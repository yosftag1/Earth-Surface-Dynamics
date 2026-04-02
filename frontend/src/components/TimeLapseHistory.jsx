import React from "react"
import { Clock, Trash2, Play, ChevronRight, ChevronLeft } from "lucide-react"

export default function TimeLapseHistory({ entries, collapsed, onToggle, onRestore, onDelete }) {
  if (entries.length === 0) return null

  return (
    <div className={`history-panel ${collapsed ? "collapsed" : ""}`}>
      <div className="history-header" onClick={onToggle}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Clock size={16} />
          <span>History ({entries.length})</span>
        </div>
        {collapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </div>
      
      {!collapsed && (
        <div className="history-list">
          {entries.map(entry => (
            <div key={entry.id} className="history-item">
              <div className="history-item-info">
                <div className="history-item-title">{entry.label}</div>
                <div className="history-item-meta">
                  {entry.quality} • {entry.method || "median"}
                </div>
              </div>
              <div className="history-item-actions">
                <button onClick={() => onRestore(entry)} className="action-btn play-btn" title="Replay">
                  <Play size={14} />
                </button>
                <button onClick={() => onDelete(entry.id)} className="action-btn delete-btn" title="Delete">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <style>{`
        .history-panel {
          position: absolute;
          top: 80px;
          right: 20px;
          width: 300px;
          background: rgba(10, 14, 26, 0.95);
          backdrop-filter: blur(16px);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          z-index: 1000;
          overflow: hidden;
          transition: width 0.3s ease;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        }
        .history-panel.collapsed {
          width: 140px;
        }
        .history-header {
          padding: 12px 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: rgba(255, 255, 255, 0.05);
          cursor: pointer;
          font-size: 0.85rem;
          font-weight: 600;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }
        .history-header:hover {
          background: rgba(255, 255, 255, 0.08);
        }
        .history-list {
          max-height: 400px;
          overflow-y: auto;
          padding: 8px;
        }
        .history-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 8px;
          margin-bottom: 8px;
        }
        .history-item-title {
          font-size: 0.8rem;
          font-weight: 600;
          color: #fff;
        }
        .history-item-meta {
          font-size: 0.65rem;
          color: var(--text-secondary);
          margin-top: 4px;
        }
        .history-item-actions {
          display: flex;
          gap: 6px;
        }
        .action-btn {
          background: rgba(255, 255, 255, 0.05);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 6px;
          padding: 6px;
          cursor: pointer;
          color: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s ease;
        }
        .play-btn:hover { background: rgba(47, 129, 247, 0.2); border-color: rgba(47, 129, 247, 0.5); color: #2f81f7; }
        .delete-btn:hover { background: rgba(239, 83, 80, 0.2); border-color: rgba(239, 83, 80, 0.5); color: #ef5350; }
      `}</style>
    </div>
  )
}
