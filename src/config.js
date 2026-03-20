import 'dotenv/config';

const DEFAULT_AD_KEYWORDS = [
  'продам',
  'продаю',
  'куплю',
  'сдам',
  'аренда',
  'ищу',
  'работа',
  'вакансия',
  'услуги',
  'цена',
  'торг',
  'руб',
  'сом',
  'тенге',
  'kzt',
  'kgs',
  'usd',
];

function parseList(value) {
  return String(value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBool(value, defaultValue = false) {
  const normalized = String(value ?? '').toLowerCase();
  if (!normalized) return defaultValue;
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  return defaultValue;
}

function parsePostApiKind(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;

  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function parsePipelineMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (['ads', 'ad', 'listing', 'listings'].includes(normalized)) return 'ads';
  if (['services', 'service'].includes(normalized)) return 'services';
  if (['taxi', 'rides', 'travel'].includes(normalized)) return 'taxi';
  return normalized;
}

function resolvePipelineMode(rawMode, rawKind) {
  const parsedMode = parsePipelineMode(rawMode);
  if (parsedMode) return parsedMode;
  return parsePostApiKind(rawKind) === 2 ? 'services' : 'ads';
}

function normalizeSource(rawSource) {
  const src = String(rawSource || '').trim();
  if (!src) return '';
  if (src.startsWith('@')) return src.slice(1);

  const match = src.match(/^https?:\/\/t\.me\/([a-zA-Z0-9_+]+)(?:\/.*)?$/i);
  if (match?.[1]) return match[1];

  return src;
}

function resolveSources() {
  return parseList(process.env.TG_SOURCES).map(normalizeSource).filter(Boolean);
}

function resolveAdKeywords() {
  const envKeywords = parseList(process.env.TG_AD_KEYWORDS).map((kw) => kw.toLowerCase());
  return envKeywords.length > 0 ? envKeywords : DEFAULT_AD_KEYWORDS;
}

export function loadConfig() {
  const explicitPostApiKind = parsePostApiKind(process.env.TG_POST_API_KIND);
  const pipelineMode = resolvePipelineMode(process.env.TG_PIPELINE_MODE, process.env.TG_POST_API_KIND);
  const postApiRequested = parseBool(process.env.TG_POST_API_ENABLED, false);
  const derivedPostApiKind = pipelineMode === 'services'
    ? 2
    : pipelineMode === 'ads'
      ? 1
      : null;

  const config = {
    apiId: Number(process.env.TG_API_ID),
    apiHash: process.env.TG_API_HASH,
    defaultPhoneNumber: String(process.env.TG_PHONE_NUMBER || '').trim(),
    forceSms: parseBool(process.env.TG_FORCE_SMS, false),
    fetchLimit: Number(process.env.TG_FETCH_LIMIT || 100),
    onlyAds: parseBool(process.env.TG_ONLY_ADS, true),
    savePhotos: parseBool(process.env.TG_SAVE_PHOTOS, true),
    clearBeforeRun: parseBool(process.env.TG_CLEAR_BEFORE_RUN, false),
    photosDir: String(process.env.TG_PHOTOS_DIR || 'media').trim(),
    session: process.env.TG_SESSION || '',
    pipelineMode,
    sources: resolveSources(),
    adKeywords: resolveAdKeywords(),
    postApiRequested,
    postApiEnabled: postApiRequested,
    postApiUrl: String(process.env.TG_POST_API_URL || 'http://127.0.0.1:3002/ircom-api/v1').trim(),
    postApiAccountId: Number(process.env.TG_POST_API_ACCOUNT_ID || 0),
    postApiKind: explicitPostApiKind || derivedPostApiKind,
    postApiDefaultCategory: String(process.env.TG_POST_API_DEFAULT_CATEGORY || 'Другое').trim(),
    postApiDefaultPrice: Number(process.env.TG_POST_API_DEFAULT_PRICE || 1),
    postApiTimeoutMs: Number(process.env.TG_POST_API_TIMEOUT_MS || 15000),
    retentionDays: Number(process.env.TG_RETENTION_DAYS || 0),
    s3PublicBaseUrl: String(process.env.TG_S3_PUBLIC_BASE_URL || '').trim(),
    s3MaxUploadBytes: Number(process.env.TG_S3_MAX_UPLOAD_BYTES || 10485760),
    s3ImageOptimizationEnabled: parseBool(process.env.TG_S3_IMAGE_OPTIMIZATION_ENABLED, true),
    s3ImageMaxDimension: Number(process.env.TG_S3_IMAGE_MAX_DIMENSION || 2000),
    s3ImageQuality: Number(process.env.TG_S3_IMAGE_QUALITY || 84),
  };

  validateConfig(config);
  return config;
}

function validateConfig(config) {
  if (!Number.isInteger(config.apiId) || config.apiId <= 0) {
    throw new Error('Invalid TG_API_ID in .env. Expected a positive integer from my.telegram.org');
  }
  if (!config.apiHash || typeof config.apiHash !== 'string' || config.apiHash.trim().length < 10) {
    throw new Error('Invalid TG_API_HASH in .env. Expected a non-empty hash from my.telegram.org');
  }
  if (!Number.isInteger(config.fetchLimit) || config.fetchLimit <= 0) {
    throw new Error('Invalid TG_FETCH_LIMIT in .env. Expected a positive integer.');
  }
  if (!Number.isInteger(config.retentionDays) || config.retentionDays < 0) {
    throw new Error('Invalid TG_RETENTION_DAYS in .env. Expected an integer >= 0.');
  }
  if (config.sources.length === 0) {
    throw new Error(
      'No sources configured. Add TG_SOURCES in .env, e.g. TG_SOURCES=@channel1,@channel2,https://t.me/some_group'
    );
  }
  if (!['ads', 'services'].includes(config.pipelineMode)) {
    if (config.pipelineMode !== 'taxi') {
      throw new Error('Invalid TG_PIPELINE_MODE in .env. Expected ads, services or taxi.');
    }
  }
  if (
    Number.isInteger(config.postApiKind)
    && ((config.pipelineMode === 'services' && config.postApiKind !== 2)
      || (config.pipelineMode === 'ads' && config.postApiKind !== 1))
  ) {
    throw new Error('TG_PIPELINE_MODE conflicts with TG_POST_API_KIND in .env. Keep them aligned.');
  }
  if (config.postApiEnabled) {
    if (!config.postApiUrl) {
      throw new Error('Invalid TG_POST_API_URL in .env. Expected a non-empty HTTP endpoint.');
    }
    if (!Number.isInteger(config.postApiAccountId) || config.postApiAccountId <= 0) {
      throw new Error('Invalid TG_POST_API_ACCOUNT_ID in .env. Expected a positive integer account id.');
    }
    if (config.pipelineMode !== 'taxi' && ![1, 2].includes(config.postApiKind)) {
      throw new Error('Invalid TG_POST_API_KIND in .env. Expected 1 (ad) or 2 (service).');
    }
    if (!Number.isFinite(config.postApiDefaultPrice) || config.postApiDefaultPrice <= 0) {
      throw new Error('Invalid TG_POST_API_DEFAULT_PRICE in .env. Expected a positive number.');
    }
    if (!Number.isInteger(config.postApiTimeoutMs) || config.postApiTimeoutMs <= 0) {
      throw new Error('Invalid TG_POST_API_TIMEOUT_MS in .env. Expected a positive integer.');
    }
    if (!Number.isFinite(config.s3MaxUploadBytes) || config.s3MaxUploadBytes <= 0) {
      throw new Error('Invalid TG_S3_MAX_UPLOAD_BYTES in .env. Expected a positive number.');
    }
    if (!Number.isInteger(config.s3ImageMaxDimension) || config.s3ImageMaxDimension <= 0) {
      throw new Error('Invalid TG_S3_IMAGE_MAX_DIMENSION in .env. Expected a positive integer.');
    }
    if (!Number.isInteger(config.s3ImageQuality) || config.s3ImageQuality < 1 || config.s3ImageQuality > 100) {
      throw new Error('Invalid TG_S3_IMAGE_QUALITY in .env. Expected an integer from 1 to 100.');
    }
  }
}
