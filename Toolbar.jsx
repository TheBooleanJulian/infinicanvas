import { useState } from 'react'
import './Toolbar.css'

/* ── Tool definitions ─────────────────────────── */
const TOOLS = [
  {
    id: 'pen', label: 'Pen', key: 'P',
    icon: (
      <svg viewBox="0 0 20 20" fill="none">
        <path d="M14 3l3 3L7 16H4v-3L14 3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
        <path d="M12 5l3 3" stroke="currentColor" strokeWidth="1.5"/>
      </svg>
    )
  },
  {
    id: 'eraser', label: 'Eraser', key: 'E',
    icon: (
      <svg viewBox="0 0 20 20" fill="none">
        <path d="M4 16h12M14.5 4.5L17 7l-8 8H5l-1-1 7-7 3.5-3.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
        <path d="M9 7l4 4" stroke="currentColor" strokeWidth="1.5"/>
      </svg>
    )
  },
  {
    id: 'line', label: 'Line', key: 'L',
    icon: (
      <svg viewBox="0 0 20 20" fill="none">
        <path d="M4 16L16 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        <circle cx="4" cy="16" r="2" fill="currentColor"/>
        <circle cx="16" cy="4" r="2" fill="currentColor"/>
      </svg>
    )
  },
  {
    id: 'rect', label: 'Rect', key: 'R',
    icon: (
      <svg viewBox="0 0 20 20" fill="none">
        <rect x="3" y="5" width="14" height="10" stroke="currentColor" strokeWidth="1.5" rx="1"/>
      </svg>
    )
  },
  {
    id: 'circle', label: 'Circle', key: 'C',
    icon: (
      <svg viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.5"/>
      </svg>
    )
  },
  {
    id: 'text', label: 'Text', key: 'T',
    icon: (
      <svg viewBox="0 0 20 20" fill="none">
        <path d="M4 5h12M10 5v11M7 16h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    )
  },
  {
    id: 'pan', label: 'Pan', key: 'H',
    icon: (
      <svg viewBox="0 0 20 20" fill="none">
        <path d="M8 3v8M11 4v7M14 6v5M5 9v4a4 4 0 004 4h2a4 4 0 004-4v-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        <path d="M5 9a1 1 0 012 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    )
  },
]

const PALETTE = [
  '#ffffff', '#e8e8e8', '#aaaaaa', '#555555', '#000000',
  '#ff5f6d', '#ff9a3c', '#ffd93d', '#6bcb77', '#4d9de0',
  '#7b2d8b', '#e040fb', '#00d4c8', '#0096c7', '#023e8a',
  '#ff006e', '#fb5607', '#ffbe0b', '#8338ec', '#3a86ff',
]

/* ── Helpers ──────────────────────────────────── */
function hexToRgb(hex) {
  const h = hex.replace('#', '').padEnd(6, '0')
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ]
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')
}

