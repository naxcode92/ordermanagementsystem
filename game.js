/**
 * Rock Paper Scissors — Multiplayer Game Server
 * Pure Node.js server (no external dependencies)
 * Node v22+ built-in sqlite (node:sqlite)
 *
 * Run:  node game.js
 * Open: http://localhost:3001
 *
 * Env vars:
 *   GAME_PORT           (default 3001)
 *   SENDGRID_API_KEY    (optional — for email verification)
 *   GAME_BASE_URL       (e.g. http://localhost:3001)
 */

"use strict";

const http   = require("node:http");
const https  = require("node:https");
const crypto = require("node:crypto");
const path   = require("node:path");
const fs     = require("node:fs");
const url    = require("node:url");
const qs     = require("node:querystring");
const { DatabaseSync } = require("node:sqlite");

// ── Load .env file ───────────────────────────────────────
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// ── Config ───────────────────────────────────────────────
const PORT          = process.env.GAME_PORT || 3001;
const SENDGRID_KEY  = process.env.SENDGRID_API_KEY || "";
const BASE_URL      = process.env.GAME_BASE_URL || `http://localhost:${PORT}`;
const PLATFORM_FEE  = 0.10; // 10% of $1
const EXTEND_COST   = 1.00; // $1 to extend

// ── Database ─────────────────────────────────────────────
const DB_PATH = path.join(__dirname, "rps.db");
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    email          TEXT NOT NULL UNIQUE,
    display_name   TEXT NOT NULL DEFAULT '',
    wallet_balance REAL NOT NULL DEFAULT 10.00,
    games_played   INTEGER NOT NULL DEFAULT 0,
    games_won      INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    player1_id  INTEGER NOT NULL,
    player2_id  INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'playing',
    best_of     INTEGER NOT NULL DEFAULT 3,
    winner_id   INTEGER,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (player1_id) REFERENCES players(id),
    FOREIGN KEY (player2_id) REFERENCES players(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS rounds (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id      INTEGER NOT NULL,
    round_number INTEGER NOT NULL,
    player1_move TEXT,
    player2_move TEXT,
    winner_id    INTEGER,
    is_draw      INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (game_id) REFERENCES games(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id   INTEGER NOT NULL,
    amount      REAL NOT NULL,
    type        TEXT NOT NULL,
    description TEXT,
    game_id     INTEGER,
    created_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (player_id) REFERENCES players(id)
  )
`);

// ── Prepared statements ──────────────────────────────────
const stmtGetPlayer       = db.prepare("SELECT * FROM players WHERE email = ?");
const stmtGetPlayerById   = db.prepare("SELECT * FROM players WHERE id = ?");
const stmtInsertPlayer    = db.prepare("INSERT INTO players (email, display_name) VALUES (?, ?)");
const stmtUpdateWallet    = db.prepare("UPDATE players SET wallet_balance = wallet_balance + ? WHERE id = ?");
const stmtIncrPlayed      = db.prepare("UPDATE players SET games_played = games_played + 1 WHERE id = ?");
const stmtIncrWon         = db.prepare("UPDATE players SET games_won = games_won + 1 WHERE id = ?");
const stmtInsertGame      = db.prepare("INSERT INTO games (player1_id, player2_id) VALUES (?, ?)");
const stmtGetGame         = db.prepare("SELECT * FROM games WHERE id = ?");
const stmtUpdateGame      = db.prepare("UPDATE games SET status = ?, winner_id = ?, best_of = ?, updated_at = datetime('now') WHERE id = ?");
const stmtInsertRound     = db.prepare("INSERT INTO rounds (game_id, round_number, player1_move, player2_move, winner_id, is_draw) VALUES (?, ?, ?, ?, ?, ?)");
const stmtGetRounds       = db.prepare("SELECT * FROM rounds WHERE game_id = ? ORDER BY round_number ASC");
const stmtInsertTx        = db.prepare("INSERT INTO transactions (player_id, amount, type, description, game_id) VALUES (?, ?, ?, ?, ?)");
const stmtGetTx           = db.prepare("SELECT * FROM transactions WHERE player_id = ? ORDER BY created_at DESC LIMIT 50");
const stmtLeaderboard     = db.prepare("SELECT id, display_name, email, games_played, games_won FROM players ORDER BY games_won DESC, games_played ASC LIMIT 20");

// ── In-memory stores ────────────────────────────────────
const sessions       = new Map(); // sessionId → { playerId, email, expiresAt }
const verifyStore    = new Map(); // email → { code, expiresAt, attempts }
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;
const CODE_EXPIRY     = 10 * 60 * 1000; // 10 minutes

// Matchmaking queue: array of { playerId, email, sseRes, joinedAt }
let matchQueue = [];

// Active game SSE connections: gameId → Map<playerId, res>
const gameStreams = new Map();

// Pending moves per round: gameId → Map<playerId, move>
const pendingMoves = new Map();

// ── Static MIME map ──────────────────────────────────────
const MIME = {
  ".css":  "text/css",
  ".js":   "application/javascript",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".html": "text/html",
  ".svg":  "image/svg+xml",
};
const STATIC_DIR = path.join(__dirname, "static");

// ── Helper: HTML escape ──────────────────────────────────
function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── Session helpers ──────────────────────────────────────
function createSession(data) {
  const id = crypto.randomBytes(32).toString("hex");
  sessions.set(id, { ...data, expiresAt: Date.now() + SESSION_MAX_AGE });
  return id;
}

function getSession(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)rps_session=([a-f0-9]{64})/);
  if (!match) return null;
  const sess = sessions.get(match[1]);
  if (!sess) return null;
  if (sess.expiresAt < Date.now()) { sessions.delete(match[1]); return null; }
  return sess;
}

function sessionCookie(sessionId) {
  return `rps_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE / 1000}`;
}

function clearSessionCookie() {
  return "rps_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

// ── Email sending (SendGrid HTTP API or dev-mode fallback) ──
async function sendVerificationEmail(email, code) {
  if (!SENDGRID_KEY) {
    console.log(`[DEV MODE] Verification code for ${email}: ${code}`);
    return { devMode: true, code };
  }

  const body = JSON.stringify({
    personalizations: [{ to: [{ email }] }],
    from: { email: "noreply@rps-game.com", name: "RPS Game" },
    subject: "Your RPS Game Verification Code",
    content: [{
      type: "text/html",
      value: `<h2>Your verification code is: <strong>${code}</strong></h2><p>This code expires in 10 minutes.</p>`,
    }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.sendgrid.com",
      path: "/v3/mail/send",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SENDGRID_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ sent: true, status: res.statusCode }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Game logic helpers ──────────────────────────────────
const MOVES = ["rock", "paper", "scissors"];

function resolveRound(move1, move2) {
  if (move1 === move2) return "draw";
  if (
    (move1 === "rock" && move2 === "scissors") ||
    (move1 === "paper" && move2 === "rock") ||
    (move1 === "scissors" && move2 === "paper")
  ) return "player1";
  return "player2";
}

function getGameScore(rounds) {
  let p1 = 0, p2 = 0;
  for (const r of rounds) {
    if (r.winner_id === null && !r.is_draw) continue;
    if (r.is_draw) continue;
    // Determine if winner is player1 or player2 of the game
    // winner_id is stored per round
    if (r.winner_id === r._p1id) p1++;
    else p2++;
  }
  return { p1, p2 };
}

function getGameScoreFromDb(gameId, game) {
  const rounds = stmtGetRounds.all(gameId);
  let p1 = 0, p2 = 0;
  for (const r of rounds) {
    if (r.is_draw || !r.winner_id) continue;
    if (r.winner_id === game.player1_id) p1++;
    else if (r.winner_id === game.player2_id) p2++;
  }
  return { p1, p2, rounds };
}

function winsNeeded(bestOf) {
  return Math.ceil(bestOf / 2);
}

// ── SSE helpers ──────────────────────────────────────────
function sseSetup(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n"); // initial comment to establish connection
}

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) { /* connection may be closed */ }
}

function broadcastGame(gameId, event, data) {
  const streams = gameStreams.get(gameId);
  if (!streams) return;
  for (const [, res] of streams) {
    sseSend(res, event, data);
  }
}

// ── Parse request body ──────────────────────────────────
function parseBody(req, maxSize = 1024 * 64) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooBig = false;
    req.on("data", chunk => {
      body += chunk;
      if (body.length > maxSize) { tooBig = true; req.destroy(); }
    });
    req.on("end", () => {
      if (tooBig) return reject(new Error("Body too large"));
      const ct = req.headers["content-type"] || "";
      if (ct.includes("application/json")) {
        try { resolve(JSON.parse(body)); } catch { resolve({}); }
      } else {
        resolve(qs.parse(body));
      }
    });
    req.on("error", reject);
  });
}

// ── JSON response helpers ────────────────────────────────
function jsonOk(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function jsonErr(res, message, status = 400) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

function htmlResponse(res, html, status = 200) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

// ═══════════════════════════════════════════════════════════
// ── HTML Pages ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

function gameHead(title, extraHead = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${esc(title)}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet"/>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css"/>
  <link rel="stylesheet" href="/static/game/css/game.css"/>
  ${extraHead}
</head>
<body>`;
}

