import React, { useState, useEffect } from "react"
import { MapContainer, TileLayer, useMapEvents, Rectangle, Pane, useMap } from "react-leaflet"
import { Activity, Map as MapIcon, ArrowRight, BarChart3, AlertCircle, Layers, Eye, Film } from "lucide-react"

import TimeSeriesChart    from "./components/TimeSeriesChart"
import SlideshowWindow    from "./components/SlideshowWindow"
import EventExplorerPanel from "./components/EventExplorerPanel"
import EVENT_CATEGORIES from "./data/eventCatalog"

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") || ""
const apiUrl = (path) => `${API_BASE_URL}${path}`

/* ── constants ─────────────────────────────────────────────────────── */
const DW_CLASSES = [
  { id: 0, key: "water",              label: "Water",       color: "#419bdf", icon: "💧" },
  { id: 1, key: "trees",              label: "Trees",        color: "#397d49", icon: "🌳" },
  { id: 2, key: "grass",              label: "Grass",        color: "#88b053", icon: "🌿" },
  { id: 3, key: "flooded_vegetation", label: "Flooded Veg", color: "#7a87c6", icon: "🌾" },
  { id: 4, key: "crops",              label: "Crops",        color: "#e49635", icon: "🌽" },
  { id: 5, key: "shrub_and_scrub",    label: "Shrub",        color: "#dfc35a", icon: "🌵" },
  { id: 6, key: "built",              label: "Urban Area",   color: "#c4281b", icon: "🏙️" },
  { id: 7, key: "bare",               label: "Bare Ground",  color: "#a59b8f", icon: "🏜️" },
  { id: 8, key: "snow_and_ice",       label: "Snow / Ice",   color: "#b39fe1", icon: "❄️" },
]


const DEFAULT_CENTER = [48.117, -1.677]
const DEFAULT_ZOOM   = 13
const MIN_THRESHOLD  = 0.005  // km²

