// The practice screen for one phrase. It opens a PracticeEngine through the controller (openPractice) and shows its snapshot:
// the strip (the original in the guide's key, your live pitch while you sing), the choices, the big Listen / Sing dock and, after
// a take, the result sheet. The engine does the audio, the comparison and the saving; this screen only asks and shows, so it
// runs against the scripted FakeTrainerEngine as well as the real one.
//
// Keyboard and screen readers: every control is a button or a radio, the dock buttons keep focus when their label changes (they
// are aria-disabled, never disabled, while busy), one polite live region announces the count-in, the analysis and the result
// (nothing is spoken while the microphone is recording, so a screen reader's voice does not end up in the take), the result sheet's
// heading takes focus, and what a failed or cancelled action said is shown above the dock, where it cannot hide under it.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { requestWakeLock } from '../../audio/route';
import { useApp } from '../../state/context';
import { goTrainer, trainerHash } from '../../state/routing';
import { useTrainer } from '../../state/trainerContext';
import type { PracticeEngine, PracticeSnapshot } from '../../trainer/engine';
import { rangeMessage, shiftLabel } from '../../trainer/keys';
import type { AttemptRecord } from '../../types';
import { Icon } from '../components/Icon';
import { Notice } from '../components/Notice';
import { PhraseStrip } from '../components/PhraseStrip';
import { PracticeControls, PracticeDock, type DockNote } from '../components/PracticeControls';
import { ResultSheet, resultAnnouncement, type Hear } from '../components/ResultSheet';
import { StatusChip } from '../components/StatusChip';
import { neighbours, phraseByNumber, phraseCount, phraseNumber, phraseStatus, visiblePhrases } from '../components/phraseStatus';
import { clipColor } from '../components/ClipCard';
import { useTrainerPrefs } from '../trainerPrefs';
import { singerOf, useFocusOnMount } from './trainerKit';
import { isDesktopKind, platformKind } from '../../pwa/platform';

const noopSubscribe = () => () => undefined;
const noSnapshot = (): PracticeSnapshot | null => null;

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** What the live region says as the practice state changes. Quiet for states that need no words, and while the microphone records. */
function stateAnnouncement(snap: PracticeSnapshot | null, hearing: Hear | null): string {
  if (!snap) return '';
  switch (snap.state) {
    case 'preparing':
      return 'Getting the phrase ready.';
    case 'listening':
      return hearing === 'you' ? 'Playing your take.' : hearing === 'both' ? 'Playing the original and your take together.' : 'Playing the phrase.';
    case 'countin':
      return 'Get ready.';
    // The Done button says it is recording; a spoken "sing now" would be heard by the microphone.
    case 'singing':
      return '';
    case 'processing':
      return 'Analysing your take.';
    // The message itself is on screen above the dock in its own alert; it is not read out a second time here.
    case 'interrupted':
    case 'error':
      return snap.message ? '' : `Something went wrong. ${isDesktopKind(platformKind()) ? 'Click' : 'Tap'} Sing or Listen to try again.`;
    default:
      return '';
  }
}

/** "Original key, 75%, sing along, 3 beats": the choices at a glance when the settings are folded away. */
export function settingsSummary(o: PracticeSnapshot['options']): string {
  const key = Math.round(o.guideShift) === 0 ? 'Original key' : shiftLabel(o.guideShift);
  return `${key}, ${Math.round(o.rate * 100)}%, ${o.mode === 'sing-along' ? 'sing along' : 'listen then sing'}, ${o.countInBeats} beats${o.loop ? ', looping' : ''}`;
}

