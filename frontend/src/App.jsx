import { useState, useRef, useEffect, useCallback, Component } from 'react'
import CanvasBoard from './components/CanvasBoard'
import Toolbar from './components/Toolbar'
import './App.css'

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: 16, fontFamily: 'Outfit, sans-serif' }}>
          <p style={{ color: '#888', margin: 0 }}>Something went wrong. Please reload.</p>
          <button onClick={() => window.location.reload()} style={{ padding: '8px 20px', cursor: 'pointer' }}>
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

const _rawApiUrl = import.meta.env.VITE_API_URL || ''
const API_BASE = _rawApiUrl && !_rawApiUrl.startsWith('http')
  ? `https://${_rawApiUrl.replace(/\/$/, '')}`
  : _rawApiUrl.replace(/\/$/, '')

function genSessionId() {
  const stored = localStorage.getItem('infinicanvas_sid')
  if (stored) return stored
  const id = 'u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  localStorage.setItem('infinicanvas_sid', id)
  return id
}

export default function App() {
  const [tool, setTool]         = useState('pen')
  const [color, setColor]       = useState('#00d4c8')
  const [brushSize, setBrushSize] = useState(6)
  const [filled, setFilled]     = useState(false)
  const [fontSize, setFontSize] = useState(24)
  const [online, setOnline]     = useState(1)
  const [zoom, setZoom]         = useState(100)
  const [cursor, setCursor]     = useState(null)  // { x, y } in canvas coords centred on (0,0)
  const [wsStatus, setWsStatus] = useState('connecting') // connecting | live | offline
  const [timelapseLoading, setTimelapseLoading] = useState(false)
  const [snapshotCount, setSnapshotCount] = useState(0)
  const sessionId  = useRef(genSessionId())
  const captureRef = useRef(null)

  // Auto-capture every 5 minutes
  useEffect(() => {
    const doCapture = async () => {
      const dataUrl = await captureRef.current?.()
      if (!dataUrl) return
      const png = dataUrl.split(',')[1]
      try {
        await fetch(`${API_BASE}/api/snapshots`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ png, timestamp: Date.now() }),
        })
        setSnapshotCount(c => c + 1)
      } catch {}
    }
    const id = setInterval(doCapture, 5 * 60 * 1000)
    // Fetch current count on mount
    fetch(`${API_BASE}/api/snapshots/count`)
      .then(r => r.json()).then(d => setSnapshotCount(d.count ?? 0)).catch(() => {})
    return () => clearInterval(id)
  }, [])

  const downloadTimelapse = useCallback(async () => {
    if (timelapseLoading) return
    setTimelapseLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/snapshots/gif`)
      if (!res.ok) { alert('No snapshots yet — the canvas auto-captures every 5 minutes.'); return }
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'infinicanvas-timelapse.gif'
      a.click()
    } catch { alert('Failed to generate timelapse.') }
    finally { setTimelapseLoading(false) }
  }, [timelapseLoading])

  return (
    <ErrorBoundary>
    <div className="app">
      {/* ── Header ─────────────────────────────── */}
      <header className="header">
        <div className="header-left">
          <div className="logo">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <rect x="2" y="2" width="7" height="7" fill="var(--teal)" opacity="0.9"/>
              <rect x="11" y="2" width="7" height="7" fill="var(--teal)" opacity="0.5"/>
              <rect x="2" y="11" width="7" height="7" fill="var(--teal)" opacity="0.5"/>
              <rect x="11" y="11" width="7" height="7" fill="var(--teal)" opacity="0.2"/>
            </svg>
            <span className="logo-text">Infini<span>Canvas</span></span>
          </div>
          <div className="header-divider" />
          <span className="canvas-tag">65536 × 65536</span>
        </div>

        <div className="header-right">
          <button
            className={`timelapse-btn${timelapseLoading ? ' loading' : ''}`}
            onClick={downloadTimelapse}
            disabled={timelapseLoading}
            title={snapshotCount ? `Download timelapse GIF (${snapshotCount} frame${snapshotCount !== 1 ? 's' : ''})` : 'Captures every 5 min — check back later'}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="3" width="10" height="10" rx="1" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M11 6l4-2v8l-4-2V6z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            </svg>
            <span>{timelapseLoading ? 'Generating…' : 'Timelapse'}</span>
            {snapshotCount > 0 && !timelapseLoading && (
              <span className="timelapse-count">{snapshotCount}</span>
            )}
          </button>
          <span className="built-by">built by <span className="built-by-name">TheBooleanJulian</span></span>
          <div className={`ws-badge ws-${wsStatus}`}>
            <span className="ws-dot" />
            <span>{wsStatus === 'live' ? `${online} online` : wsStatus}</span>
          </div>
          <div className="zoom-display">
            <span className="zoom-label">ZOOM</span>
            <span className="zoom-val">{zoom}%</span>
          </div>
          {cursor && (
            <div className="cursor-display">
              <span className="zoom-label">XY</span>
              <span className="zoom-val">{cursor.x}, {cursor.y}</span>
            </div>
          )}
        </div>
      </header>

      {/* ── Workspace ──────────────────────────── */}
      <div className="workspace">
        <Toolbar
          tool={tool}       setTool={setTool}
          color={color}     setColor={setColor}
          brushSize={brushSize} setBrushSize={setBrushSize}
          filled={filled}   setFilled={setFilled}
          fontSize={fontSize} setFontSize={setFontSize}
        />
        <CanvasBoard
          tool={tool}
          color={color}
          brushSize={brushSize}
          filled={filled}
          fontSize={fontSize}
          sessionId={sessionId.current}
          onOnlineChange={setOnline}
          onZoomChange={setZoom}
          onStatusChange={setWsStatus}
          onCursorMove={setCursor}
          zoom={zoom}
          captureRef={captureRef}
        />
      </div>
    </div>
    </ErrorBoundary>
  )
}
