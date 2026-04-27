import { useRef, useState, useEffect, useCallback } from 'react'
import './CanvasBoard.css'

const CANVAS_W  = 2048
const CANVAS_H  = 2048
const INIT_SCALE = 0.35

// Resolve API/WS URLs — set VITE_API_URL in Zeabur environment
const API_URL = import.meta.env.VITE_API_URL || ''   // same origin in proxy mode

/* ── Replay engine ──────────────────────────── */
function applyOp(ctx, op) {
  if (!op?.type) return
  ctx.save()

  switch (op.type) {

    case 'stroke': {
      const pts = op.points
      if (!pts?.length) break
      ctx.globalCompositeOperation = op.eraser ? 'destination-out' : 'source-over'
      ctx.strokeStyle = op.eraser ? 'rgba(0,0,0,1)' : op.color
      ctx.lineWidth   = op.size
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      if (pts.length === 1) {
        ctx.arc(pts[0].x, pts[0].y, op.size / 2, 0, Math.PI * 2)
        ctx.fillStyle = op.eraser ? 'rgba(0,0,0,1)' : op.color
        ctx.fill()
      } else {
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
        ctx.stroke()
      }
      break
    }

    case 'line':
      ctx.strokeStyle = op.color
      ctx.lineWidth   = op.size
      ctx.lineCap     = 'round'
      ctx.beginPath()
      ctx.moveTo(op.x1, op.y1)
      ctx.lineTo(op.x2, op.y2)
      ctx.stroke()
      break

    case 'rect':
      if (op.filled) {
        ctx.fillStyle = op.color
        ctx.fillRect(op.x, op.y, op.w, op.h)
      } else {
        ctx.strokeStyle = op.color
        ctx.lineWidth   = op.lineWidth ?? 2
        ctx.strokeRect(op.x, op.y, op.w, op.h)
      }
      break

    case 'circle': {
      const rx = Math.abs(op.rx) || 1
      const ry = Math.abs(op.ry) || 1
      ctx.beginPath()
      ctx.ellipse(op.cx, op.cy, rx, ry, 0, 0, Math.PI * 2)
      if (op.filled) {
        ctx.fillStyle = op.color
        ctx.fill()
      } else {
        ctx.strokeStyle = op.color
        ctx.lineWidth   = op.lineWidth ?? 2
        ctx.stroke()
      }
      break
    }

    case 'text':
      ctx.font         = `${op.bold ? 'bold ' : ''}${op.fontSize}px 'Outfit', 'Segoe UI', sans-serif`
      ctx.fillStyle    = op.color
      ctx.textBaseline = 'top'
      ctx.fillText(op.text, op.x, op.y)
      break

    default:
      break
  }

  ctx.restore()
}

