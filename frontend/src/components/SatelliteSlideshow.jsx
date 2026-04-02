import React, { useState, useEffect, useRef, useCallback } from "react"
import { TileLayer, Pane } from "react-leaflet"

const SPEEDS = [
  { label: "0.5×", ms: 2000 },
  { label: "1×",   ms: 1000 },
  { label: "2×",   ms: 500  },
  { label: "4×",   ms: 250  },
]

/**
 * SatelliteSlideshow
 *
 * Props:
 *   frames        : [{ year, tile_url }]  — sorted ascending
 *   loading       : bool  — true while backend is generating URLs
 *   onClose       : () => void
 */
export default function SatelliteSlideshow({ frames = [], loading, onClose }) {
  const [idx,       setIdx]       = useState(0)
  const [playing,   setPlaying]   = useState(false)
  const [speedIdx,  setSpeedIdx]  = useState(1)   // default 1×
  const [opacity,   setOpacity]   = useState(0.9)
  const timerRef = useRef(null)

  const total = frames.length
  const current = frames[idx] ?? null

  // Auto-advance when playing
  const advance = useCallback(() => {
    setIdx(prev => {
      if (prev >= total - 1) { setPlaying(false); return prev }
      return prev + 1
    })
  }, [total])

  useEffect(() => {
    if (playing && total > 1) {
      timerRef.current = setInterval(advance, SPEEDS[speedIdx].ms)
    } else {
      clearInterval(timerRef.current)
    }
    return () => clearInterval(timerRef.current)
  }, [playing, speedIdx, advance, total])

  // Reset to start when new frames arrive
  useEffect(() => { setIdx(0); setPlaying(false) }, [frames])

  // Block ALL pointer events from leaking through to the Leaflet map underneath
  const stopEvents = useCallback(e => {
    e.stopPropagation()
    e.nativeEvent?.stopImmediatePropagation?.()
  }, [])

  if (loading) {
    return (
      <>
        {/* Loading badge on the map */}
        <div
          style={panelStyle}
          onClick={stopEvents}
          onMouseDown={stopEvents}
          onTouchStart={stopEvents}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem",
                        fontSize: "0.82rem", color: "var(--text-secondary)" }}>
            <div style={spinnerStyle} />
            Generating satellite frames… this takes ~20 s
          </div>
        </div>
      </>
    )
  }

  if (!total) return null

  return (
    <>
      {/* ── Active satellite tile layer ── */}
      {current?.tile_url && (
        <Pane name="slideshowPane" style={{ zIndex: 600 }}>
          <TileLayer url={current.tile_url} opacity={opacity} />
        </Pane>
      )}

      {/* ── Control panel (overlaid on map bottom-center) ── */}
      <div
        style={panelStyle}
        onClick={stopEvents}
        onMouseDown={stopEvents}
        onMouseUp={stopEvents}
        onTouchStart={stopEvents}
        onTouchEnd={stopEvents}
        onWheel={stopEvents}
      >
        {/* Year badge */}
        <div style={{
          fontSize: "1.6rem", fontWeight: 800, color: "white",
          letterSpacing: "-0.03em", textShadow: "0 2px 8px rgba(0,0,0,0.6)",
          minWidth: "60px", textAlign: "center",
        }}>
          {current?.year ?? "—"}
        </div>

        {/* Satellite label */}
        <div style={{ fontSize: "0.62rem", color: "#e0a800", fontWeight: 600,
                      letterSpacing: "0.06em", marginTop: "-10px", textAlign: "center" }}>
          {current?.year < 2022
            ? current?.year < 2013
              ? current?.year < 1999 ? "LANDSAT 5" : "LANDSAT 7"
              : "LANDSAT 8"
            : "LANDSAT 9"}
        </div>

        {/* Scrubber */}
        <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "4px" }}>
          <input
            type="range" min={0} max={Math.max(0, total - 1)} value={idx}
            onChange={e => { setPlaying(false); setIdx(+e.target.value) }}
            style={{ width: "100%", cursor: "pointer" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between",
                        fontSize: "0.65rem", color: "var(--text-secondary)" }}>
            <span>{frames[0]?.year}</span>
            <span>{idx + 1} / {total}</span>
            <span>{frames[total - 1]?.year}</span>
          </div>
        </div>

        {/* Transport controls */}
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
          {/* Prev */}
          <button style={btnStyle} onClick={() => { setPlaying(false); setIdx(i => Math.max(0, i - 1)) }}>
            ⏮
          </button>

          {/* Play / Pause */}
          <button
            style={{ ...btnStyle, background: playing ? "var(--danger)" : "var(--accent)",
                     width: "42px", height: "42px", fontSize: "1.1rem" }}
            onClick={() => setPlaying(p => !p)}
            disabled={total <= 1}
          >
            {playing ? "⏸" : "▶"}
          </button>

          {/* Next */}
          <button style={btnStyle} onClick={() => { setPlaying(false); setIdx(i => Math.min(total - 1, i + 1)) }}>
            ⏭
          </button>

          {/* Speed selector */}
          <div style={{ display: "flex", gap: "2px" }}>
            {SPEEDS.map((s, i) => (
              <button key={s.label} style={{
                ...btnStyle,
                fontSize: "0.68rem", padding: "4px 7px",
                background: speedIdx === i ? "var(--accent)" : "rgba(255,255,255,0.1)",
              }} onClick={() => setSpeedIdx(i)}>
                {s.label}
              </button>
            ))}
          </div>

          {/* Close */}
          <button style={{ ...btnStyle, background: "rgba(255,255,255,0.08)", fontSize: "0.8rem" }}
            onClick={onClose}>
            ✕ Exit
          </button>
        </div>

        {/* Opacity */}
        <div style={{ width: "100%", display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <span style={{ fontSize: "0.65rem", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
            Opacity {Math.round(opacity * 100)}%
          </span>
          <input type="range" min={0} max={1} step={0.05} value={opacity}
            onChange={e => setOpacity(+e.target.value)} style={{ flex: 1 }} />
        </div>
      </div>
    </>
  )
}

/* ── Inline styles ──────────────────────────────────────────────────── */
const panelStyle = {
  position: "absolute",
  bottom: "24px",
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 1100,
  pointerEvents: "all",   // explicitly capture — don't let clicks fall through to Leaflet
  background: "rgba(10,14,26,0.88)",
  backdropFilter: "blur(16px)",
  border: "1px solid rgba(255,255,255,0.10)",
  borderRadius: "14px",
  padding: "14px 20px",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "10px",
  minWidth: "380px",
  maxWidth: "480px",
  boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
  cursor: "default",
  userSelect: "none",
}

const btnStyle = {
  background: "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: "8px",
  color: "white",
  cursor: "pointer",
  padding: "6px 10px",
  fontSize: "0.9rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "background 0.15s ease",
}

const spinnerStyle = {
  width: "16px",
  height: "16px",
  border: "2px solid rgba(255,255,255,0.2)",
  borderTopColor: "var(--accent)",
  borderRadius: "50%",
  animation: "spin 0.8s linear infinite",
}
