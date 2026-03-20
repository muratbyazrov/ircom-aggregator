import fs from 'node:fs';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

import { loadConfig } from './config.js';
import { createPostsRepository } from './db/postsRepository.js';
import { createIrcomApiClient } from './api/ircomClient.js';
import { createMediaUploader } from './api/mediaUploader.js';
import {
  looksLikeAd,
  detectPostKind,
  extractStructuredData,
  buildContentHash,
  buildDuplicateFingerprint,
  FALLBACK_LISTING_CATEGORY_BY_CODE,
  FALLBACK_SERVICE_CATEGORY_BY_CODE,
} from './parsing/adParser.js';
import {
  looksLikeTaxiOffer,
  extractTaxiStructuredData,
  resolveTaxiDepartureAt,
  isTaxiOfferExpired,
} from './parsing/taxiParser.js';
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

function normalizeTelegramMessageDate(dateValue) {
  if (dateValue === null || dateValue === undefined) return null;

  if (dateValue instanceof Date) {
    return Number.isNaN(dateValue.getTime()) ? null : dateValue.toISOString();
  }

  if (typeof dateValue === 'number' && Number.isFinite(dateValue)) {
    const normalizedDate = new Date(dateValue * 1000);
    return Number.isNaN(normalizedDate.getTime()) ? null : normalizedDate.toISOString();
  }

  if (typeof dateValue === 'bigint') {
    const normalizedDate = new Date(Number(dateValue) * 1000);
    return Number.isNaN(normalizedDate.getTime()) ? null : normalizedDate.toISOString();
  }

  const text = String(dateValue || '').trim();
  if (!text) return null;

  const parsedDate = new Date(text);
  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString();
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

function parseStoredPhotoPaths(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }

  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) return [];

  try {
    const parsed = JSON.parse(normalizedValue);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item || '').trim()).filter(Boolean);
    }
  } catch {
    // Fall back to legacy single-path storage.
  }

  return [normalizedValue];
}

function getPostPhotoPaths(post) {
  const multiValue = post?.photo_paths ?? post?.photoPaths;
  const parsedMultiValue = parseStoredPhotoPaths(multiValue);
  if (parsedMultiValue.length > 0) {
    return parsedMultiValue;
  }
  return parseStoredPhotoPaths(post?.photo_path || post?.photoPath);
}

