// InfiniCanvas on Cloudflare Workers — port of server.js (Express + ws + Redis).
//
// One Durable Object (class Canvas, name "main") is the shared canvas: it holds the op log and timelapse snapshots in
// its SQLite storage (instead of Redis) and every browser's WebSocket (hibernation API, so idle sockets cost nothing).
// The Worker serves frontend/dist and forwards /api/*, /health and WebSocket upgrades (the client connects to "/")
// to that object. Same REST endpoints, same WebSocket messages, same validation and rate limit as server.js.
//
// Differences, on purpose:
//   * POST /api/clear needs CLEAR_SECRET; with it unset nobody can clear (server.js let anyone clear then).
//   * POST /api/import (one-time migration of the Redis op log) only works while IMPORT_TOKEN is set and the canvas
//     is empty.
import gifenc from 'gifenc'; // CommonJS package: default import works in both node --test and wrangler's bundler
import { decodePng } from './png.js';

const { GIFEncoder, quantize, applyPalette } = gifenc;

// ── Input validation (same as server.js) ─────────────────────────────────────
const VALID_OP_TYPES = new Set(['stroke', 'line', 'rect', 'circle', 'text']);
const CANVAS_MAX = 65536;

function isNum(v) { return typeof v === 'number' && isFinite(v); }
function inBounds(v) { return isNum(v) && v >= -CANVAS_MAX && v <= CANVAS_MAX * 2; }
function isColor(v) { return typeof v === 'string' && v.length <= 25; }
function isSize(v) { return isNum(v) && v >= 1 && v <= 500; }

