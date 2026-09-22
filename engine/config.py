import os
from dataclasses import dataclass, field


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, str(default)))
    except ValueError:
        return default


def _env_float(key: str, default: float) -> float:
    try:
        return float(os.environ.get(key, str(default)))
    except ValueError:
        return default


def _env_bool(key: str, default: bool) -> bool:
    val = os.environ.get(key)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class EngineConfig:
    data_provider: str = field(default_factory=lambda: _env("DATA_PROVIDER", "twelvedata"))
    twelve_data_api_key: str = field(default_factory=lambda: _env("TWELVE_DATA_API_KEY"))
    symbols: list[str] = field(
        default_factory=lambda: [
            s.strip()
            for s in _env("SYMBOLS", "EUR/USD,GBP/USD,XAU/USD").split(",")
            if s.strip()
        ]
    )

    telegram_bot_token: str = field(default_factory=lambda: _env("TELEGRAM_BOT_TOKEN"))
    telegram_chat_id: str = field(default_factory=lambda: _env("TELEGRAM_CHAT_ID"))
    telegram_ops_chat_id: str = field(default_factory=lambda: _env("TELEGRAM_OPS_CHAT_ID"))
    send_startup_message: bool = field(
        default_factory=lambda: _env_bool("SEND_STARTUP_MESSAGE", True)
    )

    facebook_enable: bool = field(default_factory=lambda: _env_bool("FACEBOOK_ENABLE", True))
    facebook_url: str = field(
        default_factory=lambda: _env("FACEBOOK_URL", "http://127.0.0.1:5005/signal")
    )
    facebook_basis: str = field(
        default_factory=lambda: _env(
            "FACEBOOK_BASIS", "Donchian Breakout · H1 Trend"
        )
    )

    weekly_ema: int = 21
    daily_ma: int = 200
    cross_fast_ma: int = 50
    cross_slow_ma: int = 200
    alert_golden_death_cross: bool = True

    h1_ema: int = 50
    swing_lookback: int = 60
    fractal_wing: int = 2

    rsi_period: int = 14
    rsi_oversold: int = 32
    rsi_overbought: int = 68
    macd_fast: int = 12
    macd_slow: int = 26
    macd_signal: int = 9

    m5_ema_fast: int = 8
    m5_ema_slow: int = 21
    m5_rsi_period: int = 9
    m5_rsi_oversold: int = 35
    m5_rsi_overbought: int = 65

    atr_period: int = 14
    sl_atr_mult: float = 1.2
    rr_ratio: float = 2.0
    tp1_ratio: float = 1.0

    # ── Donchian breakout (the live strategy) ───────────────────────────
    # Validated on gold + silver H1: PF ~1.2-1.3 across N=15..30. N=25 was
    # the best of the robust zone. SL = donchian_sl_mult * ATR; target =
    # donchian_tp_r * risk (1:2, full position to target).
    donchian_n: int = field(default_factory=lambda: _env_int("DONCHIAN_N", 25))
    donchian_trend_ema: int = field(default_factory=lambda: _env_int("DONCHIAN_TREND_EMA", 200))
    donchian_sl_mult: float = field(default_factory=lambda: _env_float("DONCHIAN_SL_MULT", 2.0))
    donchian_tp_r: float = field(default_factory=lambda: _env_float("DONCHIAN_TP_R", 2.0))
    donchian_require_trend: bool = field(
        default_factory=lambda: _env_bool("DONCHIAN_REQUIRE_TREND", True)
    )

    # Entry zone: signals fire on an M5 close and are read/acted on later
    # (seconds on Telegram, minutes-to-hours on the batched Facebook posts),
    # so the exact tick is never fillable. We publish a band around the exact
    # entry — width = this fraction of the stop distance on each side — so a
    # follower entering anywhere inside it keeps a near-identical R:R. The
    # exact entry is still shown (and still used for SL/TP math and the
    # simulation); the zone is guidance plus a "don't chase" invalidation.
    entry_zone_pct: float = field(default_factory=lambda: _env_float("ENTRY_ZONE_PCT", 0.25))

    min_score: int = field(default_factory=lambda: _env_int("MIN_SCORE", 5))
    alert_full_signal: bool = True
    cooldown_bars: int = 2

    amd_enable: bool = True
    amd_accum_bars: int = 20
    amd_atr_ratio: float = 0.6
    amd_wick_ratio: float = 0.6

    adx_enable: bool = True
    adx_period: int = 14
    adx_min_trend: float = 22.0

    # D1 ADX asks "was the daily trend strong" — that can be stale by the
    # time an M5 entry fires. This asks the same question on the execution
    # timeframe: is there real directional conviction happening *now*.
    m15_adx_enable: bool = field(default_factory=lambda: _env_bool("M15_ADX_ENABLE", True))
    m15_adx_min_trend: float = field(default_factory=lambda: _env_float("M15_ADX_MIN_TREND", 20.0))

    # Found in the 77-trade track record: the 51 straight losers averaged
    # only 0.33R of favorable excursion before reversing (max 0.28R-0.97R
    # across symbols) — they never showed real follow-through. A single
    # momentum trigger (RSI/MACD/EMA-cross agreeing with trend) is a very
    # low bar on M5/M15; requiring genuine multi-trigger confluence filters
    # out noise-driven entries that were never going anywhere.
    min_trigger_count: int = field(default_factory=lambda: _env_int("MIN_TRIGGER_COUNT", 2))

    # The SMC/institutional filters (sweep, FVG, order block, BOS) were
    # ported as score bonuses only — a trade could score well from legacy
    # indicators alone with zero structural confluence, which is exactly
    # the combination that produced the -42R track record. Requiring at
    # least one to actually be present makes them load-bearing instead of
    # decorative. Only enforced if at least one of the underlying features
    # is enabled, so it can't silently zero out signals when all four are
    # turned off.
    require_smc_confluence: bool = field(
        default_factory=lambda: _env_bool("REQUIRE_SMC_CONFLUENCE", True)
    )

    # Quality gates reject weak or late entries before scoring.
    require_weekly_alignment: bool = field(
        default_factory=lambda: _env_bool("REQUIRE_WEEKLY_ALIGNMENT", True)
    )
    require_h1_alignment: bool = field(
        default_factory=lambda: _env_bool("REQUIRE_H1_ALIGNMENT", True)
    )
    volatility_regime_enable: bool = field(
        default_factory=lambda: _env_bool("VOLATILITY_REGIME_ENABLE", True)
    )
    volatility_lookback: int = field(
        default_factory=lambda: _env_int("VOLATILITY_LOOKBACK", 20)
    )
    volatility_min_ratio: float = field(
        default_factory=lambda: _env_float("VOLATILITY_MIN_RATIO", 0.80)
    )
    volatility_max_ratio: float = field(
        default_factory=lambda: _env_float("VOLATILITY_MAX_RATIO", 1.80)
    )
    candle_confirmation_enable: bool = field(
        default_factory=lambda: _env_bool("CANDLE_CONFIRMATION_ENABLE", True)
    )
    min_trigger_body_ratio: float = field(
        default_factory=lambda: _env_float("MIN_TRIGGER_BODY_RATIO", 0.35)
    )
    max_entry_distance_atr: float = field(
        default_factory=lambda: _env_float("MAX_ENTRY_DISTANCE_ATR", 1.50)
    )
    min_stop_atr: float = field(
        default_factory=lambda: _env_float("MIN_STOP_ATR", 0.80)
    )
    max_stop_atr: float = field(
        default_factory=lambda: _env_float("MAX_STOP_ATR", 2.50)
    )

    session_enable: bool = True
    session_start_hour: int = 7
    session_end_hour: int = 20

    spread_enable: bool = False
    max_spread_points: int = 30

    # ── Ported from SignalBot_MultiIndicator_MT5.mq5 "NEW 1-11" SMC/
    # institutional filters. Each is independently toggleable and additive
    # to the existing scoring/gates above — nothing above was changed.
    kill_zone_enable: bool = field(default_factory=lambda: _env_bool("KILL_ZONE_ENABLE", True))
    lkz_start: int = field(default_factory=lambda: _env_int("LKZ_START", 7))
    lkz_end: int = field(default_factory=lambda: _env_int("LKZ_END", 9))
    nykz_start: int = field(default_factory=lambda: _env_int("NYKZ_START", 12))
    nykz_end: int = field(default_factory=lambda: _env_int("NYKZ_END", 14))
    lckz_start: int = field(default_factory=lambda: _env_int("LCKZ_START", 15))
    lckz_end: int = field(default_factory=lambda: _env_int("LCKZ_END", 16))

    news_blackout_enable: bool = field(default_factory=lambda: _env_bool("NEWS_BLACKOUT_ENABLE", True))
    news_times: list[int] = field(
        default_factory=lambda: [
            _env_int("NEWS_TIME1", 0),
            _env_int("NEWS_TIME2", 0),
            _env_int("NEWS_TIME3", 0),
            _env_int("NEWS_TIME4", 0),
        ]
    )
    news_buffer_mins: int = field(default_factory=lambda: _env_int("NEWS_BUFFER_MINS", 30))

    liquidity_sweep_enable: bool = field(default_factory=lambda: _env_bool("LIQUIDITY_SWEEP_ENABLE", True))
    liquidity_sweep_lookback: int = field(default_factory=lambda: _env_int("LIQUIDITY_SWEEP_LOOKBACK", 20))
    liquidity_sweep_wick_ratio: float = field(
        default_factory=lambda: _env_float("LIQUIDITY_SWEEP_WICK_RATIO", 0.55)
    )

    fvg_enable: bool = field(default_factory=lambda: _env_bool("FVG_ENABLE", True))
    fvg_lookback: int = field(default_factory=lambda: _env_int("FVG_LOOKBACK", 30))

    choch_enable: bool = field(default_factory=lambda: _env_bool("CHOCH_ENABLE", True))
    choch_lookback: int = field(default_factory=lambda: _env_int("CHOCH_LOOKBACK", 40))

    premium_discount_enable: bool = field(
        default_factory=lambda: _env_bool("PREMIUM_DISCOUNT_ENABLE", True)
    )
    # Backtest finding: premium/discount as a HARD gate (combined with the
    # candle-pattern gate) drove the joint pass-rate to ~0, silencing the
    # bot. It's now SCORED confluence by default, not a hard reject. Set
    # PREMIUM_DISCOUNT_GATE=1 to restore the old hard-gate behaviour.
    premium_discount_gate: bool = field(
        default_factory=lambda: _env_bool("PREMIUM_DISCOUNT_GATE", False)
    )
    premium_discount_lookback: int = field(
        default_factory=lambda: _env_int("PREMIUM_DISCOUNT_LOOKBACK", 50)
    )

    divergence_enable: bool = field(default_factory=lambda: _env_bool("DIVERGENCE_ENABLE", True))
    divergence_lookback: int = field(default_factory=lambda: _env_int("DIVERGENCE_LOOKBACK", 20))

    order_block_enable: bool = field(default_factory=lambda: _env_bool("ORDER_BLOCK_ENABLE", True))
    order_block_lookback: int = field(default_factory=lambda: _env_int("ORDER_BLOCK_LOOKBACK", 40))
    order_block_impulse_atr: float = field(
        default_factory=lambda: _env_float("ORDER_BLOCK_IMPULSE_ATR", 1.5)
    )

    candle_pattern_enable: bool = field(default_factory=lambda: _env_bool("CANDLE_PATTERN_ENABLE", True))
    # Backtest finding: the M15 candle-pattern HARD gate passed only ~19%
    # of bars and, combined with premium/discount, was the main reason the
    # bot fired ~0 signals. It's now SCORED confluence by default, not a
    # hard reject. Set CANDLE_PATTERN_GATE=1 to restore the hard-gate.
    candle_pattern_gate: bool = field(default_factory=lambda: _env_bool("CANDLE_PATTERN_GATE", False))
    candle_pattern_pin_wick_ratio: float = field(
        default_factory=lambda: _env_float("CANDLE_PATTERN_PIN_WICK_RATIO", 0.6)
    )

    # Adapted from mq5's live-position correlation cap: this bot only ever
    # sends signals (no open-position tracking), so "same-direction
    # USD-exposure position" becomes "same-direction USD-exposure signal
    # sent within the last N minutes" — the closest true equivalent.
    correlation_cap_enable: bool = field(default_factory=lambda: _env_bool("CORRELATION_CAP_ENABLE", True))
    max_correlated_signals: int = field(default_factory=lambda: _env_int("MAX_CORRELATED_SIGNALS", 2))
    correlation_window_mins: int = field(
        default_factory=lambda: _env_int("CORRELATION_WINDOW_MINS", 240)
    )

    # Re-entry guard: blocks re-firing the same direction on the same
    # symbol unless price has moved at least this many ATRs since the last
    # signal, even if the time-based cooldown has already elapsed. Added
    # after the simulation track record showed repeated same-direction
    # signals firing every ~5 minutes into a ranging market, losing
    # repeatedly without price ever meaningfully moving between them.
    reentry_guard_enable: bool = field(default_factory=lambda: _env_bool("REENTRY_GUARD_ENABLE", True))
    reentry_min_move_atr: float = field(
        default_factory=lambda: _env_float("REENTRY_MIN_MOVE_ATR", 0.5)
    )

    poll_seconds: int = field(default_factory=lambda: _env_int("POLL_SECONDS", 30))
    state_file: str = field(
        default_factory=lambda: _env("ENGINE_STATE_FILE", "/opt/trading-bot/engine_state.json")
    )
    debug: bool = field(default_factory=lambda: _env_bool("ENGINE_DEBUG", False))
    notifications_paused: bool = field(
        default_factory=lambda: _env_bool("NOTIFICATIONS_PAUSED", False)
    )

    # ── Parked mq5 features, now ported ─────────────────────────────
    dxy_enable: bool = field(default_factory=lambda: _env_bool("DXY_ENABLE", True))
    dxy_symbol: str = field(default_factory=lambda: _env("DXY_SYMBOL", "DX-Y.NYB"))
    dxy_ma_period: int = field(default_factory=lambda: _env_int("DXY_MA_PERIOD", 50))

    crisis_mode: bool = field(default_factory=lambda: _env_bool("CRISIS_MODE", False))
    crisis_sl_multiplier: float = field(default_factory=lambda: _env_float("CRISIS_SL_MULTIPLIER", 2.0))
    crisis_score_boost: int = field(default_factory=lambda: _env_int("CRISIS_SCORE_BOOST", 3))
    crisis_pairs: list[str] = field(
        default_factory=lambda: [
            s.strip().upper() for s in _env("CRISIS_PAIRS", "").split(",") if s.strip()
        ]
    )

    spike_breaker_enable: bool = field(default_factory=lambda: _env_bool("SPIKE_BREAKER_ENABLE", True))
    spike_breaker_mult: float = field(default_factory=lambda: _env_float("SPIKE_BREAKER_MULT", 2.5))
    spike_breaker_lookback: int = field(default_factory=lambda: _env_int("SPIKE_BREAKER_LOOKBACK", 10))
    spike_breaker_cooldown_mins: int = field(
        default_factory=lambda: _env_int("SPIKE_BREAKER_COOLDOWN_MINS", 30)
    )

    cot_enable: bool = field(default_factory=lambda: _env_bool("COT_ENABLE", False))
    cot_bias_overrides: str = field(default_factory=lambda: _env("COT_BIAS_OVERRIDES", ""))

    breaking_news_enable: bool = field(default_factory=lambda: _env_bool("BREAKING_NEWS_ENABLE", False))
    breaking_news_url: str = field(default_factory=lambda: _env("BREAKING_NEWS_URL", ""))
    breaking_news_keywords: str = field(
        default_factory=lambda: _env(
            "BREAKING_NEWS_KEYWORDS",
            "war,attack,strike,invasion,missile,explosion,closed,closure,emergency,"
            "martial law,coup,nuclear,military action,ceasefire collapse",
        )
    )
    breaking_news_check_mins: int = field(default_factory=lambda: _env_int("BREAKING_NEWS_CHECK_MINS", 5))
    breaking_news_cooldown_mins: int = field(
        default_factory=lambda: _env_int("BREAKING_NEWS_COOLDOWN_MINS", 60)
    )

    chart_image_enable: bool = field(default_factory=lambda: _env_bool("CHART_IMAGE_ENABLE", True))

    dup_guard_enable: bool = field(default_factory=lambda: _env_bool("DUP_GUARD_ENABLE", True))
    dup_guard_lock_file: str = field(
        default_factory=lambda: _env("DUP_GUARD_LOCK_FILE", "/var/lib/trading-bot/engine.lock")
    )
    dup_guard_stale_secs: int = field(default_factory=lambda: _env_int("DUP_GUARD_STALE_SECS", 30))
