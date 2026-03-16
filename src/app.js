import fs from 'node:fs';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

import { loadConfig } from './config.js';
import { createPostsRepository } from './db/postsRepository.js';
import { createIrcomApiClient } from './api/ircomClient.js';
import { createMediaUploader } from './api/mediaUploader.js';
import { looksLikeAd, extractStructuredData, buildContentHash, buildDuplicateFingerprint } from './parsing/adParser.js';
import { createPhotoStorage } from './media/photoStorage.js';
import { buildAuthParams, logAuthError } from './telegram/auth.js';

const MAX_PHOTOS_PER_LISTING = 8;
const PHONE_LIKE_RE = /(?<![\d,.])(?:\+?\d{10,15}|\+?\d{1,4}(?:[\s()-]+\d{1,4}){2,})(?![\d])/gu;

function buildPermalink(entity, msgId) {
  const username = entity?.username;
  return username ? `https://t.me/${username}/${msgId}` : null;
}

function normalizeSenderId(senderId) {
  if (senderId === null || senderId === undefined) return null;
  if (typeof senderId === 'string') return senderId;
  if (typeof senderId === 'number' || typeof senderId === 'bigint') return String(senderId);
  if (typeof senderId?.toString === 'function') {
    const value = senderId.toString();
    return value && value !== '[object Object]' ? value : null;
  }
  return null;
}

function hasVisualMedia(message) {
  const hasPhoto = Boolean(message?.photo);
  const hasImageDoc = String(message?.media?.document?.mimeType || '').startsWith('image/');
  return hasPhoto || hasImageDoc;
}

function getGroupedId(message) {
  const raw = message?.groupedId;
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  return value && value !== '[object Object]' ? value : null;
}

function buildRetentionCutoffIso(retentionDays) {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) return null;
  return new Date(Date.now() - (retentionDays * 24 * 60 * 60 * 1000)).toISOString();
}

function cleanupLocalPhotos(photoPaths) {
  for (const photoPath of photoPaths) {
    const normalizedPath = String(photoPath || '').trim();
    if (!normalizedPath || !fs.existsSync(normalizedPath)) continue;
    try {
      fs.unlinkSync(normalizedPath);
    } catch {
      // Ignore cleanup errors for local photos.
    }
  }
}

