#!/usr/bin/env python3
"""Trading Bot Control Dashboard — Flask API + static UI."""

from __future__ import annotations

import ast
import csv
import io
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from functools import wraps
from pathlib import Path

import psutil
from flask import Flask, Response, jsonify, request, send_file, send_from_directory, session
from werkzeug.middleware.proxy_fix import ProxyFix

try:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill

    HAS_OPENPYXL = True
except ImportError:
    HAS_OPENPYXL = False

# ── Paths ─────────────────────────────────────────────────────────────
BOT_ROOT = Path(os.environ.get("BOT_ROOT", "/opt/trading-bot"))
ENV_FILE = Path(os.environ.get("ENV_FILE", str(BOT_ROOT / ".env")))
STATE_FILE = BOT_ROOT / "engine_state.json"
SIGNAL_LOG = BOT_ROOT / "Facebook" / "signal_log.txt"
SIGNAL_QUEUE = BOT_ROOT / "Facebook" / "signal_queue.json"
TELEGRAM_DELIVERY_LOG = BOT_ROOT / "Facebook" / "telegram_delivery.log"
OUTCOMES_LOG = BOT_ROOT / "Facebook" / "signal_outcomes.log"
PM2_LOG_DIR = Path(os.environ.get("PM2_LOG_DIR", "/root/.pm2/logs"))
ENGINE_LOG = PM2_LOG_DIR / "signal-engine-error.log"
STATIC_DIR = Path(__file__).parent / "static"
VERSION_FILE = Path(__file__).parent / "version.json"

PROCESSES = ("signal-engine", "signal-server")
DISPLAY_PROCESSES = ("signal-engine", "signal-server", "dashboard")
SECRET_KEYS = (
    "TWELVE_DATA_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
)

def _load_dotenv() -> None:
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip())


_load_dotenv()


def _get_secret_key() -> str:
    """Stable secret shared across all gunicorn workers."""
    key = os.environ.get("DASHBOARD_SECRET")
    if key:
        return key
    secret_file = BOT_ROOT / ".dashboard_secret"
    if secret_file.exists():
        return secret_file.read_text().strip()
    key = secrets.token_hex(32)
    secret_file.write_text(key)
    return key


app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
app.secret_key = _get_secret_key()
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=7)

if os.environ.get("BEHIND_PROXY", "0") == "1":
    app.config["SESSION_COOKIE_SECURE"] = True
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


def _dashboard_username() -> str:
    return os.environ.get("DASHBOARD_USERNAME", "admin")


def _dashboard_password() -> str:
    return os.environ.get("DASHBOARD_PASSWORD", "tradingbot2026")


def _dashboard_version() -> dict:
    default = {"major": 2, "minor": 1, "patch": 0, "label": "v2.1", "released": "", "history": []}
    if not VERSION_FILE.exists():
        return default
    try:
        data = json.loads(VERSION_FILE.read_text())
        major = int(data.get("major", default["major"]))
        minor = int(data.get("minor", default["minor"]))
        patch = int(data.get("patch", default["patch"]))
        label = data.get("label") or f"v{major}.{minor}"
        return {
            "major": major,
            "minor": minor,
            "patch": patch,
            "label": label,
            "full": f"{major}.{minor}.{patch}",
            "released": data.get("released", ""),
            "history": data.get("history", []),
        }
    except (json.JSONDecodeError, TypeError, ValueError):
        return default


def auth_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if session.get("authenticated"):
            return f(*args, **kwargs)
        token = request.headers.get("X-Dashboard-Token")
        if token and token == os.environ.get("DASHBOARD_TOKEN"):
            return f(*args, **kwargs)
        return jsonify({"error": "Unauthorized"}), 401

    return wrapper


