<div align="center">

# InfiniCanvas

**A real-time collaborative 65536×65536 pixel canvas — draw, type, and create together anywhere on an infinite grid.**

![JavaScript](https://img.shields.io/badge/-JavaScript-F7DF1E?logo=javascript&logoColor=black)
![Node.js](https://img.shields.io/badge/-Node.js-339933?logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/-React-61DAFB?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/-Vite-646CFF?logo=vite&logoColor=white)
![Redis](https://img.shields.io/badge/-Redis-DC382D?logo=redis&logoColor=white)
![Zeabur](https://img.shields.io/badge/-Zeabur-6C5CE7)
![License](https://img.shields.io/badge/license-MIT-00D4C8.svg)

</div>

---

## What it does

InfiniCanvas is a real-time collaborative drawing app built around a single, shared 65536×65536 pixel canvas. Multiple users can draw, annotate, and create simultaneously — changes sync instantly via WebSocket and persist across restarts through Redis. The canvas is rendered as a grid of on-demand tiles so it stays performant regardless of size, and a view-only mode below 100% zoom keeps accidental edits from happening while panning around.

## Features

- **Pen** — freehand drawing with custom RGB colour and brush size
- **Eraser** — clean stroke removal
- **Line, Rectangle, Circle** — shape tools with configurable thickness and fill
- **Text** — place text anywhere with custom font size and colour
- **Pan & Zoom** — middle-click, Space+drag, or H key to pan; scroll wheel to zoom (1%–1000%)
- **View-only mode** — canvas is read-only below 100% zoom; zoom in to draw
- **Tiled rendering** — 1024×1024 tiles created on demand, capped at 48 in memory to prevent OOM
- **Real-time sync** — WebSocket broadcast; online user count displayed live
- **Persistent history** — all ops stored in Redis and replayed on tile creation
- **Timelapse GIF** — canvas auto-captured every 5 minutes; downloadable as a GIF
- **Cursor coordinates** — live XY display in the header (0,0 = canvas centre)
- **Mobile sidebar** — toolbar collapses to a bottom bar on small screens

## Tech Stack

| Layer | Choice |
|---|---|
| Backend | Node.js + Express + `ws` (WebSocket) |
| Frontend | React + Vite |
| Persistence | Redis (via `ioredis`) |
| Image / GIF | `jimp`, `gifenc` |
| Hosting | Zeabur (single service, frontend built via `postinstall`) |

## Quick Start

### Prerequisites

- Node.js 18+
- A Redis instance (`redis-server` or `docker run -p 6379:6379 redis`)

```bash
git clone https://github.com/TheBooleanJulian/infinicanvas
cd infinicanvas
npm install          # also builds the React frontend via postinstall
cp .env.example .env
# set REDIS_URI in .env
npm run dev          # backend + frontend served at http://localhost:3001
```

For frontend hot-reload during development:

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173 — proxies /api and /ws to :3001
```

## Configuration

| Variable | Required | Description |
|---|---|---|
| `REDIS_URI` | Yes | Redis connection string, e.g. `redis://localhost:6379` |
| `CLEAR_SECRET` | No | Secret token to authorise `POST /api/clear` |
| `PORT` | No | Server port (default `3001`; auto-set by Zeabur) |

## Project Structure

```
infinicanvas/
├── server.js               Node.js + Express + WebSocket backend
├── package.json            Backend deps + frontend build scripts
├── .env.example
└── frontend/               React + Vite frontend
    ├── index.html
    ├── vite.config.js
    ├── package.json
    └── src/
        ├── main.jsx
        ├── App.jsx
        └── components/
            ├── CanvasBoard.jsx
            └── Toolbar.jsx
```

## API

| Endpoint | Method | Description |
|---|---|---|
| `GET /` | GET | Service info |
| `GET /health` | GET | Status, client count, op count |
| `GET /api/canvas` | GET | Fetch all draw ops for canvas replay |
| `POST /api/clear` | POST | Clear canvas (requires `{ secret }`) |

## Deployment

Deployed on Zeabur as a single service. `npm install` triggers `postinstall`, which builds the React frontend; `npm start` then serves both API and static files from `server.js`. Add a Redis service from the Zeabur marketplace — `REDIS_URI` is injected automatically.

## Status / Roadmap

- [x] Real-time WebSocket sync + Redis persistence
- [x] Tiled 65536×65536 canvas with OOM protection
- [x] Full shape and text tool set
- [x] Timelapse GIF capture and download
- [x] Mobile-friendly bottom toolbar
- [ ] Named rooms / multiple canvases
- [ ] User attribution per stroke
- [ ] Undo / redo

## Changelog

- **2026-04-29** — Added timelapse feature: canvas auto-captured every 5 minutes with GIF download; sidebar moved to a bottom bar on mobile
- **2026-04-28** — Fixed browser and Cloudflare caching on `/api/canvas`; fixed eraser painting white instead of erasing; normalised `VITE_API_URL` handling
- **2026-04-27 (stability)** — Fixed OOM crashes via smaller tiles, a 48-tile cap, and visibility-based eviction; fixed in-place tile redraw for correct persistence
- **2026-04-27 (canvas)** — Expanded canvas to 65536×65536 with tiled rendering; added live cursor coordinates; clamped zoom to 25%–100% range; centred initial view on canvas midpoint
- **2026-04-27 (features)** — Added view-only mode below 100% zoom; updated colour palette to a 24-swatch ColorChecker-style grid; improved attribution and view-only badge visibility
- **2026-04-27 (persistence)** — Switched persistence backend from in-memory to Redis; added user attribution per op
- **2026-04-27 (init)** — Initial release: React + Vite frontend scaffolded and wired to Express + WebSocket backend; root route added for deploy

## License

MIT

---

<div align="center">
<sub>Built by <a href="https://github.com/TheBooleanJulian">@TheBooleanJulian</a></sub>
</div>