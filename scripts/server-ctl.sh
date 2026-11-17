#!/usr/bin/env bash
set -euo pipefail

umask 0007
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
PID_FILE="${RUNTIME_DIR}/focuswiki-server.pid"
LOG_FILE="${RUNTIME_DIR}/focuswiki-server.log"

mkdir -p "${RUNTIME_DIR}"

is_running() {
  if [[ -f "${PID_FILE}" ]]; then
    local pid
    pid="$(cat "${PID_FILE}")"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

cmd="${1:-status}"

case "${cmd}" in
  start)
    if is_running; then
      echo "focuswiki already running (PID $(cat "${PID_FILE}"))"
      exit 0
    fi
    cd "${ROOT_DIR}"
    (
      set -m
      PORT="${PORT:-8088}" FOCUSWIKI_BIND_HOST="${BIND_HOST:-${FOCUSWIKI_BIND_HOST:-127.0.0.1}}" NODE_ENV=production \
        nohup node dist/server/server/index.js >"${LOG_FILE}" 2>&1 &
      echo $! >"${PID_FILE}"
    )
    sleep 1
    if is_running; then
      echo "Started focuswiki (PID $(cat "${PID_FILE}")), log: ${LOG_FILE}"
    else
      echo "Failed to start focuswiki; recent log:" >&2
      tail -n 30 "${LOG_FILE}" >&2 || true
      exit 1
    fi
    ;;
  stop)
    if is_running; then
      pid="$(cat "${PID_FILE}")"
      kill "${pid}"
      for _ in {1..20}; do
        if ! kill -0 "${pid}" 2>/dev/null; then
          break
        fi
        sleep 0.1
      done
      rm -f "${PID_FILE}"
      echo "Stopped focuswiki (PID ${pid})"
    else
      rm -f "${PID_FILE}"
      echo "focuswiki is not running"
    fi
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    if is_running; then
      echo "running (PID $(cat "${PID_FILE}"))"
    else
      echo "stopped"
      exit 1
    fi
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}" >&2
    exit 2
    ;;
esac
