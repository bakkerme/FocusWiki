# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund

COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY shared ./shared
COPY server ./server
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund

COPY --from=builder /app/dist ./dist
COPY scripts/socket-health.mjs /usr/local/lib/focuswiki/socket-health.mjs
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh && mkdir -p /run/secrets && chmod 0700 /run/secrets

# Under rootless Docker, container uid 0 maps to the unprivileged daemon account.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["web"]
