import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

import { loadConfig } from './config.js';
import { createPostsRepository } from './db/postsRepository.js';
import { looksLikeAd, extractStructuredData } from './parsing/adParser.js';
import { createPhotoStorage } from './media/photoStorage.js';
import { buildAuthParams, logAuthError } from './telegram/auth.js';

function buildPermalink(entity, msgId) {
  const username = entity?.username;
  return username ? `https://t.me/${username}/${msgId}` : null;
}

export async function runApp() {
  const config = loadConfig();
  const db = createPostsRepository('data.db');
  const photoStorage = createPhotoStorage({
    enabled: config.savePhotos,
    photosDir: config.photosDir,
  });

  const client = new TelegramClient(new StringSession(config.session), config.apiId, config.apiHash, {
    connectionRetries: 5,
  });

  try {
    await client.start(buildAuthParams({
      defaultPhoneNumber: config.defaultPhoneNumber,
      forceSms: config.forceSms,
    }));

    const session = client.session.save();
    console.log('\n✅ SESSION (скопируй в .env как TG_SESSION=...):\n');
    console.log(session);

    if (config.clearBeforeRun) {
      const deletedRows = db.clear();
      console.log(`\nDB cleanup enabled: removed ${deletedRows} rows from posts`);
    }

    console.log(`\nSources configured: ${config.sources.length}`);
    console.log(`Filter mode: ${config.onlyAds ? 'only ads' : 'all posts'}`);
    if (config.onlyAds) {
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
      let skippedByFilter = 0;
      let photosSaved = 0;

      for await (const message of client.iterMessages(entity, { limit: config.fetchLimit })) {
        scanned++;
        const text = message?.message?.trim?.() || '';
        const hasPhoto = Boolean(message?.photo);
        const hasImageDoc = String(message?.media?.document?.mimeType || '').startsWith('image/');
        const hasVisualMedia = hasPhoto || hasImageDoc;

        if (!text && !hasVisualMedia) continue;
        if (config.onlyAds && (!text || !looksLikeAd(text, config.adKeywords))) {
          skippedByFilter++;
          continue;
        }

        const structured = extractStructuredData(text);
        let photoPath = null;
        try {
          photoPath = await photoStorage.savePhotoIfAny(client, message, source, message.id);
          if (photoPath) photosSaved++;
        } catch (err) {
          console.error(`Photo save failed for ${source}/${message.id}: ${err?.message || err}`);
        }

        db.upsert({
          source,
          msg_id: message.id,
          date: message.date?.toISOString?.() || new Date().toISOString(),
          permalink: buildPermalink(entity, message.id),
          title: structured.title,
          description: structured.description,
          price_value: structured.priceValue,
          contact_phone: structured.contactPhone,
          contact_username: structured.contactUsername,
          contact_text: structured.contactText,
          category: structured.category,
          photo_path: photoPath,
        });

        saved++;
      }

      totalSaved += saved;
      console.log(
        `Scanned: ${scanned} | Saved: ${saved} | Skipped by filter: ${skippedByFilter} | Photos: ${photosSaved}`
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
