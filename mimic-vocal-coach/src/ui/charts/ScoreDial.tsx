// A 0..100 score as a 270-degree arc (open at the bottom) with the number in the display face.

import type { JSX } from 'react';
import { clamp, r1 } from './chartKit';

const SWEEP = 270;
const START = 135; // degrees clockwise from the +x axis (SVG y points down), so the gap is at the bottom

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** SVG arc path from `fromDeg` sweeping clockwise by `sweepDeg`. */
export function arcPath(cx: number, cy: number, r: number, fromDeg: number, sweepDeg: number): string {
  const sweep = clamp(sweepDeg, 0, 359.99);
  const [x0, y0] = polar(cx, cy, r, fromDeg);
  const [x1, y1] = polar(cx, cy, r, fromDeg + sweep);
  return `M${r1(x0)} ${r1(y0)}A${r1(r)} ${r1(r)} 0 ${sweep > 180 ? 1 : 0} 1 ${r1(x1)} ${r1(y1)}`;
}

export function ScoreDial(props: { score: number; label?: string; color?: string; size?: number }): JSX.Element {
  const size = Math.max(64, props.size ?? 160);
  const valid = Number.isFinite(props.score);
  const score = valid ? clamp(props.score, 0, 100) : 0;
  const rounded = Math.round(score);
  const color = props.color ?? 'var(--accent)';
  const stroke = Math.max(6, size * 0.075);
  const c = size / 2;
  const r = c - stroke / 2 - 1;
  const label = props.label ?? 'Score';
  return (
    <div className="viz dial" style={{ width: size, maxWidth: '100%' }}>
      <svg
        width="100%"
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={valid ? `${label}: ${rounded} out of 100` : `${label}: not available`}
      >
        <path d={arcPath(c, c, r, START, SWEEP)} fill="none" strokeLinecap="round" style={{ stroke: 'var(--grid)', strokeWidth: stroke }} />
        {valid && rounded > 0 && (
          <path d={arcPath(c, c, r, START, (SWEEP * score) / 100)} fill="none" strokeLinecap="round" style={{ stroke: color, strokeWidth: stroke }} />
        )}
        <text x={c} y={c} textAnchor="middle" dominantBaseline="central" className="dial-number" style={{ fontSize: size * 0.3 }}>
          {valid ? rounded : '–'}
        </text>
        <text x={c} y={c + size * 0.24} textAnchor="middle" dominantBaseline="central" className="viz-tick" style={{ fontSize: Math.max(10, size * 0.07) }}>
          / 100
        </text>
      </svg>
      {props.label && <p className="dial-label">{props.label}</p>}
    </div>
  );
}