def _run(cmd: list[str], timeout: int = 15) -> tuple[int, str, str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except subprocess.TimeoutExpired:
        return 1, "", "timeout"
    except FileNotFoundError:
        return 1, "", "command not found"


def _pm2_list() -> list[dict]:
    code, out, _ = _run(["pm2", "jlist"])
    if code != 0 or not out:
        return []
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return []


def _proc_info(name: str) -> dict:
    for p in _pm2_list():
        if p.get("name") == name:
            env = p.get("pm2_env") or {}
            monit = p.get("monit") or {}
            return {
                "name": name,
                "status": env.get("status", "unknown"),
                "pid": p.get("pid", 0),
                "uptime": env.get("pm_uptime"),
                "restarts": env.get("restart_time", 0),
                "memory_mb": round((monit.get("memory") or 0) / 1024 / 1024, 1),
                "cpu": monit.get("cpu", 0),
            }
    return {"name": name, "status": "not_found", "pid": 0, "restarts": 0, "memory_mb": 0, "cpu": 0}


def _uptime_str(ms: int | None) -> str:
    if not ms:
        return "—"
    secs = max(0, int(time.time() * 1000 - ms) // 1000)
    d, rem = divmod(secs, 86400)
    h, rem = divmod(rem, 3600)
    m, s = divmod(rem, 60)
    parts = []
    if d:
        parts.append(f"{d}d")
    if h:
        parts.append(f"{h}h")
    if m:
        parts.append(f"{m}m")
    if not parts:
        parts.append(f"{s}s")
    return " ".join(parts)


def _read_json(path: Path) -> dict | list | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def _parse_env() -> dict[str, str]:
    if not ENV_FILE.exists():
        return {}
    out: dict[str, str] = {}
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip()
    return out


def _write_env(updates: dict[str, str]) -> None:
    lines: list[str] = []
    seen: set[str] = set()
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and "=" in stripped:
                k = stripped.split("=", 1)[0].strip()
                if k in updates:
                    lines.append(f"{k}={updates[k]}")
                    seen.add(k)
                    continue
            lines.append(line)
    for k, v in updates.items():
        if k not in seen:
            lines.append(f"{k}={v}")
    ENV_FILE.write_text("\n".join(lines) + "\n")


def _mask(val: str) -> str:
    if not val:
        return ""
    if len(val) <= 8:
        return "••••••••"
    return val[:4] + "•" * (len(val) - 8) + val[-4:]


def _parse_signals(limit: int = 50, days: int | None = None) -> list[dict]:
    if not SIGNAL_LOG.exists():
        return []
    signals: list[dict] = []
    cutoff = None
    if days is not None:
        cutoff = datetime.now() - timedelta(days=days)
    pattern = re.compile(
        r"\[(?P<ts>[^\]]+)\] Signal saved → (?P<data>.+)$"
    )
    for line in reversed(SIGNAL_LOG.read_text().splitlines()):
        m = pattern.search(line)
        if not m:
            continue
        ts_str = m.group("ts")
        if cutoff:
            try:
                ts_dt = datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S")
                if ts_dt < cutoff:
                    continue
            except ValueError:
                pass
        try:
            data = ast.literal_eval(m.group("data"))
        except Exception:
            continue
        signals.append({"timestamp": ts_str, **data})
        if len(signals) >= limit:
            break
    return signals


def _parse_all_signals(days: int | None = None) -> list[dict]:
    if not SIGNAL_LOG.exists():
        return []
    signals: list[dict] = []
    cutoff = None
    if days is not None:
        cutoff = datetime.now() - timedelta(days=days)
    pattern = re.compile(
        r"\[(?P<ts>[^\]]+)\] Signal saved → (?P<data>.+)$"
    )
    for line in SIGNAL_LOG.read_text().splitlines():
        m = pattern.search(line)
        if not m:
            continue
        ts_str = m.group("ts")
        if cutoff:
            try:
                ts_dt = datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S")
                if ts_dt < cutoff:
                    continue
            except ValueError:
                pass
        try:
            data = ast.literal_eval(m.group("data"))
        except Exception:
            continue
        signals.append({"timestamp": ts_str, **data})
    return list(reversed(signals))


_OUTCOME_ENGINE_RES = (
    re.compile(
        r"(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ .*?(?P<outcome>TP1|TP2|TP|SL|STOP.?LOSS|TAKE.?PROFIT).*?hit.*?(?P<symbol>[\w/]+)",
        re.I,
    ),
    re.compile(
        r"(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ .*?(?P<symbol>[\w/]+).*?(?P<outcome>TP1|TP2|TP|SL).*?(?:hit|reached|triggered)",
        re.I,
    ),
)


def _parse_outcomes(days: int | None = 30) -> list[dict]:
    """Load trade outcomes from JSONL log and engine log patterns."""
    outcomes: list[dict] = []
    cutoff = datetime.now() - timedelta(days=days) if days else None

    if OUTCOMES_LOG.exists():
        for line in reversed(OUTCOMES_LOG.read_text(encoding="utf-8", errors="replace").splitlines()):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts = str(row.get("ts") or row.get("timestamp") or "")
            if cutoff and _parse_ts(ts) and _parse_ts(ts) < cutoff:
                continue
            raw_out = str(row.get("outcome") or row.get("result") or "open").lower()
            if raw_out in ("tp", "take_profit", "takeprofit"):
                raw_out = "tp1"
            elif raw_out.startswith("tp2"):
                raw_out = "tp2"
            elif raw_out.startswith("tp1"):
                raw_out = "tp1"
            elif raw_out in ("sl", "stop_loss", "stoploss", "loss"):
                raw_out = "sl"
            elif raw_out in ("expired", "timeout"):
                raw_out = "expired"
            else:
                raw_out = "open"
            outcomes.append({
                "timestamp": ts[:19],
                "symbol": _normalize_symbol(str(row.get("symbol", ""))),
                "direction": str(row.get("direction", "")).upper(),
                "entry": row.get("entry"),
                "outcome": raw_out,
                "exit_price": row.get("exit_price"),
                "source": "outcomes_log",
            })

    if ENGINE_LOG.exists():
        seen_engine: set[str] = set()
        for line in reversed(ENGINE_LOG.read_text(encoding="utf-8", errors="replace").splitlines()):
            for pat in _OUTCOME_ENGINE_RES:
                m = pat.search(line)
                if not m:
                    continue
                ts_str = m.group("ts")
                if cutoff and _parse_ts(ts_str) and _parse_ts(ts_str) < cutoff:
                    continue
                oc_raw = m.group("outcome").upper()
                if "TP2" in oc_raw:
                    oc = "tp2"
                elif "TP" in oc_raw:
                    oc = "tp1"
                else:
                    oc = "sl"
                key = f"{ts_str}|{m.group('symbol')}|{oc}"
                if key in seen_engine:
                    continue
                seen_engine.add(key)
                outcomes.append({
                    "timestamp": ts_str,
                    "symbol": _normalize_symbol(m.group("symbol")),
                    "direction": "",
                    "entry": None,
                    "outcome": oc,
                    "exit_price": None,
                    "source": "engine_log",
                })
                break

    return outcomes


def _attach_outcomes(signals: list[dict], outcomes: list[dict]) -> list[dict]:
    for sig in signals:
        sym = _normalize_symbol(str(sig.get("symbol", "")))
        direction = str(sig.get("direction", "")).upper()
        ts = _parse_ts(sig.get("timestamp", ""))
        match = None
        best_delta = 999999.0
        for o in outcomes:
            if _normalize_symbol(str(o.get("symbol", ""))) != sym:
                continue
            o_dir = str(o.get("direction", "")).upper()
            if o_dir and direction and o_dir != direction:
                continue
            o_ts = _parse_ts(o.get("timestamp", ""))
            if ts and o_ts:
                delta = abs((ts - o_ts).total_seconds())
                if delta > 86400:
                    continue
                if delta < best_delta:
                    best_delta = delta
                    match = o
            elif not ts:
                match = o
                break
        if match and match.get("outcome") not in (None, "open"):
            sig["outcome"] = match["outcome"]
            sig["outcome_source"] = match.get("source")
            sig["exit_price"] = match.get("exit_price")
        else:
            sig["outcome"] = "open"
            sig["outcome_source"] = None
            sig["exit_price"] = None
    return signals


def _outcome_summary(signals: list[dict]) -> dict:
    wins = [s for s in signals if s.get("outcome") in ("tp1", "tp2")]
    losses = [s for s in signals if s.get("outcome") == "sl"]
    open_ = [s for s in signals if s.get("outcome") in (None, "open")]
    expired = [s for s in signals if s.get("outcome") == "expired"]
    closed = len(wins) + len(losses)
    today = datetime.now().strftime("%Y-%m-%d")
    today_sigs = [s for s in signals if str(s.get("timestamp", "")).startswith(today)]
    today_wins = [s for s in today_sigs if s.get("outcome") in ("tp1", "tp2")]
    today_losses = [s for s in today_sigs if s.get("outcome") == "sl"]
    today_closed = len(today_wins) + len(today_losses)
    return {
        "wins": len(wins),
        "losses": len(losses),
        "open": len(open_),
        "expired": len(expired),
        "closed": closed,
        "win_rate": round(len(wins) / closed * 100, 1) if closed else None,
        "today_wins": len(today_wins),
        "today_losses": len(today_losses),
        "today_closed": today_closed,
        "today_win_rate": round(len(today_wins) / today_closed * 100, 1) if today_closed else None,
    }


def _log_telegram_delivery(**kwargs) -> None:
    try:
        sys.path.insert(0, str(BOT_ROOT))
        from telegram_logger import log_telegram_delivery

        log_telegram_delivery(**kwargs)
    except Exception:
        TELEGRAM_DELIVERY_LOG.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "ts": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
            **kwargs,
        }
        with TELEGRAM_DELIVERY_LOG.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")


def _telegram_send(text: str) -> dict:
    env = _parse_env()
    token = env.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = env.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        return {"ok": False, "error": "تلگرام تنظیم نشده (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)", "http_status": None}
    payload = json.dumps({"chat_id": chat_id, "text": text, "parse_mode": "HTML"}).encode("utf-8")
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            ok = bool(body.get("ok"))
            err = None if ok else str(body.get("description") or body)
            return {"ok": ok, "error": err, "http_status": resp.status, "response": body}
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode("utf-8"))
            err = str(body.get("description") or body)
        except Exception:
            err = str(exc)
        return {"ok": False, "error": err, "http_status": exc.code}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "http_status": None}


def _format_signal_telegram_message(sig: dict) -> str:
    sym = sig.get("symbol", "?")
    direction = str(sig.get("direction", "")).upper()
    emoji = "🟢" if direction == "BUY" else "🔴"
    lines = [
        f"{emoji} <b>{direction} {sym}</b>",
        f"Entry: <code>{sig.get('entry', '—')}</code>",
        f"SL: <code>{sig.get('sl', '—')}</code>",
        f"TP1: <code>{sig.get('tp1', '—')}</code>",
    ]
    if sig.get("tp2"):
        lines.append(f"TP2: <code>{sig.get('tp2')}</code>")
    if sig.get("rr"):
        lines.append(f"RR: {sig.get('rr')}")
    if sig.get("score") is not None:
        lines.append(f"Score: {sig.get('score')}")
    if sig.get("basis"):
        lines.append(f"\n{sig.get('basis')}")
    return "\n".join(lines)


