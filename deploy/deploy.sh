#!/usr/bin/env bash
# Cloud-agent / local deploy script for TradeChi dashboard
set -euo pipefail

HOST="${DEPLOY_HOST:-65.109.179.227}"
USER="${DEPLOY_USER:-root}"
PATH_ON_SERVER="${DEPLOY_PATH:-/opt/trading-bot}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Deploying dashboard to ${USER}@${HOST}:${PATH_ON_SERVER}"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
if [[ -n "${SSH_AUTH_SOCK:-}" ]]; then
  SSH_OPTS+=(-o BatchMode=yes)
fi

rsync -avz --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  "${ROOT}/dashboard/" "${USER}@${HOST}:${PATH_ON_SERVER}/dashboard/"

rsync -avz -e "ssh ${SSH_OPTS[*]}" \
  "${ROOT}/deploy/nginx/agennews.store.conf" \
  "${USER}@${HOST}:/etc/nginx/sites-available/agennews.store"

ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" \
  "nginx -t && systemctl reload nginx && pm2 restart dashboard && pm2 save"

echo "✓ Deploy complete — https://agennews.store/"
