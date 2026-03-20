import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

function parseErrorMessage(payload) {
  if (!payload) return 'Request failed';
  if (typeof payload === 'string') return payload;
  if (payload?.error?.message) return payload.error.message;
  if (payload?.error?.msg) return payload.error.msg;
  if (typeof payload?.error === 'string') return payload.error;
  if (payload?.message) return payload.message;
  if (payload?.msg) return payload.msg;
  try {
    return JSON.stringify(payload);
  } catch {
    return 'Request failed';
  }
}

function normalizePhotoReference(value, publicBaseUrl) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!publicBaseUrl) return raw;
  return `${publicBaseUrl}/${encodeURIComponent(raw).replace(/%2F/g, '/')}`;
}

function buildPhotoUrlFromUpload(uploadUrl, objectKey) {
  const normalizedKey = String(objectKey || '').trim();
  const normalizedUrl = String(uploadUrl || '').trim().replace(/\/+$/, '');
  if (!normalizedKey || !normalizedUrl) return '';
  return `${normalizedUrl}/${encodeURIComponent(normalizedKey).replace(/%2F/g, '/')}`;
}

function extractS3Error(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const code = text.match(/<Code>([^<]+)<\/Code>/i)?.[1] || '';
  const message = text.match(/<Message>([^<]+)<\/Message>/i)?.[1] || '';
  if (code && message) return `${code}: ${message}`;
  if (message) return message;
  return text.slice(0, 400);
}

function resolveMimeType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.heic' || ext === '.heif') return 'image/heic';
  return 'image/jpeg';
}

function replaceExtension(fileName, ext) {
  const baseName = String(fileName || '').trim();
  if (!baseName) return `upload${ext}`;
  return baseName.replace(/\.[^.]+$/, '') === baseName ? `${baseName}${ext}` : baseName.replace(/\.[^.]+$/, ext);
}

function canOptimizeMimeType(mimeType) {
  return ['image/jpeg', 'image/png', 'image/webp', 'image/heic'].includes(String(mimeType || '').trim().toLowerCase());
}

