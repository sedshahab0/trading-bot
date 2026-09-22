"""OHLCV from Twelve Data with a persistent candle warehouse and API-key pool."""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import sqlite3
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Dict

import pandas as pd
import requests

logger = logging.getLogger(__name__)

INTERVAL_MAP = {
    "M5": "5min",
    "M15": "15min",
    "H1": "1h",
    "D1": "1day",
    "W1": "1week",
}

OUTPUT_SIZE = {
    "M5": 500,
    "M15": 300,
    "H1": 300,
    "D1": 250,
    "W1": 100,
}

# Small follow-up pulls once the warehouse already holds enough history.
REFRESH_SIZE = {
    "M5": 36,
    "M15": 24,
    "H1": 12,
    "D1": 8,
    "W1": 4,
}

MIN_BARS = {
    "M5": 80,
    "M15": 80,
    "H1": 230,
    "D1": 210,
    "W1": 30,
}

KEEP_BARS = {
    "M5": 500,
    "M15": 400,
    "H1": 400,
    "D1": 280,
    "W1": 120,
}

INVALID_UNTIL = datetime(2099, 1, 1, tzinfo=timezone.utc).timestamp()
POOL_ALERT_ALL = "all"
POOL_ALERT_LOW = "low"
POOL_ALERT_OK = "ok"


class RateLimiter:
    """Max 6 API calls per rolling 60s window + minimum gap between calls."""

    def __init__(self, max_per_minute: int = 6, min_gap: float = 8.5):
        self.max_per_minute = max_per_minute
        self.min_gap = min_gap
        self._times: deque[float] = deque()
        self._last_call = 0.0

    def wait(self) -> None:
        now = time.time()
        while self._times and now - self._times[0] >= 60:
            self._times.popleft()
        if len(self._times) >= self.max_per_minute:
            sleep_for = 60 - (now - self._times[0]) + 1.0
            logger.warning("Rate limit: sleeping %.0fs", sleep_for)
            time.sleep(sleep_for)
            now = time.time()
        gap = self.min_gap - (now - self._last_call)
        if gap > 0:
            time.sleep(gap)
        now = time.time()
        self._times.append(now)
        self._last_call = now


def _parse_api_keys(primary: str) -> list[str]:
    keys: list[str] = []
    extra = os.environ.get("TWELVE_DATA_API_KEYS", "")
    for raw in (primary, extra):
        for part in str(raw or "").replace(";", ",").split(","):
            key = part.strip()
            if key and key not in keys:
                keys.append(key)
    return keys


