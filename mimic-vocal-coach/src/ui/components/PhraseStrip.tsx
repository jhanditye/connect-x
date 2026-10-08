// The phrase being practised, drawn in the key the guide plays in: a semitone grid with note names, a bar for every original
// note, the original contour, the loop region with draggable edges, the playhead and, while singing, your live pitch.
// Touch: tap a note to loop it (tap again to clear), drag across the strip to loop a stretch, drag an edge to adjust. Every one
// of those has a plain button too (the note chips under the strip, "Clear loop"), because a drag is not possible for everyone.
//
// The playhead and the live pitch are moved on animation frames straight on the SVG, never through React state, so a 60 Hz
// update does not re-render the screen.

import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type PointerEvent } from 'react';
import { midiToNoteName } from '../../dsp/music';
import type { VoiceAnalysis } from '../../types';
import { clamp, formatTick, linear, r1, timeTicks, useContainerWidth, useSvgId } from '../charts/chartKit';
import { contourSegments, pitchYDomain } from '../charts/PitchPlot';
import { formatDuration } from './format';

export interface Loop {
  from: number;
  to: number;
}

export interface PhraseStripProps {
  /** The original phrase analysis (notes and contour, in the original key); null while it is being prepared. */
  reference: VoiceAnalysis | null;
  /** Length of the phrase window, seconds. */
  durationSec: number;
  /** Guide shift in semitones: the strip is drawn in the key the guide plays in. */
  shift: number;
  loop: Loop | null;
  onLoopChange(loop: Loop | null): void;
  /** Playhead in phrase seconds, NaN when nothing plays. Called on animation frames. */
  getPosition(): number;
  /** Live pitch in the displayed key, null when unvoiced. Called on animation frames while `singing`. */
  getLiveMidi(): number | null;
  playing: boolean;
  singing: boolean;
  /** Beats left in the count-in (shown as a big numeral), or null. */
  countIn: number | null;
  height?: number;
  /** A tap or drag does nothing (the phrase is still loading). */
  disabled?: boolean;
}

const AXIS_W = 34;
const PAD_TOP = 10;
const PAD_BOTTOM = 22;
const PAD_RIGHT = 8;
/** A drag shorter than this many px is a tap. */
const TAP_PX = 8;
/** The smallest loop worth making, seconds. */
export const MIN_LOOP_SEC = 0.3;
const NOTE_PAD_SEC = 0.05;

interface StripNote {
  index: number;
  start: number;
  end: number;
  midi: number;
  name: string;
}

/** The original's notes in the displayed key, clipped to the phrase window. */
export function stripNotes(reference: VoiceAnalysis | null, shift: number, durationSec: number): StripNote[] {
  if (!reference) return [];
  return reference.notes
    .filter((n) => n.end > 0 && n.start < durationSec && Number.isFinite(n.midi))
    .map((n, i) => ({ index: i, start: Math.max(0, n.start), end: Math.min(durationSec, n.end), midi: n.midi + shift, name: midiToNoteName(n.midi + shift) }));
}

/** The loop for one note: its own span with a little room, kept inside the phrase and at least MIN_LOOP_SEC long. */
export function loopForNote(n: Pick<StripNote, 'start' | 'end'>, durationSec: number): Loop {
  const from = clamp(n.start - NOTE_PAD_SEC, 0, durationSec);
  const to = clamp(n.end + NOTE_PAD_SEC, 0, durationSec);
  return to - from >= MIN_LOOP_SEC ? { from, to } : { from, to: Math.min(durationSec, from + MIN_LOOP_SEC) };
}

export function sameLoop(a: Loop | null, b: Loop | null): boolean {
  return a !== null && b !== null && Math.abs(a.from - b.from) < 0.02 && Math.abs(a.to - b.to) < 0.02;
}

export function loopText(loop: Loop | null, durationSec: number): string {
  if (!loop) return 'The whole phrase';
  if (loop.from <= 0.02 && loop.to >= durationSec - 0.02) return 'The whole phrase, on repeat';
  return `${formatDuration(loop.from)} to ${formatDuration(loop.to)}`;
}

