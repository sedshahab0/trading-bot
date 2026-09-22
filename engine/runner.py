"""Main loop — polls on new M5 bar, evaluates symbols, sends alerts."""

from __future__ import annotations

import atexit
import json
import logging
import os
import signal
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

from engine.config import EngineConfig, _env_bool
from engine.data_provider import DataProvider
from engine.notifier import (
    send_facebook_bridge,
    send_ops_telegram,
    send_signal_with_chart,
    send_telegram,
    startup_message,
)
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
    cfg.telegram_ops_chat_id = os.environ.get("TELEGRAM_OPS_CHAT_ID", cfg.telegram_ops_chat_id)
    cfg.twelve_data_api_key = os.environ.get("TWELVE_DATA_API_KEY", cfg.twelve_data_api_key)
    cfg.min_score = int(os.environ.get("MIN_SCORE", str(cfg.min_score)))
    cfg.poll_seconds = int(os.environ.get("POLL_SECONDS", str(cfg.poll_seconds)))
    cfg.debug = _env_bool("ENGINE_DEBUG", cfg.debug)
    cfg.crisis_mode = _env_bool("CRISIS_MODE", cfg.crisis_mode)
    cfg.breaking_news_enable = _env_bool("BREAKING_NEWS_ENABLE", cfg.breaking_news_enable)
    return cfg


# ── v6.13 Fix 2/6, adapted: Duplicate-Instance Guard ─────────────────
# mq5 guards against two EAs running on the same MT5 symbol/terminal via a
# GlobalVariable heartbeat. This engine normally runs as a single pm2
# process, but the same failure mode (someone manually starting a second
# `python run_engine.py` alongside the pm2-managed one) would double-fire
# every signal — so the same heartbeat-lockfile pattern applies here.
def _claim_singleton(cfg: EngineConfig) -> bool:
    if not cfg.dup_guard_enable:
        return True
    lock_path = Path(cfg.dup_guard_lock_file)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    now = time.time()
    if lock_path.exists():
        try:
            held = json.loads(lock_path.read_text())
            if held.get("pid") != os.getpid() and (now - float(held.get("heartbeat", 0))) < cfg.dup_guard_stale_secs:
                return False
        except Exception:
            pass
    lock_path.write_text(json.dumps({"pid": os.getpid(), "heartbeat": now}))
    return True


def _update_heartbeat(cfg: EngineConfig) -> None:
    if not cfg.dup_guard_enable:
        return
    try:
        Path(cfg.dup_guard_lock_file).write_text(
            json.dumps({"pid": os.getpid(), "heartbeat": time.time()})
        )
    except Exception:
        pass


def _release_singleton(cfg: EngineConfig) -> None:
    """mq5's OnDeinit -> ReleaseSingleton(): free the lock on a clean exit
    (pm2 restart/stop sends SIGTERM) so the next start doesn't mistake the
    just-exited process's still-fresh heartbeat for a genuine duplicate."""
    if not cfg.dup_guard_enable:
        return
    try:
        lock_path = Path(cfg.dup_guard_lock_file)
        if lock_path.exists():
            held = json.loads(lock_path.read_text())
            if held.get("pid") == os.getpid():
                lock_path.unlink()
    except Exception:
        pass


def _handle_shutdown_signal(signum, frame) -> None:
    raise SystemExit(0)


def _install_singleton_release(cfg: EngineConfig) -> None:
    atexit.register(_release_singleton, cfg)
    signal.signal(signal.SIGTERM, _handle_shutdown_signal)
    signal.signal(signal.SIGINT, _handle_shutdown_signal)


# ── v6.13 Fix 9: Breaking News Auto-Detection ────────────────────────
# Optional, OFF by default (matching mq5) — polls a user-supplied URL for
# high-severity keywords and pauses ALL signal generation globally for a
# cooldown period on a match. Requires BREAKING_NEWS_URL to be set.
_news_check_state = {"last_check": 0.0, "last_alert": 0.0}


def _breaking_news_paused(cfg: EngineConfig) -> bool:
    if not cfg.breaking_news_enable or not cfg.breaking_news_url:
        return False
    now = time.time()
    still_cooling = (now - _news_check_state["last_alert"]) < cfg.breaking_news_cooldown_mins * 60
    if (now - _news_check_state["last_check"]) < cfg.breaking_news_check_mins * 60:
        return still_cooling
    _news_check_state["last_check"] = now
    try:
        r = requests.get(cfg.breaking_news_url, timeout=10)
        body = r.text.lower()
    except Exception as exc:
        logger.debug("Breaking news fetch failed: %s", exc)
        return still_cooling
    for kw in cfg.breaking_news_keywords.split(","):
        kw = kw.strip().lower()
        if kw and kw in body:
            _news_check_state["last_alert"] = now
            logger.warning(
                "Breaking news keyword match: '%s' — pausing signals for %s min",
                kw,
                cfg.breaking_news_cooldown_mins,
            )
            send_telegram(
                cfg,
                f"⚠️ <b>Breaking News Alert</b>\nKeyword match: {kw}\n"
                f"Signals paused {cfg.breaking_news_cooldown_mins} min",
                message_type="alert",
                direction="ALERT",
            )
            return True
    return still_cooling