def _find_signal_for_retry(symbol: str, timestamp: str = "", direction: str = "") -> dict | None:
    sym = _normalize_symbol(symbol)
    direction = direction.upper()
    candidates = _parse_all_signals(days=30)
    best = None
    best_delta = 999999.0
    target_ts = _parse_ts(timestamp) if timestamp else None
    for sig in candidates:
        if _normalize_symbol(str(sig.get("symbol", ""))) != sym:
            continue
        if direction and str(sig.get("direction", "")).upper() != direction:
            continue
        if target_ts:
            sig_ts = _parse_ts(sig.get("timestamp", ""))
            if not sig_ts:
                continue
            delta = abs((target_ts - sig_ts).total_seconds())
            if delta < best_delta:
                best_delta = delta
                best = sig
        else:
            return sig
    return best if best_delta <= 600 else None


def _enrich_signals(signals: list[dict], telegram_entries: list[dict]) -> list[dict]:
    """Attach telegram delivery status and quality flags to each saved signal."""
    tg_signals = [e for e in telegram_entries if e.get("message_type", "signal") == "signal"]
    enriched: list[dict] = []
    seen_recent: list[tuple[str, str, datetime]] = []

    for sig in signals:
        row = dict(sig)
        sym = _normalize_symbol(str(sig.get("symbol", "")))
        direction = str(sig.get("direction", "")).upper()
        ts = _parse_ts(sig.get("timestamp", ""))

        match = None
        best_delta = 999999.0
        for t in tg_signals:
            if _normalize_symbol(str(t.get("symbol", ""))) != sym:
                continue
            t_dir = str(t.get("direction", "")).upper()
            if t_dir and direction and t_dir != direction:
                continue
            t_ts = _parse_ts(t.get("timestamp", ""))
            if ts and t_ts:
                delta = abs((ts - t_ts).total_seconds())
                if delta > 300:
                    continue
                if t.get("entry") and sig.get("entry"):
                    try:
                        e1 = float(t["entry"])
                        e2 = float(sig["entry"])
                        if abs(e1 - e2) / max(abs(e2), 1e-9) > 0.002:
                            continue
                    except (TypeError, ValueError):
                        pass
                if delta < best_delta:
                    best_delta = delta
                    match = t
            elif not ts:
                match = t
                break

        if match:
            row["delivery_status"] = "sent" if match.get("ok") else "failed"
            row["telegram_ok"] = bool(match.get("ok"))
            row["telegram_detail"] = match.get("detail") or match.get("error") or ""
            row["score"] = match.get("score") or sig.get("score")
            row["telegram_source"] = match.get("source")
        else:
            row["delivery_status"] = "unsent"
            row["telegram_ok"] = None
            row["telegram_detail"] = "ارسال تلگرام تأیید نشده"
            row["score"] = sig.get("score")

        duplicate = False
        if ts:
            for psym, pdir, pts in seen_recent:
                if psym == sym and pdir == direction and abs((ts - pts).total_seconds()) < 1800:
                    duplicate = True
                    break
            seen_recent.append((sym, direction, ts))
        row["duplicate"] = duplicate
        if duplicate and row["delivery_status"] == "sent":
            row["quality"] = "duplicate"
        elif row["delivery_status"] == "failed":
            row["quality"] = "mistaken"
        elif row["delivery_status"] == "unsent":
            row["quality"] = "pending"
        else:
            row["quality"] = "ok"

        enriched.append(row)

    enriched.sort(key=lambda s: s.get("timestamp", ""), reverse=True)
    outcomes = _parse_outcomes(days=90)
    return _attach_outcomes(enriched, outcomes)


def _signals_page_summary(enriched: list[dict]) -> dict:
    today = datetime.now().strftime("%Y-%m-%d")
    sent = [s for s in enriched if s.get("delivery_status") == "sent"]
    failed = [s for s in enriched if s.get("delivery_status") == "failed"]
    unsent = [s for s in enriched if s.get("delivery_status") == "unsent"]
    dupes = [s for s in enriched if s.get("duplicate")]
    today_list = [s for s in enriched if str(s.get("timestamp", "")).startswith(today)]
    by_symbol: dict[str, int] = {}
    for s in enriched:
        sym = _normalize_symbol(str(s.get("symbol", "?")))
        by_symbol[sym] = by_symbol.get(sym, 0) + 1
    daily: dict[str, dict] = {}
    for s in enriched:
        day = str(s.get("timestamp", ""))[:10]
        if not day:
            continue
        if day not in daily:
            daily[day] = {"date": day, "total": 0, "sent": 0, "failed": 0, "unsent": 0}
        daily[day]["total"] += 1
        st = s.get("delivery_status", "unsent")
        if st in daily[day]:
            daily[day][st] += 1
    daily_list = sorted(daily.values(), key=lambda d: d["date"])[-30:]
    total = len(enriched) or 1
    oc = _outcome_summary(enriched)
    return {
        "total": len(enriched),
        "sent": len(sent),
        "failed": len(failed),
        "unsent": len(unsent),
        "duplicates": len(dupes),
        "mistaken": len(failed) + len(dupes),
        "today": len(today_list),
        "today_sent": len([s for s in today_list if s.get("delivery_status") == "sent"]),
        "delivery_rate": round(len(sent) / total * 100, 1),
        "by_symbol": by_symbol,
        "by_direction": {
            "BUY": len([s for s in enriched if str(s.get("direction", "")).upper() == "BUY"]),
            "SELL": len([s for s in enriched if str(s.get("direction", "")).upper() == "SELL"]),
        },
        "daily": daily_list,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "outcomes": oc,
    }


def _normalize_symbol(sym: str) -> str:
    sym = (sym or "").strip().upper()
    if not sym:
        return "?"
    if "/" in sym:
        return sym
    if len(sym) == 6:
        return f"{sym[:3]}/{sym[3:]}"
    if sym.endswith("USD") and len(sym) > 3:
        return f"{sym[:-3]}/USD"
    return sym


def _parse_ts(ts_str: str) -> datetime | None:
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S UTC"):
        try:
            return datetime.strptime(ts_str[:19], fmt[:19])
        except ValueError:
            continue
    return None


def _within_days(ts_str: str, days: int | None) -> bool:
    if days is None:
        return True
    ts = _parse_ts(ts_str)
    if not ts:
        return True
    return ts >= datetime.now() - timedelta(days=days)


_TELEGRAM_SENT_RE = re.compile(
    r"(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ \w+ Signal sent "
    r"(?P<symbol>[\w/]+) (?P<direction>BUY|SELL)(?: score=(?P<score>\d+))?(?: entry=(?P<entry>[\d.]+))?"
)
_TELEGRAM_FAIL_RES = (
    re.compile(
        r"(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ ERROR (?P<msg>Telegram(?: send)? failed[^\\n]*?)"
        r"(?:\s+symbol[=:]?(?P<symbol>[\w/]+))?",
        re.I,
    ),
    re.compile(
        r"(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ ERROR (?P<msg>.*Telegram.*)",
        re.I,
    ),
    re.compile(
        r"(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ WARNING (?P<msg>Telegram[^\\n]+)",
        re.I,
    ),
)
_TELEGRAM_STARTUP_RE = re.compile(
    r"(?P<ts>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ \w+ (?P<msg>.*(?:startup|Startup).*(?:Telegram|telegram|sent).*)",
    re.I,
)


