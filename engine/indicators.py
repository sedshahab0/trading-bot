"""Technical indicators and structure helpers (ported from MQ5 v5)."""

from __future__ import annotations

import numpy as np
import pandas as pd


def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


def sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(period).mean()


def rsi(series: pd.Series, period: int) -> pd.Series:
    # Wilder's RSI (the standard used by TradingView / MT4 / MT5), so the
    # values here match what a follower sees on their own chart. Wilder's
    # smoothing is an EMA with alpha = 1/period; the earlier version used a
    # simple rolling mean (Cutler's RSI), which produced different numbers
    # and made the 32/68 thresholds not correspond to any real platform.
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
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
    # Proper Wilder ADX (matches TradingView / MT4 / MT5), so the ADX gates
    # (D1 >= 22, M15 >= 20) correspond to real platform ADX values. The
    # earlier version used simple rolling means throughout, which is a rough
    # approximation whose numbers didn't map to any real ADX reading.
    # Wilder smoothing = EMA with alpha = 1/period, applied to +DM, -DM and
    # True Range, then to DX itself. atr() (a simple mean) is deliberately
    # NOT reused here so the DI ratio uses the same Wilder-smoothed TR.
    high, low, close = df["high"], df["low"], df["close"]
    up = high.diff()
    down = -low.diff()
    plus_dm = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=df.index)
    minus_dm = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=df.index)
    prev_close = close.shift(1)
    tr = pd.concat(
        [high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1
    ).max(axis=1)

    def _wilder(s: pd.Series) -> pd.Series:
        return s.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()

    atr_w = _wilder(tr)
    plus_di = 100 * _wilder(plus_dm) / atr_w
    minus_di = 100 * _wilder(minus_dm) / atr_w
    dx = (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan) * 100
    return _wilder(dx)


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


def volatility_regime(
    atr_series: pd.Series, lookback: int, minimum: float, maximum: float
) -> tuple[bool, float]:
    """Check the latest closed ATR against its recent average."""
    closed = atr_series.iloc[:-1].dropna()
    if len(closed) < lookback:
        return False, float("nan")
    current = float(closed.iloc[-1])
    baseline = float(closed.iloc[-lookback:].mean())
    if baseline <= 0:
        return False, float("nan")
    ratio = current / baseline
    return minimum <= ratio <= maximum, ratio


def directional_candle(df: pd.DataFrame, trend: int, min_body_ratio: float) -> bool:
    """Require the latest closed candle to have directional conviction."""
    if len(df) < 2:
        return False
    bar = df.iloc[-2]
    candle_range = float(bar["high"] - bar["low"])
    if candle_range <= 0:
        return False
    body = float(bar["close"] - bar["open"])
    if abs(body) / candle_range < min_body_ratio:
        return False
    return body > 0 if trend == 1 else body < 0


# ─────────────────────────────────────────────────────────────────────
# Ported from SignalBot_MultiIndicator_MT5.mq5 v6.x ("NEW 1" through
# "NEW 11" institutional/SMC filters). All shift math below uses this
# file's existing convention: iloc[-2] is the latest fully CLOSED bar
# (== mq5 shift 1, since iloc[-1] may still be an in-progress bar);
# mq5 shift s therefore maps to iloc[-(s + 1)].


def _shift(df: pd.DataFrame, s: int) -> pd.Series:
    return df.iloc[-(s + 1)]


def kill_zone(hour: int, cfg) -> tuple[bool, str]:
    """mq5 'NEW 1': London / New York / London-Close kill zones (UTC hour)."""
    if not cfg.kill_zone_enable:
        return True, "Session"
    if cfg.lkz_start <= hour < cfg.lkz_end:
        return True, "London KZ"
    if cfg.nykz_start <= hour < cfg.nykz_end:
        return True, "New York KZ"
    if cfg.lckz_start <= hour < cfg.lckz_end:
        return True, "London Close KZ"
    return False, ""


def news_blackout(now_hour: int, now_minute: int, cfg) -> bool:
    """mq5 'NEW 8': manual HHMM blackout windows, +/- buffer minutes."""
    if not cfg.news_blackout_enable:
        return False
    now_mins = now_hour * 60 + now_minute
    for hhmm in cfg.news_times:
        if not hhmm:
            continue
        event_mins = (hhmm // 100) * 60 + (hhmm % 100)
        if abs(now_mins - event_mins) <= cfg.news_buffer_mins:
            return True
    return False


def liquidity_sweep(m15: pd.DataFrame, trend: int, lookback: int, wick_ratio: float) -> bool:
    """mq5 'NEW 2': wick sweeps a recent M15 swing level then closes back
    on the right side of it — a rejection, not a breakout."""
    if len(m15) < lookback + 2:
        return False
    window = m15.iloc[-(lookback + 1) : -2]
    if window.empty:
        return False
    swing_low = float(window["low"].min())
    swing_high = float(window["high"].max())
    bar = _shift(m15, 1)
    o, h, l, c = float(bar["open"]), float(bar["high"]), float(bar["low"]), float(bar["close"])
    rng = h - l
    if rng <= 0:
        return False
    if trend == 1:
        if l >= swing_low or c <= swing_low:
            return False
        wick = swing_low - l
        return (wick / rng) >= wick_ratio
    if h <= swing_high or c >= swing_high:
        return False
    wick = h - swing_high
    return (wick / rng) >= wick_ratio


def fair_value_gap(h1: pd.DataFrame, trend: int, lookback: int) -> bool:
    """mq5 'NEW 3': 3-candle imbalance (FVG) that price is currently inside
    and that hasn't since been fully mitigated (closed through)."""
    n = lookback + 2
    if len(h1) < n + 1:
        return False
    price = float(_shift(h1, 1)["close"])
    for i in range(2, lookback + 1):
        if len(h1) < i + 2:
            break
        prev_bar = _shift(h1, i + 1)
        next_bar = _shift(h1, i - 1)
        h_prev, l_prev = float(prev_bar["high"]), float(prev_bar["low"])
        h_next, l_next = float(next_bar["high"]), float(next_bar["low"])
        if trend == 1:
            if h_prev < l_next:
                z_low, z_high = h_prev, l_next
                filled = any(
                    float(_shift(h1, j)["close"]) < z_low for j in range(1, i - 1)
                )
                if filled:
                    continue
                if z_low <= price <= z_high:
                    return True
        else:
            if l_prev > h_next:
                z_low, z_high = h_next, l_prev
                filled = any(
                    float(_shift(h1, j)["close"]) > z_high for j in range(1, i - 1)
                )
                if filled:
                    continue
                if z_low <= price <= z_high:
                    return True
    return False


def _first_swing(h1: pd.DataFrame, find_highs: bool, wing: int, lookback: int) -> float | None:
    """Most recent H1 fractal swing point (single one, not a pair)."""
    total = lookback + wing
    if len(h1) < total + wing + 1:
        return None
    for i in range(wing, total):
        col = "high" if find_highs else "low"
        c = float(_shift(h1, i)[col])
        ok = True
        for k in range(1, wing + 1):
            prev = float(_shift(h1, i + k)[col])
            nxt = float(_shift(h1, i - k)[col])
            if find_highs:
                if c < prev or c < nxt:
                    ok = False
                    break
            else:
                if c > prev or c > nxt:
                    ok = False
                    break
        if ok:
            return c
    return None


def choch_bos(h1: pd.DataFrame, trend: int, wing: int, lookback: int) -> tuple[int, bool]:
    """mq5 'NEW 4': break of the last H1 swing point in the trend direction
    (BOS, +confluence) vs. a break AGAINST it (CHoCH — rejects the signal
    outright, same as mq5's `if(chaoch) return;`)."""
    last_swing_h = _first_swing(h1, True, wing, lookback)
    last_swing_l = _first_swing(h1, False, wing, lookback)
    close = float(_shift(h1, 1)["close"])
    if trend == 1:
        if last_swing_h is not None and close > last_swing_h:
            return 1, False
        if last_swing_l is not None and close < last_swing_l:
            return 0, True
    else:
        if last_swing_l is not None and close < last_swing_l:
            return -1, False
        if last_swing_h is not None and close > last_swing_h:
            return 0, True
    return 0, False


def premium_discount(htf: pd.DataFrame, h1_close: float, trend: int, lookback: int) -> bool:
    """mq5 'NEW 5': BUY only in the lower half (discount) and SELL only in
    the upper half (premium) of a higher-timeframe (H4) range."""
    if len(htf) < lookback + 1:
        return True
    window = htf.iloc[-(lookback + 1) : -1]
    range_high = float(window["high"].max())
    range_low = float(window["low"].min())
    mid = (range_high + range_low) / 2.0
    if trend == 1:
        return h1_close <= mid
    return h1_close >= mid


def rsi_divergence(m15: pd.DataFrame, rsi_s: pd.Series, trend: int, lookback: int) -> tuple[int, str]:
    """mq5 'NEW 6': regular (reversal) / hidden (continuation) RSI divergence
    against recent M15 swing lows (bullish) or highs (bearish)."""
    n = lookback + 2
    if len(m15) < n or len(rsi_s) < n:
        return 0, ""

    def val_at(series_or_df, shift, col=None):
        row = _shift(series_or_df, shift)
        return float(row[col]) if col else float(row)

    if trend == 1:
        found = []
        for i in range(2, n - 2):
            p = val_at(m15, i, "low")
            p_next = val_at(m15, i + 1, "low")
            p_prev = val_at(m15, i - 1, "low")
            if p < p_next and p < p_prev:
                found.append((p, val_at(rsi_s, i)))
                if len(found) == 2:
                    break
        if len(found) < 2:
            return 0, ""
        (p1, r1), (p2, r2) = found
        if p1 < p2 and r1 > r2:
            return 1, "regular"
        if p1 > p2 and r1 < r2:
            return 1, "hidden"
        return 0, ""
    else:
        found = []
        for i in range(2, n - 2):
            p = val_at(m15, i, "high")
            p_next = val_at(m15, i + 1, "high")
            p_prev = val_at(m15, i - 1, "high")
            if p > p_next and p > p_prev:
                found.append((p, val_at(rsi_s, i)))
                if len(found) == 2:
                    break
        if len(found) < 2:
            return 0, ""
        (p1, r1), (p2, r2) = found
        if p1 > p2 and r1 < r2:
            return -1, "regular"
        if p1 < p2 and r1 > r2:
            return -1, "hidden"
        return 0, ""


def order_block(h1: pd.DataFrame, trend: int, lookback: int, impulse_atr_mult: float, atr_v: float) -> bool:
    """mq5 'NEW 7': last opposite-color H1 candle before a strong impulse
    move, still unmitigated, that current price is pulling back into."""
    if atr_v <= 0 or len(h1) < lookback + 2:
        return False
    price = float(_shift(h1, 1)["close"])
    for i in range(3, lookback + 1):
        imp = _shift(h1, i - 1)
        o_imp, c_imp = float(imp["open"]), float(imp["close"])
        impulse = abs(c_imp - o_imp)
        if impulse < atr_v * impulse_atr_mult:
            continue
        ob = _shift(h1, i)
        ob_o, ob_c = float(ob["open"]), float(ob["close"])
        if trend == 1 and c_imp > o_imp and ob_c <= ob_o:
            z_low, z_high = min(ob_o, ob_c), max(ob_o, ob_c)
            mitigated = any(float(_shift(h1, j)["close"]) < z_low for j in range(1, i))
            if mitigated:
                continue
            if z_low <= price <= z_high:
                return True
        elif trend == -1 and c_imp < o_imp and ob_c >= ob_o:
            z_low, z_high = min(ob_o, ob_c), max(ob_o, ob_c)
            mitigated = any(float(_shift(h1, j)["close"]) > z_high for j in range(1, i))
            if mitigated:
                continue
            if z_low <= price <= z_high:
                return True
    return False


def candle_pattern(m15: pd.DataFrame, trend: int, pin_wick_ratio: float) -> int:
    """mq5 'NEW 9': engulfing / pin bar / inside-bar on the last closed M15
    candle. Separate from (and additive to) the existing body-ratio
    `directional_candle` gate."""
    if len(m15) < 3:
        return 0
    b1, b2 = _shift(m15, 1), _shift(m15, 2)
    o1, c1, h1v, l1 = float(b1["open"]), float(b1["close"]), float(b1["high"]), float(b1["low"])
    o2, c2, h2, l2 = float(b2["open"]), float(b2["close"]), float(b2["high"]), float(b2["low"])
    rng1 = h1v - l1
    if rng1 <= 0:
        return 0
    body1 = abs(c1 - o1)

    if trend == 1 and c2 < o2 and c1 > o1 and c1 > o2 and o1 < c2:
        return 1
    if trend == -1 and c2 > o2 and c1 < o1 and c1 < o2 and o1 > c2:
        return -1

    if trend == 1:
        lower_wick = min(o1, c1) - l1
        if rng1 > 0 and lower_wick / rng1 >= pin_wick_ratio and body1 / rng1 <= 0.3:
            return 1
    if trend == -1:
        upper_wick = h1v - max(o1, c1)
        if rng1 > 0 and upper_wick / rng1 >= pin_wick_ratio and body1 / rng1 <= 0.3:
            return -1

    if h1v < h2 and l1 > l2:
        return trend
    return 0


def dxy_aligned(symbol: str, trend: int, dxy_close: float | None, dxy_ma: float | None) -> bool:
    """mq5 'NEW 11': DXY correlation. Dollar-positive pairs (USD base, e.g.
    USD/JPY): BUY needs DXY bullish. Dollar-negative pairs (USD quote, e.g.
    EUR/USD, XAU/USD): BUY needs DXY bearish. Fails OPEN (True) if DXY data
    is unavailable — same fail-safe pattern mq5 uses when it can't resolve
    a DXY symbol on the broker."""
    if dxy_close is None or dxy_ma is None or dxy_close <= 0:
        return True
    normalized = symbol.replace("/", "").upper()
    usd_base = normalized.startswith("USD")
    usd_quote = normalized.endswith("USD") and not usd_base
    if not usd_base and not usd_quote:
        return True
    dxy_bull = dxy_close > dxy_ma
    if usd_base:
        return dxy_bull if trend == 1 else not dxy_bull
    return (not dxy_bull) if trend == 1 else dxy_bull


def volatility_spike(
    m5: pd.DataFrame, lookback: int, mult: float
) -> tuple[bool, int]:
    """mq5 'v6.12 B' Spike Circuit Breaker, adapted for a poll-based (not
    tick-based) engine: mq5 checks the live, still-forming M5 candle every
    tick; this bot only sees a bar once it closes, so this checks the range
    of the LAST CLOSED M5 bar against the average range of the preceding
    `lookback` closed bars. Returns (spike_detected, direction)."""
    if len(m5) < lookback + 2:
        return False, 0
    bar = m5.iloc[-2]
    cur_range = float(bar["high"] - bar["low"])
    window = m5.iloc[-(lookback + 2) : -2]
    avg_range = float((window["high"] - window["low"]).mean())
    if avg_range <= 0:
        return False, 0
    if cur_range < avg_range * mult:
        return False, 0
    direction = 1 if bar["close"] > bar["open"] else (-1 if bar["close"] < bar["open"] else 0)
    return True, direction


def cot_bias(symbol: str, overrides: str) -> int:
    """mq5 'v6.13 Fix 4c' COT Positioning — manual weekly input, same
    honest limitation as mq5: real-time CFTC data has no API and is
    published weekly; this just parses a user-maintained override string
    like 'EURUSD:1,GBPUSD:-1,XAUUSD:0'."""
    if not overrides:
        return 0
    normalized = symbol.replace("/", "").upper()
    for part in overrides.split(","):
        part = part.strip()
        if ":" not in part:
            continue
        sym, _, val = part.partition(":")
        if sym.strip().upper() == normalized:
            try:
                return int(val.strip())
            except ValueError:
                return 0
    return 0


def _usd_exposure_long(symbol: str, trend: int) -> bool | None:
    normalized = symbol.replace("/", "").upper()
    usd_base = normalized.startswith("USD")
    usd_quote = normalized.endswith("USD") and not usd_base
    if not usd_base and not usd_quote:
        return None
    return trend == 1 if usd_base else trend == -1


def count_correlated_usd_exposure(
    symbol: str,
    trend: int,
    recent_signals: dict[str, tuple],
    now: float,
    window_secs: int,
) -> int:
    """mq5 'NEW' portfolio correlation cap, adapted for a signal-only bot:
    mq5 counts currently OPEN same-direction USD-exposure positions across
    the account; this bot never holds positions, so the closest true
    equivalent is same-direction USD-exposure signals sent to OTHER symbols
    within the last `window_secs`. `recent_signals` values are
    (timestamp, direction, entry) — entry is unused here."""
    new_usd_long = _usd_exposure_long(symbol, trend)
    if new_usd_long is None:
        return 0
    count = 0
    for sym, record in recent_signals.items():
        ts, sig_trend = record[0], record[1]
        if sym == symbol or not ts or (now - ts) > window_secs:
            continue
        usd_long = _usd_exposure_long(sym, sig_trend)
        if usd_long is not None and usd_long == new_usd_long:
            count += 1
    return count
