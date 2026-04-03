/**
 * SlideshowWindow – a draggable floating window that contains:
 *   - its own Leaflet map showing the satellite imagery
 *   - playback controls embedded below the map
 *
 * Rendered with position:fixed so it truly floats above the entire app.
 * The parent only needs to provide frames, loading state, quality, bounds,
 * and callbacks — all playback state lives here.
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { MapContainer, TileLayer, ImageOverlay, useMap } from "react-leaflet"

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") || ""
const apiUrl = (path) => `${API_BASE_URL}${path}`

/* ── constants ─────────────────────────────────────────────────── */
const SPEEDS = [
  { label: "0.5×", ms: 2000 },
  { label: "1×",   ms: 1000 },
  { label: "2×",   ms: 500  },
  { label: "4×",   ms: 250  },
]

const TECHNIQUE_OPTIONS = [
  {
    id: "median",
    label: "Natural Median",
    icon: "🌐",
    description: "Blends many scenes to reduce clouds and haze. Most stable and realistic over time.",
  },
  {
    id: "best",
    label: "Best Capture",
    icon: "📷",
    description: "Uses a single clearest scene. Sharper detail, but more sensitive to seasonal/lighting shifts.",
  },
]

const DATASET_META = {
  rgb:   { text: "🌍 RGB Optical", color: "#4caf50", bg: "rgba(76,175,80,0.20)" },
  ndvi:  { text: "🌿 Veg NDVI",   color: "#8bc34a", bg: "rgba(139,195,74,0.15)" },
  night: { text: "🌃 Night Map", color: "#fbc02d", bg: "rgba(251,192,45,0.15)" },
  water: { text: "💧 Surface Water", color: "#03a9f4", bg: "rgba(3,169,244,0.15)" },
  fire:  { text: "🔥 Thermal FIRMS", color: "#f44336", bg: "rgba(244,67,54,0.15)" },
  sar:   { text: "📡 Radar SAR", color: "#9e9e9e", bg: "rgba(158,158,158,0.15)" },
}

const GIF_QUALITY_OPTIONS = [
  { value: "draft", label: "Draft (fast)" },
  { value: "standard", label: "Standard" },
  { value: "high", label: "High" },
]

const GIF_RESOLUTION_OPTIONS = [
  { value: 768, label: "768 px" },
  { value: 1024, label: "1024 px" },
  { value: 1536, label: "1536 px" },
]

const gifSelectStyle = {
  width: "100%",
  borderRadius: "8px",
  border: "1px solid rgba(255,255,255,0.12)",
  background: "#f3f6fb",
  color: "#101828",
  padding: "8px 10px",
  fontSize: "0.8rem",
}

/* ── BoundsSyncer: fits the inner Leaflet map to the analysis bbox ── */
function BoundsSyncer({ bounds }) {
  const map = useMap()
  useEffect(() => {
    if (bounds) map.fitBounds(bounds, { animate: false, padding: [12, 12] })
  }, [bounds, map])
  return null
}