const BASE_MAPS = [
  { id: "esri", label: "Optical Satellite (Esri)", url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", attribution: "&copy; Esri", options: { maxNativeZoom: 18 } },
  { id: "topo", label: "Elevation Contours (OpenTopo)", url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", attribution: "&copy; OpenTopoMap", options: { maxNativeZoom: 17 } },
  { id: "night", label: "Night Lights (NASA VIIRS)", url: "https://map1.vis.earthdata.nasa.gov/wmts-webmerc/VIIRS_CityLights_2012/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpg", attribution: "NASA EarthData", options: { maxNativeZoom: 8 } },
  { id: "terrain", label: "Terrain & Hillshade (Stamen)", url: "https://tiles.stadiamaps.com/tiles/stamen_terrain/{z}/{x}/{y}{r}.png", attribution: "&copy; Stadia Maps", options: { maxNativeZoom: 18 } },
]

const TIMELAPSE_DATASETS = new Set(["rgb", "ndvi", "night", "fire", "sar"])
const sanitizeDataset = (dataset) => (TIMELAPSE_DATASETS.has(dataset) ? dataset : "rgb")

/* ── helpers ──────────────────────────────────────────────────────── */
const bboxFromBounds = b => [b[0][1], b[0][0], b[1][1], b[1][0]]
const boundsFromCenter = (lat, lng, km) => {
  const dLat = km / 111.0
  const dLng = dLat / Math.cos(lat * Math.PI / 180)
  return [[lat - dLat, lng - dLng], [lat + dLat, lng + dLng]]
}

/* ── Non-linear (log) radius scale ─────────────────────────────────
 *
 *  slider raw value: 0 – 100  (integer steps)
 *  radius range:     0.5 – 150 km
 *
 *  Mapping: radius = 0.5 × 600^(raw/100)
 *    raw=100 → 300 km
 * ────────────────────────────────────────────────────────────────── */
const R_MIN = 0.5, R_MAX = 300
const sliderToRadius = raw => +(R_MIN * Math.pow(R_MAX / R_MIN, raw / 100)).toFixed(2)
const radiusToSlider = km  => Math.round(Math.log(km / R_MIN) / Math.log(R_MAX / R_MIN) * 100)
const fmtRadius = km => km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`

const normalizeSlideshowFrames = (data) => {
  if (!Array.isArray(data)) return []
  return data
    .map((f) => ({
      year: Number(f?.year),
      tile_url: f?.tile_url || f?.url || null,
    }))
    .filter((f) => Number.isFinite(f.year) && typeof f.tile_url === "string" && f.tile_url.length > 0)
    .sort((a, b) => a.year - b.year)
}

/* ── small map components ─────────────────────────────────────────── */
function MapSelection({ bounds, setBounds, radiusKm, onSelectionDoubleClick }) {
  useMapEvents({
    click(e) {
      setBounds(boundsFromCenter(e.latlng.lat, e.latlng.lng, radiusKm))
    },
    dblclick(e) {
      e.originalEvent?.preventDefault?.()
      const nextBounds = boundsFromCenter(e.latlng.lat, e.latlng.lng, radiusKm)
      setBounds(nextBounds)
      onSelectionDoubleClick(nextBounds)
    },
  })
  return bounds ? <Rectangle bounds={bounds} pathOptions={{ className: "selection-box", weight: 2 }} /> : null
}

function MapController({ bounds, fitRequestId }) {
  const map = useMap()
  const lastHandledFitRef = React.useRef(0)
  useEffect(() => {
    if (!bounds || fitRequestId === 0 || fitRequestId === lastHandledFitRef.current) return
    lastHandledFitRef.current = fitRequestId
    map.fitBounds(bounds, { animate: true, padding: [20, 20] })
  }, [bounds, fitRequestId, map])
  return null
}

/* ══════════════════════════════════════════ App ═══════════════════ */
export default function App() {
  /* region & years */
  const [bounds,     setBounds]     = useState(null)
  const [yearBefore, setYearBefore] = useState(2010)
  const [yearAfter,  setYearAfter]  = useState(2024)
  const [radiusKm,   setRadiusKm]   = useState(2.0)
  const [sliderRaw,  setSliderRaw]  = useState(() => radiusToSlider(2.0))

  /* analysis */
  const [loading,      setLoading]      = useState(false)
  const [error,        setError]        = useState("")
  const [result,       setResult]       = useState(null)
  const [timelineData, setTimelineData] = useState([])

  /* overlay — only 3 modes now (no swipe) */
  const [activeOverlay, setActiveOverlay] = useState("diff")
  const [maskOpacity,   setMaskOpacity]   = useState(0.70)
  const [showSatellite, setShowSatellite] = useState(true)
  const [activeBaseMap, setActiveBaseMap] = useState(BASE_MAPS[0].id)

  /* slideshow — fully outside Leaflet */
  const [slideshowOpen,    setSlideshowOpen]    = useState(false)
  const [slideshowFrames,  setSlideshowFrames]  = useState([])
  const [slideshowLoading, setSlideshowLoading] = useState(false)
  const [slideshowLabel,   setSlideshowLabel]   = useState("")
  const [slideshowDataset, setSlideshowDataset] = useState("rgb")
  const [slideshowMethod,  setSlideshowMethod]  = useState("median")

  /* history */
  const [history,         setHistory]         = useState([])
  const [fitRequestId,    setFitRequestId]    = useState(0)

  /* resize box when radiusKm changes */
  useEffect(() => {
    if (!bounds) return
    const lat = (bounds[0][0] + bounds[1][0]) / 2
    const lng = (bounds[0][1] + bounds[1][1]) / 2
    setBounds(boundsFromCenter(lat, lng, radiusKm))
  }, [radiusKm]) // eslint-disable-line

  /* ── fetch satellite slideshow ────────────────────────────────── */
  const fetchSlideshow = async (
    overrideBounds = null,
    yearsOverride = null,
    labelOverride = null,
    datasetOverride = null
  ) => {
    const tb = overrideBounds || bounds
    if (!tb) return
    const bbox = bboxFromBounds(tb)
    const yBefore = yearsOverride?.yearBefore ?? yearBefore
    const yAfter = yearsOverride?.yearAfter ?? yearAfter
    const lbl  = labelOverride || `${yBefore}–${yAfter}`
    const ds = sanitizeDataset(datasetOverride || slideshowDataset)
    setSlideshowLabel(lbl)
    if (datasetOverride) setSlideshowDataset(ds)
    setSlideshowLoading(true)
    setSlideshowOpen(true)
    setSlideshowFrames([])
    try {
      const res  = await fetch(apiUrl("/api/gee/satellite-timeseries"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bbox,
            year_start: yBefore,
            year_end: yAfter,
          quality: "high",
          method: slideshowMethod,
          dataset: ds,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || "Slideshow error")
      const frames = normalizeSlideshowFrames(data)
      setSlideshowFrames(frames)
      /* auto-save to history */
      if (frames.length > 0) {
        setHistory(h => [...h, {
          id: Date.now(),
          label: lbl,
          yearStart: yBefore,
          yearEnd:   yAfter,
          dataset:   ds,
          method:    slideshowMethod,
          frames,
          timestamp: new Date().toISOString(),
        }])
      }
    } catch (e) {
      setError(e.message)
      setSlideshowOpen(false)
    } finally {
      setSlideshowLoading(false)
    }
  }

  const restoreFromHistory = (entry) => {
    setSlideshowLabel(entry.label)
    setSlideshowFrames(normalizeSlideshowFrames(entry.frames))
    setSlideshowLoading(false)
    setSlideshowDataset(sanitizeDataset(entry.dataset || "rgb"))
    setSlideshowMethod(entry.method === "best" ? "best" : "median")
    setSlideshowOpen(true)
  }

  const deleteFromHistory = (id) => setHistory(h => h.filter(e => e.id !== id))

  const moveToEvent = (event) => {
    const nb = boundsFromCenter(event.lat, event.lng, event.radius)
    setBounds(nb)
    setRadiusKm(event.radius)
    setSliderRaw(radiusToSlider(event.radius))
    setFitRequestId((id) => id + 1)
    return nb
  }

  /* ── main analysis ────────────────────────────────────────────── */
  const handleAnalyze = async (explicitBounds = null, yearsOverride = null) => {
    if (loading) return
    const tb = explicitBounds || bounds
    if (!tb) { setError("Click the map to select a region first."); return }
    setError("")
    setLoading(true)
    const bbox = bboxFromBounds(tb)
    const yBefore = yearsOverride?.yearBefore ?? yearBefore
    const yAfter = yearsOverride?.yearAfter ?? yearAfter
    try {
      const [rC, rT] = await Promise.all([
        fetch(apiUrl("/api/gee/layout-change"), {
          method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bbox, year_before: yBefore, year_after: yAfter, mask_png: false, scale_m: 10.0 })
        }),
        fetch(apiUrl("/api/gee/layout-timeseries"), {
          method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ bbox, year_start: yBefore, year_end: yAfter, scale_m: 10.0 })
        }),
      ])
      const [dC, dT] = await Promise.all([rC.json(), rT.json()])
      if (!rC.ok) throw new Error(dC.detail || "change API error")
      if (!rT.ok) throw new Error(dT.detail || "timeline API error")
      setResult({ ...dC, bounds_leaflet: tb })
      setTimelineData(Array.isArray(dT) ? dT : [])
      setActiveOverlay("diff")
    } catch (e) { setError(e.message) }
    finally     { setLoading(false) }
  }

  const applyEventAndRun = async (event, action) => {
    const nb = moveToEvent(event)
    setYearBefore(event.yearBefore)
    setYearAfter(event.yearAfter)
    setSlideshowMethod("median")
    const eventDataset = event.timelapseDataset || "rgb"

    const years = { yearBefore: event.yearBefore, yearAfter: event.yearAfter }
    if (action === "analysis") {
      await handleAnalyze(nb, years)
      return
    }
    if (action === "timelapse") {
      await fetchSlideshow(nb, years, `${event.name} (${event.yearBefore}-${event.yearAfter})`, eventDataset)
    }
  }

  /* ── stat rows ────────────────────────────────────────────────── */
  const statRows = React.useMemo(() => {
    if (!result?.change_summary) return []
    const b = result.change_summary.area_km2_by_class_before || {}
    const a = result.change_summary.area_km2_by_class_after  || {}
    return DW_CLASSES
      .map(c => ({ ...c, before: b[c.key]||0, after: a[c.key]||0, net: (a[c.key]||0)-(b[c.key]||0) }))
      .filter(r => r.before > MIN_THRESHOLD || r.after > MIN_THRESHOLD)
      .sort((x, y) => Math.abs(y.net) - Math.abs(x.net))
  }, [result])

  const isLegacyBefore = yearBefore < 2016

  const baseMapObj = BASE_MAPS.find(m => m.id === activeBaseMap) || BASE_MAPS[0]

  /* ════════════════════════════════════════ render ══════════════ */
  return (
    <div className="app-container">
      <header className="glass-header">
        <div className="header-title-group">
          <h1><Activity size={24} color="var(--accent)" /> EarthWatch Global Dynamic World</h1>
          <p>Real-Time Deep Learning Land Cover Transitions (1985 – 2024)</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Layers size={18} color="var(--text-secondary)" />
          <select 
            className="styled-select" 
            value={activeBaseMap} 
            onChange={e => setActiveBaseMap(e.target.value)}
            style={{ minWidth: '180px', padding: '0.4rem 0.6rem' }}
          >
            {BASE_MAPS.map(m => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </div>
      </header>

      <main className="dashboard-main">
        {/* ─── Left sidebar ─────────────────────────────────────── */}
        <aside className="sidebar" style={{ width: "420px" }}>
          <div className="control-panel">

            {/* Year selectors */}
            <div className="input-group">
              <label>Time Period</label>
              <div className="row-inputs">
                <select className="styled-select" value={yearBefore} onChange={e => setYearBefore(+e.target.value)}>
                  {Array.from({ length: 40 }, (_, i) => 1985 + i).map(y => <option key={y} value={y}>{y}</option>)}
                </select>
                <ArrowRight size={20} color="var(--text-secondary)" style={{ alignSelf: "center" }} />
                <select className="styled-select" value={yearAfter} onChange={e => setYearAfter(+e.target.value)}>
                  {Array.from({ length: 40 }, (_, i) => 1985 + i).map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>

            {/* Legacy notice */}
            {isLegacyBefore && (
              <div style={{ background: "rgba(224,168,0,0.08)", border: "1px solid rgba(224,168,0,0.25)",
                            borderRadius: "6px", padding: "0.7rem" }}>
                <div style={{ display: "flex", gap: "0.4rem", color: "#e0a800", fontSize: "0.74rem",
                              fontWeight: 600, alignItems: "center" }}>
                  <AlertCircle size={13} /> LEGACY MODE – MODIS 500 m + Landsat 30 m
                </div>
                <p style={{ fontSize: "0.64rem", color: "var(--text-secondary)", lineHeight: 1.5, margin: "0.3rem 0 0" }}>
                  Land-cover classes are remapped from IGBP. Satellite imagery uses Landsat 5/7.
                </p>
              </div>
            )}

            {/* Radius */}
            <div className="input-group">
              <label style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Analysis Radius</span>
                <span style={{ color: "var(--accent)", fontWeight: 700 }}>{fmtRadius(radiusKm)}</span>
              </label>
              <input
                type="range" min="0" max="100" step="1"
                value={sliderRaw}
                onChange={e => {
                  const raw = +e.target.value
                  setSliderRaw(raw)
                  setRadiusKm(sliderToRadius(raw))
                }}
                style={{ width: "100%" }}
              />
              <div style={{ display: "flex", justifyContent: "space-between",
                            fontSize: "0.62rem", color: "var(--text-secondary)", marginTop: "-4px" }}>
                <span>0.5 km</span>
                <span>2 km</span>
                <span>10 km</span>
                <span>50 km</span>
                <span>150 km</span>
              </div>
            </div>

            {/* Mask opacity */}
            <div className="input-group">
              <label style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
                  <Eye size={12} /> Mask Opacity
                </span>
                <span style={{ color: "var(--accent)", fontWeight: 700 }}>{Math.round(maskOpacity * 100)}%</span>
              </label>
              <input type="range" min="0" max="1" step="0.05" value={maskOpacity}
                onChange={e => setMaskOpacity(+e.target.value)} style={{ width: "100%" }} />
            </div>

            {/* Satellite toggle */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <label style={{ margin: 0, display: "flex", gap: "0.4rem", alignItems: "center",
                              fontSize: "0.82rem", fontWeight: 500, color: "var(--text-secondary)",
                              textTransform: "uppercase", letterSpacing: "0.05em" }}>
                <Layers size={13} /> Satellite Underlay
              </label>
              <label className="toggle-switch">
                <input type="checkbox" checked={showSatellite} onChange={e => setShowSatellite(e.target.checked)} />
                <span className="toggle-slider" />
              </label>
            </div>

            {/* Analyse button */}
            <button className="primary-button" onClick={() => handleAnalyze()} disabled={loading || !bounds}
              title={!bounds ? "Click the map first" : ""}>
              {loading
                ? <><div className="loader-spinner" />Processing…</>
                : <><MapIcon size={18} />Run Deep Analysis</>}
            </button>

            {/* Dataset selector */}
            <div className="input-group">
              <label>Time-Lapse Dataset</label>
              <select className="styled-select" value={slideshowDataset} onChange={e => setSlideshowDataset(e.target.value)}>
                <option value="rgb">Optical Satellite (Native RGB)</option>
                <option value="ndvi">Vegetation Index (NDVI)</option>
                <option value="night">Night Lights (VIIRS)</option>
                <option value="fire">Thermal Hotspots (FIRMS)</option>
                <option value="sar">Radar Penetration (SAR VV)</option>
              </select>
            </div>

            {/* Time-lapse button */}
            <button className="primary-button"
              style={{ background: "rgba(255,180,0,0.12)", border: "1px solid rgba(255,180,0,0.3)", color: "#e0a800" }}
              disabled={!bounds}
              onClick={() => fetchSlideshow()}>
              <Film size={16} /> Satellite Time-Lapse ({yearBefore}–{yearAfter})
            </button>

            {error && (
              <div style={{ color: "var(--danger)", fontSize: "0.82rem", display: "flex", gap: "0.4rem", alignItems: "center" }}>
                <AlertCircle size={14} /> {error}
              </div>
            )}

            {/* Overlay selector — 3 modes, no swipe */}
            {result && (
              <div className="input-group">
                <label>Active Overlay</label>
                <div style={{ display: "flex", gap: "0.4rem" }}>
                  {[
                    { id: "diff",   label: "🎨 Change Types" },
                    { id: "before", label: `${result.year_before}` },
                    { id: "after",  label: `${result.year_after}` },
                  ].map(o => (
                    <button key={o.id} className="primary-button"
                      style={{ flex: 1, padding: "0.5rem 0.2rem", fontSize: "0.78rem",
                               background: activeOverlay === o.id ? "var(--accent)" : "var(--panel-bg)", color: "white" }}
                      onClick={() => setActiveOverlay(o.id)}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="legend-panel">
            <TimeSeriesChart data={timelineData} />
          </div>
        </aside>

        {/* ─── Map wrapper ───────────────────────────────────────── */}
        <div style={{ flex: 1, position: "relative", display: "flex", flexDirection: "column" }}>
          <MapContainer center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} doubleClickZoom={false} scrollWheelZoom className="leaflet-container">

            {/* Base map selector */}
            <TileLayer
              attribution={baseMapObj.attribution}
              url={baseMapObj.url}
              {...(baseMapObj.options || {})}
            />

            {/* Landsat visual underlay for analysis result */}
            {result && showSatellite && !slideshowOpen && (() => {
              if (activeOverlay === "before" && result.visual_url_before)
                return <TileLayer url={result.visual_url_before} zIndex={410} opacity={0.95} tileSize={256} zoomOffset={0} detectRetina={false} maxNativeZoom={16} />
              if (activeOverlay === "after" && result.visual_url_after)
                return <TileLayer url={result.visual_url_after} zIndex={410} opacity={0.95} tileSize={256} zoomOffset={0} detectRetina={false} maxNativeZoom={16} />
              return null
            })()}

            {/* Dark tint */}
            <div style={{ pointerEvents: "none", position: "absolute", inset: 0,
                          backgroundColor: "rgba(0,0,0,0.28)", zIndex: 400 }} />

            <MapController bounds={bounds} fitRequestId={fitRequestId} />
            <MapSelection
              bounds={bounds}
              setBounds={setBounds}
              radiusKm={radiusKm}
              onSelectionDoubleClick={() => setFitRequestId((id) => id + 1)}
            />

            {/* Mask overlays */}
            {result && activeOverlay === "after"  && result.tile_url_after  &&
              <TileLayer url={result.tile_url_after}  opacity={maskOpacity} zIndex={500} tileSize={256} zoomOffset={0} detectRetina={false} maxNativeZoom={16} />}
            {result && activeOverlay === "before" && result.tile_url_before &&
              <TileLayer url={result.tile_url_before} opacity={maskOpacity} zIndex={500} tileSize={256} zoomOffset={0} detectRetina={false} maxNativeZoom={16} />}
            {result && activeOverlay === "diff"   && result.tile_url_diff   &&
              <TileLayer url={result.tile_url_diff}   opacity={maskOpacity} zIndex={500} tileSize={256} zoomOffset={0} detectRetina={false} maxNativeZoom={16} />}


            {/* City labels */}
            <TileLayer url="https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png"
              zIndex={800} className="inverted-labels" />
          </MapContainer>

          {/* ── Stats panel (bottom-right of map area) ── */}
          {result && !loading && !slideshowOpen && statRows.length > 0 && (
            <div className="results-overlay" style={{ maxHeight: "55vh", overflowY: "auto" }}>
              <div className="overlay-header">
                <BarChart3 size={16} /> Net Change ({result.year_before}→{result.year_after})
              </div>
              <div style={{ fontSize: "0.64rem", color: "var(--text-secondary)", marginBottom: "0.4rem" }}>
                Sorted by magnitude · km²
              </div>
              {statRows.map(row => {
                const pct = row.before > 0 ? (row.net / row.before * 100) : null
                const up  = row.net >= 0
                return (
                  <div key={row.key} style={{ paddingBottom: "0.5rem", marginBottom: "0.4rem",
                                              borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: "0.4rem",
                                     color: "var(--text-secondary)", fontSize: "0.82rem" }}>
                        <span style={{ width: 12, height: 12, borderRadius: 3, flexShrink: 0,
                                       background: row.color, display: "inline-block" }} />
                        {row.icon} {row.label}
                      </span>
                      <span style={{ fontWeight: 600, color: up ? "#4caf50" : "#ef5350", fontSize: "0.85rem" }}>
                        {up ? "+" : ""}{row.net.toFixed(2)} km²
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between",
                                  fontSize: "0.62rem", color: "var(--text-secondary)", paddingLeft: "1.2rem", marginTop: "2px" }}>
                      <span>{row.before.toFixed(2)} → {row.after.toFixed(2)} km²</span>
                      {pct !== null && (
                        <span style={{ color: up ? "#4caf50" : "#ef5350" }}>
                          {up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%
                        </span>
                      )}
                    </div>
                    <div style={{ height: "3px", background: "rgba(255,255,255,0.07)", borderRadius: "2px",
                                  marginTop: "4px", overflow: "hidden" }}>
                      <div style={{
                        height: "100%", borderRadius: "2px",
                        width: `${Math.min(100, (Math.abs(row.net) / (Math.abs(statRows[0].net) || 1)) * 100)}%`,
                        background: up ? "#4caf50" : "#ef5350",
                        transition: "width 0.4s ease",
                      }} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {result && !loading && !slideshowOpen && activeOverlay === "diff" && Array.isArray(result.diff_legend) && result.diff_legend.length > 0 && (
            <div
              style={{
                position: "absolute",
                right: "390px",
                bottom: "1rem",
                zIndex: 1000,
                width: "224px",
                maxHeight: "38vh",
                overflowY: "auto",
                background: "var(--panel-bg)",
                border: "1px solid var(--glass-border)",
                borderRadius: "10px",
                backdropFilter: "blur(10px)",
                padding: "10px 10px 8px",
                boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
              }}
            >
              <div style={{ fontSize: "0.68rem", fontWeight: 700, color: "var(--text-secondary)", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: "6px" }}>
                Transition Key
              </div>
              <div style={{ display: "grid", gap: "4px" }}>
                {result.diff_legend.map((item) => (
                  <div key={item.key} style={{ display: "flex", alignItems: "center", gap: "7px", fontSize: "0.7rem", color: "var(--text-primary)" }}>
                    <span style={{ width: "11px", height: "11px", borderRadius: "2px", background: item.color, flexShrink: 0, border: "1px solid rgba(255,255,255,0.25)" }} />
                    <span>{item.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ─── Right: Event Explorer + History ─────────────────── */}
        <EventExplorerPanel
          categories={EVENT_CATEGORIES}
          historyEntries={history}
          onRunAnalysis={(event) => applyEventAndRun(event, "analysis")}
          onRunTimelapse={(event) => applyEventAndRun(event, "timelapse")}
          onGoToEvent={moveToEvent}
          onRestoreHistory={restoreFromHistory}
          onDeleteHistory={deleteFromHistory}
        />
      </main>

      {/* ── Slideshow: draggable fixed window over everything ── */}
      {slideshowOpen && (
        <SlideshowWindow
          frames={slideshowFrames}
          loading={slideshowLoading}
          label={slideshowLabel}
          dataset={slideshowDataset}
          method={slideshowMethod}
          setMethod={setSlideshowMethod}
          reFetch={() => fetchSlideshow()}
          bounds={bounds}
          onClose={() => setSlideshowOpen(false)}
        />
      )}
    </div>
  )
}
