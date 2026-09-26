// Score over time for one singer and one metric ('overall' or a style dimension's 0..100 score).

import type { JSX } from 'react';
import type { SessionRecord, StyleKey } from '../../types';
import { DIM_DISPLAY, linear, r1, singerVar, useContainerWidth } from './chartKit';

export interface ProgressPoint {
  time: number;
  value: number;
  session: SessionRecord;
}

/** Sessions for the profile (all when undefined) that carry the metric, oldest first. */
export function progressPoints(sessions: readonly SessionRecord[], profileId: string | undefined, metric: 'overall' | StyleKey): ProgressPoint[] {
  const out: ProgressPoint[] = [];
  for (const s of sessions) {
    if (profileId !== undefined && s.profileId !== profileId) continue;
    const time = Date.parse(s.createdAt);
    const value = metric === 'overall' ? s.overall : s.dimensionScores?.[metric];
    if (!Number.isFinite(time) || value === undefined || !Number.isFinite(value)) continue;
    out.push({ time, value: Math.max(0, Math.min(100, value)), session: s });
  }
  return out.sort((a, b) => a.time - b.time);
}

export function metricName(metric: 'overall' | StyleKey): string {
  return metric === 'overall' ? 'Overall match' : `${DIM_DISPLAY[metric]?.name ?? metric} score`;
}

const DAY_MS = 86_400_000;

function formatDay(ms: number, withYear: boolean): string {
  try {
    return new Intl.DateTimeFormat(undefined, withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/**
 * Indices of points whose x-axis date label fits: greedy left to right with at least `minGap` px
 * between labels, always keeping the newest point's label (it is the one people look for).
 */
export function labelIndices(xs: readonly number[], minGap: number): number[] {
  const n = xs.length;
  if (n === 0) return [];
  const lastX = xs[n - 1];
  const out: number[] = [];
  let prev = -Infinity;
  for (let i = 0; i < n - 1; i++) {
    if (xs[i] - prev >= minGap && lastX - xs[i] >= minGap) {
      out.push(i);
      prev = xs[i];
    }
  }
  out.push(n - 1);
  return out;
}

export function describeProgress(points: ProgressPoint[], metric: 'overall' | StyleKey): string {
  const name = metricName(metric);
  if (points.length === 0) return `${name}: no saved sessions yet.`;
  const first = points[0];
  const last = points[points.length - 1];
  const best = Math.max(...points.map((p) => p.value));
  if (points.length === 1) return `${name}: one session, ${Math.round(first.value)} on ${formatDay(first.time, true)}.`;
  return `${name} over ${points.length} sessions: from ${Math.round(first.value)} on ${formatDay(first.time, true)} to ${Math.round(last.value)} on ${formatDay(last.time, true)}; best ${Math.round(best)}.`;
}

const PAD = { top: 14, right: 34, bottom: 24, left: 30 };

export function ProgressChart(props: { sessions: SessionRecord[]; profileId?: string; metric?: 'overall' | StyleKey; height?: number }): JSX.Element {
  const metric = props.metric ?? 'overall';
  const height = Math.max(120, props.height ?? 220);
  const [ref, containerW] = useContainerWidth<HTMLDivElement>(600);
  const points = progressPoints(props.sessions, props.profileId, metric);
  const color = props.profileId ? singerVar(props.profileId, 'var(--accent)') : 'var(--accent)';

  if (points.length === 0) {
    return (
      <div className="viz pchart pchart--empty" ref={ref}>
        <p className="viz-empty">
          No saved {metric === 'overall' ? 'takes' : 'measurements of this'} yet. Analyse a take, then press “Save to progress” on the Results page to start a trend.
        </p>
      </div>
    );
  }

  const width = Math.max(240, containerW);
  const t0 = points[0].time;
  const t1 = points[points.length - 1].time;
  // A single day (or a single point) is centred rather than stretched to the edges.
  const spanMs = Math.max(t1 - t0, 0);
  const x =
    spanMs < 1
      ? () => (PAD.left + width - PAD.right) / 2
      : linear(t0, t1, PAD.left + 6, width - PAD.right);
  const y = linear(0, 100, height - PAD.bottom, PAD.top);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${r1(x(p.time))} ${r1(y(p.value))}`).join('');
  const area = points.length > 1 ? `${line}L${r1(x(t1))} ${r1(y(0))}L${r1(x(t0))} ${r1(y(0))}Z` : '';
  const last = points[points.length - 1];
  const withYear = new Date(t0).getFullYear() !== new Date(t1).getFullYear();
  const dateIdx = spanMs < DAY_MS ? [points.length - 1] : labelIndices(points.map((p) => x(p.time)), withYear ? 96 : 64);
  // Two sessions on the same day would print the same label twice; keep the first.
  const seenDays = new Set<string>();
  const dateLabels = dateIdx
    .map((i) => ({ i, text: formatDay(points[i].time, withYear) }))
    .filter((d) => (seenDays.has(d.text) ? false : (seenDays.add(d.text), true)));

  return (
    <div className="viz pchart" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={describeProgress(points, metric)}>
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={width - PAD.right} y1={r1(y(v))} y2={r1(y(v))} style={{ stroke: v === 0 ? 'var(--grid-strong)' : 'var(--grid)' }} />
            <text className="viz-tick" x={PAD.left - 6} y={r1(y(v))} textAnchor="end" dominantBaseline="middle">
              {v}
            </text>
          </g>
        ))}
        {area && <path d={area} style={{ fill: color, fillOpacity: 0.1 }} />}
        {points.length > 1 && <path d={line} fill="none" strokeLinejoin="round" strokeLinecap="round" style={{ stroke: color, strokeWidth: 2 }} />}
        {points.map((p, i) => {
          const isLast = i === points.length - 1;
          const when = formatDay(p.time, true);
          return (
            <g key={p.session.id}>
              <circle
                cx={r1(x(p.time))}
                cy={r1(y(p.value))}
                r={isLast ? 6 : 4}
                style={{ fill: isLast ? color : 'var(--surface)', stroke: isLast ? 'var(--surface)' : color, strokeWidth: 2 }}
              />
              {/* Invisible, larger hit target so the native tooltip is easy to reach. */}
              <circle cx={r1(x(p.time))} cy={r1(y(p.value))} r={11} fill="transparent">
                <title>{`${when}: ${Math.round(p.value)}${p.session.label ? ` (${p.session.label})` : ''}`}</title>
              </circle>
            </g>
          );
        })}
        <text className="viz-value" x={r1(x(last.time) + 10)} y={r1(y(last.value))} dominantBaseline="middle">
          {Math.round(last.value)}
        </text>
        {dateLabels.map(({ i, text }) => {
          const px = x(points[i].time);
          const anchor = px < PAD.left + 30 ? 'start' : px > width - PAD.right - 30 ? 'end' : 'middle';
          return (
            <text key={i} className="viz-tick" x={r1(px)} y={height - 6} textAnchor={anchor}>
              {text}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
