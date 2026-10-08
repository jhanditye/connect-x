// The phrase editor of the import review: a waveform strip with the detected pitch line and the phrase bands drawn on it,
// tap a band to select it, drag or nudge its edges, split at the cursor, merge with the next, hide a phrase; below it a list of
// the phrases with their length, note range and a difficulty hint. Everything is operable without dragging: the edges are
// sliders (arrow keys), the toolbar has +-50 ms buttons, and the list selects phrases. The strip scrolls inside its own box,
// never the page. Pure state lives in the caller (the phrase list); the edit operations are trainer/segment.ts.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { peaks } from '../../audio/pcm';
import { percentile } from '../../dsp/stats';
import { DIFFICULTY_WORDS, isHidden, MIN_PHRASE_SEC, mergePhrases, nudgePhraseEdge, phraseDifficulty, setHidden, setPhraseEdge, splitPhraseAt, summarizeSegment, type SegPhrase, type Trim } from '../../trainer/segment';
import type { VoiceAnalysis } from '../../types';
import { formatClock, noteRange } from './format';
import { Icon } from './Icon';
import './clipImport.css';

/** Pixels per second the strip can show; the zoom buttons step through these. */
export const ZOOM_LEVELS: readonly number[] = [4, 8, 16, 32, 64, 128];
/** What the nudge buttons and the arrow keys move an edge by. */
export const NUDGE_SEC = 0.05;
const BIG_NUDGE_SEC = 0.5;

/** The strip is never drawn wider than this, so a five-minute clip cannot make a layer the browser struggles with. */
const MAX_STRIP_PX = 24000;
const STRIP_HEIGHT = 168;
const LABEL_BAND = 16;
const RULER_BAND = 20;
const HANDLE_PX = 44;

