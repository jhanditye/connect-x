// Widgets the singing screens share: header, live needle and trace, the degree strip, findings, the safety note,
// the "sing now" panel with its Stop button, error notices and the headphones question.

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { isDesktopKind, type PlatformKind } from '../../../pwa/platform';
import { BREATH_SAFETY_NOTES, degreeLabelText, type DegreeLabel } from '../../../skills/theory';
import { STRICTNESS_LABELS, type Finding, type LiveReading, type SequenceNoteScore, type Strictness } from '../../../skills/types';
import { Notice } from '../../components/Notice';
import { accuracyOf, centsText, centsWords, foldInto, type Accuracy } from './common';
import type { TakePhase } from './useTake';
import './sing.css';

export function ScreenHead(props: { title: string; lede?: ReactNode; embedded?: boolean; onExit(): void; eyebrow?: string }) {
  if (props.embedded) {
    return (
      <div className="sing-embedded-head">
        <h2 className="section-title">{props.title}</h2>
        {props.lede && <p className="lede">{props.lede}</p>}
      </div>
    );
  }
  return (
    <header className="page-head sing-head">
      <button type="button" className="link-button sing-back" onClick={props.onExit}>
        ← Skills
      </button>
      {props.eyebrow && <p className="eyebrow">{props.eyebrow}</p>}
      <h1 className="page-title">{props.title}</h1>
      {props.lede && <p className="lede">{props.lede}</p>}
    </header>
  );
}

/** Horizontal needle: ±100 cents shown, the strictness band shaded, the needle green inside it. */
export function PitchNeedle(props: { centsNow: number | null; toleranceCents: number; idleText?: string }) {
  const c = props.centsNow;
  const has = c !== null && Number.isFinite(c);
  const clamped = has ? Math.max(-100, Math.min(100, c as number)) : 0;
  const inside = has && Math.abs(c as number) <= props.toleranceCents;
  const bandPct = Math.min(100, props.toleranceCents);
  const words = !has ? (props.idleText ?? 'Waiting for your voice') : inside ? `In the band (${centsText(c)})` : `${centsWords(c)}`;
  return (
    <div className="sing-needle">
      <div className="sing-needle-scale" aria-hidden="true">
        <span className="sing-needle-band" style={{ left: `${50 - bandPct / 2}%`, width: `${bandPct}%` }} />
        <span className="sing-needle-centre" />
        {has && <span className={`sing-needle-mark${inside ? ' sing-needle-mark--in' : ''}`} style={{ left: `${50 + clamped / 2}%` }} />}
        <span className="sing-needle-tick sing-needle-tick--lo">flat</span>
        <span className="sing-needle-tick sing-needle-tick--hi">sharp</span>
      </div>
      <p className={`sing-needle-text${inside ? ' sing-needle-text--in' : ''}`}>{words}</p>
    </div>
  );
}

/**
 * The last few seconds of live pitch against the target lines (each with its strictness band). Readings an octave
 * away are folded onto the view so a man singing a woman's line still sees his trace. Decorative: the needle and
 * the status text carry the numbers.
 */
