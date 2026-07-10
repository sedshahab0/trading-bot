"""Main loop — polls on new M5 bar, evaluates symbols, sends alerts."""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from engine.config import EngineConfig, _env_bool
from engine.data_provider import DataProvider
from engine.notifier import send_facebook_bridge, send_telegram, startup_message
from engine.signal_logic import SignalEngine
from engine.simulation import SimulationTracker

logger = logging.getLogger(__name__)


def _load_state(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}


def _save_state(path: str, state: dict) -> None:
    Path(path).write_text(json.dumps(state, indent=2, default=str))


def _env_file_path() -> Path:
    return Path(os.environ.get("ENV_FILE", "/opt/trading-bot/.env"))


def _load_dotenv(*, overwrite: bool = False) -> None:
    env_path = _env_file_path()
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip()
        if overwrite:
            os.environ[key] = val
        else:
            os.environ.setdefault(key, val)


def _notifications_paused_live() -> bool:
    """Read NOTIFICATIONS_PAUSED from .env on each call (dashboard may change it)."""
    env_path = _env_file_path()
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line.startswith("NOTIFICATIONS_PAUSED="):
                return line.split("=", 1)[1].strip() in ("1", "true", "True", "yes", "on")
    return _env_bool("NOTIFICATIONS_PAUSED", False)


def _refresh_cfg(cfg: EngineConfig) -> EngineConfig:
    _load_dotenv(overwrite=True)
    cfg.notifications_paused = _notifications_paused_live()
    cfg.telegram_bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", cfg.telegram_bot_token)
    cfg.telegram_chat_id = os.environ.get("TELEGRAM_CHAT_ID", cfg.telegram_chat_id)
    cfg.min_score = int(os.environ.get("MIN_SCORE", str(cfg.min_score)))
    cfg.poll_seconds = int(os.environ.get("POLL_SECONDS", str(cfg.poll_seconds)))
    cfg.debug = _env_bool("ENGINE_DEBUG", cfg.debug)
    return cfg


def run_forever(cfg: EngineConfig | None = None) -> None:
    _load_dotenv(overwrite=True)
    cfg = _refresh_cfg(cfg or EngineConfig())
    logging.basicConfig(
        level=logging.DEBUG if cfg.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    if cfg.notifications_paused:
        logger.warning("NOTIFICATIONS_PAUSED=1 — engine idle until resumed")

    if cfg.data_provider == "twelvedata" and not cfg.twelve_data_api_key:
        raise SystemExit(
            "Set TWELVE_DATA_API_KEY (free at https://twelvedata.com) "
            "or DATA_PROVIDER=yfinance for limited demo mode."
        )
    if not cfg.telegram_bot_token or not cfg.telegram_chat_id:
        raise SystemExit("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID")

    data = DataProvider(cfg.twelve_data_api_key, cfg.data_provider)
    engine = SignalEngine(cfg, data)
    simulation = SimulationTracker(
        os.environ.get("SIMULATION_DB", "/var/lib/trading-bot/signal-simulation.sqlite3"),
        expiry_hours=int(os.environ.get("SIMULATION_EXPIRY_HOURS", "72")),
        cost_r=float(os.environ.get("SIMULATION_COST_R", "0.03")),
    )
    simulation.import_signal_log(
        os.environ.get("SIGNAL_LOG_FILE", "/var/lib/trading-bot/signal_log.txt")
    )
    state = _load_state(cfg.state_file)

    if cfg.send_startup_message and not state.get("startup_sent") and not cfg.notifications_paused:
        if send_telegram(cfg, startup_message(cfg), message_type="startup"):
            state["startup_sent"] = True
            _save_state(cfg.state_file, state)

    logger.info(
        "Engine started — symbols=%s provider=%s poll=%ss",
        cfg.symbols,
        cfg.data_provider,
        cfg.poll_seconds,
    )

    last_bars: dict[str, str] = state.get("last_bars", {})
    last_signal_at: dict[str, float] = state.get("last_signal_at", {})
    last_cross: dict[str, int] = state.get("last_cross", {})

    while True:
        try:
            cfg = _refresh_cfg(cfg)
            if cfg.notifications_paused:
                logger.info("Notifications paused — engine idle (no signals sent)")
                time.sleep(cfg.poll_seconds)
                continue

            for symbol in cfg.symbols:
                bar_key = engine.latest_m5_bar(symbol)
                if not bar_key:
                    continue

                prev = last_bars.get(symbol)
                if prev == bar_key:
                    continue
                last_bars[symbol] = bar_key

                data.prefetch_symbol(symbol)
                frames = engine.fetch_frames(symbol)
                simulation.evaluate_symbol(symbol, frames["M5"])

                cross_alert = engine.check_golden_cross(symbol, frames["D1"])
                if cross_alert:
                    if last_cross.get(symbol) != cross_alert.cross:
                        send_telegram(
                            cfg,
                            cross_alert.message_html,
                            symbol=symbol,
                            direction="ALERT",
                            message_type="alert",
                        )
                        last_cross[symbol] = cross_alert.cross

                sig = engine.evaluate(symbol, frames=frames)
                if not sig:
                    continue

                cool_secs = cfg.cooldown_bars * 300
                last_ts = last_signal_at.get(symbol, 0)
                if time.time() - last_ts < cool_secs:
                    continue

                if send_telegram(
                    cfg,
                    sig.message_html,
                    symbol=sig.symbol,
                    direction=sig.direction,
                    score=sig.score,
                    entry=sig.entry,
                ):
                    last_signal_at[symbol] = time.time()
                    simulation.register({
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "symbol": sig.symbol,
                        "direction": sig.direction,
                        "entry": sig.entry,
                        "sl": sig.sl,
                        "tp1": sig.tp1,
                        "tp2": sig.tp2,
                        "score": sig.score,
                    })
                    send_facebook_bridge(cfg, sig)
                    logger.info(
                        "Signal sent %s %s score=%s entry=%s",
                        symbol,
                        sig.direction,
                        sig.score,
                        sig.entry,
                    )

            state["last_bars"] = last_bars
            state["last_signal_at"] = last_signal_at
            state["last_cross"] = last_cross
            state["updated_at"] = datetime.now(timezone.utc).isoformat()
            _save_state(cfg.state_file, state)

        except Exception:
            logger.exception("Engine loop error")

        time.sleep(cfg.poll_seconds)


if __name__ == "__main__":
    run_forever()
