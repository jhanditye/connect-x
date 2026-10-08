// The controls of the practice screen. PracticeControls holds the choices: which key the guide plays in, how fast, sing along or
// listen then sing, the count-in, the loop. PracticeDock holds the two big buttons (Listen, Sing) and sits at the bottom of the
// screen, in thumb reach. Everything is a 44 px button or a native radio; nothing needs a hover or a long press. The screen
// decides what the buttons do (the PracticeEngine); these components only show the choices and ask.

import { useId, useState, type JSX } from 'react';
import type { RouteInfo } from '../../audio/duplex';
import { routeNotes, type RouteNote } from '../../audio/route';
import { shiftLabel } from '../../trainer/keys';
import type { PracticeOptions, PracticeState } from '../../trainer/engine';
import type { PlayMode } from '../../types';
import { COUNT_IN_CHOICES, SPEEDS } from '../trainerPrefs';
import { Icon } from './Icon';
import { Notice } from './Notice';
import { loopText, type Loop } from './PhraseStrip';

export interface PracticeControlsProps {
  options: PracticeOptions;
  state: PracticeState;
  route: RouteInfo | null;
  /** The key the last good attempt was sung in (PhraseRecord.keyHint), offered as "My key". */
  keyHint: number | null;
  /** The phrase window length, for "loop the whole phrase". */
  durationSec: number;
  /** Set when the chosen key would put the original out of the range the app can follow. */
  rangeMessage?: string | null;
  onOptions(patch: Partial<PracticeOptions>): void;
  /** Where "use the iPhone microphone" goes (Settings). */
  onOpenMicSettings?(): void;
}

const MODES: { value: PlayMode; label: string }[] = [
  { value: 'sing-along', label: 'Sing along' },
  { value: 'turn-taking', label: 'Listen, then sing' },
];

/** Busy states in which nothing can be changed or started. */
function locked(state: PracticeState): boolean {
  return state === 'preparing' || state === 'processing' || state === 'closed';
}

function inTake(state: PracticeState): boolean {
  return state === 'singing' || state === 'countin';
}

