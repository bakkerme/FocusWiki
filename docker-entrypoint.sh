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
      "${FOCUSWIKI_REPOS_DIR:?}" "${FOCUSWIKI_GIT_STATE_DIR:?}"
    has_github=0
    has_forgejo=0
    if [ -n "${FOCUSWIKI_GITHUB_APP_ID:-}" ] || [ -n "${FOCUSWIKI_GITHUB_INSTALLATION_ID:-}" ] || [ -n "${FOCUSWIKI_OPENBAO_SECRET_PATH:-}" ]; then
      : "${FOCUSWIKI_GITHUB_APP_KEY_FILE:?}" "${FOCUSWIKI_GITHUB_APP_ID:?}" "${FOCUSWIKI_GITHUB_INSTALLATION_ID:?}"
      has_github=1
    fi
    if [ -n "${FOCUSWIKI_FORGEJO_ORIGIN:-}" ] || [ -n "${FOCUSWIKI_OPENBAO_FORGEJO_SECRET_PATH:-}" ]; then
      : "${FOCUSWIKI_FORGEJO_ORIGIN:?}" "${FOCUSWIKI_FORGEJO_TOKEN_FILE:?}"
      has_forgejo=1
    fi
    if [ "$has_github" -eq 0 ] && [ "$has_forgejo" -eq 0 ]; then
      echo '[focuswiki] Configure GitHub App and/or Forgejo credentials for git-worker.' >&2
      exit 1
    fi
    if [ -n "${FOCUSWIKI_OPENBAO_ADDR:-}" ]; then
      node dist/server/server/openbaoBootstrap.js
      unset FOCUSWIKI_OPENBAO_ADDR FOCUSWIKI_OPENBAO_ROLE_ID FOCUSWIKI_OPENBAO_ROLE_ID_FILE \
        FOCUSWIKI_OPENBAO_SECRET_ID FOCUSWIKI_OPENBAO_SECRET_ID_FILE FOCUSWIKI_OPENBAO_AUTH_MOUNT \
        FOCUSWIKI_OPENBAO_SECRET_PATH FOCUSWIKI_OPENBAO_SECRET_FIELD \
        FOCUSWIKI_OPENBAO_FORGEJO_SECRET_PATH FOCUSWIKI_OPENBAO_FORGEJO_SECRET_FIELD \
        FOCUSWIKI_OPENBAO_NAMESPACE FOCUSWIKI_OPENBAO_CA_FILE FOCUSWIKI_OPENBAO_PROXY \
        FOCUSWIKI_OPENBAO_RETRIES FOCUSWIKI_OPENBAO_RETRY_DELAY_MS
    fi
    exec node dist/server/server/gitRunner.js
    ;;
  init-volumes)
    umask 0077
    for dir in /volumes/repos /volumes/git-state /volumes/git-socket /volumes/serve-socket /volumes/tailscale-state /volumes/tailscale-config; do
      if [ ! -d "$dir" ]; then
        echo "[focuswiki-init] Missing volume mountpoint: $dir" >&2
        exit 1
      fi
    done
    chown 0:0 /volumes/repos /volumes/git-state /volumes/git-socket /volumes/tailscale-state /volumes/tailscale-config
    chmod 0750 /volumes/repos /volumes/git-socket /volumes/tailscale-config
    chmod 0700 /volumes/git-state /volumes/tailscale-state
    chown 10002:0 /volumes/serve-socket
    chmod 0750 /volumes/serve-socket
    tmp_serve="/volumes/tailscale-config/.serve.json.$$"
    cat <<'EOF' > "$tmp_serve"
{
  "TCP": {
    "443": {
      "HTTPS": true
    }
  },
  "Web": {
    "${TS_CERT_DOMAIN}:443": {
      "Handlers": {
        "/": {
          "Proxy": "unix:/run/focuswiki-serve/http.sock"
        }
      }
    }
  }
}
EOF
    chown 0:0 "$tmp_serve"
    chmod 0640 "$tmp_serve"
    mv "$tmp_serve" /volumes/tailscale-config/serve.json
    echo '[focuswiki-init] Initialized volume permissions and Tailscale Serve config.'
    ;;
  *)
    echo '[focuswiki] Expected web, git-worker, or init-volumes.' >&2
    exit 2
    ;;
esac
