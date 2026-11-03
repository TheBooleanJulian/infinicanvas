// node --test   The Canvas Durable Object on node:sqlite (standing in for ctx.storage.sql), fake sockets, and the
// PNG → GIF timelapse path with a real PNG made here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Canvas, validateOp, getOpTileBounds, sampleEvenly, buildGif } from './index.js';
import { decodePng } from './png.js';

function fakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sockets = [];
  return {
    sockets,
    getWebSockets: () => sockets,
    acceptWebSocket: (ws) => sockets.push(ws),
    storage: {
      sql: {
        exec(query, ...binds) {
          const stmt = db.prepare(query);
          const rows = /^\s*select/i.test(query) ? stmt.all(...binds) : (stmt.run(...binds), []);
          return Object.assign(rows[Symbol.iterator](), { toArray: () => rows });
        }
      }
    }
  };
}
const ws = () => ({ readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() { this.readyState = 3; } });
const canvas = (env = {}) => { const ctx = fakeCtx(); return { c: new Canvas(ctx, env), ctx }; };
const req = (path, init) => new Request('https://c.example' + path, init);
const STROKE = { type: 'stroke', points: [{ x: 100, y: 100 }, { x: 1500, y: 120 }], color: '#00d4c8', size: 6 };

test('validation and tile maths are unchanged from server.js', () => {
  assert.equal(validateOp(STROKE), true);
  assert.equal(validateOp({ ...STROKE, size: 0 }), false);
  assert.equal(validateOp({ type: 'text', x: 0, y: 0, text: '', color: '#000', fontSize: 12 }), false);
  assert.equal(validateOp({ type: 'image' }), false);
  assert.deepEqual(getOpTileBounds(STROKE), { minTX: 0, minTY: 0, maxTX: 1, maxTY: 0 });
  assert.deepEqual(sampleEvenly([1, 2, 3, 4, 5, 6], 3), [1, 3, 5]);
});

test('draw: persisted, given an id, broadcast to everyone, indexed into tiles, rate-limited per session', async () => {
  const { c, ctx } = canvas();
  const a = ws(), b = ws();
  ctx.sockets.push(a, b);
  await c.webSocketMessage(a, JSON.stringify({ type: 'draw', op: STROKE, sessionId: 's1' }));
  await c.webSocketMessage(a, JSON.stringify({ type: 'draw', op: STROKE, sessionId: 's1' })); // within 80 ms: dropped
  await c.webSocketMessage(a, JSON.stringify({ type: 'draw', op: { ...STROKE, size: 999 } })); // invalid: dropped
  assert.equal(b.sent.length, 1);
  assert.deepEqual(b.sent[0], { type: 'op', op: { id: 1, sessionId: 's1', ...STROKE } });
  assert.equal(a.sent.length, 1); // sender gets it too, like broadcastAll
  const tile = await (await c.fetch(req('/api/canvas/tile?tx=1&ty=0'))).json();
  assert.equal(tile.length, 1);
  assert.deepEqual(await (await c.fetch(req('/api/canvas/tile?tx=5&ty=5'))).json(), []);
  assert.equal((await c.fetch(req('/api/canvas/tile?tx=64&ty=0'))).status, 400);

  // a fresh object (after hibernation/eviction) reloads the same state from storage
  const again = new Canvas(ctx, {});
  assert.equal((await (await again.fetch(req('/api/canvas'))).json()).length, 1);
  assert.deepEqual(await (await again.fetch(req('/health'))).json(), { status: 'ok', clients: 2, ops: 1 });
});

