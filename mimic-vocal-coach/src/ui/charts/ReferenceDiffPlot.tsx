// Cents difference between the user and the (transposed) reference along the aligned path, with a
// shaded +/-50 cent "in tune with the reference" band and a zero line.

import type { JSX } from 'react';
import type { ReferenceComparison } from '../../types';
import { clamp, formatTick, linear, MINUS, r1, timeTicks, useContainerWidth, useSvgId } from './chartKit';

const PAD = { top: 10, right: 10, bottom: 22, left: 44 };
/** A jump in user time larger than this between path points is an unvoiced gap: break the line. */
const GAP_SEC = 0.25;

/** Symmetric y extent in cents: at least 100, rounded up to 50, capped at 600 (beyond is clipped). */
export function centsExtent(diffs: readonly number[]): number {
  let m = 0;
  for (const d of diffs) if (Number.isFinite(d)) m = Math.max(m, Math.abs(d));
  return clamp(Math.ceil(m / 50) * 50, 100, 600);
}

/** Path points sorted by user time, split into runs at gaps. */
export function diffRuns(path: ReferenceComparison['path']): { t: number; c: number }[][] {
  const pts = path
    .filter((p) => Number.isFinite(p.userT) && Number.isFinite(p.centsDiff))
    .map((p) => ({ t: p.userT, c: p.centsDiff }))
    .sort((a, b) => a.t - b.t);
  const runs: { t: number; c: number }[][] = [];
  let cur: { t: number; c: number }[] = [];
  for (const p of pts) {
    if (cur.length > 0 && p.t - cur[cur.length - 1].t > GAP_SEC) {
      runs.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length > 0) runs.push(cur);
  return runs;
}

/** Keeps every `stride`-th point of a run plus its last point (about one point per pixel). */
export function decimateRun<T>(run: readonly T[], stride: number): T[] {
  const k = Math.max(1, Math.floor(stride));
  if (k === 1 || run.length <= 2) return [...run];
  const out: T[] = [];
  for (let i = 0; i < run.length; i += k) out.push(run[i]);
  if (out[out.length - 1] !== run[run.length - 1]) out.push(run[run.length - 1]);
  return out;
}

function centsLabel(c: number): string {
  return c === 0 ? '0¢' : `${c > 0 ? '+' : MINUS}${Math.abs(c)}¢`;
}

export function describeReferenceDiff(c: ReferenceComparison): string {
  const shift = Math.round(c.transposeSemitones);
  const shiftText = shift === 0 ? 'no key shift' : `compared ${Math.abs(shift)} ${Math.abs(shift) === 1 ? 'semitone' : 'semitones'} ${shift < 0 ? 'lower' : 'higher'} than the reference`;
  return `Pitch difference from the reference along your take: ${Math.round(c.withinFiftyCents * 100)}% of aligned frames within 50 cents, average ${Math.round(c.meanAbsCents)} cents off, ${shiftText}. Positive means sharp.`;
}

export function ReferenceDiffPlot(props: { comparison: ReferenceComparison; height?: number }): JSX.Element {
  const { comparison } = props;
  const height = Math.max(120, props.height ?? 180);
  const [ref, containerW] = useContainerWidth<HTMLDivElement>(640);
  const clipId = useSvgId('rd-clip');
  const width = Math.max(240, containerW);
  const runs = diffRuns(comparison.path);
  const ext = centsExtent(comparison.path.map((p) => p.centsDiff));
  const tMax = Math.max(0.5, ...runs.map((r) => r[r.length - 1].t));
  const x = linear(0, tMax, PAD.left, width - PAD.right);
  const y = linear(-ext, ext, height - PAD.bottom, PAD.top);
  const yTicks = ext <= 150 ? [-ext, -50, 0, 50, ext] : [-ext, -ext / 2, -50, 0, 50, ext / 2, ext].map((v) => Math.round(v / 50) * 50);
  const uniqueY = [...new Set(yTicks)];
  const tTicks = timeTicks(tMax, Math.max(2, Math.floor((width - PAD.left - PAD.right) / 70)));
  const stride = comparison.path.length / Math.max(1, width - PAD.left - PAD.right);
  const drawn = runs.map((run) => decimateRun(run, stride));

  return (
    <div className="viz refdiff" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={describeReferenceDiff(comparison)}>
        <defs>
          <clipPath id={clipId}>
            <rect x={PAD.left} y={PAD.top} width={width - PAD.left - PAD.right} height={height - PAD.top - PAD.bottom} />
          </clipPath>
        </defs>
        <rect x={PAD.left} y={r1(y(50))} width={width - PAD.left - PAD.right} height={r1(y(-50) - y(50))} style={{ fill: 'var(--accent-soft)' }} />
        {uniqueY.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={r1(y(v))}
              y2={r1(y(v))}
              style={{ stroke: v === 0 ? 'var(--ink-3)' : 'var(--grid)', strokeWidth: v === 0 ? 1.25 : 1 }}
            />
            <text className="viz-tick" x={PAD.left - 6} y={r1(y(v))} textAnchor="end" dominantBaseline="middle">
              {centsLabel(v)}
            </text>
          </g>
        ))}
        {tTicks.map((t) => (
          <text key={t} className="viz-tick" x={r1(x(t))} y={height - 6} textAnchor={t === 0 ? 'start' : x(t) > width - PAD.right - 16 ? 'end' : 'middle'}>
            {formatTick(t, tMax)}
          </text>
        ))}
        <g clipPath={`url(#${clipId})`}>
          {drawn.map((run, i) => (
            <path
              key={i}
              d={
                run.map((p, j) => `${j === 0 ? 'M' : 'L'}${r1(x(p.t))} ${r1(y(p.c))}`).join('') +
                (run.length === 1 ? `L${r1(x(run[0].t))} ${r1(y(run[0].c))}` : '')
              }
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ stroke: 'var(--accent)', strokeWidth: 1.75 }}
            />
          ))}
        </g>
        {runs.length === 0 && (
          <text className="viz-note" x={(PAD.left + width - PAD.right) / 2} y={height / 2} textAnchor="middle">
            No aligned singing to compare
          </text>
        )}
      </svg>
      <ul className="viz-legend" aria-label="Reference difference key">
        <li>
          <span className="viz-key viz-key--line" style={{ background: 'var(--accent)' }} aria-hidden="true" /> You minus reference (up = sharp)
        </li>
        <li>
          <span className="viz-key viz-key--block" style={{ background: 'var(--accent-soft)' }} aria-hidden="true" /> Within ±50¢
        </li>
      </ul>
    </div>
  );
}