/** "1:05.3": a time in the clip to a tenth of a second, for edge readouts. */
export function formatEdgeTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.0';
  const tenths = Math.round(sec * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

/** The phrase whose window contains t, or -1. */
export function bandAt(phrases: SegPhrase[], t: number): number {
  return phrases.findIndex((p) => t >= p.start && t < p.end);
}

function closestZoom(pps: number): number {
  let best = 0;
  ZOOM_LEVELS.forEach((z, i) => {
    if (Math.abs(Math.log(z / pps)) < Math.abs(Math.log(ZOOM_LEVELS[best] / pps))) best = i;
  });
  return best;
}

/** The waveform as one closed path: the upper envelope left to right, the lower one back. */
export function waveformPath(samples: Float32Array, duration: number, width: number, midY: number, halfHeight: number): string {
  if (samples.length === 0 || !(duration > 0) || !(width > 0)) return '';
  const bins = Math.max(2, Math.min(4000, Math.round(width / 2)));
  const env = peaks(samples, bins);
  let top = '';
  let bottom = '';
  for (let i = 0; i < bins; i++) {
    const x = ((i + 0.5) / bins) * width;
    const h = Math.min(1, env[i]) * halfHeight;
    top += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${(midY - h).toFixed(1)}`;
    bottom = `L${x.toFixed(1)},${(midY + h).toFixed(1)}${bottom}`;
  }
  return `${top}${bottom}Z`;
}

/** The pitch line as separate polylines (a rest or a jump of more than 2.5 semitones breaks the line). */
export function contourLines(analysis: VoiceAnalysis, pps: number, top: number, height: number): string[] {
  const hop = analysis.hopSec > 0 ? analysis.hopSec : 0.01;
  const midis: number[] = [];
  for (const f of analysis.frames) if (f.voiced && Number.isFinite(f.midi)) midis.push(f.midi);
  if (midis.length < 5) return [];
  const lo = percentile(midis, 3) - 2;
  const hi = Math.max(percentile(midis, 97) + 2, lo + 6);
  const stride = Math.max(1, Math.ceil(1.5 / (pps * hop)));
  const lines: string[] = [];
  let current: string[] = [];
  let prev = NaN;
  const flush = () => {
    if (current.length > 1) lines.push(current.join(' '));
    current = [];
  };
  for (let i = 0; i < analysis.frames.length; i += stride) {
    const f = analysis.frames[i];
    if (!f.voiced || !Number.isFinite(f.midi)) {
      flush();
      prev = NaN;
      continue;
    }
    if (Number.isFinite(prev) && Math.abs(f.midi - prev) > 2.5) flush();
    prev = f.midi;
    const y = top + height - ((f.midi - lo) / (hi - lo)) * height;
    current.push(`${(f.t * pps).toFixed(1)},${Math.max(top, Math.min(top + height, y)).toFixed(1)}`);
  }
  flush();
  return lines;
}

function tickStep(pps: number): number {
  const target = 70 / pps; // seconds per ~70 px
  for (const s of [1, 2, 5, 10, 15, 30, 60]) if (s >= target) return s;
  return 60;
}

export interface PhraseEditorProps {
  duration: number;
  phrases: SegPhrase[];
  onChange(next: SegPhrase[]): void;
  /** The clip's samples for the waveform; omit when they are not at hand. */
  samples?: Float32Array | null;
  analysis?: VoiceAnalysis | null;
  /** The phrase selected, or null for none. Omit to let the editor keep it. */
  selected?: number | null;
  onSelect?(index: number | null): void;
  /** The kept span; the strip dims what lies outside it. */
  trim?: Trim | null;
  /** Playing the selected phrase (the Play button is hidden without `onPlayPhrase`). */
  onPlayPhrase?(index: number): void;
  onStop?(): void;
  playing?: boolean;
  /** Clip time of the playhead while playing, read on every animation frame. */
  getPlayhead?(): number | null;
}

export function PhraseEditor(props: PhraseEditorProps) {
  const { duration, phrases, analysis, samples, trim } = props;
  const [innerSelected, setInnerSelected] = useState<number | null>(phrases.length > 0 ? 0 : null);
  const selectedRaw = props.selected !== undefined ? props.selected : innerSelected;
  const sel = selectedRaw !== null && selectedRaw >= 0 && selectedRaw < phrases.length ? selectedRaw : null;
  const [zoomIdx, setZoomIdx] = useState(2);
  const [cursor, setCursor] = useState<number | null>(null);
  const [showShort, setShowShort] = useState(false);
  const [announce, setAnnounce] = useState('');
  const scrollerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const playheadRef = useRef<SVGLineElement>(null);
  const phrasesRef = useRef(phrases);
  phrasesRef.current = phrases;
  const dragRef = useRef<{ edge: 'start' | 'end'; index: number } | null>(null);
  const initialZoomDone = useRef(false);

  let zoomMax = ZOOM_LEVELS.length - 1;
  while (zoomMax > 0 && duration * ZOOM_LEVELS[zoomMax] > MAX_STRIP_PX) zoomMax--;
  const zoomAt = Math.min(zoomIdx, zoomMax);
  const pps = ZOOM_LEVELS[zoomAt];
  const width = Math.max(1, Math.ceil(duration * pps));
  const edgeOpts = useCallback((): { duration: number; a: VoiceAnalysis | null } => ({ duration, a: analysis ?? null }), [duration, analysis]);

  const select = useCallback(
    (index: number | null) => {
      if (props.selected === undefined) setInnerSelected(index);
      props.onSelect?.(index);
    },
    [props],
  );

  const commit = useCallback(
    (next: SegPhrase[], message?: string) => {
      if (next === phrasesRef.current) return;
      phrasesRef.current = next;
      props.onChange(next);
      if (message) setAnnounce(message);
    },
    [props],
  );

  // The first time the strip has a width, zoom so the selected (or first) phrase fills most of it.
  useEffect(() => {
    if (initialZoomDone.current) return;
    const el = scrollerRef.current;
    const w = el && el.clientWidth > 0 ? el.clientWidth : 320;
    const p = phrases[sel ?? 0];
    if (!p) return;
    initialZoomDone.current = true;
    setZoomIdx(closestZoom((w * 0.8) / Math.max(1, p.end - p.start)));
  }, [phrases, sel]);

  // Keep the selected phrase in view when it changes or the zoom does.
  useEffect(() => {
    const el = scrollerRef.current;
    const p = sel !== null ? phrases[sel] : null;
    if (!el || !p || typeof el.scrollTo !== 'function') return;
    const left = p.start * pps;
    const right = p.end * pps;
    if (left < el.scrollLeft + 8 || right > el.scrollLeft + el.clientWidth - 8) {
      el.scrollTo({ left: Math.max(0, left - 24), behavior: 'auto' });
    }
    // Only when the selection or zoom changes, not on every edit of the same phrase.
  }, [sel, pps]);

  // The playhead is moved on animation frames straight on the SVG, not through React state.
  useEffect(() => {
    const line = playheadRef.current;
    if (!props.playing || !line || !props.getPlayhead || typeof requestAnimationFrame !== 'function') {
      line?.setAttribute('visibility', 'hidden');
      return;
    }
    let raf = 0;
    const tick = () => {
      const t = props.getPlayhead?.() ?? null;
      if (t === null) {
        line.setAttribute('visibility', 'hidden');
      } else {
        const x = t * pps;
        line.setAttribute('x1', String(x));
        line.setAttribute('x2', String(x));
        line.setAttribute('visibility', 'visible');
        const el = scrollerRef.current;
        if (el && (x < el.scrollLeft + 12 || x > el.scrollLeft + el.clientWidth - 40) && typeof el.scrollTo === 'function') el.scrollTo({ left: Math.max(0, x - el.clientWidth * 0.3), behavior: 'auto' });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [props.playing, props.getPlayhead, pps]);

  const views = useMemo(() => {
    const mid = LABEL_BAND + (STRIP_HEIGHT - LABEL_BAND - RULER_BAND) / 2;
    const region = STRIP_HEIGHT - LABEL_BAND - RULER_BAND;
    return {
      wave: samples && samples.length > 0 ? waveformPath(samples, duration, width, mid, region * 0.42) : '',
      lines: analysis ? contourLines(analysis, pps, LABEL_BAND + region * 0.08, region * 0.84) : [],
    };
  }, [samples, analysis, duration, width, pps]);

  const rows = useMemo(
    () =>
      phrases.map((p) => ({
        summary: analysis ? summarizeSegment(analysis, p) : null,
        difficulty: analysis ? phraseDifficulty(analysis, p) : null,
      })),
    [phrases, analysis],
  );

  const timeFromClientX = (clientX: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    return ((clientX - (rect?.left ?? 0)) / pps) || 0;
  };

  // ----- strip interaction

  const onStripClick = (e: ReactMouseEvent) => {
    const t = Math.max(0, Math.min(duration, timeFromClientX(e.clientX)));
    setCursor(t);
    const i = bandAt(phrasesRef.current, t);
    if (i >= 0) select(i);
  };

  const onHandleDown = (edge: 'start' | 'end') => (e: ReactPointerEvent<HTMLElement>) => {
    if (sel === null) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { edge, index: sel };
  };
  const onHandleMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    if (!d) return;
    commit(setPhraseEdge(phrasesRef.current, d.index, d.edge, timeFromClientX(e.clientX), edgeOpts()));
  };
  const onHandleUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (d) {
      const p = phrasesRef.current[d.index];
      if (p) setAnnounce(`Phrase ${d.index + 1} ${d.edge} moved to ${formatEdgeTime(d.edge === 'start' ? p.start : p.end)}.`);
    }
  };
  const onHandleKey = (edge: 'start' | 'end') => (e: KeyboardEvent<HTMLElement>) => {
    if (sel === null) return;
    const step = e.shiftKey ? BIG_NUDGE_SEC : NUDGE_SEC;
    let delta = 0;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') delta = -step;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') delta = step;
    else return;
    e.preventDefault();
    nudge(edge, delta);
  };

  // ----- toolbar actions

  const selected = sel !== null ? phrases[sel] : null;

  const nudge = (edge: 'start' | 'end', delta: number) => {
    if (sel === null) return;
    const next = nudgePhraseEdge(phrasesRef.current, sel, edge, delta, edgeOpts());
    const p = next[sel];
    commit(next, p ? `Phrase ${sel + 1} ${edge} is now ${formatEdgeTime(edge === 'start' ? p.start : p.end)}.` : undefined);
  };

  const canSplit = selected !== null && cursor !== null && cursor - selected.start >= MIN_PHRASE_SEC && selected.end - cursor >= MIN_PHRASE_SEC;
  const split = () => {
    if (sel === null || cursor === null || !canSplit) return; // aria-disabled, not disabled: the pressed button keeps the focus
    const next = splitPhraseAt(phrasesRef.current, sel, cursor, MIN_PHRASE_SEC, analysis ?? null);
    commit(next, `Split phrase ${sel + 1} at ${formatEdgeTime(cursor)}. There are now ${next.length} phrases.`);
  };
  const canMerge = sel !== null && sel < phrases.length - 1;
  const merge = () => {
    if (sel === null || !canMerge) return;
    const next = mergePhrases(phrasesRef.current, sel, analysis ?? null);
    commit(next, `Merged phrases ${sel + 1} and ${sel + 2}. There are now ${next.length} phrases.`);
  };
  const toggleHidden = () => {
    if (selected === null || sel === null) return;
    const hide = !isHidden(selected);
    commit(setHidden(phrasesRef.current, sel, hide), `Phrase ${sel + 1} is ${hide ? 'hidden' : 'shown'}.`);
  };
  const stop = () => {
    if (props.playing && props.getPlayhead && selected) {
      const t = props.getPlayhead();
      if (t !== null && t > selected.start && t < selected.end) setCursor(t);
    }
    props.onStop?.();
  };

  // ----- render

  const shortRows = phrases.map((p, i) => (isHidden(p) && p.fragment ? i : -1)).filter((i) => i >= 0);
  const shortOpen = showShort || (sel !== null && shortRows.includes(sel));
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += tickStep(pps)) ticks.push(t);

  if (phrases.length === 0) {
    return (
      <div className="pe">
        <p className="pe-empty">No phrases were found. Go back and pick a clip with a clearly sung melody and short breaths between lines.</p>
      </div>
    );
  }

  const startHandleLeft = selected ? selected.start * pps - HANDLE_PX : 0;
  const endHandleLeft = selected ? selected.end * pps : 0;
  const lowerBound = (edge: 'start' | 'end'): number => (selected === null || sel === null ? 0 : edge === 'start' ? (phrases[sel - 1]?.end ?? 0) : selected.start + MIN_PHRASE_SEC);
  const upperBound = (edge: 'start' | 'end'): number => (selected === null || sel === null ? duration : edge === 'start' ? selected.end - MIN_PHRASE_SEC : (phrases[sel + 1]?.start ?? duration));

  return (
    <div className="pe">
      <div className="pe-strip-head">
        <h4 className="pe-title">Phrases</h4>
        <div className="pe-zoom" role="group" aria-label="Zoom the strip">
          <button type="button" className="icon-button icon-button--touch" aria-label="Zoom out" aria-disabled={zoomAt === 0 ? true : undefined} onClick={() => zoomAt > 0 && setZoomIdx(Math.max(0, zoomAt - 1))}>
            <span aria-hidden="true">&minus;</span>
          </button>
          <button type="button" className="icon-button icon-button--touch" aria-label="Zoom in" aria-disabled={zoomAt >= zoomMax ? true : undefined} onClick={() => zoomAt < zoomMax && setZoomIdx(Math.min(zoomMax, zoomAt + 1))}>
            <Icon name="add" size={18} />
          </button>
        </div>
      </div>

      <div className="pe-scroller" ref={scrollerRef} role="group" aria-label="Clip strip: tap a phrase to select it, tap again where you want to split">
        <div className="pe-canvas" style={{ width, height: STRIP_HEIGHT }}>
          <svg ref={svgRef} className="pe-svg" width={width} height={STRIP_HEIGHT} viewBox={`0 0 ${width} ${STRIP_HEIGHT}`} onClick={onStripClick} data-testid="phrase-strip">
            {phrases.map((p, i) => (
              <rect
                key={i}
                className={`pe-band ${i % 2 ? 'pe-band--b' : 'pe-band--a'}${isHidden(p) ? ' pe-band--hidden' : ''}${i === sel ? ' pe-band--selected' : ''}`}
                x={p.start * pps}
                y={LABEL_BAND}
                width={Math.max(1, (p.end - p.start) * pps)}
                height={STRIP_HEIGHT - LABEL_BAND - RULER_BAND}
                data-band={i}
              />
            ))}
            {views.wave && <path className="pe-wave" d={views.wave} />}
            {views.lines.map((pts, i) => (
              <polyline key={i} className="pe-contour" points={pts} />
            ))}
            {phrases.map((p, i) => (
              <text key={i} className={`pe-number${i === sel ? ' pe-number--selected' : ''}`} x={p.start * pps + 4} y={LABEL_BAND - 4}>
                {i + 1}
              </text>
            ))}
            {trim && trim.startSec > 0 && <rect className="pe-dim" x={0} y={0} width={trim.startSec * pps} height={STRIP_HEIGHT - RULER_BAND} />}
            {trim && trim.endSec < duration && <rect className="pe-dim" x={trim.endSec * pps} y={0} width={Math.max(0, (duration - trim.endSec) * pps)} height={STRIP_HEIGHT - RULER_BAND} />}
            {ticks.map((t) => (
              <g key={t}>
                <line className="pe-tick" x1={t * pps} x2={t * pps} y1={STRIP_HEIGHT - RULER_BAND} y2={STRIP_HEIGHT - RULER_BAND + 4} />
                <text className="pe-tick-label" x={t * pps + 3} y={STRIP_HEIGHT - 5}>
                  {formatClock(t)}
                </text>
              </g>
            ))}
            {cursor !== null && <line className="pe-cursor" x1={cursor * pps} x2={cursor * pps} y1={LABEL_BAND} y2={STRIP_HEIGHT - RULER_BAND} />}
            <line ref={playheadRef} className="pe-playhead" x1={0} x2={0} y1={0} y2={STRIP_HEIGHT - RULER_BAND} visibility="hidden" />
          </svg>

          {selected && sel !== null && (
            <>
              <div
                role="slider"
                tabIndex={0}
                className="pe-handle pe-handle--start"
                style={{ left: startHandleLeft }}
                aria-label={`Phrase ${sel + 1} start`}
                aria-orientation="horizontal"
                aria-valuemin={lowerBound('start')}
                aria-valuemax={upperBound('start')}
                aria-valuenow={selected.start}
                aria-valuetext={`${formatEdgeTime(selected.start)} seconds`}
                onPointerDown={onHandleDown('start')}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
                onKeyDown={onHandleKey('start')}
              >
                <span className="pe-grip" aria-hidden="true" />
              </div>
              <div
                role="slider"
                tabIndex={0}
                className="pe-handle pe-handle--end"
                style={{ left: endHandleLeft }}
                aria-label={`Phrase ${sel + 1} end`}
                aria-orientation="horizontal"
                aria-valuemin={lowerBound('end')}
                aria-valuemax={upperBound('end')}
                aria-valuenow={selected.end}
                aria-valuetext={`${formatEdgeTime(selected.end)} seconds`}
                onPointerDown={onHandleDown('end')}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
                onKeyDown={onHandleKey('end')}
              >
                <span className="pe-grip" aria-hidden="true" />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="pe-toolbar" role="group" aria-label={selected && sel !== null ? `Edit phrase ${sel + 1}` : 'Edit phrase'}>
        {selected === null || sel === null ? (
          <p className="pe-hint">Tap a phrase on the strip or in the list to edit it.</p>
        ) : (
          <>
            <div className="pe-row pe-row--nav">
              <button type="button" className="button button--ghost pe-step" aria-label="Previous phrase" aria-disabled={sel === 0 ? true : undefined} onClick={() => sel > 0 && select(sel - 1)}>
                <Icon name="back" size={20} />
              </button>
              {props.onPlayPhrase &&
                (props.playing ? (
                  <button type="button" className="button button--accent pe-play" onClick={stop}>
                    <Icon name="stop" size={18} />
                    <span>Stop</span>
                  </button>
                ) : (
                  <button type="button" className="button button--accent pe-play" onClick={() => props.onPlayPhrase?.(sel)}>
                    <Icon name="play" size={18} />
                    <span>Play phrase {sel + 1}</span>
                  </button>
                ))}
              <button type="button" className="button button--ghost pe-step" aria-label="Next phrase" aria-disabled={sel >= phrases.length - 1 ? true : undefined} onClick={() => sel < phrases.length - 1 && select(sel + 1)}>
                <Icon name="forward" size={20} />
              </button>
            </div>

            <div className="pe-row">
              <EdgeControl label="Start" value={selected.start} onNudge={(d) => nudge('start', d)} phrase={sel + 1} />
              <EdgeControl label="End" value={selected.end} onNudge={(d) => nudge('end', d)} phrase={sel + 1} />
            </div>

            <div className="pe-row">
              <button type="button" className="button" onClick={split} aria-disabled={!canSplit ? true : undefined}>
                <Icon name="split" size={18} />
                <span>Split at cursor</span>
              </button>
              <button type="button" className="button" onClick={merge} aria-disabled={!canMerge ? true : undefined}>
                <Icon name="merge" size={18} />
                <span>Merge with next</span>
              </button>
              <button type="button" className="button" onClick={toggleHidden} aria-pressed={isHidden(selected)}>
                <span>{isHidden(selected) ? 'Show phrase' : 'Hide phrase'}</span>
              </button>
            </div>
            <p className="pe-hint">
              {canSplit
                ? `The cursor is at ${formatEdgeTime(cursor as number)}. Split cuts the phrase there.`
                : 'To split, tap the strip where the phrase should be cut (play it and press Stop to cut at a breath).'}{' '}
              {isHidden(selected) ? 'This phrase is hidden: it will not be practised.' : ''}
            </p>
          </>
        )}
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announce}
      </p>

      <ol className="pe-list" aria-label="Phrases in this clip">
        {phrases.map((p, i) => {
          const row = rows[i];
          const isShort = shortRows.includes(i);
          if (isShort && !shortOpen) return null;
          return (
            <li key={i}>
              <button type="button" className={`pe-item${i === sel ? ' pe-item--selected' : ''}${isHidden(p) ? ' pe-item--hidden' : ''}`} aria-current={i === sel ? 'true' : undefined} onClick={() => select(i)}>
                <span className="pe-item-num num">{i + 1}</span>
                <span className="pe-item-main">
                  <span className="pe-item-time num">
                    {formatClock(p.start)} to {formatClock(p.end)}
                  </span>
                  <span className="pe-item-meta">
                    <span className="num">{(p.voicedEnd - p.voicedStart).toFixed(1)} s</span>
                    {row?.summary && row.summary.lowMidi !== null && <span className="num">{noteRange(row.summary.lowMidi, row.summary.highMidi)}</span>}
                    {isHidden(p) && <span className="chip">{p.fragment ? 'Short bit' : 'Hidden'}</span>}
                    {row?.difficulty && !isHidden(p) && (
                      <span className={`chip pe-level pe-level--${row.difficulty.level}`} title={row.difficulty.reasons.join(', ') || 'Steady notes'}>
                        {DIFFICULTY_WORDS[row.difficulty.level]}
                        {row.difficulty.reasons.length > 0 && <span className="visually-hidden">: {row.difficulty.reasons.join(', ')}</span>}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {shortRows.length > 0 && (
        <button type="button" className="link-button pe-short-toggle" aria-expanded={shortOpen} onClick={() => setShowShort((v) => !v)}>
          {shortOpen ? 'Hide' : 'Show'} {shortRows.length} short bit{shortRows.length === 1 ? '' : 's'}
        </button>
      )}
    </div>
  );
}

function EdgeControl(props: { label: string; value: number; phrase: number; onNudge(delta: number): void }) {
  const ms = Math.round(NUDGE_SEC * 1000);
  return (
    <div className="pe-edge" role="group" aria-label={`${props.label} of phrase ${props.phrase}`}>
      <span className="pe-edge-label">{props.label}</span>
      <button type="button" className="button button--ghost pe-nudge" aria-label={`${props.label} ${ms} milliseconds earlier`} onClick={() => props.onNudge(-NUDGE_SEC)}>
        <span aria-hidden="true">&minus;{ms}</span>
      </button>
      <span className="pe-edge-value num" aria-hidden="true">
        {formatEdgeTime(props.value)}
      </span>
      <button type="button" className="button button--ghost pe-nudge" aria-label={`${props.label} ${ms} milliseconds later`} onClick={() => props.onNudge(NUDGE_SEC)}>
        <span aria-hidden="true">+{ms}</span>
      </button>
    </div>
  );
}
