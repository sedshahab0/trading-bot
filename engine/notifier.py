"""Telegram + Facebook notifications."""

from __future__ import annotations

import logging
import os
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

import pandas as pd
import requests

from engine.config import EngineConfig
from engine.signal_logic import SignalResult

logger = logging.getLogger(__name__)
_BOT_ROOT = Path(__file__).resolve().parent.parent


def _log_telegram_delivery(**kwargs) -> None:
    try:
        if str(_BOT_ROOT) not in sys.path:
            sys.path.insert(0, str(_BOT_ROOT))
        from telegram_logger import log_telegram_delivery

        log_telegram_delivery(**kwargs)
    except Exception as exc:
        logger.debug("Telegram delivery log skipped: %s", exc)


def send_telegram(
    cfg: EngineConfig,
    text: str,
    *,
    symbol: str = "—",
    direction: str = "",
    message_type: str = "signal",
    score: int | float | None = None,
    entry: str | float | None = None,
) -> bool:
    if cfg.notifications_paused:
        logger.info("Telegram skipped — NOTIFICATIONS_PAUSED=1")
        return False
    if not cfg.telegram_bot_token or not cfg.telegram_chat_id:
        logger.error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set")
        _log_telegram_delivery(
            symbol=symbol,
            direction=direction or "INFO",
            ok=False,
            error="TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set",
            score=score,
            entry=entry,
            message_type=message_type,
        )
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
            ok = resp.status == 200
            _log_telegram_delivery(
                symbol=symbol,
                direction=direction or "INFO",
                ok=ok,
                error=None if ok else f"HTTP {resp.status}",
                http_status=resp.status,
                score=score,
                entry=entry,
                message_type=message_type,
            )
            return ok
    except Exception as e:
        logger.error("Telegram send failed: %s", e)
        http_status = getattr(e, "code", None)
        _log_telegram_delivery(
            symbol=symbol,
            direction=direction or "INFO",
            ok=False,
            error=str(e),
            http_status=http_status,
            score=score,
            entry=entry,
            message_type=message_type,
        )
        return False


