#!/usr/bin/env bash
set -euo pipefail

BOT_ROOT="${BOT_ROOT:-/opt/trading-bot}"

"${BOT_ROOT}/deploy/ensure-runtime.sh"
exec "${BOT_ROOT}/venv/bin/gunicorn" "$@"
