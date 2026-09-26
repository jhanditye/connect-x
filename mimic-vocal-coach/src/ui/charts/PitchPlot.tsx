// Pitch over time on a semitone grid: the passaggio band, the contour coloured by estimated
// register (breaking at unvoiced frames), vibrato marks over notes, and an optional reference contour.

import { useMemo, useState, type JSX, type PointerEvent } from 'react';
import { midiToNoteName } from '../../dsp/music';
import { percentile } from '../../dsp/stats';
import type { FrameFeatures, PassaggioZone, ReferenceComparison, RegisterLabel, VoiceAnalysis } from '../../types';
import { clamp, fmtSigned, formatTick, linear, r1, registerVar, timeTicks, useContainerWidth, useSvgId } from './chartKit';

const AXIS_W = 40;
const PAD_TOP = 8;
const PAD_BOTTOM = 22;
const PAD_RIGHT = 10;
/** Longer takes get a horizontal scroller at this many px per second instead of squeezing. */
const SCROLL_AFTER_SEC = 60;
const PX_PER_SEC_LONG = 14;

export interface ContourPoint {
  t: number;
  midi: number;
}
export interface ContourSegment {
  register: RegisterLabel | null;
  points: ContourPoint[];
}
type ContourFrame = Pick<FrameFeatures, 't' | 'midi' | 'register'>;

/**
 * Splits frames into drawable runs: a new run at every unvoiced gap and (when `byRegister`) at
 * every register change. Inside a run every `stride`-th point is kept (about one per pixel), plus
 * the run's last point so peaks at phrase ends are not lost. Register runs share their boundary
 * point so adjacent colours meet without a gap.
 */
export function contourSegments(frames: readonly ContourFrame[], stride: number, byRegister: boolean): ContourSegment[] {
  const step = Math.max(1, Math.floor(stride));
  const out: ContourSegment[] = [];
  let cur: ContourSegment | null = null;
  let prev: ContourPoint | null = null;
  let sinceEmit = 0;
  const closeWith = (seg: ContourSegment, p: ContourPoint | null) => {
    if (p && seg.points[seg.points.length - 1] !== p) seg.points.push(p);
  };
  for (const f of frames) {
    if (!Number.isFinite(f.midi)) {
      if (cur) closeWith(cur, prev);
      cur = null;
      prev = null;
      continue;
    }
    const reg = byRegister ? f.register : null;
    const p: ContourPoint = { t: f.t, midi: f.midi };
    if (!cur) {
      cur = { register: reg, points: [p] };
      out.push(cur);
      sinceEmit = 0;
    } else if (cur.register !== reg) {
      closeWith(cur, prev);
      cur.points.push(p);
      cur = { register: reg, points: [p] };
      out.push(cur);
      sinceEmit = 0;
    } else if (++sinceEmit >= step) {
      cur.points.push(p);
      sinceEmit = 0;
    }
    prev = p;
  }
  if (cur) closeWith(cur, prev);
  return out;
}

/**
 * Visible MIDI range: the 0.5th..99.5th percentile of the plotted pitches (so a stray octave error
 * does not squash the plot; it is clipped instead), padded by 2 semitones, at least an octave tall.
 */
export function pitchYDomain(midis: ArrayLike<number>, passaggio?: PassaggioZone): [number, number] {
  let lo = percentile(midis, 0.5);
  let hi = percentile(midis, 99.5);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    const centre = passaggio ? (passaggio.lowMidi + passaggio.highMidi) / 2 : 60;
    lo = centre - 6;
    hi = centre + 6;
  }
  lo = Math.floor(lo) - 2;
  hi = Math.ceil(hi) + 2;
  if (hi - lo < 12) {
    const mid = (lo + hi) / 2;
    lo = Math.floor(mid - 6);
    hi = lo + 12;
  }
  return [lo, hi];
}

