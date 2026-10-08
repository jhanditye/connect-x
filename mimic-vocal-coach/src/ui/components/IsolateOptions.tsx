// "Isolate the vocal first (AI)": the choice on the Add clips screen, and the offer in a clip's review. Both say what it costs and
// what it cannot do before anything is downloaded or run. Shown only when the app can really do it (audio/separation/client.ts).

import { useId, useState } from 'react';
import type { ModelManifest } from '../../audio/separation/manifest';
import type { ImportProgress, IsolateRequest } from '../../trainer/import';
import { MAX_ISOLATE_SEC } from '../../trainer/import';
import { interruptedSplitText, ISOLATE_LABEL, ISOLATE_LIMIT_TEXT, isolateCapText, isolateCostText } from '../../trainer/importCopy';
import { interruptedSplit } from '../../trainer/splitMarker';

export interface IsolateChoice {
  on: boolean;
  /** "m:ss" typed by the person. */
  start: string;
  /** Minutes of the song to take, from the start. */
  minutes: number;
}

/**
 * One minute by default, not the most: nobody has timed or measured the memory of a split on a phone yet, and a long run is the one that
 * can be paused by the screen locking or ended by iOS. A verse and a chorus are enough to practise from; the longer parts are one tap away.
 */
export const DEFAULT_ISOLATE_CHOICE: IsolateChoice = { on: false, start: '0:00', minutes: 1 };

const MAX_MINUTES = Math.floor(MAX_ISOLATE_SEC / 60);

/** "1:30" or "90" to seconds; "" is the beginning; null when it is not a time. */
export function parseClock(text: string): number | null {
  const t = text.trim();
  if (t === '') return 0;
  const m = /^(?:(\d{1,3}):)?(\d{1,5})(?:\.\d+)?$/.exec(t);
  if (!m) return null;
  const minutes = m[1] === undefined ? 0 : Number(m[1]);
  const seconds = Number(m[2]);
  if (m[1] !== undefined && seconds > 59) return null;
  return minutes * 60 + seconds;
}

/** What to hand to prepareClip: null when the option is off or the start is not a time. */
export function requestFromChoice(c: IsolateChoice): IsolateRequest | null {
  if (!c.on) return null;
  const startSec = parseClock(c.start);
  if (startSec === null) return null;
  return { startSec, maxSec: Math.max(1, Math.min(MAX_MINUTES, Math.round(c.minutes))) * 60 };
}

/** Seconds left as words: "about 3 min left", "under a minute left"; a hint while there is no estimate yet. */
export function etaWords(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return 'Working out how long this will take';
  if (sec < 45) return 'Under a minute left';
  const min = Math.round(sec / 60);
  return `About ${min} min left`;
}

/** One line for what a progress report means. */
export function progressWords(p: ImportProgress): string {
  switch (p.phase) {
    case 'downloading-model':
      return `Downloading the vocal model (one time)`;
    case 'isolating':
      return `Splitting the song into voice and band`;
    default:
      return '';
  }
}

export function IsolateChoiceCard(props: {
  manifest: ModelManifest | null;
  modelKept: boolean;
  value: IsolateChoice;
  onChange(next: IsolateChoice): void;
  startError: string | null;
}) {
  const id = useId();
  const { value, onChange } = props;
  // A split that iOS cut off (the page came back fresh) is said once, here, where the next one is chosen.
  const [cutOff] = useState(() => interruptedSplit());
  const sizeMb = props.manifest ? props.manifest.bytes / (1024 * 1024) : null;
  return (
    <section className="imp-isolate" aria-labelledby={`${id}-t`}>
      {cutOff && (
        <p className="field-hint" role="status">
          {interruptedSplitText(cutOff.fileName, cutOff.seconds)}
        </p>
      )}
      <label className="rev-check">
        <input type="checkbox" checked={value.on} onChange={(e) => onChange({ ...value, on: e.target.checked })} />
        <span>
          <span className="rev-check-title" id={`${id}-t`}>
            {ISOLATE_LABEL}
          </span>
          <span className="rev-check-hint">For a whole song you own: Mimic pulls the voice out on this phone and practises with that. Takes minutes.</span>
        </span>
      </label>
      {value.on && (
        <div className="imp-isolate-more">
          <p className="field-hint">{isolateCostText(sizeMb, props.modelKept)}</p>
          <p className="field-hint">{ISOLATE_LIMIT_TEXT}</p>
          <p className="field-hint">{isolateCapText(MAX_MINUTES)}</p>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-start`}>
              Start at (minutes:seconds)
            </label>
            <input
              id={`${id}-start`}
              className="text-input"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={value.start}
              maxLength={8}
              aria-invalid={props.startError ? true : undefined}
              onChange={(e) => onChange({ ...value, start: e.target.value })}
            />
            {props.startError && (
              <p className="field-error" role="alert">
                {props.startError}
              </p>
            )}
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-len`}>
              How much of the song
            </label>
            <select id={`${id}-len`} className="select" value={value.minutes} onChange={(e) => onChange({ ...value, minutes: Number(e.target.value) })}>
              {Array.from({ length: MAX_MINUTES }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {m === 1 ? '1 minute' : `${m} minutes`}
                  {m === MAX_MINUTES ? ' (the most)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </section>
  );
}
