const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs   = require('fs');
const path = require('path');
const cors = require('cors');
const Redis = require('ioredis');

// ── Input validation ─────────────────────────────────────────────────────────
const VALID_OP_TYPES = new Set(['stroke', 'line', 'rect', 'circle', 'text']);
const CANVAS_MAX = 2048;

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function inBounds(v) { return isNum(v) && v >= -CANVAS_MAX && v <= CANVAS_MAX * 2; }
function isColor(v) { return typeof v === 'string' && v.length <= 25; }
function isSize(v) { return isNum(v) && v >= 1 && v <= 500; }

function validateOp(op) {
  if (!op || typeof op !== 'object' || !VALID_OP_TYPES.has(op.type)) return false;
  switch (op.type) {
    case 'stroke':
      return Array.isArray(op.points) && op.points.length > 0 && op.points.length <= 10000
        && op.points.every(p => p && isNum(p.x) && isNum(p.y))
        && isColor(op.color) && isSize(op.size);
    case 'line':
      return inBounds(op.x1) && inBounds(op.y1) && inBounds(op.x2) && inBounds(op.y2)
        && isColor(op.color) && isSize(op.size);
    case 'rect':
      return inBounds(op.x) && inBounds(op.y)
        && isNum(op.w) && isNum(op.h) && op.w >= 0 && op.h >= 0
        && op.w <= CANVAS_MAX * 2 && op.h <= CANVAS_MAX * 2
        && isColor(op.color);
    case 'circle':
      return inBounds(op.cx) && inBounds(op.cy)
        && isNum(op.rx) && isNum(op.ry)
        && Math.abs(op.rx) <= CANVAS_MAX && Math.abs(op.ry) <= CANVAS_MAX
        && isColor(op.color);
    case 'text':
      return inBounds(op.x) && inBounds(op.y)
        && typeof op.text === 'string' && op.text.length > 0 && op.text.length <= 1000
        && isColor(op.color) && isSize(op.fontSize);
    default:
      return false;
  }
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── Redis ────────────────────────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URI || process.env.REDIS_URL || 'redis://localhost:6379');

const KEYS = { ops: 'canvas:ops', sessions: 'canvas:sessions' };

// In-memory mirror (loaded on start, updated on every write)
let ops = [];
let opIdCounter = 1;
let sessions = {};

async function loadData() {
  const rawOps = await redis.lrange(KEYS.ops, 0, -1);
  ops = rawOps.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  opIdCounter = ops.length > 0 ? Math.max(...ops.map(o => o.id)) + 1 : 1;

  const rawSessions = await redis.hgetall(KEYS.sessions);
  if (rawSessions) {
    sessions = {};
    for (const [k, v] of Object.entries(rawSessions)) {
      try { sessions[k] = JSON.parse(v); } catch {}
    }
  }
}

async function persistOp(op) {
  await redis.rpush(KEYS.ops, JSON.stringify(op));
}

async function persistSession(sessionId, data) {
  await redis.hset(KEYS.sessions, sessionId, JSON.stringify(data));
}

async function clearStore() {
  ops = [];
  opIdCounter = 1;
  sessions = {};
  await redis.del(KEYS.ops, KEYS.sessions);
}

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));

// ── Static frontend ──────────────────────────────────────────────────────────
const DIST = path.join(__dirname, 'frontend', 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
}

// ── REST API ─────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', clients: wss.clients.size, ops: ops.length })
);

app.get('/api/canvas', (_req, res) => {
  res.json(ops);
});

app.post('/api/clear', async (req, res) => {
  const { secret } = req.body;
  if (process.env.CLEAR_SECRET && secret !== process.env.CLEAR_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await clearStore();
  broadcastAll(JSON.stringify({ type: 'clear' }));
  res.json({ ok: true });
});

// ── WebSocket ────────────────────────────────────────────────────────────────
const COOLDOWN_MS = 80;

function broadcast(sender, msg) {
  for (const client of wss.clients) {
    if (client !== sender && client.readyState === 1) client.send(msg);
  }
}

function broadcastAll(msg) {
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function pushOnlineCount() {
  broadcastAll(JSON.stringify({ type: 'online', count: wss.clients.size }));
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'online', count: wss.clients.size }));
  pushOnlineCount();

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type !== 'draw') return;
    if (!validateOp(msg.op)) return;

    const { op, sessionId } = msg;
    const now = Date.now();

    // Rate limit per session
    if (sessionId) {
      const sess = sessions[sessionId];
      if (sess && now - sess.lastPlacedAt < COOLDOWN_MS) return;
      const updated = { lastPlacedAt: now, opCount: (sess?.opCount ?? 0) + 1 };
      sessions[sessionId] = updated;
      persistSession(sessionId, updated).catch(() => {});
    }

    // Persist and broadcast
    const stored = { id: opIdCounter++, sessionId: sessionId || null, ...op };
    ops.push(stored);
    persistOp(stored).catch(() => {});

    broadcastAll(JSON.stringify({ type: 'op', op: stored }));
  });

  ws.on('close', () => pushOnlineCount());
  ws.on('error', () => { /* socket errors are handled by the close event */ });
});

// SPA fallback — serve index.html for any non-API route
if (fs.existsSync(DIST)) {
  app.get('*', (req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

// ── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown() {
  for (const client of wss.clients) client.terminate();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

loadData()
  .then(() => server.listen(PORT, '0.0.0.0', () =>
    console.log(`✦ InfiniCanvas backend · port ${PORT} · ${ops.length} ops loaded from Redis`)
  ))
  .catch(err => {
    console.error('Failed to load data from Redis:', err.message);
    process.exit(1);
  });
