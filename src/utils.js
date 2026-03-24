import fs from 'node:fs';

export function buildPermalink(entity, msgId) {
  const username = entity?.username;
  return username ? `https://t.me/${username}/${msgId}` : null;
}

export function normalizeSenderId(senderId) {
  if (senderId === null || senderId === undefined) return null;
  if (typeof senderId === 'string') return senderId;
  if (typeof senderId === 'number' || typeof senderId === 'bigint') return String(senderId);
  if (typeof senderId?.toString === 'function') {
    const value = senderId.toString();
    return value && value !== '[object Object]' ? value : null;
  }
  return null;
}

export function normalizeTelegramMessageDate(dateValue) {
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

export function hasVisualMedia(message) {
  const hasPhoto = Boolean(message?.photo);
  const hasImageDoc = String(message?.media?.document?.mimeType || '').startsWith('image/');
  return hasPhoto || hasImageDoc;
}

export function getGroupedId(message) {
  const raw = message?.groupedId;
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  return value && value !== '[object Object]' ? value : null;
}

export function buildRetentionCutoffIso(retentionDays) {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) return null;
  return new Date(Date.now() - (retentionDays * 24 * 60 * 60 * 1000)).toISOString();
}

export function cleanupLocalPhotos(photoPaths) {
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

export function parseStoredPhotoPaths(value) {
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

export function getPostPhotoPaths(post) {
  const multiValue = post?.photo_paths ?? post?.photoPaths;
  const parsedMultiValue = parseStoredPhotoPaths(multiValue);
  if (parsedMultiValue.length > 0) {
    return parsedMultiValue;
  }
  return parseStoredPhotoPaths(post?.photo_path || post?.photoPath);
}

export function buildPostPreview(text, maxLength = 90) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trim()}...`;
}

export function splitMultiValueField(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getFirstMultiValue(value, { prefix = '' } = {}) {
  const firstValue = splitMultiValueField(value)[0] || null;
  if (!firstValue) return null;
  return prefix && !firstValue.startsWith(prefix) ? `${prefix}${firstValue}` : firstValue;
}
