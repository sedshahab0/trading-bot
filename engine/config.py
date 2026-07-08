import os
from dataclasses import dataclass, field


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, str(default)))
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
    send_startup_message: bool = field(
        default_factory=lambda: _env_bool("SEND_STARTUP_MESSAGE", True)
    )

    facebook_enable: bool = field(default_factory=lambda: _env_bool("FACEBOOK_ENABLE", True))
    facebook_url: str = field(
        default_factory=lambda: _env("FACEBOOK_URL", "http://127.0.0.1:5005/signal")
    )
    facebook_basis: str = field(
        default_factory=lambda: _env(
            "FACEBOOK_BASIS", "SMC Structure + Liquidity Grab + Daily Bias"
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

    session_enable: bool = True
    session_start_hour: int = 7
    session_end_hour: int = 20

    spread_enable: bool = False
    max_spread_points: int = 30

    poll_seconds: int = field(default_factory=lambda: _env_int("POLL_SECONDS", 30))
    state_file: str = field(
        default_factory=lambda: _env("ENGINE_STATE_FILE", "/opt/trading-bot/engine_state.json")
    )
    debug: bool = field(default_factory=lambda: _env_bool("ENGINE_DEBUG", False))
    notifications_paused: bool = field(
        default_factory=lambda: _env_bool("NOTIFICATIONS_PAUSED", False)
    )
