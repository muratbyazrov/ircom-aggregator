import { buildDuplicateFingerprint } from './parsing/adParser.js';
import { TAXI_POST_EXPIRY_GRACE_MS } from './parsing/taxiParser.js';
import { normalizeSenderId, splitMultiValueField } from './utils.js';

const PHONE_LIKE_RE = /(?<![\d,.])(?:\+?\d{10,15}|\+?\d{1,4}(?:[\s()-]+\d{1,4}){2,})(?![\d])/gu;

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

export function buildDuplicateIdentityKeys(post) {
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
  if (titleFingerprint && dedupeKey) {
    keys.add(`title-fuzzy:${titleFingerprint}:${dedupeKey}`);
  }

  const taxiDirection = post?.taxi_direction ?? post?.taxiDirection;
  const taxiDepartureAt = post?.taxi_departure_at ?? post?.taxiDepartureAt;
  if (taxiDirection != null && taxiDepartureAt) {
    const departureHour = new Date(taxiDepartureAt).toISOString().slice(0, 13);
    if (departureHour && !departureHour.startsWith('Invalid')) {
      for (const phone of splitMultiValueField(post?.contact_phone || post?.contactPhone)) {
        keys.add(`phone-route-time:${phone}:${taxiDirection}:${departureHour}`);
      }
    }
  }

  return [...keys];
}

export function getComparableMessageId(post) {
  const value = Number(post?.msg_id ?? post?.msgId ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function comparePostsByRecency(left, right) {
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

export function createDuplicateIndex(posts) {
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

export function findStaleDuplicatePosts(posts) {
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

export function buildBackendItemDedupPost(item, { isTaxi = false } = {}) {
  const text = [item.description, item.title].filter(Boolean).join(' ');
  const listingId = Number(item.listingId) || null;
  const taxiOfferId = Number(item.taxiOfferId) || null;
  const entityId = isTaxi ? taxiOfferId : listingId;

  return {
    // entity references for deletion
    listingId,
    taxiOfferId,
    source: item.source,

    // comparePostsByRecency fields
    date: item.messageDate,
    msg_id: item.msgId,
    id: entityId,

    // buildDuplicateIdentityKeys fields
    content_hash: item.contentHash || null,
    dedupe_key: buildDuplicateFingerprint(text),
    title: item.title || null,
    contact_phone: item.phone || null,
    contact_username: item.telegram || null,
    sender_id: null,
  };
}

async function fetchAllImportedItemsFromBackend({ config, postApi }) {
  const isTaxi = config.pipelineMode === 'taxi';
  const accountId = config.postApiAccountId;
  const kind = config.postApiKind;
  const pageSize = 200;
  const allItems = [];
  let offset = 0;

  while (true) {
    let result;
    if (isTaxi) {
      result = await postApi.getImportedTaxiOffersForDedup({ accountId, limit: pageSize, offset });
    } else {
      result = await postApi.getImportedListingsForDedup({ accountId, kind, limit: pageSize, offset });
    }

    const items = Array.isArray(result?.data) ? result.data : [];
    if (items.length === 0) break;
    allItems.push(...items);
    if (items.length < pageSize) break;
    offset += pageSize;
  }

  return allItems;
}

async function deleteBackendDuplicate({ item, isTaxi, config, postApi }) {
  const accountId = config.postApiAccountId;

  if (isTaxi) {
    const taxiOfferId = Number(item.taxiOfferId);
    if (!Number.isInteger(taxiOfferId) || taxiOfferId <= 0) {
      throw new Error(`Invalid taxiOfferId: ${item.taxiOfferId}`);
    }
    await postApi.deleteTaxiOffer({ accountId, taxiOfferId });
  } else {
    const listingId = Number(item.listingId);
    if (!Number.isInteger(listingId) || listingId <= 0) {
      throw new Error(`Invalid listingId: ${item.listingId}`);
    }
    await postApi.deleteImportedListingById({
      accountId,
      kind: config.postApiKind,
      listingId,
    });
  }
}

function isBackendItemDepartureExpired(item, now) {
  if (!item.departureAt) return false;
  const departureTime = new Date(item.departureAt).getTime();
  return Number.isFinite(departureTime) && departureTime + TAXI_POST_EXPIRY_GRACE_MS < now.getTime();
}

// Deletes backend taxi offers whose departure time has already passed.
// Accepts pre-fetched `backendItems` to avoid a redundant API call when
// called from runDedupMode which already has the list.
export async function cleanupExpiredBackendDepartures({ config, postApi, backendItems = null }) {
  const items = backendItems ?? await fetchAllImportedItemsFromBackend({ config, postApi });
  const now = new Date();
  const expired = items.filter((item) => isBackendItemDepartureExpired(item, now));

  if (expired.length === 0) return { deleted: 0, failed: 0 };

  let deleted = 0;
  let failed = 0;

  for (const item of expired) {
    const taxiOfferId = Number(item.taxiOfferId);
    const label = `${item.source}/${item.msgId}`;
    try {
      await postApi.deleteTaxiOffer({ accountId: config.postApiAccountId, taxiOfferId });
      console.log(`  Deleted expired departure: ${label} (departed ${item.departureAt})`);
      deleted++;
    } catch (err) {
      console.error(`  Failed to delete expired ${label}: ${err?.message || err}`);
      failed++;
    }
  }

  return { deleted, failed };
}

export async function runDedupMode({ config, postApi }) {
  const isTaxi = config.pipelineMode === 'taxi';
  const modeLabel = isTaxi ? 'taxi offers' : `listings kind=${config.postApiKind}`;

  console.log(`\nDedup mode: scanning backend ${modeLabel} for duplicates...`);

  const backendItems = await fetchAllImportedItemsFromBackend({ config, postApi });
  console.log(`Fetched ${backendItems.length} imported ${modeLabel} from backend`);

  if (backendItems.length === 0) {
    console.log('Nothing to dedup.');
    return;
  }

  // For taxi: also remove offers whose departure time has already passed.
  if (isTaxi) {
    console.log('\nChecking for expired taxi departures...');
    const { deleted, failed } = await cleanupExpiredBackendDepartures({ config, postApi, backendItems });
    console.log(
      `Expired departures: deleted ${deleted}`
        + (failed > 0 ? `, failed ${failed}` : '')
    );
  }

  const dedupPosts = backendItems.map((item) => buildBackendItemDedupPost(item, { isTaxi }));
  const stalePosts = findStaleDuplicatePosts(dedupPosts);

  console.log(`\nFound ${stalePosts.length} stale duplicate${stalePosts.length !== 1 ? 's' : ''}`);

  if (stalePosts.length === 0) {
    console.log('No duplicates to remove.');
    return;
  }

  let deleted = 0;
  let failed = 0;

  for (const stalePost of stalePosts) {
    const label = `${stalePost.source}/${stalePost.msg_id}`;
    try {
      await deleteBackendDuplicate({ item: stalePost, isTaxi, config, postApi });
      console.log(`  Deleted duplicate: ${label}`);
      deleted++;
    } catch (err) {
      console.error(`  Failed to delete ${label}: ${err?.message || err}`);
      failed++;
    }
  }

  console.log(
    `\nDedup complete: deleted ${deleted} duplicate${deleted !== 1 ? 's' : ''}`
      + (failed > 0 ? `, failed ${failed}` : '')
  );
}