async function preparePhotoForUpload({
  photoPath,
  fileName,
  mimeType,
  maxDimension,
  quality,
  optimizationEnabled,
}) {
  const originalBuffer = fs.readFileSync(photoPath);
  const originalSize = originalBuffer.byteLength;
  const fallback = {
    fileName,
    mimeType,
    fileBuffer: originalBuffer,
    optimized: false,
    originalSize,
    uploadSize: originalSize,
  };

  if (!optimizationEnabled || !canOptimizeMimeType(mimeType)) {
    return fallback;
  }

  try {
    const metadata = await sharp(originalBuffer, { failOn: 'none' }).metadata();
    if (!metadata.width && !metadata.height) {
      return fallback;
    }

    const optimizedBuffer = await sharp(originalBuffer, { failOn: 'none' })
      .rotate()
      .resize({
        width: maxDimension,
        height: maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({
        quality,
        effort: 4,
      })
      .toBuffer();

    if (!optimizedBuffer || optimizedBuffer.byteLength >= originalSize) {
      return fallback;
    }

    return {
      fileName: replaceExtension(fileName, '.webp'),
      mimeType: 'image/webp',
      fileBuffer: optimizedBuffer,
      optimized: true,
      originalSize,
      uploadSize: optimizedBuffer.byteLength,
    };
  } catch {
    return fallback;
  }
}

export function createMediaUploader(config) {
  const endpoint = String(config?.postApiUrl || '').trim();
  const accountId = Number(config?.postApiAccountId || 0);
  const timeoutMs = Number(config?.postApiTimeoutMs || 15000);
  const publicBaseUrl = String(config?.s3PublicBaseUrl || '').trim().replace(/\/+$/, '');
  const maxSizeBytes = Number(config?.s3MaxUploadBytes || 10485760);
  const imageOptimizationEnabled = Boolean(config?.s3ImageOptimizationEnabled);
  const imageMaxDimension = Number(config?.s3ImageMaxDimension || 2000);
  const imageQuality = Number(config?.s3ImageQuality || 84);

  async function callApi({ domain, event, params }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ domain, event, params }),
        signal: controller.signal,
      });

      let payload = null;
      let rawBody = '';
      try {
        rawBody = await response.text();
        payload = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        payload = null;
      }

      if (!response.ok) {
        throw new Error(parseErrorMessage(payload || rawBody) || `HTTP ${response.status}`);
      }
      if (payload?.error) {
        throw new Error(parseErrorMessage(payload));
      }

      return payload?.data ?? payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function uploadFileToS3({ uploadUrl, fields, fileName, mimeType, fileBuffer }) {
    const formData = new FormData();
    Object.entries(fields || {}).forEach(([key, value]) => {
      formData.append(key, value);
    });
    const fileBlob = new Blob([fileBuffer], { type: mimeType });
    formData.append('file', fileBlob, fileName);

    const response = await fetch(uploadUrl, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      let details = '';
      try {
        details = extractS3Error(await response.text());
      } catch {
        details = '';
      }
      throw new Error(details ? `S3 upload failed: ${details}` : `S3 upload failed (HTTP ${response.status})`);
    }
  }

  async function uploadPhotoFromPath(photoPath, { entityType = 'listing' } = {}) {
    const normalizedPath = String(photoPath || '').trim();
    if (!normalizedPath) return null;
    if (!fs.existsSync(normalizedPath)) {
      throw new Error(`Photo file not found: ${normalizedPath}`);
    }

    const stat = fs.statSync(normalizedPath);
    if (!stat.isFile()) {
      throw new Error(`Photo path is not a file: ${normalizedPath}`);
    }
    if (stat.size <= 0) {
      throw new Error(`Photo file is empty: ${normalizedPath}`);
    }

    const preparedFile = await preparePhotoForUpload({
      photoPath: normalizedPath,
      fileName: path.basename(normalizedPath),
      mimeType: resolveMimeType(normalizedPath),
      maxDimension: imageMaxDimension,
      quality: imageQuality,
      optimizationEnabled: imageOptimizationEnabled,
    });

    if (preparedFile.uploadSize > maxSizeBytes) {
      throw new Error(`Photo file is too large after optimization (${preparedFile.uploadSize} bytes)`);
    }

    const init = await callApi({
      domain: 'media',
      event: 'initPhotoUpload',
      params: {
        accountId,
        entityType,
        mimeType: preparedFile.mimeType,
        byteSize: preparedFile.uploadSize,
        originalName: preparedFile.fileName,
      },
    });

    if (!init?.upload?.url || !init?.upload?.fields || !init?.objectKey) {
      throw new Error('Invalid upload payload');
    }

    await uploadFileToS3({
      uploadUrl: init.upload.url,
      fields: init.upload.fields,
      fileName: preparedFile.fileName,
      mimeType: preparedFile.mimeType,
      fileBuffer: preparedFile.fileBuffer,
    });

    let photoUrl = normalizePhotoReference(init.photoUrl, publicBaseUrl);
    if (!photoUrl) {
      try {
        const resolved = await callApi({
          domain: 'media',
          event: 'buildPhotoUrl',
          params: { objectKey: init.objectKey },
        });
        photoUrl = normalizePhotoReference(resolved?.photoUrl || resolved?.objectKey || '', publicBaseUrl);
      } catch {
        photoUrl = '';
      }
    }

    return {
      objectKey: init.objectKey,
      photoUrl: photoUrl
        || normalizePhotoReference(buildPhotoUrlFromUpload(init.upload.url, init.objectKey), publicBaseUrl)
        || normalizePhotoReference(init.objectKey, publicBaseUrl),
    };
  }

  return {
    uploadPhotoFromPath,
  };
}