/* ── Component ────────────────────────────────── */
export default function Toolbar({ tool, setTool, color, setColor, brushSize, setBrushSize, filled, setFilled, fontSize, setFontSize }) {
  const [hexInput, setHexInput] = useState(color)
  const [r, g, b] = hexToRgb(color)

  const handleHex = (val) => {
    setHexInput(val)
    if (/^#[0-9a-fA-F]{6}$/.test(val)) setColor(val)
  }

  const setRGB = (nr, ng, nb) => {
    const next = rgbToHex(nr ?? r, ng ?? g, nb ?? b)
    setColor(next)
    setHexInput(next)
  }

  const handleSwatchClick = (c) => {
    setColor(c)
    setHexInput(c)
  }

  const showFillToggle = tool === 'rect' || tool === 'circle'
  const showBrushSize  = tool === 'pen' || tool === 'eraser' || tool === 'line'
  const showFontSize   = tool === 'text'
  const showColor      = tool !== 'eraser' && tool !== 'pan'

  return (
    <aside className="toolbar">
      {/* ── Tools ── */}
      <div className="tb-section">
        <div className="tb-label">TOOLS</div>
        <div className="tool-grid">
          {TOOLS.map(t => (
            <button
              key={t.id}
              className={`tool-btn ${tool === t.id ? 'active' : ''}`}
              onClick={() => setTool(t.id)}
              title={`${t.label} [${t.key}]`}
            >
              <span className="tool-icon">{t.icon}</span>
              <span className="tool-name">{t.label}</span>
              <span className="tool-key">{t.key}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Fill toggle ── */}
      {showFillToggle && (
        <div className="tb-section">
          <div className="tb-label">STYLE</div>
          <div className="toggle-pair">
            <button className={`toggle-btn ${!filled ? 'active' : ''}`} onClick={() => setFilled(false)}>
              <svg viewBox="0 0 16 16" fill="none" width="14">
                <rect x="2" y="2" width="12" height="12" stroke="currentColor" strokeWidth="1.5" rx="1"/>
              </svg>
              Outline
            </button>
            <button className={`toggle-btn ${filled ? 'active' : ''}`} onClick={() => setFilled(true)}>
              <svg viewBox="0 0 16 16" fill="currentColor" width="14">
                <rect x="2" y="2" width="12" height="12" rx="1"/>
              </svg>
              Filled
            </button>
          </div>
        </div>
      )}

      {/* ── Brush size ── */}
      {showBrushSize && (
        <div className="tb-section">
          <div className="tb-label-row">
            <span className="tb-label">SIZE</span>
            <span className="tb-val">{brushSize}px</span>
          </div>
          <input
            type="range" min="1" max="60" value={brushSize}
            onChange={e => setBrushSize(+e.target.value)}
            className="full-range"
          />
          <div className="brush-preview-row">
            <div
              className="brush-dot"
              style={{
                width: Math.min(brushSize, 48) + 'px',
                height: Math.min(brushSize, 48) + 'px',
                background: tool === 'eraser' ? '#ffffff' : color,
                border: tool === 'eraser' ? '1.5px solid #333' : 'none',
              }}
            />
          </div>
        </div>
      )}

      {/* ── Font size ── */}
      {showFontSize && (
        <div className="tb-section">
          <div className="tb-label-row">
            <span className="tb-label">FONT SIZE</span>
            <span className="tb-val">{fontSize}px</span>
          </div>
          <input
            type="range" min="8" max="120" value={fontSize}
            onChange={e => setFontSize(+e.target.value)}
            className="full-range"
          />
          <div className="font-preview" style={{ fontSize: Math.min(fontSize, 32) + 'px', color }}>
            Aa
          </div>
        </div>
      )}

      {/* ── Color ── */}
      {showColor && (
        <div className="tb-section color-section">
          <div className="tb-label">COLOR</div>

          {/* Swatch + hex */}
          <div className="color-top-row">
            <div className="color-swatch-large" style={{ background: color }}>
              <input
                type="color" value={color}
                onChange={e => { setColor(e.target.value); setHexInput(e.target.value) }}
                className="native-color-picker"
                title="Open color picker"
              />
            </div>
            <div className="hex-wrapper">
              <span className="hex-hash">#</span>
              <input
                className="hex-input"
                value={hexInput.replace('#', '')}
                maxLength={6}
                spellCheck={false}
                onChange={e => handleHex('#' + e.target.value)}
                onBlur={() => setHexInput(color)}
              />
            </div>
          </div>

          {/* RGB sliders */}
          <div className="rgb-sliders">
            {[
              { label: 'R', val: r, cls: 'slider-r', fn: v => setRGB(v, null, null), col: '#ff5f6d' },
              { label: 'G', val: g, cls: 'slider-g', fn: v => setRGB(null, v, null), col: '#39d98a' },
              { label: 'B', val: b, cls: 'slider-b', fn: v => setRGB(null, null, v), col: '#74c0fc' },
            ].map(({ label, val, cls, fn, col }) => (
              <div className="rgb-row" key={label}>
                <span className="rgb-label" style={{ color: col }}>{label}</span>
                <input type="range" min="0" max="255" value={val}
                  onChange={e => fn(+e.target.value)} className={cls} />
                <span className="rgb-num">{val}</span>
              </div>
            ))}
          </div>

          {/* Palette */}
          <div className="palette">
            {PALETTE.map(c => (
              <button
                key={c}
                className={`swatch ${color === c ? 'swatch-active' : ''}`}
                style={{ background: c }}
                onClick={() => handleSwatchClick(c)}
                title={c}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Tips ── */}
      <div className="tb-tips">
        <div className="tip-line">Scroll to zoom</div>
        <div className="tip-line">Middle-click or H to pan</div>
        <div className="tip-line">Space+drag to pan</div>
      </div>
    </aside>
  )
}
