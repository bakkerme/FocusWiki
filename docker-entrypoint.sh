#!/bin/sh
set -eu

umask 0007

if [ ! -d "/app/sample-repos/cindervault-rpg/.git" ] || [ ! -d "/app/sample-repos/helios-lab/.git" ]; then
  echo "[entrypoint] Initializing sample Git repositories in /app/sample-repos..."
  node dist/server/scripts/seed-repos.js
fi

exec node dist/server/server/index.js
