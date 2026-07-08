"""Technical indicators and structure helpers (ported from MQ5 v5)."""

from __future__ import annotations

import numpy as np
import pandas as pd


def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


def sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(period).mean()


def rsi(series: pd.Series, period: int) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def macd_line_signal(
    close: pd.Series, fast: int, slow: int, signal: int
) -> tuple[pd.Series, pd.Series]:
    ema_fast = ema(close, fast)
    ema_slow = ema(close, slow)
    macd = ema_fast - ema_slow
    sig = ema(macd, signal)
    return macd, sig


def atr(df: pd.DataFrame, period: int) -> pd.Series:
    high, low, close = df["high"], df["low"], df["close"]
    prev_close = close.shift(1)
    tr = pd.concat(
        [
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr.rolling(period).mean()


def adx(df: pd.DataFrame, period: int) -> pd.Series:
    high, low, close = df["high"], df["low"], df["close"]
    up = high.diff()
    down = -low.diff()
    plus_dm = np.where((up > down) & (up > 0), up, 0.0)
    minus_dm = np.where((down > up) & (down > 0), down, 0.0)
    tr = atr(df, period)
    plus_di = 100 * pd.Series(plus_dm, index=df.index).rolling(period).mean() / tr
    minus_di = 100 * pd.Series(minus_dm, index=df.index).rolling(period).mean() / tr
    dx = (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan) * 100
    return dx.rolling(period).mean()


def bias_vs_ma(close: float, ma: float) -> int:
    if np.isnan(ma):
        return 0
    if close > ma:
        return 1
    if close < ma:
        return -1
    return 0


def golden_death_cross(fast: pd.Series, slow: pd.Series) -> int:
    if len(fast) < 3:
        return 0
    f0, f1 = fast.iloc[-2], fast.iloc[-3]
    s0, s1 = slow.iloc[-2], slow.iloc[-3]
    if f1 <= s1 and f0 > s0:
        return 1
    if f1 >= s1 and f0 < s0:
        return -1
    return 0


def swing_hl(h1: pd.DataFrame, lookback: int) -> tuple[float, float] | None:
    if len(h1) < lookback + 2:
        return None
    window = h1.iloc[-(lookback + 1) : -1]
    return float(window["high"].max()), float(window["low"].min())


def fib_zone(price: float, sw_h: float, sw_l: float, trend: int) -> bool:
    r = sw_h - sw_l
    if r <= 0:
        return False
    if trend == 1:
        a, b = sw_h - 0.618 * r, sw_h - 0.500 * r
    else:
        a, b = sw_l + 0.500 * r, sw_l + 0.618 * r
    return a <= price <= b


def two_fractals(h1: pd.DataFrame, find_highs: bool, wing: int, lookback: int):
    total = lookback + 2 * wing + 2
    if len(h1) < total:
        return None
    data = h1.iloc[-total:]
    found = []
    for i in range(wing, len(data) - wing):
        c = data["high"].iloc[i] if find_highs else data["low"].iloc[i]
        ok = True
        for k in range(1, wing + 1):
            prev = data["high" if find_highs else "low"].iloc[i + k]
            nxt = data["high" if find_highs else "low"].iloc[i - k]
            if find_highs:
                if c < prev or c < nxt:
                    ok = False
                    break
            else:
                if c > prev or c > nxt:
                    ok = False
                    break
        if ok:
            found.append((i, c))
        if len(found) == 2:
            break
    if len(found) < 2:
        return None
    return found[0], found[1]


def trendline_ok(h1: pd.DataFrame, trend: int, wing: int, lookback: int) -> int:
    if trend == 1:
        fr = two_fractals(h1, False, wing, lookback)
        if not fr:
            return 0
        (i1, p1), (i2, p2) = fr
        if i2 == i1:
            return 0
        slope = (p1 - p2) / (i2 - i1)
        level = p1 + slope * (i1 - 1)
        return 1 if h1["low"].iloc[-2] >= level * 0.999 else 0
    if trend == -1:
        fr = two_fractals(h1, True, wing, lookback)
        if not fr:
            return 0
        (i1, p1), (i2, p2) = fr
        if i2 == i1:
            return 0
        slope = (p1 - p2) / (i2 - i1)
        level = p1 + slope * (i1 - 1)
        return -1 if h1["high"].iloc[-2] <= level * 1.001 else 0
    return 0


def rsi_signal(rsi_s: pd.Series, oversold: int, overbought: int, soft: int) -> int:
    if len(rsi_s) < 3:
        return 0
    val, r1 = rsi_s.iloc[-2], rsi_s.iloc[-3]
    if r1 < oversold and val >= oversold:
        return 1
    if r1 > overbought and val <= overbought:
        return -1
    if val < oversold + soft:
        return 1
    if val > overbought - soft:
        return -1
    return 0


def macd_signal(macd: pd.Series, sig: pd.Series) -> int:
    if len(macd) < 3:
        return 0
    m0, m1 = macd.iloc[-2], macd.iloc[-3]
    s0, s1 = sig.iloc[-2], sig.iloc[-3]
    if m1 <= s1 and m0 > s0:
        return 1
    if m1 >= s1 and m0 < s0:
        return -1
    h0, h1 = m0 - s0, m1 - s1
    if h0 > 0 and h0 > h1:
        return 1
    if h0 < 0 and h0 < h1:
        return -1
    return 0


def ema_cross(fast: pd.Series, slow: pd.Series) -> int:
    if len(fast) < 3:
        return 0
    f0, f1 = fast.iloc[-2], fast.iloc[-3]
    s0, s1 = slow.iloc[-2], slow.iloc[-3]
    if f1 <= s1 and f0 > s0:
        return 1
    if f1 >= s1 and f0 < s0:
        return -1
    if f0 > s0:
        return 1
    if f0 < s0:
        return -1
    return 0


def amd_signal(m15: pd.DataFrame, trend: int, atr_v: float, cfg) -> int:
    if not cfg.amd_enable or atr_v <= 0 or len(m15) < cfg.amd_accum_bars + 3:
        return 0
    accum = m15.iloc[-(cfg.amd_accum_bars + 2) : -2]
    amd_h, amd_l = accum["high"].max(), accum["low"].min()
    if amd_h - amd_l >= atr_v * cfg.amd_atr_ratio:
        return 0
    bar = m15.iloc[-2]
    o, h, l, c = bar["open"], bar["high"], bar["low"], bar["close"]
    rng = h - l
    if rng <= 0:
        return 0
    if trend == 1 and l < amd_l and c >= amd_l:
        if (min(o, c) - l) / rng >= cfg.amd_wick_ratio:
            return 1
    if trend == -1 and h > amd_h and c <= amd_h:
        if (h - max(o, c)) / rng >= cfg.amd_wick_ratio:
            return -1
    return 0


def structural_sl(h1: pd.DataFrame, trend: int, entry: float, atr_v: float, cfg) -> float:
    buffer = atr_v * 0.3
    lookback = cfg.swing_lookback
    if trend == 1:
        swing_low = float(h1["low"].iloc[-lookback - 1 : -1].min())
        sl = swing_low - buffer
        if sl < entry and (entry - sl) <= atr_v * 3.0:
            return sl
        return entry - atr_v * cfg.sl_atr_mult
    swing_high = float(h1["high"].iloc[-lookback - 1 : -1].max())
    sl = swing_high + buffer
    if sl > entry and (sl - entry) <= atr_v * 3.0:
        return sl
    return entry + atr_v * cfg.sl_atr_mult
