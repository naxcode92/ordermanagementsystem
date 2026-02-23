/**
 * Order Management System — TCCCPR India
 * Pure Node.js server (no external dependencies)
 * Node v22+ built-in sqlite (node:sqlite)
 *
 * Run:  node app.js
 * Open: http://localhost:3000
 */

"use strict";

const http = require("node:http");
const path = require("node:path");
const fs   = require("node:fs");
const url  = require("node:url");
const qs   = require("node:querystring");
const { DatabaseSync } = require("node:sqlite");

// ── Config ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "orders.db");
const STATIC_DIR = path.join(__dirname, "static");

// ── Database setup ────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    call_sid              TEXT NOT NULL,
    lead_id               TEXT NOT NULL,
    date_type             TEXT,
    order_date            TEXT,
    delivery_failure_date TEXT,
    call_request_date     TEXT,
    last_request_date     TEXT,
    phone_number          TEXT,
    name                  TEXT,
    call_recording        TEXT,
    created_at            TEXT DEFAULT (datetime('now')),
    UNIQUE(lead_id, call_sid)
  )
`);

// ── Prepared statements ───────────────────────────────────
const stmtInsert = db.prepare(`
  INSERT INTO orders
    (call_sid, lead_id, date_type, order_date, delivery_failure_date,
     call_request_date, last_request_date, phone_number, name, call_recording)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtUpdate = db.prepare(`
  UPDATE orders SET
    date_type = ?,
    order_date = ?,
    delivery_failure_date = ?,
    call_request_date = ?,
    last_request_date = ?,
    phone_number = ?,
    name = ?,
    call_recording = ?
  WHERE lead_id = ? AND call_sid = ?
`);

const stmtSelect = db.prepare(
  "SELECT * FROM orders WHERE lead_id = ? AND call_sid = ?"
);

const stmtList = db.prepare(
  "SELECT lead_id, call_sid, name, phone_number, created_at FROM orders ORDER BY created_at DESC"
);

// ── Static MIME map ───────────────────────────────────────
const MIME = {
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".html": "text/html",
};

