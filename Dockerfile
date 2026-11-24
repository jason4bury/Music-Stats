# Music Stats v1.01. Build with: docker build -t jason4bury/music-stats:1.01 .
# Node.js is pinned to an exact version so every build is the same; bump it here on purpose.
ARG NODE_IMAGE=node:22.23.4-bookworm-slim

# --- Build stage: install production dependencies from package-lock.json ---
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY package.json package-lock.json ./

RUN npm ci --omit=dev

# --- Runtime stage ---
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="Music Stats" \
      org.opencontainers.image.description="Your music collection in numbers: decades, genres, artists, albums and formats, read from the tags" \
      org.opencontainers.image.version="1.01" \
      org.opencontainers.image.source="https://github.com/jason4bury/Music-Stats" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.authors="Jason Rhodes"
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

ENV NODE_ENV=production
EXPOSE 3050

# The cache of tags, so rescans only read new and changed files.
ENV DATA_DIR=/data
VOLUME ["/data"]

# Backs Docker's own health status with GET /healthz, using Node itself (the slim image has no curl).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3050)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
