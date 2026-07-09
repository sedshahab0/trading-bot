#!/usr/bin/env bash
set -euo pipefail

BOT_ROOT="${BOT_ROOT:-/opt/trading-bot}"
VENV_DIR="${VENV_DIR:-${BOT_ROOT}/venv}"
REQ_DASH="${REQ_DASH:-${BOT_ROOT}/dashboard/requirements.txt}"
REQ_ENGINE="${REQ_ENGINE:-${BOT_ROOT}/requirements-engine.txt}"
LOCK_FILE="${LOCK_FILE:-/tmp/trading-bot-runtime.lock}"

is_healthy() {
  [[ -x "${VENV_DIR}/bin/python3" ]] || return 1
  [[ -x "${VENV_DIR}/bin/gunicorn" ]] || return 1
  "${VENV_DIR}/bin/python3" - <<'PY' >/dev/null 2>&1
import flask
import gunicorn
import psutil
PY
}

needs_bootstrap=0
if ! is_healthy; then
  needs_bootstrap=1
fi

if [[ "${needs_bootstrap}" -eq 0 ]]; then
  exit 0
fi

mkdir -p "$(dirname "${LOCK_FILE}")"
exec 9>"${LOCK_FILE}"
flock -w 300 9

if is_healthy; then
  exit 0
fi

echo "[ensure-runtime] rebuilding python environment in ${VENV_DIR}"
rm -rf "${VENV_DIR}"
python3 -m venv "${VENV_DIR}"
"${VENV_DIR}/bin/python" -m pip install --upgrade pip setuptools wheel
"${VENV_DIR}/bin/pip" install -r "${REQ_DASH}" -r "${REQ_ENGINE}"
"${VENV_DIR}/bin/python3" - <<'PY'
import flask
import gunicorn
import psutil
print("runtime ok")
PY
