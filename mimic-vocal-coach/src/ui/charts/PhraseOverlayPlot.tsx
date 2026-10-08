// The original phrase against your take, drawn in YOUR key. x = time in the original phrase, y = pitch on a semitone grid.
// The original is a dashed line with a +-50 cent band around each note; your take is a solid line mapped through the fitted
// time model (not the DTW path), so a late entrance or a held-short note is visible where it happened. Notes that cost
// points carry a marker shape (not colour alone). Touch or drag to read a note; the arrow keys step through the notes.

import { useMemo, useState, type JSX, type KeyboardEvent, type PointerEvent } from 'react';
import { midiToNoteName } from '../../dsp/music';
import type { KeyMode, NoteCompare, PassaggioZone, PhraseComparison, VoiceAnalysis } from '../../types';
import { isSevereFlag, keyCaption, noteSummary, outsideTrackerRange, pitchFlag } from '../components/noteWords';
import { clamp, formatTick, linear, r1, timeTicks, useContainerWidth, useSvgId } from './chartKit';
import { contourSegments, pitchYDomain, type ContourSegment } from './PitchPlot';
import './phraseOverlay.css';

const AXIS_W = 40;
const PAD_TOP = 12;
const PAD_BOTTOM = 22;
const PAD_RIGHT = 10;
/** The +-50 cent band around every original note. */
const BAND_SEMITONES = 0.5;
/** Take frames this far outside the matched stretch (lead-in talk, a trailing remark) are not drawn. */
const SPAN_PAD_SEC = 0.3;

export interface PhraseOverlayPlotProps {
  /** The original phrase (its contour and notes, in the original key). */
  reference: VoiceAnalysis;
  comparison: PhraseComparison;
  /** The take's analysis. Without it the sung notes are drawn from the note table (pitch, entrance, length). */
  attempt?: VoiceAnalysis | null;
  /** The singer's own passaggio, shaded behind the notes. Defaults to the take's. */
  passaggio?: PassaggioZone | null;
  /** 'free' removes a constant detune (shown in the caption); 'locked' keeps it. */
  keyMode?: KeyMode;
  height?: number;
  /** The note highlighted by the note table. */
  selectedNote?: number | null;
  /** Called when a note is tapped on the plot (null when tapping empty space). */
  onSelectNote?: (index: number | null) => void;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)

interface TimeModel {
  lag: number;
  tempo: number;
}

/** The scorer's fitted rigid model userT = lag + tempo * refT, from the score's diagnostics; null when it is not there. */
export function timeModelOf(c: PhraseComparison): TimeModel | null {
  const lag = c.score.diagnostics.lagSec;
  const tempo = c.score.diagnostics.tempoRaw;
  return typeof lag === 'number' && typeof tempo === 'number' && Number.isFinite(lag) && Number.isFinite(tempo) && tempo > 0 ? { lag, tempo } : null;
}

export interface OverlayFrame {
  t: number;
  midi: number;
  register: null;
}

/** The take's voiced frames on the original's clock, restricted to the stretch that was matched. */
export function attemptFrames(attempt: VoiceAnalysis, c: PhraseComparison): OverlayFrame[] {
  const model = timeModelOf(c);
  const span = c.score.matchedSpan;
  if (!model || !span || c.score.status !== 'ok') return [];
  const out: OverlayFrame[] = [];
  for (const f of attempt.frames) {
    const u = f.t;
    if (!f.voiced || !Number.isFinite(f.midi) || u < span.start - SPAN_PAD_SEC || u > span.end + SPAN_PAD_SEC) continue;
    out.push({ t: (u - model.lag) / model.tempo, midi: f.midi, register: null });
  }
  return out;
}

export interface NoteBar {
  index: number;
  t0: number;
  t1: number;
  midi: number;
}

/** The original note's pitch in the singer's key (fractional MIDI): the reference's own note plus the key shift. */
export function nominalMidi(reference: VoiceAnalysis, n: NoteCompare, shift: number): number | null {
  const rn = reference.notes[n.refIndex];
  if (rn && Number.isFinite(rn.midi)) return rn.midi + shift;
  return noteNameToMidi(n.refName);
}

