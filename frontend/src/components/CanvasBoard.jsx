import { useRef, useState, useEffect, useCallback } from 'react'
import './CanvasBoard.css'

const CANVAS_W  = 65536
const CANVAS_H  = 65536
const TILE_SIZE = 1024           // 4 MB per tile (vs 16 MB at 2048)
const TILES_X   = CANVAS_W / TILE_SIZE  // 64
const TILES_Y   = CANVAS_H / TILE_SIZE  // 64
const INIT_SCALE = 1.0
const MAX_TILES          = 64    // evict oldest tiles beyond this limit
const MAX_VIEWPORT_TILES = 36    // max tiles loaded per ensureVisibleTiles call

const _rawApiUrl = import.meta.env.VITE_API_URL || ''
const API_URL = _rawApiUrl && !_rawApiUrl.startsWith('http')
  ? `https://${_rawApiUrl.replace(/\/$/, '')}`
  : _rawApiUrl.replace(/\/$/, '')

// ── Per-op drawing ───────────────────────────────────────────────────────────
function applyOp(ctx, op) {
  if (!op?.type) return
  ctx.save()
  switch (op.type) {
    case 'stroke': {
      const pts = op.points
      if (!pts?.length) break
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = op.eraser ? '#ffffff' : op.color
      ctx.lineWidth   = op.size
      ctx.lineCap     = 'round'
      ctx.lineJoin    = 'round'
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      if (pts.length === 1) {
        ctx.arc(pts[0].x, pts[0].y, op.size / 2, 0, Math.PI * 2)
        ctx.fillStyle = op.eraser ? '#ffffff' : op.color
        ctx.fill()
      } else {
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
        ctx.stroke()
      }
      break
    }
    case 'line':
      ctx.strokeStyle = op.color; ctx.lineWidth = op.size; ctx.lineCap = 'round'
      ctx.beginPath(); ctx.moveTo(op.x1, op.y1); ctx.lineTo(op.x2, op.y2); ctx.stroke()
      break
    case 'rect':
      if (op.filled) { ctx.fillStyle = op.color; ctx.fillRect(op.x, op.y, op.w, op.h) }
      else { ctx.strokeStyle = op.color; ctx.lineWidth = op.lineWidth ?? 2; ctx.strokeRect(op.x, op.y, op.w, op.h) }
      break
    case 'circle': {
      const rx = Math.abs(op.rx) || 1, ry = Math.abs(op.ry) || 1
      ctx.beginPath(); ctx.ellipse(op.cx, op.cy, rx, ry, 0, 0, Math.PI * 2)
      if (op.filled) { ctx.fillStyle = op.color; ctx.fill() }
      else { ctx.strokeStyle = op.color; ctx.lineWidth = op.lineWidth ?? 2; ctx.stroke() }
      break
    }
    case 'text':
      ctx.font = `${op.bold ? 'bold ' : ''}${op.fontSize}px 'Outfit','Segoe UI',sans-serif`
      ctx.fillStyle = op.color; ctx.textBaseline = 'top'
      ctx.fillText(op.text, op.x, op.y)
      break
    default: break
  }
  ctx.restore()
}