export function LiveTrace(props: { trace: readonly LiveReading[]; targets: readonly number[]; toleranceCents: number; windowSec?: number; active?: number | null }) {
  const W = 600;
  const H = 160;
  const win = props.windowSec ?? 6;
  const targets = props.targets.filter((t) => Number.isFinite(t));
  const lo = (targets.length ? Math.min(...targets) : 57) - 3;
  const hi = (targets.length ? Math.max(...targets) : 69) + 3;
  const last = props.trace.length ? props.trace[props.trace.length - 1].t : 0;
  const t0 = Math.max(0, last - win);
  const x = (t: number) => ((t - t0) / win) * W;
  const y = (m: number) => H - ((m - lo) / (hi - lo)) * H;
  const tol = props.toleranceCents / 100;
  const segs: string[] = [];
  let cur: string[] = [];
  let prevT = -1;
  for (const r of props.trace) {
    if (r.t < t0) continue;
    if (r.midi === null || !Number.isFinite(r.midi) || (prevT >= 0 && r.t - prevT > 0.12)) {
      if (cur.length > 1) segs.push(cur.join(' '));
      cur = [];
    }
    if (r.midi !== null && Number.isFinite(r.midi)) {
      const m = Math.max(lo - 1, Math.min(hi + 1, foldInto(r.midi, lo, hi)));
      cur.push(`${x(r.t).toFixed(1)},${y(m).toFixed(1)}`);
      prevT = r.t;
    }
  }
  if (cur.length > 1) segs.push(cur.join(' '));
  return (
    <svg className="sing-trace" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {targets.map((t, i) => (
        <g key={`${i}-${t}`} className={props.active === i ? 'sing-trace-target sing-trace-target--active' : 'sing-trace-target'}>
          <rect x={0} width={W} y={y(t + tol)} height={Math.max(1, y(t - tol) - y(t + tol))} className="sing-trace-band" />
          <line x1={0} x2={W} y1={y(t)} y2={y(t)} className="sing-trace-line" />
        </g>
      ))}
      {segs.map((p, i) => (
        <polyline key={i} points={p} className="sing-trace-pitch" fill="none" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

/** A level bar for unvoiced work (hiss): -70 dBFS empty, -10 full. */
export function LevelBar(props: { rmsDb: number | null }) {
  const db = props.rmsDb ?? -120;
  const f = Math.max(0, Math.min(1, (db + 70) / 60));
  return (
    <div className="sing-level" aria-hidden="true">
      <span className="sing-level-fill" style={{ width: `${Math.round(f * 100)}%` }} />
    </div>
  );
}

export const ACCURACY_CLASS: Record<Accuracy, string> = {
  within: 'sing-acc--within',
  near: 'sing-acc--near',
  off: 'sing-acc--off',
  none: 'sing-acc--none',
};

/** The degrees of a line, big; after a take each one is coloured by how close it was and shows its cents. */
export function DegreeStrip(props: { labels: readonly DegreeLabel[]; results?: readonly SequenceNoteScore[] | null; activeIndex?: number | null; toleranceCents: number }) {
  return (
    <ol className="sing-degrees" aria-label="The line">
      {props.labels.map((l, i) => {
        const r = props.results?.[i] ?? null;
        const acc: Accuracy | null = r ? (r.sung ? accuracyOf(r.cents, props.toleranceCents) : 'none') : null;
        const desc = r ? (r.sung ? `${centsWords(r.cents)}${r.octaveSlip ? ', in another octave' : ''}` : 'not heard') : '';
        return (
          <li
            key={i}
            className={`sing-degree${props.activeIndex === i ? ' sing-degree--active' : ''}${acc ? ` ${ACCURACY_CLASS[acc]}` : ''}`}
            aria-label={`${degreeLabelText(l)}${desc ? `: ${desc}` : ''}`}
          >
            <span className="sing-degree-mark sing-degree-mark--hi" aria-hidden="true">
              {l.octaveMark > 0 ? '•'.repeat(Math.min(2, l.octaveMark)) : ''}
            </span>
            <span className="sing-degree-text" aria-hidden="true">
              {l.text}
            </span>
            <span className="sing-degree-mark sing-degree-mark--lo" aria-hidden="true">
              {l.octaveMark < 0 ? '•'.repeat(Math.min(2, -l.octaveMark)) : ''}
            </span>
            {r && (
              <span className="sing-degree-cents" aria-hidden="true">
                {r.sung ? centsText(r.cents) : 'missed'}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export function FindingList(props: { findings: readonly Finding[] }) {
  if (props.findings.length === 0) return null;
  return (
    <ul className="sing-findings">
      {props.findings.map((f, i) => (
        <li key={i} className={`sing-finding sing-finding--${f.tone}`}>
          {f.text}
        </li>
      ))}
    </ul>
  );
}

export function SafetyNote(props: { compact?: boolean }) {
  return (
    <aside className="sing-safety" aria-label="Breathing safety">
      <p className="sing-safety-title">Go gently</p>
      <ul>
        {(props.compact ? BREATH_SAFETY_NOTES.slice(0, 3) : BREATH_SAFETY_NOTES).map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </aside>
  );
}

/** One number with its meaning. */
export function Stat(props: { label: string; value: string; note?: string; tone?: Accuracy }) {
  return (
    <div className={`sing-stat${props.tone ? ` ${ACCURACY_CLASS[props.tone]}` : ''}`}>
      <dt className="sing-stat-label">{props.label}</dt>
      <dd className="sing-stat-value">{props.value}</dd>
      {props.note && <dd className="sing-stat-note">{props.note}</dd>}
    </div>
  );
}

export function phaseText(phase: TakePhase, kind: PlatformKind): string {
  switch (phase) {
    case 'prompt':
      return 'Listen…';
    case 'gap':
      return 'Get ready…';
    case 'listening':
      return 'Sing now';
    case 'scoring':
      return 'Scoring…';
    default:
      return isDesktopKind(kind) ? 'Press Return to start' : 'Tap Start when you are ready';
  }
}

/** The status line and Stop button while a take runs. */
export function TakeStatus(props: { phase: TakePhase; kind: PlatformKind; elapsedSec: number; onStop(): void; hint?: string; noAudioText?: string | null }) {
  const listening = props.phase === 'listening';
  const desktop = isDesktopKind(props.kind);
  return (
    <div className={`sing-status sing-status--${props.phase}`}>
      <p className="sing-status-phase">
        {listening && <span className="rec-light" aria-hidden="true" />} {phaseText(props.phase, props.kind)}
        {listening && <span className="sing-status-time"> {props.elapsedSec.toFixed(1)} s</span>}
      </p>
      {listening && props.hint && <p className="sing-status-hint">{props.hint}</p>}
      {listening && (
        <button type="button" className="button button--rec" onClick={props.onStop}>
          Stop{desktop ? ' (Return)' : ''}
        </button>
      )}
      {listening && props.noAudioText && <p className="sing-status-hint sing-status-warn">{props.noAudioText}</p>}
    </div>
  );
}

export function ErrorNotice(props: { error: { title: string; message: string } | null; onRetry?(): void; retryLabel?: string }) {
  if (!props.error) return null;
  return (
    <Notice tone="error" title={props.error.title}>
      <p>{props.error.message}</p>
      {props.onRetry && (
        <div className="button-row">
          <button type="button" className="button button--small" onClick={props.onRetry}>
            {props.retryLabel ?? 'Try again'}
          </button>
        </div>
      )}
    </Notice>
  );
}

/** Asked before a drone is offered: through speakers it would leak into the microphone. */
export function HeadphonesQuestion(props: { answer: boolean | null; onAnswer(v: boolean): void; kind: PlatformKind }) {
  return (
    <fieldset className="segmented sing-headphones">
      <legend className="field-label">Are you wearing headphones?</legend>
      <p className="field-hint">
        A drone (the note held underneath you) only works with headphones: through {isDesktopKind(props.kind) ? 'the computer’s speakers' : 'the phone’s speaker'} it
        leaks into the microphone and confuses the pitch reading.
      </p>
      <div className="segmented-options">
        <label className="segmented-option">
          <input type="radio" name="sing-headphones" checked={props.answer === true} onChange={() => props.onAnswer(true)} />
          <span>Yes</span>
        </label>
        <label className="segmented-option">
          <input type="radio" name="sing-headphones" checked={props.answer === false} onChange={() => props.onAnswer(false)} />
          <span>No</span>
        </label>
      </div>
    </fieldset>
  );
}

export function StrictnessLine(props: { strictness: Strictness; toleranceCents: number }) {
  return (
    <p className="sing-strictness muted">
      Strictness: {STRICTNESS_LABELS[props.strictness]}, so a note counts as in tune within ±{props.toleranceCents} cents (100 cents is one
      semitone).
    </p>
  );
}

/** Polite live region plus focus on the result heading when a result arrives. */
export function useAnnounceFocus(key: unknown): RefObject<HTMLHeadingElement | null> {
  const ref = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (key === null || key === undefined || key === false) return;
    ref.current?.focus();
  }, [key]);
  return ref;
}

export function LiveRegion(props: { text: string }) {
  return (
    <p className="visually-hidden" aria-live="polite" role="status">
      {props.text}
    </p>
  );
}