/* ═══════════════════════════════════════════════════════════════════ */
export default function SlideshowWindow({
  frames = [],
  loading,
  onClose,
  label,
  dataset = "rgb",
  method  = "median",
  setMethod,
  reFetch,
  bounds,   // [[lat_sw, lng_sw], [lat_ne, lng_ne]] from analysis result
}) {
  /* playback */
  const [idx,      setIdx]      = useState(0)
  const [playing,  setPlaying]  = useState(false)
  const [speedIdx, setSpeedIdx] = useState(1)
  const [opacity,  setOpacity]  = useState(0.95)
  const [gifLoading, setGifLoading] = useState(false)
  const [showGifConfig, setShowGifConfig] = useState(false)
  const [gifAddTimestamps, setGifAddTimestamps] = useState(true)
  const [gifFps, setGifFps] = useState(4)
  const [gifQuality, setGifQuality] = useState("high")
  const [gifDimensions, setGifDimensions] = useState(1024)
  const timerRef = useRef(null)
  const preloadRef = useRef(null)

  /* dragging */
  const [pos, setPos]  = useState(null)   // null = CSS-centered, else {x,y} in px
  const drag = useRef({ active: false, ox: 0, oy: 0 })

  const safeFrames = useMemo(() => {
    if (!Array.isArray(frames)) return []
    return frames
      .map((f) => ({
        year: Number(f?.year),
        tile_url: f?.tile_url || f?.url || null,
      }))
      .filter((f) => Number.isFinite(f.year) && typeof f.tile_url === "string" && f.tile_url.length > 0)
      .sort((a, b) => a.year - b.year)
  }, [frames])

  const [loadedFrameUrls, setLoadedFrameUrls] = useState({})
  const [visibleIdx, setVisibleIdx] = useState(0)

  const total   = safeFrames.length
  const current = safeFrames[idx] ?? null
  const visibleFrame = safeFrames[visibleIdx] ?? current
  const dsMeta  = DATASET_META[dataset] ?? DATASET_META.rgb

  useEffect(() => {
    setLoadedFrameUrls({})
    setVisibleIdx(0)

    if (safeFrames.length === 0) return undefined

    let cancelled = false
    const urls = [...new Set(safeFrames.map((frame) => frame.tile_url))]

    const markLoaded = (url) => {
      if (cancelled) return
      setLoadedFrameUrls((prev) => (prev[url] ? prev : { ...prev, [url]: true }))
    }

    preloadRef.current = urls.map((url) => {
      const img = new Image()
      img.decoding = "async"
      img.onload = () => markLoaded(url)
      img.onerror = () => markLoaded(url)
      img.src = url
      return img
    })

    return () => {
      cancelled = true
      preloadRef.current = null
    }
  }, [safeFrames])

  useEffect(() => {
    if (!current) return
    if (loadedFrameUrls[current.tile_url]) {
      setVisibleIdx(idx)
    }
  }, [current, idx, loadedFrameUrls])

  /* ── export ───────────────────────────────────────────────────── */
  const handleExportGif = async () => {
    if (!bounds || total === 0 || gifLoading) return
    setGifLoading(true)
    try {
      const bbox = [bounds[0][1], bounds[0][0], bounds[1][1], bounds[1][0]]
      const res = await fetch(apiUrl("/api/gee/timelapse-gif"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bbox,
          year_start: safeFrames[0].year,
          year_end: safeFrames[total - 1].year,
          quality: gifQuality,
          method,
          dataset,
          add_timestamps: gifAddTimestamps,
          fps: gifFps,
          gif_dimensions: gifDimensions,
        })
      })
      if (!res.ok) throw new Error("Failed to export server-side GIF")
      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `timelapse_${dataset}_${safeFrames[0].year}-${safeFrames[total - 1].year}.gif`
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
    } catch (e) {
      alert("GIF Export failed: " + e.message)
    } finally {
      setGifLoading(false)
    }
  }

  /* ── auto-advance ─────────────────────────────────────────────── */
  const advance = useCallback(() => {
    setIdx(prev => {
      if (total <= 1) return prev
      if (prev >= total - 1) return 0
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

  useEffect(() => { setIdx(0); setPlaying(false); setPos(null) }, [label])
  useEffect(() => { setIdx(0); setPlaying(false) }, [frames])

  /* ── drag ─────────────────────────────────────────────────────── */
  const onTitleDown = useCallback(e => {
    drag.current = {
      active: true,
      ox: e.clientX - (pos?.x ?? 0),
      oy: e.clientY - (pos?.y ?? 0),
    }
    e.preventDefault()
  }, [pos])

  useEffect(() => {
    const onMove = e => {
      if (!drag.current.active) return
      setPos({ x: e.clientX - drag.current.ox, y: e.clientY - drag.current.oy })
    }
    const onUp = () => { drag.current.active = false }
    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup",  onUp)
    return () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup",   onUp)
    }
  }, [])

  /* ── initial map center (from bbox or world view) ──────────────── */
  const mapCenter = bounds
    ? [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2]
    : [20, 0]
  const mapZoom = bounds ? 10 : 2

  /* ── window positioning ───────────────────────────────────────── */
  const posStyle = pos
    ? { left: pos.x, top: pos.y, transform: "none" }
    : { left: "50%",  top: "50%", transform: "translate(-50%, -50%)" }

  /* ═══════════════════════════════════════════════════════════════ */
  return (
    <>
      {/* Dim backdrop — click to close */}
      <div
        style={{
          position: "fixed", inset: 0, zIndex: 9998,
          background: "rgba(0,0,0,0.50)",
          backdropFilter: "blur(4px)",
          WebkitBackdropFilter: "blur(4px)",
        }}
        onClick={onClose}
      />

      {/* ── Floating window ─────────────────────────────────────── */}
      <div style={{
        position: "fixed",
        zIndex: 9999,
        width: "900px",
        maxWidth: "calc(100vw - 32px)",
        ...posStyle,
        background: "rgba(10,14,26,0.97)",
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: "16px",
        boxShadow: "0 28px 90px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.04) inset",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        animation: pos ? "none" : "wndFadeIn 0.2s ease",
      }}>

        {/* ── Title bar ─────────────────────────────────────────── */}
        <div
          onMouseDown={onTitleDown}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "11px 16px",
            background: "rgba(255,255,255,0.025)",
            borderBottom: "1px solid rgba(255,255,255,0.07)",
            cursor: "grab", userSelect: "none", flexShrink: 0,
          }}>

          <div style={{ display: "flex", alignItems: "center", gap: "0.55rem" }}>
            {/* Window drag dots */}
            <div style={{ display: "flex", gap: "5px" }}>
              {["#ef5350","#e0a800","#4caf50"].map(c => (
                <div key={c} style={{ width: 11, height: 11, borderRadius: "50%", background: c, opacity: 0.8 }} />
              ))}
            </div>
            <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "white", marginLeft: 4 }}>
              🎬 {label || "Satellite Time-Lapse"}
            </span>
            <span style={{ fontSize: "0.6rem", fontWeight: 700, padding: "2px 7px", borderRadius: "5px",
                           background: dsMeta.bg, color: dsMeta.color, letterSpacing: "0.04em" }}>
              {dsMeta.text}
            </span>
            {!loading && total > 0 && (
              <span style={{ fontSize: "0.65rem", color: "rgba(139,148,158,0.6)" }}>
                {total} frames
              </span>
            )}
          </div>

          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={onClose}
            style={{
              background: "rgba(218,54,51,0.12)", border: "1px solid rgba(218,54,51,0.3)",
              borderRadius: "7px", color: "#f85149", cursor: "pointer",
              padding: "3px 10px", fontSize: "0.78rem", fontWeight: 600,
              transition: "background 0.15s ease",
            }}
            onMouseEnter={e => e.currentTarget.style.background = "rgba(218,54,51,0.28)"}
            onMouseLeave={e => e.currentTarget.style.background = "rgba(218,54,51,0.12)"}>
            ✕
          </button>
        </div>

        {/* ── Satellite map ─────────────────────────────────────── */}
        <div style={{ position: "relative", height: "540px", background: "#07090f", flexShrink: 0 }}>

          {loading ? (
            /* Loading state */
            <div style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              justifyContent: "center", height: "100%", gap: "1rem",
            }}>
              <div style={{
                width: "40px", height: "40px",
                border: "3px solid rgba(255,255,255,0.08)",
                borderTopColor: "var(--accent)",
                borderRadius: "50%",
                animation: "spin 0.9s linear infinite",
              }} />
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: "4px" }}>
                  Generating {dsMeta.text} time-lapse…
                </div>
                <div style={{ fontSize: "0.68rem", color: "rgba(139,148,158,0.45)" }}>
                  Processing high-resolution frames on Google Earth Engine...
                </div>
              </div>
            </div>
          ) : total === 0 ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center",
                          height: "100%", color: "var(--text-secondary)", fontSize: "0.85rem" }}>
              No frames available for this region/range
            </div>
          ) : (
            <MapContainer
              center={mapCenter}
              zoom={mapZoom}
              scrollWheelZoom
              zoomControl
              preferCanvas={true}
              zoomSnap={0.5}
              style={{ width: "100%", height: "100%", background: "#07090f" }}
            >
              {/* Base imagery */}
              <TileLayer
                attribution="&copy; Esri"
                url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
              />

              {/* Satellite frame overlays are thumb images; render them as bounded image overlays.
                  Using TileLayer for non-tile URLs causes repeated tiling across the whole map. */}
              {bounds && visibleFrame?.tile_url && (
                <ImageOverlay
                  key={`${visibleFrame.year}-${method}`}
                  url={visibleFrame.tile_url}
                  bounds={bounds}
                  opacity={opacity}
                  zIndex={30}
                />
              )}

              {/* City labels — always on top */}
              <TileLayer
                url="https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png"
                zIndex={800}
                className="inverted-labels"
              />
              {bounds && <BoundsSyncer bounds={bounds} />}
            </MapContainer>
          )}

          {/* Year badge — overlaid on the map */}
          {!loading && visibleFrame && (
            <div style={{
              position: "absolute", top: "12px", right: "12px", zIndex: 1000,
              pointerEvents: "none",
              background: "rgba(10,14,26,0.88)", backdropFilter: "blur(10px)",
              border: "1px solid rgba(255,255,255,0.12)", borderRadius: "10px",
              padding: "8px 14px",
            }}>
              <div style={{ fontSize: "2rem", fontWeight: 800, color: "white",
                            letterSpacing: "-0.04em", lineHeight: 1 }}>
                {visibleFrame.year}
              </div>
            </div>
          )}

          {/* Frame progress bar — bottom edge of map */}
          {!loading && total > 1 && (
            <div style={{
              position: "absolute", bottom: 0, left: 0, right: 0, height: "3px",
              background: "rgba(0,0,0,0.4)", zIndex: 1000,
            }}>
              <div style={{
                height: "100%", background: "var(--accent)",
                width: `${(idx / (total - 1)) * 100}%`,
                transition: "width 0.15s ease",
              }} />
            </div>
          )}
        </div>

        {/* ── Controls ─────────────────────────────────────────── */}
        {!loading && total > 0 && (
          <div style={{ padding: "14px 18px 16px", display: "flex", flexDirection: "column", gap: "10px" }}>

            {/* Scrubber */}
            <div>
              <input
                type="range" min={0} max={Math.max(0, total - 1)} value={idx}
                onChange={e => { setPlaying(false); setIdx(+e.target.value) }}
                style={{ width: "100%", cursor: "pointer" }}
              />
              <div style={{ display: "flex", justifyContent: "space-between",
                            fontSize: "0.62rem", color: "var(--text-secondary)", marginTop: "2px" }}>
                <span>{safeFrames[0]?.year}</span>
                <span>{idx + 1} / {total} frames</span>
              </div>
            </div>

            {/* Rendering Technique Toggle */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "4px 0" }}>
              <span style={{ fontSize: "0.65rem", color: "var(--text-secondary)", fontWeight: 700,
                             textTransform: "uppercase", letterSpacing: "0.05em", width: "100px" }}>
                Technique
              </span>
              <div style={{ display: "flex", gap: "4px", flex: 1 }}>
                {TECHNIQUE_OPTIONS.map(m => {
                  const active = method === m.id
                  return (
                    <button
                      key={m.id}
                      disabled={loading}
                      onClick={() => { setMethod(m.id); setTimeout(reFetch, 0) }}
                      style={{
                        ...btnStyle, flex: 1, fontSize: "0.68rem", padding: "6px 4px", gap: "5px",
                        background: active ? "var(--accent)" : "rgba(255,255,255,0.05)",
                        border: active ? "1px solid var(--accent)" : "1px solid rgba(255,255,255,0.08)",
                        opacity: loading ? 0.5 : 1, transition: "all 0.2s ease",
                      }}
                    >
                      <span style={{ opacity: active ? 1 : 0.6 }}>{m.icon}</span>
                      {m.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <div style={{ marginTop: "-3px", marginLeft: "110px", display: "grid", gap: "4px" }}>
              {TECHNIQUE_OPTIONS.map((opt) => {
                const active = method === opt.id
                return (
                  <div
                    key={`${opt.id}-desc`}
                    style={{
                      fontSize: "0.67rem",
                      lineHeight: 1.35,
                      color: "rgba(206,214,222,0.82)",
                      background: active ? "rgba(47,129,247,0.12)" : "rgba(255,255,255,0.03)",
                      border: active ? "1px solid rgba(47,129,247,0.45)" : "1px solid rgba(255,255,255,0.08)",
                      borderRadius: "7px",
                      padding: "6px 8px",
                    }}
                  >
                    <span style={{ color: active ? "#8cc3ff" : "#d0d7de", fontWeight: 700 }}>{opt.icon} {opt.label}:</span>{" "}
                    {opt.description}
                  </div>
                )
              })}
            </div>

            {/* Transport + speed */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem", flexWrap: "wrap" }}>
              <button style={btnStyle} onClick={() => { setPlaying(false); setIdx(i => Math.max(0, i - 1)) }}>⏮</button>
              <button
                style={{ ...btnStyle,
                         background: playing ? "rgba(218,54,51,0.7)" : "rgba(47,129,247,0.85)",
                         width: "46px", height: "46px", fontSize: "1.2rem" }}
                onClick={() => setPlaying(p => !p)} disabled={total <= 1}>
                {playing ? "⏸" : "▶"}
              </button>
              <button style={btnStyle} onClick={() => { setPlaying(false); setIdx(i => Math.min(total - 1, i + 1)) }}>⏭</button>
              <div style={{ display: "flex", gap: "3px", marginLeft: "6px" }}>
                {SPEEDS.map((s, i) => (
                  <button key={s.label}
                    style={{ ...btnStyle, fontSize: "0.68rem", padding: "5px 9px",
                             background: speedIdx === i ? "var(--accent)" : "rgba(255,255,255,0.08)" }}
                    onClick={() => setSpeedIdx(i)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Options bar */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.7rem", flex: 1 }}>
                <span style={{ fontSize: "0.65rem", color: "var(--text-secondary)", flexShrink: 0 }}>
                  Satellite opacity {Math.round(opacity * 100)}%
                </span>
                <input type="range" min={0} max={1} step={0.05} value={opacity}
                  onChange={e => setOpacity(+e.target.value)} style={{ width: "200px" }} />
              </div>
              
              <button 
                onClick={() => setShowGifConfig(true)}
                disabled={gifLoading || loading}
                title="Open GIF export settings"
                style={{ ...btnStyle, fontSize: "0.68rem", fontWeight: "bold", 
                         background: gifLoading ? "rgba(255,255,255,0.05)" : "rgba(47,129,247,0.15)", 
                         border: "1px solid rgba(47,129,247,0.4)", color: "#2f81f7" }}
              >
                {gifLoading ? "⏳ Rendering Fast Server-side GIF..." : "💾 Export GIF"}
              </button>
            </div>
          </div>
        )}
      </div>

      {showGifConfig && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10001,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px",
          }}
          onClick={() => !gifLoading && setShowGifConfig(false)}
        >
          <div
            style={{
              width: "520px",
              maxWidth: "100%",
              background: "rgba(10,14,26,0.98)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: "14px",
              boxShadow: "0 20px 70px rgba(0,0,0,0.65)",
              padding: "16px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: "0.95rem", fontWeight: 700, color: "white" }}>GIF Export Settings</div>
              <button
                onClick={() => !gifLoading && setShowGifConfig(false)}
                disabled={gifLoading}
                style={{ ...btnStyle, padding: "4px 8px", fontSize: "0.72rem" }}
              >
                Close
              </button>
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
              <input
                type="checkbox"
                checked={gifAddTimestamps}
                onChange={(e) => setGifAddTimestamps(e.target.checked)}
                disabled={gifLoading}
              />
              Add year timestamps on each frame
            </label>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span style={{ fontSize: "0.74rem", color: "var(--text-secondary)" }}>Animation speed (FPS): {gifFps}</span>
              <input
                type="range"
                min={1}
                max={12}
                step={1}
                value={gifFps}
                onChange={(e) => setGifFps(Number(e.target.value))}
                disabled={gifLoading}
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <span style={{ fontSize: "0.74rem", color: "var(--text-secondary)" }}>GIF quality</span>
                <select
                  value={gifQuality}
                  onChange={(e) => setGifQuality(e.target.value)}
                  disabled={gifLoading}
                  style={gifSelectStyle}
                >
                  {GIF_QUALITY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value} style={{ color: "#101828", background: "#ffffff" }}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <span style={{ fontSize: "0.74rem", color: "var(--text-secondary)" }}>GIF resolution</span>
                <select
                  value={gifDimensions}
                  onChange={(e) => setGifDimensions(Number(e.target.value))}
                  disabled={gifLoading}
                  style={gifSelectStyle}
                >
                  {GIF_RESOLUTION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value} style={{ color: "#101828", background: "#ffffff" }}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "2px" }}>
              <button
                onClick={() => setShowGifConfig(false)}
                disabled={gifLoading}
                style={{ ...btnStyle, background: "rgba(255,255,255,0.06)" }}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  await handleExportGif()
                  setShowGifConfig(false)
                }}
                disabled={gifLoading}
                style={{
                  ...btnStyle,
                  fontWeight: 700,
                  background: "rgba(47,129,247,0.25)",
                  border: "1px solid rgba(47,129,247,0.45)",
                  color: "#8cc3ff",
                }}
              >
                {gifLoading ? "Rendering..." : "Export GIF"}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes wndFadeIn {
          from { opacity: 0; transform: translate(-50%, -50%) scale(0.93); }
          to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
        /* 📽️ Cinematic Transition CSS */
        .leaflet-layer {
          transition: opacity 300ms ease-in-out !important;
        }
        /* Ensure the base satellite layer doesn't fade, only the GEE overlays */
        .leaflet-container .leaflet-tile-pane .leaflet-layer:first-child {
          transition: none !important;
          opacity: 1 !important;
        }
      `}</style>
    </>
  )
}

/* ── Shared button style ─────────────────────────────────────────── */
const btnStyle = {
  background: "rgba(255,255,255,0.1)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: "8px", color: "white", cursor: "pointer",
  padding: "7px 11px", fontSize: "0.9rem",
  display: "flex", alignItems: "center", justifyContent: "center",
  transition: "background 0.15s ease",
}
