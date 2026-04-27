import { useState, useRef, useEffect, Component } from 'react'
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
  const sessionId = useRef(genSessionId())

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
          <span className="canvas-tag">2048 × 2048</span>
        </div>

        <div className="header-right">
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
        />
      </div>
    </div>
    </ErrorBoundary>
  )
}
