# ✦ InfiniCanvas

A real-time collaborative 2048×2048 pixel canvas. Draw, type, and create together.

## Features

- **Pen** — freehand drawing with custom RGB color + brush size
- **Eraser** — erase strokes cleanly
- **Line** — straight lines with configurable thickness
- **Rectangle** — outline or filled rectangles
- **Circle** — outline or filled ellipses
- **Text** — place text anywhere with custom font size and color
- **Pan** — navigate the canvas (also: middle-click, Space+drag)
- **Zoom** — scroll wheel to zoom in/out (5% → 1000%)
- Real-time sync via WebSocket
- Persistent canvas history (JSONL append log — survives restarts)
- Online count display

## Project Structure

```
infinicanvas/
├── backend/          Node.js + Express + WebSocket + SQLite
│   ├── server.js
│   └── package.json
└── frontend/         React + Vite
    ├── src/
    │   ├── App.jsx
    │   ├── components/
    │   │   ├── CanvasBoard.jsx
    │   │   └── Toolbar.jsx
    │   └── main.jsx
    ├── index.html
    └── package.json
```

## Local Development

### Backend
```bash
cd backend
npm install
npm run dev        # http://localhost:3001
```

### Frontend
```bash
cd frontend
npm install
npm run dev        # http://localhost:5173  (proxies /api to :3001)
```

## Deploy on Zeabur

### 1. Push to GitHub
```bash
git init && git add . && git commit -m "init InfiniCanvas"
gh repo create infinicanvas --public --push
```

### 2. Create Zeabur project
1. Go to [zeabur.com](https://zeabur.com) → New Project
2. **Add Service → Git** → select your repo → set **Root Directory** to `backend`
   - Zeabur auto-detects Node.js and runs `npm start`
3. **Add Service → Git** → same repo → set **Root Directory** to `frontend`
   - Zeabur auto-detects Vite and runs `npm run build`, serves `dist/`

### 3. Set environment variables (Frontend service)
```
VITE_API_URL=https://your-backend.zeabur.app
VITE_WS_URL=wss://your-backend.zeabur.app
```

### 4. Optional env vars (Backend service)
```
CLEAR_SECRET=your-secret-token    # required to call POST /api/clear
PORT=3001                          # auto-set by Zeabur
```

## API

| Endpoint | Method | Description |
|---|---|---|
| `GET /api/canvas` | GET | Fetch all draw operations (canvas replay) |
| `POST /api/clear` | POST | Clear canvas (requires `{ secret }`) |
| `GET /health` | GET | Status check |

## WebSocket Protocol

**Client → Server**
```json
{ "type": "draw", "sessionId": "u_abc123", "op": { "type": "stroke", ... } }
```

**Server → Client**
```json
{ "type": "op", "op": { "type": "stroke", "sessionId": "...", ... } }
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

## Clear Canvas

```bash
curl -X POST https://your-backend.zeabur.app/api/clear \
  -H 'Content-Type: application/json' \
  -d '{"secret":"your-secret-token"}'
```
