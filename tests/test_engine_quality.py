import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from engine import indicators
from engine.simulation import ALGORITHM_VERSION, SimulationTracker


class IndicatorQualityTests(unittest.TestCase):
    def test_directional_candle_requires_body_and_direction(self):
        frame = pd.DataFrame(
            [
                {"open": 1.0, "high": 1.2, "low": 0.9, "close": 1.1},
                {"open": 1.0, "high": 1.5, "low": 0.9, "close": 1.4},
                {"open": 1.4, "high": 1.4, "low": 1.4, "close": 1.4},
            ]
        )
        self.assertTrue(indicators.directional_candle(frame, 1, 0.35))
        self.assertFalse(indicators.directional_candle(frame, -1, 0.35))

    def test_volatility_regime_uses_closed_values_only(self):
        values = pd.Series([1.0] * 20 + [1.1, 99.0])
        accepted, ratio = indicators.volatility_regime(values, 20, 0.8, 1.8)
        self.assertTrue(accepted)
        self.assertLess(ratio, 1.2)


class SimulationIntegrityTests(unittest.TestCase):
    def test_forming_candle_is_not_marked_seen(self):
        with tempfile.TemporaryDirectory() as tmp:
            tracker = SimulationTracker(str(Path(tmp) / "simulation.sqlite3"))
            tracker.register(
                {
                    "timestamp": "2026-07-10T11:59:00+00:00",
                    "symbol": "EUR/USD",
                    "direction": "BUY",
                    "entry": 1.1000,
                    "sl": 1.0990,
                    "tp1": 1.1010,
                    "tp2": 1.1020,
                    "score": 10,
                }
            )
            index = pd.DatetimeIndex(["2026-07-10T12:00:00+00:00"])
            candles = pd.DataFrame(
                [{"open": 1.1000, "high": 1.1021, "low": 1.1000, "close": 1.1015}],
                index=index,
            )

            self.assertEqual(
                tracker.evaluate_symbol(
                    "EUR/USD", candles, now=datetime(2026, 7, 10, 12, 2, tzinfo=timezone.utc)
                ),
                0,
            )
            with tracker._connect() as conn:
                row = conn.execute("SELECT status, last_bar_time FROM simulated_trades").fetchone()
                self.assertEqual(row["status"], "open")
                self.assertIsNone(row["last_bar_time"])

            self.assertEqual(
                tracker.evaluate_symbol(
                    "EUR/USD", candles, now=datetime(2026, 7, 10, 12, 6, tzinfo=timezone.utc)
                ),
                1,
            )
            with tracker._connect() as conn:
                row = conn.execute(
                    "SELECT status, algorithm_version, data_quality FROM simulated_trades"
                ).fetchone()
                self.assertEqual(row["status"], "tp2")
                self.assertEqual(row["algorithm_version"], ALGORITHM_VERSION)
                self.assertEqual(row["data_quality"], "verified_m5")


if __name__ == "__main__":
    unittest.main()