function buildPostPreview(text, maxLength = 90) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trim()}...`;
}

function logTaxiSkip({ source, msgId, reason, text }) {
  const preview = buildPostPreview(text);
  const suffix = preview ? ` | ${preview}` : '';
  console.log(`Skip taxi ${source}/${msgId}: ${reason}${suffix}`);
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

function normalizeCategoryLookupKey(value) {
  return String(value || '').trim().toLowerCase();
}

function getStorageTableName(config) {
  if (config?.pipelineMode === 'taxi') return 'taxi_posts';
  return config?.pipelineMode === 'services' ? 'service_posts' : 'posts';
}

function matchesPipelineMode(text, config) {
  if (config?.pipelineMode === 'taxi') {
    return looksLikeTaxiOffer(text);
  }
  const detectedKind = detectPostKind(text);
  return config?.pipelineMode === 'services' ? detectedKind === 2 : detectedKind !== 2;
}

function shouldKeepTextByFilter(text, config) {
  if (config?.pipelineMode === 'taxi') {
    return looksLikeTaxiOffer(text);
  }

  return looksLikeAd(text, config.adKeywords) && matchesPipelineMode(text, config);
}

function extractPostData(text, config) {
  if (config?.pipelineMode === 'taxi') {
    return extractTaxiStructuredData(text);
  }

  return extractStructuredData(text, { kind: config.postApiKind });
}

function getFallbackCategoryMap(kind) {
  return Number(kind) === 2 ? FALLBACK_SERVICE_CATEGORY_BY_CODE : FALLBACK_LISTING_CATEGORY_BY_CODE;
}

function createCategoryResolver(categories, config, kind) {
  const byCode = new Map();
  const byName = new Map();

  for (const category of Array.isArray(categories) ? categories : []) {
    const normalizedCode = String(category?.code || '').trim();
    const normalizedName = String(category?.name || '').trim();
    const categoryId = Number(category?.categoryId || 0);

    if (!normalizedCode || !normalizedName || !Number.isInteger(categoryId) || categoryId <= 0) {
      continue;
    }

    const resolved = { categoryId, categoryCode: normalizedCode, categoryName: normalizedName };
    byCode.set(normalizedCode, resolved);
    byName.set(normalizeCategoryLookupKey(normalizedName), resolved);
  }

  const fallbackDefaultName = String(config?.postApiDefaultCategory || '').trim() || 'Другое';
  const fallbackCategoryByCode = getFallbackCategoryMap(kind);

  const resolve = (inputCategory) => {
    const rawValue = String(inputCategory || '').trim();
    const byExactCode = rawValue ? byCode.get(rawValue) : null;
    if (byExactCode) return byExactCode;

    const fallbackName = rawValue
      ? (fallbackCategoryByCode[rawValue] || rawValue)
      : fallbackDefaultName;
    const byResolvedName = byName.get(normalizeCategoryLookupKey(fallbackName));
    if (byResolvedName) return byResolvedName;

    const byDefaultCode = byCode.get(String(config?.postApiDefaultCategoryCode || '').trim());
    if (byDefaultCode) return byDefaultCode;

    const byDefaultName = byName.get(normalizeCategoryLookupKey(fallbackDefaultName));
    if (byDefaultName) return byDefaultName;

    return {
      categoryId: null,
      categoryCode: rawValue || null,
      categoryName: fallbackName || 'Другое',
    };
  };

  return { resolve, size: byCode.size };
}

async function loadCategoryResolver({ config, postApi }) {
  if (!config.postApiEnabled || config?.pipelineMode === 'taxi') {
    return createCategoryResolver([], config, config.postApiKind);
  }

  try {
    const categories = await postApi.getCategories(config.postApiKind);
    return createCategoryResolver(categories, config, config.postApiKind);
  } catch (error) {
    console.warn(`Failed to load categories from backend, using fallback mapping: ${error?.message || error}`);
    return createCategoryResolver([], config, config.postApiKind);
  }
}

function buildListingPayload(post, config, categoryResolver) {
  const listingPhone = getFirstMultiValue(post?.contact_phone || post?.contactPhone);
  const listingTelegram = getFirstMultiValue(post?.contact_username || post?.contactUsername, { prefix: '@' });
  const resolvedCategory = categoryResolver.resolve(post?.category || post?.categoryCode);
  const fallbackCategoryName = String(post?.category_name || post?.categoryName || '').trim();
  const categoryName = resolvedCategory.categoryName || fallbackCategoryName || config.postApiDefaultCategory || 'Другое';

  return {
    accountId: config.postApiAccountId,
    kind: config.postApiKind,
    ...(resolvedCategory.categoryId ? { categoryId: resolvedCategory.categoryId } : {}),
    category: categoryName,
    title: String(post?.title || '').trim() || 'Объявление',
    description: String(post?.description || '').trim(),
    price: Number(post?.price_value || post?.priceValue) || config.postApiDefaultPrice || 1,
    ...(listingPhone ? { phone: listingPhone } : {}),
    ...(listingTelegram ? { telegram: listingTelegram } : {}),
    importMeta: {
      source: post?.source,
      msgId: post?.msg_id ?? post?.msgId,
      date: post?.date,
      permalink: post?.permalink || null,
      contentHash: post?.content_hash || post?.contentHash || null,
      photoObjectKeys: [],
    },
  };
}

function clampText(value, maxLength, fallback = '') {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength).trim();
}

function getNormalizedPhoneValue(value) {
  const raw = getFirstMultiValue(value);
  if (!raw) return null;
  const normalized = String(raw).replace(/[^\d+]/g, '').trim();
  return normalized || null;
}

function getNormalizedPhoneValues(value) {
  return splitMultiValueField(value)
    .map((item) => String(item).replace(/[^\d+]/g, '').trim())
    .filter(Boolean);
}

function getNormalizedTelegramValue(value) {
  const raw = getFirstMultiValue(value, { prefix: '@' });
  if (!raw) return null;
  return String(raw).trim() || null;
}

function getTaggedContactValue(contactText, prefixes) {
  for (const part of String(contactText || '').split(';')) {
    const normalizedPart = String(part || '').trim();
    for (const prefix of prefixes) {
      if (!normalizedPart.startsWith(prefix)) continue;
      const value = normalizedPart.slice(prefix.length).trim();
      if (value) return value;
    }
  }
  return null;
}

function hasWhatsappMention(text) {
  return /(?:wh(?:a)?ts?\s*app|wats?\s*app|ватсап|ватсапп|вацап|вацап|ваца|вац|вотсап|васап)/i.test(String(text || ''));
}

function getNormalizedTelegramContactValue(contactUsername, contactText) {
  const username = getNormalizedTelegramValue(contactUsername);
  if (username) return username;

  const taggedPhone = getTaggedContactValue(contactText, ['tg-phone:']);
  if (taggedPhone) return taggedPhone;

  return null;
}

function buildTaxiPayload(post, config) {
  const rawText = String(post?.raw_text || post?.rawText || post?.description || '').trim();
  const reparsed = extractTaxiStructuredData(rawText);
  const direction = Number(reparsed.direction || post?.taxi_direction || post?.taxiDirection || 2) || 2;
  const description = clampText(rawText || reparsed.description || post?.description, 2000, '');
  const phoneValues = getNormalizedPhoneValues(post?.contact_phone || post?.contactPhone);
  const phone = phoneValues[0] || getNormalizedPhoneValue(post?.contact_phone || post?.contactPhone);
  const contactText = post?.contact_text || post?.contactText;
  const telegram = getNormalizedTelegramContactValue(post?.contact_username || post?.contactUsername, contactText);
  const whatsappTaggedPhone = getTaggedContactValue(contactText, ['wa:']);
  const departureAt = resolveTaxiDepartureAt(rawText, post?.date);
  const backendEntityId = Number(post?.backend_entity_id || post?.backendEntityId || 0);
  if (!phone) {
    throw new Error(`Taxi backend sync requires a phone number for ${post?.source}/${post?.msg_id}`);
  }
  const payload = {
    accountId: config.postApiAccountId,
    direction,
    description,
    phone,
    price: Number(reparsed.priceValue || post?.price_value || post?.priceValue || config.postApiDefaultPrice || 1),
  };

  if (telegram) payload.telegram = telegram;
  if (hasWhatsappMention(rawText) || whatsappTaggedPhone) {
    payload.whatsapp = whatsappTaggedPhone || phoneValues[1] || phone;
  }
  if (departureAt) payload.departureAt = departureAt;
  if (direction === 2) {
    const routeDirection = Number(reparsed.routeDirection || 0);
    const fromPlace = clampText(reparsed.fromPlace || post?.taxi_from || post?.taxiFrom, 60);
    const toPlace = clampText(reparsed.toPlace || post?.taxi_to || post?.taxiTo, 60);
    const routeText = clampText(
      reparsed.routeText || post?.taxi_route || post?.taxiRoute || (fromPlace && toPlace ? `${fromPlace} - ${toPlace}` : ''),
      160
    );

    if (routeDirection === 1 || routeDirection === 2) payload.routeDirection = routeDirection;
    if (fromPlace) payload.fromPlace = fromPlace;
    if (toPlace) payload.toPlace = toPlace;
    if (routeText) payload.routeText = routeText;
  }

  const vehicle = clampText(reparsed.vehicle || post?.taxi_vehicle || post?.taxiVehicle, 80);
  if (vehicle) {
    payload.vehicle = vehicle;
  }

  const seatsFree = Number(reparsed.seatsFree ?? post?.taxi_seats_free ?? post?.taxiSeatsFree);
  if (Number.isInteger(seatsFree) && seatsFree >= 0) {
    payload.seatsFree = seatsFree;
  }

  const seatsTotal = Number(reparsed.seatsTotal ?? post?.taxi_seats_total ?? post?.taxiSeatsTotal);
  if (Number.isInteger(seatsTotal) && seatsTotal >= 1) {
    payload.seatsTotal = seatsTotal;
  }

  return {
    payload,
    backendEntityId: Number.isInteger(backendEntityId) && backendEntityId > 0 ? backendEntityId : null,
  };
}

export function extractTaxiOfferIdFromBackendResponse(response) {
  const payload = response?.data ?? response ?? null;
  const taxiOfferId = Number(payload?.taxiOfferId || 0);
  return Number.isInteger(taxiOfferId) && taxiOfferId > 0 ? taxiOfferId : null;
}

function buildBackendSyncTarget(config) {
  const endpoint = String(config?.postApiUrl || '').trim().replace(/\/+$/, '');
  const accountId = Number(config?.postApiAccountId || 0);
  const kind = Number(config?.postApiKind || 0);
  return JSON.stringify({
    endpoint,
    accountId,
    mode: String(config?.pipelineMode || 'ads'),
    ...(kind > 0 ? { kind } : {}),
  });
}

async function syncListingPostToBackend({ post, config, db, postApi, mediaUploader, backendSyncTarget, categoryResolver }) {
  if (!config.postApiEnabled || !post?.id) return { skipped: true, reason: 'disabled-or-missing-post' };

  const payload = buildListingPayload(post, config, categoryResolver);
  const uploadedPhotos = [];
  const originalPhotoPaths = getPostPhotoPaths(post).slice(0, MAX_PHOTOS_PER_LISTING);
  const existingPhotoPaths = originalPhotoPaths.filter((photoPath) => fs.existsSync(photoPath));
  const missingPhotoPathsCount = originalPhotoPaths.length - existingPhotoPaths.length;

  if (missingPhotoPathsCount > 0) {
    db.updateStoredPhotos({
      id: post.id,
      photoPath: existingPhotoPaths[0] || null,
      photoPaths: existingPhotoPaths.length > 0 ? JSON.stringify(existingPhotoPaths) : null,
    });
    console.warn(
      `Skipping ${missingPhotoPathsCount} missing local photo(s) for ${post.source}/${post.msg_id} during backend sync`
    );
  }

  for (const photoPath of existingPhotoPaths) {
    try {
      const uploadedPhoto = await mediaUploader.uploadPhotoFromPath(photoPath);
      if (uploadedPhoto?.photoUrl) {
        uploadedPhotos.push(uploadedPhoto);
      }
    } catch (err) {
      console.error(`Photo upload failed for ${post.source}/${post.msg_id}: ${err?.message || err}`);
    }
  }

  payload.photos = uploadedPhotos.map((photo) => photo.photoUrl);
  payload.importMeta.photoObjectKeys = uploadedPhotos
    .map((photo) => String(photo?.objectKey || '').trim())
    .filter(Boolean);

  try {
    await postApi.createListing(payload);
    db.markBackendSyncSuccess({ id: post.id, backendSyncTarget });
    return { skipped: false, synced: true, uploadedPhotosCount: uploadedPhotos.length };
  } catch (err) {
    db.markBackendSyncFailure({ id: post.id, error: err?.message || err });
    throw err;
  }
}

async function syncTaxiPostToBackend({ post, config, db, postApi, mediaUploader, backendSyncTarget }) {
  if (!config.postApiEnabled || !post?.id) return { skipped: true, reason: 'disabled-or-missing-post' };

  const { payload, backendEntityId } = buildTaxiPayload(post, config);
  const uploadedPhotos = [];
  const originalPhotoPaths = getPostPhotoPaths(post).slice(0, 10);
  const existingPhotoPaths = originalPhotoPaths.filter((photoPath) => fs.existsSync(photoPath));
  const missingPhotoPathsCount = originalPhotoPaths.length - existingPhotoPaths.length;

  if (missingPhotoPathsCount > 0) {
    db.updateStoredPhotos({
      id: post.id,
      photoPath: existingPhotoPaths[0] || null,
      photoPaths: existingPhotoPaths.length > 0 ? JSON.stringify(existingPhotoPaths) : null,
    });
    console.warn(
      `Skipping ${missingPhotoPathsCount} missing local photo(s) for ${post.source}/${post.msg_id} during taxi backend sync`
    );
  }

  for (const photoPath of existingPhotoPaths) {
    try {
      const uploadedPhoto = await mediaUploader.uploadPhotoFromPath(photoPath, { entityType: 'taxi' });
      if (uploadedPhoto?.photoUrl) {
        uploadedPhotos.push(uploadedPhoto);
      }
    } catch (err) {
      console.error(`Taxi photo upload failed for ${post.source}/${post.msg_id}: ${err?.message || err}`);
    }
  }

  if (uploadedPhotos.length > 0) {
    payload.carPhotos = uploadedPhotos.map((photo) => photo.photoUrl);
  }

  try {
    const response = backendEntityId
      ? await postApi.updateTaxiOffer({ ...payload, taxiOfferId: backendEntityId })
      : await postApi.createTaxiOffer(payload);
    const resolvedBackendEntityId = extractTaxiOfferIdFromBackendResponse(response) || backendEntityId;
    if (!backendEntityId && !resolvedBackendEntityId) {
      throw new Error('Taxi backend response did not include taxiOfferId');
    }
    db.markBackendSyncSuccess({
      id: post.id,
      backendSyncTarget,
      backendEntityId: resolvedBackendEntityId,
    });
    return {
      skipped: false,
      synced: true,
      uploadedPhotosCount: uploadedPhotos.length,
      backendEntityId: resolvedBackendEntityId,
      operation: backendEntityId ? 'update' : 'create',
    };
  } catch (err) {
    db.markBackendSyncFailure({ id: post.id, error: err?.message || err });
    throw err;
  }
}

async function syncPostToBackend(args) {
  if (args?.config?.pipelineMode === 'taxi') {
    return syncTaxiPostToBackend(args);
  }

  return syncListingPostToBackend(args);
}

async function deleteTaxiPostFromBackend({ post, config, postApi }) {
  const backendEntityId = Number(post?.backend_entity_id || post?.backendEntityId || 0);
  if (!config?.postApiEnabled || config?.pipelineMode !== 'taxi' || !Number.isInteger(backendEntityId) || backendEntityId <= 0) {
    return { skipped: true };
  }

  await postApi.deleteTaxiOffer({
    accountId: config.postApiAccountId,
    taxiOfferId: backendEntityId,
  });

  return { skipped: false, deleted: true };
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
  const storageTableName = getStorageTableName(config);
  const db = createPostsRepository('data.db', { tableName: storageTableName });
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
    console.log('\n✅ SESSION (скопируй в .env как TG_SESSION=...):\n');
    console.log(session);

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
      const expiredTaxiPosts = db.getExpiredByDepartureBefore(new Date().toISOString());
      if (expiredTaxiPosts.length > 0) {
        cleanupLocalPhotos(expiredTaxiPosts.flatMap((post) => getPostPhotoPaths(post)));
        if (config.postApiEnabled) {
          let deletedBackendPosts = 0;
          let failedBackendDeletes = 0;
          for (const expiredPost of expiredTaxiPosts) {
            try {
              const result = await deleteTaxiPostFromBackend({ post: expiredPost, config, postApi });
              if (!result?.skipped) {
                deletedBackendPosts++;
              }
            } catch (err) {
              failedBackendDeletes++;
              console.error(`Expired taxi backend cleanup failed for ${expiredPost.source}/${expiredPost.msg_id}: ${err?.message || err}`);
            }
          }
          const deletedLocalExpiredTaxiPosts = db.deletePostsByIds(expiredTaxiPosts.map((post) => post.id));
          for (const expiredPost of expiredTaxiPosts) {
            duplicateIndex.removePost(expiredPost);
          }
          console.log(
            `\nTaxi departure cleanup: removed ${deletedLocalExpiredTaxiPosts} expired local posts`
              + `, ${deletedBackendPosts} backend taxi offers`
              + (failedBackendDeletes > 0 ? ` (${failedBackendDeletes} backend deletions failed)` : '')
          );
        } else {
          const deletedLocalExpiredTaxiPosts = db.deletePostsByIds(expiredTaxiPosts.map((post) => post.id));
          for (const expiredPost of expiredTaxiPosts) {
            duplicateIndex.removePost(expiredPost);
          }
          console.log(`\nTaxi departure cleanup: removed ${deletedLocalExpiredTaxiPosts} expired local posts`);
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
      if (expiredPosts.length > 0) {
        cleanupLocalPhotos(expiredPosts.flatMap((post) => getPostPhotoPaths(post)));
      }
      const deletedExpiredPosts = db.deleteExpiredBefore(retentionCutoffIso);
      if (deletedExpiredPosts > 0) {
        for (const expiredPost of expiredPosts) {
          duplicateIndex.removePost(expiredPost);
        }
      }

      if (config.postApiEnabled) {
        try {
          if (config.pipelineMode === 'taxi') {
            let deletedBackendPosts = 0;
            let failedBackendDeletes = 0;
            for (const expiredPost of expiredPosts) {
              try {
                const result = await deleteTaxiPostFromBackend({ post: expiredPost, config, postApi });
                if (!result?.skipped) {
                  deletedBackendPosts++;
                }
              } catch (err) {
                failedBackendDeletes++;
                console.error(`Taxi TTL cleanup failed for ${expiredPost.source}/${expiredPost.msg_id}: ${err?.message || err}`);
              }
            }
            console.log(
              `\nTTL cleanup: removed ${deletedExpiredPosts} local posts`
                + `, ${deletedBackendPosts} backend taxi offers`
                + (failedBackendDeletes > 0 ? ` (${failedBackendDeletes} backend deletions failed)` : '')
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
        const postDateIso = normalizeTelegramMessageDate(primaryMessage?.date);
        const senderId = normalizeSenderId(
          primaryMessage?.senderId || unitMessages.find((item) => item?.senderId !== null && item?.senderId !== undefined)?.senderId
        );
        const taxiExpired = config.pipelineMode === 'taxi' && text
          ? isTaxiOfferExpired(text, primaryMessage?.date)
          : false;

        if (!text && !hasAnyVisualMedia) continue;
        if (isReply) {
          if (config.pipelineMode === 'taxi') {
            logTaxiSkip({ source, msgId: primaryMessage?.id, reason: 'reply', text });
          }
          skippedAsReply++;
          continue;
        }
        if (isRepost) {
          if (config.pipelineMode === 'taxi') {
            logTaxiSkip({ source, msgId: primaryMessage?.id, reason: 'repost', text });
          }
          skippedAsRepost++;
          continue;
        }
        if (config.onlyAds && (!text || !shouldKeepTextByFilter(text, config))) {
          if (config.pipelineMode === 'taxi') {
            logTaxiSkip({ source, msgId: primaryMessage?.id, reason: 'filter', text });
          }
          skippedByFilter++;
          continue;
        }
        if (config.pipelineMode === 'taxi' && taxiExpired) {
          logTaxiSkip({ source, msgId: primaryMessage?.id, reason: 'expired', text });
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
          if (config.pipelineMode === 'taxi') {
            logTaxiSkip({ source, msgId: primaryMessage?.id, reason: 'duplicate-content', text });
          }
          skippedAsDuplicate++;
          continue;
        }
        if (db.hasFuzzyDuplicate({
          msgId: primaryMessage.id,
          senderId,
          contactPhone: structured.contactPhone,
          dedupeKey,
        })) {
          if (config.pipelineMode === 'taxi') {
            logTaxiSkip({ source, msgId: primaryMessage?.id, reason: 'duplicate-fuzzy', text });
          }
          skippedAsDuplicate++;
          continue;
        }

        const matchedDuplicates = duplicateIndex.findMatches(incomingPost);
        if (matchedDuplicates.length > 0) {
          const latestExistingDuplicate = matchedDuplicates
            .sort(comparePostsByRecency)
            .at(-1);

          if (latestExistingDuplicate && comparePostsByRecency(latestExistingDuplicate, incomingPost) >= 0) {
            if (config.pipelineMode === 'taxi') {
              logTaxiSkip({ source, msgId: primaryMessage?.id, reason: 'duplicate-index', text });
            }
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
        }

        if (config.postApiEnabled && savedPost) {
          try {
            const syncResult = await syncPostToBackend({
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

        const refreshedSavedPost = db.getPostBySourceAndMsgId({ source, msgId: primaryMessage.id });
        const isBackendSynced = Boolean(refreshedSavedPost?.backend_synced_at || refreshedSavedPost?.backendSyncedAt);
        if (config.postApiEnabled && !config.savePhotos && photoPaths.length > 0 && isBackendSynced) {
          cleanupLocalPhotos(photoPaths);
        }

        saved++;
      }

      totalSaved += saved;
      console.log(
        `Scanned: ${scanned} | Saved: ${saved} | Replies: ${skippedAsReply} | Reposts: ${skippedAsRepost} | Duplicates: ${skippedAsDuplicate} | Skipped by filter: ${skippedByFilter} | Skipped without date: ${skippedWithoutDate} | Photos: ${photosSaved} | API photos uploaded: ${uploadedPhotosToApi} | API photo upload failed: ${uploadPhotosFailed} | API posted: ${postedToApi} | API failed: ${postApiFailed}`
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
