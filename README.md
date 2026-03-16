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
- `TG_POST_API_ENABLED`: `true/false` send parsed posts to backend API
- `TG_POST_API_URL`: backend endpoint (same as frontend `VITE_IRCOM_API_URL`)
- `TG_POST_API_ACCOUNT_ID`: account id used in `createListing` payload
- `TG_POST_API_KIND`: listing kind (`1` for ad, `2` for service)
- `TG_POST_API_DEFAULT_CATEGORY`: fallback category when parser returns null
- `TG_POST_API_DEFAULT_PRICE`: fallback price when parser cannot extract one
- `TG_POST_API_TIMEOUT_MS`: HTTP timeout for backend posting
- `TG_RETENTION_DAYS`: TTL in days for old aggregator records; on startup removes expired local posts and imported backend listings
- `TG_S3_PUBLIC_BASE_URL`: optional public base URL for photo URL normalization
- `TG_S3_MAX_UPLOAD_BYTES`: max upload size (bytes) for one image (default `10485760`)

## Stored fields (`posts`)

- `title`: normalized listing title
  Max length: 60 characters
- `description`: listing body text
- `price_value`: parsed price value (RUB)
- `sender_id`: Telegram sender id when available
- `content_hash`: normalized post content hash for de-duplication
- `contact_phone`: comma-separated phones
- `contact_username`: comma-separated Telegram usernames
- `contact_text`: normalized contacts summary (e.g. `phone:+7999...; tg:@name`)
- `category`: rule-based category (e.g. `Авто`, `Недвижимость`, `Электроника`)
- `photo_path`: first local photo path when available
- `photo_paths`: JSON array with all local photo paths when available

When `TG_POST_API_ENABLED=true`, the aggregator also sends backend import metadata:
`source`, `msgId`, `date`, `permalink`, `contentHash`, `photoObjectKeys`.