/**
 * Maps reference time to user time along a DTW path (piecewise linear). Returns null outside the
 * aligned span so unaligned reference material is not drawn at a misleading position.
 */
export function refTimeMapper(path: ReferenceComparison['path']): (refT: number) => number | null {
  const pts = path.filter((p) => Number.isFinite(p.refT) && Number.isFinite(p.userT)).sort((a, b) => a.refT - b.refT || a.userT - b.userT);
  if (pts.length === 0) return () => null;
  const first = pts[0].refT;
  const last = pts[pts.length - 1].refT;
  return (refT) => {
    if (refT < first || refT > last) return null;
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].refT <= refT) lo = mid;
      else hi = mid;
    }
    const a = pts[lo];
    const b = pts[hi];
    if (b.refT === a.refT) return a.userT;
    return a.userT + ((refT - a.refT) / (b.refT - a.refT)) * (b.userT - a.userT);
  };
}

/** Which note names get a label, depending on how many px one semitone gets. */
function labelledPitchClasses(pxPerSemitone: number): Set<number> {
  if (pxPerSemitone >= 14) return new Set([0, 2, 4, 5, 7, 9, 11]);
  if (pxPerSemitone >= 4.5) return new Set([0, 4, 7]);
  return new Set([0]);
}

function pathData(points: readonly ContourPoint[], x: (t: number) => number, y: (m: number) => number): string {
  let d = '';
  for (let i = 0; i < points.length; i++) d += `${i === 0 ? 'M' : 'L'}${r1(x(points[i].t))} ${r1(y(points[i].midi))}`;
  // A lone point becomes a zero-length line, which a round cap renders as a dot.
  if (points.length === 1) d += `L${r1(x(points[0].t))} ${r1(y(points[0].midi))}`;
  return d;
}

function vibratoWave(x0: number, x1: number, y: number): string {
  let d = `M${r1(x0)} ${r1(y)}`;
  for (let x = x0 + 1.5; x <= x1; x += 1.5) d += `L${r1(x)} ${r1(y + 1.8 * Math.sin(((x - x0) / 6) * 2 * Math.PI))}`;
  return d;
}