export function PracticeView(props: { clipId: string; phraseNumber: number; now: number; focusHeading: boolean }) {
  const trainer = useTrainer();
  const app = useApp();
  const trainerRef = useRef(trainer);
  trainerRef.current = trainer;
  const [prefs, setPrefs] = useTrainerPrefs();
  const clip = trainer.getClip(props.clipId);
  const phrase = clip ? phraseByNumber(clip, props.phraseNumber) : undefined;
  const clipId = clip?.id;
  const phraseId = phrase?.id;
  const blocked = !clip || !phrase || clip.audioMissing;

  const headingRef = useFocusOnMount<HTMLHeadingElement>(props.focusHeading);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const [engine, setEngine] = useState<PracticeEngine | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [history, setHistory] = useState<AttemptRecord[]>([]);
  const [tries, setTries] = useState(0);
  const [announce, setAnnounce] = useState('');
  const hearing = useRef<Hear | null>(null);
  const singRef = useRef<HTMLButtonElement>(null);
  /** The result the history list was loaded for: the mastery line waits for it instead of showing a stale or empty count. */
  const [historyFor, setHistoryFor] = useState<unknown>(null);
  const choseMode = useRef(false);
  const [controlsOpen, setControlsOpen] = useState(true);

  // ----- open the engine for this phrase (and close it again when the screen goes)
  useEffect(() => {
    if (!clipId || !phraseId || blocked) return;
    let cancelled = false;
    let opened: PracticeEngine | null = null;
    setEngine(null);
    setOpenError(null);
    setActionNote(null);
    setTries(0);
    choseMode.current = false;
    trainerRef.current.openPractice(clipId, phraseId).then(
      (e) => {
        if (cancelled) {
          e.dispose();
          return;
        }
        opened = e;
        setEngine(e);
      },
      (err) => {
        if (!cancelled) setOpenError(messageOf(err, 'This phrase could not be opened. Go back to the clip and try again.'));
      },
    );
    return () => {
      cancelled = true;
      opened?.dispose();
    };
  }, [clipId, phraseId, blocked, reloads]);

  // The engine's methods are called on it (they may be class methods that use `this`), never passed on bare.
  const subscribe = useMemo(() => (engine ? (listener: () => void) => engine.subscribe(listener) : noopSubscribe), [engine]);
  const getSnapshot = useMemo(() => (engine ? () => engine.getSnapshot() : noSnapshot), [engine]);
  const snap = useSyncExternalStore(subscribe, getSnapshot);

  // ----- the starting options: speed, count-in, and how to start (by the headphones)
  const started = useRef<PracticeEngine | null>(null);
  useEffect(() => {
    if (!engine || !phrase || started.current === engine) return;
    started.current = engine;
    engine.setOptions({ rate: phrase.rate < 1 ? phrase.rate : prefs.defaultRate, countInBeats: prefs.countInBeats, ...(prefs.startMode !== 'auto' ? { mode: prefs.startMode } : {}) });
    // Only when a new engine arrives.
  }, [engine, phrase]);

  const route = snap?.route ?? null;
  useEffect(() => {
    // With no preference, sing along only where headphones are likely; an explicit choice by the singer wins.
    if (!engine || prefs.startMode !== 'auto' || choseMode.current || !route || route.labelsHidden) return;
    const want = route.headphonesLikely ? 'sing-along' : 'turn-taking';
    if (engine.getSnapshot().options.mode !== want) engine.setOptions({ mode: want });
  }, [engine, route, prefs.startMode]);

  // ----- keep the screen awake while practising
  useEffect(() => {
    let release: (() => void) | null = null;
    let gone = false;
    void requestWakeLock().then((r) => {
      if (gone) r();
      else release = r;
    });
    return () => {
      gone = true;
      release?.();
    };
  }, []);

  // ----- history of this phrase (for the result's mastery line and history)
  const result = snap?.result ?? null;
  useEffect(() => {
    if (!phraseId) return;
    let live = true;
    trainerRef.current.listAttempts({ phraseId, limit: 30 }).then(
      (list) => {
        if (!live) return;
        setHistory(list);
        setHistoryFor(result);
      },
      () => {
        if (!live) return;
        setHistory([]);
        setHistoryFor(result);
      },
    );
    return () => {
      live = false;
    };
  }, [phraseId, result]);

  // ----- a new result: count it, announce it, move focus to it; every other state change: say what is happening, once
  const lastResult = useRef<unknown>(null);
  const state = snap?.state ?? (openError ? 'error' : 'preparing');
  useEffect(() => {
    if (result && lastResult.current !== result) {
      lastResult.current = result;
      setTries((n) => n + 1);
      setControlsOpen(false);
      setAnnounce(resultAnnouncement(result, snap?.reference ?? null));
      requestAnimationFrame(() => resultRef.current?.focus({ preventScroll: false }));
      // The announcement uses the reference at the time of the result.
      return;
    }
    if (state === 'closed') return;
    if (state !== 'listening') hearing.current = null;
    // Back at rest (also after a cancelled take): clear what was said, so the next take's first words are heard as new.
    setAnnounce(state === 'idle' || state === 'result' ? '' : stateAnnouncement(snap, hearing.current));
  }, [result, state, snap?.message]);

  // ----- what the buttons do
  const options = snap?.options;
  const act = useCallback((task: () => Promise<void> | void) => {
    setActionNote(null);
    try {
      const r = task();
      if (r) r.catch((err) => setActionNote(messageOf(err, 'That did not work. Try again.')));
    } catch (err) {
      setActionNote(messageOf(err, 'That did not work. Try again.'));
    }
  }, []);
  const setOptions = useCallback(
    (patch: Parameters<PracticeEngine['setOptions']>[0]) => {
      if (patch.mode !== undefined) choseMode.current = true;
      engine?.setOptions(patch);
    },
    [engine],
  );
  const getPosition = useCallback(() => engine?.position() ?? NaN, [engine]);
  const getLiveMidi = useCallback(() => engine?.getSnapshot().liveMidi ?? null, [engine]);

  const hasKnownMedian = snap?.reference?.pitch.medianMidi ?? null;
  const range = useMemo(() => (hasKnownMedian !== null && options ? rangeMessage(hasKnownMedian, options.guideShift) : null), [hasKnownMedian, options]);

  // ----- screens that are not the practice screen
  if (!clip) {
    const loading = trainer.status === 'loading';
    return (
      <div className="page page--practice">
        <a className="back-link" href="#trainer">
          <Icon name="back" size={18} /> All clips
        </a>
        <header className="page-head">
          <h1 className="page-title" ref={headingRef} tabIndex={-1}>
            {loading ? 'Opening your library…' : 'That clip is not in your library'}
          </h1>
          {!loading && <p className="lede">Open the library to pick a clip, or add it again.</p>}
        </header>
      </div>
    );
  }
  if (!phrase) {
    return (
      <div className="page page--practice">
        <a className="back-link" href={trainerHash({ view: 'clip', clipId: clip.id })}>
          <Icon name="back" size={18} /> {clip.title}
        </a>
        <header className="page-head">
          <h1 className="page-title" ref={headingRef} tabIndex={-1}>
            There is no phrase {props.phraseNumber} in this clip
          </h1>
          <p className="lede">
            This clip has {phraseCount(clip.phrases.length)}. The phrases may have been edited since the link was made.
          </p>
        </header>
        <a className="button button--accent" href={trainerHash({ view: 'clip', clipId: clip.id })}>
          Pick a phrase
        </a>
      </div>
    );
  }

  const n = phraseNumber(phrase);
  const visible = visiblePhrases(clip);
  const { prev, next } = neighbours(clip, phrase);
  const status = phraseStatus(phrase, props.now);
  const singer = singerOf(clip, trainer.singers);
  const goPhrase = (p: { index: number }) => goTrainer({ view: 'phrase', clipId: clip.id, phraseNumber: phraseNumber(p) });
  const hiddenCount = clip.phrases.length - visible.length;
  const duration = Math.max(0.5, phrase.end - phrase.start);

  const back = (
    <a className="back-link" href={trainerHash({ view: 'clip', clipId: clip.id })}>
      <Icon name="back" size={18} /> {clip.title}
    </a>
  );

  const header = (
    <header className="pr-head">
      {/* The note buttons and options come before Listen and Sing in the Tab order; this gets a keyboard user to them at once. */}
      <button type="button" className="skip-link" onClick={() => singRef.current?.focus()}>
        Skip to the practice buttons
      </button>
      {back}
      <div className="pr-nav">
        {prev ? (
          <a className="icon-button pr-step" href={trainerHash({ view: 'phrase', clipId: clip.id, phraseNumber: phraseNumber(prev) })} aria-label={`Previous phrase, ${phraseNumber(prev)}`}>
            <Icon name="back" size={20} />
          </a>
        ) : (
          <span className="icon-button pr-step pr-step--off" aria-hidden="true" />
        )}
        <h1 className="pr-title" ref={headingRef} tabIndex={-1}>
          Phrase <span className="num">{n}</span> <span className="pr-of">of {clip.phrases.length}</span>
          {hiddenCount > 0 && <span className="visually-hidden"> ({hiddenCount} hidden)</span>}
        </h1>
        {next ? (
          <a className="icon-button pr-step" href={trainerHash({ view: 'phrase', clipId: clip.id, phraseNumber: phraseNumber(next) })} aria-label={`Next phrase, ${phraseNumber(next)}`}>
            <Icon name="forward" size={20} />
          </a>
        ) : (
          <span className="icon-button pr-step pr-step--off" aria-hidden="true" />
        )}
      </div>
      <p className="pr-status">
        <span className="pr-dot" style={{ background: clipColor(singer) }} aria-hidden="true" />
        {singer?.name.split(' ')[0] ?? (clip.singerLabel || 'Clip')} · <StatusChip status={status} />
        {phrase.stats.best !== null && (
          <>
            {' '}
            · best <span className="num">{Math.round(phrase.stats.best)}</span>
          </>
        )}
      </p>
      {phrase.lyrics && <p className="pr-lyrics">{phrase.lyrics}</p>}
    </header>
  );

  if (clip.audioMissing) {
    return (
      <div className="page page--practice">
        {header}
        <Notice tone="warn" title="This clip needs its audio again">
          <p>The sound of this clip is not on this device (it came back from a backup). Open the clip and pick the same file again, then come back to practise.</p>
          <div className="button-row">
            <a className="button button--small" href={trainerHash({ view: 'clip', clipId: clip.id })}>
              Open the clip
            </a>
          </div>
        </Notice>
      </div>
    );
  }

  if (openError) {
    return (
      <div className="page page--practice">
        {header}
        <Notice tone="error" title="This phrase could not be opened">
          <p>{openError}</p>
          <div className="button-row">
            <button type="button" className="button button--small" onClick={() => setReloads((r) => r + 1)}>
              Try again
            </button>
            <a className="button button--ghost button--small" href={trainerHash({ view: 'clip', clipId: clip.id })}>
              Back to the clip
            </a>
          </div>
        </Notice>
      </div>
    );
  }

  const o = options ?? { rate: 1, guideShift: 0, mode: 'sing-along' as const, countInBeats: 3, loop: null };
  const playing = state === 'listening';
  const singing = state === 'singing';
  const tooSoft = state === 'interrupted' || state === 'error';
  const inResult = result !== null && state !== 'preparing';
  // What the last action said, above the dock: a failure, an interruption, a refused sing-along, a cancelled take.
  const note: DockNote | null = actionNote
    ? { text: actionNote, tone: 'error' }
    : snap?.message && (tooSoft || state === 'idle' || state === 'result')
      ? { text: snap.message, tone: tooSoft ? 'error' : 'info' }
      : null;
  const micOn = !!engine && !!engine.releaseMicrophone && snap?.micOpen === true && (state === 'idle' || state === 'result');
  const turnMicOff = (): void => {
    engine?.releaseMicrophone?.();
    setAnnounce('Microphone off.');
    singRef.current?.focus({ preventScroll: true });
  };

  return (
    <div className="page page--practice">
      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announce}
      </p>
      {header}

      <PhraseStrip
        reference={snap?.reference ?? null}
        durationSec={duration}
        shift={o.guideShift}
        loop={o.loop}
        onLoopChange={(loop) => setOptions({ loop })}
        getPosition={getPosition}
        getLiveMidi={getLiveMidi}
        playing={playing || singing}
        singing={singing}
        countIn={state === 'countin' ? (snap?.countIn ?? null) : null}
        disabled={state === 'preparing' || state === 'processing' || state === 'countin' || singing}
      />

      {state === 'preparing' && (
        <p className="pr-preparing">Getting the phrase ready…</p>
      )}
      {singing && (
        <div className="pr-level" aria-hidden="true">
          <span className="pr-level-fill" style={{ width: `${Math.round(Math.max(0, Math.min(1, snap?.level ?? 0)) * 100)}%` }} />
        </div>
      )}

      {micOn && (
        <div className="button-row">
          <p className="pc-hint">
            <Icon name="mic" size={16} /> Microphone on, so the next try starts at once. It turns itself off in a moment.
          </p>
          <button type="button" className="button button--ghost button--small" onClick={turnMicOff}>
            Turn off
          </button>
        </div>
      )}

      {inResult && result && (
        <ResultSheet
          result={result}
          reference={snap?.reference ?? null}
          phrase={phrase}
          clipKind={clip.kind}
          isolatedReference={!!clip.isolation}
          rate={o.rate}
          triesThisVisit={tries}
          history={history}
          historyReady={historyFor === result}
          keepRecordings={prefs.keepRecordings}
          onKeepRecordings={(on) => setPrefs({ keepRecordings: on })}
          onHear={(which: Hear) => {
            hearing.current = which;
            if (engine) act(() => engine.playAttempt(which));
          }}
          onNext={next ? () => goPhrase(next) : undefined}
          onSlower={() => setOptions({ rate: 0.75 })}
          onFaster={() => setOptions({ rate: 1 })}
          onLoop={(loop) => {
            setOptions({ loop: { from: loop.from, to: loop.to }, rate: loop.rate });
            if (engine) act(() => engine.listen());
          }}
          onOpenExercises={(ids) => app.openPractice(ids)}
          headingRef={resultRef}
        />
      )}

      <details className="pr-settings" open={controlsOpen} onToggle={(e) => setControlsOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="pr-settings-summary">
          <span className="pr-settings-title">Key, speed and mode</span>
          <span className="pr-settings-now num">{settingsSummary(o)}</span>
        </summary>
        <PracticeControls
          options={o}
          state={state}
          route={route}
          keyHint={phrase.keyHint}
          durationSec={duration}
          rangeMessage={range}
          onOptions={setOptions}
          onOpenMicSettings={() => app.go('settings')}
        />
      </details>

      <PracticeDock
        options={o}
        state={state}
        route={route}
        hasResult={result !== null}
        speakerConfirmed={snap?.speakerConfirmed === true}
        note={note}
        onDismissNote={actionNote ? () => setActionNote(null) : undefined}
        singRef={singRef}
        onOptions={setOptions}
        onListen={() => engine && act(() => engine.listen())}
        onSing={(speakerConfirmed) => engine && act(() => engine.sing(speakerConfirmed ? { speakerConfirmed: true } : undefined))}
        onStop={() => engine?.stop()}
        onFinish={() => (engine?.finish ? engine.finish() : engine?.stop())}
      />
    </div>
  );
}