function gameNav(player = null) {
  const playerHtml = player ? `
    <div class="d-flex align-items-center gap-2">
      <span class="badge bg-success"><i class="bi bi-wallet2 me-1"></i>$${player.wallet_balance.toFixed(2)}</span>
      <a href="/profile" class="text-white-50 text-decoration-none small">${esc(player.email)}</a>
      <a href="/logout" class="btn btn-outline-light btn-sm py-0 px-2" style="font-size:.75rem;">Sign out</a>
    </div>` : "";

  return `
  <nav class="navbar navbar-dark rps-navbar px-3 px-md-4">
    <a class="navbar-brand d-flex align-items-center gap-2" href="/lobby">
      <span class="rps-logo">&#9994;&#9995;&#9996;&#65039;</span>
      <span class="fw-bold">RPS Arena</span>
    </a>
    <div class="d-flex align-items-center gap-3">
      <a href="/leaderboard" class="text-white-50 text-decoration-none small"><i class="bi bi-trophy me-1"></i>Leaderboard</a>
      ${playerHtml}
    </div>
  </nav>`;
}

function gameFoot(extraJs = "") {
  return `
  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
  ${extraJs}
</body>
</html>`;
}

// ── Page: Login / Landing ────────────────────────────────
function pageLogin(message = "", messageType = "") {
  return gameHead("RPS Arena — Rock Paper Scissors Multiplayer") + `
  <div class="rps-landing">
    <div class="rps-landing-bg"></div>
    <div class="container position-relative">
      <div class="row justify-content-center">
        <div class="col-sm-10 col-md-7 col-lg-5 col-xl-4">
          <div class="text-center mb-4">
            <div class="rps-hero-icons">
              <span class="rps-hero-icon rock">&#9994;</span>
              <span class="rps-hero-icon paper">&#9995;</span>
              <span class="rps-hero-icon scissors">&#9996;&#65039;</span>
            </div>
            <h1 class="rps-title">RPS Arena</h1>
            <p class="rps-subtitle">Multiplayer Rock Paper Scissors</p>
            <p class="text-white-50 small">Play best-of-3 matches against players worldwide. Losing 0-2? Pay $1 to extend to best-of-7!</p>
          </div>
          <div class="rps-card p-4">
            ${message ? `<div class="alert alert-${messageType || "info"} small py-2 mb-3">${esc(message)}</div>` : ""}
            <div id="step-email">
              <h5 class="fw-bold mb-3"><i class="bi bi-envelope me-2"></i>Enter your email to play</h5>
              <form id="emailForm">
                <div class="mb-3">
                  <input type="email" class="form-control form-control-lg" id="emailInput" placeholder="you@example.com" required autofocus/>
                </div>
                <button type="submit" class="btn btn-rps btn-lg w-100" id="sendCodeBtn">
                  <i class="bi bi-send me-2"></i>Send Verification Code
                </button>
              </form>
            </div>
            <div id="step-code" style="display:none;">
              <h5 class="fw-bold mb-2"><i class="bi bi-shield-lock me-2"></i>Enter verification code</h5>
              <p class="text-muted small mb-3">We sent a 6-digit code to <strong id="sentToEmail"></strong></p>
              <form id="codeForm">
                <div class="mb-3">
                  <input type="text" class="form-control form-control-lg text-center tracking-wide" id="codeInput"
                    maxlength="6" pattern="[0-9]{6}" placeholder="000000" required autofocus/>
                </div>
                <button type="submit" class="btn btn-rps btn-lg w-100" id="verifyBtn">
                  <i class="bi bi-check-circle me-2"></i>Verify & Play
                </button>
                <button type="button" class="btn btn-link text-muted btn-sm w-100 mt-2" id="backBtn">Use a different email</button>
              </form>
              <div id="devCodeAlert" class="alert alert-warning small mt-3" style="display:none;">
                <i class="bi bi-info-circle me-1"></i><strong>Dev mode:</strong> Your code is <code id="devCode"></code>
              </div>
            </div>
            <div id="loginError" class="alert alert-danger small mt-3" style="display:none;"></div>
          </div>
        </div>
      </div>
    </div>
  </div>` + gameFoot(`
<script>
(function() {
  const emailForm = document.getElementById('emailForm');
  const codeForm = document.getElementById('codeForm');
  const stepEmail = document.getElementById('step-email');
  const stepCode = document.getElementById('step-code');
  const emailInput = document.getElementById('emailInput');
  const codeInput = document.getElementById('codeInput');
  const sentToEmail = document.getElementById('sentToEmail');
  const loginError = document.getElementById('loginError');
  const devCodeAlert = document.getElementById('devCodeAlert');
  const devCode = document.getElementById('devCode');
  const sendCodeBtn = document.getElementById('sendCodeBtn');
  const backBtn = document.getElementById('backBtn');

  function showError(msg) {
    loginError.textContent = msg;
    loginError.style.display = '';
  }
  function hideError() { loginError.style.display = 'none'; }

  emailForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    const email = emailInput.value.trim();
    if (!email) return;
    sendCodeBtn.disabled = true;
    sendCodeBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Sending...';
    try {
      const resp = await fetch('/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await resp.json();
      if (!resp.ok) { showError(data.error || 'Failed to send code'); return; }
      sentToEmail.textContent = email;
      stepEmail.style.display = 'none';
      stepCode.style.display = '';
      codeInput.focus();
      if (data.devMode && data.code) {
        devCode.textContent = data.code;
        devCodeAlert.style.display = '';
      }
    } catch (err) {
      showError('Network error. Please try again.');
    } finally {
      sendCodeBtn.disabled = false;
      sendCodeBtn.innerHTML = '<i class="bi bi-send me-2"></i>Send Verification Code';
    }
  });

  codeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    const email = emailInput.value.trim();
    const code = codeInput.value.trim();
    if (!code) return;
    try {
      const resp = await fetch('/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      });
      const data = await resp.json();
      if (!resp.ok) { showError(data.error || 'Invalid code'); return; }
      window.location.href = '/lobby';
    } catch (err) {
      showError('Network error. Please try again.');
    }
  });

  backBtn.addEventListener('click', () => {
    stepCode.style.display = 'none';
    stepEmail.style.display = '';
    devCodeAlert.style.display = 'none';
    hideError();
    emailInput.focus();
  });
})();
</script>`);
}

