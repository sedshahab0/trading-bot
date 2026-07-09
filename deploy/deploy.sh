#!/usr/bin/env bash
# Cloud-agent / local deploy script for TradeChi dashboard + engine
set -euo pipefail

HOST="${DEPLOY_HOST:-91.107.251.1}"
USER="${DEPLOY_USER:-root}"
PATH_ON_SERVER="${DEPLOY_PATH:-/opt/trading-bot}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ Deploying to ${USER}@${HOST}:${PATH_ON_SERVER}"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
if [[ -n "${SSH_AUTH_SOCK:-}" ]]; then
  SSH_OPTS+=(-o BatchMode=yes)
fi

rsync -avz --delete \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  "${ROOT}/dashboard/" "${USER}@${HOST}:${PATH_ON_SERVER}/dashboard/"

rsync -avz \
  -e "ssh ${SSH_OPTS[*]}" \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  "${ROOT}/engine/" "${USER}@${HOST}:${PATH_ON_SERVER}/engine/"

rsync -avz \
  -e "ssh ${SSH_OPTS[*]}" \
  "${ROOT}/run_engine.py" "${USER}@${HOST}:${PATH_ON_SERVER}/run_engine.py"

rsync -avz -e "ssh ${SSH_OPTS[*]}" \
  "${ROOT}/deploy/nginx/agennews.store.conf" \
  "${USER}@${HOST}:/etc/nginx/sites-available/agennews.store"

ssh "${SSH_OPTS[@]}" "${USER}@${HOST}" bash -s <<EOF
set -euo pipefail
nginx -t && systemctl reload nginx
cd ${PATH_ON_SERVER}
pm2 startOrReload ecosystem.config.js --update-env
PAUSED=\$(grep -E '^NOTIFICATIONS_PAUSED=' ${PATH_ON_SERVER}/.env 2>/dev/null | cut -d= -f2 || echo 0)
if [[ "\$PAUSED" == "1" ]]; then
  pm2 stop signal-engine 2>/dev/null || true
  echo "→ signal-engine left stopped (NOTIFICATIONS_PAUSED=1)"
else
  pm2 restart signal-engine 2>/dev/null || pm2 start signal-engine 2>/dev/null || true
fi
pm2 save
EOF

echo "✓ Deploy complete — https://agennews.store/"
