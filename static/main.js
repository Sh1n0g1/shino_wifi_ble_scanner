const TBODY = document.getElementById("devices-body");
const LAST = document.getElementById("last-refresh");
const WIFI_COUNT = document.getElementById("wifi-count");
const BLE_COUNT  = document.getElementById("ble-count");

// Filters
const FILTER_TEXT = document.getElementById("filter-text");
const FILTER_TYPE = document.getElementById("filter-type");
const FILTER_RSSI_MIN = document.getElementById("filter-rssi-min");
const FILTER_RSSI_MAX = document.getElementById("filter-rssi-max");

const MASK_CB = document.getElementById("mask-mac");
let maskEnabled = true; // default ON
if (MASK_CB) maskEnabled = !!MASK_CB.checked;

// Sorting
const HEADER_CELLS = Array.from(document.querySelectorAll("thead th.sortable"));

// Fixed RSSI scale for mini-charts (dBm)
const RSSI_MIN = -100;
const RSSI_MAX = -30;
const POLL_MS = 2000;

// State
let rawDevices = [];          // last payload from server
let sortKey = "type";         // default
let sortDir = "asc";          // "asc" | "desc"
let debounceTimer = null;

function fmtSignal(dbm) {
  if (dbm === null || dbm === undefined) return "—";
  return `${dbm} dBm`;
}

function sanitizeId(x) {
  return String(x).replace(/[^A-Za-z0-9\-_:.]/g, "_");
}
function displayMac(mac) {
  if (!mac) return "";
  const raw = String(mac);
  // Normalize separators but preserve original if possible
  const sep = raw.includes("-") ? "-" : raw.includes(":") ? ":" : null;

  // Extract hex pairs in order regardless of separator
  const pairs = raw.match(/[0-9a-fA-F]{2}/g);
  if (!pairs || pairs.length < 6) {
    // Fallback: if we can't parse 6 pairs, just return raw or masked char-wise
    if (!maskEnabled) return raw;
    // Mask middle 4 chars as last resort (UI-only)
    return raw.replace(/^(.{6}).{4}(.*)$/, "$1••••$2");
  }

  // Mask 4th and 5th octets when enabled
  if (maskEnabled) {
    const masked = [...pairs];
    if (masked[3]) masked[3] = "••";
    if (masked[4]) masked[4] = "••";
    return sep ? masked.join(sep) : masked.join(":");
  }

  return sep ? pairs.join(sep) : pairs.join(":");
}

/**
 * Draw a sparkline of RSSI history.
 * Returns true if drawn, false otherwise.
 */
function drawSpark(canvas, values) {
  if (!canvas || !canvas.getContext) return false;

  const cssW = canvas.width || 290;
  const cssH = canvas.height || 36;

  const ctx = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;

  if (canvas._ratio !== ratio) {
    canvas._ratio = ratio;
    canvas.width = Math.floor(cssW * ratio);
    canvas.height = Math.floor(cssH * ratio);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }

  const w = cssW, h = cssH;
  ctx.setTransform(canvas._ratio, 0, 0, canvas._ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (!Array.isArray(values) || values.length === 0) return false;

  const toY = (v) => {
    const clamped = Math.max(RSSI_MIN, Math.min(RSSI_MAX, v));
    const t = (clamped - RSSI_MIN) / (RSSI_MAX - RSSI_MIN);
    return (h - 2) - t * (h - 4);
  };
  const n = values.length;
  const toX = (i) => (n === 1 ? Math.floor(w / 2) : Math.floor(2 + i * (w - 4) / (n - 1)));

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#7aa2ff";
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(values[0]));
  for (let i = 1; i < n; i++) ctx.lineTo(toX(i), toY(values[i]));
  ctx.stroke();

  ctx.fillStyle = "#e7ecff";
  const lx = toX(n - 1), ly = toY(values[n - 1]);
  ctx.beginPath();
  ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
  ctx.fill();

  return true;
}

function signalClass(rssi) {
  if (rssi === null || rssi === undefined) return "";
  // Stronger signals are closer to 0
  if (rssi >= -50) return "signal-green";      // Excellent
  if (rssi >= -60) return "signal-yellow";     // Good
  if (rssi >= -70) return "signal-orange";     // Fair
  return "signal-red";                         // Weak
}

function makeRow(d) {
  const tr = document.createElement("tr");

  // Type
  const tdType = document.createElement("td");
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = (d.type || "").toUpperCase();
  tdType.appendChild(badge);
  tr.appendChild(tdType);

  // Name / SSID
  const tdName = document.createElement("td");
  tdName.textContent = d.name || "(unknown)";
  tr.appendChild(tdName);

  // MAC (Vendor)
  const tdMac = document.createElement("td");
  const macSpan = document.createElement("span");
  macSpan.textContent = displayMac(d.mac);
  const venSpan = document.createElement("span");
  venSpan.className = "mac-vendor";
  venSpan.textContent = `(${d.vendor || "Unknown"})`;
  tdMac.appendChild(macSpan);
  tdMac.appendChild(venSpan);
  tr.appendChild(tdMac);

  // Signal
  const tdSig = document.createElement("td");
  tdSig.className = "signal " + signalClass(d.signal_dbm);
  tdSig.textContent = fmtSignal(d.signal_dbm);
  tr.appendChild(tdSig);

  // Sparkline or placeholder
  const tdSpark = document.createElement("td");
  if (Array.isArray(d.history) && d.history.length > 0) {
    const canvas = document.createElement("canvas");
    canvas.className = "spark";
    canvas.width = 290; canvas.height = 36;
    canvas.id = "spark-" + sanitizeId(d.mac);
    tdSpark.appendChild(canvas);
  } else {
    const none = document.createElement("span");
    none.textContent = "—";
    none.className = "dim";
    tdSpark.appendChild(none);
  }
  tr.appendChild(tdSpark);

  // Last seen
  const tdLast = document.createElement("td");
  const t = d.last_seen_iso ? new Date(d.last_seen_iso) : new Date();
  tdLast.innerHTML = `<span title="${t.toISOString()}">${t.toLocaleString()}</span>`;
  tdLast.className = "dim";
  tr.appendChild(tdLast);

  return tr;
}