// ── Page: Lobby ──────────────────────────────────────────
function pageLobby(player) {
  return gameHead("Lobby — RPS Arena") + gameNav(player) + `
  <div class="container py-4">
    <div class="row justify-content-center">
      <div class="col-lg-8 col-xl-7">

        <!-- Player card -->
        <div class="rps-card mb-4 p-4">
          <div class="d-flex align-items-center gap-3 mb-3">
            <div class="rps-avatar">${esc(player.email[0].toUpperCase())}</div>
            <div>
              <h4 class="mb-0 fw-bold">${esc(player.display_name || player.email.split("@")[0])}</h4>
              <span class="text-muted small">${esc(player.email)}</span>
            </div>
            <div class="ms-auto text-end">
              <div class="h5 mb-0 text-success fw-bold">$${player.wallet_balance.toFixed(2)}</div>
              <small class="text-muted">${player.games_won}W / ${player.games_played}G</small>
            </div>
          </div>
        </div>

        <!-- Matchmaking -->
        <div class="rps-card text-center p-5" id="matchSection">
          <div id="findMatch">
            <div class="rps-hero-icons mb-3" style="font-size:2.5rem;">
              <span>&#9994;</span> <span>&#9995;</span> <span>&#9996;&#65039;</span>
            </div>
            <h3 class="fw-bold mb-2">Ready to Play?</h3>
            <p class="text-muted mb-4">Find an opponent for a best-of-3 match. If you fall behind 0-2, you can pay $1 to extend to best-of-7!</p>
            <button class="btn btn-rps btn-lg px-5" id="findMatchBtn">
              <i class="bi bi-search me-2"></i>Find Match
            </button>
          </div>
          <div id="searching" style="display:none;">
            <div class="rps-searching mb-3">
              <div class="spinner-grow text-primary" role="status"></div>
            </div>
            <h4 class="fw-bold mb-2">Searching for opponent...</h4>
            <p class="text-muted mb-4" id="waitMsg">Waiting for another player to join</p>
            <button class="btn btn-outline-secondary" id="cancelBtn">Cancel</button>
          </div>
        </div>

        <!-- Recent games -->
        <div class="rps-card mt-4 overflow-hidden">
          <div class="rps-card-header">
            <i class="bi bi-clock-history me-2"></i>How to Play
          </div>
          <div class="p-4">
            <div class="row g-3">
              <div class="col-md-4 text-center">
                <div class="fs-1 mb-2">&#127919;</div>
                <h6 class="fw-bold">1. Find a Match</h6>
                <p class="small text-muted mb-0">Click "Find Match" and wait for an opponent to join from anywhere in the world.</p>
              </div>
              <div class="col-md-4 text-center">
                <div class="fs-1 mb-2">&#9994;&#9995;&#9996;&#65039;</div>
                <h6 class="fw-bold">2. Play Best of 3</h6>
                <p class="small text-muted mb-0">Pick rock, paper, or scissors each round. First to 2 wins takes the match!</p>
              </div>
              <div class="col-md-4 text-center">
                <div class="fs-1 mb-2">&#128176;</div>
                <h6 class="fw-bold">3. Extend to Bo7</h6>
                <p class="small text-muted mb-0">Down 0-2? Pay $1 to extend the match to best-of-7 and stage a comeback!</p>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>` + gameFoot(`
<script>
(function() {
  const findMatchBtn = document.getElementById('findMatchBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const findMatchDiv = document.getElementById('findMatch');
  const searchingDiv = document.getElementById('searching');
  let evtSource = null;

  findMatchBtn.addEventListener('click', async () => {
    findMatchDiv.style.display = 'none';
    searchingDiv.style.display = '';

    try {
      const resp = await fetch('/matchmake', { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok) {
        alert(data.error || 'Matchmaking error');
        findMatchDiv.style.display = '';
        searchingDiv.style.display = 'none';
        return;
      }

      // Connect to matchmaking SSE
      evtSource = new EventSource('/matchmake/events');
      evtSource.addEventListener('matched', (e) => {
        const d = JSON.parse(e.data);
        evtSource.close();
        window.location.href = '/game/' + d.gameId;
      });
      evtSource.addEventListener('cancelled', () => {
        evtSource.close();
        findMatchDiv.style.display = '';
        searchingDiv.style.display = 'none';
      });
      evtSource.addEventListener('error', () => {
        // Reconnect or show error handled by browser
      });
    } catch (err) {
      alert('Network error');
      findMatchDiv.style.display = '';
      searchingDiv.style.display = 'none';
    }
  });

  cancelBtn.addEventListener('click', async () => {
    if (evtSource) evtSource.close();
    await fetch('/matchmake/cancel', { method: 'POST' });
    findMatchDiv.style.display = '';
    searchingDiv.style.display = 'none';
  });
})();
</script>`);
}

