import React, { useEffect, useMemo, useState } from "react"
import { BookOpen, Clock, ExternalLink, Film, Play, Trash2, Navigation, PanelRightClose, PanelRightOpen } from "lucide-react"

const buildEventParagraph = (event) => {
  const base = (event.description || "").trim()
  const timeSpan = `${event.yearBefore} to ${event.yearAfter}`
  return `${base} This case is best explored over ${timeSpan} across roughly a ${event.radius} km radius so you can compare long-term landscape transition, disturbance, and recovery in one focused view.`
}

const getWikipediaTitleFromSources = (sources = []) => {
  const wiki = sources.find((s) => typeof s?.url === "string" && s.url.includes("wikipedia.org/wiki/"))
  if (!wiki) return null
  try {
    const u = new URL(wiki.url)
    const marker = "/wiki/"
    const idx = u.pathname.indexOf(marker)
    if (idx === -1) return null
    const rawTitle = u.pathname.slice(idx + marker.length)
    if (!rawTitle) return null
    return decodeURIComponent(rawTitle)
  } catch {
    return null
  }
}

export default function EventExplorerPanel({
  categories = [],
  historyEntries = [],
  onRunAnalysis,
  onRunTimelapse,
  onGoToEvent,
  onRestoreHistory,
  onDeleteHistory,
}) {
  const [activeTab, setActiveTab] = useState("events")
  const [openCategory, setOpenCategory] = useState(categories[0]?.id || null)
  const [infoEvent, setInfoEvent] = useState(null)
  const [eventImages, setEventImages] = useState({})
  const [collapsed, setCollapsed] = useState(false)

  const allEvents = useMemo(() => categories.flatMap((c) => c.events || []), [categories])

  useEffect(() => {
    let cancelled = false

    const fetchEventImages = async () => {
      const pending = allEvents.filter((ev) => !eventImages[ev.id])
      if (pending.length === 0) return

      const results = await Promise.all(
        pending.map(async (ev) => {
          const title = getWikipediaTitleFromSources(ev.sources)
          if (!title) return [ev.id, null]
          try {
            const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`)
            if (!res.ok) return [ev.id, null]
            const data = await res.json()
            return [ev.id, data?.thumbnail?.source || null]
          } catch {
            return [ev.id, null]
          }
        })
      )

      if (cancelled) return
      setEventImages((prev) => {
        const next = { ...prev }
        results.forEach(([id, img]) => {
          if (!next[id]) next[id] = img
        })
        return next
      })
    }

    fetchEventImages()
    return () => {
      cancelled = true
    }
  }, [allEvents, eventImages])

  return (
    <>
      <div style={{ ...panelStyle, ...(collapsed ? panelCollapsedStyle : null) }}>
        <div style={headerStyle}>
          {!collapsed ? (
            <>
              <div style={tabRowStyle}>
                <button
                  style={{ ...tabBtn, ...(activeTab === "events" ? tabBtnActive : null) }}
                  onClick={() => setActiveTab("events")}
                >
                  Event Explorer
                </button>
                <button
                  style={{ ...tabBtn, ...(activeTab === "history" ? tabBtnActive : null) }}
                  onClick={() => setActiveTab("history")}
                >
                  History ({historyEntries.length})
                </button>
              </div>
              <button
                style={collapseBtnStyle}
                onClick={() => setCollapsed(true)}
                title="Collapse panel"
                aria-label="Collapse event and history panel"
              >
                <PanelRightClose size={14} />
              </button>
            </>
          ) : (
            <div style={collapsedControlsStyle}>
              <button
                style={{ ...miniTabPillStyle, ...(activeTab === "events" ? miniTabPillActive : null) }}
                onClick={() => setActiveTab("events")}
                title="Events"
                aria-label="Show events tab"
              >
                E
              </button>
              <button
                style={{ ...miniTabPillStyle, ...(activeTab === "history" ? miniTabPillActive : null) }}
                onClick={() => setActiveTab("history")}
                title="History"
                aria-label="Show history tab"
              >
                H
              </button>
              <button
                style={collapseBtnStyle}
                onClick={() => setCollapsed(false)}
                title="Expand panel"
                aria-label="Expand event and history panel"
              >
                <PanelRightOpen size={14} />
              </button>
            </div>
          )}
        </div>

        {collapsed ? null : (
          <>

            {activeTab === "events" ? (
              <div style={scrollStyle}>
                {categories.map((cat) => {
                  const expanded = openCategory === cat.id
                  return (
                    <div key={cat.id} style={catBlockStyle}>
                      <button
                        onClick={() => setOpenCategory(expanded ? null : cat.id)}
                        style={catHeaderStyle}
                      >
                        <span>{cat.title}</span>
                        <span style={{ opacity: 0.7 }}>{expanded ? "-" : "+"}</span>
                      </button>

                      {expanded && (
                        <div style={{ display: "grid", gap: "8px", marginTop: "8px" }}>
                          {cat.events.map((ev) => (
                            <div key={ev.id} style={eventCardStyle}>
                              {eventImages[ev.id] && (
                                <img
                                  src={eventImages[ev.id]}
                                  alt={ev.name}
                                  style={eventThumbStyle}
                                  loading="lazy"
                                />
                              )}
                              <div style={{ fontSize: "0.8rem", fontWeight: 700, color: "#fff" }}>{ev.name}</div>
                              <div style={{ fontSize: "0.67rem", color: "var(--text-secondary)", lineHeight: 1.35 }}>
                                {buildEventParagraph(ev)}
                              </div>
                              <div style={{ fontSize: "0.63rem", color: "#8cc3ff", marginTop: "2px" }}>
                                {ev.yearBefore} - {ev.yearAfter} • {ev.radius} km radius
                              </div>

                              <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
                                <button style={miniBtn} onClick={() => onGoToEvent?.(ev)}>
                                  <Navigation size={13} /> Go To
                                </button>
                                <button style={{ ...miniBtn, ...primaryMini }} onClick={() => onRunAnalysis?.(ev)}>
                                  <Play size={13} /> Analyze
                                </button>
                                <button style={{ ...miniBtn, ...warnMini }} onClick={() => onRunTimelapse?.(ev)}>
                                  <Film size={13} /> Time-Lapse
                                </button>
                                <button style={miniBtn} onClick={() => setInfoEvent(ev)}>
                                  <BookOpen size={13} /> Info
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div style={scrollStyle}>
                {historyEntries.length === 0 ? (
                  <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem" }}>No history yet.</div>
                ) : (
                  historyEntries.map((entry) => (
                    <div key={entry.id} style={eventCardStyle}>
                      <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "#fff" }}>{entry.label}</div>
                      <div style={{ fontSize: "0.66rem", color: "var(--text-secondary)" }}>
                        {entry.yearStart} - {entry.yearEnd} • {entry.dataset} • {entry.method || "median"}
                      </div>
                      <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
                        <button style={{ ...miniBtn, ...primaryMini }} onClick={() => onRestoreHistory?.(entry)}>
                          <Clock size={13} /> Replay
                        </button>
                        <button style={{ ...miniBtn, ...dangerMini }} onClick={() => onDeleteHistory?.(entry.id)}>
                          <Trash2 size={13} /> Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </div>

      {infoEvent && (
        <div style={modalBackdrop} onClick={() => setInfoEvent(null)}>
          <div style={modalCard} onClick={(e) => e.stopPropagation()}>
            {eventImages[infoEvent.id] && (
              <img
                src={eventImages[infoEvent.id]}
                alt={infoEvent.name}
                style={eventHeroStyle}
              />
            )}
            <div style={{ fontSize: "1rem", fontWeight: 800, color: "#fff" }}>{infoEvent.name}</div>
            <p style={{ fontSize: "0.78rem", color: "var(--text-secondary)", lineHeight: 1.45, marginTop: "8px" }}>
              {buildEventParagraph(infoEvent)}
            </p>
            <div style={{ fontSize: "0.7rem", color: "#8cc3ff", marginTop: "4px" }}>
              Suggested window: {infoEvent.yearBefore} - {infoEvent.yearAfter}
            </div>

            <div style={{ marginTop: "12px", display: "grid", gap: "6px" }}>
              {(infoEvent.sources || []).map((src) => (
                <a
                  key={src.url}
                  href={src.url}
                  target="_blank"
                  rel="noreferrer"
                  style={sourceLinkStyle}
                >
                  <ExternalLink size={13} /> {src.label}
                </a>
              ))}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "12px" }}>
              <button style={miniBtn} onClick={() => setInfoEvent(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

const panelStyle = {
  position: "absolute",
  top: 80,
  right: 20,
  width: 360,
  maxHeight: "76vh",
  display: "flex",
  flexDirection: "column",
  background: "rgba(10,14,26,0.95)",
  backdropFilter: "blur(16px)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 12,
  zIndex: 1000,
  overflow: "hidden",
  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
}

const panelCollapsedStyle = {
  width: 56,
  maxHeight: "none",
}

const headerStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: 10,
  background: "rgba(255,255,255,0.05)",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
}

const tabRowStyle = {
  flex: 1,
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 6,
}

const collapseBtnStyle = {
  width: 30,
  height: 30,
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.16)",
  background: "rgba(255,255,255,0.06)",
  color: "#d0d7de",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
}

const collapsedControlsStyle = {
  width: "100%",
  display: "grid",
  gap: 6,
}

const miniTabPillStyle = {
  width: "100%",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.04)",
  color: "#d0d7de",
  fontSize: "0.66rem",
  fontWeight: 700,
  padding: "5px 0",
  cursor: "pointer",
}

const miniTabPillActive = {
  background: "rgba(47,129,247,0.2)",
  border: "1px solid rgba(47,129,247,0.45)",
  color: "#8cc3ff",
}

const tabBtn = {
  background: "rgba(255,255,255,0.04)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  padding: "8px 10px",
  color: "#d0d7de",
  fontSize: "0.72rem",
  fontWeight: 700,
  cursor: "pointer",
}

const tabBtnActive = {
  background: "rgba(47,129,247,0.2)",
  border: "1px solid rgba(47,129,247,0.45)",
  color: "#8cc3ff",
}

const scrollStyle = {
  overflowY: "auto",
  padding: 10,
  display: "grid",
  gap: 8,
}

const catBlockStyle = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 10,
  padding: 8,
}

const catHeaderStyle = {
  width: "100%",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  background: "transparent",
  border: "none",
  color: "#fff",
  fontWeight: 700,
  fontSize: "0.74rem",
  cursor: "pointer",
}

const eventCardStyle = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 8,
  padding: 8,
}

const eventThumbStyle = {
  width: "100%",
  height: 96,
  objectFit: "cover",
  borderRadius: 6,
  marginBottom: 8,
  border: "1px solid rgba(255,255,255,0.1)",
}

const miniBtn = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 7,
  color: "#fff",
  cursor: "pointer",
  padding: "6px 8px",
  fontSize: "0.67rem",
  display: "flex",
  alignItems: "center",
  gap: 5,
}

const primaryMini = {
  background: "rgba(47,129,247,0.2)",
  border: "1px solid rgba(47,129,247,0.45)",
  color: "#8cc3ff",
}

const warnMini = {
  background: "rgba(224,168,0,0.18)",
  border: "1px solid rgba(224,168,0,0.45)",
  color: "#f2c75c",
}

const dangerMini = {
  background: "rgba(239,83,80,0.2)",
  border: "1px solid rgba(239,83,80,0.45)",
  color: "#ff8f8d",
}

const modalBackdrop = {
  position: "fixed",
  inset: 0,
  zIndex: 10002,
  background: "rgba(0,0,0,0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
}

const modalCard = {
  width: 520,
  maxWidth: "100%",
  background: "rgba(10,14,26,0.98)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 12,
  padding: 14,
}

const eventHeroStyle = {
  width: "100%",
  maxHeight: 220,
  objectFit: "cover",
  borderRadius: 8,
  marginBottom: 10,
  border: "1px solid rgba(255,255,255,0.1)",
}

const sourceLinkStyle = {
  color: "#8cc3ff",
  textDecoration: "none",
  fontSize: "0.73rem",
  display: "flex",
  alignItems: "center",
  gap: 6,
}
