// The controls of the practice screen. PracticeControls holds the choices: which key the guide plays in, how fast, sing along or
// listen then sing, the count-in, the loop. PracticeDock holds the two big buttons (Listen, Sing) and sits at the bottom of the
// screen, in thumb reach. Everything is a 44 px button or a native radio; nothing needs a hover or a long press. The screen
// decides what the buttons do (the PracticeEngine); these components only show the choices and ask.

import { useEffect, useId, useRef, useState, type CSSProperties, type JSX, type RefObject } from 'react';
import type { RouteInfo } from '../../audio/duplex';
import { routeNotes, type RouteNote } from '../../audio/route';
import { shiftLabel } from '../../trainer/keys';
import type { PracticeOptions, PracticeState } from '../../trainer/engine';
import type { PlayMode } from '../../types';
import { COUNT_IN_CHOICES, SPEEDS } from '../trainerPrefs';
import { Icon } from './Icon';
import { Notice } from './Notice';
import { loopText, type Loop } from './PhraseStrip';
import { isDesktopKind, platformKind } from '../../pwa/platform';

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
  const kind = platformKind();
  const ids = { key: useId(), speed: useId(), mode: useId(), count: useId(), loop: useId() };
  const [otherKey, setOtherKey] = useState(false);
  const off = locked(state) || inTake(state);

  const notes: RouteNote[] = route ? routeNotes(route, options.mode, kind) : [];
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
                <span className="visually-hidden"> {Math.abs(shift) === 1 ? 'semitone' : 'semitones'}</span>
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
          {options.loop === null && <p className="pc-hint">{isDesktopKind(kind) ? 'Click a note or drag across the strip to loop just that part.' : 'Tap a note or drag across the strip to loop just that part.'}</p>}
        </div>
      </div>
    </div>
  );
}

export interface DockNote {
  text: string;
  /** error and interruption messages are announced at once (role="alert"); the rest politely. */
  tone: 'info' | 'warn' | 'error';
}

export interface PracticeDockProps {
  options: PracticeOptions;
  state: PracticeState;
  route: RouteInfo | null;
  hasResult: boolean;
  /** The engine already has the singer's yes to "I have headphones on" for this route (snapshot.speakerConfirmed): do not ask again. */
  speakerConfirmed?: boolean;
  /**
   * What the last action said (a failure, an interruption, a cancelled take). It is shown here, above the buttons, because the dock
   * is pinned over the bottom of the page: a message further up the page sits under it on a phone in a Safari tab.
   */
  note?: DockNote | null;
  onDismissNote?(): void;
  /** The Sing button, when the screen needs to move focus to it (for example after the microphone was turned off). */
  singRef?: RefObject<HTMLButtonElement | null>;
  onOptions(patch: Partial<PracticeOptions>): void;
  onListen(): void;
  /** `speakerConfirmed`: the singer said they have headphones on, though the route does not look like it. */
  onSing(speakerConfirmed?: boolean): void;
  /** Stops the guide, or cancels a take (nothing is scored). */
  onStop(): void;
  /** While recording: end the take now and score what was sung. */
  onFinish(): void;
}

/** A button that is "not available right now" but keeps keyboard and VoiceOver focus (a disabled button would drop it to the page). */
const dimmed: CSSProperties = { opacity: 0.5, cursor: 'not-allowed' };
/** The look of the dock's message (the same paper-and-border as the headphones question), from tokens so both themes work. */
function noteStyle(tone: DockNote['tone']): CSSProperties {
  const edge = tone === 'error' ? 'var(--bad)' : 'var(--warn)';
  return {
    marginBottom: 'var(--space-3)',
    padding: 'var(--space-3)',
    borderRadius: 'var(--radius-md)',
    background: `color-mix(in srgb, ${edge} 14%, var(--surface))`,
    border: `1px solid ${edge}`,
    fontSize: 'var(--fs-sm)',
    maxHeight: '35vh',
    overflowY: 'auto',
  };
}
/** A Tab press and the focus it causes are one event; a focus this much later was not caused by the key. */
const TAB_FOCUS_MS = 100;

/**
 * Listen and Sing, large, at the bottom of the screen. Singing along without headphones asks first. While a take runs the left
 * button cancels it and the right one is Done (it scores what was sung); the buttons keep their place so focus stays where it was.
 */
