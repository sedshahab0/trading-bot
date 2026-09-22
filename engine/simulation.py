"""Persist and evaluate hypothetical signal trades against real M5 candles."""

from __future__ import annotations

import ast
import hashlib
import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd


ALGORITHM_VERSION = 5
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
    def __init__(self, db_path: str, *, expiry_hours: int = 72, cost_r: float = 0.03):
        self.db_path = Path(db_path)
        self.expiry_hours = expiry_hours
        self.cost_r = max(0.0, float(cost_r))
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
                    algorithm_version INTEGER NOT NULL DEFAULT 1,
                    data_quality TEXT NOT NULL DEFAULT 'legacy',
                    first_bar_time TEXT,
                    gross_r_multiple REAL,
                    cost_r REAL NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                )
            """)
            existing = {row[1] for row in conn.execute("PRAGMA table_info(simulated_trades)")}
            migrations = {
                "algorithm_version": "INTEGER NOT NULL DEFAULT 1",
                "data_quality": "TEXT NOT NULL DEFAULT 'legacy'",
                "first_bar_time": "TEXT",
                "gross_r_multiple": "REAL",
                "cost_r": "REAL NOT NULL DEFAULT 0",
                "confluence": "TEXT",
            }
            for column, definition in migrations.items():
                if column not in existing:
                    conn.execute(f"ALTER TABLE simulated_trades ADD COLUMN {column} {definition}")
            conn.execute("""
                CREATE TABLE IF NOT EXISTS simulation_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_sim_symbol_active ON simulated_trades(symbol, active)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_sim_time ON simulated_trades(signal_time DESC)")
            current = conn.execute(
                "SELECT value FROM simulation_meta WHERE key='algorithm_version'"
            ).fetchone()
            if not current or int(current[0]) < ALGORITHM_VERSION:
                # Historical outcomes are immutable. Resetting them when the
                # evaluator changes can silently rewrite the track record.
                conn.execute(
                    "INSERT OR REPLACE INTO simulation_meta(key, value) VALUES('algorithm_version', ?)",
                    (str(ALGORITHM_VERSION),),
                )

    @staticmethod
    def _canonical_parts(signal: dict) -> tuple[str, str, str, str]:
        signal_time = _utc(
            signal.get("timestamp") or signal.get("received_at") or signal.get("signal_time")
        )
        ts = signal_time.replace(microsecond=0).isoformat() if signal_time else ""
        symbol = str(signal.get("symbol", "")).replace("/", "").upper()
        direction = str(signal.get("direction", "")).upper()
        entry = _number(signal.get("entry"))
        if entry is None:
            entry_s = ""
        elif abs(entry) >= 10:
            entry_s = f"{round(entry, 2):.2f}"
        else:
            entry_s = f"{round(entry, 5):.5f}"
        return ts, symbol, direction, entry_s

    @staticmethod
    def trade_id(signal: dict) -> str:
        # Live runner timestamps have microseconds and "XAU/USD"; signal_log
        # replay has whole seconds and "XAUUSD". Hash the canonical form so
        # both paths land on one row and INSERT OR IGNORE actually dedupes.
        raw = "|".join(SimulationTracker._canonical_parts(signal))
        return hashlib.sha256(raw.encode()).hexdigest()[:20]

    def _dedupe_key(self, signal: dict, signal_time: datetime) -> str:
        return self.trade_id({**signal, "timestamp": signal_time})

    @staticmethod
    def _row_quality(row: sqlite3.Row | dict) -> tuple:
        get = row.__getitem__
        bars = int(get("bars_seen") or 0)
        status = str(get("status") or "")
        evaluated = 2 if status in ("sl", "tp1", "tp2") else (1 if bars > 0 else 0)
        return (evaluated, bars, 0 if status == "open" else 1)

    def migrate_legacy_ids(self, *, dry_run: bool = False) -> dict:
        """Remap historical rows onto the canonical id. Merges duplicates
        created by the old timestamp/symbol/entry hashing, keeping the
        evaluated outcome (more bars / sl|tp2) over the empty replay ghost."""
        with self._connect() as conn:
            rows = list(conn.execute("SELECT * FROM simulated_trades"))
            groups: dict[str, list] = {}
            for row in rows:
                payload = {k: row[k] for k in row.keys()}
                payload["timestamp"] = payload.get("signal_time")
                new_id = self.trade_id(payload)
                groups.setdefault(new_id, []).append((new_id, row))

            merges = []
            renames = []
            unchanged = 0
            for new_id, members in groups.items():
                ranked = sorted(members, key=lambda item: self._row_quality(item[1]), reverse=True)
                winner = ranked[0][1]
                losers = [item[1] for item in ranked[1:]]
                if winner["id"] == new_id and not losers:
                    unchanged += 1
                    continue
                merges.append(
                    {
                        "new_id": new_id,
                        "keep": winner["id"],
                        "drop": [row["id"] for row in losers],
                        "symbol": winner["symbol"],
                        "direction": winner["direction"],
                        "signal_time": winner["signal_time"],
                        "keep_status": winner["status"],
                        "keep_bars": winner["bars_seen"],
                        "drop_status": [row["status"] for row in losers],
                    }
                )
                if not dry_run:
                    for loser in losers:
                        conn.execute("DELETE FROM simulated_trades WHERE id=?", (loser["id"],))
                    if winner["id"] != new_id:
                        taken = conn.execute(
                            "SELECT id FROM simulated_trades WHERE id=?", (new_id,)
                        ).fetchone()
                        if taken:
                            conn.execute("DELETE FROM simulated_trades WHERE id=?", (new_id,))
                        conn.execute(
                            "UPDATE simulated_trades SET id=? WHERE id=?",
                            (new_id, winner["id"]),
                        )
                        renames.append((winner["id"], new_id))

            return {
                "total": len(rows),
                "unchanged": unchanged,
                "merge_groups": len(merges),
                "dropped": sum(len(item["drop"]) for item in merges),
                "renames": len(renames) if not dry_run else sum(
                    1 for item in merges if item["keep"] != item["new_id"]
                ),
                "resulting": len(rows) - sum(len(item["drop"]) for item in merges),
                "merges": merges,
            }

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
        valid_structure = (
            sl < entry < tp1 and (tp2 is None or tp1 <= tp2)
            if direction == "BUY"
            else sl > entry > tp1 and (tp2 is None or tp1 >= tp2)
        )
        status = "open" if valid_structure else "invalid"
        active = int(valid_structure)
        quality = "pending" if valid_structure else "invalid_levels"
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as conn:
            conn.execute("""
                INSERT OR IGNORE INTO simulated_trades
                    (id, signal_time, symbol, direction, entry, sl, tp1, tp2, score,
                     status, active, algorithm_version, data_quality, cost_r, confluence, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                self._dedupe_key(signal, signal_time),
                signal_time.isoformat(), symbol, direction, entry, sl, tp1, tp2,
                int(signal.get("score") or 0), status, active,
                ALGORITHM_VERSION, quality, self.cost_r, str(signal.get("confluence") or ""), now,
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

    def evaluate_symbol(
        self, symbol: str, candles: pd.DataFrame, *, now: datetime | None = None
    ) -> int:
        if candles is None or candles.empty:
            return 0
        normalized = symbol.replace("/", "").upper()
        frame = candles.sort_index().copy()
        if frame.index.tz is None:
            frame.index = frame.index.tz_localize("UTC")
        else:
            frame.index = frame.index.tz_convert("UTC")
        current_bar = pd.Timestamp(now or datetime.now(timezone.utc)).floor("5min")
        # The provider includes the currently forming candle. If it is marked as
        # seen, later TP/SL touches in that same candle are skipped forever.
        frame = frame[frame.index < current_bar]
        if frame.empty:
            return 0
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
        # Signals are emitted after an M5 candle closes. Starting from the next
        # complete bar prevents pre-signal high/low data from leaking into replay.
        first_full_bar = pd.Timestamp(opened).floor("5min") + pd.Timedelta(minutes=5)
        eligible = frame[frame.index >= first_full_bar]
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
        first_bar_time = trade["first_bar_time"]
        gross_r_multiple = trade["gross_r_multiple"]

        for ts, bar in eligible.iterrows():
            open_price = float(bar["open"])
            high, low, close = float(bar["high"]), float(bar["low"]), float(bar["close"])
            stamp = pd.Timestamp(ts).tz_convert("UTC").isoformat()
            first_bar_time = first_bar_time or stamp
            if pd.Timestamp(ts).to_pydatetime() - opened >= timedelta(hours=self.expiry_hours):
                raw_r = (
                    (open_price - entry) / risk
                    if direction == "BUY"
                    else (entry - open_price) / risk
                )
                r_multiple = round(raw_r, 3)
                status, active, closed_at, close_reason, exit_price = (
                    "expired", False, stamp, "expired_at_bar_open", open_price,
                )
                break
            favorable = (high - entry) / risk if direction == "BUY" else (entry - low) / risk
            adverse = (entry - low) / risk if direction == "BUY" else (high - entry) / risk
            mfe_r, mae_r = max(mfe_r, favorable), max(mae_r, adverse)
            bars_seen += 1
            sl_hit = low <= sl if direction == "BUY" else high >= sl
            tp2_hit = bool(tp2) and (high >= tp2 if direction == "BUY" else low <= tp2)

            # Donchian strategy runs the FULL position to the target — no
            # partial at TP1, no breakeven move. So each trade resolves
            # cleanly to its ~2R target or its ~1R stop, whichever hits
            # first (matching the validated backtest's exit).
            if status == "open":
                if sl_hit and tp2_hit:
                    # both touched in the same bar — assume the stop hit first
                    ambiguous = 1
                    gap_stop = open_price <= sl if direction == "BUY" else open_price >= sl
                    actual_exit = open_price if gap_stop else sl
                    actual_r = (
                        (actual_exit - entry) / risk
                        if direction == "BUY"
                        else (entry - actual_exit) / risk
                    )
                    status, active, closed_at, close_reason, exit_price, r_multiple = (
                        "sl", False, stamp, "same_bar_conservative",
                        actual_exit, round(actual_r, 3),
                    )
                elif sl_hit:
                    gap_stop = open_price <= sl if direction == "BUY" else open_price >= sl
                    actual_exit = open_price if gap_stop else sl
                    actual_r = (
                        (actual_exit - entry) / risk
                        if direction == "BUY"
                        else (entry - actual_exit) / risk
                    )
                    status, active, closed_at, close_reason, exit_price, r_multiple = (
                        "sl", False, stamp, "gap_stop" if gap_stop else "stop_loss",
                        actual_exit, round(actual_r, 3),
                    )
                elif tp2_hit:
                    gap_tp = open_price >= tp2 if direction == "BUY" else open_price <= tp2
                    actual_exit = open_price if gap_tp else tp2
                    actual_r = (
                        (actual_exit - entry) / risk
                        if direction == "BUY"
                        else (entry - actual_exit) / risk
                    )
                    tp2_at = stamp
                    status, active, closed_at, close_reason, exit_price, r_multiple = (
                        "tp2", False, stamp, "tp2", actual_exit, round(actual_r, 3),
                    )

            if not active:
                break

        if not active and r_multiple is not None:
            gross_r_multiple = round(float(r_multiple), 3)
            r_multiple = round(gross_r_multiple - self.cost_r, 3)

        last_time = pd.Timestamp(eligible.index[-1]).tz_convert("UTC").isoformat()
        conn.execute("""
            UPDATE simulated_trades SET
                status=?, active=?, tp1_at=?, tp2_at=?, closed_at=?, close_reason=?,
                exit_price=?, r_multiple=?, mfe_r=?, mae_r=?, bars_seen=?,
                last_bar_time=?, ambiguous=?, updated_at=?,
                algorithm_version=?, data_quality=?, first_bar_time=?,
                gross_r_multiple=?, cost_r=?
            WHERE id=?
        """, (
            status, int(active), tp1_at, tp2_at, closed_at, close_reason,
            exit_price, r_multiple, round(mfe_r, 3), round(mae_r, 3), bars_seen,
            last_time, ambiguous, datetime.now(timezone.utc).isoformat(),
            ALGORITHM_VERSION, "ambiguous" if ambiguous else "verified_m5",
            first_bar_time, gross_r_multiple, self.cost_r,
            trade["id"],
        ))
        return True