def send_ops_telegram(cfg: EngineConfig, text: str) -> bool:
    """Ops alerts never go to the signal channel unless TELEGRAM_OPS_CHAT_ID is set."""
    token = os.environ.get("TELEGRAM_BOT_TOKEN", cfg.telegram_bot_token)
    chat_id = os.environ.get("TELEGRAM_OPS_CHAT_ID", cfg.telegram_ops_chat_id)
    if not token or not chat_id:
        logger.warning("Ops alert skipped (set TELEGRAM_OPS_CHAT_ID): %s", text)
        return False
    if chat_id == os.environ.get("TELEGRAM_CHAT_ID", cfg.telegram_chat_id):
        logger.warning("Ops alert skipped — TELEGRAM_OPS_CHAT_ID must not be the signal channel")
        return False
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode(
        {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    ).encode()
    req = urllib.request.Request(url, data=data)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status == 200
    except Exception as exc:
        logger.error("Ops telegram send failed: %s", exc)
        return False


def send_facebook_bridge(cfg: EngineConfig, sig: SignalResult, m15: pd.DataFrame | None = None) -> bool:
    if cfg.notifications_paused:
        logger.info("Facebook bridge skipped — NOTIFICATIONS_PAUSED=1")
        return False
    # Always forward to the signal bridge: it is the only place that records
    # the signal for the dashboard's Signals/Home views and the Facebook
    # approval queue. Whether the signal actually gets posted to Facebook
    # groups is controlled independently by signal_server.py (FACEBOOK_AUTO_POST
    # and poster readiness), so facebook_enable must not skip this call.
    digits = 2 if ("XAU" in sig.symbol or "JPY" in sig.symbol) else 5
    payload = {
        "symbol": sig.symbol.replace("/", ""),
        "direction": sig.direction,
        "entry": f"{sig.entry:.{digits}f}",
        "sl": f"{sig.sl:.{digits}f}",
        "tp": f"{sig.tp1:.{digits}f}",
        "tp1": f"{sig.tp1:.{digits}f}",
        "tp2": f"{sig.tp2:.{digits}f}",
        "basis": cfg.facebook_basis,
    }
    # Entry zone (band around the exact entry) for the Facebook post, so
    # followers who read the post minutes/hours later have an actionable
    # area rather than a single already-moved tick. Only sent when the
    # engine provided it (older SignalResults default the bounds to 0).
    if sig.entry_low and sig.entry_high:
        payload["entry_zone"] = f"{sig.entry_low:.{digits}f} - {sig.entry_high:.{digits}f}"
    # Same chart image as the Telegram post, generated here and uploaded
    # alongside the signal fields so signal_server.py can save it under the
    # signal_id it assigns — the Facebook poster attaches it from there
    # whenever the operator approves the job (which may be hours/days
    # later), not synchronously with this bridge call.
    if cfg.chart_image_enable and m15 is not None and len(m15) >= 5:
        with tempfile.TemporaryDirectory() as tmp:
            img_path = Path(tmp) / f"chart_{sig.symbol.replace('/', '')}_{int(time.time())}.png"
            try:
                _draw_signal_chart(m15, sig, str(img_path))
                with open(img_path, "rb") as fh:
                    r = requests.post(
                        cfg.facebook_url, data=payload,
                        files={"chart_image": ("chart.png", fh, "image/png")},
                        timeout=15,
                    )
                return r.status_code in (200, 202)
            except Exception as e:
                logger.warning("Facebook bridge chart image failed, sending text-only: %s", e)
    try:
        r = requests.post(cfg.facebook_url, data=payload, timeout=10)
        return r.status_code in (200, 202)
    except Exception as e:
        logger.error("Facebook bridge failed: %s", e)
        return False


def _draw_signal_chart(df_src: pd.DataFrame, sig: SignalResult, out_path: str,
                       bars: int = 90, channel_n: int = 25) -> None:
    """Render an H1 candlestick chart of the breakout, with the Donchian
    channel (prior N-bar high/low) drawn so the break is visually obvious,
    plus Entry / SL / TP (1:2). Prices use metal-appropriate digits."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    digits = 2 if ("XAU" in sig.symbol or "JPY" in sig.symbol) else 3 if "XAG" in sig.symbol else 5
    df = df_src.iloc[-bars:].reset_index(drop=True)
    fig, ax = plt.subplots(figsize=(10, 6), dpi=100)

    # Donchian channel over the visible window (prior N bars, shifted by 1)
    hi = df["high"].rolling(channel_n).max().shift(1)
    lo = df["low"].rolling(channel_n).min().shift(1)
    ax.plot(hi.index, hi.values, color="#8ab4f8", linestyle=":", linewidth=1, label=f"{channel_n}-bar high")
    ax.plot(lo.index, lo.values, color="#f6aea9", linestyle=":", linewidth=1, label=f"{channel_n}-bar low")

    for i, row in df.iterrows():
        color = "#26a269" if row["close"] >= row["open"] else "#c01c28"
        ax.vlines(i, row["low"], row["high"], color=color, linewidth=1)
        ax.add_patch(
            plt.Rectangle(
                (i - 0.3, min(row["open"], row["close"])),
                0.6,
                max(abs(row["close"] - row["open"]), 1e-9),
                color=color,
            )
        )
    levels = [
        ("Entry", sig.entry, "white"),
        ("SL", sig.sl, "#c01c28"),
        ("TP (1:2)", sig.tp2, "#33d17a"),
    ]
    for label, level, color in levels:
        ax.axhline(level, color=color, linestyle="--", linewidth=1)
        ax.text(len(df) - 1, level, f" {label} {level:.{digits}f}", color=color, va="center", fontsize=8)
    ax.set_title(f"{sig.symbol}  {sig.direction} · Donchian Breakout · H1", color="white")
    ax.set_facecolor("#1e1e1e")
    fig.patch.set_facecolor("#1e1e1e")
    ax.tick_params(colors="white")
    ax.set_xticks([])
    ax.legend(loc="upper left", fontsize=7, facecolor="#2b2b2b", labelcolor="white")
    fig.tight_layout()
    fig.savefig(out_path, facecolor=fig.get_facecolor())
    plt.close(fig)


def send_telegram_photo(cfg: EngineConfig, photo_path: str, caption: str = "") -> bool:
    if not cfg.telegram_bot_token or not cfg.telegram_chat_id:
        return False
    url = f"https://api.telegram.org/bot{cfg.telegram_bot_token}/sendPhoto"
    try:
        with open(photo_path, "rb") as fh:
            r = requests.post(
                url,
                data={"chat_id": cfg.telegram_chat_id, "caption": caption},
                files={"photo": fh},
                timeout=20,
            )
        return r.status_code == 200
    except Exception as e:
        logger.error("Telegram photo send failed: %s", e)
        return False


def send_chart_image(cfg: EngineConfig, sig: SignalResult, m15: pd.DataFrame) -> bool:
    """mq5 v6.16 NEW + v6.17 hardening, adapted: renders and sends a chart
    image after a signal, with one retry and an honest failure notice —
    matching v6.17's fix for "screenshot failed silently"."""
    if not cfg.chart_image_enable:
        return True
    if len(m15) < 5:
        return True
    with tempfile.TemporaryDirectory() as tmp:
        out_path = str(Path(tmp) / f"signal_{sig.symbol.replace('/', '')}_{int(time.time())}.png")
        ok = False
        for attempt in range(2):
            try:
                _draw_signal_chart(m15, sig, out_path)
                ok = send_telegram_photo(cfg, out_path)
                if ok:
                    break
            except Exception as exc:
                logger.warning("Chart image attempt %s failed for %s: %s", attempt + 1, sig.symbol, exc)
        if not ok:
            send_telegram(
                cfg,
                f"⚠️ Chart image failed to attach for this {sig.symbol} signal — check logs.",
                symbol=sig.symbol,
                direction=sig.direction,
                message_type="alert",
            )
        return ok


def send_signal_with_chart(cfg: EngineConfig, sig: SignalResult, h1: pd.DataFrame | None) -> bool:
    """Send the signal as ONE Telegram message: the chart photo with the full
    signal text as its HTML caption (replaces the old text-then-photo pair).
    Falls back to the plain text message if the chart cannot be rendered or
    the upload fails twice — a signal must never be lost to a chart problem."""
    if cfg.notifications_paused:
        logger.info("Telegram skipped — NOTIFICATIONS_PAUSED=1")
        return False
    caption = sig.message_html
    # Telegram caps photo captions at 1024 chars (ours is ~750 incl. tags).
    # If a future edit pushes it over, revert to text + separate photo.
    if (not cfg.chart_image_enable or h1 is None or len(h1) < 5
            or not cfg.telegram_bot_token or not cfg.telegram_chat_id
            or len(caption) > 1000):
        ok = send_telegram(cfg, caption, symbol=sig.symbol, direction=sig.direction,
                           score=sig.score, entry=sig.entry)
        if ok and cfg.chart_image_enable and h1 is not None and len(h1) >= 5:
            send_chart_image(cfg, sig, h1)
        return ok
    url = f"https://api.telegram.org/bot{cfg.telegram_bot_token}/sendPhoto"
    with tempfile.TemporaryDirectory() as tmp:
        img = str(Path(tmp) / f"signal_{sig.symbol.replace('/', '')}_{int(time.time())}.png")
        for attempt in range(2):
            try:
                _draw_signal_chart(h1, sig, img)
                with open(img, "rb") as fh:
                    r = requests.post(
                        url,
                        data={"chat_id": cfg.telegram_chat_id, "caption": caption,
                              "parse_mode": "HTML"},
                        files={"photo": fh},
                        timeout=20,
                    )
                if r.status_code == 200:
                    _log_telegram_delivery(symbol=sig.symbol, direction=sig.direction,
                                           ok=True, error=None, http_status=200,
                                           score=sig.score, entry=sig.entry,
                                           message_type="signal")
                    return True
                logger.warning("sendPhoto attempt %s for %s: HTTP %s %s",
                               attempt + 1, sig.symbol, r.status_code, r.text[:200])
                if r.status_code in (401, 403):
                    _log_telegram_delivery(
                        symbol=sig.symbol, direction=sig.direction, ok=False,
                        error=f"HTTP {r.status_code} {r.text[:200]}",
                        http_status=r.status_code, score=sig.score, entry=sig.entry,
                        message_type="signal",
                    )
                    return send_telegram(
                        cfg, caption, symbol=sig.symbol, direction=sig.direction,
                        score=sig.score, entry=sig.entry,
                    )
            except Exception as exc:
                logger.warning("Signal-with-chart attempt %s failed for %s: %s",
                               attempt + 1, sig.symbol, exc)
    # Photo failed twice — plain text so the signal still reaches the channel.
    logger.warning("Falling back to text-only signal for %s", sig.symbol)
    return send_telegram(cfg, caption, symbol=sig.symbol, direction=sig.direction,
                         score=sig.score, entry=sig.entry)


def startup_message(cfg: EngineConfig) -> str:
    symbols = ", ".join(cfg.symbols)
    return (
        f"🤖 <b>SignalBot — Donchian Breakout Engine Online</b>\n"
        f"─────────────\n"
        f"📊 Symbols   : {symbols}\n"
        f"🕑 Timeframe : H1\n"
        f"📈 Strategy  : {cfg.donchian_n}-bar Donchian breakout, EMA{cfg.donchian_trend_ema} trend filter\n"
        f"🛑 Stop      : {cfg.donchian_sl_mult:.1f} × ATR\n"
        f"🎯 Target    : 1 : {cfg.donchian_tp_r:.0f}  (full position to TP)\n"
        f"🖼 Chart Image: {'ON' if cfg.chart_image_enable else 'OFF'}\n"
        f"✅ Data       : {cfg.data_provider}\n"
        f"⚠️ Trend-following — ~37% win rate, expect losing streaks.\n"
        f"✅ Monitoring gold & silver for breakouts..."
    )