def _fingerprint(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def _redact_error(exc: BaseException) -> str:
    text = str(exc)
    if "apikey=" in text.lower():
        lower = text.lower()
        start = lower.find("apikey=")
        return text[:start] + "apikey=***"
    return text


def _daily_credit_exhausted(message: str) -> bool:
    lowered = message.lower()
    if "credits for the day" in lowered:
        return True
    if "run out of api credits" in lowered:
        return True
    if "api credits" in message and "daily" in lowered:
        return True
    if "daily" in lowered and "credit" in lowered:
        return True
    return False


def _next_utc_reset() -> datetime:
    now_utc = datetime.now(timezone.utc)
    return (now_utc + timedelta(days=1)).replace(hour=0, minute=2, second=0, microsecond=0)


def _period_start(now: datetime, timeframe: str) -> datetime:
    now = now.astimezone(timezone.utc).replace(second=0, microsecond=0)
    if timeframe == "M5":
        return now.replace(minute=(now.minute // 5) * 5)
    if timeframe == "M15":
        return now.replace(minute=(now.minute // 15) * 15)
    if timeframe == "H1":
        return now.replace(minute=0)
    if timeframe == "D1":
        return now.replace(hour=0, minute=0)
    if timeframe == "W1":
        return (now - timedelta(days=now.weekday())).replace(hour=0, minute=0)
    return now.replace(minute=0)


def _warehouse_covers(frame: pd.DataFrame | None, timeframe: str, now: datetime) -> bool:
    if frame is None or frame.empty:
        return False
    if len(frame) < MIN_BARS.get(timeframe, 50):
        return False
    last = frame.index[-1]
    if last.tzinfo is None:
        last = last.tz_localize("UTC")
    else:
        last = last.tz_convert("UTC")
    return last >= _period_start(now, timeframe)


class DataProvider:
    def __init__(self, api_key: str, provider: str = "twelvedata"):
        self.provider = provider
        self._cache: Dict[str, tuple[float, pd.DataFrame]] = {}
        self._key_blocked_until: dict[str, float] = {}
        self._key_reason: dict[str, str] = {}
        self._sticky_fp = ""
        self._twelve_blocked_until = 0.0
        self._last_pool_alert = POOL_ALERT_OK
        self.on_pool_change: Callable[[int, int, dict], None] | None = None
        self._limiter = RateLimiter()
        data_root = Path(os.environ.get("BOT_DATA_ROOT", "/var/lib/trading-bot"))
        self._cache_db = Path(os.environ.get("MARKET_CACHE_DB", str(data_root / "market-cache.sqlite3")))
        self._pool_status_path = Path(
            os.environ.get("TWELVE_POOL_STATUS", str(data_root / "twelve-pool.json"))
        )
        self._init_persistent_cache()
        self.api_keys: list[str] = []
        self.api_key = ""
        self._configured_primary = api_key or os.environ.get("TWELVE_DATA_API_KEY", "")
        self._limiters: dict[str, RateLimiter] = {}
        self.reload_keys_from_env(api_key)
        self.budget_mode = os.environ.get("TWELVEDATA_BUDGET_MODE", "0").lower() in {
            "1", "true", "yes", "on"
        }

    def reload_keys_from_env(self, primary: str | None = None) -> None:
        env_primary = os.environ.get("TWELVE_DATA_API_KEY", "")
        if primary is None:
            primary = env_primary or self._configured_primary
        elif primary:
            self._configured_primary = primary
        keys = _parse_api_keys(primary)
        changed = keys != self.api_keys
        self.api_keys = keys
        self.api_key = self.api_keys[0] if self.api_keys else (primary or "")
        for key in self.api_keys:
            self._limiters.setdefault(key, RateLimiter())
        self._load_key_state()
        self._sync_global_block()
        self._write_pool_status()
        if self.api_keys and changed:
            logger.info("Twelve Data keys loaded: %s", len(self.api_keys))

    def pool_status(self) -> dict:
        now = time.time()
        keys = []
        for index, key in enumerate(self.api_keys, start=1):
            until = self._key_blocked_until.get(key, 0.0)
            reason = self._key_reason.get(key, "")
            blocked = now < until
            if reason == "invalid":
                state = "invalid"
            elif blocked:
                state = "blocked"
            elif _fingerprint(key) == self._sticky_fp:
                state = "active"
            else:
                state = "ready"
            keys.append({
                "n": index,
                "suffix": key[-4:] if len(key) >= 4 else key,
                "state": state,
                "reason": reason,
                "until": (
                    datetime.fromtimestamp(until, timezone.utc).isoformat()
                    if blocked else None
                ),
            })
        usable = self._usable_keys()
        sticky = ""
        if self._sticky_fp:
            for key in self.api_keys:
                if _fingerprint(key) == self._sticky_fp:
                    sticky = key[-4:]
                    break
        return {
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "total": len(self.api_keys),
            "usable": len(usable),
            "sticky": sticky,
            "keys": keys,
        }

    def _key_label(self, key: str) -> str:
        try:
            index = self.api_keys.index(key) + 1
        except ValueError:
            index = 0
        suffix = key[-4:] if len(key) >= 4 else key
        return f"#{index} …{suffix}"

    def _usable_keys(self) -> list[str]:
        now = time.time()
        live = [key for key in self.api_keys if now >= self._key_blocked_until.get(key, 0.0)]
        if not live:
            return []
        sticky = next((key for key in live if _fingerprint(key) == self._sticky_fp), None)
        if sticky:
            return [sticky, *[key for key in live if key != sticky]]
        return live

    def _sync_global_block(self) -> None:
        usable = self._usable_keys()
        if usable:
            self.api_key = usable[0]
            self._limiter = self._limiters.setdefault(self.api_key, RateLimiter())
            self._twelve_blocked_until = 0.0
            return
        self._twelve_blocked_until = max(self._key_blocked_until.values(), default=0.0)

    def _block_key(self, key: str, until: float, reason: str) -> None:
        self._key_blocked_until[key] = until
        self._key_reason[key] = reason
        if _fingerprint(key) == self._sticky_fp:
            nxt = self._usable_keys()
            self._sticky_fp = _fingerprint(nxt[0]) if nxt else ""
        self._persist_key_row(key)
        self._persist_sticky()
        self._sync_global_block()
        reset = datetime.fromtimestamp(until, timezone.utc).isoformat()
        logger.warning(
            "Twelve Data key %s blocked until %s (%s); %s key(s) still usable",
            self._key_label(key),
            reset,
            reason,
            len(self._usable_keys()),
        )
        self._write_pool_status()
        self._emit_pool_alert()

    def _mark_key_ok(self, key: str) -> None:
        self._key_blocked_until.pop(key, None)
        self._key_reason.pop(key, None)
        self._sticky_fp = _fingerprint(key)
        self.api_key = key
        self._limiter = self._limiter_for(key)
        self._persist_key_row(key, ok=True)
        self._persist_sticky()
        self._sync_global_block()
        self._write_pool_status()
        self._emit_pool_alert()

    def _limiter_for(self, key: str) -> RateLimiter:
        limiter = self._limiters.get(key)
        if limiter is None:
            limiter = RateLimiter()
            self._limiters[key] = limiter
        return limiter

    def _init_persistent_cache(self) -> None:
        try:
            self._cache_db.parent.mkdir(parents=True, exist_ok=True)
            with sqlite3.connect(self._cache_db, timeout=5) as conn:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS market_cache (
                        cache_key TEXT PRIMARY KEY,
                        fetched_at REAL NOT NULL,
                        payload TEXT NOT NULL
                    )
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS candles (
                        symbol TEXT NOT NULL,
                        timeframe TEXT NOT NULL,
                        bar_time TEXT NOT NULL,
                        open REAL NOT NULL,
                        high REAL NOT NULL,
                        low REAL NOT NULL,
                        close REAL NOT NULL,
                        source TEXT NOT NULL,
                        fetched_at REAL NOT NULL,
                        PRIMARY KEY (symbol, timeframe, bar_time)
                    )
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS twelve_keys (
                        fingerprint TEXT PRIMARY KEY,
                        suffix TEXT NOT NULL,
                        blocked_until REAL NOT NULL DEFAULT 0,
                        reason TEXT NOT NULL DEFAULT '',
                        last_ok_at REAL,
                        last_error_at REAL
                    )
                """)
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS twelve_pool (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        sticky_fp TEXT NOT NULL DEFAULT '',
                        last_alert TEXT NOT NULL DEFAULT 'ok'
                    )
                """)
                conn.execute(
                    "INSERT OR IGNORE INTO twelve_pool(id, sticky_fp, last_alert) VALUES (1, '', 'ok')"
                )
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS twelve_symbols (
                        symbol TEXT NOT NULL,
                        timeframe TEXT NOT NULL,
                        blocked_until REAL NOT NULL DEFAULT 0,
                        reason TEXT NOT NULL DEFAULT '',
                        PRIMARY KEY (symbol, timeframe)
                    )
                """)
        except (OSError, sqlite3.Error) as exc:
            logger.warning("Persistent market cache unavailable: %s", exc)
            self._cache_db = None

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._cache_db), timeout=5)
        conn.row_factory = sqlite3.Row
        return conn

    def _load_key_state(self) -> None:
        self._key_blocked_until = {}
        self._key_reason = {}
        if self._cache_db is None:
            return
        try:
            with self._connect() as conn:
                row = conn.execute("SELECT sticky_fp, last_alert FROM twelve_pool WHERE id=1").fetchone()
                if row:
                    self._sticky_fp = row["sticky_fp"] or ""
                    self._last_pool_alert = row["last_alert"] or POOL_ALERT_OK
                rows = conn.execute(
                    "SELECT fingerprint, blocked_until, reason FROM twelve_keys"
                ).fetchall()
            by_fp = {key: _fingerprint(key) for key in self.api_keys}
            now = time.time()
            for rec in rows:
                key = next((k for k, fp in by_fp.items() if fp == rec["fingerprint"]), None)
                if key is None:
                    continue
                until = float(rec["blocked_until"] or 0)
                reason = rec["reason"] or ""
                if until > now:
                    self._key_blocked_until[key] = until
                    self._key_reason[key] = reason
            if self._sticky_fp not in by_fp.values():
                self._sticky_fp = ""
        except (OSError, sqlite3.Error) as exc:
            logger.warning("Twelve key state load failed: %s", exc)

    def _persist_key_row(self, key: str, ok: bool = False) -> None:
        if self._cache_db is None:
            return
        now = time.time()
        try:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO twelve_keys(fingerprint, suffix, blocked_until, reason, last_ok_at, last_error_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(fingerprint) DO UPDATE SET
                        suffix=excluded.suffix,
                        blocked_until=excluded.blocked_until,
                        reason=excluded.reason,
                        last_ok_at=COALESCE(excluded.last_ok_at, twelve_keys.last_ok_at),
                        last_error_at=COALESCE(excluded.last_error_at, twelve_keys.last_error_at)
                    """,
                    (
                        _fingerprint(key),
                        key[-4:] if len(key) >= 4 else key,
                        0.0 if ok else self._key_blocked_until.get(key, 0.0),
                        "" if ok else self._key_reason.get(key, ""),
                        now if ok else None,
                        None if ok else now,
                    ),
                )
        except (OSError, sqlite3.Error) as exc:
            logger.warning("Twelve key state write failed: %s", exc)

    def _persist_sticky(self) -> None:
        if self._cache_db is None:
            return
        try:
            with self._connect() as conn:
                conn.execute(
                    "UPDATE twelve_pool SET sticky_fp=?, last_alert=? WHERE id=1",
                    (self._sticky_fp, self._last_pool_alert),
                )
        except (OSError, sqlite3.Error) as exc:
            logger.warning("Twelve sticky write failed: %s", exc)

    def _write_pool_status(self) -> None:
        payload = self.pool_status()
        try:
            self._pool_status_path.parent.mkdir(parents=True, exist_ok=True)
            self._pool_status_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
        except OSError as exc:
            logger.warning("Twelve pool status write failed: %s", exc)

    def _emit_pool_alert(self) -> None:
        usable = len(self._usable_keys())
        total = len(self.api_keys)
        if usable == 0:
            level = POOL_ALERT_ALL
        elif usable == 1:
            level = POOL_ALERT_LOW
        else:
            level = POOL_ALERT_OK
        if level == self._last_pool_alert:
            return
        self._last_pool_alert = level
        self._persist_sticky()
        if self.on_pool_change:
            try:
                self.on_pool_change(usable, total, self.pool_status())
            except Exception as exc:
                logger.warning("Twelve pool alert callback failed: %s", exc)

    def _read_persistent(self, key: str) -> tuple[float, pd.DataFrame] | None:
        if self._cache_db is None:
            return None
        try:
            with sqlite3.connect(self._cache_db, timeout=3) as conn:
                row = conn.execute(
                    "SELECT fetched_at, payload FROM market_cache WHERE cache_key=?", (key,)
                ).fetchone()
            if not row:
                return None
            frame = pd.read_json(io.StringIO(row[1]), orient="split")
            frame.index = pd.to_datetime(frame.index, utc=True)
            return float(row[0]), frame
        except (ValueError, OSError, sqlite3.Error) as exc:
            logger.warning("Persistent cache read failed for %s: %s", key, exc)
            return None

    def _write_persistent(self, key: str, fetched_at: float, frame: pd.DataFrame) -> None:
        if self._cache_db is None:
            return
        try:
            payload = frame.to_json(orient="split", date_format="iso")
            with sqlite3.connect(self._cache_db, timeout=3) as conn:
                conn.execute(
                    """
                    INSERT INTO market_cache(cache_key, fetched_at, payload)
                    VALUES (?, ?, ?)
                    ON CONFLICT(cache_key) DO UPDATE SET
                        fetched_at=excluded.fetched_at,
                        payload=excluded.payload
                    """,
                    (key, fetched_at, payload),
                )
        except (OSError, sqlite3.Error) as exc:
            logger.warning("Persistent cache write failed for %s: %s", key, exc)

    def _load_candles(self, symbol: str, timeframe: str) -> pd.DataFrame | None:
        if self._cache_db is None:
            return None
        try:
            with self._connect() as conn:
                rows = conn.execute(
                    """
                    SELECT bar_time, open, high, low, close
                    FROM candles
                    WHERE symbol=? AND timeframe=?
                    ORDER BY bar_time
                    """,
                    (symbol, timeframe),
                ).fetchall()
            if not rows:
                return None
            frame = pd.DataFrame(
                [{"open": r["open"], "high": r["high"], "low": r["low"], "close": r["close"]} for r in rows],
                index=pd.to_datetime([r["bar_time"] for r in rows], utc=True),
            )
            return frame
        except (OSError, sqlite3.Error, ValueError) as exc:
            logger.warning("Candle warehouse read failed for %s %s: %s", symbol, timeframe, exc)
            return None

    def _save_candles(self, symbol: str, timeframe: str, frame: pd.DataFrame) -> None:
        if self._cache_db is None or frame.empty:
            return
        keep = KEEP_BARS.get(timeframe, 400)
        stored = frame.sort_index().iloc[-keep:]
        now = time.time()
        rows = [
            (
                symbol,
                timeframe,
                ts.isoformat(),
                float(row["open"]),
                float(row["high"]),
                float(row["low"]),
                float(row["close"]),
                "twelvedata",
                now,
            )
            for ts, row in stored.iterrows()
        ]
        try:
            with self._connect() as conn:
                conn.executemany(
                    """
                    INSERT INTO candles(symbol, timeframe, bar_time, open, high, low, close, source, fetched_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(symbol, timeframe, bar_time) DO UPDATE SET
                        open=excluded.open,
                        high=excluded.high,
                        low=excluded.low,
                        close=excluded.close,
                        source=excluded.source,
                        fetched_at=excluded.fetched_at
                    """,
                    rows,
                )
                cutoff = stored.index[0].isoformat()
                conn.execute(
                    "DELETE FROM candles WHERE symbol=? AND timeframe=? AND bar_time < ?",
                    (symbol, timeframe, cutoff),
                )
        except (OSError, sqlite3.Error) as exc:
            logger.warning("Candle warehouse write failed for %s %s: %s", symbol, timeframe, exc)

    def _symbol_blocked_until(self, symbol: str, timeframe: str) -> tuple[float, str]:
        if self._cache_db is None:
            return 0.0, ""
        try:
            with self._connect() as conn:
                row = conn.execute(
                    "SELECT blocked_until, reason FROM twelve_symbols WHERE symbol=? AND timeframe=?",
                    (symbol, timeframe),
                ).fetchone()
            if not row:
                return 0.0, ""
            return float(row["blocked_until"] or 0), row["reason"] or ""
        except (OSError, sqlite3.Error) as exc:
            logger.warning("Twelve symbol skip read failed: %s", exc)
            return 0.0, ""

    def _block_symbol(self, symbol: str, timeframe: str, until: float, reason: str) -> None:
        if self._cache_db is None:
            return
        try:
            with self._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO twelve_symbols(symbol, timeframe, blocked_until, reason)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(symbol, timeframe) DO UPDATE SET
                        blocked_until=excluded.blocked_until,
                        reason=excluded.reason
                    """,
                    (symbol, timeframe, until, reason),
                )
        except (OSError, sqlite3.Error) as exc:
            logger.warning("Twelve symbol skip write failed: %s", exc)

    def get_ohlcv(self, symbol: str, timeframe: str) -> pd.DataFrame:
        now_dt = datetime.now(timezone.utc)
        warehouse = self._load_candles(symbol, timeframe)
        if _warehouse_covers(warehouse, timeframe, now_dt):
            frame = warehouse.sort_index()
            frame.attrs["source"] = "twelvedata"
            return frame.copy()

        until, reason = self._symbol_blocked_until(symbol, timeframe)
        if until > time.time():
            raise RuntimeError(f"Twelve Data has no {symbol} {timeframe} on this plan ({reason})")

        if self.provider == "yfinance":
            raise RuntimeError("DATA_PROVIDER=yfinance is disabled; Twelve Data only")

        outputsize = OUTPUT_SIZE[timeframe]
        if warehouse is not None and len(warehouse) >= MIN_BARS.get(timeframe, 50):
            outputsize = REFRESH_SIZE.get(timeframe, 12)
        df = self._fetch_twelve_data(symbol, timeframe, outputsize=outputsize)
        if warehouse is not None and not warehouse.empty:
            df = pd.concat([warehouse, df])
            df = df[~df.index.duplicated(keep="last")].sort_index()
        df = df.sort_index()
        self._save_candles(symbol, timeframe, df)
        blob_key = f"{symbol}:{timeframe}"
        self._cache[blob_key] = (time.time(), df)
        self._write_persistent(blob_key, time.time(), df)
        df.attrs["source"] = "twelvedata"
        return df.copy()

    def _provider_for_symbol(self, symbol: str) -> str:
        if self.provider == "yfinance":
            return "yfinance"
        return "twelvedata"

    def _fetch_twelve_data(
        self, symbol: str, timeframe: str, outputsize: int | None = None
    ) -> pd.DataFrame:
        if not self.api_keys:
            raise RuntimeError(
                "TWELVE_DATA_API_KEY is required. Get a free key at https://twelvedata.com"
            )
        usable = self._usable_keys()
        if not usable:
            raise RuntimeError("All Twelve Data keys are at their daily credit limit")
        size = outputsize or OUTPUT_SIZE[timeframe]
        last_error: Exception | None = None
        for key_index, api_key in enumerate(usable):
            try:
                return self._request_twelve_series(symbol, timeframe, api_key, size)
            except _KeyDailyLimit as exc:
                last_error = exc
                if key_index < len(usable) - 1:
                    logger.warning(
                        "Twelve Data key %s out of daily credits for %s %s — switching to next key",
                        self._key_label(api_key),
                        symbol,
                        timeframe,
                    )
                    continue
                raise RuntimeError(str(exc)) from exc
            except _KeyRateLimited as exc:
                last_error = exc
                if key_index < len(usable) - 1:
                    logger.warning(
                        "Twelve Data key %s hit per-minute limit for %s %s — switching to next key",
                        self._key_label(api_key),
                        symbol,
                        timeframe,
                    )
                    continue
                time.sleep(exc.retry_after)
                try:
                    return self._request_twelve_series(symbol, timeframe, api_key, size)
                except _KeyRateLimited:
                    raise RuntimeError(str(exc)) from exc
            except _SymbolUnavailable:
                raise
        if last_error:
            raise RuntimeError(str(last_error)) from last_error
        raise RuntimeError(f"Failed to fetch {symbol} {timeframe}")

    def _request_twelve_series(
        self, symbol: str, timeframe: str, api_key: str, outputsize: int
    ) -> pd.DataFrame:
        normalized_symbol = symbol.replace("/", "").upper()
        provider_symbol = (
            f"{normalized_symbol[:3]}/{normalized_symbol[3:]}"
            if len(normalized_symbol) == 6 and normalized_symbol.isalpha()
            else symbol
        )
        params = {
            "symbol": provider_symbol,
            "interval": INTERVAL_MAP[timeframe],
            "outputsize": outputsize,
            "apikey": api_key,
            "timezone": "UTC",
        }
        url = "https://api.twelvedata.com/time_series"

        for attempt in range(3):
            self._limiter_for(api_key).wait()
            try:
                r = requests.get(url, params=params, timeout=30)
                if r.status_code in (401, 403):
                    self._block_key(api_key, INVALID_UNTIL, "invalid")
                    raise _KeyDailyLimit(f"Twelve Data key rejected (HTTP {r.status_code})")
                if r.status_code == 429:
                    try:
                        message = str((r.json() or {}).get("message", ""))
                    except ValueError:
                        message = ""
                    if _daily_credit_exhausted(message):
                        reset = _next_utc_reset()
                        self._block_key(api_key, reset.timestamp(), "daily credits")
                        raise _KeyDailyLimit(
                            f"Twelve Data daily credits exhausted until {reset.isoformat()}"
                        )
                    retry = int(r.headers.get("Retry-After", 60))
                    logger.warning(
                        "Twelve Data 429 for %s %s on %s — wait %ss (attempt %s)",
                        symbol,
                        timeframe,
                        self._key_label(api_key),
                        retry,
                        attempt + 1,
                    )
                    raise _KeyRateLimited(retry)
                if r.status_code == 404 or r.status_code >= 400:
                    try:
                        payload = r.json() if r.content else {}
                    except ValueError:
                        payload = {}
                    msg = str((payload or {}).get("message") or f"HTTP {r.status_code}")
                    lowered = msg.lower()
                    if r.status_code == 404 or "grow" in lowered or "venture" in lowered:
                        self._block_symbol(symbol, timeframe, _next_utc_reset().timestamp(), msg[:180])
                        logger.warning("Twelve Data has no %s %s on this plan: %s", symbol, timeframe, msg[:180])
                        raise _SymbolUnavailable(msg)
                    if 400 <= r.status_code < 500:
                        raise RuntimeError(
                            f"Twelve Data HTTP {r.status_code} for {symbol} {timeframe}: {msg[:180]}"
                        )
                r.raise_for_status()
                payload = r.json()
                if payload.get("status") == "error":
                    msg = payload.get("message", str(payload))
                    if _daily_credit_exhausted(msg) or "API credits" in msg:
                        reset = _next_utc_reset()
                        self._block_key(api_key, reset.timestamp(), "daily credits")
                        raise _KeyDailyLimit(
                            f"Twelve Data credits exhausted until {reset.isoformat()}: {msg}"
                        )
                    if "invalid" in msg.lower() and "key" in msg.lower():
                        self._block_key(api_key, INVALID_UNTIL, "invalid")
                        raise _KeyDailyLimit(msg)
                    if "rate" in msg.lower():
                        raise _KeyRateLimited(60)
                    if "grow" in msg.lower() or "venture" in msg.lower() or "upgrading" in msg.lower():
                        self._block_symbol(symbol, timeframe, _next_utc_reset().timestamp(), msg[:180])
                        raise _SymbolUnavailable(msg)
                    raise RuntimeError(msg)
                values = payload.get("values") or []
                if not values:
                    raise RuntimeError(f"No data for {symbol} {timeframe}")
                df = pd.DataFrame(values)
                df["datetime"] = pd.to_datetime(df["datetime"], utc=True)
                df = df.set_index("datetime")
                for col in ("open", "high", "low", "close", "volume"):
                    if col in df.columns:
                        df[col] = pd.to_numeric(df[col], errors="coerce")
                df = df.rename(columns=str.lower)
                self._mark_key_ok(api_key)
                return df[["open", "high", "low", "close"]].dropna()
            except (_KeyDailyLimit, _KeyRateLimited, _SymbolUnavailable, RuntimeError):
                raise
            except requests.RequestException as e:
                if attempt == 2:
                    raise RuntimeError(
                        f"Twelve Data request failed for {symbol} {timeframe}: {_redact_error(e)}"
                    ) from e
                time.sleep(15 * (attempt + 1))

        raise RuntimeError(f"Failed to fetch {symbol} {timeframe} after retries")

    def prefetch_symbol(self, symbol: str) -> None:
        """Warm only the frames the engine actually evaluates."""
        for tf in ("D1", "H1", "M5"):
            try:
                self.get_ohlcv(symbol, tf)
            except Exception as e:
                logger.error("Prefetch %s %s failed: %s", symbol, tf, e)


class _KeyDailyLimit(RuntimeError):
    """This Twelve Data key is unusable until UTC reset (or quarantined if invalid)."""


class _KeyRateLimited(RuntimeError):
    def __init__(self, retry_after: int):
        super().__init__(f"per-minute rate limit, retry after {retry_after}s")
        self.retry_after = retry_after


class _SymbolUnavailable(RuntimeError):
    """This Twelve Data symbol is not on the current plan (or does not exist)."""