// ── Page: Game ───────────────────────────────────────────
function pageGame(game, player, opponent, rounds) {
  const isP1 = player.id === game.player1_id;
  const score = getGameScoreFromDb(game.id, game);

  return gameHead(`Game #${game.id} — RPS Arena`) + gameNav(player) + `
  <div class="container py-4">
    <div class="row justify-content-center">
      <div class="col-lg-9 col-xl-8">

        <!-- Scoreboard -->
        <div class="rps-card mb-4 overflow-hidden">
          <div class="rps-scoreboard">
            <div class="rps-player-score ${isP1 ? 'rps-you' : ''}">
              <div class="rps-score-name">${isP1 ? 'You' : esc(opponent.display_name || opponent.email.split("@")[0])}</div>
              <div class="rps-score-num" id="p1score">${score.p1}</div>
            </div>
            <div class="rps-vs">
              <div class="small text-muted">Best of</div>
              <div class="fw-bold fs-4" id="bestOf">${game.best_of}</div>
              <div class="small text-muted" id="gameStatus">${game.status === "playing" ? "In Progress" : game.status === "extend_offer" ? "Extend Offered" : "Finished"}</div>
            </div>
            <div class="rps-player-score ${!isP1 ? 'rps-you' : ''}">
              <div class="rps-score-name">${!isP1 ? 'You' : esc(opponent.display_name || opponent.email.split("@")[0])}</div>
              <div class="rps-score-num" id="p2score">${score.p2}</div>
            </div>
          </div>
        </div>

        <!-- Move selection -->
        <div class="rps-card mb-4 p-4 text-center" id="moveSection">
          <div id="pickMove" ${game.status !== "playing" ? 'style="display:none;"' : ""}>
            <h4 class="fw-bold mb-3">Choose your move!</h4>
            <div class="rps-moves">
              <button class="rps-move-btn" data-move="rock" title="Rock">
                <span class="rps-move-emoji">&#9994;</span>
                <span class="rps-move-label">Rock</span>
              </button>
              <button class="rps-move-btn" data-move="paper" title="Paper">
                <span class="rps-move-emoji">&#9995;</span>
                <span class="rps-move-label">Paper</span>
              </button>
              <button class="rps-move-btn" data-move="scissors" title="Scissors">
                <span class="rps-move-emoji">&#9996;&#65039;</span>
                <span class="rps-move-label">Scissors</span>
              </button>
            </div>
          </div>
          <div id="waitingMove" style="display:none;">
            <div class="spinner-border text-primary mb-3"></div>
            <h5 class="fw-bold">Waiting for opponent's move...</h5>
            <p class="text-muted small">You chose: <strong id="yourMoveText"></strong></p>
          </div>
          <div id="roundResult" style="display:none;">
            <div class="rps-round-result mb-3">
              <span class="rps-result-move" id="resultYou"></span>
              <span class="rps-result-vs">vs</span>
              <span class="rps-result-move" id="resultOpp"></span>
            </div>
            <h4 class="fw-bold" id="roundVerdict"></h4>
            <button class="btn btn-rps mt-3" id="nextRoundBtn" style="display:none;">Next Round</button>
          </div>
          <div id="extendOffer" style="display:none;">
            <h4 class="fw-bold mb-2">&#128176; Extend to Best of 7?</h4>
            <p class="text-muted" id="extendMsg"></p>
            <div class="d-flex justify-content-center gap-3">
              <button class="btn btn-rps btn-lg" id="extendYesBtn">Pay $1.00 & Continue</button>
              <button class="btn btn-outline-secondary btn-lg" id="extendNoBtn">Accept Defeat</button>
            </div>
          </div>
          <div id="extendWait" style="display:none;">
            <div class="spinner-border text-warning mb-3"></div>
            <h5 class="fw-bold">Opponent is deciding whether to extend...</h5>
            <p class="text-muted small">They can pay $1.00 to extend the match to best-of-7.</p>
          </div>
          <div id="gameOver" ${game.status !== "finished" ? 'style="display:none;"' : ""}>
            <div class="fs-1 mb-2" id="gameOverEmoji">&#127942;</div>
            <h3 class="fw-bold" id="gameOverMsg">${game.status === "finished" ? (game.winner_id === player.id ? "You Won!" : "You Lost!") : ""}</h3>
            <p class="text-muted" id="gameOverDetail"></p>
            <a href="/lobby" class="btn btn-rps btn-lg mt-3"><i class="bi bi-arrow-left me-2"></i>Back to Lobby</a>
          </div>
        </div>

        <!-- Round history -->
        <div class="rps-card overflow-hidden">
          <div class="rps-card-header">
            <i class="bi bi-list-ol me-2"></i>Round History
          </div>
          <div class="p-3" id="roundHistory">
            ${rounds.length === 0 ? '<p class="text-muted text-center small py-3 mb-0">No rounds played yet</p>' :
              rounds.map(r => {
                const yourMove = isP1 ? r.player1_move : r.player2_move;
                const oppMove = isP1 ? r.player2_move : r.player1_move;
                const result = r.is_draw ? 'Draw' : (r.winner_id === player.id ? 'Won' : 'Lost');
                const emoji = moveEmoji(yourMove);
                const oppEmoji = moveEmoji(oppMove);
                const badge = r.is_draw ? 'bg-secondary' : (r.winner_id === player.id ? 'bg-success' : 'bg-danger');
                return `<div class="rps-round-row">
                  <span class="fw-bold small">R${r.round_number}</span>
                  <span>${emoji} vs ${oppEmoji}</span>
                  <span class="badge ${badge}">${result}</span>
                </div>`;
              }).join("")}
          </div>
        </div>

      </div>
    </div>
  </div>` + gameFoot(`
<script>
(function() {
  const gameId = ${game.id};
  const playerId = ${player.id};
  const isP1 = ${isP1};
  const moveEmojis = { rock: '\\u270A', paper: '\\u270B', scissors: '\\u270C\\uFE0F' };

  // Elements
  const pickMove = document.getElementById('pickMove');
  const waitingMove = document.getElementById('waitingMove');
  const roundResult = document.getElementById('roundResult');
  const extendOffer = document.getElementById('extendOffer');
  const extendWait = document.getElementById('extendWait');
  const gameOver = document.getElementById('gameOver');
  const p1score = document.getElementById('p1score');
  const p2score = document.getElementById('p2score');
  const bestOf = document.getElementById('bestOf');
  const gameStatus = document.getElementById('gameStatus');
  const roundHistory = document.getElementById('roundHistory');

  function hideAllSections() {
    pickMove.style.display = 'none';
    waitingMove.style.display = 'none';
    roundResult.style.display = 'none';
    extendOffer.style.display = 'none';
    extendWait.style.display = 'none';
    gameOver.style.display = 'none';
  }

  // SSE connection
  const evtSource = new EventSource('/game/' + gameId + '/events');

  evtSource.addEventListener('move_accepted', () => {
    hideAllSections();
    waitingMove.style.display = '';
  });

  evtSource.addEventListener('round_result', (e) => {
    const d = JSON.parse(e.data);
    hideAllSections();
    roundResult.style.display = '';

    const yourMove = isP1 ? d.player1_move : d.player2_move;
    const oppMove = isP1 ? d.player2_move : d.player1_move;

    document.getElementById('resultYou').textContent = moveEmojis[yourMove] || yourMove;
    document.getElementById('resultOpp').textContent = moveEmojis[oppMove] || oppMove;

    p1score.textContent = d.score.p1;
    p2score.textContent = d.score.p2;

    const myScore = isP1 ? d.score.p1 : d.score.p2;
    const oppScore = isP1 ? d.score.p2 : d.score.p1;

    if (d.isDraw) {
      document.getElementById('roundVerdict').textContent = "It's a draw!";
      document.getElementById('roundVerdict').className = 'fw-bold text-secondary';
    } else if (d.winnerId === playerId) {
      document.getElementById('roundVerdict').textContent = 'You won this round!';
      document.getElementById('roundVerdict').className = 'fw-bold text-success';
    } else {
      document.getElementById('roundVerdict').textContent = 'You lost this round!';
      document.getElementById('roundVerdict').className = 'fw-bold text-danger';
    }

    // Add to round history
    const badge = d.isDraw ? 'bg-secondary' : (d.winnerId === playerId ? 'bg-success' : 'bg-danger');
    const result = d.isDraw ? 'Draw' : (d.winnerId === playerId ? 'Won' : 'Lost');
    const placeholder = roundHistory.querySelector('.text-muted.text-center');
    if (placeholder) placeholder.remove();
    roundHistory.innerHTML += '<div class="rps-round-row"><span class="fw-bold small">R' + d.roundNumber +
      '</span><span>' + (moveEmojis[yourMove]||yourMove) + ' vs ' + (moveEmojis[oppMove]||oppMove) +
      '</span><span class="badge ' + badge + '">' + result + '</span></div>';

    // Show next round button if game continues
    if (!d.gameOver) {
      document.getElementById('nextRoundBtn').style.display = '';
    }
  });

  evtSource.addEventListener('extend_offer', (e) => {
    const d = JSON.parse(e.data);
    hideAllSections();
    if (d.loserId === playerId) {
      extendOffer.style.display = '';
      document.getElementById('extendMsg').textContent =
        'You are down ' + (isP1 ? d.score.p1 : d.score.p2) + '-' + (isP1 ? d.score.p2 : d.score.p1) +
        '. Pay $1.00 to extend to best-of-7. ($0.90 goes to opponent, $0.10 platform fee)';
    } else {
      extendWait.style.display = '';
    }
  });

  evtSource.addEventListener('game_extended', (e) => {
    const d = JSON.parse(e.data);
    hideAllSections();
    pickMove.style.display = '';
    bestOf.textContent = d.bestOf;
    gameStatus.textContent = 'In Progress';
  });

  evtSource.addEventListener('game_over', (e) => {
    const d = JSON.parse(e.data);
    hideAllSections();
    gameOver.style.display = '';
    p1score.textContent = d.score.p1;
    p2score.textContent = d.score.p2;
    gameStatus.textContent = 'Finished';

    if (d.winnerId === playerId) {
      document.getElementById('gameOverEmoji').textContent = '\\u{1F3C6}';
      document.getElementById('gameOverMsg').textContent = 'You Won!';
      document.getElementById('gameOverMsg').className = 'fw-bold text-success';
    } else {
      document.getElementById('gameOverEmoji').textContent = '\\u{1F614}';
      document.getElementById('gameOverMsg').textContent = 'You Lost!';
      document.getElementById('gameOverMsg').className = 'fw-bold text-danger';
    }
    document.getElementById('gameOverDetail').textContent =
      'Final score: ' + (isP1 ? d.score.p1 : d.score.p2) + ' - ' + (isP1 ? d.score.p2 : d.score.p1);
    evtSource.close();
  });

  evtSource.addEventListener('opponent_disconnected', () => {
    hideAllSections();
    gameOver.style.display = '';
    document.getElementById('gameOverEmoji').textContent = '\\u{1F44B}';
    document.getElementById('gameOverMsg').textContent = 'Opponent disconnected';
    document.getElementById('gameOverMsg').className = 'fw-bold text-warning';
    evtSource.close();
  });

  evtSource.addEventListener('next_round', () => {
    hideAllSections();
    pickMove.style.display = '';
  });

  // Move selection
  document.querySelectorAll('.rps-move-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const move = btn.dataset.move;
      document.querySelectorAll('.rps-move-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      document.getElementById('yourMoveText').textContent = move.charAt(0).toUpperCase() + move.slice(1);

      hideAllSections();
      waitingMove.style.display = '';

      await fetch('/game/' + gameId + '/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ move }),
      });
    });
  });

  // Next round button
  document.getElementById('nextRoundBtn').addEventListener('click', () => {
    hideAllSections();
    pickMove.style.display = '';
    document.getElementById('nextRoundBtn').style.display = 'none';
  });

  // Extend buttons
  document.getElementById('extendYesBtn').addEventListener('click', async () => {
    const resp = await fetch('/game/' + gameId + '/extend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept: true }),
    });
    const data = await resp.json();
    if (!resp.ok) alert(data.error || 'Extension failed');
  });

  document.getElementById('extendNoBtn').addEventListener('click', async () => {
    await fetch('/game/' + gameId + '/extend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accept: false }),
    });
  });
})();
</script>`);
}

