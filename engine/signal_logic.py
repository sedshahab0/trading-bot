"""Core signal detection — Donchian breakout on trending metals (H1).

This replaced the earlier multi-indicator SMC stack, which backtested at
break-even/negative on FX majors. The Donchian breakout on gold & silver (H1)
validated across 2 instruments, 4 parameter settings, and both halves of the
clean-data window (Profit Factor ~1.2-1.3). See the MT5 EdgeTest results.

Entry logic (per validated backtest, no ADX filter — it tested worse):
  - Trend filter: last closed H1 close vs the EMA(trend) on H1.
  - Fresh Donchian breakout: last closed H1 bar closes beyond the N-bar
    channel, and the bar before it did NOT (so we signal the break, not
    every bar of an extended run).
  - Risk: structural ATR stop; target = TP_R * risk (validated at 1:2,
    full position to target — no premature break-even).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

import pandas as pd

from engine.config import EngineConfig
from engine.data_provider import DataProvider
from engine import indicators as ind

logger = logging.getLogger(__name__)


@dataclass
class SignalResult:
    symbol: str
    trend: int  # 1 buy, -1 sell
    entry: float
    sl: float
    tp1: float
    tp2: float
    score: int
    message_html: str
    direction: str
    confluence: str = ""
    entry_low: float = 0.0
    entry_high: float = 0.0
    max_score: int = 0


@dataclass
class CrossAlert:
    symbol: str
    cross: int  # 1 golden, -1 death
    message_html: str


SEP = "─────────────"
E = {
    "green": "🟢",
    "red": "🔴",
    "money": "💰",
    "up": "📈",
    "down": "📉",
    "target": "🎯",
    "stop": "🛑",
    "check": "✅",
    "ruler": "📐",
    "clock": "🕑",
    "robot": "🤖",
    "star": "🌟",
    "skull": "💀",
    "fire": "🔥",
    "warn": "⚠️",
    "chart": "📊",
}


def discretionary_max_score(cfg: EngineConfig) -> int:
    """Retained so notifier.startup_message keeps importing cleanly. The
    Donchian strategy has no confluence score, so this is 0."""
    return 0


def _fmt_price(symbol: str, price: float) -> str:
    digits = 2 if "XAU" in symbol or "JPY" in symbol else 3 if "XAG" in symbol else 5
    return f"{price:.{digits}f}"


class SignalEngine:
    def __init__(self, cfg: EngineConfig, data: DataProvider):
        self.cfg = cfg
        self.data = data

    def fetch_frames(self, symbol: str) -> dict[str, pd.DataFrame]:
        # H1 is the ONLY essential feed — it drives every signal and the chart
        # image. If it fails, the caller skips this cycle (we can't signal
        # without it). M5 (simulation outcome tracking) and D1 (the optional
        # golden-cross alert) are non-essential: a transient data hiccup on
        # either — e.g. yfinance returning an empty daily series for gold —
        # must NEVER block a breakout signal, so they fail soft to an empty
        # frame. (M15 is no longer fetched; the chart now renders from H1.
        # Daily/M5 come from Twelve Data too — not yfinance.)
        h1 = self.data.get_ohlcv(symbol, "H1")

        def _soft(tf: str) -> pd.DataFrame:
            try:
                return self.data.get_ohlcv(symbol, tf)
            except Exception as exc:
                logger.warning("%s %s unavailable (non-essential, continuing): %s", symbol, tf, exc)
                return pd.DataFrame(columns=["open", "high", "low", "close"])

        return {"H1": h1, "M5": _soft("M5"), "D1": _soft("D1")}

    def check_golden_cross(self, symbol: str, d1: pd.DataFrame) -> CrossAlert | None:
        if not self.cfg.alert_golden_death_cross or len(d1) < self.cfg.cross_slow_ma + 3:
            return None
        fast = ind.sma(d1["close"], self.cfg.cross_fast_ma)
        slow = ind.sma(d1["close"], self.cfg.cross_slow_ma)
        cross = ind.golden_death_cross(fast, slow)
        if cross == 0:
            return None
        now = datetime.now(timezone.utc).strftime("%Y.%m.%d %H:%M")
        icon = E["star"] if cross == 1 else E["skull"]
        label = "GOLDEN" if cross == 1 else "DEATH"
        bias = "Bullish" if cross == 1 else "Bearish"
        msg = (
            f"{icon} <b>{label} CROSS - {symbol}</b>\n{SEP}\n"
            f"Daily MA{self.cfg.cross_fast_ma} crossed "
            f"{'above' if cross == 1 else 'below'} MA{self.cfg.cross_slow_ma}\n"
            f"Bias : {bias}\n{E['clock']} {now}"
        )
        return CrossAlert(symbol=symbol, cross=cross, message_html=msg)

    def in_session(self) -> bool:
        return True  # breakout strategy trades around the clock

    def latest_h1_bar(self, symbol: str) -> str | None:
        h1 = self.data.get_ohlcv(symbol, "H1")
        if h1.empty:
            return None
        return str(h1.index[-1])

    # kept as an alias so any older caller still works
    def latest_m5_bar(self, symbol: str) -> str | None:
        return self.latest_h1_bar(symbol)

    def evaluate(
        self,
        symbol: str,
        frames: dict[str, pd.DataFrame] | None = None,
        recent_signals=None,
        spike_state=None,
    ) -> SignalResult | None:
        cfg = self.cfg
        if frames is None:
            frames = self.fetch_frames(symbol)
        h1 = frames["H1"]

        n = cfg.donchian_n
        ema_period = cfg.donchian_trend_ema
        if len(h1) < ema_period + n + 5:
            return None

        close = h1["close"]
        ema = ind.ema(close, ema_period)

        # iloc[-1] may be a still-forming bar; iloc[-2] is the last CLOSED bar.
        c1 = float(close.iloc[-2])   # last closed bar
        c2 = float(close.iloc[-3])   # bar before it
        ema1 = ema.iloc[-2]
        if pd.isna(ema1):
            return None
        ema1 = float(ema1)

        trend_up = c1 > ema1
        trend_dn = c1 < ema1

        # Donchian channel = highest high / lowest low of the N bars BEFORE
        # the bar in question (excludes the bar itself).
        win_now = h1.iloc[-(n + 2):-2]    # N bars before the last closed bar
        win_prev = h1.iloc[-(n + 3):-3]   # N bars before the one before that
        if len(win_now) < n or len(win_prev) < n:
            return None
        hh_now = float(win_now["high"].max())
        ll_now = float(win_now["low"].min())
        hh_prev = float(win_prev["high"].max())
        ll_prev = float(win_prev["low"].min())

        # Fresh breakout only: the last closed bar breaks the channel and the
        # prior bar did not (prevents re-signalling every bar of a long run).
        direction = 0
        if cfg.donchian_require_trend and not (trend_up or trend_dn):
            return None
        if (not cfg.donchian_require_trend or trend_up) and c1 > hh_now and c2 <= hh_prev:
            direction = 1
        elif (not cfg.donchian_require_trend or trend_dn) and c1 < ll_now and c2 >= ll_prev:
            direction = -1
        if direction == 0:
            return None

        atr_s = ind.atr(h1, cfg.atr_period)
        atr_v = float(atr_s.iloc[-2]) if len(atr_s) >= 2 else 0.0
        if not pd.notna(atr_v) or atr_v <= 0:
            return None

        risk = atr_v * cfg.donchian_sl_mult
        entry = c1
        if direction == 1:
            sl = entry - risk
            tp1 = entry + risk * cfg.tp1_ratio
            tp2 = entry + risk * cfg.donchian_tp_r
        else:
            sl = entry + risk
            tp1 = entry - risk * cfg.tp1_ratio
            tp2 = entry - risk * cfg.donchian_tp_r

        zone_half = risk * cfg.entry_zone_pct
        entry_low = entry - zone_half
        entry_high = entry + zone_half

        direction_str = "BUY" if direction == 1 else "SELL"
        msg = self._build_message(
            symbol, direction, entry, entry_low, entry_high, sl, tp2, atr_v
        )

        logger.info(
            "Donchian breakout %s %s entry=%s sl=%s tp=%s",
            symbol, direction_str, entry, sl, tp2,
        )
        return SignalResult(
            symbol=symbol,
            trend=direction,
            entry=entry,
            sl=sl,
            tp1=tp1,
            tp2=tp2,
            score=0,
            message_html=msg,
            direction=direction_str,
            confluence="Donchian Breakout (H1)",
            entry_low=entry_low,
            entry_high=entry_high,
            max_score=0,
        )

    def _build_message(
        self, symbol, direction, entry, entry_low, entry_high, sl, tp, atr_v
    ) -> str:
        now = datetime.now(timezone.utc).strftime("%Y.%m.%d %H:%M")
        rr = self.cfg.donchian_tp_r
        zone = f"{_fmt_price(symbol, entry_low)} – {_fmt_price(symbol, entry_high)}"
        # Stop distance = the risk (in price) for this trade. Followers plug
        # it into: position size = (account × risk%) ÷ (stop distance × value/pt).
        stop_dist = _fmt_price(symbol, abs(entry - sl))
        if direction == 1:
            head = f"{E['green']*3}  <b>B U Y — {symbol}</b>  {E['green']*3}"
            arrow = E["up"]
            label = "BUY"
        else:
            head = f"{E['red']*3}  <b>S E L L — {symbol}</b>  {E['red']*3}"
            arrow = E["down"]
            label = "SELL"
        return (
            f"{head}\n{SEP}\n"
            f"{E['chart']}  <b>Donchian Breakout · H1</b>\n"
            f"{arrow}  <b>{label}</b>\n{SEP}\n"
            f"{E['target']}  Entry  :  <b>{_fmt_price(symbol, entry)}</b>\n"
            f"{E['target']}  Zone   :  {zone}\n"
            f"{E['stop']}  SL     :  {_fmt_price(symbol, sl)}\n"
            f"{E['check']}  TP     :  {_fmt_price(symbol, tp)}   (1:{rr:.0f})\n"
            f"{E['ruler']}  R : R  :  1 : {rr:.0f}\n"
            f"{E['ruler']}  Stop size : {stop_dist}  (risk this to size your lot)\n{SEP}\n"
            f"{E['warn']}  Risk 0.5–1% per trade · enter within the zone, "
            f"don't chase if price already left it.\n"
            f"{E['warn']}  Spread check: skip this signal if your spread is "
            f"over 5% of the stop size.\n"
            f"{E['money']}  TP is a target, not a promise — banking profit "
            f"early is always OK.\n"
            f"{E['warn']}  Trend-following: ~37% win rate — expect losing "
            f"streaks; profit comes from the occasional big run.\n{SEP}\n"
            f"{E['clock']}  {now}"
        )
