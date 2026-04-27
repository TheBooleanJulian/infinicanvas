# ✦ InfiniCanvas

A real-time collaborative 65536×65536 pixel canvas. Draw, type, and create together — anywhere on an infinite grid.

Built by [TheBooleanJulian](https://github.com/TheBooleanJulian).

## Features

- **Pen** — freehand drawing with custom RGB color + brush size
- **Eraser** — erase strokes cleanly
- **Line** — straight lines with configurable thickness
- **Rectangle** — outline or filled rectangles
- **Circle** — outline or filled ellipses
- **Text** — place text anywhere with custom font size and color
- **Pan** — navigate the canvas (middle-click, Space+drag, or H key)
- **Zoom** — scroll wheel to zoom in/out (1% → 1000%)
- **View-only mode** — canvas is read-only below 100% zoom; zoom in to draw
- **Cursor coordinates** — live XY display in the header (0,0 = centre of canvas)
- Real-time sync via WebSocket
- Persistent canvas history via Redis (survives restarts)
- Online user count

## Project Structure

```
infinicanvas/
├── server.js           Node.js + Express + WebSocket backend
├── package.json        Backend deps + frontend build scripts
├── .env.example        Required environment variables
└── frontend/           React + Vite frontend
    ├── index.html
    ├── vite.config.js
    ├── package.json
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── App.css
        └── components/
            ├── CanvasBoard.jsx
            ├── CanvasBoard.css
            ├── Toolbar.jsx
            └── Toolbar.css
```

## Local Development

### Prerequisites

- Node.js 18+
- A local Redis instance (`redis-server` or Docker: `docker run -p 6379:6379 redis`)

### Backend

```bash
# from repo root
npm install        # also builds the frontend via postinstall
npm run dev        # http://localhost:3001
```

### Frontend (hot-reload dev server)

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173  (proxies /api and /ws to :3001)
```

Set `REDIS_URI=redis://localhost:6379` in a `.env` file at the repo root (see `.env.example`).

## Deploy on Zeabur (single service)

The backend builds and serves the frontend automatically — only one service needed.

### 1. Push to GitHub

```bash
git init && git add . && git commit -m "init"
gh repo create infinicanvas --public --push
```

### 2. Create Zeabur project

1. Go to [zeabur.com](https://zeabur.com) → New Project
2. **Add Service → Git** → select your repo (leave Root Directory as `/`)
   - Zeabur runs `yarn install` (triggers `postinstall` → frontend build), then `npm start`
3. **Add Service → Marketplace → Redis**
   - Zeabur automatically injects `REDIS_URI` into your backend service

### 3. Optional env vars (Backend service)

```
CLEAR_SECRET=your-secret-token    # protects POST /api/clear
PORT=3001                          # auto-set by Zeabur
```

## Rendering Architecture

The canvas is 65536×65536 logical pixels, rendered as a grid of **1024×1024 tiles** created on demand as the user pans. Tiles are replayed from Redis ops on creation. A maximum of 48 tiles are kept in memory at once; older tiles are evicted when the limit is reached.

## API

| Endpoint | Method | Description |
|---|---|---|
| `GET /` | GET | Service info |
| `GET /health` | GET | Status + client count + op count |
| `GET /api/canvas` | GET | Fetch all draw operations (canvas replay) |
| `POST /api/clear` | POST | Clear canvas (requires `{ secret }`) |

## WebSocket Protocol

**Client → Server**
```json
{ "type": "draw", "sessionId": "u_abc123", "op": { "type": "stroke", ... } }
```

**Server → Client**
```json
{ "type": "op",     "op": { "type": "stroke", "sessionId": "...", ... } }
{ "type": "online", "count": 4 }
{ "type": "clear" }
```

## Op Types

| Type | Fields |
|---|---|
| `stroke` | `points[{x,y}]`, `color`, `size`, `eraser` |
| `line` | `x1`, `y1`, `x2`, `y2`, `color`, `size` |
| `rect` | `x`, `y`, `w`, `h`, `color`, `filled` |
| `circle` | `cx`, `cy`, `rx`, `ry`, `color`, `filled` |
| `text` | `x`, `y`, `text`, `color`, `fontSize` |

Coordinates are in canvas space. (0, 0) is the top-left corner of the 65536×65536 canvas. The UI displays coordinates centred on (0, 0) at the canvas midpoint (32768, 32768).

## Clear Canvas

```bash
curl -X POST https://your-backend.zeabur.app/api/clear \
  -H 'Content-Type: application/json' \
  -d '{"secret":"your-secret-token"}'
```
