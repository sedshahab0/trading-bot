#!/usr/bin/env bash
# Install cron for automatic git pull + dashboard restart.
set -euo pipefail

BOT_ROOT="${BOT_ROOT:-/opt/trading-bot}"
DEPLOY_DIR="${BOT_ROOT}/deploy"
CRON_TAG="# tradechi-auto-deploy"
ENV_FILE="${BOT_ROOT}/.env"
INTERVAL="${AUTO_DEPLOY_INTERVAL_MIN:-5}"

chmod +x "${DEPLOY_DIR}/auto-deploy.sh" 2>/dev/null || true

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

INTERVAL="${AUTO_DEPLOY_INTERVAL_MIN:-5}"
CRON_LINE="*/${INTERVAL} * * * * flock -n /tmp/tradechi-auto-deploy.lock bash ${DEPLOY_DIR}/auto-deploy.sh >> ${BOT_ROOT}/auto-deploy.log 2>&1 ${CRON_TAG}"

TMP="$(mktemp)"
crontab -l 2>/dev/null | grep -v "${CRON_TAG}" | grep -v "tradechi-auto-deploy" > "${TMP}" || true
echo "${CRON_LINE}" >> "${TMP}"
crontab "${TMP}"
rm -f "${TMP}"

echo "Installed auto-deploy cron (every ${INTERVAL} min):"
crontab -l | grep "${CRON_TAG}" || true