export function speedLabel(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function PracticeControls(props: PracticeControlsProps): JSX.Element {
  const { options, state, route, keyHint, durationSec } = props;
  const ids = { key: useId(), speed: useId(), mode: useId(), count: useId(), loop: useId() };
  const [otherKey, setOtherKey] = useState(false);
  const off = locked(state) || inTake(state);

  const notes: RouteNote[] = route ? routeNotes(route, options.mode) : [];
  const hintShift = keyHint !== null && Math.round(keyHint) !== 0 ? Math.round(keyHint) : null;
  const shift = Math.round(options.guideShift);
  const customShift = shift !== 0 && shift !== hintShift;
  const wholeLoop = options.loop !== null && options.loop.from <= 0.02 && options.loop.to >= durationSec - 0.02;
  const setLoop = (loop: Loop | null) => props.onOptions({ loop });

  return (
    <div className="pc">
      {notes
        // The speaker-and-sing-along warning is asked about when Sing is tapped (PracticeDock); the rest are advice up front.
        .filter((n) => n.id !== 'speaker-sing-along' && n.id !== 'no-headphones')
        .map((n) => (
          <Notice key={n.id} tone={n.level === 'warn' ? 'warn' : 'info'}>
            <p>{n.message}</p>
            {n.action === 'use-builtin-mic' && props.onOpenMicSettings && (
              <div className="button-row">
                <button type="button" className="button button--small" onClick={props.onOpenMicSettings}>
                  Choose the microphone
                </button>
              </div>
            )}
          </Notice>
        ))}
      {props.rangeMessage && (
        <Notice tone="warn">
          <p>{props.rangeMessage}</p>
        </Notice>
      )}

      <div className="pc-grid">
        <div className="pc-row" role="group" aria-labelledby={ids.key}>
          <p className="pc-label" id={ids.key}>
            Key
          </p>
          <div className="pc-chips">
            <button type="button" className="tr-chip" aria-pressed={shift === 0} onClick={() => props.onOptions({ guideShift: 0 })} disabled={off}>
              Original
            </button>
            {hintShift !== null && (
              <button type="button" className="tr-chip" aria-pressed={shift === hintShift} onClick={() => props.onOptions({ guideShift: hintShift })} disabled={off}>
                {shiftLabel(hintShift)}
              </button>
            )}
            <button type="button" className="tr-chip" aria-pressed={customShift} aria-expanded={otherKey} onClick={() => setOtherKey((v) => !v)} disabled={off}>
              {customShift ? shiftLabel(shift) : 'Other'}
            </button>
          </div>
          {otherKey && (
            <div className="pc-stepper" role="group" aria-label="Guide key in semitones">
              <button type="button" className="button button--small" onClick={() => props.onOptions({ guideShift: Math.max(-12, shift - 1) })} disabled={off || shift <= -12}>
                <Icon name="chevron-down" size={18} /> Lower
              </button>
              <span className="num pc-stepper-n" aria-live="polite">
                {shift === 0 ? '0' : shift > 0 ? `+${shift}` : `−${Math.abs(shift)}`}
                <span className="visually-hidden"> semitones</span>
              </span>
              <button type="button" className="button button--small" onClick={() => props.onOptions({ guideShift: Math.min(12, shift + 1) })} disabled={off || shift >= 12}>
                <Icon name="chevron-up" size={18} /> Higher
              </button>
            </div>
          )}
        </div>

        <div className="pc-row" role="group" aria-labelledby={ids.speed}>
          <p className="pc-label" id={ids.speed}>
            Speed
          </p>
          <div className="pc-chips">
            {SPEEDS.map((r) => (
              <button key={r} type="button" className="tr-chip" aria-pressed={Math.abs(options.rate - r) < 0.01} onClick={() => props.onOptions({ rate: r })} disabled={off}>
                <span className="num">{speedLabel(r)}</span>
                {r === 0.5 && <span className="pc-rough"> rough</span>}
              </button>
            ))}
          </div>
        </div>

        <fieldset className="pc-row pc-mode" aria-describedby={`${ids.mode}-hint`}>
          <legend className="pc-label">Mode</legend>
          <div className="segmented-options" role="radiogroup">
            {MODES.map((m) => (
              <label key={m.value} className="segmented-option">
                <input
                  type="radio"
                  name={`${ids.mode}-mode`}
                  value={m.value}
                  checked={options.mode === m.value}
                  onChange={() => props.onOptions({ mode: m.value })}
                  disabled={off}
                />
                <span>{m.label}</span>
              </label>
            ))}
          </div>
          <p id={`${ids.mode}-hint`} className="pc-hint">
            {options.mode === 'sing-along'
              ? route && route.headphonesLikely
                ? 'Headphones on: the guide plays while you sing, after a count-in.'
                : 'Needs headphones, so the microphone does not hear the guide.'
              : 'You hear the phrase, then it is your turn. Works with the speaker.'}
          </p>
        </fieldset>

        <div className="pc-row" role="group" aria-labelledby={ids.count}>
          <p className="pc-label" id={ids.count}>
            Count-in
          </p>
          <div className="pc-chips">
            {COUNT_IN_CHOICES.map((n) => (
              <button key={n} type="button" className="tr-chip" aria-pressed={options.countInBeats === n} onClick={() => props.onOptions({ countInBeats: n })} disabled={off}>
                <span className="num">{n}</span> beats
              </button>
            ))}
          </div>
        </div>

        <div className="pc-row" role="group" aria-labelledby={ids.loop}>
          <p className="pc-label" id={ids.loop}>
            Loop
          </p>
          <div className="pc-chips">
            <button type="button" className="tr-chip" aria-pressed={wholeLoop} onClick={() => setLoop(wholeLoop ? null : { from: 0, to: durationSec })} disabled={off || durationSec <= 0}>
              <Icon name="loop" size={16} /> Whole phrase
            </button>
            {options.loop !== null && !wholeLoop && (
              <>
                <span className="pc-loop-text num">{loopText(options.loop, durationSec)}</span>
                <button type="button" className="button button--ghost button--small" onClick={() => setLoop(null)} disabled={off}>
                  Clear loop
                </button>
              </>
            )}
          </div>
          {options.loop === null && <p className="pc-hint">Tap a note or drag across the strip to loop just that part.</p>}
        </div>
      </div>
    </div>
  );
}

export interface PracticeDockProps {
  options: PracticeOptions;
  state: PracticeState;
  route: RouteInfo | null;
  hasResult: boolean;
  onOptions(patch: Partial<PracticeOptions>): void;
  onListen(): void;
  onSing(): void;
  onStop(): void;
}

/** Listen and Sing, large, at the bottom of the screen. Singing along without headphones asks first. */
export function PracticeDock(props: PracticeDockProps): JSX.Element {
  const { options, state, route } = props;
  const askId = useId();
  const [asking, setAsking] = useState(false);
  const [speakerOk, setSpeakerOk] = useState(false);
  const busy = locked(state);
  const recording = inTake(state);
  const listening = state === 'listening';
  const speakerRisk = options.mode === 'sing-along' && route !== null && !route.headphonesLikely && !route.labelsHidden;

  const sing = () => {
    if (speakerRisk && !speakerOk) {
      setAsking(true);
      return;
    }
    props.onSing();
  };

  const singLabel =
    state === 'singing' ? 'Stop' : state === 'countin' ? 'Cancel' : state === 'processing' ? 'Analysing…' : state === 'preparing' ? 'Getting ready…' : props.hasResult ? 'Try again' : 'Sing';

  return (
    <div className="pd">
      {asking && (
        <div
          className="pc-ask"
          role="alert"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setAsking(false);
            }
          }}
        >
          <p id={askId} className="pc-ask-text">
            <Icon name="headphones" size={18} /> No headphones detected. If the guide plays from the speaker, the microphone hears it too and your score can be wrong.
          </p>
          <div className="button-row">
            <button
              type="button"
              className="button button--accent"
              autoFocus
              onClick={() => {
                setAsking(false);
                props.onOptions({ mode: 'turn-taking' });
                props.onSing();
              }}
            >
              Listen first, then sing
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setAsking(false);
                setSpeakerOk(true);
                props.onSing();
              }}
            >
              I have headphones on
            </button>
            <button type="button" className="button button--ghost" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="pc-dock">
        <button type="button" className="pc-listen" onClick={listening ? props.onStop : props.onListen} disabled={busy || recording}>
          <Icon name={listening ? 'stop' : 'play'} size={20} /> {listening ? 'Stop' : 'Listen'}
        </button>
        <button type="button" className={`pc-sing${recording ? ' pc-sing--live' : ''}`} onClick={recording ? props.onStop : sing} disabled={busy}>
          {recording ? <Icon name="stop" size={20} /> : <span className="pc-sing-dot" aria-hidden="true" />} {singLabel}
        </button>
      </div>
    </div>
  );
}
