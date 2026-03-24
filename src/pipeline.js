import {
  looksLikeAd,
  detectPostKind,
  extractStructuredData,
  FALLBACK_LISTING_CATEGORY_BY_CODE,
  FALLBACK_SERVICE_CATEGORY_BY_CODE,
} from './parsing/adParser.js';
import { looksLikeTaxiOffer, extractTaxiStructuredData } from './parsing/taxiParser.js';
import { buildPostPreview, getGroupedId } from './utils.js';

export function getStorageTableName(config) {
  if (config?.pipelineMode === 'taxi') return 'taxi_posts';
  return config?.pipelineMode === 'services' ? 'service_posts' : 'posts';
}

export function matchesPipelineMode(text, config) {
  if (config?.pipelineMode === 'taxi') {
    return looksLikeTaxiOffer(text);
  }
  const detectedKind = detectPostKind(text);
  return config?.pipelineMode === 'services' ? detectedKind === 2 : detectedKind !== 2;
}

export function shouldKeepTextByFilter(text, config) {
  if (config?.pipelineMode === 'taxi') {
    return looksLikeTaxiOffer(text);
  }

  return looksLikeAd(text, config.adKeywords) && matchesPipelineMode(text, config);
}

export function extractPostData(text, config) {
  if (config?.pipelineMode === 'taxi') {
    return extractTaxiStructuredData(text);
  }

  return extractStructuredData(text, { kind: config.postApiKind });
}

function getFallbackCategoryMap(kind) {
  return Number(kind) === 2 ? FALLBACK_SERVICE_CATEGORY_BY_CODE : FALLBACK_LISTING_CATEGORY_BY_CODE;
}

function normalizeCategoryLookupKey(value) {
  return String(value || '').trim().toLowerCase();
}

export function createCategoryResolver(categories, config, kind) {
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

export async function loadCategoryResolver({ config, postApi }) {
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

export function buildMessageUnits(messages) {
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

export function logTaxiSkip({ source, msgId, reason, text }) {
  const preview = buildPostPreview(text);
  const suffix = preview ? ` | ${preview}` : '';
  console.log(`Skip taxi ${source}/${msgId}: ${reason}${suffix}`);
}

export function recordTaxiSkip({ config, stats, source, msgId, reason, text }) {
  if (config?.pipelineMode !== 'taxi') return;
  stats[reason] = Number(stats[reason] || 0) + 1;
  if (config?.taxiVerboseSkips) {
    logTaxiSkip({ source, msgId, reason, text });
  }
}

export function formatTaxiSkipSummary(stats) {
  const entries = Object.entries(stats || {})
    .filter(([, count]) => Number(count) > 0)
    .sort((left, right) => right[1] - left[1]);

  if (entries.length === 0) return '';
  return entries.map(([reason, count]) => `${reason}: ${count}`).join(' | ');
}