export function validateOp(op) {
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

// ── Tile indexing (mirrors frontend/src/components/CanvasBoard.jsx tile math) ─
const TILE_SIZE = 1024;
const TILES_X   = CANVAS_MAX / TILE_SIZE; // 64
const TILES_Y   = CANVAS_MAX / TILE_SIZE; // 64

export function getOpTileBounds(op) {
  const pad = (op.size || op.lineWidth || 2) + 2;
  let minX, minY, maxX, maxY;

  switch (op.type) {
    case 'stroke': {
      if (!op.points?.length) return null;
      minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
      for (const p of op.points) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
      minX -= pad; minY -= pad; maxX += pad; maxY += pad;
      break;
    }
    case 'line':
      minX = Math.min(op.x1, op.x2) - pad; minY = Math.min(op.y1, op.y2) - pad;
      maxX = Math.max(op.x1, op.x2) + pad; maxY = Math.max(op.y1, op.y2) + pad;
      break;
    case 'rect':
      minX = op.x - pad; minY = op.y - pad;
      maxX = op.x + op.w + pad; maxY = op.y + op.h + pad;
      break;
    case 'circle':
      minX = op.cx - Math.abs(op.rx) - pad; minY = op.cy - Math.abs(op.ry) - pad;
      maxX = op.cx + Math.abs(op.rx) + pad; maxY = op.cy + Math.abs(op.ry) + pad;
      break;
    case 'text': {
      const w = (op.text?.length || 1) * op.fontSize * 0.7;
      minX = op.x - 4; minY = op.y - 4; maxX = op.x + w + 4; maxY = op.y + op.fontSize + 4;
      break;
    }
    default:
      return { minTX: 0, minTY: 0, maxTX: TILES_X - 1, maxTY: TILES_Y - 1 };
  }
  return {
    minTX: Math.max(0, Math.floor(minX / TILE_SIZE)),
    minTY: Math.max(0, Math.floor(minY / TILE_SIZE)),
    maxTX: Math.min(TILES_X - 1, Math.floor(maxX / TILE_SIZE)),
    maxTY: Math.min(TILES_Y - 1, Math.floor(maxY / TILE_SIZE)),
  };
}

// ── Snapshots / timelapse ────────────────────────────────────────────────────
const MAX_SNAPSHOTS      = 288;   // 24 h at 5-min intervals
const MAX_GIF_FRAMES     = 100;
const SNAPSHOT_WINDOW_MS = 5 * 60 * 1000;
const SNAPSHOT_TTL_MS    = (86400 + 3600) * 1000; // Redis EXPIRE in server.js
const COOLDOWN_MS        = 80;

export function sampleEvenly(arr, maxLen) {
  if (arr.length <= maxLen) return arr;
  const step = arr.length / maxLen;
  return Array.from({ length: maxLen }, (_, i) => arr[Math.floor(i * step)]);
}

export async function buildGif(pngsBase64) {
  const frames = [];
  for (const b64 of pngsBase64) {
    try {
      frames.push(await decodePng(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
    } catch { /* skip corrupt frame */ }
  }
  if (!frames.length) return null;
  const { width, height } = frames[0];
  const gif = GIFEncoder();
  for (const frame of frames) {
    if (frame.width !== width || frame.height !== height) continue;
    const palette = quantize(frame.data, 256);
    const index = applyPalette(frame.data, palette);
    gif.writeFrame(index, width, height, { palette, delay: 500 });
  }
  gif.finish();
  return gif.bytes();
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...headers } });

// ── the canvas (Durable Object) ──────────────────────────────────────────────
export class Canvas {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(`create table if not exists ops (id integer primary key, op text not null)`);
    this.sql.exec(`create table if not exists snapshots (bucket integer primary key, ts integer not null, png text not null)`);
    this.ops = null;          // in-memory mirror, loaded lazily (the object may have hibernated)
    this.tileIndex = null;    // "tx,ty" -> ops[]
    this.nextId = 1;
    this.sessions = new Map(); // sessionId -> { lastPlacedAt, opCount } (rate limit only)
  }

  load() {
    if (this.ops) return;
    this.ops = [];
    this.tileIndex = new Map();
    for (const row of this.sql.exec('select op from ops order by id')) {
      try { this.addToMemory(JSON.parse(row.op)); } catch { /* skip bad row */ }
    }
    this.nextId = this.ops.length ? Math.max(...this.ops.map((o) => o.id)) + 1 : 1;
  }

  addToMemory(op) {
    this.ops.push(op);
    const b = getOpTileBounds(op);
    if (!b) return;
    for (let tx = b.minTX; tx <= b.maxTX; tx++) {
      for (let ty = b.minTY; ty <= b.maxTY; ty++) {
        const key = `${tx},${ty}`;
        let bucket = this.tileIndex.get(key);
        if (!bucket) { bucket = []; this.tileIndex.set(key, bucket); }
        bucket.push(op);
      }
    }
  }

  sockets() {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === 1);
  }

  broadcastAll(msg) {
    for (const ws of this.sockets()) { try { ws.send(msg); } catch { /* closing */ } }
  }

  pushOnlineCount() {
    this.broadcastAll(JSON.stringify({ type: 'online', count: this.sockets().length }));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.headers.get('Upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: 'online', count: this.sockets().length }));
      this.pushOnlineCount();
      return new Response(null, { status: 101, webSocket: client });
    }

    if (path === '/health') {
      this.load();
      return json({ status: 'ok', clients: this.sockets().length, ops: this.ops.length });
    }

    if (path === '/api/canvas' && request.method === 'GET') {
      this.load();
      return new Response(JSON.stringify(this.ops), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
    }

    if (path === '/api/canvas/tile' && request.method === 'GET') {
      const tx = Number(url.searchParams.get('tx'));
      const ty = Number(url.searchParams.get('ty'));
      if (!Number.isInteger(tx) || !Number.isInteger(ty) || tx < 0 || tx >= TILES_X || ty < 0 || ty >= TILES_Y) {
        return json({ error: 'Invalid tile coordinates' }, 400);
      }
      this.load();
      return json(this.tileIndex.get(`${tx},${ty}`) || [], 200, { 'Cache-Control': 'no-store' });
    }

    if (path === '/api/snapshots' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { png, timestamp } = body || {};
      if (!png || typeof png !== 'string' || png.length > 2_000_000) return json({ error: 'Invalid snapshot' }, 400);
      const ts = (typeof timestamp === 'number' && isFinite(timestamp)) ? timestamp : Date.now();
      const bucket = Math.floor(ts / SNAPSHOT_WINDOW_MS);
      // SETNX: first snapshot in each 5-minute window wins.
      this.sql.exec('insert or ignore into snapshots (bucket, ts, png) values (?, ?, ?)', bucket, ts, png);
      this.sql.exec('delete from snapshots where ts < ?', Date.now() - SNAPSHOT_TTL_MS);
      this.sql.exec(`delete from snapshots where bucket not in (select bucket from snapshots order by bucket desc limit ${MAX_SNAPSHOTS})`);
      return json({ ok: true });
    }

    if (path === '/api/snapshots/count' && request.method === 'GET') {
      this.sql.exec('delete from snapshots where ts < ?', Date.now() - SNAPSHOT_TTL_MS);
      const [{ n }] = this.sql.exec('select count(*) as n from snapshots').toArray();
      return json({ count: n });
    }

    if (path === '/api/snapshots/gif' && request.method === 'GET') {
      this.sql.exec('delete from snapshots where ts < ?', Date.now() - SNAPSHOT_TTL_MS);
      const buckets = this.sql.exec('select bucket from snapshots order by bucket').toArray().map((r) => r.bucket);
      if (!buckets.length) return json({ error: 'No snapshots yet' }, 404);
      const pngs = sampleEvenly(buckets, MAX_GIF_FRAMES)
        .map((b) => this.sql.exec('select png from snapshots where bucket = ?', b).toArray()[0]?.png)
        .filter(Boolean);
      const gif = await buildGif(pngs);
      if (!gif) return json({ error: 'No valid snapshots' }, 404);
      return new Response(gif, {
        headers: { 'Content-Type': 'image/gif', 'Content-Disposition': 'attachment; filename="infinicanvas-timelapse.gif"', 'Access-Control-Allow-Origin': '*' }
      });
    }

    if (path === '/api/clear' && request.method === 'POST') {
      const { secret } = (await request.json().catch(() => ({}))) || {};
      if (!this.env.CLEAR_SECRET || secret !== this.env.CLEAR_SECRET) return json({ error: 'Forbidden' }, 403);
      this.sql.exec('delete from ops');
      this.ops = null;
      this.sessions = new Map();
      this.load();
      this.broadcastAll(JSON.stringify({ type: 'clear' }));
      return json({ ok: true });
    }

    if (path === '/api/import' && request.method === 'POST') {
      if (!this.env.IMPORT_TOKEN || request.headers.get('X-Import-Token') !== this.env.IMPORT_TOKEN) return json({ error: 'Forbidden' }, 403);
      this.load();
      if (this.ops.length) return json({ error: 'canvas is not empty' }, 409);
      const ops = await request.json().catch(() => null);
      if (!Array.isArray(ops)) return json({ error: 'expected an array of ops' }, 400);
      let imported = 0;
      for (const op of ops) {
        if (!Number.isInteger(op?.id) || !validateOp(op)) continue;
        this.sql.exec('insert or ignore into ops (id, op) values (?, ?)', op.id, JSON.stringify(op));
        imported++;
      }
      this.ops = null;
      this.load();
      return json({ ok: true, imported, ops: this.ops.length });
    }

    return json({ error: 'Not found' }, 404);
  }

  // A draw message from one browser: validate, rate-limit per session, persist, broadcast to everyone.
  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    if (msg.type !== 'draw') return;
    if (!validateOp(msg.op)) return;

    const { op, sessionId } = msg;
    const now = Date.now();
    if (sessionId) {
      const sess = this.sessions.get(sessionId);
      if (sess && now - sess.lastPlacedAt < COOLDOWN_MS) return;
      this.sessions.set(sessionId, { lastPlacedAt: now, opCount: (sess?.opCount ?? 0) + 1 });
    }

    this.load();
    const stored = { id: this.nextId++, sessionId: sessionId || null, ...op };
    this.sql.exec('insert into ops (id, op) values (?, ?)', stored.id, JSON.stringify(stored));
    this.addToMemory(stored);
    this.broadcastAll(JSON.stringify({ type: 'op', op: stored }));
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch { /* already closed */ }
    this.pushOnlineCount();
  }

  async webSocketError() {
    this.pushOnlineCount();
  }
}

// ── Worker entry ─────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
    }
    if (request.headers.get('Upgrade') === 'websocket' || pathname.startsWith('/api/') || pathname === '/health') {
      return env.CANVAS.get(env.CANVAS.idFromName('main')).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};
