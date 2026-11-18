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

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund \
  && install -d -o 10001 -g 10003 -m 0750 /run/focuswiki /var/lib/focuswiki/repos

FROM runtime AS git-runner

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -o 10001 -g 10003 -m 0700 /var/lib/focuswiki/git
COPY --from=builder /app/dist/server ./dist/server
USER 10001:10003
ENTRYPOINT ["node", "dist/server/server/gitRunner.js"]

FROM runtime AS web

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
ENV PORT=8088
ENV FOCUSWIKI_BIND_HOST=0.0.0.0

COPY --from=builder /app/dist ./dist
COPY seeds ./sample-repos
COPY config/projects.default.json ./config/projects.default.json
EXPOSE 8088

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8088/api/health || exit 1

CMD ["node", "dist/server/server/index.js"]