function labelledPitchClasses(pxPerSemitone: number): Set<number> {
  if (pxPerSemitone >= 12) return new Set([0, 2, 4, 5, 7, 9, 11]);
  if (pxPerSemitone >= 5) return new Set([0, 4, 7]);
  return new Set([0]);
}

type Drag =
  | { kind: 'new'; startX: number; startT: number; moved: boolean; from: number; to: number }
  | { kind: 'edge'; edge: 'from' | 'to'; moved: boolean; from: number; to: number };

export function PhraseStrip(props: PhraseStripProps): JSX.Element {
  const { reference, durationSec, shift, loop, disabled } = props;
  const height = props.height ?? 188;
  const [containerRef, containerW] = useContainerWidth<HTMLDivElement>(340);
  const clipId = useSvgId('ps-clip');
  const svgRef = useRef<SVGSVGElement>(null);
  const headRef = useRef<SVGLineElement>(null);
  const liveRef = useRef<SVGPolylineElement>(null);
  const trail = useRef<{ t: number; midi: number }[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  const duration = Math.max(0.5, durationSec);
  const notes = useMemo(() => stripNotes(reference, shift, duration), [reference, shift, duration]);
  const segments = useMemo(
    () => (reference ? contourSegments(reference.frames.map((f) => ({ t: f.t, midi: f.voiced && Number.isFinite(f.midi) ? f.midi + shift : NaN, register: null })), 2, false) : []),
    [reference, shift],
  );
  const [yLo, yHi] = useMemo(() => {
    const midis = notes.map((n) => n.midi);
    return pitchYDomain(midis.length > 0 ? midis : [60]);
  }, [notes]);

  const plotW = Math.max(160, containerW - AXIS_W);
  const innerW = plotW - PAD_RIGHT;
  const plotBottom = height - PAD_BOTTOM;
  const x = linear(0, duration, 0, innerW);
  const y = linear(yLo, yHi, plotBottom, PAD_TOP);
  const pxPerSemitone = (plotBottom - PAD_TOP) / (yHi - yLo);
  const labelled = labelledPitchClasses(pxPerSemitone);
  const grid: number[] = [];
  for (let m = Math.ceil(yLo); m <= Math.floor(yHi); m++) grid.push(m);
  const ticks = timeTicks(duration, Math.max(2, Math.floor(innerW / 64)));

  const shown: Loop | null = drag ? { from: Math.min(drag.from, drag.to), to: Math.max(drag.from, drag.to) } : loop;
  const showLoop = shown !== null && !(drag !== null && !drag.moved);
  const wholeLoop = shown !== null && shown.from <= 0.02 && shown.to >= duration - 0.02;

  // The playhead and the live trail, on animation frames.
  const { getPosition, getLiveMidi, playing, singing } = props;
  useEffect(() => {
    const head = headRef.current;
    const live = liveRef.current;
    if (typeof requestAnimationFrame !== 'function') return;
    if (!singing) trail.current = [];
    live?.setAttribute('points', '');
    if (!playing && !singing) {
      head?.setAttribute('visibility', 'hidden');
      return;
    }
    const startedAt = performance.now();
    let raf = 0;
    const tick = () => {
      const pos = getPosition();
      const t = Number.isFinite(pos) ? pos : singing ? (performance.now() - startedAt) / 1000 : NaN;
      if (head) {
        if (Number.isFinite(t)) {
          const px = r1(x(clamp(t, 0, duration)));
          head.setAttribute('x1', String(px));
          head.setAttribute('x2', String(px));
          head.setAttribute('visibility', 'visible');
        } else head.setAttribute('visibility', 'hidden');
      }
      if (singing && live && Number.isFinite(t)) {
        const midi = getLiveMidi();
        const list = trail.current;
        if (midi !== null && Number.isFinite(midi)) {
          // Restart the line after a rest or when the guide loops back.
          if (list.length > 0 && t < list[list.length - 1].t - 0.05) list.length = 0;
          list.push({ t: clamp(t, 0, duration), midi });
          if (list.length > 600) list.splice(0, list.length - 600);
        }
        live.setAttribute('points', list.map((p) => `${r1(x(p.t))},${r1(y(clamp(p.midi, yLo - 1, yHi + 1)))}`).join(' '));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // x and y are re-created on every render; their inputs are what matter.
  }, [playing, singing, getPosition, getLiveMidi, innerW, height, duration, yLo, yHi]);

  const timeAt = useCallback(
    (clientX: number): number => {
      const box = svgRef.current?.getBoundingClientRect();
      const left = (box?.left ?? 0) + AXIS_W;
      return clamp(((clientX - left) / Math.max(1, innerW)) * duration, 0, duration);
    },
    [innerW, duration],
  );

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (disabled || !reference) return;
    const target = e.target as Element;
    const edge = target.getAttribute('data-edge') as 'from' | 'to' | null;
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic events in tests have no active pointer.
    }
    if (edge && loop) setDrag({ kind: 'edge', edge, moved: false, from: loop.from, to: loop.to });
    else setDrag({ kind: 'new', startX: e.clientX, startT: timeAt(e.clientX), moved: false, from: timeAt(e.clientX), to: timeAt(e.clientX) });
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const t = timeAt(e.clientX);
    if (d.kind === 'new') {
      const moved = d.moved || Math.abs(e.clientX - d.startX) > TAP_PX;
      setDrag({ ...d, moved, from: d.startT, to: t });
    } else {
      setDrag({ ...d, moved: true, [d.edge]: t });
    }
  };

  const finish = (e: PointerEvent<SVGSVGElement>, cancelled: boolean) => {
    const d = dragRef.current;
    setDrag(null);
    try {
      svgRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // Nothing was captured.
    }
    if (!d || cancelled) return;
    if (d.kind === 'new' && !d.moved) {
      // A tap: loop the note under the finger, or clear the loop when that note is already the loop.
      const t = timeAt(e.clientX);
      const hit = notes.find((n) => t >= n.start - 0.08 && t <= n.end + 0.08);
      if (!hit) return;
      const next = loopForNote(hit, duration);
      props.onLoopChange(sameLoop(loop, next) ? null : next);
      return;
    }
    const from = Math.min(d.from, d.to);
    const to = Math.max(d.from, d.to);
    if (to - from < MIN_LOOP_SEC) return;
    props.onLoopChange({ from, to });
  };

  const wholeLabel = reference ? `Original phrase in the guide's key: ${notes.length} ${notes.length === 1 ? 'note' : 'notes'}${notes.length ? ` from ${notes.reduce((a, n) => (n.midi < a.midi ? n : a)).name} to ${notes.reduce((a, n) => (n.midi > a.midi ? n : a)).name}` : ''}, ${duration.toFixed(1)} seconds.` : 'The phrase is loading.';

  return (
    <div className="ps" ref={containerRef}>
      <svg
        ref={svgRef}
        className={`ps-svg${disabled || !reference ? ' ps-svg--off' : ''}`}
        width={containerW}
        height={height}
        role="img"
        aria-label={`${wholeLabel}${loop ? ` Looping ${loopText(loop, duration)}.` : ''} Tap a note to loop it, or drag across the strip.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
      >
        <defs>
          <clipPath id={clipId}>
            {/* in the user space of the translated group that uses it */}
            <rect x={0} y={0} width={innerW} height={plotBottom} />
          </clipPath>
        </defs>

        {/* semitone grid with note names */}
        {grid.map((m) => {
          const pc = ((m % 12) + 12) % 12;
          const c = pc === 0;
          const natural = [0, 2, 4, 5, 7, 9, 11].includes(pc);
          if (!natural && pxPerSemitone < 9) return null;
          return (
            <g key={m}>
              <line className={`ps-grid${c ? ' ps-grid--c' : ''}`} x1={AXIS_W} x2={AXIS_W + innerW} y1={r1(y(m))} y2={r1(y(m))} />
              {labelled.has(pc) && (
                <text className="ps-tick" x={AXIS_W - 5} y={r1(y(m))} textAnchor="end" dominantBaseline="middle">
                  {midiToNoteName(m)}
                </text>
              )}
            </g>
          );
        })}

        <g transform={`translate(${AXIS_W},0)`} clipPath={`url(#${clipId})`}>
          {/* loop region under the notes so the notes stay readable */}
          {showLoop && shown && (
            <rect className={`ps-loop${wholeLoop ? ' ps-loop--whole' : ''}`} x={r1(x(shown.from))} y={PAD_TOP - 4} width={Math.max(2, r1(x(shown.to) - x(shown.from)))} height={plotBottom - PAD_TOP + 4} />
          )}
          {notes.map((n) => {
            const w = Math.max(3, x(n.end) - x(n.start));
            const selected = loop !== null && sameLoop(loop, loopForNote(n, duration));
            return (
              <g key={n.index}>
                <rect className={`ps-note${selected ? ' ps-note--loop' : ''}`} x={r1(x(n.start))} y={r1(y(n.midi + 0.42))} width={r1(w)} height={Math.max(6, r1(pxPerSemitone * 0.84))} rx={3} />
                {w >= 26 && (
                  <text className="ps-note-name" x={r1(x(n.start) + 4)} y={r1(y(n.midi + 0.42) - 3)}>
                    {n.name}
                  </text>
                )}
              </g>
            );
          })}
          {segments.map((s, i) => (
            <polyline key={i} className="ps-contour" fill="none" points={s.points.map((p) => `${r1(x(p.t))},${r1(y(p.midi))}`).join(' ')} />
          ))}
          {/* your voice, drawn as it is sung */}
          <polyline ref={liveRef} className="ps-live" fill="none" points="" />
        </g>

        {/* loop edges: drawn above the clip so a handle at the edge of the strip can still be grabbed */}
        {showLoop && shown && !wholeLoop && (
          <g transform={`translate(${AXIS_W},0)`}>
            {(['from', 'to'] as const).map((edge) => (
              <g key={edge}>
                <line className="ps-edge" x1={r1(x(shown[edge]))} x2={r1(x(shown[edge]))} y1={PAD_TOP - 4} y2={plotBottom} />
                <rect className="ps-edge-grip" data-edge={edge} x={r1(x(shown[edge]) - 22)} y={PAD_TOP - 4} width={44} height={plotBottom - PAD_TOP + 4} />
              </g>
            ))}
          </g>
        )}

        <g transform={`translate(${AXIS_W},0)`}>
          <line ref={headRef} className="ps-head" x1={0} x2={0} y1={PAD_TOP - 4} y2={plotBottom} visibility="hidden" />
        </g>

        {/* time axis */}
        <line className="ps-axis" x1={AXIS_W} x2={AXIS_W + innerW} y1={plotBottom} y2={plotBottom} />
        {ticks.map((t) => (
          <text key={t} className="ps-tick" x={r1(AXIS_W + x(t))} y={height - 6} textAnchor={t === 0 ? 'start' : t >= duration - 0.01 ? 'end' : 'middle'}>
            {formatTick(t, duration)}
          </text>
        ))}
      </svg>

      {props.countIn !== null && (
        <div className="ps-count" aria-hidden="true">
          <span className="ps-count-n num">{props.countIn}</span>
        </div>
      )}

      {notes.length > 0 && (
        <div className="ps-notes" role="group" aria-label="Loop one note">
          {notes.map((n) => {
            const target = loopForNote(n, duration);
            const on = sameLoop(loop, target);
            return (
              <button
                key={n.index}
                type="button"
                className="ps-chip"
                aria-pressed={on}
                aria-label={`Loop note ${n.index + 1}, ${n.name}`}
                disabled={disabled}
                onClick={() => props.onLoopChange(on ? null : target)}
              >
                <span className="num">{n.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
