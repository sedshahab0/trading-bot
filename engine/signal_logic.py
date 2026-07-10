"""Core signal detection — port of SignalBot MQ5 v5 ProcessSignals()."""

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
}


def _score_label(score: int) -> str:
    if score >= 10:
        return f"{E['fire']} STRONG  ({score}/12)"
    if score >= 7:
        return f"{E['check']} MODERATE ({score}/12)"
    return f"{E['warn']} WATCH   ({score}/12)"


def _fmt_price(symbol: str, price: float) -> str:
    digits = 2 if "XAU" in symbol or "JPY" in symbol else 5
    return f"{price:.{digits}f}"


class SignalEngine:
    def __init__(self, cfg: EngineConfig, data: DataProvider):
        self.cfg = cfg
        self.data = data

    def fetch_frames(self, symbol: str) -> dict[str, pd.DataFrame]:
        return {
            "W1": self.data.get_ohlcv(symbol, "W1"),
            "D1": self.data.get_ohlcv(symbol, "D1"),
            "H1": self.data.get_ohlcv(symbol, "H1"),
            "M15": self.data.get_ohlcv(symbol, "M15"),
            "M5": self.data.get_ohlcv(symbol, "M5"),
        }

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
        if not self.cfg.session_enable:
            return True
        h = datetime.now(timezone.utc).hour
        return self.cfg.session_start_hour <= h < self.cfg.session_end_hour

    def evaluate(
        self, symbol: str, frames: dict[str, pd.DataFrame] | None = None
    ) -> SignalResult | None:
        cfg = self.cfg
        if not cfg.alert_full_signal:
            return None
        if not self.in_session():
            return None

        if frames is None:
            frames = self.fetch_frames(symbol)
        w1, d1, h1, m15, m5 = frames["W1"], frames["D1"], frames["H1"], frames["M15"], frames["M5"]

        # ADX regime on D1
        if cfg.adx_enable:
            adx_s = ind.adx(d1, cfg.adx_period)
            adx_v = adx_s.iloc[-2] if len(adx_s) >= 2 else float("nan")
            if not pd.isna(adx_v) and adx_v < cfg.adx_min_trend:
                return None

        w_ema = ind.ema(w1["close"], cfg.weekly_ema)
        d_ma = ind.sma(d1["close"], cfg.daily_ma)
        h1_ema = ind.ema(h1["close"], cfg.h1_ema)

        wb = ind.bias_vs_ma(w1["close"].iloc[-2], w_ema.iloc[-2])
        db = ind.bias_vs_ma(d1["close"].iloc[-2], d_ma.iloc[-2])
        if db == 0:
            return None
        trend = db

        if cfg.require_weekly_alignment and wb != trend:
            logger.debug("%s rejected: weekly alignment", symbol)
            return None

        sw = ind.swing_hl(h1, cfg.swing_lookback)
        if not sw:
            return None
        sw_h, sw_l = sw
        price = h1["close"].iloc[-2]
        fib = ind.fib_zone(price, sw_h, sw_l, trend)
        tl = ind.trendline_ok(h1, trend, cfg.fractal_wing, cfg.swing_lookback)
        h1e = ind.bias_vs_ma(h1["close"].iloc[-2], h1_ema.iloc[-2])
        if cfg.require_h1_alignment and h1e != trend:
            logger.debug("%s rejected: H1 alignment", symbol)
            return None

        rsi15_s = ind.rsi(m15["close"], cfg.rsi_period)
        macd15, sig15 = ind.macd_line_signal(
            m15["close"], cfg.macd_fast, cfg.macd_slow, cfg.macd_signal
        )
        rsi15 = ind.rsi_signal(rsi15_s, cfg.rsi_oversold, cfg.rsi_overbought, 10)
        mac15 = ind.macd_signal(macd15, sig15)

        m5_ef = ind.ema(m5["close"], cfg.m5_ema_fast)
        m5_es = ind.ema(m5["close"], cfg.m5_ema_slow)
        m5_rsi_s = ind.rsi(m5["close"], cfg.m5_rsi_period)
        ema_cross = ind.ema_cross(m5_ef, m5_es)
        rsi5 = ind.rsi_signal(
            m5_rsi_s, cfg.m5_rsi_oversold, cfg.m5_rsi_overbought, 8
        )

        atr_s = ind.atr(m15, cfg.atr_period)
        atr_v = float(atr_s.iloc[-2]) if len(atr_s) >= 2 else 0.0
        if not pd.notna(atr_v) or atr_v <= 0:
            logger.debug("%s rejected: invalid ATR", symbol)
            return None
        if cfg.volatility_regime_enable:
            regime_ok, regime_ratio = ind.volatility_regime(
                atr_s,
                cfg.volatility_lookback,
                cfg.volatility_min_ratio,
                cfg.volatility_max_ratio,
            )
            if not regime_ok:
                logger.debug("%s rejected: volatility ratio=%s", symbol, regime_ratio)
                return None

        if cfg.candle_confirmation_enable and not ind.directional_candle(
            m5, trend, cfg.min_trigger_body_ratio
        ):
            logger.debug("%s rejected: M5 candle confirmation", symbol)
            return None

        m15_anchor = ind.ema(m15["close"], cfg.h1_ema).iloc[-2]
        entry = float(m5["close"].iloc[-2])
        if not pd.notna(m15_anchor) or abs(entry - float(m15_anchor)) > atr_v * cfg.max_entry_distance_atr:
            logger.debug("%s rejected: entry extended from M15 mean", symbol)
            return None
        amd_ok = ind.amd_signal(m15, trend, atr_v, cfg) == trend

        score = 0
        if db == trend:
            score += 3
        if wb == trend:
            score += 2
        if h1e == trend:
            score += 2
        if tl == trend:
            score += 1
        if fib:
            score += 1
        if rsi15 == trend or mac15 == trend:
            score += 1
        if ema_cross == trend or rsi5 == trend:
            score += 1
        if amd_ok:
            score += 1

        trigger = rsi15 == trend or mac15 == trend or ema_cross == trend or rsi5 == trend

        if cfg.debug:
            logger.info(
                "%s trend=%s score=%s trigger=%s wb=%s db=%s",
                symbol,
                trend,
                score,
                trigger,
                wb,
                db,
            )

        if not trigger or score < cfg.min_score:
            return None

        sl = ind.structural_sl(h1, trend, entry, atr_v, cfg)
        sl_dist = abs(entry - sl)
        stop_atr = sl_dist / atr_v
        if not cfg.min_stop_atr <= stop_atr <= cfg.max_stop_atr:
            logger.debug("%s rejected: stop distance %.2f ATR", symbol, stop_atr)
            return None
        if trend == 1:
            tp1 = entry + sl_dist * cfg.tp1_ratio
            tp2 = entry + sl_dist * cfg.rr_ratio
        else:
            tp1 = entry - sl_dist * cfg.tp1_ratio
            tp2 = entry - sl_dist * cfg.rr_ratio

        label = _score_label(score)
        now = datetime.now(timezone.utc).strftime("%Y.%m.%d %H:%M")
        direction = "BUY" if trend == 1 else "SELL"

        if trend == 1:
            msg = (
                f"{E['green']*3}  <b>B U Y  S I G N A L</b>  {E['green']*3}\n{SEP}\n"
                f"{E['money']}  <b>{symbol}</b>\n"
                f"{E['up']}  <b>BUY</b>     {label}\n{SEP}\n"
                f"{E['target']}  Entry  :  <b>{_fmt_price(symbol, entry)}</b>\n"
                f"{E['stop']}  SL     :  {_fmt_price(symbol, sl)}\n"
                f"{E['check']}  TP1    :  {_fmt_price(symbol, tp1)}  (1:{cfg.tp1_ratio:.1f})\n"
                f"{E['check']}  TP2    :  {_fmt_price(symbol, tp2)}  (1:{cfg.rr_ratio:.1f})\n"
                f"{E['ruler']}  R : R  :  1 : {cfg.rr_ratio:.1f}\n{SEP}\n"
                f"{E['clock']}  {now}"
            )
        else:
            msg = (
                f"{E['red']*3}  <b>S E L L  S I G N A L</b>  {E['red']*3}\n{SEP}\n"
                f"{E['money']}  <b>{symbol}</b>\n"
                f"{E['down']}  <b>SELL</b>   {label}\n{SEP}\n"
                f"{E['target']}  Entry  :  <b>{_fmt_price(symbol, entry)}</b>\n"
                f"{E['stop']}  SL     :  {_fmt_price(symbol, sl)}\n"
                f"{E['check']}  TP1    :  {_fmt_price(symbol, tp1)}  (1:{cfg.tp1_ratio:.1f})\n"
                f"{E['check']}  TP2    :  {_fmt_price(symbol, tp2)}  (1:{cfg.rr_ratio:.1f})\n"
                f"{E['ruler']}  R : R  :  1 : {cfg.rr_ratio:.1f}\n{SEP}\n"
                f"{E['clock']}  {now}"
            )

        return SignalResult(
            symbol=symbol,
            trend=trend,
            entry=entry,
            sl=sl,
            tp1=tp1,
            tp2=tp2,
            score=score,
            message_html=msg,
            direction=direction,
        )

    def latest_m5_bar(self, symbol: str) -> str | None:
        m5 = self.data.get_ohlcv(symbol, "M5")
        if m5.empty:
            return None
        return str(m5.index[-1])
