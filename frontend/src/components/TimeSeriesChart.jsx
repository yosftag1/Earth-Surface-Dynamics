import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';

const DW_CLASSES = [
  { key: "water",             label: "Water",        color: "#419bdf" },
  { key: "trees",             label: "Trees",        color: "#397d49" },
  { key: "grass",             label: "Grass",        color: "#88b053" },
  { key: "flooded_vegetation",label: "Flooded Veg",  color: "#7a87c6" },
  { key: "crops",             label: "Crops",        color: "#e49635" },
  { key: "shrub_and_scrub",   label: "Shrub",        color: "#dfc35a" },
  { key: "built",             label: "Built Area",   color: "#c4281b" },
  { key: "bare",              label: "Bare Ground",  color: "#a59b8f" },
  { key: "snow_and_ice",      label: "Snow/Ice",     color: "#b39fe1" },
];

export default function TimeSeriesChart({ data }) {
  if (!data || data.length === 0) {
    return (
      <div style={{ color: 'var(--text-secondary)', padding: '1rem', textAlign: 'center', fontSize: '0.8rem' }}>
        No timeline data yet — run an analysis to see the land cover trajectory.
      </div>
    );
  }

  // Only show lines for classes that have meaningful presence (> 0.01 km²) in at least one year
  const activeClasses = DW_CLASSES.filter(cls =>
    data.some(yearData => (yearData[cls.key] || 0) > 0.01)
  );

  const years   = data.map(d => d.year);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);

  // Custom dot: draw a diamond for legacy (MODIS) years to visually distinguish them
  const CustomDot = (cls) => (props) => {
    const { cx, cy, payload } = props;
    if (!cx || !cy) return null;
    if (payload.is_legacy) {
      const size = 5;
      return (
        <polygon
          key={`dot-${cls.key}-${payload.year}`}
          points={`${cx},${cy - size} ${cx + size},${cy} ${cx},${cy + size} ${cx - size},${cy}`}
          fill={cls.color}
          stroke="white"
          strokeWidth={1}
        />
      );
    }
    return <circle key={`dot-${cls.key}-${payload.year}`} cx={cx} cy={cy} r={3} fill={cls.color} />;
  };

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload || payload.length === 0) return null;
    const isLegacy = data.find(d => d.year === label)?.is_legacy;
    return (
      <div style={{
        background: 'rgba(10,14,26,0.95)',
        border: '1px solid var(--glass-border)',
        borderRadius: '8px',
        padding: '0.7rem 1rem',
        fontSize: '0.78rem',
        backdropFilter: 'blur(8px)',
        minWidth: '160px',
      }}>
        <div style={{ fontWeight: 700, marginBottom: '0.4rem', color: 'white' }}>
          {label} {isLegacy ? <span style={{ color: '#e0a800', fontSize: '0.7rem' }}>MODIS</span> : <span style={{ color: '#64b5f6', fontSize: '0.7rem' }}>DW</span>}
        </div>
        {payload.map(p => (
          <div key={p.dataKey} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', color: p.color }}>
            <span>{p.name}</span>
            <span style={{ fontWeight: 600 }}>{(p.value || 0).toFixed(2)} km²</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={{ width: '100%', marginTop: '1rem', background: 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
        <h3 style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>
          Land Cover Trajectory ({minYear}–{maxYear})
        </h3>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
          <span>◆ MODIS (legacy)</span>
          <span>● Dynamic World</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
          <XAxis
            dataKey="year"
            stroke="var(--text-secondary)"
            tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
            tickLine={false}
          />
          <YAxis
            stroke="var(--text-secondary)"
            tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
            tickLine={false}
            label={{ value: 'km²', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)', dx: -2, fontSize: 11 }}
          />
          <Tooltip content={<CustomTooltip />} />
          <Legend
            wrapperStyle={{ paddingTop: '8px', fontSize: '0.72rem' }}
            iconType="circle"
            iconSize={8}
          />
          {activeClasses.map(cls => (
            <Line
              key={cls.key}
              type="monotone"
              dataKey={cls.key}
              name={cls.label}
              stroke={cls.color}
              strokeWidth={2.5}
              dot={CustomDot(cls)}
              activeDot={{ r: 7, stroke: 'white', strokeWidth: 1.5 }}
              connectNulls={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
