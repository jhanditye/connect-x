// Style radar: one spoke per measured dimension. Every spoke uses the same normalisation, so the
// target band of every dimension lands on one shared ring:
//
//   value inside [low, high]      -> radius BAND_IN..BAND_OUT (linear across the band)
//   value below low               -> inward, reaching the centre at low - tolerance
//   value above high              -> outward, reaching the rim at high + tolerance
//
// "Inside the ring" therefore reads as "less than the target" and "outside" as "more", whatever
// the unit. The ideal polygon sits inside the ring at each dimension's `ideal`.

import type { JSX } from 'react';
import type { Comparison, DimensionResult, SingerProfile, TargetBand } from '../../types';
import { clamp, r1, shortDimLabel, singerVar, textWidth, useContainerWidth } from './chartKit';

export const BAND_IN = 0.55;
export const BAND_OUT = 0.75;
const LABEL_ROOM_X = 70;
const LABEL_ROOM_Y = 30;
const LABEL_PX = 11;

/** Normalised radius 0..1 of `value` against a target band (see the file comment). */
export function radarRadius(value: number, band: TargetBand): number {
  const tol = band.tolerance > 0 ? band.tolerance : Math.max(Math.abs(band.high - band.low), 1e-6);
  if (value < band.low) return BAND_IN * clamp(1 - (band.low - value) / tol, 0, 1);
  if (value > band.high) return BAND_OUT + (1 - BAND_OUT) * clamp((value - band.high) / tol, 0, 1);
  const span = band.high - band.low;
  if (span <= 0) return (BAND_IN + BAND_OUT) / 2;
  return BAND_IN + ((value - band.low) / span) * (BAND_OUT - BAND_IN);
}

const LINE_H = 13;
const BLOCK_H = 2 * LINE_H; // label name + score

export interface PlacedLabel {
  x: number;
  /** Baseline of the first line. */
  y: number;
  anchor: 'start' | 'middle' | 'end';
  box: [number, number, number, number];
}

function overlaps(a: PlacedLabel['box'], b: PlacedLabel['box']): boolean {
  return a[0] < b[2] + 2 && b[0] < a[2] + 2 && a[1] < b[3] + 1 && b[1] < a[3] + 1;
}

/**
 * Two-line labels just outside the rim. Upper labels sit above their spoke end, lower ones below,
 * side ones centred on it. A label that would overlap an earlier one steps away from the centre
 * (crowded radars); every label is kept inside [0, width] horizontally. The caller grows the SVG
 * vertically to fit the returned boxes.
 */
export function placeRadarLabels(labels: readonly { angle: number; width: number }[], cx: number, cy: number, R: number, width: number): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  for (const { angle, width: w } of labels) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const anchor: PlacedLabel['anchor'] = Math.abs(cos) < 0.3 ? 'middle' : cos > 0 ? 'start' : 'end';
    let best: PlacedLabel | null = null;
    const lx = cx + cos * (R + 6);
    const ly = cy + sin * (R + 6);
    for (let attempt = 0; attempt < 16; attempt++) {
      // Upper and lower labels step vertically away from the centre (horizontal room is what runs
      // out on a phone); side labels step outward along the spoke.
      const push = attempt * 7;
      const dx = Math.abs(sin) < 0.3 ? Math.sign(cos) * push : 0;
      const dy = Math.abs(sin) < 0.3 ? 0 : Math.sign(sin) * push;
      const top = (sin < -0.3 ? ly - BLOCK_H - 2 : sin > 0.3 ? ly + 4 : ly - BLOCK_H / 2) + dy;
      let x0 = (anchor === 'start' ? lx + 2 : anchor === 'end' ? lx - 2 - w : lx - w / 2) + dx;
      x0 = clamp(x0, 2, Math.max(2, width - w - 2));
      const x = anchor === 'start' ? x0 : anchor === 'end' ? x0 + w : x0 + w / 2;
      const cand: PlacedLabel = { x, y: top + 10, anchor, box: [x0, top, x0 + w, top + BLOCK_H] };
      best = cand;
      if (!placed.some((p) => overlaps(p.box, cand.box))) break;
    }
    placed.push(best!);
  }
  return placed;
}

function polygon(points: [number, number][]): string {
  return points.map(([px, py]) => `${r1(px)},${r1(py)}`).join(' ');
}

export function describeRadar(dims: DimensionResult[], profile: SingerProfile, overall: number): string {
  if (dims.length === 0) return `Style radar against ${profile.name}: no style measures could be taken from this take.`;
  const inBand = dims.filter((d) => d.value !== null && d.value >= d.target.low && d.value <= d.target.high).length;
  const scores = dims.map((d) => `${d.label} ${Math.round(d.score)}`).join(', ');
  return `Style radar against ${profile.name}, overall ${Math.round(overall)} of 100: ${inBand} of ${dims.length} measures inside the target band. Scores: ${scores}.`;
}