function noteWithCents(midi: number): string {
  const nearest = Math.round(midi);
  const cents = Math.round((midi - nearest) * 100);
  return `${midiToNoteName(nearest)} ${cents === 0 ? '±0' : fmtSigned(cents, 0)}¢`;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Screen-reader summary with the key numbers. */
export function describePitchPlot(analysis: VoiceAnalysis, hasReference: boolean, shift: number): string {
  const p = analysis.pitch;
  const parts = [`Pitch over ${analysis.durationSec.toFixed(1)} seconds`];
  if (p.lowMidi !== null && p.highMidi !== null) {
    parts.push(`range ${midiToNoteName(p.lowMidi)} to ${midiToNoteName(p.highMidi)}${p.medianMidi !== null ? `, centred on ${midiToNoteName(p.medianMidi)}` : ''}`);
  } else {
    parts.push('no clear pitch detected');
  }
  parts.push(`passaggio ${midiToNoteName(analysis.passaggio.lowMidi)} to ${midiToNoteName(analysis.passaggio.highMidi)}`);
  const r = analysis.registerShares;
  parts.push(`estimated registers ${pct(r.chest)} chest, ${pct(r.mix)} mix, ${pct(r.head)} head`);
  const vib = analysis.notes.filter((n) => n.vibrato).length;
  if (vib > 0) parts.push(`${vib} note${vib === 1 ? '' : 's'} with vibrato`);
  if (hasReference) parts.push(`reference contour overlaid${shift ? `, shifted ${shift > 0 ? 'up' : 'down'} ${Math.abs(Math.round(shift))} semitones` : ''}`);
  return `${parts.join('; ')}.`;
}

interface Hover {
  x: number;
  frame: FrameFeatures | null;
  t: number;
}

export function PitchPlot(props: {
  analysis: VoiceAnalysis;
  reference?: VoiceAnalysis;
  referenceShiftSemitones?: number;
  referencePath?: ReferenceComparison['path'];
  showRegisters?: boolean;
  height?: number;
}): JSX.Element {
  const { analysis, reference, referencePath } = props;
  const shift = props.referenceShiftSemitones ?? 0;
  const showRegisters = props.showRegisters ?? true;
  const height = Math.max(140, props.height ?? 260);
  const [ref, containerW] = useContainerWidth<HTMLDivElement>(640);
  const clipId = useSvgId('pp-clip');
  const [hover, setHover] = useState<Hover | null>(null);

  // Reference frames re-timed onto the user's clock (or left on their own clock without a path).
  const refFrames = useMemo<ContourFrame[] | null>(() => {
    if (!reference) return null;
    const map = referencePath && referencePath.length > 0 ? refTimeMapper(referencePath) : null;
    return reference.frames.map((f) => {
      const t = map ? map(f.t) : f.t;
      return { t: t ?? NaN, midi: t === null || !f.voiced ? NaN : f.midi + shift, register: null };
    });
  }, [reference, referencePath, shift]);

  const duration = useMemo(() => {
    let d = analysis.durationSec;
    if (refFrames) for (const f of refFrames) if (Number.isFinite(f.midi) && f.t > d) d = f.t;
    return Math.max(d, 0.5);
  }, [analysis.durationSec, refFrames]);

  const [yLo, yHi] = useMemo(() => {
    const midis: number[] = [];
    for (const f of analysis.frames) if (f.voiced && Number.isFinite(f.midi)) midis.push(f.midi);
    if (refFrames) for (const f of refFrames) if (Number.isFinite(f.midi)) midis.push(f.midi);
    return pitchYDomain(midis, analysis.passaggio);
  }, [analysis.frames, analysis.passaggio, refFrames]);

  const available = Math.max(160, containerW - AXIS_W);
  const scrolls = duration > SCROLL_AFTER_SEC && duration * PX_PER_SEC_LONG > available;
  const plotW = scrolls ? Math.ceil(duration * PX_PER_SEC_LONG) : available;
  const innerW = plotW - PAD_RIGHT;
  const plotBottom = height - PAD_BOTTOM;
  const x = linear(0, duration, 0, innerW);
  const y = linear(yLo, yHi, plotBottom, PAD_TOP);
  const pxPerSemitone = (plotBottom - PAD_TOP) / (yHi - yLo);

  const segments = useMemo(() => {
    const frames = analysis.frames.map((f) => (f.voiced ? f : { t: f.t, midi: NaN, register: null }));
    return contourSegments(frames, analysis.frames.length / Math.max(1, innerW), showRegisters);
  }, [analysis.frames, innerW, showRegisters]);

  const refSegments = useMemo(
    () => (refFrames ? contourSegments(refFrames, refFrames.length / Math.max(1, innerW), false) : []),
    [refFrames, innerW],
  );

  const labelled = labelledPitchClasses(pxPerSemitone);
  const gridNotes: number[] = [];
  for (let m = Math.ceil(yLo); m <= Math.floor(yHi); m++) gridNotes.push(m);
  const showEverySemitone = pxPerSemitone >= 3;
  const tTicks = timeTicks(duration, Math.max(2, Math.floor(plotW / 70)));

  const pass = analysis.passaggio;
  const bandTop = y(clamp(pass.highMidi + 0.5, yLo, yHi));
  const bandBottom = y(clamp(pass.lowMidi - 0.5, yLo, yHi));
  const bandVisible = bandBottom - bandTop > 0.5;
  const passAbove = pass.lowMidi - 0.5 >= yHi;
  const passBelow = pass.highMidi + 0.5 <= yLo;

  const vibratoNotes = analysis.notes.filter((n) => n.vibrato && x(n.end) - x(n.start) >= 8 && n.midi + 0.5 < yHi && n.midi > yLo);
  const hasUnclassified = showRegisters && analysis.frames.some((f) => f.voiced && f.register === null);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = clamp(e.clientX - box.left, 0, innerW);
    const t = (px / innerW) * duration;
    const frames = analysis.frames;
    if (frames.length === 0) return setHover({ x: px, frame: null, t });
    const hop = analysis.hopSec > 0 ? analysis.hopSec : 0.01;
    const i = clamp(Math.round((t - frames[0].t) / hop), 0, frames.length - 1);
    // Snap to the nearest voiced frame within 50 ms so the readout does not flicker in short gaps.
    let found: FrameFeatures | null = null;
    for (let d = 0; d <= 5 && !found; d++) {
      for (const j of [i - d, i + d]) {
        const f = frames[j];
        if (f && f.voiced && Number.isFinite(f.midi)) {
          found = f;
          break;
        }
      }
    }
    setHover({ x: found ? x(found.t) : px, frame: found, t: found ? found.t : t });
  };

  const readout = hover
    ? hover.frame
      ? `${hover.t.toFixed(2)} s · ${noteWithCents(hover.frame.midi)} · ${hover.frame.register ? `${hover.frame.register} (estimated)` : 'register unclear'}`
      : `${hover.t.toFixed(2)} s · no pitch`
    : '';

  return (
    <div className="viz pitchplot" ref={ref}>
      <p className="pitchplot-readout num" aria-hidden="true">
        {readout || 'Hover over or touch the plot to read the note and register.'}
      </p>
      <div className="pitchplot-frame">
        <svg className="pitchplot-axis" width={AXIS_W} height={height} aria-hidden="true">
          {gridNotes
            .filter((m) => labelled.has(((m % 12) + 12) % 12))
            .map((m) => (
              <text key={m} className="viz-tick" x={AXIS_W - 6} y={y(m)} textAnchor="end" dominantBaseline="middle">
                {midiToNoteName(m)}
              </text>
            ))}
        </svg>
        <div
          className={`pitchplot-scroll${scrolls ? ' pitchplot-scroll--on' : ''}`}
          tabIndex={scrolls ? 0 : undefined}
          role={scrolls ? 'group' : undefined}
          aria-label={scrolls ? 'Pitch plot, scroll sideways to see the whole take' : undefined}
        >
          <svg
            width={plotW}
            height={height}
            role="img"
            aria-label={describePitchPlot(analysis, !!reference, shift)}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            <defs>
              <clipPath id={clipId}>
                <rect x={0} y={PAD_TOP} width={plotW} height={plotBottom - PAD_TOP} />
              </clipPath>
            </defs>

            {bandVisible && (
              <g className="pitchplot-passaggio">
                <rect x={0} y={bandTop} width={innerW} height={bandBottom - bandTop} style={{ fill: 'var(--reg-mix)', fillOpacity: 0.09 }} />
                {bandBottom - bandTop >= 13 && (
                  <text className="viz-note" x={6} y={bandTop + 11}>
                    passaggio
                  </text>
                )}
              </g>
            )}
            {(passAbove || passBelow) && (
              <text className="viz-note" x={6} y={passAbove ? PAD_TOP + 11 : plotBottom - 5}>
                {`passaggio ${midiToNoteName(pass.lowMidi)}–${midiToNoteName(pass.highMidi)} ${passAbove ? 'above' : 'below'} this take`}
              </text>
            )}

            {gridNotes.map((m) => {
              const pc = ((m % 12) + 12) % 12;
              const isLabelled = labelled.has(pc);
              if (!isLabelled && !showEverySemitone) return null;
              return (
                <line
                  key={m}
                  x1={0}
                  x2={innerW}
                  y1={r1(y(m))}
                  y2={r1(y(m))}
                  style={{ stroke: isLabelled ? 'var(--grid-strong)' : 'var(--grid)', strokeWidth: pc === 0 ? 1.5 : 1 }}
                />
              );
            })}

            {tTicks.map((t) => (
              <g key={t}>
                <line x1={r1(x(t))} x2={r1(x(t))} y1={plotBottom} y2={plotBottom + 4} style={{ stroke: 'var(--grid-strong)' }} />
                <text
                  className="viz-tick"
                  x={r1(x(t))}
                  y={height - 6}
                  textAnchor={t === 0 ? 'start' : x(t) > innerW - 16 ? 'end' : 'middle'}
                >
                  {formatTick(t, duration)}
                </text>
              </g>
            ))}
            <line x1={0} x2={innerW} y1={plotBottom} y2={plotBottom} style={{ stroke: 'var(--grid-strong)' }} />

            <g clipPath={`url(#${clipId})`} fill="none" strokeLinecap="round" strokeLinejoin="round">
              {refSegments.map((s, i) => (
                <path key={`r${i}`} d={pathData(s.points, x, y)} style={{ stroke: 'var(--ink-3)', strokeWidth: 1.5, strokeDasharray: '4 3' }} />
              ))}
              {segments.map((s, i) => (
                <path
                  key={i}
                  d={pathData(s.points, x, y)}
                  style={{ stroke: showRegisters ? registerVar(s.register) : 'var(--accent)', strokeWidth: 2 }}
                />
              ))}
              {vibratoNotes.map((n) => (
                <path
                  key={`v${n.start}`}
                  d={vibratoWave(x(n.start), x(n.end), y(n.midi) - Math.max(7, pxPerSemitone * 0.9))}
                  style={{ stroke: 'var(--ink-2)', strokeWidth: 1 }}
                />
              ))}
            </g>

            {hover && (
              <g pointerEvents="none">
                <line x1={r1(hover.x)} x2={r1(hover.x)} y1={PAD_TOP} y2={plotBottom} style={{ stroke: 'var(--ink-3)' }} />
                {hover.frame && (
                  <circle
                    cx={r1(hover.x)}
                    cy={r1(y(clamp(hover.frame.midi, yLo, yHi)))}
                    r={4}
                    style={{ fill: showRegisters ? registerVar(hover.frame.register) : 'var(--accent)', stroke: 'var(--surface)', strokeWidth: 2 }}
                  />
                )}
              </g>
            )}
          </svg>
        </div>
      </div>
      <ul className="viz-legend" aria-label="Pitch plot key">
        {showRegisters ? (
          <>
            <li>
              <span className="viz-key viz-key--line" style={{ background: 'var(--reg-chest)' }} aria-hidden="true" /> Chest
            </li>
            <li>
              <span className="viz-key viz-key--line" style={{ background: 'var(--reg-mix)' }} aria-hidden="true" /> Mix
            </li>
            <li>
              <span className="viz-key viz-key--line" style={{ background: 'var(--reg-head)' }} aria-hidden="true" /> Head
            </li>
            {hasUnclassified && (
              <li>
                <span className="viz-key viz-key--line" style={{ background: 'var(--ink-3)' }} aria-hidden="true" /> Unclear
              </li>
            )}
          </>
        ) : (
          <li>
            <span className="viz-key viz-key--line" style={{ background: 'var(--accent)' }} aria-hidden="true" /> Your pitch
          </li>
        )}
        {reference && (
          <li>
            <span className="viz-key viz-key--dashed" aria-hidden="true" /> Reference
          </li>
        )}
        <li>
          <span className="viz-key viz-key--band" aria-hidden="true" /> Passaggio
        </li>
        {vibratoNotes.length > 0 && (
          <li>
            <svg className="viz-key-svg" width={16} height={8} aria-hidden="true">
              <path d={vibratoWave(0, 16, 4)} fill="none" style={{ stroke: 'var(--ink-2)', strokeWidth: 1 }} />
            </svg>{' '}
            Vibrato
          </li>
        )}
      </ul>
    </div>
  );
}
