// "Match the note": a target note plays, then the singer finds it with a live needle against the target band. A pass
// is 1.5 s continuously inside the strictness band; the screen reports how long it took to lock in. A drone under
// the voice is offered only after the singer says they wear headphones (speakers would leak into the microphone).

import { useEffect, useMemo, useRef, useState } from 'react';
import { isDesktopKind } from '../../../pwa/platform';
import { AUTO_STOP_RULES } from '../../../skills/audio';
import { foldCents } from '../../../skills/score';
import { makeSkillsRng, noteEvents, singleNoteTargets } from '../../../skills/theory';
import type { LiveReading, MatchPlan, MatchSession, SkillScreenProps } from '../../../skills/types';
import { a4For, accuracyOf, centsText, centsWords, meanAbs, meanOf, noteName, rangeFor, seconds, sessionBase, toleranceFor, TOO_QUIET_TEXT, useFlushOnHide, centsCount } from './common';
import { useSingDeps, type SingDeps } from './deps';
import { outcomeError, useSkillKeys, useTake } from './useTake';
import { ErrorNotice, HeadphonesQuestion, LiveRegion, LiveTrace, PitchNeedle, ScreenHead, Stat, StrictnessLine, TakeStatus, useAnnounceFocus } from './widgets';

export type MatchNoteScreenProps = SkillScreenProps<MatchSession> & { plan?: MatchPlan; deps?: Partial<SingDeps> };

type Attempt = MatchSession['attempts'][number];

