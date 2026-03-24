# ── Stage 1: install dependencies (needs build tools for native modules) ──────
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: production image ─────────────────────────────────────────────────
FROM node:22-alpine

# libc6-compat is required for some prebuilt native binaries on musl libc
RUN apk add --no-cache libc6-compat

WORKDIR /app

# Copy compiled node_modules from builder (no build tools in final image)
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY . .

# Ensure the data directory exists before the app tries to write data.db
RUN mkdir -p /app/data

CMD ["node", "scheduler.js"]