// ── Tile bounds for an op ────────────────────────────────────────────────────
function getOpTileBounds(op) {
  const pad = (op.size || op.lineWidth || 2) + 2
  let minX, minY, maxX, maxY

  switch (op.type) {
    case 'stroke': {
      if (!op.points?.length) return null
      minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity
      for (const p of op.points) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
      }
      minX -= pad; minY -= pad; maxX += pad; maxY += pad
      break
    }
    case 'line':
      minX = Math.min(op.x1, op.x2) - pad; minY = Math.min(op.y1, op.y2) - pad
      maxX = Math.max(op.x1, op.x2) + pad; maxY = Math.max(op.y1, op.y2) + pad
      break
    case 'rect':
      minX = op.x - pad; minY = op.y - pad
      maxX = op.x + op.w + pad; maxY = op.y + op.h + pad
      break
    case 'circle':
      minX = op.cx - Math.abs(op.rx) - pad; minY = op.cy - Math.abs(op.ry) - pad
      maxX = op.cx + Math.abs(op.rx) + pad; maxY = op.cy + Math.abs(op.ry) + pad
      break
    case 'text': {
      const w = (op.text?.length || 1) * op.fontSize * 0.7
      minX = op.x - 4; minY = op.y - 4; maxX = op.x + w + 4; maxY = op.y + op.fontSize + 4
      break
    }
    default:
      return { minTX: 0, minTY: 0, maxTX: TILES_X - 1, maxTY: TILES_Y - 1 }
  }
  return {
    minTX: Math.max(0, Math.floor(minX / TILE_SIZE)),
    minTY: Math.max(0, Math.floor(minY / TILE_SIZE)),
    maxTX: Math.min(TILES_X - 1, Math.floor(maxX / TILE_SIZE)),
    maxTY: Math.min(TILES_Y - 1, Math.floor(maxY / TILE_SIZE)),
  }
}

function opHitsTile(op, tx, ty) {
  const b = getOpTileBounds(op)
  return b ? tx >= b.minTX && tx <= b.maxTX && ty >= b.minTY && ty <= b.maxTY : false
}

