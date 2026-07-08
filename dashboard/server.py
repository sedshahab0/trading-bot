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
import time
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
PM2_LOG_DIR = Path(os.environ.get("PM2_LOG_DIR", "/root/.pm2/logs"))
STATIC_DIR = Path(__file__).parent / "static"

PROCESSES = ("signal-engine", "signal-server")
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


def _report_summary(signals: list[dict]) -> dict:
    stats = _signal_stats(signals)
    daily = _daily_breakdown(signals, 7)
    avg_per_day = round(stats["total"] / max(len([d for d in daily if d["total"] > 0]), 1), 1)
    top_symbol = max(stats["by_symbol"], key=stats["by_symbol"].get) if stats["by_symbol"] else "—"
    buy = stats["by_direction"].get("BUY", 0)
    sell = stats["by_direction"].get("SELL", 0)
    ratio = f"{round(buy / sell, 2)}:1" if sell else "—"
    procs = [_proc_info(n) for n in PROCESSES]
    total_restarts = sum(p.get("restarts", 0) for p in procs)
    return {
        **stats,
        "daily": daily,
        "avg_per_day": avg_per_day,
        "top_symbol": top_symbol,
        "buy_sell_ratio": ratio,
        "total_restarts": total_restarts,
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
    headers = ["Timestamp", "Symbol", "Direction", "Entry", "SL", "TP1", "TP2", "RR", "Basis"]
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
        procs.append(info)

    state = _read_json(STATE_FILE) or {}
    env = _parse_env()
    if stats_signals is None:
        stats_signals = _parse_signals(100)

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
        "signal_stats": _signal_stats(stats_signals),
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


@app.route("/api/bootstrap")
@auth_required
def api_bootstrap():
    """Single payload for fast dashboard boot — one signal-log read."""
    all_signals = _parse_all_signals(days=30)
    cutoff_7 = datetime.now() - timedelta(days=7)
    signals_7d = [s for s in all_signals if _signal_after(s, cutoff_7)]
    stats_signals = all_signals[:100]

    return jsonify(
        {
            "status": _build_status_payload(stats_signals=stats_signals),
            "system": _system_stats(),
            "signals": all_signals[:50],
            "report_7": _report_summary(signals_7d),
            "report_30": _report_summary(all_signals),
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
    elif path.startswith("/api/") and path not in ("/api/stream", "/api/auth/login", "/api/auth/logout"):
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
    limit = request.args.get("limit", 30, type=int)
    signals = _parse_signals(min(limit, 200))
    return jsonify({"signals": signals, "stats": _signal_stats(signals)})


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
    signals = _parse_all_signals(days=min(days, 365))
    summary = _report_summary(signals)
    env = _parse_env()
    summary["notifications_paused"] = env.get("NOTIFICATIONS_PAUSED", "0") == "1"
    summary["engine_debug"] = env.get("ENGINE_DEBUG", "0") == "1"
    return jsonify(summary)


@app.route("/api/export/signals.xlsx")
@auth_required
def export_signals_xlsx():
    days = request.args.get("days", 30, type=int)
    signals = _parse_all_signals(days=min(days, 365))
    summary = _report_summary(signals)
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
        return jsonify({"ok": True, "message": "All processes restarted", "results": results})

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

    return jsonify({"error": f"Unknown action: {action}"}), 400


@app.route("/api/stream")
@auth_required
def api_stream():
    def generate():
        while True:
            procs = [_proc_info(n) for n in PROCESSES]
            payload = {
                "overall": _overall_status(procs),
                "processes": procs,
                "system": _system_stats(),
                "server_time": datetime.now().strftime("%H:%M:%S"),
            }
            yield f"data: {json.dumps(payload)}\n\n"
            time.sleep(3)

    return Response(generate(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    port = int(os.environ.get("DASHBOARD_PORT", "8080"))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
