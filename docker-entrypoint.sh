#!/bin/sh
set -eu

case "${1:-web}" in
  web)
    umask 0007
    exec node dist/server/server/index.js
    ;;
  git-worker)
    umask 0077
    if [ ! -f dist/server/server/gitRunner.js ]; then
      echo '[focuswiki] Git worker module is missing from this image.' >&2
      exit 1
    fi
    : "${FOCUSWIKI_GIT_SOCKET:?}" "${FOCUSWIKI_ENROLLMENT_FILE:?}" \
      "${FOCUSWIKI_REPOS_DIR:?}" "${FOCUSWIKI_GIT_STATE_DIR:?}" \
      "${FOCUSWIKI_GITHUB_APP_KEY_FILE:?}" "${FOCUSWIKI_GITHUB_APP_ID:?}" \
      "${FOCUSWIKI_GITHUB_INSTALLATION_ID:?}"
    exec node dist/server/server/gitRunner.js
    ;;
  *)
    echo '[focuswiki] Expected web or git-worker.' >&2
    exit 2
    ;;
esac
