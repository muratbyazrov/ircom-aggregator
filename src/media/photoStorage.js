import fs from 'node:fs';
import path from 'node:path';

export function createPhotoStorage({ enabled, photosDir }) {
  return {
    async savePhotoIfAny(client, message, source, msgId) {
      if (!enabled) return null;
      const hasPhoto = Boolean(message?.photo);
      const isImageDoc = String(message?.media?.document?.mimeType || '').startsWith('image/');
      if (!hasPhoto && !isImageDoc) return null;

      fs.mkdirSync(photosDir, { recursive: true });
      const fileName = `${sanitizeForFilename(source)}_${msgId}.${getPhotoExtension(message)}`;
      const fullPath = path.join(photosDir, fileName);

      // Guard against path traversal — sanitizeForFilename strips most unsafe chars,
      // but resolve + prefix check is an extra safety net.
      const resolvedPath = path.resolve(fullPath);
      const resolvedDir = path.resolve(photosDir);
      if (!resolvedPath.startsWith(resolvedDir + path.sep)) {
        throw new Error(`Unsafe photo path resolved outside photos directory: ${resolvedPath}`);
      }

      const media = await client.downloadMedia(message, {});
      if (!media) return null;

      if (Buffer.isBuffer(media)) {
        fs.writeFileSync(fullPath, media);
        return fullPath;
      }
      if (typeof media === 'string') {
        return media;
      }
      return null;
    },
  };
}

function sanitizeForFilename(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function getPhotoExtension(message) {
  const mimeType = message?.media?.document?.mimeType || '';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/heic') return 'heic';
  return 'jpg';
}

