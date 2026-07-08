#!/usr/bin/env python3
"""Structured Telegram delivery logger for the signal engine.

Usage in run_engine.py after send attempt:

    from telegram_logger import log_telegram_delivery
    log_telegram_delivery(
        symbol="EUR/USD",
        direction="SELL",
        ok=True,
        score=9,
        entry=1.1426,
    )
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

BOT_ROOT = Path(os.environ.get("BOT_ROOT", "/opt/trading-bot"))
LOG_FILE = Path(os.environ.get("TELEGRAM_DELIVERY_LOG", str(BOT_ROOT / "Facebook" / "telegram_delivery.log")))


def log_telegram_delivery(
    *,
    symbol: str,
    direction: str,
    ok: bool,
    error: str | None = None,
    score: int | float | None = None,
    entry: str | float | None = None,
    http_status: int | None = None,
    message_type: str = "signal",
) -> None:
    """Append one JSON line to the Telegram delivery log."""
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "symbol": symbol,
        "direction": direction.upper(),
        "ok": bool(ok),
        "status": "ok" if ok else "failed",
        "error": error,
        "score": score,
        "entry": entry,
        "http_status": http_status,
        "message_type": message_type,
    }
    with LOG_FILE.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")
