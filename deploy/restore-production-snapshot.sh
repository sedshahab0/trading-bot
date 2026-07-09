#!/bin/bash
set -e
BOT=/opt/trading-bot
DATA=/var/lib/trading-bot
SNAP=$BOT/deploy/production-snapshot
mkdir -p "$DATA" "$BOT/.cache" "$BOT/strategy" "$BOT/Facebook"
cp -a "$SNAP/.env" "$BOT/.env"
cp -a "$SNAP/.dashboard_secret" "$BOT/" 2>/dev/null || true
cp -a "$SNAP/engine_state.json" "$BOT/" 2>/dev/null || true
cp -a "$SNAP/var-lib-trading-bot/." "$DATA/"
cp -a "$SNAP/cache/." "$BOT/.cache/" 2>/dev/null || true
cp -a "$SNAP/strategy/." "$BOT/strategy/" 2>/dev/null || true
chmod 600 "$BOT/.env" "$BOT/.dashboard_secret" 2>/dev/null || true
echo RESTORE_OK
