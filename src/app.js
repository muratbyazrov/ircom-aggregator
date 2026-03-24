import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

import { loadConfig } from './config.js';
import { createPostsRepository } from './db/postsRepository.js';
import { createIrcomApiClient } from './api/ircomClient.js';
import { createMediaUploader } from './api/mediaUploader.js';
import { buildContentHash, buildDuplicateFingerprint } from './parsing/adParser.js';
import { isTaxiOfferExpired, resolveTaxiDepartureAt } from './parsing/taxiParser.js';
import { createPhotoStorage } from './media/photoStorage.js';
import { buildAuthParams, logAuthError } from './telegram/auth.js';
import {
  normalizeSenderId,
  normalizeTelegramMessageDate,
  hasVisualMedia,
  buildRetentionCutoffIso,
  cleanupLocalPhotos,
  getPostPhotoPaths,
  buildPermalink,
} from './utils.js';
import {
  getStorageTableName,
  shouldKeepTextByFilter,
  extractPostData,
  loadCategoryResolver,
  buildMessageUnits,
  recordTaxiSkip,
  formatTaxiSkipSummary,
} from './pipeline.js';
import {
  buildBackendSyncTarget,
  syncPostToBackend,
  deleteTaxiPostFromBackend,
} from './sync.js';
import {
  findStaleDuplicatePosts,
  createDuplicateIndex,
  comparePostsByRecency,
  cleanupExpiredBackendDepartures,
  runDedupMode,
} from './dedup.js';

export { runDedupMode } from './dedup.js';
export { extractTaxiOfferIdFromBackendResponse } from './sync.js';

async function cleanupTaxiPosts({ posts, config, db, postApi, duplicateIndex, failureLabel }) {
  if (!Array.isArray(posts) || posts.length === 0) {
    return {
      deletedLocalPosts: 0,
      deletedBackendPosts: 0,
      failedBackendDeletes: 0,
    };
  }

  cleanupLocalPhotos(posts.flatMap((post) => getPostPhotoPaths(post)));

  let deletedBackendPosts = 0;
  let failedBackendDeletes = 0;
  if (config.postApiEnabled) {
    for (const post of posts) {
      try {
        const result = await deleteTaxiPostFromBackend({ post, config, postApi });
        if (!result?.skipped) {
          deletedBackendPosts++;
        }
      } catch (err) {
        failedBackendDeletes++;
        console.error(`${failureLabel} for ${post.source}/${post.msg_id}: ${err?.message || err}`);
      }
    }
  }

  const deletedLocalPosts = db.deletePostsByIds(posts.map((post) => post.id));
  if (deletedLocalPosts > 0 && duplicateIndex) {
    for (const post of posts) {
      duplicateIndex.removePost(post);
    }
  }

  return {
    deletedLocalPosts,
    deletedBackendPosts,
    failedBackendDeletes,
  };
}

