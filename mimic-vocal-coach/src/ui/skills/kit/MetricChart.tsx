// A small trend chart for one Skills measure (src/skills/progress/history.ts metricSeries): one dot per session, evenly
// spaced, oldest on the left, with the axis in the measure's own units (cents, %, seconds). Hand-built SVG like the
// app's other charts; the label tells screen readers the first, latest and best values.

import { linear, niceTicks, r1, useContainerWidth } from '../../charts/chartKit';
import type { MetricInfo } from '../../../skills/progress/history';

const PAD = { top: 12, right: 12, bottom: 24, left: 40 };

/** "18 cents", "80%", "12.5 s". */
export function formatMetric(v: number, unit: MetricInfo['unit']): string {
  if (!Number.isFinite(v)) return '–';
  if (unit === 'share') return `${Math.round(v * 100)}%`;
  if (unit === 'sec') return `${v < 10 ? (Math.round(v * 10) / 10).toFixed(1) : Math.round(v)} s`;
  return `${Math.round(v)} ${Math.round(v) === 1 ? 'cent' : 'cents'}`;
}

function tickText(v: number, unit: MetricInfo['unit']): string {
  if (unit === 'share') return `${Math.round(v * 100)}%`;
  if (unit === 'sec') return `${Math.round(v)}s`;
  return `${Math.round(v)}`;
}

function shortDay(at: string): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(t);
  } catch {
    return new Date(t).toISOString().slice(5, 10);
  }
}

/** One sentence for screen readers: "8 sessions. First 32 cents, latest 18 cents, best 15 cents. Lower is better." */
export function describeSeries(points: readonly { value: number }[], info: MetricInfo): string {
  if (points.length === 0) return `${info.label}: nothing measured yet.`;
  const first = points[0].value;
  const last = points[points.length - 1].value;
  const best = info.better === 'lower' ? Math.min(...points.map((p) => p.value)) : Math.max(...points.map((p) => p.value));
  const n = points.length;
  return `${info.label}: ${n} ${n === 1 ? 'session' : 'sessions'}. First ${formatMetric(first, info.unit)}, latest ${formatMetric(last, info.unit)}, best ${formatMetric(
    best,
    info.unit,
  )}. ${info.better === 'lower' ? 'Lower' : 'Higher'} is better.`;
}

export function MetricChart(props: { points: readonly { at: string; value: number }[]; info: MetricInfo; height?: number }) {
  const { points, info } = props;
  const height = props.height ?? 150;
  const [ref, containerW] = useContainerWidth<HTMLDivElement>(320);
  const width = Math.max(220, containerW);
  if (points.length === 0) {
    return (
      <div className="sk-chart sk-chart--empty" ref={ref}>
        <p className="muted">Nothing measured yet.</p>
      </div>
    );
  }
  const values = points.map((p) => p.value);
  let lo = info.unit === 'share' ? 0 : Math.min(0, ...values);
  let hi = info.unit === 'share' ? 1 : Math.max(...values);
  if (hi - lo < 1e-9) hi = lo + (info.unit === 'cents' ? 10 : 1);
  if (info.unit === 'cents') hi = Math.max(hi, 30);
  const ticks = niceTicks(lo, hi, 4);
  hi = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  lo = Math.min(lo, ticks[0] ?? lo);
  const x = points.length === 1 ? () => (PAD.left + width - PAD.right) / 2 : linear(0, points.length - 1, PAD.left + 6, width - PAD.right - 6);
  const y = linear(lo, hi, height - PAD.bottom, PAD.top);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${r1(x(i))} ${r1(y(p.value))}`).join('');
  return (
    <div className="sk-chart" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={describeSeries(points, info)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={width - PAD.right} y1={r1(y(v))} y2={r1(y(v))} style={{ stroke: v === 0 ? 'var(--grid-strong)' : 'var(--grid)' }} />
            <text className="viz-tick" x={PAD.left - 6} y={r1(y(v))} textAnchor="end" dominantBaseline="middle">
              {tickText(v, info.unit)}
            </text>
          </g>
        ))}
        {points.length > 1 && <path d={line} fill="none" strokeLinejoin="round" strokeLinecap="round" style={{ stroke: 'var(--accent)', strokeWidth: 2 }} />}
        {points.map((p, i) => (
          <circle key={`${p.at}-${i}`} cx={r1(x(i))} cy={r1(y(p.value))} r={i === points.length - 1 ? 4.5 : 3} style={{ fill: i === points.length - 1 ? 'var(--accent)' : 'var(--surface)', stroke: 'var(--accent)', strokeWidth: 1.5 }}>
            <title>{`${shortDay(p.at)}: ${formatMetric(p.value, info.unit)}`}</title>
          </circle>
        ))}
        <text className="viz-tick" x={r1(x(0))} y={height - 6} textAnchor={points.length === 1 ? 'middle' : 'start'}>
          {shortDay(points[0].at)}
        </text>
        {points.length > 1 && (
          <text className="viz-tick" x={r1(x(points.length - 1))} y={height - 6} textAnchor="end">
            {shortDay(points[points.length - 1].at)}
          </text>
        )}
      </svg>
    </div>
  );
}