function moveEmoji(move) {
  const map = { rock: "\u270A", paper: "\u270B", scissors: "\u270C\uFE0F" };
  return map[move] || move || "?";
}

// ── Page: Profile ────────────────────────────────────────
function pageProfile(player) {
  const txns = stmtGetTx.all(player.id);
  return gameHead("Profile — RPS Arena") + gameNav(player) + `
  <div class="container py-4">
    <div class="row justify-content-center">
      <div class="col-lg-8 col-xl-7">
        <div class="rps-card p-4 mb-4">
          <div class="d-flex align-items-center gap-3 mb-4">
            <div class="rps-avatar rps-avatar-lg">${esc(player.email[0].toUpperCase())}</div>
            <div>
              <h3 class="mb-0 fw-bold">${esc(player.display_name || player.email.split("@")[0])}</h3>
              <span class="text-muted">${esc(player.email)}</span>
            </div>
          </div>
          <div class="row g-3 text-center">
            <div class="col-4">
              <div class="h4 fw-bold text-success mb-0">$${player.wallet_balance.toFixed(2)}</div>
              <small class="text-muted">Wallet Balance</small>
            </div>
            <div class="col-4">
              <div class="h4 fw-bold mb-0">${player.games_played}</div>
              <small class="text-muted">Games Played</small>
            </div>
            <div class="col-4">
              <div class="h4 fw-bold text-primary mb-0">${player.games_won}</div>
              <small class="text-muted">Games Won</small>
            </div>
          </div>
        </div>
        <div class="rps-card overflow-hidden">
          <div class="rps-card-header"><i class="bi bi-receipt me-2"></i>Transaction History</div>
          <div class="p-3">
            ${txns.length === 0 ? '<p class="text-muted text-center small py-3 mb-0">No transactions yet</p>' :
              txns.map(t => `
                <div class="rps-tx-row">
                  <span class="badge ${t.amount > 0 ? "bg-success" : "bg-danger"} me-2">${t.amount > 0 ? "+" : ""}$${t.amount.toFixed(2)}</span>
                  <span class="small">${esc(t.description || t.type)}</span>
                  <span class="text-muted small ms-auto">${esc(t.created_at)}</span>
                </div>`).join("")}
          </div>
        </div>
      </div>
    </div>
  </div>` + gameFoot();
}

