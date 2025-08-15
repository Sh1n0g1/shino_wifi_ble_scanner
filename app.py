#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import time
from datetime import datetime, timezone
from flask import Flask, jsonify, render_template

from scanners import DeviceStore, start_wifi_scanner, start_ble_scanner

app = Flask(__name__, template_folder="templates", static_folder="static")

# Shared in-memory store for both scanners
store = DeviceStore(history_len=60)  # keep ~60 samples per device

# Kick off background scanners
start_wifi_scanner(store, interval_sec=5)   # scan every ~5s
start_ble_scanner(store)                    # continuous BLE scanning


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/devices")
def api_devices():
    snapshot = store.snapshot()
    # Convert to JSON-safe payload
    out = []
    for d in snapshot:
        out.append({
            "type": d["type"],  # "wifi" | "ble"
            "name": d.get("name") or d.get("ssid") or "(unknown)",
            "mac": d["mac"],
            "vendor": d.get("vendor") or "Unknown",
            "last_seen": d["last_seen"],
            "last_seen_iso": datetime.fromtimestamp(d["last_seen"], tz=timezone.utc).astimezone().isoformat(),
            "signal_dbm": d.get("rssi"),
            "history": d.get("history", [])  # list of numbers (latest at end)
        })
    return jsonify({"devices": out, "server_time": time.time()})


if __name__ == "__main__":
    # Use Flask’s dev server for simplicity. For production, consider waitress/uvicorn+ASGI, etc.
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 5000)), debug=True)
