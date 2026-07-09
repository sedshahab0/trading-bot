#!/usr/bin/env bash
# Server-side auto deploy: git pull + pm2 restart dashboard.
set -euo pipefail

BOT_ROOT="${BOT_ROOT:-/opt/trading-bot}"
ENV_FILE="${BOT_ROOT}/.env"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
GITHUB_USER="${GITHUB_USER:-sedshahab0}"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
TOKEN="${GH_PAT:-${GITHUB_TOKEN:-}}"

if [[ ! -d "${BOT_ROOT}/.git" ]]; then
  echo "$(date -Is) not a git repo — skip"
  exit 0
fi

gitx() {
  if [[ -n "${TOKEN}" ]]; then
    git -c "credential.helper=!f() { echo username=${GITHUB_USER}; echo password=${TOKEN}; }; f" "$@"
  else
    git "$@"
  fi
}

cd "${BOT_ROOT}"
gitx fetch origin "${DEPLOY_BRANCH}"
gitx checkout "${DEPLOY_BRANCH}"
gitx reset --hard "origin/${DEPLOY_BRANCH}"

if command -v pm2 >/dev/null; then
  pm2 startOrReload ecosystem.config.js --update-env
  pm2 save
fi

echo "$(date -Is) deployed origin/${DEPLOY_BRANCH}"