// ── HTML helpers ──────────────────────────────────────────
function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function baseHead(title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${esc(title)}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"/>
  <link rel="stylesheet" href="/static/css/style.css"/>
</head>
<body>
  <nav class="navbar navbar-dark navbar-oms px-4">
    <a class="navbar-brand d-flex align-items-center gap-2" href="/">
      <i class="bi bi-box-seam-fill fs-4"></i>
      <span class="fw-bold">Order Management System</span>
    </a>
    <span class="badge badge-tcccpr ms-auto">TCCCPR Compliant</span>
  </nav>
  <div class="container-lg py-4">`;
}

function baseFoot(extraJs = "") {
  return `
  </div>
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
  <script src="/static/js/app.js"></script>
  ${extraJs}
</body>
</html>`;
}

// ── Page: Input form ──────────────────────────────────────
function pageIndex(error = "", prefill = {}) {
  const v = (k) => esc(prefill[k] || "");
  const sel = (opt) =>
    prefill.date_type === opt ? ' selected' : '';

  return baseHead("New Order Entry — OMS") + `
<div class="row justify-content-center">
  <div class="col-lg-8 col-xl-7">
    <div class="d-flex align-items-center mb-4 gap-3">
      <div class="page-icon"><i class="bi bi-pencil-square fs-3"></i></div>
      <div>
        <h1 class="h3 mb-0 fw-bold">New Order Entry</h1>
        <p class="text-muted mb-0 small">Enter order details for TCCCPR compliance record</p>
      </div>
    </div>
    ${error ? `<div class="alert alert-danger d-flex align-items-center gap-2" role="alert">
      <i class="bi bi-exclamation-triangle-fill"></i>${esc(error)}</div>` : ""}
    <form method="POST" action="/submit" id="orderForm" novalidate>

      <!-- Identifiers -->
      <div class="card form-card mb-4">
        <div class="card-header section-header">
          <i class="bi bi-fingerprint me-2"></i>Identifiers
        </div>
        <div class="card-body">
          <div class="row g-3">
            <div class="col-md-6">
              <label for="lead_id" class="form-label required-label">Lead ID</label>
              <div class="input-group">
                <span class="input-group-text"><i class="bi bi-person-badge"></i></span>
                <input type="text" class="form-control" id="lead_id" name="lead_id"
                  placeholder="e.g. LEAD-00123" value="${v("lead_id")}" required/>
              </div>
              <div class="invalid-feedback">Lead ID is required.</div>
            </div>
            <div class="col-md-6">
              <label for="call_sid" class="form-label required-label">Call SID</label>
              <div class="input-group">
                <span class="input-group-text"><i class="bi bi-telephone-fill"></i></span>
                <input type="text" class="form-control" id="call_sid" name="call_sid"
                  placeholder="e.g. CA1234abcd5678efgh" value="${v("call_sid")}" required/>
              </div>
              <div class="invalid-feedback">Call SID is required.</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Customer Details -->
      <div class="card form-card mb-4">
        <div class="card-header section-header">
          <i class="bi bi-person-lines-fill me-2"></i>Customer Details
        </div>
        <div class="card-body">
          <div class="row g-3">
            <div class="col-md-6">
              <label for="name" class="form-label">Customer Name</label>
              <div class="input-group">
                <span class="input-group-text"><i class="bi bi-person"></i></span>
                <input type="text" class="form-control" id="name" name="name"
                  placeholder="Full name" value="${v("name")}"/>
              </div>
            </div>
            <div class="col-md-6">
              <label for="phone_number" class="form-label">Phone Number</label>
              <div class="input-group">
                <span class="input-group-text"><i class="bi bi-phone"></i></span>
                <input type="tel" class="form-control" id="phone_number" name="phone_number"
                  placeholder="+91 9XXXXXXXXX" value="${v("phone_number")}"/>
              </div>
            </div>
            <div class="col-12">
              <label for="call_recording" class="form-label">Call Recording URL / Reference</label>
              <div class="input-group">
                <span class="input-group-text"><i class="bi bi-mic-fill"></i></span>
                <input type="text" class="form-control" id="call_recording" name="call_recording"
                  placeholder="https://recordings.example.com/rec-id  or  REC-XXXXXX"
                  value="${v("call_recording")}"/>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Date Information -->
      <div class="card form-card mb-4">
        <div class="card-header section-header">
          <i class="bi bi-calendar3 me-2"></i>Date Information
        </div>
        <div class="card-body">
          <div class="row g-3">
            <div class="col-12">
              <label for="date_type" class="form-label">Primary Date Type</label>
              <div class="input-group">
                <span class="input-group-text"><i class="bi bi-tag"></i></span>
                <select class="form-select" id="date_type" name="date_type">
                  <option value="">-- Select primary date type --</option>
                  <option value="Order Date"${sel("Order Date")}>Order Date</option>
                  <option value="Delivery Failure Date"${sel("Delivery Failure Date")}>Delivery Failure Date</option>
                  <option value="Call Request Date"${sel("Call Request Date")}>Call Request Date</option>
                  <option value="Last Request Date"${sel("Last Request Date")}>Last Request Date</option>
                </select>
              </div>
              <div class="form-text">Select the most relevant date type for this TCCCPR record.</div>
            </div>
            <div class="col-md-6">
              <label for="order_date" class="form-label">Order Date</label>
              <div class="input-group">
                <span class="input-group-text"><i class="bi bi-cart-check"></i></span>
                <input type="date" class="form-control date-field" id="order_date"
                  name="order_date" value="${v("order_date")}"/>
              </div>
            </div>
            <div class="col-md-6">
              <label for="delivery_failure_date" class="form-label">Delivery Failure Date</label>
              <div class="input-group">
                <span class="input-group-text"><i class="bi bi-truck"></i></span>
                <input type="date" class="form-control date-field" id="delivery_failure_date"
                  name="delivery_failure_date" value="${v("delivery_failure_date")}"/>
              </div>
            </div>
            <div class="col-md-6">
              <label for="call_request_date" class="form-label">Call Request Date</label>
              <div class="input-group">
                <span class="input-group-text"><i class="bi bi-telephone-inbound"></i></span>
                <input type="date" class="form-control date-field" id="call_request_date"
                  name="call_request_date" value="${v("call_request_date")}"/>
              </div>
            </div>
            <div class="col-md-6">
              <label for="last_request_date" class="form-label">Last Request Date</label>
              <div class="input-group">
                <span class="input-group-text"><i class="bi bi-calendar-check"></i></span>
                <input type="date" class="form-control date-field" id="last_request_date"
                  name="last_request_date" value="${v("last_request_date")}"/>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Submit -->
      <div class="d-grid gap-2 d-md-flex justify-content-md-end">
        <button type="reset" class="btn btn-outline-secondary px-4">
          <i class="bi bi-arrow-counterclockwise me-1"></i>Reset
        </button>
        <button type="submit" class="btn btn-primary px-5 btn-submit">
          <i class="bi bi-check2-circle me-1"></i>Save &amp; View Record
        </button>
      </div>

    </form>
  </div>
</div>` + baseFoot(`
<script>
  (() => {
    const form = document.getElementById("orderForm");
    form.addEventListener("submit", (e) => {
      if (!form.checkValidity()) { e.preventDefault(); e.stopPropagation(); }
      form.classList.add("was-validated");
    });
    const dateTypeSelect = document.getElementById("date_type");
    const dateMap = {
      "Order Date": "order_date",
      "Delivery Failure Date": "delivery_failure_date",
      "Call Request Date": "call_request_date",
      "Last Request Date": "last_request_date",
    };
    dateTypeSelect.addEventListener("change", () => {
      const targetId = dateMap[dateTypeSelect.value];
      if (targetId) {
        const el = document.getElementById(targetId);
        if (!el.value) el.value = new Date().toISOString().split("T")[0];
        el.focus();
      }
    });
  })();
</script>`);
}

// ── Page: Order detail ────────────────────────────────────
function pageOrder(order) {
  const e = (k) => esc(order[k]);

  function dateCell(label, icon, field, isHighlight) {
    const val = order[field] || "—";
    const star = isHighlight
      ? ' <i class="bi bi-star-fill ms-1 text-warning small"></i>'
      : "";
    return `
    <div class="col-sm-6 detail-cell${isHighlight ? " highlight-primary" : ""}">
      <div class="detail-label"><i class="bi ${icon} me-1"></i>${label}</div>
      <div class="detail-value date-value">${esc(val)}${isHighlight ? star : ""}</div>
    </div>`;
  }

  const dt = order.date_type || "";
  const rec = order.call_recording || "";
  const recHtml = rec
    ? rec.startsWith("http")
      ? `<a href="${esc(rec)}" target="_blank" class="recording-link"><i class="bi bi-play-circle me-1"></i>${esc(rec)}</a>`
      : `<span class="recording-ref">${esc(rec)}</span>`
    : "—";

  return baseHead(`${order.name || order.lead_id} — Order Record`) + `
<div class="row justify-content-center">
  <div class="col-lg-9 col-xl-8">

    <!-- Action bar (excluded from screenshot) -->
    <div class="d-flex flex-wrap align-items-center gap-2 mb-4 no-print" id="actionBar">
      <a href="/" class="btn btn-outline-secondary btn-sm">
        <i class="bi bi-arrow-left me-1"></i>New Entry
      </a>
      <div class="ms-auto d-flex gap-2">
        <button class="btn btn-outline-primary btn-sm" onclick="window.print()">
          <i class="bi bi-printer me-1"></i>Print
        </button>
        <button class="btn btn-primary btn-sm" id="screenshotBtn">
          <i class="bi bi-camera me-1"></i>Save Screenshot
        </button>
        <a href="/?lead_id=${e("lead_id")}&call_sid=${e("call_sid")}&date_type=${encodeURIComponent(dt)}&order_date=${e("order_date")}&delivery_failure_date=${e("delivery_failure_date")}&call_request_date=${e("call_request_date")}&last_request_date=${e("last_request_date")}&phone_number=${e("phone_number")}&name=${e("name")}&call_recording=${e("call_recording")}" class="btn btn-outline-warning btn-sm">
          <i class="bi bi-pencil me-1"></i>Edit
        </a>
      </div>
    </div>

    <!-- Screenshot target -->
    <div id="screenshotTarget" class="screenshot-card">

      <!-- Header -->
      <div class="record-header">
        <div class="d-flex align-items-start justify-content-between flex-wrap gap-2">
          <div>
            <div class="record-label">TCCCPR Order Record</div>
            <h2 class="record-title">${e("name") || "—"}</h2>
          </div>
          <div class="text-end">
            <div class="record-label">Record URL</div>
            <div class="record-url">
              <i class="bi bi-link-45deg"></i>
              <span id="currentUrl"></span>
            </div>
          </div>
        </div>
      </div>

      <!-- Identifiers -->
      <div class="detail-section">
        <div class="row g-0">
          <div class="col-sm-6 detail-cell border-end-sm">
            <div class="detail-label"><i class="bi bi-person-badge me-1"></i>Lead ID</div>
            <div class="detail-value highlight-id">${e("lead_id")}</div>
          </div>
          <div class="col-sm-6 detail-cell">
            <div class="detail-label"><i class="bi bi-telephone-fill me-1"></i>Call SID</div>
            <div class="detail-value highlight-id">${e("call_sid")}</div>
          </div>
        </div>
      </div>

      <!-- Customer -->
      <div class="detail-section">
        <div class="section-title"><i class="bi bi-person-lines-fill me-2"></i>Customer Information</div>
        <div class="row g-0">
          <div class="col-sm-6 detail-cell border-end-sm">
            <div class="detail-label"><i class="bi bi-person me-1"></i>Name</div>
            <div class="detail-value">${e("name") || "—"}</div>
          </div>
          <div class="col-sm-6 detail-cell">
            <div class="detail-label"><i class="bi bi-phone me-1"></i>Phone Number</div>
            <div class="detail-value">${e("phone_number") || "—"}</div>
          </div>
          <div class="col-12 detail-cell border-top-divider">
            <div class="detail-label"><i class="bi bi-mic-fill me-1"></i>Call Recording</div>
            <div class="detail-value">${recHtml}</div>
          </div>
        </div>
      </div>

      <!-- Dates -->
      <div class="detail-section">
        <div class="section-title"><i class="bi bi-calendar3 me-2"></i>Date Information</div>
        ${dt ? `<div class="px-3 pb-2">
          <span class="badge primary-date-badge">
            <i class="bi bi-tag-fill me-1"></i>Primary Type: ${esc(dt)}
          </span></div>` : ""}
        <div class="row g-0">
          ${dateCell("Order Date",            "bi-cart-check",         "order_date",            dt === "Order Date")}
          ${dateCell("Delivery Failure Date", "bi-truck",              "delivery_failure_date", dt === "Delivery Failure Date")}
          ${dateCell("Call Request Date",     "bi-telephone-inbound",  "call_request_date",     dt === "Call Request Date")}
          ${dateCell("Last Request Date",     "bi-calendar-check",     "last_request_date",     dt === "Last Request Date")}
        </div>
      </div>

      <!-- Footer stamp -->
      <div class="record-footer">
        <div class="d-flex flex-wrap justify-content-between align-items-center gap-2">
          <div>
            <i class="bi bi-shield-check me-1"></i>
            Generated for TCCCPR Compliance — Telecom Commercial Communications
            Customer Preference Regulations, India
          </div>
          <div class="text-muted small">Created: ${e("created_at")}</div>
        </div>
      </div>

    </div><!-- end screenshotTarget -->
  </div>
</div>` + baseFoot(`
<script>
  document.getElementById("currentUrl").textContent = window.location.href;

  document.getElementById("screenshotBtn").addEventListener("click", async () => {
    const btn       = document.getElementById("screenshotBtn");
    const actionBar = document.getElementById("actionBar");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Capturing…';
    actionBar.style.visibility = "hidden";
    try {
      const canvas = await html2canvas(document.getElementById("screenshotTarget"), {
        scale: 2, useCORS: true, backgroundColor: "#ffffff",
      });
      const link = document.createElement("a");
      link.download = "TCCCPR_${e("lead_id")}_${e("call_sid")}.png";
      link.href = canvas.toDataURL("image/png");
      link.click();
    } finally {
      actionBar.style.visibility = "visible";
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-camera me-1"></i>Save Screenshot';
    }
  });
</script>`);
}

// ── Page: 404 ─────────────────────────────────────────────
function page404(leadId, callSid) {
  return baseHead("Record Not Found — OMS") + `
<div class="row justify-content-center text-center py-5">
  <div class="col-md-6">
    <div class="display-1 text-muted mb-3">404</div>
    <h2 class="fw-bold mb-2">Record Not Found</h2>
    <p class="text-muted mb-1">No order record exists for:</p>
    <p class="mb-4">
      <span class="badge bg-secondary me-1">Lead ID: ${esc(leadId)}</span>
      <span class="badge bg-secondary">Call SID: ${esc(callSid)}</span>
    </p>
    <a href="/" class="btn btn-primary">
      <i class="bi bi-plus-circle me-1"></i>Create New Record
    </a>
  </div>
</div>` + baseFoot();
}

// ── HTTP server ───────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method   = req.method.toUpperCase();

  // Static files
  if (pathname.startsWith("/static/")) {
    const filePath = path.join(STATIC_DIR, pathname.slice("/static/".length));
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(data);
    });
    return;
  }

  // GET / — input form
  if (pathname === "/" && method === "GET") {
    const prefill = {};
    for (const [k, v] of Object.entries(parsed.query)) {
      prefill[k] = v;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageIndex("", prefill));
    return;
  }

  // POST /submit — save order
  if (pathname === "/submit" && method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const data = qs.parse(body);
      const trim = (k) => (data[k] || "").trim();

      const call_sid   = trim("call_sid");
      const lead_id    = trim("lead_id");
      const date_type  = trim("date_type");
      const order_date            = trim("order_date");
      const delivery_failure_date = trim("delivery_failure_date");
      const call_request_date     = trim("call_request_date");
      const last_request_date     = trim("last_request_date");
      const phone_number          = trim("phone_number");
      const name                  = trim("name");
      const call_recording        = trim("call_recording");

      if (!call_sid || !lead_id) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(pageIndex("Call SID and Lead ID are required.", data));
        return;
      }

      try {
        stmtInsert.run(
          call_sid, lead_id, date_type, order_date, delivery_failure_date,
          call_request_date, last_request_date, phone_number, name, call_recording
        );
      } catch (e) {
        // Duplicate — update instead
        stmtUpdate.run(
          date_type, order_date, delivery_failure_date,
          call_request_date, last_request_date, phone_number, name, call_recording,
          lead_id, call_sid
        );
      }

      res.writeHead(302, { Location: `/${encodeURIComponent(lead_id)}/${encodeURIComponent(call_sid)}` });
      res.end();
    });
    return;
  }

  // GET /api/orders — JSON list
  if (pathname === "/api/orders" && method === "GET") {
    const rows = stmtList.all();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rows));
    return;
  }

  // GET /:leadId/:callSid — order detail
  const detailMatch = pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
  if (detailMatch && method === "GET") {
    const leadId  = decodeURIComponent(detailMatch[1]);
    const callSid = decodeURIComponent(detailMatch[2]);
    const order   = stmtSelect.get(leadId, callSid);
    if (!order) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page404(leadId, callSid));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageOrder(order));
    return;
  }

  // Default 404
  res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page404("", ""));
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   Order Management System — TCCCPR India     ║
║   http://localhost:${PORT}                      ║
╚══════════════════════════════════════════════╝
  `);
});
