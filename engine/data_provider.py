"""Fetch OHLCV candles from Twelve Data (or yfinance fallback)."""

from __future__ import annotations

import logging
import time
from collections import deque
from typing import Dict

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
    # Covers the full 72h simulation window plus a safety margin.
    "M5": 1200,
    "M15": 300,
    "H1": 300,
    "D1": 250,
    "W1": 100,
}

# Twelve Data Basic: 8 req/min — stay under with longer cache + spacing
CACHE_TTL = {
    "M5": 300,      # 5 min
    "M15": 900,     # 15 min
    "H1": 3600,     # 1 hour
    "D1": 14400,    # 4 hours
    "W1": 86400,    # 1 day
}


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


class DataProvider:
    def __init__(self, api_key: str, provider: str = "twelvedata"):
        self.api_key = api_key
        self.provider = provider
        self._cache: Dict[str, tuple[float, pd.DataFrame]] = {}
        self._limiter = RateLimiter()

    def get_ohlcv(self, symbol: str, timeframe: str) -> pd.DataFrame:
        key = f"{symbol}:{timeframe}"
        now = time.time()
        ttl = CACHE_TTL.get(timeframe, 300)

        if key in self._cache:
            ts, df = self._cache[key]
            if now - ts < ttl:
                return df.copy()

        if self.provider == "yfinance":
            df = self._fetch_yfinance(symbol, timeframe)
        else:
            df = self._fetch_twelve_data(symbol, timeframe)

        df = df.sort_index()
        self._cache[key] = (now, df)
        return df.copy()

    def _fetch_twelve_data(self, symbol: str, timeframe: str) -> pd.DataFrame:
        if not self.api_key:
            raise RuntimeError(
                "TWELVE_DATA_API_KEY is required. Get a free key at https://twelvedata.com"
            )
        key = f"{symbol}:{timeframe}"
        interval = INTERVAL_MAP[timeframe]
        url = "https://api.twelvedata.com/time_series"
        params = {
            "symbol": symbol,
            "interval": interval,
            "outputsize": OUTPUT_SIZE[timeframe],
            "apikey": self.api_key,
            "timezone": "UTC",
        }

        for attempt in range(3):
            self._limiter.wait()
            try:
                r = requests.get(url, params=params, timeout=30)
                if r.status_code == 429:
                    retry = int(r.headers.get("Retry-After", 60))
                    logger.warning(
                        "Twelve Data 429 for %s %s — wait %ss (attempt %s)",
                        symbol,
                        timeframe,
                        retry,
                        attempt + 1,
                    )
                    if key in self._cache:
                        logger.warning("Using stale cache for %s", key)
                        return self._cache[key][1].copy()
                    time.sleep(retry)
                    continue
                r.raise_for_status()
                payload = r.json()
                if payload.get("status") == "error":
                    msg = payload.get("message", str(payload))
                    if "API credits" in msg or "rate" in msg.lower():
                        if key in self._cache:
                            return self._cache[key][1].copy()
                        time.sleep(60)
                        continue
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
                return df[["open", "high", "low", "close"]].dropna()
            except requests.RequestException as e:
                if key in self._cache:
                    logger.warning("Request failed, stale cache for %s: %s", key, e)
                    return self._cache[key][1].copy()
                if attempt == 2:
                    raise
                time.sleep(15 * (attempt + 1))

        if key in self._cache:
            return self._cache[key][1].copy()
        raise RuntimeError(f"Failed to fetch {symbol} {timeframe} after retries")

    def _fetch_yfinance(self, symbol: str, timeframe: str) -> pd.DataFrame:
        import yfinance as yf

        yf_map = {
            "EUR/USD": "EURUSD=X",
            "GBP/USD": "GBPUSD=X",
            "XAU/USD": "GC=F",
            "USD/JPY": "USDJPY=X",
        }
        ticker = yf_map.get(symbol, symbol.replace("/", "") + "=X")
        interval_map = {
            "M5": "5m",
            "M15": "15m",
            "H1": "1h",
            "D1": "1d",
            "W1": "1wk",
        }
        period_map = {
            "M5": "5d",
            "M15": "5d",
            "H1": "1mo",
            "D1": "1y",
            "W1": "2y",
        }
        t = yf.Ticker(ticker)
        df = t.history(
            interval=interval_map[timeframe],
            period=period_map[timeframe],
            auto_adjust=False,
        )
        if df.empty:
            raise RuntimeError(f"yfinance empty for {symbol} {timeframe}")
        df.index = df.index.tz_convert("UTC")
        df = df.rename(columns=str.lower)
        return df[["open", "high", "low", "close"]].dropna()

    def prefetch_symbol(self, symbol: str) -> None:
        """Warm cache slowly: HTF first (change rarely), LTF last."""
        for tf in ("W1", "D1", "H1", "M15", "M5"):
            try:
                self.get_ohlcv(symbol, tf)
            except Exception as e:
                logger.error("Prefetch %s %s failed: %s", symbol, tf, e)
