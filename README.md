# ircom-aggregator

Telegram aggregator for marketplace-like posts with structured extraction into SQLite.

## Architecture

- `index.js`: thin entrypoint
- `src/app.js`: orchestration (auth, fetch loop, filtering, persistence)
- `src/config.js`: env parsing and validation
- `src/db/postsRepository.js`: SQLite schema and upsert/cleanup operations
- `src/parsing/adParser.js`: ad detection + title/description/price/contact extraction
- `src/media/photoStorage.js`: optional media download and local file storage
- `src/telegram/auth.js`: Telegram interactive auth flow and auth error handling

## Run

```bash
npm start
```

## Main `.env` flags

- `TG_SOURCES`: comma-separated list (`@channel`, `https://t.me/...`)
- `TG_FETCH_LIMIT`: messages per source
- `TG_ONLY_ADS`: `true/false` filter for ads only
- `TG_AD_KEYWORDS`: custom ad keywords
- `TG_SAVE_PHOTOS`: `true/false` media download
- `TG_PHOTOS_DIR`: media output folder
- `TG_CLEAR_BEFORE_RUN`: clear `posts` table before each run