/* ── CanvasBoard ────────────────────────────── */
export default function CanvasBoard({
  tool, color, brushSize, filled, fontSize,
  sessionId, onOnlineChange, onZoomChange, onStatusChange,
}) {
  const viewportRef = useRef(null)
  const wrapperRef  = useRef(null)
  const mainRef     = useRef(null)
  const overlayRef  = useRef(null)
  const wsRef       = useRef(null)

  // Transform state (not React state — mutated directly for perf)
  const transform   = useRef({ x: 0, y: 0, scale: INIT_SCALE })

  // Drawing state
  const isPanning   = useRef(false)
  const panStart    = useRef({ x: 0, y: 0 })
  const isDrawing   = useRef(false)
  const stroke      = useRef([])       // for pen/eraser
  const shapeAnchor = useRef(null)     // for shapes

  // Space key held = pan mode
  const spaceHeld   = useRef(false)

  // Keep tool/color/etc refs for event handlers
  const toolRef      = useRef(tool)
  const colorRef     = useRef(color)
  const sizeRef      = useRef(brushSize)
  const filledRef    = useRef(filled)
  const fontSizeRef  = useRef(fontSize)

  useEffect(() => { toolRef.current = tool }, [tool])
  useEffect(() => { colorRef.current = color }, [color])
  useEffect(() => { sizeRef.current = brushSize }, [brushSize])
  useEffect(() => { filledRef.current = filled }, [filled])
  useEffect(() => { fontSizeRef.current = fontSize }, [fontSize])

  // Text placement UI
  const [textState, setTextState] = useState(null) // { sx, sy, cx, cy }
  const [textVal,   setTextVal  ] = useState('')

  /* ── Helpers ────────────────────────────── */
  const pushTransform = useCallback(() => {
    const { x, y, scale } = transform.current
    if (wrapperRef.current) {
      wrapperRef.current.style.transform = `translate(${x}px,${y}px) scale(${scale})`
    }
    onZoomChange?.(Math.round(scale * 100))
  }, [onZoomChange])

  const toCanvas = useCallback((e) => {
    const vp = viewportRef.current.getBoundingClientRect()
    const { x, y, scale } = transform.current
    return {
      x: (e.clientX - vp.left - x) / scale,
      y: (e.clientY - vp.top  - y) / scale,
    }
  }, [])

  const mainCtx    = () => mainRef.current?.getContext('2d')
  const overlayCtx = () => overlayRef.current?.getContext('2d')
  const clearOverlay = () => {
    const ctx = overlayCtx()
    if (ctx) ctx.clearRect(0, 0, CANVAS_W, CANVAS_H)
  }

  const sendOp = useCallback((op) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'draw', op, sessionId }))
    }
  }, [sessionId])

  const commitAndSend = useCallback((op) => {
    applyOp(mainCtx(), op)
    sendOp(op)
  }, [sendOp])

  /* ── Canvas + WebSocket init ────────────── */
  useEffect(() => {
    const canvas = mainRef.current
    const ctx    = canvas.getContext('2d')

    // White background
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)

    // Center canvas in viewport
    const vp = viewportRef.current
    transform.current = {
      x: (vp.clientWidth  - CANVAS_W * INIT_SCALE) / 2,
      y: (vp.clientHeight - CANVAS_H * INIT_SCALE) / 2,
      scale: INIT_SCALE,
    }
    pushTransform()

    // Load history
    const url = API_URL ? `${API_URL}/api/canvas` : '/api/canvas'
    fetch(url)
      .then(r => r.json())
      .then(ops => ops.forEach(op => applyOp(ctx, op)))
      .catch(() => {/* backend may not be up yet */})

    // WebSocket connection
    const connectWs = () => {
      const wsTarget = API_URL
        ? API_URL.replace(/^http/, 'ws')
        : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`

      const ws = new WebSocket(wsTarget)
      wsRef.current = ws
      onStatusChange?.('connecting')

      ws.onopen  = () => onStatusChange?.('live')
      ws.onerror = () => onStatusChange?.('offline')
      ws.onclose = () => {
        onStatusChange?.('offline')
        setTimeout(connectWs, 3000) // auto-reconnect
      }

      ws.onmessage = (e) => {
        let msg
        try { msg = JSON.parse(e.data) } catch { return }

        if (msg.type === 'op') {
          // Skip ops we already drew locally
          if (msg.op?.sessionId === sessionId) return
          applyOp(ctx, msg.op)
        }
        if (msg.type === 'online') onOnlineChange?.(msg.count)
        if (msg.type === 'clear') {
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
        }
      }
    }

    connectWs()

    return () => wsRef.current?.close()
  }, []) // eslint-disable-line

  /* ── Keyboard shortcuts ─────────────────── */
  useEffect(() => {
    const shortcutMap = {
      p: 'pen', e: 'eraser', l: 'line', r: 'rect',
      c: 'circle', t: 'text', h: 'pan',
    }
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT') return
      if (e.code === 'Space') { spaceHeld.current = true; e.preventDefault() }
      const mapped = shortcutMap[e.key.toLowerCase()]
      if (mapped) window.dispatchEvent(new CustomEvent('tool-select', { detail: mapped }))
    }
    const onKeyUp = (e) => {
      if (e.code === 'Space') spaceHeld.current = false
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  /* ── Mouse events ───────────────────────── */
  const onMouseDown = useCallback((e) => {
    const isPanTool = toolRef.current === 'pan' || e.button === 1 || spaceHeld.current
    if (isPanTool) {
      isPanning.current = true
      panStart.current  = { x: e.clientX - transform.current.x, y: e.clientY - transform.current.y }
      e.preventDefault()
      return
    }
    if (e.button !== 0) return

    const c = toCanvas(e)

    if (toolRef.current === 'text') {
      setTextState({ sx: e.clientX, sy: e.clientY, cx: c.x, cy: c.y })
      setTextVal('')
      return
    }

    isDrawing.current = true

    if (toolRef.current === 'pen' || toolRef.current === 'eraser') {
      stroke.current = [{ x: c.x, y: c.y }]
      // Draw initial dot
      const ctx = mainCtx()
      ctx.save()
      ctx.globalCompositeOperation = toolRef.current === 'eraser' ? 'destination-out' : 'source-over'
      ctx.fillStyle = toolRef.current === 'eraser' ? 'rgba(0,0,0,1)' : colorRef.current
      ctx.beginPath()
      ctx.arc(c.x, c.y, sizeRef.current / 2, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    } else {
      shapeAnchor.current = c
    }
  }, [toCanvas])

  const onMouseMove = useCallback((e) => {
    if (isPanning.current) {
      transform.current.x = e.clientX - panStart.current.x
      transform.current.y = e.clientY - panStart.current.y
      pushTransform()
      return
    }
    if (!isDrawing.current) return

    const c   = toCanvas(e)
    const t   = toolRef.current
    const col = colorRef.current
    const sz  = sizeRef.current

    if (t === 'pen' || t === 'eraser') {
      const s    = stroke.current
      const prev = s[s.length - 1]
      s.push(c)

      const ctx = mainCtx()
      ctx.save()
      ctx.globalCompositeOperation = t === 'eraser' ? 'destination-out' : 'source-over'
      ctx.strokeStyle = t === 'eraser' ? 'rgba(0,0,0,1)' : col
      ctx.lineWidth   = sz
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.beginPath()
      ctx.moveTo(prev.x, prev.y)
      ctx.lineTo(c.x, c.y)
      ctx.stroke()
      ctx.restore()
      return
    }

    const anchor = shapeAnchor.current
    if (!anchor) return
    const oct = overlayCtx()
    oct.clearRect(0, 0, CANVAS_W, CANVAS_H)
    oct.save()
    oct.strokeStyle = col
    oct.fillStyle   = col
    oct.lineWidth   = sz

    if (t === 'line') {
      oct.lineCap = 'round'
      oct.beginPath()
      oct.moveTo(anchor.x, anchor.y)
      oct.lineTo(c.x, c.y)
      oct.stroke()
    } else if (t === 'rect') {
      const x = Math.min(anchor.x, c.x), y = Math.min(anchor.y, c.y)
      const w = Math.abs(c.x - anchor.x), h = Math.abs(c.y - anchor.y)
      oct.lineWidth = 2
      if (filledRef.current) oct.fillRect(x, y, w, h)
      else oct.strokeRect(x, y, w, h)
    } else if (t === 'circle') {
      const rx = (c.x - anchor.x) / 2, ry = (c.y - anchor.y) / 2
      const cx = anchor.x + rx,        cy = anchor.y + ry
      oct.lineWidth = 2
      oct.beginPath()
      oct.ellipse(cx, cy, Math.abs(rx) || 1, Math.abs(ry) || 1, 0, 0, Math.PI * 2)
      if (filledRef.current) oct.fill()
      else oct.stroke()
    }

    oct.restore()
  }, [toCanvas, pushTransform])

  const onMouseUp = useCallback((e) => {
    if (isPanning.current) { isPanning.current = false; return }
    if (!isDrawing.current) return
    isDrawing.current = false

    const c      = toCanvas(e)
    const t      = toolRef.current
    const col    = colorRef.current
    const sz     = sizeRef.current

    if (t === 'pen' || t === 'eraser') {
      const pts = stroke.current
      if (pts.length > 0) {
        sendOp({ type: 'stroke', points: pts, color: col, size: sz, eraser: t === 'eraser' })
      }
      stroke.current = []
      return
    }

    const anchor = shapeAnchor.current
    if (!anchor) return
    clearOverlay()

    if (t === 'line') {
      commitAndSend({ type: 'line', x1: anchor.x, y1: anchor.y, x2: c.x, y2: c.y, color: col, size: sz })
    } else if (t === 'rect') {
      const x = Math.min(anchor.x, c.x), y = Math.min(anchor.y, c.y)
      const w = Math.abs(c.x - anchor.x), h = Math.abs(c.y - anchor.y)
      commitAndSend({ type: 'rect', x, y, w, h, color: col, filled: filledRef.current, lineWidth: 2 })
    } else if (t === 'circle') {
      const rx = (c.x - anchor.x) / 2, ry = (c.y - anchor.y) / 2
      const cx = anchor.x + rx,        cy = anchor.y + ry
      commitAndSend({ type: 'circle', cx, cy, rx, ry, color: col, filled: filledRef.current, lineWidth: 2 })
    }

    shapeAnchor.current = null
  }, [toCanvas, sendOp, commitAndSend])

  /* ── Zoom on scroll ─────────────────────── */
  useEffect(() => {
    const vp = viewportRef.current
    const onWheel = (e) => {
      e.preventDefault()
      const factor   = e.deltaY < 0 ? 1.1 : 0.9
      const newScale = Math.max(0.05, Math.min(10, transform.current.scale * factor))

      const rect = vp.getBoundingClientRect()
      const mx   = e.clientX - rect.left
      const my   = e.clientY - rect.top

      transform.current.x = mx - (mx - transform.current.x) * (newScale / transform.current.scale)
      transform.current.y = my - (my - transform.current.y) * (newScale / transform.current.scale)
      transform.current.scale = newScale
      pushTransform()
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [pushTransform])

  /* ── Text commit ────────────────────────── */
  const commitText = useCallback(() => {
    if (!textState || !textVal.trim()) { setTextState(null); return }
    const op = {
      type: 'text',
      x: textState.cx,
      y: textState.cy,
      text: textVal.trim(),
      color: colorRef.current,
      fontSize: fontSizeRef.current,
    }
    commitAndSend(op)
    setTextState(null)
    setTextVal('')
  }, [textState, textVal, commitAndSend])

  /* ── Cursor ─────────────────────────────── */
  const cursors = {
    pen: 'crosshair', eraser: 'cell', line: 'crosshair',
    rect: 'crosshair', circle: 'crosshair', text: 'text', pan: 'grab',
  }
  const cursor = spaceHeld.current ? 'grab' : (cursors[tool] || 'crosshair')

  /* ── Text input position (scaled) ──────── */
  const textInputStyle = textState ? {
    left: textState.sx + 'px',
    top:  textState.sy + 'px',
    '--fs': Math.max(12, fontSizeRef.current * transform.current.scale) + 'px',
  } : {}

  return (
    <div
      ref={viewportRef}
      className="viewport"
      style={{ cursor }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => {
        if (isPanning.current) isPanning.current = false
        if (isDrawing.current) {
          isDrawing.current = false
          if (toolRef.current === 'pen' || toolRef.current === 'eraser') {
            const pts = stroke.current
            if (pts.length > 1) sendOp({ type: 'stroke', points: pts, color: colorRef.current, size: sizeRef.current, eraser: toolRef.current === 'eraser' })
            stroke.current = []
          }
          clearOverlay()
          shapeAnchor.current = null
        }
      }}
      onContextMenu={e => e.preventDefault()}
    >
      {/* Dot-grid background */}
      <div className="dot-grid" />

      {/* Canvas wrapper — CSS transform applied here */}
      <div ref={wrapperRef} className="canvas-wrapper" style={{ transformOrigin: '0 0' }}>
        <canvas ref={mainRef}    width={CANVAS_W} height={CANVAS_H} className="main-canvas" />
        <canvas ref={overlayRef} width={CANVAS_W} height={CANVAS_H} className="overlay-canvas" />
      </div>

      {/* Text input overlay */}
      {textState && (
        <div className="text-overlay" style={textInputStyle}>
          <input
            autoFocus
            className="text-field"
            value={textVal}
            onChange={e => setTextVal(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText() }
              if (e.key === 'Escape') setTextState(null)
            }}
            placeholder="Type here…"
            style={{ color, fontSize: 'var(--fs)', fontFamily: 'Outfit, sans-serif' }}
          />
          <div className="text-hint">
            <kbd>Enter</kbd> to place · <kbd>Esc</kbd> to cancel
          </div>
        </div>
      )}

      {/* Corner controls */}
      <div className="corner-controls">
        <button
          className="corner-btn"
          title="Reset view"
          onClick={() => {
            const vp = viewportRef.current
            transform.current = {
              x: (vp.clientWidth  - CANVAS_W * INIT_SCALE) / 2,
              y: (vp.clientHeight - CANVAS_H * INIT_SCALE) / 2,
              scale: INIT_SCALE,
            }
            pushTransform()
          }}
        >
          <svg viewBox="0 0 16 16" fill="none" width="14">
            <path d="M2 8a6 6 0 1110.83-3.5M14 2v4h-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <button
          className="corner-btn"
          title="Zoom in"
          onClick={() => {
            const vp = viewportRef.current
            const cx = vp.clientWidth / 2, cy = vp.clientHeight / 2
            const ns = Math.min(10, transform.current.scale * 1.25)
            transform.current.x = cx - (cx - transform.current.x) * (ns / transform.current.scale)
            transform.current.y = cy - (cy - transform.current.y) * (ns / transform.current.scale)
            transform.current.scale = ns
            pushTransform()
          }}
        >
          <svg viewBox="0 0 16 16" fill="none" width="14">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M7 5v4M5 7h4M11 11l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
        <button
          className="corner-btn"
          title="Zoom out"
          onClick={() => {
            const vp = viewportRef.current
            const cx = vp.clientWidth / 2, cy = vp.clientHeight / 2
            const ns = Math.max(0.05, transform.current.scale * 0.8)
            transform.current.x = cx - (cx - transform.current.x) * (ns / transform.current.scale)
            transform.current.y = cy - (cy - transform.current.y) * (ns / transform.current.scale)
            transform.current.scale = ns
            pushTransform()
          }}
        >
          <svg viewBox="0 0 16 16" fill="none" width="14">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M5 7h4M11 11l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  )
}
