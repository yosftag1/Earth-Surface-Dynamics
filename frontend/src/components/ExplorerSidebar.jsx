/**
 * TimeLapseHistory – collapsible right sidebar that stores completed time-lapses.
 * Clicking an entry re-opens that slideshow.
 */
import React from "react"
import { Film, ChevronRight, ChevronLeft, Clock, Trash2 } from "lucide-react"

function formatDate(iso) {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

export default function TimeLapseHistory({ entries = [], onRestore, onDelete, collapsed, onToggle }) {
  return (
    <aside style={{
      width: collapsed ? "44px" : "260px",
      transition: "width 0.25s ease",
      background: "rgba(16,20,30,0.85)",
      backdropFilter: "blur(16px)",
      borderLeft: "1px solid rgba(255,255,255,0.07)",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      position: "relative",
      zIndex: 10,
    }}>
      {/* Toggle button */}
      <button
        onClick={onToggle}
        title={collapsed ? "Show time-lapse history" : "Collapse history"}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: "14px 0",
          background: "transparent",
          border: "none",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
          color: "var(--text-secondary)",
          cursor: "pointer",
          width: "100%",
          gap: "6px",
          fontSize: "0.78rem",
          whiteSpace: "nowrap",
          overflow: "hidden",
          flexShrink: 0,
        }}>
        {collapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
        {!collapsed && <><Film size={13} /><span>Time-Lapse History</span></>}
      </button>

      {/* Entry list */}
      {!collapsed && (
        <div style={{ flex: 1, overflowY: "auto", padding: "0.5rem 0" }}>
          {entries.length === 0 ? (
            <div style={{ padding: "1.5rem 1rem", textAlign: "center", fontSize: "0.75rem",
                          color: "var(--text-secondary)", lineHeight: 1.6 }}>
              <Film size={22} style={{ opacity: 0.3, marginBottom: "0.5rem", display: "block", margin: "0 auto 0.4rem" }} />
              Run a satellite time-lapse to see it saved here
            </div>
          ) : (
            [...entries].reverse().map(entry => (
              <div key={entry.id} style={{
                margin: "0.3rem 0.5rem",
                borderRadius: "8px",
                border: "1px solid rgba(255,255,255,0.06)",
                background: "rgba(255,255,255,0.03)",
                overflow: "hidden",
              }}>
                <button
                  onClick={() => onRestore(entry)}
                  style={{
                    width: "100%", background: "transparent", border: "none",
                    color: "var(--text-primary)", cursor: "pointer",
                    padding: "0.65rem 0.75rem",
                    textAlign: "left", display: "flex", flexDirection: "column", gap: "3px",
                  }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "white" }}>
                      {entry.label}
                    </span>
                    <span style={{ fontSize: "0.65rem", color: "var(--accent)", fontWeight: 700,
                                   background: "rgba(47,129,247,0.12)", borderRadius: "4px", padding: "1px 5px" }}>
                      {entry.frames.length} frames
                    </span>
                  </div>
                  <div style={{ fontSize: "0.68rem", color: "var(--text-secondary)" }}>
                    {entry.yearStart} – {entry.yearEnd}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "4px",
                                fontSize: "0.62rem", color: "rgba(139,148,158,0.6)" }}>
                    <Clock size={10} /> {formatDate(entry.timestamp)}
                  </div>
                </button>

                {/* Thumbnail year strip */}
                <div style={{ display: "flex", gap: "2px", padding: "0 0.75rem 0.6rem",
                              overflowX: "auto", scrollbarWidth: "none" }}>
                  {entry.frames.map((f, i) => (
                    <div key={f.year} style={{
                      flexShrink: 0,
                      fontSize: "0.55rem",
                      color: "var(--text-secondary)",
                      background: "rgba(255,255,255,0.06)",
                      borderRadius: "3px",
                      padding: "1px 4px",
                    }}>
                      {f.year}
                    </div>
                  ))}
                </div>

                {/* Delete */}
                <button
                  onClick={e => { e.stopPropagation(); onDelete(entry.id) }}
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    borderTop: "1px solid rgba(255,255,255,0.05)",
                    color: "rgba(218,54,51,0.6)", cursor: "pointer",
                    padding: "5px", fontSize: "0.65rem",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: "4px",
                    transition: "color 0.15s ease",
                  }}
                  onMouseEnter={e => e.currentTarget.style.color = "#da3633"}
                  onMouseLeave={e => e.currentTarget.style.color = "rgba(218,54,51,0.6)"}>
                  <Trash2 size={11} /> Delete
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Collapsed: icon badges */}
      {collapsed && entries.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center",
                      gap: "6px", padding: "8px 0" }}>
          {[...entries].reverse().slice(0, 5).map(entry => (
            <button
              key={entry.id}
              onClick={() => { onToggle(); onRestore(entry) }}
              title={`${entry.label} (${entry.yearStart}–${entry.yearEnd})`}
              style={{
                width: "28px", height: "28px", borderRadius: "6px",
                background: "rgba(47,129,247,0.2)", border: "1px solid rgba(47,129,247,0.3)",
                color: "var(--accent)", cursor: "pointer",
                fontSize: "0.6rem", fontWeight: 700, display: "flex",
                alignItems: "center", justifyContent: "center",
              }}>
              {String(entry.yearStart).slice(2)}
            </button>
          ))}
        </div>
      )}
    </aside>
  )
}