const NAMES: Record<string, number> = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
function noteNameToMidi(name: string): number | null {
  const m = /^([A-G]#?)(-?\d+)$/.exec(name);
  return m ? NAMES[m[1]] + (Number(m[2]) + 1) * 12 : null;
}

/** What the take did to each matched note, as flat bars (pitch where it was sung, from its entrance for its length). */
export function sungBars(reference: VoiceAnalysis, c: PhraseComparison): NoteBar[] {
  const tempo = timeModelOf(c)?.tempo ?? 1;
  const bars: NoteBar[] = [];
  for (const n of c.notes) {
    if (!n.matched || n.cents === null) continue;
    const nominal = nominalMidi(reference, n, c.transposeSemitones);
    if (nominal === null) continue;
    const onset = (n.onsetMs ?? 0) / 1000 / tempo;
    const t0 = n.refStart + onset;
    bars.push({ index: n.refIndex, t0, t1: Math.max(t0 + 0.05, n.refEnd + onset + (n.durationDeltaMs ?? 0) / 1000 / tempo), midi: nominal + n.cents / 100 });
  }
  return bars;
}

/** Screen-reader summary with the key numbers. */
export function describeOverlay(c: PhraseComparison, durationSec: number): string {
  const total = c.notes.length;
  const sung = c.notes.filter((n) => n.matched);
  const flagged = c.notes.filter((n) => n.flags.some((f) => f !== 'ok' && f !== 'ornament'));
  const parts = [`Your take against the original over ${durationSec.toFixed(1)} seconds, drawn in your key`];
  if (c.score.status !== 'ok') {
    parts.push('this take did not line up with the phrase, so no notes are compared');
    return `${parts.join('; ')}.`;
  }
  parts.push(`${total} note${total === 1 ? '' : 's'}, ${sung.length} sung${total - sung.length > 0 ? `, ${total - sung.length} missed` : ''}`);
  if (flagged.length > 0) parts.push(`${flagged.length} to work on: ${flagged.slice(0, 3).map(noteSummary).join('; ')}${flagged.length > 3 ? '; and more, see the note table' : ''}`);
  else parts.push('all sung notes on target');
  return `${parts.join('; ')}.`;
}

/** The readout for one note: what the original does there and what you did. */
export function readoutFor(n: NoteCompare): string {
  return `Note ${n.refIndex + 1}, ${noteSummary(n)}`;
}

/** Index of the note under time t (the nearest one when t falls in a gap), or null with no notes. */
export function noteAtTime(notes: readonly NoteCompare[], t: number): number | null {
  if (notes.length === 0) return null;
  let best = 0;
  let bestD = Infinity;
  notes.forEach((n, i) => {
    const d = t < n.refStart ? n.refStart - t : t > n.refEnd ? t - n.refEnd : 0;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

function labelledPitchClasses(pxPerSemitone: number): Set<number> {
  if (pxPerSemitone >= 14) return new Set([0, 2, 4, 5, 7, 9, 11]);
  if (pxPerSemitone >= 4.5) return new Set([0, 4, 7]);
  return new Set([0]);
}

function pathData(seg: ContourSegment, x: (t: number) => number, y: (m: number) => number): string {
  let d = '';
  seg.points.forEach((p, i) => {
    d += `${i === 0 ? 'M' : 'L'}${r1(x(p.t))} ${r1(y(p.midi))}`;
  });
  if (seg.points.length === 1) d += `L${r1(x(seg.points[0].t))} ${r1(y(seg.points[0].midi))}`;
  return d;
}

/** A small marker above a note band, by what went wrong (shape, so it does not depend on colour). */
function Marker(props: { cx: number; cy: number; kind: 'sharp' | 'flat' | 'wrong' | 'timing' | 'missed' }): JSX.Element {
  const { cx, cy } = props;
  switch (props.kind) {
    case 'sharp':
      return <path className="pov-mark pov-mark--warn" d={`M${r1(cx - 4)} ${r1(cy + 3)}L${r1(cx)} ${r1(cy - 4)}L${r1(cx + 4)} ${r1(cy + 3)}Z`} />;
    case 'flat':
      return <path className="pov-mark pov-mark--warn" d={`M${r1(cx - 4)} ${r1(cy - 3)}L${r1(cx)} ${r1(cy + 4)}L${r1(cx + 4)} ${r1(cy - 3)}Z`} />;
    case 'wrong':
      return <path className="pov-mark pov-mark--bad pov-mark--line" d={`M${r1(cx - 3.5)} ${r1(cy - 3.5)}L${r1(cx + 3.5)} ${r1(cy + 3.5)}M${r1(cx + 3.5)} ${r1(cy - 3.5)}L${r1(cx - 3.5)} ${r1(cy + 3.5)}`} />;
    case 'missed':
      return <circle className="pov-mark pov-mark--bad pov-mark--ring" cx={r1(cx)} cy={r1(cy)} r={3.6} />;
    case 'timing':
      return <rect className="pov-mark pov-mark--warn" x={r1(cx - 3.5)} y={r1(cy - 3.5)} width={7} height={7} />;
  }
}

function markerKind(n: NoteCompare): 'sharp' | 'flat' | 'wrong' | 'timing' | 'missed' | null {
  if (n.flags.includes('missed') || !n.matched) return outsideTrackerRange(n) ? null : 'missed';
  const pf = pitchFlag(n);
  if (pf === 'wrong-note' || pf === 'octave-displaced') return 'wrong';
  if (pf === 'sharp') return 'sharp';
  if (pf === 'flat') return 'flat';
  if (n.flags.some((f) => f === 'late' || f === 'early' || f === 'short' || f === 'long')) return 'timing';
  return null;
}

interface Readout {
  x: number;
  k: number;
}

export function PhraseOverlayPlot(props: PhraseOverlayPlotProps): JSX.Element {
  const { reference, comparison, attempt } = props;
  const height = Math.max(150, props.height ?? 240);
  const shift = comparison.transposeSemitones;
  const [containerRef, containerW] = useContainerWidth<HTMLDivElement>(340);
  const clipId = useSvgId('pov-clip');
  const [hover, setHover] = useState<Readout | null>(null);
  const [kbNote, setKbNote] = useState<number | null>(null);

  const notes = comparison.notes;
  const gated = comparison.score.status !== 'ok';
  const duration = useMemo(() => {
    let d = reference.durationSec;
    for (const n of notes) d = Math.max(d, n.refEnd + 0.2);
    return Math.max(d, 0.5);
  }, [reference.durationSec, notes]);

  const refFrames = useMemo(
    () => reference.frames.map((f) => ({ t: f.t, midi: f.voiced && Number.isFinite(f.midi) ? f.midi + shift : NaN, register: null })),
    [reference.frames, shift],
  );
  const takeFrames = useMemo(() => (attempt && !gated ? attemptFrames(attempt, comparison) : []), [attempt, comparison, gated]);
  const bars = useMemo(() => (takeFrames.length === 0 && !gated ? sungBars(reference, comparison) : []), [takeFrames.length, reference, comparison, gated]);

  const [yLo, yHi] = useMemo(() => {
    const midis: number[] = [];
    for (const f of refFrames) if (Number.isFinite(f.midi)) midis.push(f.midi);
    for (const f of takeFrames) midis.push(f.midi);
    for (const b of bars) midis.push(b.midi);
    return pitchYDomain(midis, props.passaggio ?? attempt?.passaggio);
  }, [refFrames, takeFrames, bars, props.passaggio, attempt?.passaggio]);

  const plotW = Math.max(160, containerW - AXIS_W);
  const innerW = plotW - PAD_RIGHT;
  const plotBottom = height - PAD_BOTTOM;
  const x = linear(0, duration, 0, innerW);
  const y = linear(yLo, yHi, plotBottom, PAD_TOP);
  const pxPerSemitone = (plotBottom - PAD_TOP) / (yHi - yLo);
  const labelled = labelledPitchClasses(pxPerSemitone);
  const gridNotes: number[] = [];
  for (let m = Math.ceil(yLo); m <= Math.floor(yHi); m++) gridNotes.push(m);
  const tTicks = timeTicks(duration, Math.max(2, Math.floor(plotW / 70)));

  const refSegments = useMemo(() => contourSegments(refFrames, refFrames.length / Math.max(1, innerW), false), [refFrames, innerW]);
  const takeSegments = useMemo(() => contourSegments(takeFrames, takeFrames.length / Math.max(1, innerW), false), [takeFrames, innerW]);

  const pass = props.passaggio ?? attempt?.passaggio ?? null;
  const bandTop = pass ? y(clamp(pass.highMidi + 0.5, yLo, yHi)) : 0;
  const bandBottom = pass ? y(clamp(pass.lowMidi - 0.5, yLo, yHi)) : 0;
  const bandVisible = pass !== null && bandBottom - bandTop > 0.5;

  const active = hover ? hover.k : kbNote;
  const selected = props.selectedNote ?? null;
  const readNote = active !== null ? notes[active] : undefined;

  const pointAt = (e: PointerEvent<SVGSVGElement>): Readout | null => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = clamp(e.clientX - box.left, 0, innerW);
    const t = (px / innerW) * duration;
    const k = noteAtTime(notes, t);
    return k === null ? null : { x: px, k };
  };
  const onPointer = (e: PointerEvent<SVGSVGElement>): void => {
    const r = pointAt(e);
    setHover(r);
    setKbNote(null);
  };
  const onTap = (e: PointerEvent<SVGSVGElement>): void => {
    const r = pointAt(e);
    setHover(r);
    props.onSelectNote?.(r === null ? null : r.k);
  };
  const onLeave = (e: PointerEvent<SVGSVGElement>): void => {
    if (e.pointerType === 'mouse') setHover(null);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (notes.length === 0) return;
    let next: number | null = null;
    const cur = kbNote ?? selected ?? -1;
    if (e.key === 'ArrowRight') next = Math.min(notes.length - 1, cur + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = notes.length - 1;
    else if (e.key === 'Escape') {
      setKbNote(null);
      setHover(null);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setHover(null);
    setKbNote(next);
    props.onSelectNote?.(next);
  };

  const label = describeOverlay(comparison, duration);
  const caption = keyCaption(shift, comparison.biasCents, props.keyMode ?? 'free');
  const readout = readNote ? readoutFor(readNote) : '';

  return (
    <div className="viz pov" ref={containerRef}>
      <p className="pov-key">{caption}</p>
      <p className="pov-readout num" aria-hidden="true">
        {gated ? 'This take did not line up with the phrase, so there is nothing to compare yet.' : readout || (containerW < 360 ? 'Touch the plot to read a note.' : 'Touch or drag across the plot to read a note.')}
      </p>
      <p className="visually-hidden" role="status" aria-live="polite">
        {kbNote !== null && notes[kbNote] ? readoutFor(notes[kbNote]) : ''}
      </p>
      <div className="pov-frame">
        <svg className="pov-axis" width={AXIS_W} height={height} aria-hidden="true">
          {gridNotes
            .filter((m) => labelled.has(((m % 12) + 12) % 12))
            .map((m) => (
              <text key={m} className="viz-tick" x={AXIS_W - 6} y={y(m)} textAnchor="end" dominantBaseline="middle">
                {midiToNoteName(m)}
              </text>
            ))}
        </svg>
        <div
          className="pov-scroll"
          tabIndex={notes.length > 0 ? 0 : undefined}
          role="group"
          aria-label={`${label} Use the left and right arrow keys to step through the notes.`}
          onKeyDown={onKey}
        >
          <svg
            className="pov-svg"
            width={plotW}
            height={height}
            role="img"
            aria-label={label}
            onPointerDown={onTap}
            onPointerMove={onPointer}
            onPointerLeave={onLeave}
          >
            <defs>
              <clipPath id={clipId}>
                <rect x={0} y={PAD_TOP} width={plotW} height={plotBottom - PAD_TOP} />
              </clipPath>
            </defs>

            {bandVisible && pass && (
              <g>
                <rect className="pov-passaggio" x={0} y={bandTop} width={innerW} height={bandBottom - bandTop} />
                {bandBottom - bandTop >= 13 && (
                  <text className="viz-note" x={6} y={bandTop + 11}>
                    passaggio
                  </text>
                )}
              </g>
            )}

            {gridNotes.map((m) => {
              const pc = ((m % 12) + 12) % 12;
              const isLabelled = labelled.has(pc);
              if (!isLabelled && pxPerSemitone < 3) return null;
              return <line key={m} className={isLabelled ? 'pov-grid pov-grid--strong' : 'pov-grid'} x1={0} x2={innerW} y1={r1(y(m))} y2={r1(y(m))} />;
            })}

            {tTicks.map((t) => (
              <g key={t}>
                <line className="pov-grid pov-grid--strong" x1={r1(x(t))} x2={r1(x(t))} y1={plotBottom} y2={plotBottom + 4} />
                <text className="viz-tick" x={r1(x(t))} y={height - 6} textAnchor={t === 0 ? 'start' : x(t) > innerW - 16 ? 'end' : 'middle'}>
                  {formatTick(t, duration)}
                </text>
              </g>
            ))}
            <line className="pov-grid pov-grid--strong" x1={0} x2={innerW} y1={plotBottom} y2={plotBottom} />

            <g clipPath={`url(#${clipId})`}>
              {notes.map((n) => {
                const nominal = nominalMidi(reference, n, shift);
                if (nominal === null) return null;
                const x0 = x(n.refStart);
                const w = Math.max(2, x(n.refEnd) - x0);
                const top = y(nominal + BAND_SEMITONES);
                const h = Math.max(3, y(nominal - BAND_SEMITONES) - top);
                const isSel = selected === n.refIndex || active === n.refIndex;
                const missed = n.flags.includes('missed') || !n.matched;
                return (
                  <g key={n.refIndex}>
                    <rect
                      className={`pov-band${missed ? ' pov-band--missed' : ''}${isSel ? ' pov-band--selected' : ''}`}
                      x={r1(x0)}
                      y={r1(top)}
                      width={r1(w)}
                      height={r1(h)}
                      rx={2}
                    />
                    {w >= 24 && h >= 9 && (
                      <text className="viz-tick pov-bandname" x={r1(x0 + 3)} y={r1(top + Math.min(h - 2, 10))}>
                        {n.refName}
                      </text>
                    )}
                  </g>
                );
              })}
              {refSegments.map((s, i) => (
                <path key={`r${i}`} className="pov-ref" d={pathData(s, x, y)} />
              ))}
              {takeSegments.map((s, i) => (
                <path key={`t${i}`} className="pov-take" d={pathData(s, x, y)} />
              ))}
              {bars.map((b) => (
                <line key={`b${b.index}`} className="pov-take pov-take--bar" x1={r1(x(b.t0))} x2={r1(x(b.t1))} y1={r1(y(b.midi))} y2={r1(y(b.midi))} />
              ))}
              {!gated &&
                notes.map((n) => {
                  const kind = markerKind(n);
                  if (!kind) return null;
                  const nominal = nominalMidi(reference, n, shift);
                  if (nominal === null) return null;
                  return <Marker key={`m${n.refIndex}`} kind={kind} cx={x((n.refStart + n.refEnd) / 2)} cy={Math.max(PAD_TOP - 2, y(nominal + BAND_SEMITONES) - 7)} />;
                })}
            </g>

            {hover && (
              <line className="pov-cursor" x1={r1(hover.x)} x2={r1(hover.x)} y1={PAD_TOP} y2={plotBottom} pointerEvents="none" />
            )}
          </svg>
        </div>
      </div>
      <ul className="viz-legend" aria-label="Plot key">
        <li>
          <span className="viz-key viz-key--dashed" aria-hidden="true" /> The original
        </li>
        <li>
          <span className="viz-key viz-key--line" style={{ background: 'var(--accent)' }} aria-hidden="true" /> You
        </li>
        <li>
          <span className="viz-key pov-key-band" aria-hidden="true" /> Right note (±50¢)
        </li>
        {pass && (
          <li>
            <span className="viz-key viz-key--band" aria-hidden="true" /> Passaggio
          </li>
        )}
        {!gated && notes.some((n) => markerKind(n) !== null) && (
          <li>
            <span className="pov-key-marks" aria-hidden="true">▲ ▼ ✕ ○</span> sharp, flat, wrong, missed
          </li>
        )}
      </ul>
      {!gated && takeFrames.length === 0 && bars.length > 0 && <p className="viz-caption">Your notes are drawn from the note table (pitch, entrance and length per note).</p>}
      {notes.some((n) => n.flags.some((f) => isSevereFlag(f))) && !gated && <p className="viz-caption">Marked notes cost points; the note table below says how much.</p>}
    </div>
  );
}
