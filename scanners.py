# -*- coding: utf-8 -*-
import asyncio
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Dict, Optional, List

# ---- Optional vendor lookup ----
_vendor_lock = threading.RLock()
_vendor_cache: Dict[str, str] = {}
try:
    from mac_vendor_lookup import MacLookup  # pip install mac-vendor-lookup
    _mac_lookup = MacLookup()
except Exception:
    _mac_lookup = None


def _normalize_mac(mac: str) -> str:
    mac = (mac or "").strip().upper().replace("-", ":")
    # Ensure colon-separated 6-byte form if possible
    if ":" not in mac and len(mac) == 12:
        mac = ":".join(mac[i:i+2] for i in range(0, 12, 2))
    return mac


def _vendor_for(mac: str) -> Optional[str]:
    mac = _normalize_mac(mac)
    if not mac:
        return None
    prefix = ":".join(mac.split(":")[:3])
    with _vendor_lock:
        if prefix in _vendor_cache:
            return _vendor_cache[prefix]
        vendor = None
        if _mac_lookup is not None:
            try:
                vendor = _mac_lookup.lookup(mac)
            except Exception:
                vendor = None
        _vendor_cache[prefix] = vendor or "Unknown"
        return _vendor_cache[prefix]


@dataclass
class DeviceRecord:
    type: str                    # "wifi" | "ble"
    mac: str
    name: Optional[str] = None   # BLE device name
    ssid: Optional[str] = None   # Wi-Fi SSID
    vendor: Optional[str] = None
    rssi: Optional[int] = None   # dBm (negative)
    last_seen: float = field(default_factory=time.time)
    history: deque = field(default_factory=lambda: deque(maxlen=60))  # of int RSSI dBm


class DeviceStore:
    def __init__(self, history_len: int = 60):
        self._lock = threading.RLock()
        self._records: Dict[str, DeviceRecord] = {}
        self._history_len = history_len

    def update(self, *, dev_type: str, mac: str, name: Optional[str], rssi: Optional[int], ssid: Optional[str] = None):
        mac = _normalize_mac(mac)
        if not mac or rssi is None:
            return
        with self._lock:
            rec = self._records.get(mac)
            if rec is None:
                rec = DeviceRecord(type=dev_type, mac=mac)
                rec.history = deque(maxlen=self._history_len)
                self._records[mac] = rec
            rec.type = dev_type
            rec.mac = mac
            if dev_type == "wifi":
                rec.ssid = name or ssid
                rec.name = None
            else:
                rec.name = name
            rec.vendor = rec.vendor or _vendor_for(mac)
            rec.rssi = int(rssi)
            rec.last_seen = time.time()
            rec.history.append(int(rssi))

    def snapshot(self) -> List[dict]:
        with self._lock:
            out = []
            for rec in self._records.values():
                out.append({
                    "type": rec.type,
                    "mac": rec.mac,
                    "name": rec.name,
                    "ssid": rec.ssid,
                    "vendor": rec.vendor,
                    "rssi": rec.rssi,
                    "last_seen": rec.last_seen,
                    "history": list(rec.history),
                })
            # Sort: Wi-Fi first, then BLE; within each, strongest (closest to 0) first
            def sort_key(d):
                t = 0 if d["type"] == "wifi" else 1
                rssi = d.get("rssi")
                # None signals go to the bottom
                strength = -(rssi if (isinstance(rssi, int) or isinstance(rssi, float)) else -9999)
                return (t, -strength)
            out.sort(key=sort_key)
            return out


# -------------------- Wi-Fi Scanner (pywifi) --------------------
def start_wifi_scanner(store: DeviceStore, interval_sec: int = 5):
    """
    Runs in a background thread. Every interval, triggers a scan and ingests results.
    Notes:
      - pywifi 'signal' should be dBm, but on some platforms it may be 0-100 quality.
        We heuristically convert quality -> dBm via (quality/2) - 100.
    """
    try:
        import pywifi
        from pywifi import PyWiFi
    except Exception as e:
        print(f"[WiFi] pywifi not available: {e}")
        return

    def _quality_to_dbm(x):
        try:
            x = int(x)
        except Exception:
            return None
        # If positive and <= 100, likely quality; convert
        if 0 <= x <= 100:
            return int(round((x / 2.0) - 100))  # 0 -> -100 dBm, 100 -> -50 dBm
        return int(x)  # already dBm (likely negative)

    def worker():
        try:
            wifi = PyWiFi()
            ifaces = wifi.interfaces()
            if not ifaces:
                print("[WiFi] No wireless interfaces found.")
                return
            iface = ifaces[0]
            print(f"[WiFi] Using interface: {iface.name()}")

            while True:
                try:
                    iface.scan()
                    # Small settle delay; Windows often needs a couple seconds
                    time.sleep(2.5)
                    results = iface.scan_results()
                    for cell in results:
                        ssid = getattr(cell, "ssid", None)
                        bssid = getattr(cell, "bssid", None) or getattr(cell, "bssid", None)
                        signal = getattr(cell, "signal", None)
                        if bssid is None or signal is None:
                            continue
                        dbm = _quality_to_dbm(signal)
                        if dbm is None:
                            continue
                        # Hidden SSIDs appear as empty strings
                        store.update(dev_type="wifi", mac=bssid, name=ssid or "(hidden)", rssi=dbm)
                except Exception as e:
                    print(f"[WiFi] scan error: {e}")
                time.sleep(interval_sec)
        except Exception as e:
            print(f"[WiFi] fatal: {e}")

    t = threading.Thread(target=worker, name="WiFiScanner", daemon=True)
    t.start()


# -------------------- BLE Scanner (bleak) --------------------
def start_ble_scanner(store: DeviceStore):
    """
    Starts a thread that runs an asyncio loop with a continuous BleakScanner.
    """
    try:
        from bleak import BleakScanner
    except Exception as e:
        print(f"[BLE] bleak not available: {e}")
        return

    async def ble_loop():
        # Callback compatible across Bleak versions
        def on_adv(device, advertisement_data=None):
            try:
                name = None
                rssi = None
                if advertisement_data is not None:
                    name = getattr(advertisement_data, "local_name", None) or getattr(device, "name", None)
                    rssi = getattr(advertisement_data, "rssi", None)
                if rssi is None:
                    # Older Bleak might keep rssi on device
                    rssi = getattr(device, "rssi", None)
                if name is None:
                    name = getattr(device, "name", None) or "(unknown)"
                mac = getattr(device, "address", None)
                if mac and rssi is not None:
                    store.update(dev_type="ble", mac=mac, name=name, rssi=int(rssi))
            except Exception as e:
                print(f"[BLE] adv parse error: {e}")

        # Try both registration styles
        try:
            scanner = BleakScanner(detection_callback=on_adv)
        except TypeError:
            scanner = BleakScanner()
            if hasattr(scanner, "register_detection_callback"):
                scanner.register_detection_callback(on_adv)

        await scanner.start()
        print("[BLE] Scanning…")
        try:
            while True:
                await asyncio.sleep(1.0)
        finally:
            await scanner.stop()

    def run():
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop.run_until_complete(ble_loop())
        except Exception as e:
            print(f"[BLE] loop error: {e}")

    t = threading.Thread(target=run, name="BLEScanner", daemon=True)
    t.start()