export async function runApp() {
  const config = await loadConfig();

  if (config.dedupOnly) {
    const postApi = createIrcomApiClient(config);
    await runDedupMode({ config, postApi });
    return;
  }

  const storageTableName = getStorageTableName(config);
  const db = createPostsRepository(config.dbPath, { tableName: storageTableName });
  const postApi = createIrcomApiClient(config);
  const mediaUploader = createMediaUploader(config);
  const backendSyncTarget = buildBackendSyncTarget(config);
  const categoryResolver = await loadCategoryResolver({ config, postApi });
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
    // Only print the session token when it's newly created or has changed,
    // to avoid leaking it into logs on every run.
    if (session && session !== config.session) {
      console.log('\n✅ SESSION (скопируй в .env как TG_SESSION=...):\n');
      console.log(session);
    }

    if (config.clearBeforeRun) {
      if (config.postApiEnabled && config.pipelineMode === 'taxi') {
        const existingBackendPosts = db.listPostsWithBackendEntity();
        let deletedBackendPosts = 0;
        let failedBackendDeletes = 0;
        for (const existingPost of existingBackendPosts) {
          try {
            await deleteTaxiPostFromBackend({ post: existingPost, config, postApi });
            deletedBackendPosts++;
          } catch (err) {
            failedBackendDeletes++;
            console.error(`Taxi backend cleanup failed for ${existingPost.source}/${existingPost.msg_id}: ${err?.message || err}`);
          }
        }
        if (deletedBackendPosts > 0 || failedBackendDeletes > 0) {
          console.log(
            `\nTaxi backend cleanup before clear: deleted ${deletedBackendPosts}`
              + (failedBackendDeletes > 0 ? `, failed ${failedBackendDeletes}` : '')
          );
        }
      }

      const deletedRows = db.clear();
      console.log(`\nDB cleanup enabled: removed ${deletedRows} rows from ${storageTableName}`);
      if (config.postApiEnabled) {
        if (config.pipelineMode === 'taxi') {
          console.log('Backend sync note: clear-before-run removes synced taxi offers and recreates them from the latest Telegram scan.');
        } else {
          console.log('Backend sync note: clear-before-run resends the latest Telegram posts and can skew backend-to-backend comparisons.');
        }
      }
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
      cleanupLocalPhotos(staleDuplicatePosts.flatMap((post) => getPostPhotoPaths(post)));
      const deletedDuplicates = db.deletePostsByIds(staleDuplicatePosts.map((post) => post.id));
      console.log(`\nDeduped existing DB: removed ${deletedDuplicates} stale duplicate posts`);
    }

    const duplicateIndex = createDuplicateIndex(db.listPostsForDedupe());

    if (config.pipelineMode === 'taxi') {
      // 1. Remove locally-tracked offers whose departure time has passed.
      const expiredTaxiPosts = db.getExpiredByDepartureBefore(new Date().toISOString());
      if (expiredTaxiPosts.length > 0) {
        const cleanupResult = await cleanupTaxiPosts({
          posts: expiredTaxiPosts,
          config,
          db,
          postApi,
          duplicateIndex,
          failureLabel: 'Expired taxi backend cleanup failed',
        });
        console.log(
          `\nTaxi departure cleanup: removed ${cleanupResult.deletedLocalPosts} expired local posts`
            + (config.postApiEnabled
              ? `, ${cleanupResult.deletedBackendPosts} backend taxi offers`
                + (cleanupResult.failedBackendDeletes > 0 ? ` (${cleanupResult.failedBackendDeletes} backend deletions failed)` : '')
              : '')
        );
      }

      // 2. Also sweep the backend for any expired offers that are not in local DB
      //    (e.g. after a manual DB reset or clearBeforeRun from a previous run).
      if (config.postApiEnabled) {
        const { deleted, failed } = await cleanupExpiredBackendDepartures({ config, postApi });
        if (deleted > 0 || failed > 0) {
          console.log(
            `Taxi backend departure sweep: deleted ${deleted} expired offers`
              + (failed > 0 ? `, failed ${failed}` : '')
          );
        }
      }
    }

    if (config.postApiEnabled) {
      const pendingBackendPosts = db.listPendingBackendSync({ backendSyncTarget });
      if (pendingBackendPosts.length > 0) {
        let syncedPendingPosts = 0;
        let failedPendingPosts = 0;

        for (const pendingPost of pendingBackendPosts) {
          try {
            await syncPostToBackend({
              post: pendingPost,
              config,
              db,
              postApi,
              mediaUploader,
              backendSyncTarget,
              categoryResolver,
            });
            syncedPendingPosts++;
          } catch (err) {
            failedPendingPosts++;
            console.error(`Retry sync failed for ${pendingPost.source}/${pendingPost.msg_id}: ${err?.message || err}`);
          }
        }

        console.log(
          `\nPending backend sync: ${syncedPendingPosts} sent`
            + (failedPendingPosts > 0 ? `, ${failedPendingPosts} still pending` : '')
        );
      }
    }

    const retentionCutoffIso = buildRetentionCutoffIso(config.retentionDays);
    if (retentionCutoffIso) {
      const expiredPosts = db.getExpiredBefore(retentionCutoffIso);
      const shouldHandleTaxiTtlWithHelper = config.pipelineMode === 'taxi' && config.postApiEnabled;
      let deletedExpiredPosts = 0;

      if (!shouldHandleTaxiTtlWithHelper) {
        if (expiredPosts.length > 0) {
          cleanupLocalPhotos(expiredPosts.flatMap((post) => getPostPhotoPaths(post)));
        }
        deletedExpiredPosts = db.deleteExpiredBefore(retentionCutoffIso);
        if (deletedExpiredPosts > 0) {
          for (const expiredPost of expiredPosts) {
            duplicateIndex.removePost(expiredPost);
          }
        }
      }

      if (config.postApiEnabled) {
        try {
          if (config.pipelineMode === 'taxi') {
            const cleanupResult = await cleanupTaxiPosts({
              posts: expiredPosts,
              config,
              db,
              postApi,
              duplicateIndex,
              failureLabel: 'Taxi TTL cleanup failed',
            });
            console.log(
              `\nTTL cleanup: removed ${cleanupResult.deletedLocalPosts} local posts`
                + `, ${cleanupResult.deletedBackendPosts} backend taxi offers`
                + (cleanupResult.failedBackendDeletes > 0 ? ` (${cleanupResult.failedBackendDeletes} backend deletions failed)` : '')
            );
          } else {
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
          }
        } catch (err) {
          console.error(`TTL cleanup failed: ${err?.message || err}`);
        }
      } else if (deletedExpiredPosts > 0) {
        console.log(`\nTTL cleanup: removed ${deletedExpiredPosts} local posts`);
      }
    }

    console.log(`\nSources configured: ${config.sources.length}`);
    if (config.loadedEnvFiles.length > 0) {
      console.log(`Env files: ${config.loadedEnvFiles.map((filePath) => filePath.split('/').pop()).join(', ')}`);
    }
    console.log(
      `Pipeline mode: ${config.pipelineMode} -> table ${storageTableName}`
        + (config.postApiEnabled
          ? (config.pipelineMode === 'taxi' ? ' -> backend domain taxi' : ` -> backend kind ${config.postApiKind}`)
          : ' -> backend sync disabled')
    );
    console.log(
      `Filter mode: ${config.onlyAds
        ? (config.pipelineMode === 'taxi' ? 'only taxi-like posts' : 'only marketplace-like posts')
        : 'all posts'}`
    );
    if (config.pipelineMode === 'taxi') {
      console.log(
        `Taxi skip logs: ${config.taxiVerboseSkips
          ? 'verbose per-message output enabled'
          : 'summary only (set TG_TAXI_VERBOSE_SKIPS=true for per-message details)'}`
      );
    }
    if (config.onlyAds && config.pipelineMode !== 'taxi') {
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
      let skippedWithoutDate = 0;
      let photosSaved = 0;
      let postedToApi = 0;
      let postApiFailed = 0;
      let uploadedPhotosToApi = 0;
      let uploadPhotosFailed = 0;
      const taxiSkipStats = {};
      const activeTaxiMsgIds = new Set();
      let oldestFetchedMessageId = null;

      const fetchedMessages = [];
      for await (const message of client.iterMessages(entity, { limit: config.fetchLimit })) {
        scanned++;
        fetchedMessages.push(message);
        const fetchedMessageId = Number(message?.id || 0);
        if (Number.isInteger(fetchedMessageId) && fetchedMessageId > 0) {
          oldestFetchedMessageId = oldestFetchedMessageId === null
            ? fetchedMessageId
            : Math.min(oldestFetchedMessageId, fetchedMessageId);
        }
      }

      for (const unitMessages of buildMessageUnits(fetchedMessages)) {
        const primaryMessage = unitMessages.find((item) => (item?.message?.trim?.() || '').length > 0) || unitMessages[0];
        const text = primaryMessage?.message?.trim?.() || '';
        const hasAnyVisualMedia = unitMessages.some(hasVisualMedia);
        const isRepost = unitMessages.some((item) => Boolean(item?.fwdFrom || item?.forward || item?.forwardInfo));
        const isReply = unitMessages.some((item) => Boolean(item?.replyTo || item?.replyToMsgId));
        const postDateIso = normalizeTelegramMessageDate(primaryMessage?.date);
        const senderId = normalizeSenderId(
          primaryMessage?.senderId || unitMessages.find((item) => item?.senderId !== null && item?.senderId !== undefined)?.senderId
        );
        const taxiExpired = config.pipelineMode === 'taxi' && text
          ? isTaxiOfferExpired(text, primaryMessage?.date)
          : false;

        if (!text && !hasAnyVisualMedia) continue;
        if (isReply) {
          recordTaxiSkip({ config, stats: taxiSkipStats, source, msgId: primaryMessage?.id, reason: 'reply', text });
          skippedAsReply++;
          continue;
        }
        if (isRepost) {
          recordTaxiSkip({ config, stats: taxiSkipStats, source, msgId: primaryMessage?.id, reason: 'repost', text });
          skippedAsRepost++;
          continue;
        }
        if (config.onlyAds && (!text || !shouldKeepTextByFilter(text, config))) {
          recordTaxiSkip({ config, stats: taxiSkipStats, source, msgId: primaryMessage?.id, reason: 'filter', text });
          skippedByFilter++;
          continue;
        }
        if (config.pipelineMode === 'taxi' && taxiExpired) {
          recordTaxiSkip({ config, stats: taxiSkipStats, source, msgId: primaryMessage?.id, reason: 'expired', text });
          skippedByFilter++;
          continue;
        }
        const structured = extractPostData(text, config);
        if (!postDateIso) {
          skippedWithoutDate++;
          console.warn(`Skip ${source}/${primaryMessage?.id}: message date is missing or invalid`);
          continue;
        }
        const contentHash = buildContentHash(text);
        const dedupeKey = buildDuplicateFingerprint(text);

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
          recordTaxiSkip({
            config,
            stats: taxiSkipStats,
            source,
            msgId: primaryMessage?.id,
            reason: 'duplicate-content',
            text,
          });
          skippedAsDuplicate++;
          continue;
        }
        if (db.hasFuzzyDuplicate({
          msgId: primaryMessage.id,
          senderId,
          contactPhone: structured.contactPhone,
          dedupeKey,
        })) {
          recordTaxiSkip({
            config,
            stats: taxiSkipStats,
            source,
            msgId: primaryMessage?.id,
            reason: 'duplicate-fuzzy',
            text,
          });
          skippedAsDuplicate++;
          continue;
        }

        const matchedDuplicates = duplicateIndex.findMatches(incomingPost);
        if (matchedDuplicates.length > 0) {
          const latestExistingDuplicate = matchedDuplicates
            .sort(comparePostsByRecency)
            .at(-1);

          if (latestExistingDuplicate && comparePostsByRecency(latestExistingDuplicate, incomingPost) >= 0) {
            recordTaxiSkip({
              config,
              stats: taxiSkipStats,
              source,
              msgId: primaryMessage?.id,
              reason: 'duplicate-index',
              text,
            });
            skippedAsDuplicate++;
            continue;
          }

          cleanupLocalPhotos(matchedDuplicates.flatMap((post) => getPostPhotoPaths(post)));
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
          raw_text: structured.rawText || text || null,
          dedupe_key: dedupeKey,
          sender_id: senderId,
          content_hash: contentHash,
          contact_phone: structured.contactPhone,
          contact_username: structured.contactUsername,
          contact_text: structured.contactText,
          category: structured.categoryCode || structured.category || null,
          taxi_direction: structured.direction || null,
          taxi_direction_name: structured.directionName || null,
          taxi_from: structured.fromPlace || null,
          taxi_to: structured.toPlace || null,
          taxi_route: structured.routeText || null,
          taxi_departure_at: resolveTaxiDepartureAt(text, primaryMessage?.date) || null,
          taxi_departure_text: structured.departureText || null,
          taxi_seats_total: structured.seatsTotal ?? null,
          taxi_seats_free: structured.seatsFree ?? null,
          taxi_vehicle: structured.vehicle || null,
          backend_entity_id: null,
          photo_path: photoPaths[0] || null,
          photo_paths: photoPaths.length > 0 ? JSON.stringify(photoPaths) : null,
        });
        const savedPost = db.getPostBySourceAndMsgId({ source, msgId: primaryMessage.id });
        if (savedPost) {
          duplicateIndex.addPost(savedPost);
          if (config.pipelineMode === 'taxi') {
            activeTaxiMsgIds.add(primaryMessage.id);
          }
        }

        let syncResult = null;
        if (config.postApiEnabled && savedPost) {
          try {
            syncResult = await syncPostToBackend({
              post: savedPost,
              config,
              db,
              postApi,
              mediaUploader,
              backendSyncTarget,
              categoryResolver,
            });
            postedToApi++;
            uploadedPhotosToApi += Number(syncResult?.uploadedPhotosCount || 0);
          } catch (err) {
            postApiFailed++;
            if (String(err?.message || err).includes('Photo upload failed')) {
              uploadPhotosFailed++;
            }
            console.error(`Post API failed for ${source}/${primaryMessage.id}: ${err?.message || err}`);
          }
        }

        // Use syncResult directly to avoid an extra DB round-trip.
        const isBackendSynced = Boolean(syncResult?.synced);
        if (config.postApiEnabled && !config.savePhotos && photoPaths.length > 0 && isBackendSynced) {
          cleanupLocalPhotos(photoPaths);
        }

        saved++;
      }

      if (config.pipelineMode === 'taxi' && oldestFetchedMessageId !== null) {
        const sourcePostsInScanWindow = db.listPostsBySourceFromMsgId({
          source,
          minMsgId: oldestFetchedMessageId,
        });
        const staleTaxiPosts = sourcePostsInScanWindow.filter((post) => !activeTaxiMsgIds.has(post.msg_id));
        if (staleTaxiPosts.length > 0) {
          const cleanupResult = await cleanupTaxiPosts({
            posts: staleTaxiPosts,
            config,
            db,
            postApi,
            duplicateIndex,
            failureLabel: 'Stale taxi backend cleanup failed',
          });
          console.log(
            `Taxi source cleanup: removed ${cleanupResult.deletedLocalPosts} stale local posts from ${source}`
              + (config.postApiEnabled
                ? `, ${cleanupResult.deletedBackendPosts} backend taxi offers`
                  + (cleanupResult.failedBackendDeletes > 0 ? ` (${cleanupResult.failedBackendDeletes} backend deletions failed)` : '')
                : '')
          );
        }
      }

      totalSaved += saved;
      console.log(
        `Scanned: ${scanned} | Saved: ${saved} | Replies: ${skippedAsReply} | Reposts: ${skippedAsRepost} | Duplicates: ${skippedAsDuplicate} | Skipped by filter: ${skippedByFilter} | Skipped without date: ${skippedWithoutDate} | Photos: ${photosSaved} | API photos uploaded: ${uploadedPhotosToApi} | API photo upload failed: ${uploadPhotosFailed} | API posted: ${postedToApi} | API failed: ${postApiFailed}`
      );
      const taxiSkipSummary = formatTaxiSkipSummary(taxiSkipStats);
      if (taxiSkipSummary) {
        console.log(`Taxi skip summary: ${taxiSkipSummary}`);
      }
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
