"""
SIGNAL SERVER — Facebook Group Auto Poster Bridge (HTTPS)
==========================================================
Runs on https://localhost:5005 so MT5 can whitelist it.

REQUIREMENTS:
    pip install flask pyopenssl

USAGE:
    1. Run once to generate SSL cert (automatic on first run)
    2. Run in a CMD window and keep it open:
           python signal_server.py
    3. In MT5: Tools → Options → Expert Advisors → Allow WebRequest
       Add exactly: https://localhost:5005
    4. In your EA inputs set:
       InpFacebookURL = https://localhost:5005/signal
"""

from flask import Flask, request, jsonify
import json, os, subprocess, threading
from datetime import datetime

app        = Flask(__name__)
QUEUE_FILE = "signal_queue.json"
LOG_FILE   = "signal_log.txt"
SCRIPT2    = os.path.join(os.path.dirname(os.path.abspath(__file__)), "script2_post_to_groups.py")
CERT_FILE  = "server.crt"
KEY_FILE   = "server.key"

# ── Helpers ──────────────────────────────────────────────────────────

def log(msg):
    ts   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def save_signal(sig):
    with open(QUEUE_FILE, "w", encoding="utf-8") as f:
        json.dump(sig, f, ensure_ascii=False, indent=2)
    log(f"Signal saved → {sig}")

def run_script2():
    log("Launching script2_post_to_groups.py ...")
    try:
        venv_python = os.environ.get(
            "VENV_PYTHON", "/opt/trading-bot/venv/bin/python3")
        subprocess.Popen(
            [venv_python, SCRIPT2],
            cwd=os.path.dirname(os.path.abspath(__file__)),
            stdout=open("script2_stdout.log", "a"),
            stderr=open("script2_stderr.log", "a"),
            start_new_session=True,
        )
    except Exception as e:
        log(f"Failed to launch script2: {e}")

def generate_cert():
    """Generate a self-signed SSL certificate if not present."""
    if os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE):
        return
    log("Generating self-signed SSL certificate...")
    try:
        from OpenSSL import crypto
        k   = crypto.PKey()
        k.generate_key(crypto.TYPE_RSA, 2048)
        cert = crypto.X509()
        cert.get_subject().CN = "localhost"
        cert.set_serial_number(1)
        cert.gmtime_adj_notBefore(0)
        cert.gmtime_adj_notAfter(10 * 365 * 24 * 60 * 60)  # 10 years
        cert.set_issuer(cert.get_subject())
        cert.set_pubkey(k)
        cert.sign(k, "sha256")
        with open(CERT_FILE, "wb") as f:
            f.write(crypto.dump_certificate(crypto.FILETYPE_PEM, cert))
        with open(KEY_FILE, "wb") as f:
            f.write(crypto.dump_privatekey(crypto.FILETYPE_PEM, k))
        log(f"Certificate saved: {CERT_FILE}")
    except ImportError:
        log("pyopenssl not installed. Run: pip install pyopenssl")
        raise

# ── Endpoints ────────────────────────────────────────────────────────

@app.route("/signal", methods=["POST"])
def receive_signal():
    try:
        # Accept both JSON and form-encoded (EA sends form-encoded)
        if request.content_type and "application/json" in request.content_type:
            data = request.get_json(force=True)
        else:
            data = {
                "symbol":    request.form.get("symbol",    ""),
                "direction": request.form.get("direction", ""),
                "entry":     request.form.get("entry",     "0"),
                "sl":        request.form.get("sl",        "0"),
                "tp1":       request.form.get("tp",        request.form.get("tp1", "0")),
                "tp2":       request.form.get("tp2",       "--"),
                "tp3":       "--",
                "rr":        request.form.get("rr",        "1:2"),
                "basis":     request.form.get("basis",     "SMC Structure + Liquidity Grab + Daily Bias"),
            }

        missing = [k for k in ["symbol","direction","entry","sl","tp1"] if not data.get(k)]
        if missing:
            return jsonify({"status": "error", "message": f"Missing: {missing}"}), 400

        data.setdefault("tp2",   "--")
        data.setdefault("tp3",   "--")
        data.setdefault("rr",    "1:2")
        data.setdefault("basis", "SMC Structure + Liquidity Grab + Daily Bias")

        save_signal(data)
        threading.Thread(target=run_script2, daemon=True).start()
        return jsonify({"status": "ok", "message": "Signal received. Posting started."}), 200

    except Exception as e:
        log(f"Error: {e}")
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/status", methods=["GET"])
def status():
    try:
        with open(QUEUE_FILE, "r", encoding="utf-8") as f:
            last = json.load(f)
    except Exception:
        last = None
    return jsonify({"status": "running", "last_signal": last}), 200


# ── Main ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    generate_cert()
    log("=" * 52)
    log("Signal Server started → https://agennews.store")
    log("MT5 whitelist URL   → https://agennews.store")
    log("EA InpFacebookURL   → https://agennews.store/signal")
    log("Waiting for signals from MT4/MT5 EA...")
    log("=" * 52)
    if os.environ.get("BEHIND_PROXY") == "1":
        log("Running behind nginx → HTTP on 127.0.0.1:5005")
        app.run(host="127.0.0.1", port=5005, debug=False)
    else:
        log("Standalone mode → HTTPS on 0.0.0.0:5005")
        app.run(host="0.0.0.0", port=5005, debug=False,
                ssl_context=(CERT_FILE, KEY_FILE))
