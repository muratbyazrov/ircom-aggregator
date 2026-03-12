import fs from 'node:fs';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

import { loadConfig } from './config.js';
import { createPostsRepository } from './db/postsRepository.js';
import { createIrcomApiClient } from './api/ircomClient.js';
import { createMediaUploader } from './api/mediaUploader.js';
import { looksLikeAd, extractStructuredData, buildContentHash } from './parsing/adParser.js';
import { createPhotoStorage } from './media/photoStorage.js';
import { buildAuthParams, logAuthError } from './telegram/auth.js';

const MAX_PHOTOS_PER_LISTING = 8;

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
        const contentHash = buildContentHash(text);
        if (db.hasDuplicateByContent({
          source,
          msgId: primaryMessage.id,
          senderId,
          contentHash,
        })) {
          skippedAsDuplicate++;
          continue;
        }

        const structured = extractStructuredData(text);
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
          date: primaryMessage.date?.toISOString?.() || new Date().toISOString(),
          permalink: buildPermalink(entity, primaryMessage.id),
          title: structured.title,
          description: structured.description,
          price_value: structured.priceValue,
          sender_id: senderId,
          content_hash: contentHash,
          contact_phone: structured.contactPhone,
          contact_username: structured.contactUsername,
          contact_text: structured.contactText,
          category: structured.category,
          photo_path: photoPaths[0] || null,
        });

        const uploadedPhotoUrls = [];
        if (config.postApiEnabled && photoPaths.length > 0) {
          for (const photoPath of photoPaths.slice(0, MAX_PHOTOS_PER_LISTING)) {
            try {
              const uploadedPhotoUrl = await mediaUploader.uploadPhotoFromPath(photoPath);
              if (uploadedPhotoUrl) {
                uploadedPhotoUrls.push(uploadedPhotoUrl);
                uploadedPhotosToApi++;
              }
            } catch (err) {
              uploadPhotosFailed++;
              console.error(`Photo upload failed for ${source}/${primaryMessage.id}: ${err?.message || err}`);
            }
          }
        }

        try {
          await postApi.createListing({
            accountId: config.postApiAccountId,
            kind: config.postApiKind,
            category: structured.category || config.postApiDefaultCategory || 'Другое',
            title: structured.title || 'Объявление',
            description: structured.description || text || '',
            price: Number(structured.priceValue) || config.postApiDefaultPrice || 1,
            photos: uploadedPhotoUrls,
          });
          if (config.postApiEnabled) {
            postedToApi++;
          }
        } catch (err) {
          postApiFailed++;
          console.error(`Post API failed for ${source}/${primaryMessage.id}: ${err?.message || err}`);
        }

        if (config.postApiEnabled && !config.savePhotos && photoPaths.length > 0) {
          for (const photoPath of photoPaths) {
            try {
              fs.unlinkSync(photoPath);
            } catch {
              // Ignore cleanup errors for temporary files.
            }
          }
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