export function PracticeDock(props: PracticeDockProps): JSX.Element {
  const { options, state, route } = props;
  const askId = useId();
  const [asking, setAsking] = useState(false);
  const [speakerOk, setSpeakerOk] = useState(false);
  const ownSingRef = useRef<HTMLButtonElement>(null);
  const singRef = props.singRef ?? ownSingRef;
  const tabbedAt = useRef<{ y: number; at: number } | null>(null);
  const closed = state === 'closed';
  const preparing = state === 'preparing';
  const processing = state === 'processing';
  const countIn = state === 'countin';
  const singing = state === 'singing';
  const listening = state === 'listening';
  const speakerRisk = options.mode === 'sing-along' && route !== null && !route.headphonesLikely && !route.labelsHidden;
  const confirmed = speakerOk || props.speakerConfirmed === true;

  // Tabbing to Listen or Sing must not drag the page to the bottom (the page's scroll padding is larger than the room the pinned dock
  // leaves, so the browser scrolls to the end to "make room"): the dock is always on screen, the scroll position is put back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Tab') tabbedAt.current = { y: window.scrollY, at: performance.now() };
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);
  const keepScroll = (): void => {
    const t = tabbedAt.current;
    tabbedAt.current = null;
    if (!t || performance.now() - t.at > TAB_FOCUS_MS || Math.abs(window.scrollY - t.y) < 1) return;
    try {
      window.scrollTo(0, t.y);
    } catch {
      // No scrolling here (a test window): nothing to put back.
    }
  };

  /** Focus goes to Sing, which is always on screen, whenever the control that was pressed goes away or changes meaning. */
  const focusSing = (): void => singRef.current?.focus({ preventScroll: true });

  const sing = () => {
    if (speakerRisk && !confirmed) {
      setAsking(true);
      return;
    }
    props.onSing(speakerRisk && confirmed ? true : undefined);
  };
  const closeAsk = (): void => {
    focusSing();
    setAsking(false);
  };

  // Escape cancels what is running (a keyboard user is not made to Tab back to the dock first).
  const running = countIn || singing || listening;
  const onStop = props.onStop;
  useEffect(() => {
    if (!running) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      onStop();
      if (!listening) focusSing();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [running, listening, onStop]);

  const singInert = preparing || countIn || processing || closed;
  const pressSing = (): void => {
    if (singing) props.onFinish();
    else if (!singInert) sing();
  };

  // Command-Return (Control-Return elsewhere) is Sing, and Done while singing, from anywhere on the screen: there are two dozen Tab
  // stops before the dock, and Safari does not Tab to buttons unless the person has switched that on. A modifier is needed so that
  // an ordinary key press (Space to scroll, a letter) never starts a recording.
  const sendSing = useRef(pressSing);
  sendSing.current = pressSing;
  const askingNow = useRef(asking);
  askingNow.current = asking;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || e.defaultPrevented || e.repeat || e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
      if (askingNow.current || document.querySelector('[aria-modal="true"], dialog[open]')) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('textarea, [contenteditable="true"]')) return;
      e.preventDefault();
      sendSing.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const singLabel = singing ? 'Done' : countIn ? 'Get ready…' : processing ? 'Analysing…' : preparing ? 'Getting ready…' : props.hasResult ? 'Try again' : 'Sing';
  const cancelling = countIn || singing;
  const leftInert = !listening && !cancelling && (preparing || processing || closed);
  const leftLabel = listening ? 'Stop' : cancelling ? 'Cancel' : 'Listen';
  const note = props.note ?? null;

  return (
    <div className="pd" onFocus={keepScroll}>
      {asking && (
        <div
          className="pc-ask"
          role="alert"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              closeAsk();
            }
          }}
        >
          <p id={askId} className="pc-ask-text">
            <Icon name="headphones" size={18} />{' '}
            {isDesktopKind(platformKind())
              ? 'No headphones detected. A laptop or desktop speaker sits right next to its microphone, so the microphone hears the guide too and your score can be wrong.'
              : 'No headphones detected. If the guide plays from the speaker, the microphone hears it too and your score can be wrong.'}
          </p>
          <div className="button-row">
            <button
              type="button"
              className="button button--accent"
              autoFocus
              onClick={() => {
                closeAsk();
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
                closeAsk();
                setSpeakerOk(true);
                props.onSing(true);
              }}
            >
              I have headphones on
            </button>
            <button type="button" className="button button--ghost" onClick={closeAsk}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {note && !asking && (
        <div className="pc-note" role={note.tone === 'error' ? 'alert' : 'status'} style={noteStyle(note.tone)}>
          <p className="pc-ask-text">
            <Icon name={note.tone === 'info' ? 'info' : 'alert'} size={18} /> <span>{note.text}</span>
          </p>
          {props.onDismissNote && (
            <div className="button-row">
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => {
                  focusSing();
                  props.onDismissNote?.();
                }}
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
      <div className="pc-dock">
        <button
          type="button"
          className="pc-listen"
          aria-disabled={leftInert || undefined}
          style={leftInert ? dimmed : undefined}
          onClick={() => {
            if (leftInert) return;
            if (listening) props.onStop();
            else if (cancelling) {
              props.onStop();
              focusSing();
            } else props.onListen();
          }}
        >
          <Icon name={listening ? 'stop' : cancelling ? 'close' : 'play'} size={20} /> {leftLabel}
        </button>
        <button
          ref={singRef}
          type="button"
          className={`pc-sing${singing ? ' pc-sing--live' : ''}`}
          aria-disabled={singInert || undefined}
          style={singInert ? dimmed : undefined}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          onClick={pressSing}
        >
          {singing ? <Icon name="check" size={20} /> : <span className="pc-sing-dot" aria-hidden="true" />} {singLabel}
        </button>
      </div>
    </div>
  );
}