function applyFilters(devices) {
  const q = (FILTER_TEXT?.value || "").trim().toLowerCase();
  const type = (FILTER_TYPE?.value || "all").toLowerCase();
  const min = Number(FILTER_RSSI_MIN?.value ?? RSSI_MIN);
  const max = Number(FILTER_RSSI_MAX?.value ?? RSSI_MAX);
  const hasMin = Number.isFinite(min);
  const hasMax = Number.isFinite(max);

  return devices.filter(d => {
    // type
    if (type !== "all" && (d.type || "").toLowerCase() !== type) return false;

    // RSSI range
    const rssi = d.signal_dbm;
    if (hasMin && rssi !== null && rssi !== undefined && rssi < min) return false;
    if (hasMax && rssi !== null && rssi !== undefined && rssi > max) return false;

    // text search (name, mac, vendor)
    if (q) {
      const hay = [
        d.name || "",
        d.mac || "",
        d.vendor || "",
      ].join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }

    return true;
  });
}

function compareAsc(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function compareDesc(a, b) {
  return a < b ? 1 : a > b ? -1 : 0;
}

function sortDevices(devs) {
  const key = sortKey;
  const dir = sortDir;

  const val = (d) => {
    switch (key) {
      case "type":       return (d.type || "").toLowerCase();          // wifi/ble
      case "name":       return (d.name || "").toLowerCase();
      case "mac":        return (d.mac || "").toLowerCase();
      case "signal_dbm": return Number.isFinite(d.signal_dbm) ? d.signal_dbm : -9999;
      case "last_seen":  return d.last_seen || 0;
      default:           return "";
    }
  };

  const cmp = dir === "asc" ? compareAsc : compareDesc;
  devs.sort((a, b) => cmp(val(a), val(b)));
  return devs;
}

function renderTable(devices) {
  TBODY.innerHTML = "";
  for (const d of devices) {
    TBODY.appendChild(makeRow(d));
  }
  // draw sparklines
  for (const d of devices) {
    const c = document.getElementById("spark-" + sanitizeId(d.mac));
    if (c) drawSpark(c, d.history || []);
  }
}

function updateStats(devices) {
  const wifi = devices.filter(d => (d.type || "").toLowerCase() === "wifi").length;
  const ble  = devices.filter(d => (d.type || "").toLowerCase() === "ble").length;
  if (WIFI_COUNT) WIFI_COUNT.textContent = String(wifi);
  if (BLE_COUNT)  BLE_COUNT.textContent  = String(ble);
}

function refreshView() {
  let devs = [...rawDevices];
  devs = applyFilters(devs);
  devs = sortDevices(devs);
  renderTable(devs);
}

function setSortFromHeader(th) {
  const key = th.getAttribute("data-key");
  if (!key) return;
  if (sortKey === key) {
    sortDir = (sortDir === "asc") ? "desc" : "asc";
  } else {
    sortKey = key;
    sortDir = (key === "signal_dbm" || key === "last_seen") ? "desc" : "asc";
  }
  HEADER_CELLS.forEach(h => h.classList.remove("asc", "desc"));
  th.classList.add(sortDir);
  refreshView();
}

function attachHeaderSorting() {
  HEADER_CELLS.forEach(th => {
    th.addEventListener("click", () => setSortFromHeader(th));
  });
  // initialize indicator
  const init = HEADER_CELLS.find(h => h.getAttribute("data-key") === sortKey);
  if (init) init.classList.add(sortDir);
}

function onFilterChange() {
  // debounce to avoid re-render spam while typing
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(refreshView, 120);
}

async function poll() {
  try {
    const res = await fetch("/api/devices", { cache: "no-store" });
    const data = await res.json();
    rawDevices = data.devices || [];

    updateStats(rawDevices);
    refreshView();

    LAST.textContent = "Last refresh: " + new Date().toLocaleTimeString();
  } catch (e) {
    LAST.textContent = "Refresh failed";
    console.error(e);
  } finally {
    setTimeout(poll, POLL_MS);
  }
}

// Wire up filters & sorting
[FILTER_TEXT, FILTER_TYPE, FILTER_RSSI_MIN, FILTER_RSSI_MAX]
  .filter(Boolean)
  .forEach(el => el.addEventListener("input", onFilterChange));

if (MASK_CB) {
  MASK_CB.addEventListener("change", () => {
    maskEnabled = !!MASK_CB.checked;
    refreshView(); // re-render table with masked/unmasked MACs
  });
}


attachHeaderSorting();

// Start
poll();