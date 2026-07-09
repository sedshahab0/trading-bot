"""Persist and evaluate hypothetical signal trades against real M5 candles."""

from __future__ import annotations

import ast
import hashlib
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd


SIGNAL_PATTERN = re.compile(r"\[(?P<ts>[^\]]+)\] Signal saved → (?P<data>.+)$")


def _number(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _utc(value) -> datetime | None:
    if not value:
        return None
    try:
        parsed = pd.Timestamp(value)
        if parsed.tzinfo is None:
            parsed = parsed.tz_localize("UTC")
        return parsed.tz_convert("UTC").to_pydatetime()
    except Exception:
        return None


class SimulationTracker:
    def __init__(self, db_path: str, *, expiry_hours: int = 72):
        self.db_path = Path(db_path)
        self.expiry_hours = expiry_hours
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=3)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS simulated_trades (
                    id TEXT PRIMARY KEY,
                    signal_time TEXT NOT NULL,
                    symbol TEXT NOT NULL,
                    direction TEXT NOT NULL,
                    entry REAL NOT NULL,
                    sl REAL NOT NULL,
                    tp1 REAL NOT NULL,
                    tp2 REAL,
                    score INTEGER,
                    status TEXT NOT NULL DEFAULT 'open',
                    active INTEGER NOT NULL DEFAULT 1,
                    tp1_at TEXT,
                    tp2_at TEXT,
                    closed_at TEXT,
                    close_reason TEXT,
                    exit_price REAL,
                    r_multiple REAL,
                    mfe_r REAL NOT NULL DEFAULT 0,
                    mae_r REAL NOT NULL DEFAULT 0,
                    bars_seen INTEGER NOT NULL DEFAULT 0,
                    last_bar_time TEXT,
                    ambiguous INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_sim_symbol_active ON simulated_trades(symbol, active)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_sim_time ON simulated_trades(signal_time DESC)")

    @staticmethod
    def trade_id(signal: dict) -> str:
        raw = "|".join(str(signal.get(key, "")) for key in ("timestamp", "symbol", "direction", "entry"))
        return hashlib.sha256(raw.encode()).hexdigest()[:20]

    def register(self, signal: dict) -> bool:
        entry = _number(signal.get("entry"))
        sl = _number(signal.get("sl"))
        tp1 = _number(signal.get("tp1") or signal.get("tp"))
        tp2 = _number(signal.get("tp2"))
        signal_time = _utc(signal.get("timestamp") or signal.get("received_at"))
        direction = str(signal.get("direction", "")).upper()
        symbol = str(signal.get("symbol", "")).replace("/", "").upper()
        if not all((entry, sl, tp1, signal_time, symbol)) or direction not in ("BUY", "SELL"):
            return False
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as conn:
            conn.execute("""
                INSERT OR IGNORE INTO simulated_trades
                    (id, signal_time, symbol, direction, entry, sl, tp1, tp2, score, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                self.trade_id({**signal, "timestamp": signal_time.isoformat()}),
                signal_time.isoformat(), symbol, direction, entry, sl, tp1, tp2,
                int(signal.get("score") or 0), now,
            ))
            return conn.total_changes > 0

    def import_signal_log(self, path: str | Path) -> int:
        source = Path(path)
        if not source.exists():
            return 0
        added = 0
        for line in source.read_text(encoding="utf-8", errors="replace").splitlines():
            match = SIGNAL_PATTERN.search(line)
            if not match:
                continue
            try:
                payload = ast.literal_eval(match.group("data"))
            except Exception:
                continue
            payload["timestamp"] = match.group("ts")
            added += int(self.register(payload))
        return added

    def evaluate_symbol(self, symbol: str, candles: pd.DataFrame) -> int:
        if candles is None or candles.empty:
            return 0
        normalized = symbol.replace("/", "").upper()
        frame = candles.sort_index()
        updates = 0
        with self._connect() as conn:
            trades = conn.execute(
                "SELECT * FROM simulated_trades WHERE symbol=? AND active=1 ORDER BY signal_time",
                (normalized,),
            ).fetchall()
            for trade in trades:
                updates += int(self._evaluate_trade(conn, trade, frame))
        return updates

    def _evaluate_trade(self, conn: sqlite3.Connection, trade: sqlite3.Row, frame: pd.DataFrame) -> bool:
        opened = _utc(trade["signal_time"])
        last_bar = _utc(trade["last_bar_time"])
        if not opened:
            return False
        eligible = frame[frame.index >= pd.Timestamp(opened)]
        if last_bar:
            eligible = eligible[eligible.index > pd.Timestamp(last_bar)]
        if eligible.empty:
            return False

        direction = trade["direction"]
        entry, sl, tp1, tp2 = trade["entry"], trade["sl"], trade["tp1"], trade["tp2"]
        risk = abs(entry - sl)
        if risk <= 0:
            return False
        status = trade["status"]
        active = bool(trade["active"])
        tp1_at, tp2_at = trade["tp1_at"], trade["tp2_at"]
        closed_at, close_reason = trade["closed_at"], trade["close_reason"]
        exit_price, r_multiple = trade["exit_price"], trade["r_multiple"]
        mfe_r, mae_r = float(trade["mfe_r"]), float(trade["mae_r"])
        ambiguous = int(trade["ambiguous"])
        bars_seen = int(trade["bars_seen"])

        for ts, bar in eligible.iterrows():
            high, low, close = float(bar["high"]), float(bar["low"]), float(bar["close"])
            favorable = (high - entry) / risk if direction == "BUY" else (entry - low) / risk
            adverse = (entry - low) / risk if direction == "BUY" else (high - entry) / risk
            mfe_r, mae_r = max(mfe_r, favorable), max(mae_r, adverse)
            bars_seen += 1
            sl_hit = low <= sl if direction == "BUY" else high >= sl
            tp1_hit = high >= tp1 if direction == "BUY" else low <= tp1
            tp2_hit = bool(tp2) and (high >= tp2 if direction == "BUY" else low <= tp2)
            stamp = pd.Timestamp(ts).tz_convert("UTC").isoformat()

            if status == "open":
                if sl_hit and (tp1_hit or tp2_hit):
                    ambiguous = 1
                    status, active, closed_at, close_reason, exit_price, r_multiple = "sl", False, stamp, "same_bar_conservative", sl, -1.0
                elif sl_hit:
                    status, active, closed_at, close_reason, exit_price, r_multiple = "sl", False, stamp, "stop_loss", sl, -1.0
                elif tp2_hit:
                    tp1_at = tp1_at or stamp
                    tp2_at = stamp
                    status, active, closed_at, close_reason, exit_price, r_multiple = "tp2", False, stamp, "tp2", tp2, 1.5
                elif tp1_hit:
                    tp1_at = stamp
                    status, r_multiple = "tp1", 0.5
            elif status == "tp1":
                if tp2_hit and sl_hit:
                    ambiguous = 1
                    status, active, closed_at, close_reason, exit_price, r_multiple = "tp1", False, stamp, "same_bar_after_tp1", sl, 0.0
                elif tp2_hit:
                    tp2_at = stamp
                    status, active, closed_at, close_reason, exit_price, r_multiple = "tp2", False, stamp, "tp2", tp2, 1.5
                elif sl_hit:
                    active, closed_at, close_reason, exit_price, r_multiple = False, stamp, "sl_after_tp1", sl, 0.0

            if not active:
                break
            if pd.Timestamp(ts).to_pydatetime() - opened >= timedelta(hours=self.expiry_hours):
                raw_r = (close - entry) / risk if direction == "BUY" else (entry - close) / risk
                if status == "tp1":
                    r_multiple = round(0.5 + 0.5 * raw_r, 3)
                else:
                    status = "expired"
                    r_multiple = round(raw_r, 3)
                active, closed_at, close_reason, exit_price = False, stamp, "expired", close
                break

        last_time = pd.Timestamp(eligible.index[-1]).tz_convert("UTC").isoformat()
        conn.execute("""
            UPDATE simulated_trades SET
                status=?, active=?, tp1_at=?, tp2_at=?, closed_at=?, close_reason=?,
                exit_price=?, r_multiple=?, mfe_r=?, mae_r=?, bars_seen=?,
                last_bar_time=?, ambiguous=?, updated_at=?
            WHERE id=?
        """, (
            status, int(active), tp1_at, tp2_at, closed_at, close_reason,
            exit_price, r_multiple, round(mfe_r, 3), round(mae_r, 3), bars_seen,
            last_time, ambiguous, datetime.now(timezone.utc).isoformat(), trade["id"],
        ))
        return True
