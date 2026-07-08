#!/usr/bin/env bash
# One-time bootstrap: wire /opt/trading-bot to GitHub + auto-deploy env.
# Run on the VPS as root (Hetzner console or SSH):
#   export GH_PAT='ghp_...'
#   sudo -E bash /opt/trading-bot/deploy/bootstrap-from-github.sh

set -euo pipefail

BOT_ROOT="${BOT_ROOT:-/opt/trading-bot}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
GITHUB_USER="${GITHUB_USER:-sedshahab0}"
REPO="${GITHUB_USER}/trading-bot"
DEPLOY_KEY="${DEPLOY_KEY:-/tmp/tradechi_deploy.pub}"
export GH_PAT="${GH_PAT:-${GITHUB_TOKEN:-}}"

if [[ $EUID -ne 0 ]]; then
  echo "Run as root"
  exit 1
fi

if [[ -z "${GH_PAT}" ]]; then
  echo "Set GH_PAT or GITHUB_TOKEN"
  exit 1
fi

gitx() {
  git -c "credential.helper=!f() { echo username=${GITHUB_USER}; echo password=${GH_PAT}; }; f" "$@"
}

mkdir -p "${BOT_ROOT}/deploy"
ENV_FILE="${BOT_ROOT}/.env"
touch "${ENV_FILE}"

upsert_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "${ENV_FILE}" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "${ENV_FILE}"
  else
    echo "${key}=${val}" >> "${ENV_FILE}"
  fi
}

upsert_env "GH_PAT" "${GH_PAT}"
upsert_env "DEPLOY_BRANCH" "${DEPLOY_BRANCH}"

if [[ -n "${DEPLOY_HOOK_TOKEN:-}" ]]; then
  upsert_env "DEPLOY_HOOK_TOKEN" "${DEPLOY_HOOK_TOKEN}"
fi

if [[ ! -d "${BOT_ROOT}/.git" ]]; then
  echo "Initializing git repo at ${BOT_ROOT}"
  BACKUP="${BOT_ROOT}.pre-github-$(date +%Y%m%d%H%M%S)"
  mkdir -p "${BACKUP}"
  shopt -s dotglob
  for item in "${BOT_ROOT}"/*; do
    base="$(basename "$item")"
    [[ "$base" == ".git" ]] && continue
    mv "$item" "${BACKUP}/"
  done
  gitx clone --branch "${DEPLOY_BRANCH}" --depth 1 \
    "https://github.com/${REPO}.git" "${BOT_ROOT}.clone"
  shopt -s dotglob
  for item in "${BOT_ROOT}.clone"/*; do
    base="$(basename "$item")"
    [[ "$base" == ".git" ]] && continue
    cp -a "$item" "${BOT_ROOT}/"
  done
  cp -a "${BOT_ROOT}.clone/.git" "${BOT_ROOT}/.git"
  rm -rf "${BOT_ROOT}.clone"
  if [[ -d "${BACKUP}/Facebook" ]]; then
    cp -an "${BACKUP}/Facebook/." "${BOT_ROOT}/Facebook/" 2>/dev/null || true
  fi
  cp -an "${BACKUP}/.env" "${ENV_FILE}" 2>/dev/null || true
  cp -an "${BACKUP}/engine_state.json" "${BOT_ROOT}/engine_state.json" 2>/dev/null || true
  cp -an "${BACKUP}/run_engine.py" "${BOT_ROOT}/run_engine.py" 2>/dev/null || true
  echo "Backup of pre-git files: ${BACKUP}"
else
  echo "Git repo exists — fetching ${DEPLOY_BRANCH}"
  gitx -C "${BOT_ROOT}" fetch origin "${DEPLOY_BRANCH}"
  gitx -C "${BOT_ROOT}" checkout "${DEPLOY_BRANCH}"
  gitx -C "${BOT_ROOT}" reset --hard "origin/${DEPLOY_BRANCH}"
fi

if [[ -f "${DEPLOY_KEY}" ]]; then
  mkdir -p /root/.ssh
  chmod 700 /root/.ssh
  touch /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
  key="$(cat "${DEPLOY_KEY}")"
  if ! grep -Fq "${key}" /root/.ssh/authorized_keys; then
    echo "${key}" >> /root/.ssh/authorized_keys
    echo "Added deploy SSH public key"
  fi
fi

chmod +x "${BOT_ROOT}/deploy/"*.sh 2>/dev/null || true
bash "${BOT_ROOT}/deploy/install-auto-deploy-cron.sh" || true

if command -v nginx >/dev/null; then
  cp -f "${BOT_ROOT}/deploy/nginx/agennews.store.conf" /etc/nginx/sites-available/agennews.store
  ln -sf /etc/nginx/sites-available/agennews.store /etc/nginx/sites-enabled/agennews.store
  nginx -t && systemctl reload nginx
fi

if command -v pm2 >/dev/null; then
  cd "${BOT_ROOT}"
  pm2 startOrReload ecosystem.config.js --update-env
  pm2 save
fi

echo "Bootstrap complete — https://agennews.store/"
