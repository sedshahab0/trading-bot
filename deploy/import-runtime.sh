#!/usr/bin/env bash
set -euo pipefail

ARCHIVE="${1:-}"
BOT_ROOT="${BOT_ROOT:-/opt/trading-bot}"
DATA_ROOT="${BOT_DATA_ROOT:-/var/lib/trading-bot}"

if [[ -z "${ARCHIVE}" || ! -f "${ARCHIVE}" ]]; then
  echo "Usage: $0 /path/to/runtime-export-YYYYMMDDTHHMMSSZ.tar.gz" >&2
  exit 1
fi

if [[ -f "${ARCHIVE}.sha256" ]]; then
  sha256sum -c "${ARCHIVE}.sha256"
fi

mkdir -p "${BOT_ROOT}" "${DATA_ROOT}"
tar --numeric-owner -xzf "${ARCHIVE}" -C /
chmod 600 "${BOT_ROOT}/.env" 2>/dev/null || true
chmod 600 "${BOT_ROOT}/.dashboard_secret" 2>/dev/null || true
chown -R root:root "${DATA_ROOT}"

echo "Runtime restored. Run deploy/bootstrap-from-github.sh next."
