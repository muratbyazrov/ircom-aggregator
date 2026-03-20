# ircom-aggregator

Telegram aggregator for marketplace-like posts with structured extraction into SQLite.

## Architecture

- `index.js`: thin entrypoint
- `src/app.js`: orchestration (auth, fetch loop, filtering, persistence)
- `src/config.js`: env parsing and validation
- `src/db/postsRepository.js`: SQLite schema and upsert/cleanup operations
- `src/parsing/adParser.js`: ad/service detection + title/description/price/contact/category extraction
- `src/parsing/taxiParser.js`: taxi/travel extraction (route, direction, departure, seats) + backend departure normalization
  - also skips already-expired taxi offers when departure time can be resolved
  - prefers per-seat fare over full-car price when both are present in one post
- `src/media/photoStorage.js`: optional media download and local file storage
- `src/telegram/auth.js`: Telegram interactive auth flow and auth error handling

## Run

```bash
npm start
```

## Main `.env` flags

- `TG_SOURCES`: comma-separated list (`@channel`, `https://t.me/...`)
- `TG_FETCH_LIMIT`: messages per source
- `TG_ONLY_ADS`: `true/false` filter for marketplace-like posts only (ads and services)
- `TG_PIPELINE_MODE`: current run mode (`ads`, `services` or `taxi`); also selects local SQLite table
- `TG_AD_KEYWORDS`: custom ad keywords
- `TG_SAVE_PHOTOS`: `true/false` media download
- `TG_PHOTOS_DIR`: media output folder
- `TG_CLEAR_BEFORE_RUN`: clear only the active pipeline table before each run (`posts`, `service_posts` or `taxi_posts`)
- `TG_POST_API_ENABLED`: `true/false` send parsed posts to backend API
  - `TG_POST_API_URL`: backend endpoint (same as frontend `VITE_IRCOM_API_URL`)
  - `TG_POST_API_ACCOUNT_ID`: account id used in `createListing` / `createTaxiOffer` payload
  - `TG_POST_API_KIND`: backend kind (`1` for ad, `2` for service); used for `ads/services`, ignored for `taxi`
- `TG_POST_API_DEFAULT_CATEGORY`: fallback category when parser returns null
- `TG_POST_API_DEFAULT_PRICE`: fallback price when parser cannot extract one
- `TG_POST_API_TIMEOUT_MS`: HTTP timeout for backend posting
- `TG_RETENTION_DAYS`: TTL in days for old aggregator records; on startup removes expired local posts and imported backend listings
- `TG_S3_PUBLIC_BASE_URL`: optional public base URL for photo URL normalization
- `TG_S3_MAX_UPLOAD_BYTES`: max upload size (bytes) for one image (default `10485760`)
- `TG_S3_IMAGE_OPTIMIZATION_ENABLED`: optimize images before S3 upload (`true` by default)
- `TG_S3_IMAGE_MAX_DIMENSION`: max width/height during optimization (default `2000`)
- `TG_S3_IMAGE_QUALITY`: lossy WebP quality used for upload optimization (default `84`)

For `TG_PIPELINE_MODE=taxi`, backend sync uses `taxi.createTaxiOffer` / `taxi.updateTaxiOffer` and stores the returned `taxiOfferId` locally for later updates and deletes.

## Stored fields (`posts`, `service_posts`, `taxi_posts`)

- `title`: normalized listing title
  Max length: 60 characters
- `description`: listing body text
- `price_value`: parsed price value (RUB)
- `sender_id`: Telegram sender id when available
- `content_hash`: normalized post content hash for de-duplication
- `contact_phone`: comma-separated phones
- `contact_username`: comma-separated Telegram usernames
- `contact_text`: normalized contacts summary (e.g. `phone:+7999...; tg:@name`)
- `category`: rule-based category (e.g. `Авто`, `Недвижимость`, `Электроника` for ads; `Красота`, `Ремонт`, `IT-услуги` for services)
- `photo_path`: first local photo path when available
- `photo_paths`: JSON array with all local photo paths when available
- `raw_text`: original Telegram message text used for local inspection/debugging
- `taxi_direction`: taxi direction code (`1` city, `2` intercity, `3` cargo) when taxi parser matches
- `taxi_from`, `taxi_to`, `taxi_route`: extracted route parts for taxi messages
- `taxi_departure_at`, `taxi_departure_text`: raw departure value detected in taxi messages
- `taxi_seats_total`, `taxi_seats_free`: parsed seats when available
- `taxi_vehicle`: extracted car/vehicle text when available
- `backend_entity_id`: backend entity id (`taxiOfferId` for taxi sync) used for follow-up updates/deletes

When `TG_POST_API_ENABLED=true`, the aggregator also sends backend import metadata:
`source`, `msgId`, `date`, `permalink`, `contentHash`, `photoObjectKeys`.