test('import fills an empty canvas once, keeping ids, and only with the token', async () => {
  const { c } = canvas({ IMPORT_TOKEN: 't0k' });
  const ops = [{ id: 7, sessionId: 'x', ...STROKE }, { id: 9, sessionId: null, type: 'rect', x: 1, y: 1, w: 5, h: 5, color: '#fff' }, { id: 10, type: 'bogus' }];
  const body = JSON.stringify(ops);
  assert.equal((await c.fetch(req('/api/import', { method: 'POST', body, headers: { 'X-Import-Token': 'nope' } }))).status, 403);
  const res = await (await c.fetch(req('/api/import', { method: 'POST', body, headers: { 'X-Import-Token': 't0k' } }))).json();
  assert.deepEqual(res, { ok: true, imported: 2, ops: 2 });
  assert.equal((await c.fetch(req('/api/import', { method: 'POST', body, headers: { 'X-Import-Token': 't0k' } }))).status, 409);
  await c.webSocketMessage(ws(), JSON.stringify({ type: 'draw', op: STROKE }));
  const all = await (await c.fetch(req('/api/canvas'))).json();
  assert.deepEqual(all.map((o) => o.id), [7, 9, 10]); // new ops continue after the highest imported id
  const { c: noToken } = canvas({});
  assert.equal((await noToken.fetch(req('/api/import', { method: 'POST', body, headers: { 'X-Import-Token': '' } }))).status, 403);
});

test('clear needs CLEAR_SECRET (fails closed when unset) and tells everyone', async () => {
  const { c, ctx } = canvas({ CLEAR_SECRET: 'sekret' });
  const a = ws();
  ctx.sockets.push(a);
  await c.webSocketMessage(a, JSON.stringify({ type: 'draw', op: STROKE }));
  assert.equal((await c.fetch(req('/api/clear', { method: 'POST', body: '{"secret":"x"}' }))).status, 403);
  assert.equal((await c.fetch(req('/api/clear', { method: 'POST', body: '{"secret":"sekret"}' }))).status, 200);
  assert.deepEqual(a.sent.at(-1), { type: 'clear' });
  assert.deepEqual(await (await c.fetch(req('/api/canvas'))).json(), []);
  const { c: open } = canvas({});
  assert.equal((await open.fetch(req('/api/clear', { method: 'POST', body: '{}' }))).status, 403);
});

// A real 2×2 RGBA PNG (filter "sub" on row 2), built with CompressionStream so decodePng is exercised end to end.
async function makePng(width, height, rgbaRows, filters) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
    v.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
    v.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width); hv.setUint32(4, height); ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = [];
  rgbaRows.forEach((row, y) => {
    raw.push(filters[y]);
    if (filters[y] === 1) row.forEach((v, i) => raw.push((v - (i >= 4 ? row[i - 4] : 0)) & 0xff));
    else raw.push(...row);
  });
  const z = new Uint8Array(await new Response(new Blob([new Uint8Array(raw)]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array())];
  return new Uint8Array(parts.flatMap((p) => [...p]));
}

test('PNG decode (incl. a filtered row) and GIF build for the timelapse', async () => {
  const rows = [[255, 0, 0, 255, 0, 255, 0, 255], [0, 0, 255, 255, 255, 255, 255, 255]];
  const png = await makePng(2, 2, rows, [0, 1]);
  const img = await decodePng(png);
  assert.equal(img.width, 2);
  assert.deepEqual([...img.data], rows.flat());
  const b64 = Buffer.from(png).toString('base64');
  const gif = await buildGif([b64, b64, 'not-a-png']);
  assert.equal(new TextDecoder().decode(gif.subarray(0, 6)), 'GIF89a');
  assert.equal(await buildGif(['bad']), null);
});

test('snapshots: one per 5-minute window, counted, and served as a GIF', async () => {
  const { c } = canvas();
  const png = Buffer.from(await makePng(1, 1, [[1, 2, 3, 255]], [0])).toString('base64');
  const post = (ts) => c.fetch(req('/api/snapshots', { method: 'POST', body: JSON.stringify({ png, timestamp: ts }) }));
  const now = Date.now();
  await post(now); await post(now + 1000); await post(now - 10 * 60 * 1000);
  assert.deepEqual(await (await c.fetch(req('/api/snapshots/count'))).json(), { count: 2 });
  const gif = await c.fetch(req('/api/snapshots/gif'));
  assert.equal(gif.headers.get('Content-Type'), 'image/gif');
  assert.equal((await c.fetch(req('/api/snapshots', { method: 'POST', body: '{}' }))).status, 400);
  const { c: empty } = canvas();
  assert.equal((await empty.fetch(req('/api/snapshots/gif'))).status, 404);
});
