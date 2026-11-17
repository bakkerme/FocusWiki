#!/bin/sh
set -eu

umask 0007

mkdir -p /app/config /app/repos /app/sample-repos

if [ ! -f "/app/config/projects.json" ] && [ -f "/app/config/projects.default.json" ]; then
  echo "[entrypoint] Initializing /app/config/projects.json from projects.default.json..."
  mkdir -p /app/config
  cp /app/config/projects.default.json /app/config/projects.json
  chmod 0660 /app/config/projects.json
fi

if [ ! -d "/app/sample-repos/cindervault-rpg/.git" ] || [ ! -d "/app/sample-repos/helios-lab/.git" ]; then
  echo "[entrypoint] Initializing sample Git repositories in /app/sample-repos..."
  node dist/server/scripts/seed-repos.js
fi

exec node dist/server/server/index.js
