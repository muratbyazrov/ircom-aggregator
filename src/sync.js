import fs from 'node:fs';

import { truncateTitle } from './parsing/adParser.js';
import { extractTaxiStructuredData, resolveTaxiDepartureAt } from './parsing/taxiParser.js';
import { splitMultiValueField, getFirstMultiValue, getPostPhotoPaths } from './utils.js';

const MAX_PHOTOS_PER_LISTING = 8;

export function extractTaxiOfferIdFromBackendResponse(response) {
  const payload = response?.data ?? response ?? null;
  const taxiOfferId = Number(payload?.taxiOfferId || 0);
  return Number.isInteger(taxiOfferId) && taxiOfferId > 0 ? taxiOfferId : null;
}

export function buildBackendSyncTarget(config) {
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

export function buildListingPayload(post, config, categoryResolver) {
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
    title: truncateTitle(String(post?.title || '').trim() || 'Объявление', 50),
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

export function buildTaxiPayload(post, config) {
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
    importMeta: {
      source: post?.source,
      msgId: post?.msg_id ?? post?.msgId,
      date: post?.date,
      permalink: post?.permalink || null,
      contentHash: post?.content_hash || post?.contentHash || null,
      photoObjectKeys: [],
    },
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

export async function syncListingPostToBackend({ post, config, db, postApi, mediaUploader, backendSyncTarget, categoryResolver }) {
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

export async function syncTaxiPostToBackend({ post, config, db, postApi, mediaUploader, backendSyncTarget }) {
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
    payload.importMeta.photoObjectKeys = uploadedPhotos
      .map((photo) => String(photo?.objectKey || '').trim())
      .filter(Boolean);
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

export async function syncPostToBackend(args) {
  if (args?.config?.pipelineMode === 'taxi') {
    return syncTaxiPostToBackend(args);
  }

  return syncListingPostToBackend(args);
}

export async function deleteTaxiPostFromBackend({ post, config, postApi }) {
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