// ── Page: Leaderboard ────────────────────────────────────
function pageLeaderboard(player) {
  const rows = stmtLeaderboard.all();
  return gameHead("Leaderboard — RPS Arena") + gameNav(player) + `
  <div class="container py-4">
    <div class="row justify-content-center">
      <div class="col-lg-8 col-xl-7">
        <div class="rps-card overflow-hidden">
          <div class="rps-card-header"><i class="bi bi-trophy me-2"></i>Top Players</div>
          <div class="table-responsive">
            <table class="table table-hover mb-0 align-middle">
              <thead class="table-light">
                <tr><th>#</th><th>Player</th><th>Won</th><th>Played</th><th>Win %</th></tr>
              </thead>
              <tbody>
                ${rows.length === 0 ? '<tr><td colspan="5" class="text-center text-muted py-4">No players yet</td></tr>' :
                  rows.map((r, i) => {
                    const pct = r.games_played > 0 ? Math.round(r.games_won / r.games_played * 100) : 0;
                    const medal = i === 0 ? "&#129351;" : i === 1 ? "&#129352;" : i === 2 ? "&#129353;" : (i + 1);
                    return `<tr${r.id === player.id ? ' class="table-warning"' : ''}>
                      <td>${medal}</td>
                      <td>${esc(r.display_name || r.email.split("@")[0])}</td>
                      <td class="fw-bold">${r.games_won}</td>
                      <td>${r.games_played}</td>
                      <td><span class="badge bg-primary">${pct}%</span></td>
                    </tr>`;
                  }).join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>` + gameFoot();
}

