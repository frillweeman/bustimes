# ── Builder ────────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

# unzip + awk (busybox) needed for GTFS preprocessing
RUN apk add --no-cache unzip

WORKDIR /app

# Install all deps (devDeps needed for tsc)
COPY functions/package*.json ./
RUN npm ci

# Compile TypeScript
COPY functions/tsconfig.json ./
COPY functions/src ./src
RUN npx tsc

# Copy assets needed by the preprocessor
COPY functions/transit-config.json ./
COPY functions/google_transit.zip ./

# Run preprocessor → produces gtfs-preprocessed.json
RUN node lib/preprocess-gtfs.js

# ── Runner ─────────────────────────────────────────────────────────────────
FROM node:24-alpine AS runner

RUN apk add --no-cache ca-certificates

WORKDIR /app

# Production deps only
COPY functions/package*.json ./
RUN npm ci --omit=dev

# Compiled app
COPY --from=builder /app/lib ./lib

# Runtime assets (no zip in final image)
COPY --from=builder /app/gtfs-preprocessed.json ./
COPY functions/transit-config.json ./
COPY public ./public

ENV PORT=3000
EXPOSE 3000

CMD ["node", "lib/index.js"]