function splitMultiValueField(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getFirstMultiValue(value, { prefix = '' } = {}) {
  const firstValue = splitMultiValueField(value)[0] || null;
  if (!firstValue) return null;
  return prefix && !firstValue.startsWith(prefix) ? `${prefix}${firstValue}` : firstValue;
}

function buildTitleFingerprint(value) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#][\p{L}\p{N}_]+/gu, ' ')
    .replace(PHONE_LIKE_RE, ' ')
    .replace(/\b(?:19|20)\d{2}\b/gu, ' ')
    .replace(/\b\d{2,4}\s*(?:gb|гб|tb|тб)\b/gu, ' ')
    .replace(/\b(?:цена|стоимость)\s*\d[\d.,\s]{0,24}\b/gu, ' ')
    .replace(/\b\d{2,}\b/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;
  const tokens = normalized.split(' ').filter((token) => token.length > 1);
  if (tokens.length < 3) return null;
  return tokens.slice(0, 8).join(' ');
}

function buildDuplicateIdentityKeys(post) {
  const keys = new Set();
  const contentHash = String(post?.content_hash || post?.contentHash || '').trim();
  const dedupeKey = String(post?.dedupe_key || post?.dedupeKey || '').trim();
  const senderId = normalizeSenderId(post?.sender_id || post?.senderId);
  const titleFingerprint = buildTitleFingerprint(post?.title);

  if (contentHash) {
    keys.add(`content:${contentHash}`);
  }
  if (dedupeKey && senderId) {
    keys.add(`sender:${senderId}:${dedupeKey}`);
  }
  if (titleFingerprint && senderId) {
    keys.add(`sender-title:${senderId}:${titleFingerprint}`);
  }
  if (dedupeKey) {
    for (const phone of splitMultiValueField(post?.contact_phone || post?.contactPhone)) {
      keys.add(`phone:${phone}:${dedupeKey}`);
    }
    for (const username of splitMultiValueField(post?.contact_username || post?.contactUsername)) {
      keys.add(`username:${username.toLowerCase()}:${dedupeKey}`);
    }
  }
  if (titleFingerprint) {
    for (const phone of splitMultiValueField(post?.contact_phone || post?.contactPhone)) {
      keys.add(`phone-title:${phone}:${titleFingerprint}`);
    }
    for (const username of splitMultiValueField(post?.contact_username || post?.contactUsername)) {
      keys.add(`username-title:${username.toLowerCase()}:${titleFingerprint}`);
    }
  }

  return [...keys];
}

function getComparableMessageId(post) {
  const value = Number(post?.msg_id ?? post?.msgId ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function comparePostsByRecency(left, right) {
  const leftTime = new Date(left?.date || 0).getTime();
  const rightTime = new Date(right?.date || 0).getTime();
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftMsgId = getComparableMessageId(left);
  const rightMsgId = getComparableMessageId(right);
  if (leftMsgId !== rightMsgId) {
    return leftMsgId - rightMsgId;
  }

  const leftId = Number(left?.id || 0);
  const rightId = Number(right?.id || 0);
  return leftId - rightId;
}

function createDuplicateIndex(posts) {
  const postsById = new Map();
  const keyToPostIds = new Map();

  const addPost = (post) => {
    if (!post?.id) return;
    postsById.set(post.id, post);
    for (const key of buildDuplicateIdentityKeys(post)) {
      if (!keyToPostIds.has(key)) keyToPostIds.set(key, new Set());
      keyToPostIds.get(key).add(post.id);
    }
  };

  const removePost = (post) => {
    if (!post?.id) return;
    postsById.delete(post.id);
    for (const key of buildDuplicateIdentityKeys(post)) {
      const ids = keyToPostIds.get(key);
      if (!ids) continue;
      ids.delete(post.id);
      if (ids.size === 0) {
        keyToPostIds.delete(key);
      }
    }
  };

  const findMatches = (post) => {
    const matches = new Map();
    for (const key of buildDuplicateIdentityKeys(post)) {
      const ids = keyToPostIds.get(key);
      if (!ids) continue;
      for (const id of ids) {
        const existingPost = postsById.get(id);
        if (existingPost) {
          matches.set(id, existingPost);
        }
      }
    }
    return [...matches.values()];
  };

  for (const post of posts) {
    addPost(post);
  }

  return {
    addPost,
    removePost,
    findMatches,
  };
}

function findStaleDuplicatePosts(posts) {
  const duplicateIndex = createDuplicateIndex([]);
  const stalePosts = [];
  const sortedPosts = [...posts].sort((left, right) => comparePostsByRecency(right, left));

  for (const post of sortedPosts) {
    if (duplicateIndex.findMatches(post).length > 0) {
      stalePosts.push(post);
      continue;
    }
    duplicateIndex.addPost(post);
  }

  return stalePosts;
}

function buildMessageUnits(messages) {
  const grouped = new Map();
  for (const message of messages) {
    const groupedId = getGroupedId(message);
    if (!groupedId) continue;
    if (!grouped.has(groupedId)) grouped.set(groupedId, []);
    grouped.get(groupedId).push(message);
  }

  const units = [];
  const seenGroups = new Set();
  for (const message of messages) {
    const groupedId = getGroupedId(message);
    if (!groupedId) {
      units.push([message]);
      continue;
    }
    if (seenGroups.has(groupedId)) continue;
    seenGroups.add(groupedId);
    units.push(grouped.get(groupedId) || [message]);
  }
  return units;
}

export async function runApp() {
  const config = loadConfig();
  const db = createPostsRepository('data.db');
  const postApi = createIrcomApiClient(config);
  const mediaUploader = createMediaUploader(config);
  const photoStorage = createPhotoStorage({
    enabled: config.savePhotos || config.postApiEnabled,
    photosDir: config.photosDir,
  });

  const client = new TelegramClient(new StringSession(config.session), config.apiId, config.apiHash, {
    connectionRetries: 5,
  });
  client.setLogLevel('none');
  client.onError = async (err) => {
    const message = String(err?.message || err || '');
    const normalized = message.toUpperCase();
    if (normalized.includes('TIMEOUT')) {
      return;
    }
    console.error(`Telegram client error: ${message}`);
  };

  try {
    await client.start(buildAuthParams({
      defaultPhoneNumber: config.defaultPhoneNumber,
      forceSms: config.forceSms,
    }));

    const session = client.session.save();
    console.log('\n✅ SESSION (скопируй в .env как TG_SESSION=...):\n');
    console.log(session);

    if (config.clearBeforeRun) {
      const deletedRows = db.clear();
      console.log(`\nDB cleanup enabled: removed ${deletedRows} rows from posts`);
    }

    const postsMissingDedupeKey = db.getPostsMissingDedupeKey();
    if (postsMissingDedupeKey.length > 0) {
      let backfilledDedupeKeys = 0;
      for (const post of postsMissingDedupeKey) {
        const dedupeKey = buildDuplicateFingerprint(post.text);
        if (!dedupeKey) continue;
        backfilledDedupeKeys += db.updateDedupeKey({ id: post.id, dedupeKey });
      }
      if (backfilledDedupeKeys > 0) {
        console.log(`\nBackfilled dedupe keys for ${backfilledDedupeKeys} posts`);
      }
    }

    const staleDuplicatePosts = findStaleDuplicatePosts(db.listPostsForDedupe());
    if (staleDuplicatePosts.length > 0) {
      cleanupLocalPhotos(staleDuplicatePosts.map((post) => post.photo_path));
      const deletedDuplicates = db.deletePostsByIds(staleDuplicatePosts.map((post) => post.id));
      console.log(`\nDeduped existing DB: removed ${deletedDuplicates} stale duplicate posts`);
    }

    const duplicateIndex = createDuplicateIndex(db.listPostsForDedupe());

    const retentionCutoffIso = buildRetentionCutoffIso(config.retentionDays);
    if (retentionCutoffIso) {
      const expiredPosts = db.getExpiredBefore(retentionCutoffIso);
      if (expiredPosts.length > 0) {
        cleanupLocalPhotos(expiredPosts.map((post) => post.photo_path));
      }
      const deletedExpiredPosts = db.deleteExpiredBefore(retentionCutoffIso);
      if (deletedExpiredPosts > 0) {
        for (const expiredPost of expiredPosts) {
          duplicateIndex.removePost(expiredPost);
        }
      }

      if (config.postApiEnabled) {
        try {
          const cleanupResult = await postApi.cleanupImportedListings({
            accountId: config.postApiAccountId,
            kind: config.postApiKind,
            olderThan: retentionCutoffIso,
          });
          const deletedListings = Number(cleanupResult?.data?.deletedListings || 0);
          const deletedPhotos = Number(cleanupResult?.data?.deletedPhotos || 0);
          const failedPhotos = Number(cleanupResult?.data?.failedPhotos || 0);
          console.log(
            `\nTTL cleanup: removed ${deletedExpiredPosts} local posts, ${deletedListings} backend listings, ${deletedPhotos} S3 objects`
              + (failedPhotos > 0 ? ` (${failedPhotos} S3 deletions failed)` : '')
          );
        } catch (err) {
          console.error(`TTL cleanup failed: ${err?.message || err}`);
        }
      } else if (deletedExpiredPosts > 0) {
        console.log(`\nTTL cleanup: removed ${deletedExpiredPosts} local posts`);
      }
    }

    console.log(`\nSources configured: ${config.sources.length}`);
    console.log(`Filter mode: ${config.onlyAds ? 'only ads' : 'all posts'}`);
    if (config.onlyAds) {
      console.log(`Ad keywords: ${config.adKeywords.join(', ')}`);
    }

    let totalSaved = 0;

    for (const source of config.sources) {
      console.log(`\n--- Fetching: ${source} ---`);
      let entity;
      try {
        entity = await client.getEntity(source);
      } catch (err) {
        console.error(`Skip source "${source}": ${err?.message || err}`);
        continue;
      }

      let saved = 0;
      let scanned = 0;
      let skippedAsRepost = 0;
      let skippedAsReply = 0;
      let skippedByFilter = 0;
      let skippedAsDuplicate = 0;
      let photosSaved = 0;
      let postedToApi = 0;
      let postApiFailed = 0;
      let uploadedPhotosToApi = 0;
      let uploadPhotosFailed = 0;

      const fetchedMessages = [];
      for await (const message of client.iterMessages(entity, { limit: config.fetchLimit })) {
        scanned++;
        fetchedMessages.push(message);
      }

      for (const unitMessages of buildMessageUnits(fetchedMessages)) {
        const primaryMessage = unitMessages.find((item) => (item?.message?.trim?.() || '').length > 0) || unitMessages[0];
        const text = primaryMessage?.message?.trim?.() || '';
        const hasAnyVisualMedia = unitMessages.some(hasVisualMedia);
        const isRepost = unitMessages.some((item) => Boolean(item?.fwdFrom || item?.forward || item?.forwardInfo));
        const isReply = unitMessages.some((item) => Boolean(item?.replyTo || item?.replyToMsgId));

        if (!text && !hasAnyVisualMedia) continue;
        if (isReply) {
          skippedAsReply++;
          continue;
        }
        if (isRepost) {
          skippedAsRepost++;
          continue;
        }
        if (config.onlyAds && (!text || !looksLikeAd(text, config.adKeywords))) {
          skippedByFilter++;
          continue;
        }

        const senderId = normalizeSenderId(
          primaryMessage?.senderId || unitMessages.find((item) => item?.senderId !== null && item?.senderId !== undefined)?.senderId
        );
        const structured = extractStructuredData(text);
        const hasListingContacts = Boolean(structured.contactPhone || structured.contactUsername);
        const postDateIso = primaryMessage.date?.toISOString?.() || new Date().toISOString();
        const contentHash = buildContentHash(text);
        const dedupeKey = buildDuplicateFingerprint(text);

        if (!hasListingContacts) {
          skippedByFilter++;
          continue;
        }

        const incomingPost = {
          source,
          msg_id: primaryMessage.id,
          date: postDateIso,
          title: structured.title,
          sender_id: senderId,
          content_hash: contentHash,
          dedupe_key: dedupeKey,
          contact_phone: structured.contactPhone,
          contact_username: structured.contactUsername,
        };
        if (db.hasDuplicateByContent({
          source,
          msgId: primaryMessage.id,
          senderId,
          contentHash,
        })) {
          skippedAsDuplicate++;
          continue;
        }
        if (db.hasFuzzyDuplicate({
          msgId: primaryMessage.id,
          senderId,
          contactPhone: structured.contactPhone,
          dedupeKey,
        })) {
          skippedAsDuplicate++;
          continue;
        }

        const matchedDuplicates = duplicateIndex.findMatches(incomingPost);
        if (matchedDuplicates.length > 0) {
          const latestExistingDuplicate = matchedDuplicates
            .sort(comparePostsByRecency)
            .at(-1);

          if (latestExistingDuplicate && comparePostsByRecency(latestExistingDuplicate, incomingPost) >= 0) {
            skippedAsDuplicate++;
            continue;
          }

          cleanupLocalPhotos(matchedDuplicates.map((post) => post.photo_path));
          db.deletePostsByIds(matchedDuplicates.map((post) => post.id));
          for (const duplicatePost of matchedDuplicates) {
            duplicateIndex.removePost(duplicatePost);
          }
        }

        const photoPaths = [];
        const mediaMessages = unitMessages.filter(hasVisualMedia);
        for (const mediaMessage of mediaMessages) {
          try {
            const photoPath = await photoStorage.savePhotoIfAny(client, mediaMessage, source, mediaMessage.id);
            if (photoPath) {
              photoPaths.push(photoPath);
              photosSaved++;
            }
          } catch (err) {
            console.error(`Photo save failed for ${source}/${mediaMessage.id}: ${err?.message || err}`);
          }
        }

        db.upsert({
          source,
          msg_id: primaryMessage.id,
          date: postDateIso,
          permalink: buildPermalink(entity, primaryMessage.id),
          title: structured.title,
          description: structured.description,
          price_value: structured.priceValue,
          dedupe_key: dedupeKey,
          sender_id: senderId,
          content_hash: contentHash,
          contact_phone: structured.contactPhone,
          contact_username: structured.contactUsername,
          contact_text: structured.contactText,
          category: structured.category,
          photo_path: photoPaths[0] || null,
        });
        const savedPost = db.getPostBySourceAndMsgId({ source, msgId: primaryMessage.id });
        if (savedPost) {
          duplicateIndex.addPost(savedPost);
        }

        const uploadedPhotos = [];
        if (config.postApiEnabled && photoPaths.length > 0) {
          for (const photoPath of photoPaths.slice(0, MAX_PHOTOS_PER_LISTING)) {
            try {
              const uploadedPhoto = await mediaUploader.uploadPhotoFromPath(photoPath);
              if (uploadedPhoto?.photoUrl) {
                uploadedPhotos.push(uploadedPhoto);
                uploadedPhotosToApi++;
              }
            } catch (err) {
              uploadPhotosFailed++;
              console.error(`Photo upload failed for ${source}/${primaryMessage.id}: ${err?.message || err}`);
            }
          }
        }

        try {
          const listingPhone = getFirstMultiValue(structured.contactPhone);
          const listingTelegram = getFirstMultiValue(structured.contactUsername, { prefix: '@' });

          await postApi.createListing({
            accountId: config.postApiAccountId,
            kind: config.postApiKind,
            category: structured.category || config.postApiDefaultCategory || 'Другое',
            title: structured.title || 'Объявление',
            description: structured.description || text || '',
            price: Number(structured.priceValue) || config.postApiDefaultPrice || 1,
            ...(listingPhone ? { phone: listingPhone } : {}),
            ...(listingTelegram ? { telegram: listingTelegram } : {}),
            photos: uploadedPhotos.map((photo) => photo.photoUrl),
            importMeta: {
              source,
              msgId: primaryMessage.id,
              date: postDateIso,
              permalink: buildPermalink(entity, primaryMessage.id),
              contentHash,
              photoObjectKeys: uploadedPhotos
                .map((photo) => String(photo?.objectKey || '').trim())
                .filter(Boolean),
            },
          });
          if (config.postApiEnabled) {
            postedToApi++;
          }
        } catch (err) {
          postApiFailed++;
          console.error(`Post API failed for ${source}/${primaryMessage.id}: ${err?.message || err}`);
        }

        if (config.postApiEnabled && !config.savePhotos && photoPaths.length > 0) {
          cleanupLocalPhotos(photoPaths);
        }

        saved++;
      }

      totalSaved += saved;
      console.log(
        `Scanned: ${scanned} | Saved: ${saved} | Replies: ${skippedAsReply} | Reposts: ${skippedAsRepost} | Duplicates: ${skippedAsDuplicate} | Skipped by filter: ${skippedByFilter} | Photos: ${photosSaved} | API photos uploaded: ${uploadedPhotosToApi} | API photo upload failed: ${uploadPhotosFailed} | API posted: ${postedToApi} | API failed: ${postApiFailed}`
      );
    }

    console.log(`\n✅ Done. Saved total: ${totalSaved}. Posts are in data.db`);
  } finally {
    try {
      await client.disconnect();
    } catch {
      // Ignore disconnect failures on shutdown.
    }
    db.close();
  }
}

export function handleFatalError(error) {
  logAuthError(error);
  process.exit(1);
}