export function MatchNoteScreen(props: MatchNoteScreenProps) {
  const deps = useSingDeps(props.deps);
  const take = useTake(deps);
  const kind = deps.platform();
  const desktop = isDesktopKind(kind);
  const { voiceType } = props.settings;
  const { rangeOverride } = props.prefs;
  const range = useMemo(() => rangeFor(voiceType, rangeOverride), [voiceType, rangeOverride]);
  const tolerance = toleranceFor(props);
  const a4Hz = a4For(props);
  const count = Math.max(1, Math.min(20, Math.round(props.plan?.count ?? 6)));
  const rngRef = useRef(makeSkillsRng(props.seed));
  const [targets] = useState(() => singleNoteTargets(range, count, rngRef.current));
  const [index, setIndex] = useState(0);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [current, setCurrent] = useState<Attempt | null>(null);
  const [quiet, setQuiet] = useState(false);
  const [lockState, setLockState] = useState<{ centsNow: number | null; heldSec: number; locked: boolean }>({ centsNow: null, heldSec: 0, locked: false });
  const [drone, setDrone] = useState(false);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [finished, setFinished] = useState(false);
  const startedMs = useRef(deps.nowMs());
  const reported = useRef(0);
  const headingRef = useAnnounceFocus(current ?? (finished ? 'done' : null));
  const target = targets[index];
  const busy = take.phase !== 'idle';
  const headphones = props.prefs.headphones;
  const droneOn = drone && headphones === true;

  // Saves the attempts not saved yet as one session (Finish, Back, leaving the screen, or the page being hidden/closed).
  const report = (list: Attempt[]) => {
    const fresh = list.slice(reported.current);
    if (fresh.length === 0) return;
    reported.current = list.length;
    props.onDone({ ...sessionBase(props, deps, startedMs.current), kind: 'match', drone: droneOn, attempts: fresh });
    startedMs.current = deps.nowMs();
  };

  const sing = async () => {
    if (!target || busy) return;
    setError(null);
    setCurrent(null);
    setQuiet(false);
    const lock = deps.createLockTracker(target.midi, tolerance);
    setLockState({ centsNow: null, heldSec: 0, locked: false });
    const got: { lockSec: number | null } = { lockSec: null };
    const out = await take.run({
      events: noteEvents(target.midi),
      rule: AUTO_STOP_RULES.match(),
      a4Hz,
      shouldStop: (r: LiveReading) => {
        const s = lock.push(r);
        setLockState({ centsNow: s.centsNow, heldSec: s.heldSec, locked: s.locked });
        if (s.locked) {
          got.lockSec = s.lockSec;
          return 'auto-held';
        }
        return null;
      },
      duringCapture: droneOn
        ? () => {
            const d = deps.startDrone(target.midi, a4Hz);
            return () => d.stop();
          }
        : undefined,
      score: (t) => deps.scoreHeldNote(t.samples, t.sampleRate, target.midi, { a4Hz, toleranceCents: tolerance, range }),
    });
    if (out.kind !== 'scored') {
      setError(outcomeError(out));
      return;
    }
    const held = out.value;
    if (held.status === 'too-quiet' && got.lockSec === null) {
      setQuiet(true);
      setAnnounce('Too quiet to score.');
      return;
    }
    const a: Attempt = {
      targetMidi: target.midi,
      register: target.register,
      locked: got.lockSec !== null,
      lockSec: got.lockSec,
      // A rough reading (too short or unsteady to measure reliably) is not reported as a number.
      heldCents: held.status === 'ok' && held.sung?.confidence !== 'low' ? held.heldCents : null,
    };
    setCurrent(a);
    const nextList = [...attempts, a];
    setAttempts(nextList);
    setAnnounce(a.locked ? `Locked in after ${seconds(a.lockSec)}.` : `Not locked in this time${a.heldCents !== null ? `; you were mostly ${centsWords(a.heldCents)}` : ''}.`);
  };

  const next = () => {
    if (busy) return;
    setCurrent(null);
    setQuiet(false);
    setError(null);
    if (index + 1 >= targets.length) {
      setFinished(true);
      report(attempts);
      setAnnounce(`All ${targets.length} notes done.`);
    } else setIndex(index + 1);
  };

  const replay = () => {
    if (!target || busy) return;
    void take.play(noteEvents(target.midi), a4Hz);
  };

  const exit = () => {
    take.cancel();
    report(attempts);
    props.onExit();
  };

  const latest = useRef(attempts);
  latest.current = attempts;
  const reportRef = useRef(report);
  reportRef.current = report;
  useEffect(() => () => reportRef.current(latest.current), []);
  useFlushOnHide(() => reportRef.current(latest.current), props.plan !== undefined);

  useSkillKeys({
    onReturn: () => {
      if (take.phase === 'listening') take.stop('key');
      else if (busy || finished) return;
      else if (current) next();
      else void sing();
    },
    onSpace: () => {
      if (take.phase === 'listening') take.stop('key');
      else if (!finished) replay();
    },
  });

  const lockedCount = attempts.filter((a) => a.locked).length;

  return (
    <section className="sing-screen" aria-label="Match the note">
      <ScreenHead
        title="Match the note"
        eyebrow="Note accuracy"
        embedded={props.embedded}
        onExit={exit}
        lede="Hear a note, then find it with your voice. The needle shows how far you are; hold it inside the green band for 1.5 seconds to lock in."
      />
      <LiveRegion text={announce} />
      <ErrorNotice error={error} />
      {!finished && target && (
        <div className="sing-card sing-item">
          <StrictnessLine strictness={props.prefs.strictness} toleranceCents={tolerance} />
          <p className="sing-progress">
            Note {index + 1} of {targets.length}
          </p>
          <p className="sing-big">{noteName(target.midi)}</p>
          <TakeStatus phase={take.phase} kind={kind} elapsedSec={take.elapsedSec} onStop={() => take.stop('button')} hint="Slide slowly towards the band, then hold it." />
          {take.phase === 'listening' && (
            <>
              <PitchNeedle centsNow={lockState.centsNow ?? (take.live?.midi != null ? foldCents((take.live.midi - target.midi) * 100) : null)} toleranceCents={tolerance} />
              <div className="sing-hold" aria-hidden="true">
                <span className="sing-hold-fill" style={{ width: `${Math.min(100, (lockState.heldSec / 1.5) * 100)}%` }} />
              </div>
              <LiveTrace trace={take.trace} targets={[target.midi]} toleranceCents={tolerance} />
            </>
          )}
          {quiet && take.phase === 'idle' && <p>{TOO_QUIET_TEXT}</p>}
          {current && take.phase === 'idle' && (
            <div className="sing-result">
              <h2 className="sing-result-title" tabIndex={-1} ref={headingRef}>
                {current.locked ? `Locked in after ${seconds(current.lockSec)}` : 'Not locked in this time'}
              </h2>
              <dl className="sing-stats">
                <Stat label="Where you settled" value={centsText(current.heldCents)} tone={accuracyOf(current.heldCents, tolerance)} note={current.heldCents !== null ? centsWords(current.heldCents) : undefined} />
                {current.locked && <Stat label="Time to lock in" value={seconds(current.lockSec)} note="from your first sound" />}
              </dl>
              {!current.locked && <p className="muted">That is useful practice too. Listen again, hum it quietly first, then slide into the band and hold still.</p>}
            </div>
          )}
          {take.phase === 'idle' && (
            <div className="button-row">
              {current ? (
                <button type="button" className="button button--accent" onClick={next}>
                  {index + 1 >= targets.length ? 'Finish' : 'Next note'}
                  {desktop ? ' (Return)' : ''}
                </button>
              ) : (
                <button type="button" className="button button--accent" onClick={() => void sing()}>
                  {quiet || error ? 'Try again' : 'Play and sing'}
                  {desktop ? ' (Return)' : ''}
                </button>
              )}
              {current && (
                <button type="button" className="button" onClick={() => void sing()}>
                  Try this note again
                </button>
              )}
              <button type="button" className="button button--ghost" onClick={replay}>
                Hear it again{desktop ? ' (Space)' : ''}
              </button>
            </div>
          )}
          <details className="sing-options">
            <summary>Drone (headphones only)</summary>
            <HeadphonesQuestion answer={headphones} kind={kind} onAnswer={(v) => props.onPrefs?.({ headphones: v })} />
            <label className={`sing-check${headphones === true ? '' : ' sing-check--disabled'}`}>
              <input type="checkbox" checked={droneOn} disabled={headphones !== true || busy} onChange={(e) => setDrone(e.target.checked)} /> Hold the note underneath me while I sing
            </label>
          </details>
        </div>
      )}
      {finished && (
        <div className="sing-card sing-summary">
          <h2 className="sing-result-title" tabIndex={-1} ref={headingRef}>
            {lockedCount} of {attempts.length} {attempts.length === 1 ? 'note' : 'notes'} locked in
          </h2>
          <dl className="sing-stats">
            <Stat label="Average time to lock in" value={seconds(meanOf(attempts.filter((a) => a.locked).map((a) => a.lockSec)))} />
            <Stat label="Average distance where you settled" value={(() => {
              const m = meanAbs(attempts.map((a) => a.heldCents));
              return m !== null ? `${centsCount(m)}` : '–';
            })()} />
          </dl>
          <div className="button-row">
            <button type="button" className="button button--accent" onClick={props.onExit}>
              {props.embedded ? 'Continue' : 'Back to Skills'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
