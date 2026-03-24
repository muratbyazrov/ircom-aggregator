FROM node:22-alpine

# sharp uses prebuilt musl binaries on Alpine — no libvips build needed.
# Only libc6-compat is required for some native addons on musl.
RUN apk add --no-cache libc6-compat

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Runtime data lives in a named volume so it survives container restarts.
# TG_DB_PATH and TG_PHOTOS_DIR are set in docker-compose.yml to point here.
VOLUME ["/app/data"]

CMD ["node", "scheduler.js"]
