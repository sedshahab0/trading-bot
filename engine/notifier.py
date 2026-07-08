"""Telegram + Facebook notifications."""

from __future__ import annotations

import logging
import urllib.parse
import urllib.request

import requests

from engine.config import EngineConfig
from engine.signal_logic import SignalResult

logger = logging.getLogger(__name__)


def send_telegram(cfg: EngineConfig, text: str) -> bool:
    if cfg.notifications_paused:
        logger.info("Telegram skipped — NOTIFICATIONS_PAUSED=1")
        return False
    if not cfg.telegram_bot_token or not cfg.telegram_chat_id:
        logger.error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set")
        return False
    url = f"https://api.telegram.org/bot{cfg.telegram_bot_token}/sendMessage"
    data = urllib.parse.urlencode(
        {
            "chat_id": cfg.telegram_chat_id,
            "text": text,
            "parse_mode": "HTML",
        }
    ).encode()
    req = urllib.request.Request(url, data=data)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status == 200
    except Exception as e:
        logger.error("Telegram send failed: %s", e)
        return False


def send_facebook_bridge(cfg: EngineConfig, sig: SignalResult) -> bool:
    if cfg.notifications_paused:
        logger.info("Facebook bridge skipped — NOTIFICATIONS_PAUSED=1")
        return False
    if not cfg.facebook_enable:
        return True
    payload = {
        "symbol": sig.symbol.replace("/", ""),
        "direction": sig.direction,
        "entry": f"{sig.entry:.5f}",
        "sl": f"{sig.sl:.5f}",
        "tp": f"{sig.tp1:.5f}",
        "tp1": f"{sig.tp1:.5f}",
        "tp2": f"{sig.tp2:.5f}",
        "basis": cfg.facebook_basis,
    }
    try:
        r = requests.post(cfg.facebook_url, data=payload, timeout=10)
        return r.status_code == 200
    except Exception as e:
        logger.error("Facebook bridge failed: %s", e)
        return False


def startup_message(cfg: EngineConfig) -> str:
    symbols = ", ".join(cfg.symbols)
    return (
        f"🤖 <b>SignalBot Python Engine v1.0 - Online</b>\n"
        f"─────────────\n"
        f"📊 Symbols : {symbols}\n"
        f"🕑 Stack   : W1 > D1 > H1 > M15 > M5\n"
        f"✅ ADX regime : {'ON' if cfg.adx_enable else 'OFF'}\n"
        f"✅ Session    : {'ON' if cfg.session_enable else 'OFF'}\n"
        f"✅ Min score  : {cfg.min_score} / 12\n"
        f"✅ Data       : {cfg.data_provider}\n"
        f"✅ Monitoring markets on server..."
    )