def _parse_telegram_jsonl(days: int | None = None, limit: int = 500) -> list[dict]:
    if not TELEGRAM_DELIVERY_LOG.exists():
        return []
    entries: list[dict] = []
    for line in reversed(TELEGRAM_DELIVERY_LOG.read_text(encoding="utf-8", errors="replace").splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        ts = row.get("ts", "")
        if not _within_days(ts, days):
            continue
        ok = bool(row.get("ok"))
        entries.append(
            {
                "timestamp": ts.replace(" UTC", ""),
                "symbol": _normalize_symbol(str(row.get("symbol", "?"))),
                "direction": str(row.get("direction", "")).upper(),
                "status": "ok" if ok else "failed",
                "ok": ok,
                "score": row.get("score"),
                "entry": row.get("entry"),
                "error": row.get("error"),
                "http_status": row.get("http_status"),
                "message_type": row.get("message_type", "signal"),
                "source": "delivery_log",
                "detail": row.get("error") or ("ارسال موفق به تلگرام" if ok else "ارسال ناموفق"),
            }
        )
        if len(entries) >= limit:
            break
    return entries


def _parse_engine_telegram_logs(days: int | None = None, limit: int = 1000) -> list[dict]:
    if not ENGINE_LOG.exists():
        return []
    entries: list[dict] = []
    for line in reversed(ENGINE_LOG.read_text(encoding="utf-8", errors="replace").splitlines()):
        m = _TELEGRAM_SENT_RE.search(line)
        if m:
            ts = m.group("ts")
            if not _within_days(ts, days):
                continue
            entries.append(
                {
                    "timestamp": ts,
                    "symbol": _normalize_symbol(m.group("symbol")),
                    "direction": m.group("direction"),
                    "status": "ok",
                    "ok": True,
                    "score": int(m.group("score")) if m.group("score") else None,
                    "entry": m.group("entry"),
                    "error": None,
                    "http_status": 200,
                    "message_type": "signal",
                    "source": "engine_log",
                    "detail": "سیگنال با موفقیت به تلگرام ارسال شد",
                }
            )
            if len(entries) >= limit:
                break
            continue

        for fail_re in _TELEGRAM_FAIL_RES:
            fm = fail_re.search(line)
            if fm:
                ts = fm.group("ts")
                if not _within_days(ts, days):
                    continue
                sym = fm.groupdict().get("symbol")
                entries.append(
                    {
                        "timestamp": ts,
                        "symbol": _normalize_symbol(sym) if sym else "—",
                        "direction": "",
                        "status": "failed",
                        "ok": False,
                        "score": None,
                        "entry": None,
                        "error": fm.group("msg").strip(),
                        "http_status": None,
                        "message_type": "signal",
                        "source": "engine_log",
                        "detail": fm.group("msg").strip(),
                    }
                )
                break

        sm = _TELEGRAM_STARTUP_RE.search(line)
        if sm:
            ts = sm.group("ts")
            if not _within_days(ts, days):
                continue
            ok = "fail" not in sm.group("msg").lower()
            entries.append(
                {
                    "timestamp": ts,
                    "symbol": "—",
                    "direction": "",
                    "status": "ok" if ok else "failed",
                    "ok": ok,
                    "score": None,
                    "entry": None,
                    "error": None if ok else sm.group("msg"),
                    "message_type": "startup",
                    "source": "engine_log",
                    "detail": sm.group("msg").strip(),
                }
            )
        if len(entries) >= limit:
            break
    return entries


def _merge_telegram_entries(*sources: list[dict]) -> list[dict]:
    seen: set[str] = set()
    merged: list[dict] = []
    for source in sources:
        for row in source:
            key = f"{row.get('timestamp')}|{row.get('symbol')}|{row.get('direction')}|{row.get('status')}|{row.get('message_type')}"
            if key in seen:
                continue
            seen.add(key)
            merged.append(row)
    merged.sort(key=lambda r: r.get("timestamp", ""), reverse=True)
    return merged


def _parse_telegram_deliveries(days: int | None = 30, limit: int = 200) -> list[dict]:
    jsonl = _parse_telegram_jsonl(days=days, limit=limit)
    engine = _parse_engine_telegram_logs(days=days, limit=limit * 2)
    return _merge_telegram_entries(jsonl, engine)[:limit]


def _telegram_summary(entries: list[dict], days: int = 30) -> dict:
    today = datetime.now().strftime("%Y-%m-%d")
    ok = [e for e in entries if e.get("ok")]
    failed = [e for e in entries if not e.get("ok")]
    signals = [e for e in entries if e.get("message_type", "signal") == "signal"]
    today_ok = sum(1 for e in ok if str(e.get("timestamp", "")).startswith(today))
    today_failed = sum(1 for e in failed if str(e.get("timestamp", "")).startswith(today))
    total_attempts = len(signals) or len(entries)
    success_rate = round(len([e for e in signals if e.get("ok")]) / max(total_attempts, 1) * 100, 1)

    daily: dict[str, dict] = {}
    for i in range(min(days, 90)):
        d = (datetime.now() - timedelta(days=min(days, 90) - 1 - i)).strftime("%Y-%m-%d")
        daily[d] = {"date": d, "ok": 0, "failed": 0, "total": 0}

    for e in entries:
        day = str(e.get("timestamp", ""))[:10]
        if day not in daily:
            continue
        daily[day]["total"] += 1
        if e.get("ok"):
            daily[day]["ok"] += 1
        else:
            daily[day]["failed"] += 1

    by_symbol: dict[str, int] = defaultdict(int)
    for e in ok:
        if e.get("symbol") and e.get("symbol") != "—":
            by_symbol[e.get("symbol", "?")] += 1

    last = entries[0] if entries else None
    return {
        "total": len(entries),
        "signals_sent": len([e for e in signals if e.get("ok")]),
        "failed": len([e for e in signals if not e.get("ok")]),
        "success_rate": success_rate,
        "today_ok": today_ok,
        "today_failed": today_failed,
        "last_delivery": last,
        "by_symbol": dict(by_symbol),
        "daily": list(daily.values()),
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def _daily_breakdown(signals: list[dict], days: int = 7) -> list[dict]:
    buckets: dict[str, dict] = defaultdict(lambda: {"date": "", "total": 0, "buy": 0, "sell": 0})
    for i in range(days):
        d = (datetime.now() - timedelta(days=days - 1 - i)).strftime("%Y-%m-%d")
        buckets[d] = {"date": d, "total": 0, "buy": 0, "sell": 0}
    for s in signals:
        day = s.get("timestamp", "")[:10]
        if day not in buckets:
            continue
        buckets[day]["total"] += 1
        direction = s.get("direction", "").upper()
        if direction == "BUY":
            buckets[day]["buy"] += 1
        elif direction == "SELL":
            buckets[day]["sell"] += 1
    return list(buckets.values())


def _report_summary(signals: list[dict], days: int = 30) -> dict:
    stats = _signal_stats(signals)
    chart_days = min(max(days, 7), 90)
    daily = _daily_breakdown(signals, chart_days)
    active_days = max(len([d for d in daily if d["total"] > 0]), 1)
    avg_per_day = round(stats["total"] / max(days, 1), 1)
    top_symbol = max(stats["by_symbol"], key=stats["by_symbol"].get) if stats["by_symbol"] else "—"
    buy = stats["by_direction"].get("BUY", 0)
    sell = stats["by_direction"].get("SELL", 0)
    ratio = f"{round(buy / sell, 2)}:1" if sell else "—"
    procs = [_proc_info(n) for n in PROCESSES]
    total_restarts = sum(p.get("restarts", 0) for p in procs)

    telegram_entries = _parse_telegram_deliveries(days=days, limit=500)
    telegram = _telegram_summary(telegram_entries, days=days)
    telegram["configured"] = bool(_parse_env().get("TELEGRAM_BOT_TOKEN"))

    return {
        **stats,
        "days": days,
        "daily": daily,
        "avg_per_day": avg_per_day,
        "top_symbol": top_symbol,
        "buy_sell_ratio": ratio,
        "total_restarts": total_restarts,
        "telegram": telegram,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def _build_xlsx(signals: list[dict], summary: dict) -> io.BytesIO:
    buf = io.BytesIO()
    if not HAS_OPENPYXL:
        return buf
    wb = Workbook()
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill("solid", fgColor="1a2332")
    accent_fill = PatternFill("solid", fgColor="e8f5f0")

    # Summary sheet
    ws = wb.active
    ws.title = "Summary"
    ws.append(["Trading Bot Performance Report"])
    ws.append(["Generated", summary["generated_at"]])
    ws.append([])
    rows = [
        ("Total Signals", summary["total"]),
        ("Today", summary["today"]),
        ("Average / Day (7d)", summary["avg_per_day"]),
        ("Top Symbol", summary["top_symbol"]),
        ("BUY Signals", summary["by_direction"].get("BUY", 0)),
        ("SELL Signals", summary["by_direction"].get("SELL", 0)),
        ("Buy/Sell Ratio", summary["buy_sell_ratio"]),
        ("PM2 Restarts", summary["total_restarts"]),
        ("Telegram Sent", summary.get("telegram", {}).get("signals_sent", 0)),
        ("Telegram Failed", summary.get("telegram", {}).get("failed", 0)),
        ("Telegram Success %", summary.get("telegram", {}).get("success_rate", 0)),
    ]
    for label, val in rows:
        ws.append([label, val])
    ws.append([])
    ws.append(["Daily Breakdown (7 days)"])
    ws.append(["Date", "Total", "BUY", "SELL"])
    for row in ws[5]:
        row.font = header_font
        row.fill = header_fill
    for day in summary["daily"]:
        ws.append([day["date"], day["total"], day["buy"], day["sell"]])

    # Signals sheet
    ws2 = wb.create_sheet("Signals")
    headers = ["Timestamp", "Symbol", "Direction", "Entry", "SL", "TP1", "TP2", "RR", "Basis", "Telegram"]
    ws2.append(headers)
    for cell in ws2[1]:
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center")
    for s in signals:
        ws2.append([
            s.get("timestamp", ""),
            s.get("symbol", ""),
            s.get("direction", ""),
            s.get("entry", ""),
            s.get("sl", ""),
            s.get("tp1", ""),
            s.get("tp2", ""),
            s.get("rr", ""),
            s.get("basis", ""),
            s.get("telegram_status", "—"),
        ])

    # By symbol sheet
    ws3 = wb.create_sheet("By Symbol")
    ws3.append(["Symbol", "Count", "Share %"])
    for cell in ws3[1]:
        cell.font = header_font
        cell.fill = header_fill
    total = summary["total"] or 1
    for sym, count in sorted(summary["by_symbol"].items(), key=lambda x: -x[1]):
        ws3.append([sym, count, f"{round(count / total * 100, 1)}%"])

    wb.save(buf)
    buf.seek(0)
    return buf


def _signal_stats(signals: list[dict]) -> dict:
    today = datetime.now().strftime("%Y-%m-%d")
    today_count = sum(1 for s in signals if s.get("timestamp", "").startswith(today))
    by_symbol: dict[str, int] = {}
    by_dir: dict[str, int] = {"BUY": 0, "SELL": 0}
    for s in signals:
        sym = s.get("symbol", "?")
        by_symbol[sym] = by_symbol.get(sym, 0) + 1
        d = s.get("direction", "").upper()
        if d in by_dir:
            by_dir[d] += 1
    return {
        "total": len(signals),
        "today": today_count,
        "by_symbol": by_symbol,
        "by_direction": by_dir,
    }


_signal_stats_cache: dict = {"mtime": 0.0, "stats": None}


def _live_signal_stats() -> dict:
    """Full signal-log stats — cached until the log file changes."""
    if not SIGNAL_LOG.exists():
        return _signal_stats([])
    mtime = SIGNAL_LOG.stat().st_mtime
    if _signal_stats_cache["stats"] is not None and _signal_stats_cache["mtime"] == mtime:
        return _signal_stats_cache["stats"]
    stats = _signal_stats(_parse_all_signals())
    _signal_stats_cache["mtime"] = mtime
    _signal_stats_cache["stats"] = stats
    return stats


_net_prev: dict[str, float] = {"ts": 0, "sent": 0, "recv": 0}


def _system_stats() -> dict:
    global _net_prev
    cpu_pct = psutil.cpu_percent(interval=0.3)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    net = psutil.net_io_counters()
    now = time.time()
    net_speed = {"up_kbps": 0.0, "down_kbps": 0.0}
    if _net_prev["ts"]:
        dt = now - _net_prev["ts"]
        if dt > 0:
            net_speed["up_kbps"] = round((net.bytes_sent - _net_prev["sent"]) / dt / 1024, 1)
            net_speed["down_kbps"] = round((net.bytes_recv - _net_prev["recv"]) / dt / 1024, 1)
    _net_prev = {"ts": now, "sent": net.bytes_sent, "recv": net.bytes_recv}

    bot_mem = sum(_proc_info(n).get("memory_mb", 0) for n in PROCESSES)
    bot_cpu = sum(_proc_info(n).get("cpu", 0) for n in PROCESSES)

    boot = datetime.fromtimestamp(psutil.boot_time(), tz=timezone.utc)
    uptime_secs = (datetime.now(timezone.utc) - boot).total_seconds()

    return {
        "cpu": {"total": cpu_pct, "bot": round(bot_cpu, 1)},
        "ram": {
            "total_gb": round(mem.total / 1024**3, 1),
            "used_pct": mem.percent,
            "bot_mb": round(bot_mem, 1),
        },
        "disk": {
            "total_gb": round(disk.total / 1024**3, 1),
            "used_pct": disk.percent,
            "free_gb": round(disk.free / 1024**3, 1),
        },
        "network": net_speed,
        "uptime_secs": int(uptime_secs),
        "hostname": os.uname().nodename,
    }


def _overall_status(procs: list[dict]) -> str:
    statuses = [p["status"] for p in procs]
    if all(s == "online" for s in statuses):
        return "running"
    if all(s == "stopped" for s in statuses):
        return "stopped"
    if any(s == "online" for s in statuses):
        return "partial"
    return "unknown"


# ── Routes ────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/api/auth/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    username = data.get("username", "")
    password = data.get("password", "")
    valid_user = secrets.compare_digest(username, _dashboard_username())
    valid_pass = secrets.compare_digest(password, _dashboard_password())
    if valid_user and valid_pass:
        session.permanent = True
        session["authenticated"] = True
        session["username"] = username
        return jsonify({"ok": True, "username": username})
    return jsonify({"error": "Invalid username or password"}), 401


@app.route("/api/auth/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/auth/check")
def auth_check():
    return jsonify({
        "authenticated": bool(session.get("authenticated")),
        "username": session.get("username"),
    })


def _build_status_payload(stats_signals: list[dict] | None = None) -> dict:
    procs = []
    for name in PROCESSES:
        info = _proc_info(name)
        info["uptime_human"] = _uptime_str(info.get("uptime"))
        info["controllable"] = True
        procs.append(info)

    all_procs = []
    for name in DISPLAY_PROCESSES:
        info = _proc_info(name)
        info["uptime_human"] = _uptime_str(info.get("uptime"))
        info["controllable"] = name in PROCESSES
        all_procs.append(info)

    state = _read_json(STATE_FILE) or {}
    env = _parse_env()
    signal_stats = _live_signal_stats()
    telegram_recent = _parse_telegram_deliveries(days=7, limit=500)
    all_recent = _parse_all_signals(days=7)
    enriched_recent = _enrich_signals(all_recent, telegram_recent)

    last_signal_human = {}
    for sym, ts in (state.get("last_signal_at") or {}).items():
        try:
            last_signal_human[sym] = datetime.fromtimestamp(float(ts), tz=timezone.utc).strftime(
                "%Y-%m-%d %H:%M UTC"
            )
        except Exception:
            last_signal_human[sym] = "—"

    return {
        "overall": _overall_status(procs),
        "processes": procs,
        "all_processes": all_procs,
        "engine_state": {
            "last_bars": state.get("last_bars", {}),
            "last_signal_at": last_signal_human,
            "updated_at": state.get("updated_at"),
            "startup_sent": state.get("startup_sent", False),
        },
        "config": {
            "symbols": env.get("SYMBOLS", "EUR/USD,GBP/USD,XAU/USD"),
            "min_score": env.get("MIN_SCORE", "5"),
            "poll_seconds": env.get("POLL_SECONDS", "30"),
            "data_provider": env.get("DATA_PROVIDER", "twelvedata"),
            "facebook_enable": env.get("FACEBOOK_ENABLE", "1") == "1",
            "telegram_configured": bool(env.get("TELEGRAM_BOT_TOKEN")),
            "notifications_paused": env.get("NOTIFICATIONS_PAUSED", "0") == "1",
            "engine_debug": env.get("ENGINE_DEBUG", "0") == "1",
        },
        "latest_signal": _read_json(SIGNAL_QUEUE),
        "signal_stats": signal_stats,
        "recent_signals": enriched_recent[:5],
        "outcome_summary": _outcome_summary(enriched_recent),
        "delivery_summary": {
            "sent": len([s for s in enriched_recent if s.get("delivery_status") == "sent"]),
            "total": len(enriched_recent),
            "rate": round(
                len([s for s in enriched_recent if s.get("delivery_status") == "sent"])
                / max(len(enriched_recent), 1)
                * 100,
                1,
            )
            if enriched_recent
            else None,
        },
        "server_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }


def _signal_after(s: dict, cutoff: datetime) -> bool:
    try:
        return datetime.strptime(s.get("timestamp", "")[:19], "%Y-%m-%d %H:%M:%S") >= cutoff
    except ValueError:
        return True


@app.route("/api/status")
@auth_required
def api_status():
    return jsonify(_build_status_payload())


@app.route("/api/version")
def api_version():
    return jsonify(_dashboard_version())


@app.route("/api/bootstrap")
@auth_required
def api_bootstrap():
    """Single payload for fast dashboard boot — one signal-log read."""
    all_signals = _parse_all_signals(days=30)
    cutoff_7 = datetime.now() - timedelta(days=7)
    signals_7d = [s for s in all_signals if _signal_after(s, cutoff_7)]
    telegram_30 = _parse_telegram_deliveries(days=30, limit=3000)
    enriched_30 = _enrich_signals(all_signals, telegram_30)

    return jsonify(
        {
            "version": _dashboard_version(),
            "status": _build_status_payload(stats_signals=_parse_signals(50)),
            "system": _system_stats(),
            "signals": {
                "signals": enriched_30[:50],
                "summary": _signals_page_summary(enriched_30),
            },
            "report_7": _report_summary(signals_7d, 7),
            "report_30": _report_summary(all_signals, 30),
            "telegram": _telegram_summary(telegram_30, 30),
        }
    )


@app.after_request
def _cache_headers(response):
    path = request.path or ""
    if path.startswith("/static/"):
        response.cache_control.public = True
        response.cache_control.max_age = 86400
        response.cache_control.immutable = True
    elif path == "/" or path.endswith(".html"):
        response.cache_control.no_cache = True
        response.cache_control.must_revalidate = True
    elif path.startswith("/api/") and path not in ("/api/stream", "/api/auth/login", "/api/auth/logout", "/api/version"):
        response.cache_control.private = True
        response.cache_control.max_age = 0
        response.cache_control.must_revalidate = True
    return response


@app.route("/api/system")
@auth_required
def api_system():
    return jsonify(_system_stats())


@app.route("/api/signals")
@auth_required
def api_signals():
    days = request.args.get("days", 30, type=int)
    limit = request.args.get("limit", 100, type=int)
    delivery = request.args.get("delivery", "all")
    direction = request.args.get("direction", "all")
    outcome = request.args.get("outcome", "all")
    symbol = request.args.get("symbol", "").strip().upper()

    days = min(max(days, 1), 365)
    limit = min(max(limit, 1), 500)

    raw = _parse_all_signals(days=days)
    telegram = _parse_telegram_deliveries(days=days, limit=3000)
    enriched = _enrich_signals(raw, telegram)

    if delivery in ("sent", "failed", "unsent"):
        enriched = [s for s in enriched if s.get("delivery_status") == delivery]
    elif delivery == "mistaken":
        enriched = [s for s in enriched if s.get("quality") in ("mistaken", "duplicate")]
    elif delivery == "duplicate":
        enriched = [s for s in enriched if s.get("duplicate")]

    if direction in ("BUY", "SELL"):
        enriched = [s for s in enriched if str(s.get("direction", "")).upper() == direction]

    if outcome in ("tp1", "tp2", "sl", "open", "win", "loss"):
        if outcome == "win":
            enriched = [s for s in enriched if s.get("outcome") in ("tp1", "tp2")]
        elif outcome == "loss":
            enriched = [s for s in enriched if s.get("outcome") == "sl"]
        else:
            enriched = [s for s in enriched if s.get("outcome") == outcome]

    if symbol:
        enriched = [s for s in enriched if symbol in _normalize_symbol(str(s.get("symbol", ""))).replace("/", "")]

    summary = _signals_page_summary(_enrich_signals(raw, telegram))
    return jsonify({
        "signals": enriched[:limit],
        "summary": summary,
        "stats": _signal_stats(raw),
    })


@app.route("/api/logs")
@auth_required
def api_logs():
    process = request.args.get("process", "signal-engine")
    lines = request.args.get("lines", 80, type=int)
    log_map = {
        "signal-engine": PM2_LOG_DIR / "signal-engine-error.log",
        "signal-server-out": PM2_LOG_DIR / "signal-server-out.log",
        "signal-server-err": PM2_LOG_DIR / "signal-server-error.log",
        "signal-server": PM2_LOG_DIR / "signal-server-out.log",
        "facebook": SIGNAL_LOG,
        "telegram": TELEGRAM_DELIVERY_LOG,
    }
    path = log_map.get(process, PM2_LOG_DIR / f"{process}-error.log")
    if not path.exists():
        return jsonify({"lines": [], "source": str(path)})
    content = path.read_text(errors="replace").splitlines()
    return jsonify({"lines": content[-lines:], "source": str(path)})


@app.route("/api/config")
@auth_required
def api_config_get():
    env = _parse_env()
    safe = {}
    for k, v in env.items():
        safe[k] = _mask(v) if k in SECRET_KEYS else v
    return jsonify({"config": safe})


@app.route("/api/config", methods=["PATCH"])
@auth_required
def api_config_patch():
    data = request.get_json(silent=True) or {}
    allowed = {
        "SYMBOLS",
        "MIN_SCORE",
        "POLL_SECONDS",
        "FACEBOOK_ENABLE",
        "DATA_PROVIDER",
        "ENGINE_DEBUG",
        "SEND_STARTUP_MESSAGE",
        "NOTIFICATIONS_PAUSED",
    }
    updates = {k: str(v) for k, v in data.items() if k in allowed}
    if not updates:
        return jsonify({"error": "No valid fields"}), 400
    _write_env(updates)
    return jsonify({"ok": True, "updated": list(updates.keys())})


@app.route("/api/control", methods=["POST"])
@auth_required
def api_control():
    data = request.get_json(silent=True) or {}
    action = data.get("action", "")
    target = data.get("process", "all")

    if action not in ("start", "stop", "restart"):
        return jsonify({"error": "Invalid action"}), 400

    targets = list(PROCESSES) if target == "all" else [target]
    if any(t not in PROCESSES for t in targets):
        return jsonify({"error": "Invalid process"}), 400

    results = []
    for t in targets:
        if action == "restart":
            code, out, err = _run(["pm2", "restart", t])
        else:
            code, out, err = _run(["pm2", action, t])
        results.append({"process": t, "ok": code == 0, "output": out or err})

    if action in ("start", "stop", "restart"):
        _run(["pm2", "save"])

    return jsonify({"results": results, "overall": _overall_status([_proc_info(t) for t in PROCESSES])})


@app.route("/api/reports/summary")
@auth_required
def api_reports_summary():
    days = request.args.get("days", 30, type=int)
    days = min(days, 365)
    signals = _parse_all_signals(days=days)
    summary = _report_summary(signals, days=days)
    env = _parse_env()
    summary["notifications_paused"] = env.get("NOTIFICATIONS_PAUSED", "0") == "1"
    summary["engine_debug"] = env.get("ENGINE_DEBUG", "0") == "1"
    return jsonify(summary)


@app.route("/api/telegram/log")
@auth_required
def api_telegram_log():
    days = request.args.get("days", 30, type=int)
    limit = request.args.get("limit", 100, type=int)
    status = request.args.get("status", "all")
    entries = _parse_telegram_deliveries(days=min(days, 365), limit=min(limit, 500))
    if status == "ok":
        entries = [e for e in entries if e.get("ok")]
    elif status == "failed":
        entries = [e for e in entries if not e.get("ok")]
    summary = _telegram_summary(_parse_telegram_deliveries(days=min(days, 365), limit=500), days=days)
    env = _parse_env()
    return jsonify(
        {
            "entries": entries,
            "summary": summary,
            "telegram_configured": bool(env.get("TELEGRAM_BOT_TOKEN")),
            "notifications_paused": env.get("NOTIFICATIONS_PAUSED", "0") == "1",
        }
    )


@app.route("/api/telegram/summary")
@auth_required
def api_telegram_summary():
    days = request.args.get("days", 30, type=int)
    entries = _parse_telegram_deliveries(days=min(days, 365), limit=500)
    summary = _telegram_summary(entries, days=days)
    env = _parse_env()
    summary["telegram_configured"] = bool(env.get("TELEGRAM_BOT_TOKEN"))
    summary["notifications_paused"] = env.get("NOTIFICATIONS_PAUSED", "0") == "1"
    return jsonify(summary)


@app.route("/api/telegram/test", methods=["POST"])
@auth_required
def api_telegram_test():
    env = _parse_env()
    if not env.get("TELEGRAM_BOT_TOKEN"):
        return jsonify({"ok": False, "error": "تلگرام تنظیم نشده"}), 400
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    text = (
        "✅ <b>TradeChi Bot — Test</b>\n"
        f"Dashboard test message\n"
        f"<code>{now}</code>"
    )
    result = _telegram_send(text)
    _log_telegram_delivery(
        symbol="TEST",
        direction="INFO",
        ok=result.get("ok", False),
        error=result.get("error"),
        http_status=result.get("http_status"),
        message_type="test",
    )
    if not result.get("ok"):
        return jsonify(result), 502
    return jsonify({"ok": True, "message": "پیام تست ارسال شد", **result})


@app.route("/api/telegram/retry", methods=["POST"])
@auth_required
def api_telegram_retry():
    data = request.get_json(silent=True) or {}
    symbol = str(data.get("symbol", "")).strip()
    if not symbol:
        return jsonify({"error": "symbol required"}), 400
    timestamp = str(data.get("timestamp", "")).strip()
    direction = str(data.get("direction", "")).strip()
    sig = _find_signal_for_retry(symbol, timestamp, direction)
    if not sig:
        sig = {
            "symbol": _normalize_symbol(symbol),
            "direction": direction.upper() or "—",
            "entry": data.get("entry"),
            "sl": data.get("sl"),
            "tp1": data.get("tp1"),
            "tp2": data.get("tp2"),
            "rr": data.get("rr"),
            "score": data.get("score"),
            "basis": data.get("basis") or "Retry from dashboard",
        }
    text = _format_signal_telegram_message(sig)
    result = _telegram_send(text)
    _log_telegram_delivery(
        symbol=sig.get("symbol", symbol),
        direction=str(sig.get("direction", direction or "—")),
        ok=result.get("ok", False),
        error=result.get("error"),
        score=sig.get("score"),
        entry=sig.get("entry"),
        http_status=result.get("http_status"),
        message_type="signal",
    )
    if not result.get("ok"):
        return jsonify({**result, "message": "ارسال مجدد ناموفق"}), 502
    return jsonify({"ok": True, "message": "سیگنال مجدداً ارسال شد", **result})


@app.route("/api/export/telegram.csv")
@auth_required
def export_telegram_csv():
    days = request.args.get("days", 30, type=int)
    entries = _parse_telegram_deliveries(days=min(days, 365), limit=2000)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Timestamp", "Symbol", "Direction", "Status", "Score", "Entry", "Error", "Detail", "Source"])
    for e in entries:
        writer.writerow([
            e.get("timestamp", ""),
            e.get("symbol", ""),
            e.get("direction", ""),
            e.get("status", ""),
            e.get("score", ""),
            e.get("entry", ""),
            e.get("error", ""),
            e.get("detail", ""),
            e.get("source", ""),
        ])
    out = io.BytesIO(buf.getvalue().encode("utf-8-sig"))
    fname = f"telegram-log-{datetime.now().strftime('%Y%m%d')}.csv"
    return send_file(out, as_attachment=True, download_name=fname, mimetype="text/csv")


@app.route("/api/export/signals.xlsx")
@auth_required
def export_signals_xlsx():
    days = request.args.get("days", 30, type=int)
    signals = _parse_all_signals(days=min(days, 365))
    summary = _report_summary(signals, days=min(days, 365))
    if not HAS_OPENPYXL:
        return jsonify({"error": "openpyxl not installed"}), 500
    buf = _build_xlsx(signals, summary)
    fname = f"bot-report-{datetime.now().strftime('%Y%m%d')}.xlsx"
    return send_file(buf, as_attachment=True, download_name=fname,
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.route("/api/export/signals.csv")
@auth_required
def export_signals_csv():
    days = request.args.get("days", 30, type=int)
    signals = _parse_all_signals(days=min(days, 365))
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Timestamp", "Symbol", "Direction", "Entry", "SL", "TP1", "TP2", "RR", "Basis"])
    for s in signals:
        writer.writerow([
            s.get("timestamp", ""), s.get("symbol", ""), s.get("direction", ""),
            s.get("entry", ""), s.get("sl", ""), s.get("tp1", ""), s.get("tp2", ""),
            s.get("rr", ""), s.get("basis", ""),
        ])
    out = io.BytesIO(buf.getvalue().encode("utf-8-sig"))
    fname = f"signals-{datetime.now().strftime('%Y%m%d')}.csv"
    return send_file(out, as_attachment=True, download_name=fname, mimetype="text/csv")


@app.route("/api/management", methods=["POST"])
@auth_required
def api_management():
    data = request.get_json(silent=True) or {}
    action = data.get("action", "")

    if action == "restart_all":
        results = []
        for t in PROCESSES:
            code, out, err = _run(["pm2", "restart", t])
            results.append({"process": t, "ok": code == 0})
        _run(["pm2", "save"])
        return jsonify({"ok": True, "message": "All bot processes restarted", "results": results})

    if action == "restart_dashboard":
        code, out, err = _run(["pm2", "restart", "dashboard"])
        _run(["pm2", "save"])
        return jsonify({"ok": code == 0, "message": "Dashboard restarted", "output": out or err})

    if action == "flush_logs":
        code, out, err = _run(["pm2", "flush"])
        return jsonify({"ok": code == 0, "message": "PM2 logs cleared"})

    if action == "reset_cooldowns":
        state = _read_json(STATE_FILE) or {}
        state["last_signal_at"] = {}
        state["updated_at"] = datetime.now(timezone.utc).isoformat()
        STATE_FILE.write_text(json.dumps(state, indent=2, default=str))
        return jsonify({"ok": True, "message": "Signal cooldowns reset"})

    if action == "reset_startup_flag":
        state = _read_json(STATE_FILE) or {}
        state["startup_sent"] = False
        state["updated_at"] = datetime.now(timezone.utc).isoformat()
        STATE_FILE.write_text(json.dumps(state, indent=2, default=str))
        return jsonify({"ok": True, "message": "Startup message flag reset"})

    if action == "pause_notifications":
        _write_env({"NOTIFICATIONS_PAUSED": "1"})
        _run(["pm2", "stop", "signal-engine"])
        _run(["pm2", "save"])
        return jsonify({"ok": True, "message": "Notifications paused — engine stopped"})

    if action == "resume_notifications":
        _write_env({"NOTIFICATIONS_PAUSED": "0"})
        _run(["pm2", "start", "signal-engine"])
        _run(["pm2", "save"])
        return jsonify({"ok": True, "message": "Notifications resumed — engine started"})

    if action == "toggle_debug":
        env = _parse_env()
        current = env.get("ENGINE_DEBUG", "0") == "1"
        _write_env({"ENGINE_DEBUG": "0" if current else "1"})
        return jsonify({"ok": True, "debug": not current, "message": f"Debug mode {'enabled' if not current else 'disabled'}"})

    if action == "pull_and_restart":
        branch = data.get("branch") or os.environ.get("DEPLOY_BRANCH", "main")
        return jsonify(_git_deploy(branch))

    if action == "install_ssh_key":
        pubkey = data.get("public_key", "").strip()
        if not pubkey or not pubkey.startswith(("ssh-ed25519 ", "ssh-rsa ")):
            return jsonify({"error": "Invalid public_key"}), 400
        auth_file = Path("/root/.ssh/authorized_keys")
        auth_file.parent.mkdir(mode=0o700, exist_ok=True)
        existing = auth_file.read_text() if auth_file.exists() else ""
        if pubkey not in existing:
            auth_file.write_text(existing.rstrip() + "\n" + pubkey + "\n")
            auth_file.chmod(0o600)
        return jsonify({"ok": True, "message": "Deploy SSH key installed"})

    return jsonify({"error": f"Unknown action: {action}"}), 400


def _git_deploy(branch: str) -> dict:
    git_dir = BOT_ROOT
    if not (git_dir / ".git").exists():
        return {"ok": False, "error": "Not a git repository"}
    token = os.environ.get("GH_PAT") or os.environ.get("GITHUB_TOKEN", "")
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    git_prefix = ["git"]
    if token:
        git_prefix = [
            "git",
            "-c",
            "credential.helper=!f() { echo username=sedshahab0; echo password=${GITHUB_TOKEN}; }; f",
        ]
        env["GITHUB_TOKEN"] = token
    steps = [
        git_prefix + ["-C", str(git_dir), "fetch", "origin", branch],
        git_prefix + ["-C", str(git_dir), "checkout", branch],
        git_prefix + ["-C", str(git_dir), "reset", "--hard", f"origin/{branch}"],
    ]
    outputs = []
    for cmd in steps:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env)
            code, out, err = r.returncode, r.stdout.strip(), r.stderr.strip()
        except subprocess.TimeoutExpired:
            code, out, err = 1, "", "timeout"
        except FileNotFoundError:
            code, out, err = 1, "", "command not found"
        outputs.append({"cmd": " ".join(cmd), "ok": code == 0, "output": out or err})
        if code != 0:
            return {"ok": False, "message": "Git pull failed", "steps": outputs}
    _run(["pm2", "restart", "dashboard"])
    _run(["pm2", "save"])
    return {"ok": True, "message": f"Pulled {branch} and restarted dashboard", "steps": outputs}


@app.route("/api/deploy/hook", methods=["POST"])
def api_deploy_hook():
    token = request.headers.get("X-Deploy-Token") or request.args.get("token", "")
    expected = os.environ.get("DEPLOY_HOOK_TOKEN", "")
    if not expected or not secrets.compare_digest(token, expected):
        return jsonify({"error": "Unauthorized"}), 401
    data = request.get_json(silent=True) or {}
    branch = data.get("branch") or os.environ.get("DEPLOY_BRANCH", "main")
    result = _git_deploy(branch)
    if not result.get("ok"):
        return jsonify(result), 500
    return jsonify(result)


@app.route("/api/stream")
@auth_required
def api_stream():
    def generate():
        while True:
            procs = []
            all_procs = []
            for name in PROCESSES:
                info = _proc_info(name)
                info["uptime_human"] = _uptime_str(info.get("uptime"))
                info["controllable"] = True
                procs.append(info)
            for name in DISPLAY_PROCESSES:
                info = _proc_info(name)
                info["uptime_human"] = _uptime_str(info.get("uptime"))
                info["controllable"] = name in PROCESSES
                all_procs.append(info)
            payload = {
                "overall": _overall_status(procs),
                "processes": procs,
                "all_processes": all_procs,
                "system": _system_stats(),
                "signal_stats": _live_signal_stats(),
                "latest_signal": _read_json(SIGNAL_QUEUE),
                "server_time": datetime.now().strftime("%H:%M:%S"),
            }
            yield f"data: {json.dumps(payload)}\n\n"
            time.sleep(3)

    return Response(generate(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    port = int(os.environ.get("DASHBOARD_PORT", "8080"))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