// ── Component ────────────────────────────────────────────────────────────────
export default function CanvasBoard({
  tool, color, brushSize, filled, fontSize,
  sessionId, onOnlineChange, onZoomChange, onStatusChange, onCursorMove, zoom,
}) {
  const viewportRef      = useRef(null)
  const wrapperRef       = useRef(null)
  const tileContainerRef = useRef(null)
  const overlayRef       = useRef(null)
  const wsRef            = useRef(null)

  const transform   = useRef({ x: 0, y: 0, scale: INIT_SCALE })
  const isPanning   = useRef(false)
  const panStart    = useRef({ x: 0, y: 0 })
  const isDrawing   = useRef(false)
  const stroke      = useRef([])
  const shapeAnchor = useRef(null)
  const spaceHeld   = useRef(false)

  const pinchDistRef = useRef(null)
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
  useEffect(() => { if (zoom < 100) setTextState(null) }, [zoom])

  const opsRef       = useRef([])
  const tilesRef     = useRef(new Map())
  const tileOrderRef = useRef([])   // FIFO for eviction

  const [textState, setTextState] = useState(null)
  const [textVal,   setTextVal  ] = useState('')

  // ── Tile management ────────────────────────────────────────────────────────
  const ensureTile = useCallback((tx, ty) => {
    if (tx < 0 || tx >= TILES_X || ty < 0 || ty >= TILES_Y) return null
    const key = `${tx},${ty}`
    if (tilesRef.current.has(key)) return tilesRef.current.get(key)

    // Evict oldest tile when over limit
    if (tilesRef.current.size >= MAX_TILES) {
      const oldKey = tileOrderRef.current.shift()
      if (oldKey) {
        tilesRef.current.get(oldKey)?.canvas.remove()
        tilesRef.current.delete(oldKey)
      }
    }

    const canvas = document.createElement('canvas')
    canvas.width = TILE_SIZE; canvas.height = TILE_SIZE
    canvas.style.cssText = `position:absolute;left:${tx * TILE_SIZE}px;top:${ty * TILE_SIZE}px;display:block;border:0;outline:0`
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE)

    const offX = tx * TILE_SIZE, offY = ty * TILE_SIZE
    for (const op of opsRef.current) {
      if (opHitsTile(op, tx, ty)) {
        ctx.save(); ctx.translate(-offX, -offY); applyOp(ctx, op); ctx.restore()
      }
    }

    tileContainerRef.current?.appendChild(canvas)
    const tile = { canvas, ctx }
    tilesRef.current.set(key, tile)
    tileOrderRef.current.push(key)
    return tile
  }, [])

  const ensureVisibleTiles = useCallback(() => {
    const vp = viewportRef.current
    if (!vp) return
    const { x, y, scale } = transform.current
    const BUFFER = 1
    const minTX = Math.max(0, Math.floor(-x / scale / TILE_SIZE) - BUFFER)
    const minTY = Math.max(0, Math.floor(-y / scale / TILE_SIZE) - BUFFER)
    const maxTX = Math.min(TILES_X - 1, Math.floor((-x + vp.clientWidth)  / scale / TILE_SIZE) + BUFFER)
    const maxTY = Math.min(TILES_Y - 1, Math.floor((-y + vp.clientHeight) / scale / TILE_SIZE) + BUFFER)

    const count = (maxTX - minTX + 1) * (maxTY - minTY + 1)

    if (count <= MAX_VIEWPORT_TILES) {
      // All visible tiles fit within limit — load all
      for (let tx = minTX; tx <= maxTX; tx++)
        for (let ty = minTY; ty <= maxTY; ty++)
          ensureTile(tx, ty)
    } else {
      // Zoomed out far — load only tiles closest to the viewport centre
      const cTX = Math.floor((-x + vp.clientWidth  / 2) / scale / TILE_SIZE)
      const cTY = Math.floor((-y + vp.clientHeight / 2) / scale / TILE_SIZE)
      const half = Math.floor(Math.sqrt(MAX_VIEWPORT_TILES) / 2)
      const loX = Math.max(minTX, cTX - half), hiX = Math.min(maxTX, cTX + half)
      const loY = Math.max(minTY, cTY - half), hiY = Math.min(maxTY, cTY + half)
      for (let tx = loX; tx <= hiX; tx++)
        for (let ty = loY; ty <= hiY; ty++)
          ensureTile(tx, ty)
    }
  }, [ensureTile])

  // ── Apply op to all existing tiles it hits ─────────────────────────────────
  const applyOpToTiles = useCallback((op) => {
    const b = getOpTileBounds(op)
    if (!b) return
    for (let tx = b.minTX; tx <= b.maxTX; tx++) {
      for (let ty = b.minTY; ty <= b.maxTY; ty++) {
        const tile = tilesRef.current.get(`${tx},${ty}`)
        if (!tile) continue
        tile.ctx.save()
        tile.ctx.translate(-tx * TILE_SIZE, -ty * TILE_SIZE)
        applyOp(tile.ctx, op)
        tile.ctx.restore()
      }
    }
  }, [])

  // ── Visibility-based tile eviction ────────────────────────────────────────
  const evictFarTiles = useCallback(() => {
    const vp = viewportRef.current
    if (!vp) return
    const { x, y, scale } = transform.current
    const KEEP = 2   // keep tiles within 2 tile-widths outside viewport
    const keepMinTX = Math.max(0, Math.floor(-x / scale / TILE_SIZE) - KEEP)
    const keepMinTY = Math.max(0, Math.floor(-y / scale / TILE_SIZE) - KEEP)
    const keepMaxTX = Math.min(TILES_X - 1, Math.floor((-x + vp.clientWidth)  / scale / TILE_SIZE) + KEEP)
    const keepMaxTY = Math.min(TILES_Y - 1, Math.floor((-y + vp.clientHeight) / scale / TILE_SIZE) + KEEP)
    for (const [key, { canvas }] of tilesRef.current.entries()) {
      const [kx, ky] = key.split(',').map(Number)
      if (kx < keepMinTX || kx > keepMaxTX || ky < keepMinTY || ky > keepMaxTY) {
        canvas.remove()
        tilesRef.current.delete(key)
        const i = tileOrderRef.current.indexOf(key)
        if (i !== -1) tileOrderRef.current.splice(i, 1)
      }
    }
  }, [])

  // ── Overlay (viewport-space) ───────────────────────────────────────────────
  const overlayCtx   = () => overlayRef.current?.getContext('2d')
  const clearOverlay = () => {
    const ctx = overlayCtx(), vp = viewportRef.current
    if (ctx && vp) ctx.clearRect(0, 0, vp.clientWidth, vp.clientHeight)
  }
  const toVP = useCallback((cx, cy) => {
    const { x, y, scale } = transform.current
    return { x: cx * scale + x, y: cy * scale + y }
  }, [])

  // ── Transform ─────────────────────────────────────────────────────────────
  const pushTransform = useCallback(() => {
    const { x, y, scale } = transform.current
    if (wrapperRef.current)
      wrapperRef.current.style.transform = `translate(${x}px,${y}px) scale(${scale})`
    onZoomChange?.(Math.round(scale * 100))
    evictFarTiles()
    ensureVisibleTiles()
  }, [onZoomChange, evictFarTiles, ensureVisibleTiles])

  const toCanvas = useCallback((e) => {
    const vp = viewportRef.current.getBoundingClientRect()
    const { x, y, scale } = transform.current
    return { x: (e.clientX - vp.left - x) / scale, y: (e.clientY - vp.top - y) / scale }
  }, [])

  // ── Op sending ─────────────────────────────────────────────────────────────
  const sendOp = useCallback((op) => {
    if (wsRef.current?.readyState === WebSocket.OPEN)
      wsRef.current.send(JSON.stringify({ type: 'draw', op, sessionId }))
  }, [sessionId])

  const commitAndSend = useCallback((op) => {
    opsRef.current.push(op)
    applyOpToTiles(op)
    sendOp(op)
  }, [applyOpToTiles, sendOp])

  // ── Init ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    const vp = viewportRef.current
    const overlay = overlayRef.current
    if (overlay) { overlay.width = vp.clientWidth; overlay.height = vp.clientHeight }

    transform.current = {
      x: (vp.clientWidth  - CANVAS_W * INIT_SCALE) / 2,
      y: (vp.clientHeight - CANVAS_H * INIT_SCALE) / 2,
      scale: INIT_SCALE,
    }
    if (wrapperRef.current) {
      const { x, y, scale } = transform.current
      wrapperRef.current.style.transform = `translate(${x}px,${y}px) scale(${scale})`
    }
    onZoomChange?.(Math.round(INIT_SCALE * 100))

    const url = API_URL ? `${API_URL}/api/canvas` : '/api/canvas'
    fetch(url, { cache: 'no-store' })
      .then(r => r.json())
      .then(loadedOps => {
        opsRef.current = loadedOps
        // Redraw all tiles that were created blank before ops arrived
        for (const [key, { ctx }] of tilesRef.current.entries()) {
          const [tx, ty] = key.split(',').map(Number)
          ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE)
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE)
          const offX = tx * TILE_SIZE, offY = ty * TILE_SIZE
          for (const op of loadedOps) {
            if (opHitsTile(op, tx, ty)) {
              ctx.save(); ctx.translate(-offX, -offY); applyOp(ctx, op); ctx.restore()
            }
          }
        }
        // Create any visible tiles not yet in the map
        ensureVisibleTiles()
      })
      .catch(() => ensureVisibleTiles())

    const connectWs = () => {
      const wsTarget = API_URL
        ? API_URL.replace(/^http/, 'ws')
        : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
      const ws = new WebSocket(wsTarget)
      wsRef.current = ws
      onStatusChange?.('connecting')
      ws.onopen  = () => onStatusChange?.('live')
      ws.onerror = () => onStatusChange?.('offline')
      ws.onclose = () => { onStatusChange?.('offline'); setTimeout(connectWs, 3000) }
      ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data) } catch { return }
        if (msg.type === 'op') {
          if (msg.op?.sessionId === sessionId) return
          opsRef.current.push(msg.op)
          applyOpToTiles(msg.op)
        }
        if (msg.type === 'online') onOnlineChange?.(msg.count)
        if (msg.type === 'clear') {
          opsRef.current = []
          for (const { ctx } of tilesRef.current.values()) {
            ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE)
            ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE)
          }
        }
      }
    }
    connectWs()

    const ro = new ResizeObserver(() => {
      if (overlayRef.current && viewportRef.current) {
        overlayRef.current.width  = viewportRef.current.clientWidth
        overlayRef.current.height = viewportRef.current.clientHeight
      }
      ensureVisibleTiles()
    })
    ro.observe(vp)
    return () => { wsRef.current?.close(); ro.disconnect() }
  }, []) // eslint-disable-line

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const map = { p:'pen', e:'eraser', l:'line', r:'rect', c:'circle', t:'text', h:'pan' }
    const onKey   = (e) => {
      if (e.target.tagName === 'INPUT') return
      if (e.code === 'Space') { spaceHeld.current = true; e.preventDefault() }
      const m = map[e.key.toLowerCase()]
      if (m) window.dispatchEvent(new CustomEvent('tool-select', { detail: m }))
    }
    const onKeyUp = (e) => { if (e.code === 'Space') spaceHeld.current = false }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp) }
  }, [])

  // ── Mouse events ───────────────────────────────────────────────────────────
  const onMouseDown = useCallback((e) => {
    const isPanTool = toolRef.current === 'pan' || e.button === 1 || spaceHeld.current
    if (isPanTool) {
      isPanning.current = true
      panStart.current  = { x: e.clientX - transform.current.x, y: e.clientY - transform.current.y }
      e.preventDefault(); return
    }
    if (e.button !== 0) return
    if (transform.current.scale < 1) return

    const c = toCanvas(e)

    if (toolRef.current === 'text') {
      setTextState({ sx: e.clientX, sy: e.clientY, cx: c.x, cy: c.y })
      setTextVal(''); return
    }

    isDrawing.current = true

    if (toolRef.current === 'pen' || toolRef.current === 'eraser') {
      stroke.current = [c]
      const tx = Math.floor(c.x / TILE_SIZE), ty = Math.floor(c.y / TILE_SIZE)
      const tile = ensureTile(tx, ty)
      if (tile) {
        tile.ctx.save()
        tile.ctx.translate(-tx * TILE_SIZE, -ty * TILE_SIZE)
        tile.ctx.globalCompositeOperation = 'source-over'
        tile.ctx.fillStyle = toolRef.current === 'eraser' ? '#ffffff' : colorRef.current
        tile.ctx.beginPath()
        tile.ctx.arc(c.x, c.y, sizeRef.current / 2, 0, Math.PI * 2)
        tile.ctx.fill()
        tile.ctx.restore()
      }
    } else {
      shapeAnchor.current = c
    }
  }, [toCanvas, ensureTile])

  const onMouseMove = useCallback((e) => {
    if (isPanning.current) {
      transform.current.x = e.clientX - panStart.current.x
      transform.current.y = e.clientY - panStart.current.y
      pushTransform(); return
    }

    // Update cursor coordinates (centred: 0,0 = middle of canvas)
    const raw = toCanvas(e)
    onCursorMove?.({ x: Math.round(raw.x - CANVAS_W / 2), y: -Math.round(raw.y - CANVAS_H / 2) })

    if (!isDrawing.current) return

    const c   = raw
    const t   = toolRef.current
    const col = colorRef.current
    const sz  = sizeRef.current
    const { scale } = transform.current

    if (t === 'pen' || t === 'eraser') {
      const s = stroke.current, prev = s[s.length - 1]
      s.push(c)
      const minTX = Math.max(0, Math.floor((Math.min(prev.x, c.x) - sz) / TILE_SIZE))
      const minTY = Math.max(0, Math.floor((Math.min(prev.y, c.y) - sz) / TILE_SIZE))
      const maxTX = Math.min(TILES_X - 1, Math.floor((Math.max(prev.x, c.x) + sz) / TILE_SIZE))
      const maxTY = Math.min(TILES_Y - 1, Math.floor((Math.max(prev.y, c.y) + sz) / TILE_SIZE))
      for (let tx = minTX; tx <= maxTX; tx++) {
        for (let ty = minTY; ty <= maxTY; ty++) {
          const tile = tilesRef.current.get(`${tx},${ty}`) || ensureTile(tx, ty)
          if (!tile) continue
          tile.ctx.save()
          tile.ctx.translate(-tx * TILE_SIZE, -ty * TILE_SIZE)
          tile.ctx.globalCompositeOperation = 'source-over'
          tile.ctx.strokeStyle = t === 'eraser' ? '#ffffff' : col
          tile.ctx.lineWidth = sz; tile.ctx.lineCap = 'round'; tile.ctx.lineJoin = 'round'
          tile.ctx.beginPath(); tile.ctx.moveTo(prev.x, prev.y); tile.ctx.lineTo(c.x, c.y)
          tile.ctx.stroke(); tile.ctx.restore()
        }
      }
      return
    }

    const anchor = shapeAnchor.current
    if (!anchor) return
    const oct = overlayCtx()
    const vp  = viewportRef.current
    oct.clearRect(0, 0, vp.clientWidth, vp.clientHeight)
    oct.save()
    oct.strokeStyle = col; oct.fillStyle = col

    const va = toVP(anchor.x, anchor.y), vc = toVP(c.x, c.y)

    if (t === 'line') {
      oct.lineWidth = sz * scale; oct.lineCap = 'round'
      oct.beginPath(); oct.moveTo(va.x, va.y); oct.lineTo(vc.x, vc.y); oct.stroke()
    } else if (t === 'rect') {
      const x = Math.min(va.x, vc.x), y = Math.min(va.y, vc.y)
      const w = Math.abs(vc.x - va.x),  h = Math.abs(vc.y - va.y)
      oct.lineWidth = 2 * scale
      if (filledRef.current) oct.fillRect(x, y, w, h); else oct.strokeRect(x, y, w, h)
    } else if (t === 'circle') {
      const rx = (vc.x - va.x) / 2, ry = (vc.y - va.y) / 2
      oct.lineWidth = 2 * scale
      oct.beginPath()
      oct.ellipse(va.x + rx, va.y + ry, Math.abs(rx) || 1, Math.abs(ry) || 1, 0, 0, Math.PI * 2)
      if (filledRef.current) oct.fill(); else oct.stroke()
    }
    oct.restore()
  }, [toCanvas, toVP, pushTransform, ensureTile])

  const finishStroke = useCallback(() => {
    const pts = stroke.current
    if (pts.length > 0) {
      const op = { type: 'stroke', points: pts, color: colorRef.current, size: sizeRef.current, eraser: toolRef.current === 'eraser' }
      opsRef.current.push(op)
      sendOp(op)
    }
    stroke.current = []
  }, [sendOp])

  const onMouseUp = useCallback((e) => {
    if (isPanning.current) { isPanning.current = false; return }
    if (!isDrawing.current) return
    isDrawing.current = false

    const t = toolRef.current
    if (t === 'pen' || t === 'eraser') { finishStroke(); return }

    const c = toCanvas(e), anchor = shapeAnchor.current
    if (!anchor) return
    clearOverlay()

    if (t === 'line') {
      commitAndSend({ type: 'line', x1: anchor.x, y1: anchor.y, x2: c.x, y2: c.y, color: colorRef.current, size: sizeRef.current })
    } else if (t === 'rect') {
      const x = Math.min(anchor.x, c.x), y = Math.min(anchor.y, c.y)
      commitAndSend({ type: 'rect', x, y, w: Math.abs(c.x - anchor.x), h: Math.abs(c.y - anchor.y), color: colorRef.current, filled: filledRef.current, lineWidth: 2 })
    } else if (t === 'circle') {
      const rx = (c.x - anchor.x) / 2, ry = (c.y - anchor.y) / 2
      commitAndSend({ type: 'circle', cx: anchor.x + rx, cy: anchor.y + ry, rx, ry, color: colorRef.current, filled: filledRef.current, lineWidth: 2 })
    }
    shapeAnchor.current = null
  }, [toCanvas, finishStroke, commitAndSend])

  // ── Touch events (mobile drawing) ─────────────────────────────────────────
  const onTouchStart = useCallback((e) => {
    if (e.touches.length === 1) {
      e.preventDefault()
      const t = e.touches[0]
      onMouseDown({ clientX: t.clientX, clientY: t.clientY, button: 0 })
    } else if (e.touches.length === 2) {
      e.preventDefault()
      isPanning.current = false
      isDrawing.current = false
    }
  }, [onMouseDown])

  const onTouchMove = useCallback((e) => {
    if (e.touches.length === 1) {
      e.preventDefault()
      const t = e.touches[0]
      onMouseMove({ clientX: t.clientX, clientY: t.clientY })
    } else if (e.touches.length === 2) {
      e.preventDefault()
      // Pinch-to-zoom
      const [a, b] = [e.touches[0], e.touches[1]]
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
      if (!pinchDistRef.current) { pinchDistRef.current = dist; return }
      const factor = dist / pinchDistRef.current
      pinchDistRef.current = dist
      const mx = (a.clientX + b.clientX) / 2
      const my = (a.clientY + b.clientY) / 2
      const vp = viewportRef.current.getBoundingClientRect()
      const cx = mx - vp.left, cy = my - vp.top
      const ns = Math.max(0.25, Math.min(1, transform.current.scale * factor))
      transform.current.x = cx - (cx - transform.current.x) * (ns / transform.current.scale)
      transform.current.y = cy - (cy - transform.current.y) * (ns / transform.current.scale)
      transform.current.scale = ns
      pushTransform()
    }
  }, [onMouseMove, pushTransform])

  const onTouchEnd = useCallback((e) => {
    e.preventDefault()
    pinchDistRef.current = null
    onMouseUp({ clientX: 0, clientY: 0, button: 0 })
  }, [onMouseUp])

  useEffect(() => {
    const vp = viewportRef.current
    vp.addEventListener('touchstart',  onTouchStart, { passive: false })
    vp.addEventListener('touchmove',   onTouchMove,  { passive: false })
    vp.addEventListener('touchend',    onTouchEnd,   { passive: false })
    vp.addEventListener('touchcancel', onTouchEnd,   { passive: false })
    return () => {
      vp.removeEventListener('touchstart',  onTouchStart)
      vp.removeEventListener('touchmove',   onTouchMove)
      vp.removeEventListener('touchend',    onTouchEnd)
      vp.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [onTouchStart, onTouchMove, onTouchEnd])

  // ── Zoom on scroll ─────────────────────────────────────────────────────────
  useEffect(() => {
    const vp = viewportRef.current
    const onWheel = (e) => {
      e.preventDefault()
      const factor   = e.deltaY < 0 ? 1.1 : 0.9
      const newScale = Math.max(0.25, Math.min(1, transform.current.scale * factor))
      const rect = vp.getBoundingClientRect()
      const mx = e.clientX - rect.left, my = e.clientY - rect.top
      transform.current.x = mx - (mx - transform.current.x) * (newScale / transform.current.scale)
      transform.current.y = my - (my - transform.current.y) * (newScale / transform.current.scale)
      transform.current.scale = newScale
      pushTransform()
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => vp.removeEventListener('wheel', onWheel)
  }, [pushTransform])

  // ── Text commit ────────────────────────────────────────────────────────────
  const commitText = useCallback(() => {
    if (!textState || !textVal.trim()) { setTextState(null); return }
    const op = { type: 'text', x: textState.cx, y: textState.cy, text: textVal.trim(), color: colorRef.current, fontSize: fontSizeRef.current }
    commitAndSend(op)
    setTextState(null); setTextVal('')
  }, [textState, textVal, commitAndSend])

  // ── Render ─────────────────────────────────────────────────────────────────
  const viewOnly = zoom < 100
  const cursors  = { pen:'crosshair', eraser:'cell', line:'crosshair', rect:'crosshair', circle:'crosshair', text:'text', pan:'grab' }
  const cursor   = spaceHeld.current ? 'grab' : viewOnly ? 'default' : (cursors[tool] || 'crosshair')

  const textInputStyle = textState ? {
    left: textState.sx + 'px', top: textState.sy + 'px',
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
        onCursorMove?.(null)
        if (isPanning.current) isPanning.current = false
        if (isDrawing.current) {
          isDrawing.current = false
          if (toolRef.current === 'pen' || toolRef.current === 'eraser') finishStroke()
          clearOverlay(); shapeAnchor.current = null
        }
      }}
      onContextMenu={e => e.preventDefault()}
    >
      <div className="dot-grid" />

      <div ref={wrapperRef} className="canvas-wrapper" style={{ transformOrigin: '0 0' }}>
        <div ref={tileContainerRef} style={{ position: 'relative', background: '#ffffff' }} />
      </div>

      <canvas ref={overlayRef} className="overlay-canvas vp-overlay" />

      {textState && (
        <div className="text-overlay" style={textInputStyle}>
          <input
            autoFocus className="text-field" value={textVal}
            onChange={e => setTextVal(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText() }
              if (e.key === 'Escape') setTextState(null)
            }}
            placeholder="Type here…"
            style={{ color, fontSize: 'var(--fs)', fontFamily: 'Outfit, sans-serif' }}
          />
          <div className="text-hint"><kbd>Enter</kbd> to place · <kbd>Esc</kbd> to cancel</div>
        </div>
      )}

      {viewOnly && <div className="viewonly-badge">view only — zoom to 100% to draw</div>}

      <div className="corner-controls">
        <button className="corner-btn" title="Reset view" onClick={() => {
          const vp = viewportRef.current
          transform.current = {
            x: (vp.clientWidth  - CANVAS_W * INIT_SCALE) / 2,
            y: (vp.clientHeight - CANVAS_H * INIT_SCALE) / 2,
            scale: INIT_SCALE,
          }
          pushTransform()
        }}>
          <svg viewBox="0 0 16 16" fill="none" width="14"><path d="M2 8a6 6 0 1110.83-3.5M14 2v4h-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        <button className="corner-btn" title="Zoom in" onClick={() => {
          const vp = viewportRef.current
          const cx = vp.clientWidth / 2, cy = vp.clientHeight / 2
          const ns = Math.min(1, transform.current.scale * 1.25)
          transform.current.x = cx - (cx - transform.current.x) * (ns / transform.current.scale)
          transform.current.y = cy - (cy - transform.current.y) * (ns / transform.current.scale)
          transform.current.scale = ns; pushTransform()
        }}>
          <svg viewBox="0 0 16 16" fill="none" width="14"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5"/><path d="M7 5v4M5 7h4M11 11l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
        <button className="corner-btn" title="Zoom out" onClick={() => {
          const vp = viewportRef.current
          const cx = vp.clientWidth / 2, cy = vp.clientHeight / 2
          const ns = Math.max(0.25, transform.current.scale * 0.8)
          transform.current.x = cx - (cx - transform.current.x) * (ns / transform.current.scale)
          transform.current.y = cy - (cy - transform.current.y) * (ns / transform.current.scale)
          transform.current.scale = ns; pushTransform()
        }}>
          <svg viewBox="0 0 16 16" fill="none" width="14"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5"/><path d="M5 7h4M11 11l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
        </button>
      </div>
    </div>
  )
}