def run_forever(cfg: EngineConfig | None = None) -> None:
    _load_dotenv(overwrite=True)
    cfg = _refresh_cfg(cfg or EngineConfig())
    logging.basicConfig(
        level=logging.DEBUG if cfg.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    if cfg.notifications_paused:
        logger.warning("NOTIFICATIONS_PAUSED=1 — engine idle until resumed")

    has_twelve_key = bool(
        cfg.twelve_data_api_key or os.environ.get("TWELVE_DATA_API_KEYS", "").strip()
    )
    if cfg.data_provider == "twelvedata" and not has_twelve_key:
        raise SystemExit(
            "Set TWELVE_DATA_API_KEY / TWELVE_DATA_API_KEYS (free at https://twelvedata.com)."
        )
    if not cfg.telegram_bot_token or not cfg.telegram_chat_id:
        raise SystemExit("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID")

    if not _claim_singleton(cfg):
        logger.error(
            "Another live instance holds the duplicate-guard lock (%s) — this instance will "
            "idle and retry rather than double-fire signals. Remove the duplicate process.",
            cfg.dup_guard_lock_file,
        )
        while not _claim_singleton(cfg):
            time.sleep(cfg.dup_guard_stale_secs)
        logger.info("Duplicate-guard lock acquired — resuming normal operation")
    _install_singleton_release(cfg)

    data = DataProvider(cfg.twelve_data_api_key, "twelvedata")

    def _on_pool_change(usable: int, total: int, _status: dict) -> None:
        if usable == 0:
            send_ops_telegram(
                cfg,
                f"Twelve Data: هر {total} کلید بسته است تا ریست نیمه‌شب UTC. تا آن موقع سیگنال ساخته نمی‌شود.",
            )
        elif usable == 1:
            send_ops_telegram(
                cfg,
                f"Twelve Data: فقط ۱ کلید از {total} مانده.",
            )

    data.on_pool_change = _on_pool_change
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
    off_plan: set[str] = set()
    last_signal_at: dict[str, float] = state.get("last_signal_at", {})
    last_signal_dir: dict[str, int] = state.get("last_signal_dir", {})
    last_signal_entry: dict[str, float] = state.get("last_signal_entry", {})
    last_cross: dict[str, int] = state.get("last_cross", {})
    last_spike: dict[str, list] = state.get("last_spike", {})
    spike_state = {sym: tuple(v) for sym, v in last_spike.items()}

    while True:
        try:
            cfg = _refresh_cfg(cfg)
            data.reload_keys_from_env()
            _update_heartbeat(cfg)
            if cfg.notifications_paused:
                logger.info("Notifications paused — engine idle (no signals sent)")
                time.sleep(cfg.poll_seconds)
                continue

            if _breaking_news_paused(cfg):
                time.sleep(cfg.poll_seconds)
                continue

            for symbol in cfg.symbols:
                try:
                    bar_key = engine.latest_m5_bar(symbol)
                except Exception as exc:
                    if "on this plan" in str(exc):
                        if symbol not in off_plan:
                            off_plan.add(symbol)
                            logger.warning(
                                "%s is not on this Twelve Data plan; skipping until the next UTC day",
                                symbol,
                            )
                        continue
                    logger.exception("Market data unavailable for %s", symbol)
                    continue
                if not bar_key:
                    continue

                prev = last_bars.get(symbol)
                if prev == bar_key:
                    continue
                logger.info("New H1 bar %s %s (was %s)", symbol, bar_key, prev)
                last_bars[symbol] = bar_key

                data.prefetch_symbol(symbol)
                try:
                    frames = engine.fetch_frames(symbol)
                except Exception:
                    logger.exception("Incomplete market frames for %s", symbol)
                    continue
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

                recent_signals = {
                    sym: (
                        last_signal_at.get(sym, 0),
                        last_signal_dir.get(sym, 0),
                        last_signal_entry.get(sym, 0.0),
                    )
                    for sym in cfg.symbols
                }
                sig = engine.evaluate(
                    symbol, frames=frames, recent_signals=recent_signals, spike_state=spike_state
                )
                if not sig:
                    continue

                cool_secs = cfg.cooldown_bars * 300
                last_ts = last_signal_at.get(symbol, 0)
                if time.time() - last_ts < cool_secs:
                    continue

                # Tracking is independent of Telegram. A dead bot token used
                # to skip simulation.register and the Facebook/dashboard
                # bridge, so the track record went silent for weeks.
                last_signal_at[symbol] = time.time()
                last_signal_dir[symbol] = sig.trend
                last_signal_entry[symbol] = sig.entry
                simulation.register({
                    "timestamp": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                    "symbol": sig.symbol,
                    "direction": sig.direction,
                    "entry": sig.entry,
                    "sl": sig.sl,
                    "tp1": sig.tp1,
                    "tp2": sig.tp2,
                    "score": sig.score,
                    "confluence": sig.confluence,
                })
                send_facebook_bridge(cfg, sig, frames["H1"])
                delivered = send_signal_with_chart(cfg, sig, frames["H1"])
                if delivered:
                    logger.info(
                        "Signal sent %s %s score=%s entry=%s",
                        symbol,
                        sig.direction,
                        sig.score,
                        sig.entry,
                    )
                else:
                    logger.error(
                        "Signal tracked but Telegram delivery failed for %s %s entry=%s",
                        symbol,
                        sig.direction,
                        sig.entry,
                    )

            state["last_bars"] = last_bars
            state["last_signal_at"] = last_signal_at
            state["last_signal_dir"] = last_signal_dir
            state["last_signal_entry"] = last_signal_entry
            state["last_cross"] = last_cross
            state["last_spike"] = {sym: list(v) for sym, v in spike_state.items()}
            state["updated_at"] = datetime.now(timezone.utc).isoformat()
            _save_state(cfg.state_file, state)

        except Exception:
            logger.exception("Engine loop error")

        time.sleep(cfg.poll_seconds)


if __name__ == "__main__":
    run_forever()