// ═══════════════════════════════════════════════════════════
// ── HTTP Server ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const method   = req.method.toUpperCase();

  try {
    // ── Static files ──────────────────────────────────────
    if (pathname.startsWith("/static/")) {
      const filePath = path.join(STATIC_DIR, pathname.slice("/static/".length));
      const ext = path.extname(filePath);
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
      });
      return;
    }

    // ── GET / — Landing / Login ───────────────────────────
    if (pathname === "/" && method === "GET") {
      const sess = getSession(req);
      if (sess) { res.writeHead(302, { Location: "/lobby" }); res.end(); return; }
      htmlResponse(res, pageLogin());
      return;
    }

    // ── POST /auth/send-code ──────────────────────────────
    if (pathname === "/auth/send-code" && method === "POST") {
      const body = await parseBody(req);
      const email = (body.email || "").trim().toLowerCase();

      if (!email || !email.includes("@")) {
        return jsonErr(res, "Please enter a valid email address.");
      }

      // Generate 6-digit code
      const code = String(crypto.randomInt(100000, 999999));
      verifyStore.set(email, { code, expiresAt: Date.now() + CODE_EXPIRY, attempts: 0 });

      const result = await sendVerificationEmail(email, code);

      if (result.devMode) {
        return jsonOk(res, { ok: true, devMode: true, code: result.code });
      }
      return jsonOk(res, { ok: true });
    }

    // ── POST /auth/verify ─────────────────────────────────
    if (pathname === "/auth/verify" && method === "POST") {
      const body = await parseBody(req);
      const email = (body.email || "").trim().toLowerCase();
      const code  = (body.code || "").trim();

      const stored = verifyStore.get(email);
      if (!stored) {
        return jsonErr(res, "No verification code found. Please request a new one.");
      }
      if (stored.expiresAt < Date.now()) {
        verifyStore.delete(email);
        return jsonErr(res, "Code expired. Please request a new one.");
      }
      if (stored.attempts >= 5) {
        verifyStore.delete(email);
        return jsonErr(res, "Too many attempts. Please request a new code.");
      }
      stored.attempts++;

      if (stored.code !== code) {
        return jsonErr(res, `Invalid code. ${5 - stored.attempts} attempts remaining.`);
      }

      verifyStore.delete(email);

      // Get or create player
      let player = stmtGetPlayer.get(email);
      if (!player) {
        stmtInsertPlayer.run(email, email.split("@")[0]);
        player = stmtGetPlayer.get(email);
      }

      const sessionId = createSession({ playerId: player.id, email: player.email });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": sessionCookie(sessionId),
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── GET /logout ───────────────────────────────────────
    if (pathname === "/logout" && method === "GET") {
      const cookieHeader = req.headers.cookie || "";
      const match = cookieHeader.match(/(?:^|;\s*)rps_session=([a-f0-9]{64})/);
      if (match) sessions.delete(match[1]);
      res.writeHead(302, { Location: "/", "Set-Cookie": clearSessionCookie() });
      res.end();
      return;
    }

    // ── Auth guard ─────────────────────────────────────────
    const sess = getSession(req);
    if (!sess) {
      if (method === "GET") { res.writeHead(302, { Location: "/" }); res.end(); return; }
      return jsonErr(res, "Not authenticated", 401);
    }

    const player = stmtGetPlayerById.get(sess.playerId);
    if (!player) {
      res.writeHead(302, { Location: "/", "Set-Cookie": clearSessionCookie() });
      res.end();
      return;
    }

    // ── GET /lobby ────────────────────────────────────────
    if (pathname === "/lobby" && method === "GET") {
      htmlResponse(res, pageLobby(player));
      return;
    }

    // ── GET /profile ──────────────────────────────────────
    if (pathname === "/profile" && method === "GET") {
      htmlResponse(res, pageProfile(player));
      return;
    }

    // ── GET /leaderboard ──────────────────────────────────
    if (pathname === "/leaderboard" && method === "GET") {
      htmlResponse(res, pageLeaderboard(player));
      return;
    }

    // ── POST /matchmake — Join the queue ──────────────────
    if (pathname === "/matchmake" && method === "POST") {
      // Remove if already in queue
      matchQueue = matchQueue.filter(q => q.playerId !== player.id);

      // Check if another player is waiting
      if (matchQueue.length > 0) {
        const opponent = matchQueue.shift();

        // Create a game
        const result = stmtInsertGame.run(opponent.playerId, player.id);
        const gameId = Number(result.lastInsertRowid);

        // Notify the waiting opponent via SSE
        if (opponent.sseRes) {
          sseSend(opponent.sseRes, "matched", { gameId, opponentEmail: player.email });
          try { opponent.sseRes.end(); } catch (_) {}
        }

        return jsonOk(res, { matched: true, gameId });
      }

      // Add to queue (SSE will be connected separately)
      matchQueue.push({ playerId: player.id, email: player.email, sseRes: null, joinedAt: Date.now() });
      return jsonOk(res, { queued: true });
    }

    // ── GET /matchmake/events — SSE for waiting in queue ──
    if (pathname === "/matchmake/events" && method === "GET") {
      sseSetup(res);

      // Find this player in the queue and attach SSE
      const entry = matchQueue.find(q => q.playerId === player.id);
      if (entry) {
        entry.sseRes = res;
      }

      req.on("close", () => {
        // Don't remove from queue on SSE close (could be reconnect)
      });
      return;
    }

    // ── POST /matchmake/cancel ────────────────────────────
    if (pathname === "/matchmake/cancel" && method === "POST") {
      const entry = matchQueue.find(q => q.playerId === player.id);
      if (entry && entry.sseRes) {
        sseSend(entry.sseRes, "cancelled", {});
        try { entry.sseRes.end(); } catch (_) {}
      }
      matchQueue = matchQueue.filter(q => q.playerId !== player.id);
      return jsonOk(res, { ok: true });
    }

    // ── Game routes: /game/:id/* ──────────────────────────
    const gameMatch = pathname.match(/^\/game\/(\d+)(\/.*)?$/);
    if (gameMatch) {
      const gameId = parseInt(gameMatch[1], 10);
      const sub    = gameMatch[2] || "";
      const game   = stmtGetGame.get(gameId);

      if (!game) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(gameHead("Not Found") + gameNav(player) +
          '<div class="container py-5 text-center"><h2>Game not found</h2><a href="/lobby" class="btn btn-rps mt-3">Back to Lobby</a></div>' + gameFoot());
        return;
      }

      // Verify player is in this game
      const isP1 = player.id === game.player1_id;
      const isP2 = player.id === game.player2_id;
      if (!isP1 && !isP2) {
        return jsonErr(res, "You are not in this game", 403);
      }

      const opponentId = isP1 ? game.player2_id : game.player1_id;
      const opponent = stmtGetPlayerById.get(opponentId);

      // GET /game/:id — Game page
      if (sub === "" && method === "GET") {
        const rounds = stmtGetRounds.all(gameId);
        htmlResponse(res, pageGame(game, player, opponent, rounds));
        return;
      }

      // GET /game/:id/events — SSE stream
      if (sub === "/events" && method === "GET") {
        sseSetup(res);

        if (!gameStreams.has(gameId)) gameStreams.set(gameId, new Map());
        gameStreams.get(gameId).set(player.id, res);

        req.on("close", () => {
          const streams = gameStreams.get(gameId);
          if (streams) {
            streams.delete(player.id);
            // Notify opponent of disconnect if game is active
            if (game.status === "playing" || game.status === "extend_offer") {
              for (const [, oppRes] of streams) {
                sseSend(oppRes, "opponent_disconnected", {});
              }
            }
          }
        });
        return;
      }

      // POST /game/:id/move — Submit a move
      if (sub === "/move" && method === "POST") {
        const body = await parseBody(req);
        const move = (body.move || "").toLowerCase();

        if (!MOVES.includes(move)) {
          return jsonErr(res, "Invalid move. Choose rock, paper, or scissors.");
        }

        if (game.status !== "playing") {
          return jsonErr(res, "Game is not in progress.");
        }

        // Store pending move
        if (!pendingMoves.has(gameId)) pendingMoves.set(gameId, new Map());
        const moves = pendingMoves.get(gameId);
        moves.set(player.id, move);

        // Notify this player's SSE that move was accepted
        const streams = gameStreams.get(gameId);
        if (streams && streams.has(player.id)) {
          sseSend(streams.get(player.id), "move_accepted", { move });
        }

        // Check if both players have moved
        if (moves.has(game.player1_id) && moves.has(game.player2_id)) {
          const p1move = moves.get(game.player1_id);
          const p2move = moves.get(game.player2_id);
          moves.clear();

          const rounds = stmtGetRounds.all(gameId);
          const roundNumber = rounds.length + 1;

          const result = resolveRound(p1move, p2move);
          const isDraw = result === "draw";
          let winnerId = null;
          if (result === "player1") winnerId = game.player1_id;
          else if (result === "player2") winnerId = game.player2_id;

          stmtInsertRound.run(gameId, roundNumber, p1move, p2move, winnerId, isDraw ? 1 : 0);

          // Calculate updated score
          const score = getGameScoreFromDb(gameId, game);
          const needed = winsNeeded(game.best_of);

          const roundData = {
            roundNumber,
            player1_move: p1move,
            player2_move: p2move,
            winnerId,
            isDraw,
            score,
            gameOver: false,
          };

          // Check if someone won the match
          if (score.p1 >= needed || score.p2 >= needed) {
            const matchWinnerId = score.p1 >= needed ? game.player1_id : game.player2_id;
            roundData.gameOver = true;

            stmtUpdateGame.run("finished", matchWinnerId, game.best_of, gameId);
            stmtIncrPlayed.run(game.player1_id);
            stmtIncrPlayed.run(game.player2_id);
            stmtIncrWon.run(matchWinnerId);

            broadcastGame(gameId, "round_result", roundData);
            // Small delay then send game_over
            setTimeout(() => {
              broadcastGame(gameId, "game_over", { winnerId: matchWinnerId, score });
            }, 1500);
          }
          // Check for extend offer: if it's best-of-3 and someone is at 0-2
          else if (game.best_of === 3 && (score.p1 === 0 && score.p2 === 2 || score.p1 === 2 && score.p2 === 0)) {
            const loserId = score.p1 === 0 ? game.player1_id : game.player2_id;
            stmtUpdateGame.run("extend_offer", null, game.best_of, gameId);

            broadcastGame(gameId, "round_result", roundData);
            setTimeout(() => {
              broadcastGame(gameId, "extend_offer", { loserId, score });
            }, 1500);
          }
          else {
            broadcastGame(gameId, "round_result", roundData);
          }
        }

        return jsonOk(res, { ok: true });
      }

      // POST /game/:id/extend — Accept or reject extension
      if (sub === "/extend" && method === "POST") {
        const body = await parseBody(req);
        const accept = body.accept === true || body.accept === "true";

        // Refresh game state
        const freshGame = stmtGetGame.get(gameId);
        if (freshGame.status !== "extend_offer") {
          return jsonErr(res, "No extension offer is active.");
        }

        const score = getGameScoreFromDb(gameId, freshGame);
        const loserId = score.p1 === 0 ? freshGame.player1_id : freshGame.player2_id;

        // Only the losing player can extend
        if (player.id !== loserId) {
          return jsonErr(res, "Only the losing player can choose to extend.");
        }

        if (!accept) {
          // Player declines — game ends
          const matchWinnerId = loserId === freshGame.player1_id ? freshGame.player2_id : freshGame.player1_id;
          stmtUpdateGame.run("finished", matchWinnerId, freshGame.best_of, gameId);
          stmtIncrPlayed.run(freshGame.player1_id);
          stmtIncrPlayed.run(freshGame.player2_id);
          stmtIncrWon.run(matchWinnerId);

          broadcastGame(gameId, "game_over", { winnerId: matchWinnerId, score });
          return jsonOk(res, { ok: true, declined: true });
        }

        // Player accepts — check wallet
        const loser = stmtGetPlayerById.get(loserId);
        if (loser.wallet_balance < EXTEND_COST) {
          return jsonErr(res, `Insufficient balance. You need $${EXTEND_COST.toFixed(2)} but have $${loser.wallet_balance.toFixed(2)}.`);
        }

        const winnerId = loserId === freshGame.player1_id ? freshGame.player2_id : freshGame.player1_id;

        // Process payment: $1 from loser, $0.90 to winner, $0.10 platform fee
        const payout = EXTEND_COST - (EXTEND_COST * PLATFORM_FEE);
        stmtUpdateWallet.run(-EXTEND_COST, loserId);
        stmtUpdateWallet.run(payout, winnerId);

        stmtInsertTx.run(loserId, -EXTEND_COST, "extend_payment", "Paid to extend game to Bo7", gameId);
        stmtInsertTx.run(winnerId, payout, "extend_received", "Received extension payment (after 10% fee)", gameId);

        // Update game to best-of-7 and resume playing
        stmtUpdateGame.run("playing", null, 7, gameId);

        broadcastGame(gameId, "game_extended", { bestOf: 7, payerId: loserId });

        return jsonOk(res, { ok: true, extended: true, newBestOf: 7 });
      }

      // Fallback for unknown game sub-routes
      return jsonErr(res, "Not found", 404);
    }

    // ── Default 404 ───────────────────────────────────────
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end(gameHead("Not Found") + gameNav(player) +
      '<div class="container py-5 text-center"><h2>Page not found</h2><a href="/lobby" class="btn btn-rps mt-3">Back to Lobby</a></div>' + gameFoot());

  } catch (err) {
    console.error("Server error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   RPS Arena — Rock Paper Scissors            ║
║   http://localhost:${PORT}                      ║
╚══════════════════════════════════════════════╝
  `);
});
