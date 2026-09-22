import os
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import pandas as pd

from engine import indicators
from engine.data_provider import DataProvider, RateLimiter
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
    def test_canonical_id_matches_live_and_log_replay(self):
        live = {
            "timestamp": "2026-07-24T03:32:33.123456+00:00",
            "symbol": "XAU/USD",
            "direction": "SELL",
            "entry": 4024.22131,
        }
        logged = {
            "timestamp": "2026-07-24 03:32:33",
            "symbol": "XAUUSD",
            "direction": "sell",
            "entry": "4024.22",
        }
        self.assertEqual(SimulationTracker.trade_id(live), SimulationTracker.trade_id(logged))

    def test_duplicate_register_is_ignored(self):
        with tempfile.TemporaryDirectory() as tmp:
            tracker = SimulationTracker(str(Path(tmp) / "simulation.sqlite3"))
            payload = {
                "timestamp": "2026-07-24T03:32:33.999999+00:00",
                "symbol": "XAU/USD",
                "direction": "SELL",
                "entry": 4024.22131,
                "sl": 4030.0,
                "tp1": 4010.0,
                "tp2": 4000.0,
                "score": 1,
            }
            self.assertTrue(tracker.register(payload))
            replay = {
                **payload,
                "timestamp": "2026-07-24 03:32:33",
                "symbol": "XAUUSD",
                "entry": "4024.22",
            }
            self.assertFalse(tracker.register(replay))
            with tracker._connect() as conn:
                count = conn.execute("SELECT COUNT(*) FROM simulated_trades").fetchone()[0]
            self.assertEqual(count, 1)

    def test_migrate_legacy_ids_keeps_evaluated_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            tracker = SimulationTracker(str(Path(tmp) / "simulation.sqlite3"))
            payload = {
                "timestamp": "2026-08-04T05:02:30+00:00",
                "symbol": "XAGUSD",
                "direction": "BUY",
                "entry": 59.01,
                "sl": 58.0,
                "tp1": 61.0,
                "tp2": 63.0,
                "score": 1,
            }
            tracker.register(payload)
            canonical = SimulationTracker.trade_id(payload)
            now = datetime.now(timezone.utc).isoformat()
            with tracker._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO simulated_trades
                        (id, signal_time, symbol, direction, entry, sl, tp1, tp2, score,
                         status, active, bars_seen, r_multiple, updated_at)
                    VALUES (?, ?, 'XAGUSD', 'BUY', 59.0099983215332, 58.0, 61.0, 63.0, 1,
                            'tp2', 0, 247, 1.97, ?)
                    """,
                    ("legacyghostid1234567", payload["timestamp"], now),
                )
                conn.execute(
                    "UPDATE simulated_trades SET status='expired', active=0, bars_seen=0, r_multiple=4.749 WHERE id=?",
                    (canonical,),
                )
            plan = tracker.migrate_legacy_ids(dry_run=True)
            self.assertEqual(plan["merge_groups"], 1)
            applied = tracker.migrate_legacy_ids(dry_run=False)
            self.assertEqual(applied["dropped"], 1)
            with tracker._connect() as conn:
                rows = list(conn.execute("SELECT id, status, bars_seen FROM simulated_trades"))
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["id"], canonical)
            self.assertEqual(rows[0]["status"], "tp2")
            self.assertEqual(rows[0]["bars_seen"], 247)

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


class PersistentMarketCacheTests(unittest.TestCase):
    def test_cache_survives_provider_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = str(Path(tmp) / "market.sqlite3")
            frame = pd.DataFrame(
                [{"open": 1.0, "high": 1.2, "low": 0.9, "close": 1.1}],
                index=pd.DatetimeIndex(["2026-07-10T12:00:00+00:00"]),
            )
            with patch.dict("os.environ", {"MARKET_CACHE_DB": cache_path}):
                first = DataProvider("unused")
                first._write_persistent("EUR/USD:M5", 123.0, frame)
                second = DataProvider("unused")
                cached = second._read_persistent("EUR/USD:M5")
            self.assertIsNotNone(cached)
            fetched_at, restored = cached
            self.assertEqual(fetched_at, 123.0)
            self.assertEqual(float(restored.iloc[0]["close"]), 1.1)

    def test_budget_mode_keeps_every_symbol_on_twelve_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(
                "os.environ",
                {"MARKET_CACHE_DB": str(Path(tmp) / "market.sqlite3"), "TWELVEDATA_BUDGET_MODE": "1"},
            ):
                provider = DataProvider("unused", "twelvedata")
            self.assertEqual(provider._provider_for_symbol("EUR/USD"), "twelvedata")
            self.assertEqual(provider._provider_for_symbol("USD/JPY"), "twelvedata")
            self.assertEqual(provider._provider_for_symbol("XAU/USD"), "twelvedata")
            self.assertEqual(provider._provider_for_symbol("XAG/USD"), "twelvedata")


def _twelve_ok(close: str = "1.5"):
    response = MagicMock()
    response.status_code = 200
    response.headers = {}
    response.raise_for_status = MagicMock()
    response.json.return_value = {
        "status": "ok",
        "values": [
            {
                "datetime": "2026-09-21 10:00:00",
                "open": "1",
                "high": "2",
                "low": "0.5",
                "close": close,
            }
        ],
    }
    return response


def _twelve_daily_429():
    response = MagicMock()
    response.status_code = 429
    response.headers = {}
    response.json.return_value = {
        "message": "You have run out of API credits for the day. 800 API credits were used."
    }
    return response


def _twelve_minute_429():
    response = MagicMock()
    response.status_code = 429
    response.headers = {"Retry-After": "60"}
    response.json.return_value = {"message": "API rate limit exceeded"}
    return response


class TwelveKeyRotationTests(unittest.TestCase):
    def test_parses_primary_and_env_keys_without_duplicates(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(
                "os.environ",
                {
                    "MARKET_CACHE_DB": str(Path(tmp) / "market.sqlite3"),
                    "TWELVE_DATA_API_KEYS": "key1, key2, key1",
                },
                clear=False,
            ):
                provider = DataProvider("key1")
        self.assertEqual(provider.api_keys, ["key1", "key2"])

    def test_daily_limit_switches_to_next_key(self):
        calls = []

        def fake_get(url, params=None, timeout=30):
            key = (params or {}).get("apikey")
            calls.append(key)
            if key == "dead":
                return _twelve_daily_429()
            return _twelve_ok("3705")

        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(
                "os.environ",
                {
                    "MARKET_CACHE_DB": str(Path(tmp) / "market.sqlite3"),
                    "TWELVE_DATA_API_KEYS": "alive",
                    "TWELVEDATA_BUDGET_MODE": "0",
                },
                clear=False,
            ):
                provider = DataProvider("dead")
            with patch("engine.data_provider.requests.get", side_effect=fake_get):
                with patch.object(RateLimiter, "wait", lambda self: None):
                    frame = provider._fetch_twelve_data("XAU/USD", "H1")
        self.assertEqual(calls, ["dead", "alive"])
        self.assertEqual(float(frame.iloc[0]["close"]), 3705)
        self.assertGreater(provider._key_blocked_until["dead"], time.time())
        self.assertNotIn("alive", provider._key_blocked_until)
        self.assertEqual(provider._usable_keys(), ["alive"])

    def test_all_keys_exhausted_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(
                "os.environ",
                {
                    "MARKET_CACHE_DB": str(Path(tmp) / "market.sqlite3"),
                    "TWELVE_DATA_API_KEYS": "dead2",
                },
                clear=False,
            ):
                provider = DataProvider("dead1")
            with patch(
                "engine.data_provider.requests.get",
                return_value=_twelve_daily_429(),
            ):
                with patch.object(RateLimiter, "wait", lambda self: None):
                    with self.assertRaises(RuntimeError) as raised:
                        provider._fetch_twelve_data("XAU/USD", "H1")
        self.assertIn("daily credits", str(raised.exception).lower())
        self.assertEqual(provider._usable_keys(), [])

    def test_per_minute_limit_switches_without_waiting(self):
        calls = []

        def fake_get(url, params=None, timeout=30):
            key = (params or {}).get("apikey")
            calls.append(key)
            if key == "slow":
                return _twelve_minute_429()
            return _twelve_ok("12.5")

        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(
                "os.environ",
                {
                    "MARKET_CACHE_DB": str(Path(tmp) / "market.sqlite3"),
                    "TWELVE_DATA_API_KEYS": "fast",
                },
                clear=False,
            ):
                provider = DataProvider("slow")
            with patch("engine.data_provider.requests.get", side_effect=fake_get):
                with patch.object(RateLimiter, "wait", lambda self: None):
                    with patch("engine.data_provider.time.sleep") as slept:
                        frame = provider._fetch_twelve_data("XAU/USD", "H1")
        self.assertEqual(calls, ["slow", "fast"])
        slept.assert_not_called()
        self.assertEqual(float(frame.iloc[0]["close"]), 12.5)

    def test_blocked_key_is_skipped_after_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {
                "MARKET_CACHE_DB": str(Path(tmp) / "market.sqlite3"),
                "TWELVE_POOL_STATUS": str(Path(tmp) / "pool.json"),
                "TWELVE_DATA_API_KEYS": "alive",
            }
            with patch.dict("os.environ", env, clear=False):
                first = DataProvider("dead")
            calls_first = []

            def first_get(url, params=None, timeout=30):
                key = (params or {}).get("apikey")
                calls_first.append(key)
                if key == "dead":
                    return _twelve_daily_429()
                return _twelve_ok("9")

            with patch("engine.data_provider.requests.get", side_effect=first_get):
                with patch.object(RateLimiter, "wait", lambda self: None):
                    first._fetch_twelve_data("XAU/USD", "H1")
            self.assertEqual(calls_first, ["dead", "alive"])
            with patch.dict("os.environ", env, clear=False):
                second = DataProvider("dead")
            calls = []

            def fake_get(url, params=None, timeout=30):
                calls.append((params or {}).get("apikey"))
                return _twelve_ok("9")

            with patch("engine.data_provider.requests.get", side_effect=fake_get):
                with patch.object(RateLimiter, "wait", lambda self: None):
                    second._fetch_twelve_data("XAU/USD", "H1")
        self.assertEqual(calls, ["alive"])

    def test_sticky_key_is_tried_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(
                "os.environ",
                {
                    "MARKET_CACHE_DB": str(Path(tmp) / "market.sqlite3"),
                    "TWELVE_POOL_STATUS": str(Path(tmp) / "pool.json"),
                    "TWELVE_DATA_API_KEYS": "second",
                },
                clear=False,
            ):
                provider = DataProvider("first")
            with patch("engine.data_provider.requests.get", return_value=_twelve_ok("3")):
                with patch.object(RateLimiter, "wait", lambda self: None):
                    provider._fetch_twelve_data("XAU/USD", "H1")
            self.assertEqual(provider._usable_keys()[0], "first")
            calls = []

            def fake_get(url, params=None, timeout=30):
                calls.append((params or {}).get("apikey"))
                return _twelve_ok("4")

            with patch("engine.data_provider.requests.get", side_effect=fake_get):
                with patch.object(RateLimiter, "wait", lambda self: None):
                    provider._fetch_twelve_data("XAU/USD", "H1")
        self.assertEqual(calls[0], "first")

    def test_reload_picks_up_new_env_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(
                "os.environ",
                {
                    "MARKET_CACHE_DB": str(Path(tmp) / "market.sqlite3"),
                    "TWELVE_POOL_STATUS": str(Path(tmp) / "pool.json"),
                    "TWELVE_DATA_API_KEYS": "",
                },
                clear=False,
            ):
                provider = DataProvider("alpha")
                self.assertEqual(provider.api_keys, ["alpha"])
                os.environ["TWELVE_DATA_API_KEYS"] = "beta"
                provider.reload_keys_from_env("alpha")
        self.assertEqual(provider.api_keys, ["alpha", "beta"])

    def test_warehouse_skips_api_when_current_period_is_present(self):
        now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
        index = pd.date_range(end=now, periods=250, freq="h", tz="UTC")
        frame = pd.DataFrame(
            {
                "open": [1.0] * 250,
                "high": [1.2] * 250,
                "low": [0.9] * 250,
                "close": [1.1] * 250,
            },
            index=index,
        )
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(
                "os.environ",
                {
                    "MARKET_CACHE_DB": str(Path(tmp) / "market.sqlite3"),
                    "TWELVE_POOL_STATUS": str(Path(tmp) / "pool.json"),
                },
                clear=False,
            ):
                provider = DataProvider("key")
                provider._save_candles("XAU/USD", "H1", frame)
                with patch("engine.data_provider.requests.get") as mocked:
                    got = provider.get_ohlcv("XAU/USD", "H1")
        mocked.assert_not_called()
        self.assertEqual(len(got), 250)

    def test_get_ohlcv_does_not_use_yfinance(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(
                "os.environ",
                {
                    "MARKET_CACHE_DB": str(Path(tmp) / "market.sqlite3"),
                    "TWELVE_POOL_STATUS": str(Path(tmp) / "pool.json"),
                    "TWELVE_DATA_API_KEYS": "dead2",
                },
                clear=False,
            ):
                provider = DataProvider("dead1")
            with patch(
                "engine.data_provider.requests.get",
                return_value=_twelve_daily_429(),
            ):
                with patch.object(RateLimiter, "wait", lambda self: None):
                    with self.assertRaises(RuntimeError):
                        provider.get_ohlcv("XAU/USD", "H1")

    def test_prefetch_only_frames_the_engine_uses(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(
                "os.environ",
                {
                    "MARKET_CACHE_DB": str(Path(tmp) / "market.sqlite3"),
                    "TWELVE_POOL_STATUS": str(Path(tmp) / "pool.json"),
                },
                clear=False,
            ):
                provider = DataProvider("key")
            with patch.object(DataProvider, "get_ohlcv") as mocked:
                provider.prefetch_symbol("XAU/USD")
        self.assertEqual([call.args[1] for call in mocked.call_args_list], ["D1", "H1", "M5"])

    def test_plan_gated_symbol_does_not_rotate_keys_or_retry(self):
        calls = []

        def fake_get(url, params=None, timeout=30):
            calls.append((params or {}).get("apikey"))
            response = MagicMock()
            response.status_code = 404
            response.headers = {}
            response.content = b'{"message":"Grow"}'
            response.json.return_value = {
                "status": "error",
                "code": 404,
                "message": "This symbol is available starting with the Grow or Venture plan.",
            }
            return response

        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(
                "os.environ",
                {
                    "MARKET_CACHE_DB": str(Path(tmp) / "market.sqlite3"),
                    "TWELVE_POOL_STATUS": str(Path(tmp) / "pool.json"),
                    "TWELVE_DATA_API_KEYS": "key2",
                },
                clear=False,
            ):
                provider = DataProvider("key1")
            with patch("engine.data_provider.requests.get", side_effect=fake_get):
                with patch.object(RateLimiter, "wait", lambda self: None):
                    with patch("engine.data_provider.time.sleep") as slept:
                        with self.assertRaises(RuntimeError) as raised:
                            provider.get_ohlcv("XAG/USD", "H1")
                        slept.assert_not_called()
                        with self.assertRaises(RuntimeError):
                            provider.get_ohlcv("XAG/USD", "H1")
        self.assertEqual(calls, ["key1"])
        self.assertIn("grow", str(raised.exception).lower())
        self.assertEqual(provider._usable_keys(), ["key1", "key2"])


if __name__ == "__main__":
    unittest.main()
