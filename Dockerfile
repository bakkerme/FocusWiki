# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY shared ./shared
COPY server ./server
COPY src ./src
COPY scripts/seed-repos.ts ./scripts/seed-repos.ts
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# The existing samples belong to the host's builder account. Rootless UID
# mapping presents that owner as nobody; trust only these two mounted checkouts.
RUN git config --system --add safe.directory /app/sample-repos/cindervault-rpg \
  && git config --system --add safe.directory /app/sample-repos/helios-lab

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8088
ENV BIND_HOSTS=0.0.0.0

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --from=builder /app/dist ./dist
COPY seeds ./seeds
COPY config ./config
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /app/sample-repos \
  && chmod 0770 /app/sample-repos

EXPOSE 8088

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8088/healthz || exit 1

# Note: Under rootless Docker owned by ubuntu (uid 1000), container uid 0 maps directly to
# unprivileged host uid 1000 (matching the POSIX ACLs on /workspace/wiki-prototype/sample-repos),
# whereas a non-zero container uid maps into /etc/subuid (100000+) and cannot read 0770 host ACL dirs.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