export function StyleRadar(props: { comparison: Comparison; profile: SingerProfile; size?: number }): JSX.Element {
  const size = Math.max(200, props.size ?? 300);
  const [ref, containerW] = useContainerWidth<HTMLDivElement>(size + 2 * LABEL_ROOM_X - 40);
  const dims = props.comparison.dimensions.filter((d): d is DimensionResult & { value: number } => d.value !== null && Number.isFinite(d.value));
  const color = singerVar(props.profile.id, props.profile.color);

  const width = Math.max(240, Math.min(containerW, size + 2 * LABEL_ROOM_X));
  const R = Math.max(48, Math.min(size / 2 - LABEL_ROOM_Y, width / 2 - LABEL_ROOM_X));
  const cx = width / 2;
  const cy = LABEL_ROOM_Y + R;
  const n = dims.length;
  const angle = (i: number) => -Math.PI / 2 + (i / Math.max(1, n)) * 2 * Math.PI;
  const at = (i: number, r: number): [number, number] => [cx + Math.cos(angle(i)) * r * R, cy + Math.sin(angle(i)) * r * R];
  const texts = dims.map((d) => shortDimLabel(d.key, d.label));
  const labels = placeRadarLabels(
    texts.map((t, i) => ({ angle: angle(i), width: textWidth(t, LABEL_PX) })),
    cx,
    cy,
    R,
    width,
  );
  // Grow the drawing vertically to whatever the labels needed (crowded radars push labels outward).
  const top = Math.min(cy - R - 4, ...labels.map((l) => l.box[1])) - 2;
  const bottom = Math.max(cy + R + 4, ...labels.map((l) => l.box[3])) + 2;
  const height = Math.ceil(bottom - top);

  const user = dims.map((d, i) => at(i, radarRadius(d.value, d.target)));
  const ideal = dims.map((d, i) => at(i, radarRadius(d.target.ideal, d.target)));
  // Annulus for the shared target band: outer circle minus inner circle (even-odd fill).
  const ring = `M${r1(cx - BAND_OUT * R)} ${r1(cy)}a${r1(BAND_OUT * R)} ${r1(BAND_OUT * R)} 0 1 0 ${r1(2 * BAND_OUT * R)} 0a${r1(BAND_OUT * R)} ${r1(BAND_OUT * R)} 0 1 0 ${r1(-2 * BAND_OUT * R)} 0Z M${r1(cx - BAND_IN * R)} ${r1(cy)}a${r1(BAND_IN * R)} ${r1(BAND_IN * R)} 0 1 0 ${r1(2 * BAND_IN * R)} 0a${r1(BAND_IN * R)} ${r1(BAND_IN * R)} 0 1 0 ${r1(-2 * BAND_IN * R)} 0Z`;

  return (
    <div className="viz radar" ref={ref}>
      <svg width={width} height={height} viewBox={`0 ${r1(top)} ${width} ${height}`} role="img" aria-label={describeRadar(dims, props.profile, props.comparison.overall)}>
        <circle cx={cx} cy={cy} r={R} fill="none" style={{ stroke: 'var(--grid)' }} />
        <path d={ring} fillRule="evenodd" style={{ fill: color, fillOpacity: 0.12 }} />
        <circle cx={cx} cy={cy} r={BAND_IN * R} fill="none" style={{ stroke: 'var(--grid-strong)' }} />
        <circle cx={cx} cy={cy} r={BAND_OUT * R} fill="none" style={{ stroke: 'var(--grid-strong)' }} />
        {dims.map((d, i) => {
          const [sx, sy] = at(i, 1);
          return <line key={d.key} x1={cx} y1={cy} x2={r1(sx)} y2={r1(sy)} style={{ stroke: 'var(--grid)' }} />;
        })}

        {n >= 3 && <polygon points={polygon(ideal)} fill="none" style={{ stroke: color, strokeWidth: 2, strokeLinejoin: 'round' }} />}
        {n >= 3 && (
          <polygon points={polygon(user)} style={{ fill: 'var(--accent)', fillOpacity: 0.16, stroke: 'var(--accent)', strokeWidth: 2, strokeLinejoin: 'round' }} />
        )}
        {ideal.map(([px, py], i) => (
          <circle key={`i${dims[i].key}`} cx={r1(px)} cy={r1(py)} r={3} style={{ fill: color }} />
        ))}
        {user.map(([px, py], i) => (
          <circle key={`u${dims[i].key}`} cx={r1(px)} cy={r1(py)} r={4} style={{ fill: 'var(--accent)', stroke: 'var(--surface)', strokeWidth: 2 }}>
            <title>{`${dims[i].label}: score ${Math.round(dims[i].score)}`}</title>
          </circle>
        ))}

        {labels.map((l, i) => (
          <text key={`l${dims[i].key}`} x={r1(l.x)} y={r1(l.y)} textAnchor={l.anchor} className="viz-label">
            <tspan x={r1(l.x)}>{texts[i]}</tspan>
            <tspan x={r1(l.x)} dy={LINE_H} className="viz-tick">
              {Math.round(dims[i].score)}
            </tspan>
          </text>
        ))}
        {n === 0 && (
          <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle" className="viz-note">
            Nothing measurable yet
          </text>
        )}
      </svg>
      <ul className="viz-legend" aria-label="Radar key">
        <li>
          <span className="viz-key viz-key--line" style={{ background: 'var(--accent)' }} aria-hidden="true" /> You
        </li>
        <li>
          <span className="viz-key viz-key--line" style={{ background: color }} aria-hidden="true" /> {props.profile.name} ideal
        </li>
        <li>
          <span className="viz-key viz-key--band" style={{ background: color }} aria-hidden="true" /> Target band
        </li>
      </ul>
      <p className="viz-caption">Inside the ring means less than the target, outside means more. Numbers are closeness scores.</p>
    </div>
  );
}
