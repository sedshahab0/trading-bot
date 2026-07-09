#!/usr/bin/env bash
set -euo pipefail

BOT_ROOT="${BOT_ROOT:-/opt/trading-bot}"
DATA_ROOT="${BOT_DATA_ROOT:-/var/lib/trading-bot}"
EXPORT_DIR="${1:-/root/trading-bot-migration}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="${EXPORT_DIR}/runtime-export-${STAMP}.tar.gz"

mkdir -p "${EXPORT_DIR}"
chmod 700 "${EXPORT_DIR}"

items=()
[[ -f "${BOT_ROOT}/.env" ]] && items+=("${BOT_ROOT}/.env")
[[ -f "${BOT_ROOT}/.dashboard_secret" ]] && items+=("${BOT_ROOT}/.dashboard_secret")
[[ -d "${DATA_ROOT}" ]] && items+=("${DATA_ROOT}")

if [[ ${#items[@]} -eq 0 ]]; then
  echo "No runtime files found." >&2
  exit 1
fi

tar --numeric-owner -czf "${ARCHIVE}" "${items[@]}"
chmod 600 "${ARCHIVE}"
sha256sum "${ARCHIVE}" > "${ARCHIVE}.sha256"
chmod 600 "${ARCHIVE}.sha256"

echo "${ARCHIVE}"
