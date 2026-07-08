#!/usr/bin/env python3
"""Bump the dashboard semantic version in dashboard/version.json.

Usage examples:
  python scripts/bump_dashboard_version.py --level minor --title "Mobile login polish"
  python scripts/bump_dashboard_version.py --level major --title "Dashboard rewrite"

This updates the JSON manifest only. Commit the resulting change so GitHub and
production stay aligned.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import date
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
VERSION_FILE = ROOT / "dashboard" / "version.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--level",
        choices=("patch", "minor", "major"),
        default="minor",
        help="How to bump the version (default: minor).",
    )
    parser.add_argument(
        "--title",
        default="Dashboard update",
        help="Short release note stored in history.",
    )
    parser.add_argument(
        "--released",
        default=date.today().isoformat(),
        help="Release date (defaults to today).",
    )
    parser.add_argument(
        "--file",
        dest="file_path",
        default=str(VERSION_FILE),
        help="Path to version.json (defaults to dashboard/version.json).",
    )
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def bump_semver(major: int, minor: int, patch: int, level: str) -> tuple[int, int, int]:
    if level == "major":
        return major + 1, 0, 0
    if level == "minor":
        return major, minor + 1, 0
    return major, minor, patch + 1


def replace_once(text: str, pattern: str, replacement: str, *, path: Path) -> str:
    next_text, count = re.subn(pattern, replacement, text, count=1, flags=re.M)
    if count != 1:
        raise RuntimeError(f"Could not update {path} using pattern: {pattern}")
    return next_text


def main() -> int:
    args = parse_args()
    path = Path(args.file_path)
    data = load_json(path)

    major = int(data.get("major", 2))
    minor = int(data.get("minor", 0))
    patch = int(data.get("patch", 0))

    major, minor, patch = bump_semver(major, minor, patch, args.level)
    label = f"v{major}.{minor}"
    full = f"{major}.{minor}.{patch}"

    history = data.get("history") or []
    history_entry = {
        "version": full,
        "label": label,
        "date": args.released,
        "title": args.title,
        "level": args.level,
    }

    next_data = {
        **data,
        "major": major,
        "minor": minor,
        "patch": patch,
        "label": label,
        "released": args.released,
        "history": [history_entry, *history],
    }

    path.write_text(json.dumps(next_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # Keep the visible defaults in sync so a fresh load shows the new version
    # before the API version request completes.
    index_html = ROOT / "dashboard" / "static" / "index.html"
    index_text = index_html.read_text(encoding="utf-8")
    index_text = replace_once(
        index_text,
        r'(<span class="version-badge" id="loginVersion">)v[\d.]+(</span>)',
        rf"\1{label}\2",
        path=index_html,
    )
    index_text = replace_once(
        index_text,
        r'(<span class="version-badge" id="sidebarVersion">)v[\d.]+(</span>)',
        rf"\1{label}\2",
        path=index_html,
    )
    index_text = replace_once(
        index_text,
        r'(<span class="version-pill" id="sidebarVersionFull" title="[^"]*">)v[\d.]+(</span>)',
        rf"\1{full}\2",
        path=index_html,
    )
    index_html.write_text(index_text, encoding="utf-8")

    dashboard_js = ROOT / "dashboard" / "static" / "js" / "dashboard.js"
    js_text = dashboard_js.read_text(encoding="utf-8")
    js_text = replace_once(
        js_text,
        r'let dashboardVersion = \{ label: "v[\d.]+", full: "[\d.]+", major: \d+, minor: \d+, patch: \d+ \};',
        f'let dashboardVersion = {{ label: "{label}", full: "{full}", major: {major}, minor: {minor}, patch: {patch} }};',
        path=dashboard_js,
    )
    dashboard_js.write_text(js_text, encoding="utf-8")

    server_py = ROOT / "dashboard" / "server.py"
    server_text = server_py.read_text(encoding="utf-8")
    server_text = replace_once(
        server_text,
        r'def _dashboard_version\(\) -> dict:\n    default = \{"major": \d+, "minor": \d+, "patch": \d+, "label": "v[\d.]+", "released": "", "history": \[\]\}',
        f'def _dashboard_version() -> dict:\n    default = {{"major": {major}, "minor": {minor}, "patch": {patch}, "label": "{label}", "released": "", "history": []}}',
        path=server_py,
    )
    server_py.write_text(server_text, encoding="utf-8")

    print(f"{label} ({full}) written to {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
