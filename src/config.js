import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse as parseDotenv } from 'dotenv';

function parseCliArgValue(argv, flagName) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '').trim();
    if (!arg) continue;

    if (arg === flagName) {
      const nextValue = String(argv[index + 1] || '').trim();
      return nextValue || null;
    }

    if (arg.startsWith(`${flagName}=`)) {
      const value = arg.slice(flagName.length + 1).trim();
      return value || null;
    }
  }

  return null;
}

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

function parseRuntimeOptions(argv, env) {
  const cliMode = parsePipelineMode(parseCliArgValue(argv, '--mode'));
  const cliEnvFile = parseCliArgValue(argv, '--env-file');
  const envFile = String(env?.TG_ENV_FILE || cliEnvFile || '').trim();

  return {
    mode: cliMode,
    envFile,
  };
}

function resolveEnvFilePath(filePath, cwd) {
  if (!filePath) return null;
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

function applyEnvFile(filePath, env, { override }) {
  if (!filePath || !existsSync(filePath)) return false;

  const parsed = parseDotenv(readFileSync(filePath));
  for (const [key, value] of Object.entries(parsed)) {
    if (override || !(key in env)) {
      env[key] = value;
    }
  }

  return true;
}

function loadRuntimeEnv({ env, argv, cwd }) {
  const runtimeOptions = parseRuntimeOptions(argv, env);
  const loadedFiles = [];

  const baseEnvPath = path.resolve(cwd, '.env');
  if (applyEnvFile(baseEnvPath, env, { override: false })) {
    loadedFiles.push(baseEnvPath);
  }

  const explicitEnvPath = resolveEnvFilePath(runtimeOptions.envFile, cwd);
  if (explicitEnvPath && !loadedFiles.includes(explicitEnvPath)) {
    if (applyEnvFile(explicitEnvPath, env, { override: true })) {
      loadedFiles.push(explicitEnvPath);
    }
  }

  return {
    ...runtimeOptions,
    loadedFiles,
  };
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

function resolveSources(env) {
  return parseList(env.TG_SOURCES).map(normalizeSource).filter(Boolean);
}

async function loadFileConfig(pipelineMode, cwd) {
  const load = async (filePath) => {
    if (!existsSync(filePath)) return {};
    const { default: cfg } = await import(pathToFileURL(filePath).href);
    return cfg || {};
  };

  const defaultCfg = await load(path.resolve(cwd, 'config', 'default.js'));
  const modeCfg = pipelineMode
    ? await load(path.resolve(cwd, 'config', `${pipelineMode}.js`))
    : {};

  return { ...defaultCfg, ...modeCfg };
}

export async function loadConfig(options = {}) {
  const env = options.env || process.env;
  const argv = Array.isArray(options.argv) ? options.argv : process.argv.slice(2);
  const cwd = options.cwd || process.cwd();
  const shouldLoadEnvFiles = options.loadEnvFiles !== false;

  const runtimeOptions = shouldLoadEnvFiles
    ? loadRuntimeEnv({ env, argv, cwd })
    : parseRuntimeOptions(argv, env);

  const rawMode = runtimeOptions.mode || env.TG_PIPELINE_MODE;
  const pipelineMode = resolvePipelineMode(rawMode, env.TG_POST_API_KIND);

  // Загружаем несекретные настройки из config-файлов
  const fc = await loadFileConfig(pipelineMode, cwd);

  // Sources: TG_SOURCES в env переопределяет config-файл
  const sources = env.TG_SOURCES
    ? resolveSources(env)
    : (fc.sources || []).map(normalizeSource).filter(Boolean);

  // adKeywords: TG_AD_KEYWORDS в env переопределяет config-файл
  const envKeywords = parseList(env.TG_AD_KEYWORDS || '').map((kw) => kw.toLowerCase());
  const adKeywords = envKeywords.length > 0
    ? envKeywords
    : (fc.adKeywords || []).map((kw) => kw.toLowerCase());

  const explicitPostApiKind = parsePostApiKind(env.TG_POST_API_KIND);
  const derivedPostApiKind = pipelineMode === 'services' ? 2 : pipelineMode === 'ads' ? 1 : null;
  const postApiKind = explicitPostApiKind ?? fc.postApiKind ?? derivedPostApiKind;
  const postApiRequested = parseBool(env.TG_POST_API_ENABLED, fc.postApiEnabled ?? false);
  const dedupOnly = parseBool(env.TG_DEDUP_ONLY, false);

  const config = {
    // Секреты из .env
    apiId: Number(env.TG_API_ID),
    apiHash: env.TG_API_HASH,
    defaultPhoneNumber: String(env.TG_PHONE_NUMBER || '').trim(),
    forceSms: parseBool(env.TG_FORCE_SMS, false),
    session: env.TG_SESSION || '',
    postApiAccountId: Number(env.TG_POST_API_ACCOUNT_ID || 0),
    postApiUrl: String(env.TG_POST_API_URL || 'http://127.0.0.1:3002/ircom-api/v1').trim(),
    s3PublicBaseUrl: String(env.TG_S3_PUBLIC_BASE_URL || '').trim(),

    // Из config-файлов (env переопределяет при наличии)
    pipelineMode,
    sources,
    adKeywords,
    postApiKind,
    postApiRequested,
    postApiEnabled: postApiRequested,
    postApiDefaultCategory: String(env.TG_POST_API_DEFAULT_CATEGORY || fc.postApiDefaultCategory || 'Другое').trim(),
    postApiDefaultPrice: Number(env.TG_POST_API_DEFAULT_PRICE || fc.postApiDefaultPrice) || null,
    postApiTimeoutMs: Number(env.TG_POST_API_TIMEOUT_MS || fc.postApiTimeoutMs || 15000),
    fetchLimit: Number(env.TG_FETCH_LIMIT || fc.fetchLimit || 100),
    onlyAds: parseBool(env.TG_ONLY_ADS, fc.onlyAds ?? true),
    savePhotos: parseBool(env.TG_SAVE_PHOTOS, fc.savePhotos ?? true),
    clearBeforeRun: parseBool(env.TG_CLEAR_BEFORE_RUN, fc.clearBeforeRun ?? false),
    photosDir: String(env.TG_PHOTOS_DIR || fc.photosDir || 'media').trim(),
    dbPath: String(env.TG_DB_PATH || 'data.db').trim(),
    taxiVerboseSkips: parseBool(env.TG_TAXI_VERBOSE_SKIPS, fc.taxiVerboseSkips ?? false),
    retentionDays: (env.TG_RETENTION_DAYS != null && env.TG_RETENTION_DAYS !== '')
      ? Number(env.TG_RETENTION_DAYS)
      : Number(fc.retentionDays ?? 0),
    s3MaxUploadBytes: Number(env.TG_S3_MAX_UPLOAD_BYTES || fc.s3MaxUploadBytes || 10485760),
    s3ImageOptimizationEnabled: parseBool(env.TG_S3_IMAGE_OPTIMIZATION_ENABLED, fc.s3ImageOptimizationEnabled ?? true),
    s3ImageMaxDimension: Number(env.TG_S3_IMAGE_MAX_DIMENSION || fc.s3ImageMaxDimension || 2000),
    s3ImageQuality: Number(env.TG_S3_IMAGE_QUALITY || fc.s3ImageQuality || 84),

    runtimeMode: runtimeOptions.mode || null,
    loadedEnvFiles: runtimeOptions.loadedFiles || [],
    dedupOnly,
  };

  validateConfig(config);
  return config;
}

function validateConfig(config) {
  if (config.dedupOnly) {
    if (!config.postApiEnabled) {
      throw new Error('TG_DEDUP_ONLY requires TG_POST_API_ENABLED=true or postApiEnabled: true in config/default.js.');
    }
    if (!Number.isInteger(config.postApiAccountId) || config.postApiAccountId <= 0) {
      throw new Error('TG_DEDUP_ONLY requires TG_POST_API_ACCOUNT_ID in .env.');
    }
    if (config.pipelineMode !== 'taxi' && ![1, 2].includes(config.postApiKind)) {
      throw new Error('TG_DEDUP_ONLY requires postApiKind in config/ads.js or config/services.js.');
    }
    return;
  }

  if (!Number.isInteger(config.apiId) || config.apiId <= 0) {
    throw new Error('Invalid TG_API_ID in .env. Expected a positive integer from my.telegram.org');
  }
  if (!config.apiHash || typeof config.apiHash !== 'string' || config.apiHash.trim().length < 10) {
    throw new Error('Invalid TG_API_HASH in .env. Expected a non-empty hash from my.telegram.org');
  }
  if (!Number.isInteger(config.fetchLimit) || config.fetchLimit <= 0) {
    throw new Error('Invalid fetchLimit. Expected a positive integer in config/default.js or TG_FETCH_LIMIT in .env.');
  }
  if (!Number.isInteger(config.retentionDays) || config.retentionDays < 0) {
    throw new Error('Invalid retentionDays. Expected an integer >= 0 in config/default.js or config/taxi.js.');
  }
  if (config.sources.length === 0) {
    throw new Error(
      `No sources configured. Add sources to config/${config.pipelineMode}.js`
    );
  }
  if (!['ads', 'services', 'taxi'].includes(config.pipelineMode)) {
    throw new Error('Invalid pipeline mode. Use --mode=ads, --mode=services or --mode=taxi.');
  }
  if (
    Number.isInteger(config.postApiKind)
    && ((config.pipelineMode === 'services' && config.postApiKind !== 2)
      || (config.pipelineMode === 'ads' && config.postApiKind !== 1))
  ) {
    throw new Error('pipelineMode conflicts with postApiKind in config files. Keep them aligned.');
  }
  if (config.postApiEnabled) {
    if (!config.postApiUrl) {
      throw new Error('Invalid TG_POST_API_URL in .env. Expected a non-empty HTTP endpoint.');
    }
    if (!Number.isInteger(config.postApiAccountId) || config.postApiAccountId <= 0) {
      throw new Error('Invalid TG_POST_API_ACCOUNT_ID in .env. Expected a positive integer account id.');
    }
    if (config.pipelineMode !== 'taxi' && ![1, 2].includes(config.postApiKind)) {
      throw new Error('Invalid postApiKind. Expected 1 (ads) or 2 (services) in config file.');
    }
    if (config.postApiDefaultPrice !== null && (!Number.isFinite(config.postApiDefaultPrice) || config.postApiDefaultPrice <= 0)) {
      throw new Error('Invalid postApiDefaultPrice. Expected a positive number or null in config/default.js.');
    }
    if (!Number.isInteger(config.postApiTimeoutMs) || config.postApiTimeoutMs <= 0) {
      throw new Error('Invalid postApiTimeoutMs. Expected a positive integer in config/default.js.');
    }
    if (!Number.isFinite(config.s3MaxUploadBytes) || config.s3MaxUploadBytes <= 0) {
      throw new Error('Invalid s3MaxUploadBytes. Expected a positive number in config/default.js.');
    }
    if (!Number.isInteger(config.s3ImageMaxDimension) || config.s3ImageMaxDimension <= 0) {
      throw new Error('Invalid s3ImageMaxDimension. Expected a positive integer in config/default.js.');
    }
    if (!Number.isInteger(config.s3ImageQuality) || config.s3ImageQuality < 1 || config.s3ImageQuality > 100) {
      throw new Error('Invalid s3ImageQuality. Expected an integer from 1 to 100 in config/default.js.');
    }
  }
}
