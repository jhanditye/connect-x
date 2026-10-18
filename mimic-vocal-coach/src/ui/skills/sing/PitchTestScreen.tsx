// "How accurate is my pitch?": ten single notes over the comfortable range (low, middle and high thirds). Each note
// plays on the piano, then the singer sings and holds it; capture ends by itself once a steady note has been held
// 1.5 s (or at 5 s). Per note: landing, held error, steadiness, time to land and octave; then a summary with the
// bias, the share in tune and the findings.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { isDesktopKind } from '../../../pwa/platform';
import { AUTO_STOP_RULES } from '../../../skills/audio';
import { centsMeaning, foldCents } from '../../../skills/score';
import { makeSkillsRng, noteEvents, singleNoteTargets } from '../../../skills/theory';
import {
  WIDE_BAND_CENTS,
  type HeldNoteScore,
  type PitchTestNoteLite,
  type PitchTestPlan,
  type PitchTestSession,
  type PitchTestSummary,
  type RegisterThird,
  type SkillScreenProps,
} from '../../../skills/types';
import { useSingDeps, type SingDeps } from './deps';
import { a4For, accuracyOf, centsText, centsWords, NO_PITCH_TEXT, noteName, percent, rangeFor, seconds, sessionBase, toleranceFor, TOO_QUIET_TEXT } from './common';
import { outcomeError, useSkillKeys, useTake } from './useTake';
import { ACCURACY_CLASS, ErrorNotice, FindingList, LiveRegion, LiveTrace, PitchNeedle, ScreenHead, Stat, StrictnessLine, TakeStatus, useAnnounceFocus } from './widgets';

export type PitchTestScreenProps = SkillScreenProps<PitchTestSession> & { plan?: PitchTestPlan; deps?: Partial<SingDeps> };

const REGISTER_WORDS: Record<RegisterThird, string> = { low: 'Low', mid: 'Middle', high: 'High' };

export function noteLite(s: HeldNoteScore): PitchTestNoteLite {
  return {
    targetMidi: s.targetMidi,
    register: s.register,
    status: s.status,
    heldCents: s.heldCents,
    landingCents: s.landingCents,
    stabilityCents: s.stabilityCents,
    timeToLandSec: s.timeToLandSec,
    octaveOffset: s.octaveOffset,
  };
}

/** One line for the live region / the per-note card. */
export function heldNoteLine(s: HeldNoteScore, tolerance: number): string {
  if (s.status === 'too-quiet') return 'Too quiet to score.';
  if (s.status === 'no-pitch') return 'No steady note found.';
  const octave = s.octaveOffset !== 0 ? ` Right note, ${Math.abs(s.octaveOffset) === 1 ? 'one octave' : `${Math.abs(s.octaveOffset)} octaves`} ${s.octaveOffset < 0 ? 'lower' : 'higher'}: that counts.` : '';
  const band = s.heldCents !== null && Math.abs(s.heldCents) <= tolerance ? 'inside the band' : 'outside the band';
  return `Held ${centsWords(s.heldCents)}, ${band}.${octave}`;
}

export function PitchTestScreen(props: PitchTestScreenProps) {
  const deps = useSingDeps(props.deps);
  const take = useTake(deps);
  const kind = deps.platform();
  const { voiceType } = props.settings;
  const { rangeOverride } = props.prefs;
  const range = useMemo(() => rangeFor(voiceType, rangeOverride), [voiceType, rangeOverride]);
  const tolerance = toleranceFor(props);
  const a4Hz = a4For(props);
  const count = Math.max(1, Math.min(20, Math.round(props.plan?.count ?? 10)));
  const rngRef = useRef(makeSkillsRng(props.seed));
  const [targets, setTargets] = useState(() => singleNoteTargets(range, count, rngRef.current));
  const [stage, setStage] = useState<'intro' | 'item' | 'summary'>('intro');
  const [index, setIndex] = useState(0);
  const [scores, setScores] = useState<(HeldNoteScore | null)[]>([]);
  const [current, setCurrent] = useState<HeldNoteScore | null>(null);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [summary, setSummary] = useState<PitchTestSummary | null>(null);
  const startedMs = useRef(deps.nowMs());
  const reported = useRef(false);
  const resultRef = useAnnounceFocus(current ?? summary);

  const target = targets[index];
  const busy = take.phase !== 'idle';
  const scored = scores.filter((s): s is HeldNoteScore => s !== null && s.status === 'ok');

  const finish = (all: (HeldNoteScore | null)[]) => {
    const list = all.filter((s): s is HeldNoteScore => s !== null);
    const sum = deps.summarisePitchTest(list, tolerance);
    setSummary(sum);
    setStage('summary');
    setAnnounce(sum.meanAbsCents !== null ? `Test finished. On average you were ${Math.round(sum.meanAbsCents)} cents from the note; ${percent(sum.shareWithin)} inside the band.` : 'Test finished, but no note could be scored.');
    if (!reported.current && list.some((s) => s.status === 'ok')) {
      reported.current = true;
      const { findings: _f, ...rest } = sum;
      void _f;
      props.onDone({ ...sessionBase(props, deps, startedMs.current), kind: 'pitch-test', notes: list.map(noteLite), summary: rest });
    }
  };

  const sing = async () => {
    if (!target || busy) return;
    setError(null);
    setCurrent(null);
    setStage('item');
    const out = await take.run({
      events: noteEvents(target.midi),
      rule: AUTO_STOP_RULES.pitchTest(),
      a4Hz,
      score: (t) => deps.scoreHeldNote(t.samples, t.sampleRate, target.midi, { a4Hz, toleranceCents: tolerance, range }),
    });
    if (out.kind !== 'scored') {
      setError(outcomeError(out));
      return;
    }
    const s = out.value;
    setCurrent(s);
    setAnnounce(`Note ${index + 1}: ${heldNoteLine(s, tolerance)}`);
    if (s.status === 'ok') {
      const next = scores.slice();
      next[index] = s;
      setScores(next);
    }
  };

  const next = () => {
    if (busy) return;
    const all = scores.slice();
    if (current && current.status !== 'ok') all[index] = current; // keep the unscored note in the record
    setScores(all);
    setCurrent(null);
    setError(null);
    if (index + 1 >= targets.length) finish(all);
    else setIndex(index + 1);
  };

  const replay = () => {
    if (!target || busy) return;
    void take.play(noteEvents(target.midi), a4Hz);
  };

  const restart = () => {
    take.cancel();
    setTargets(singleNoteTargets(range, count, rngRef.current));
    setScores([]);
    setCurrent(null);
    setSummary(null);
    setIndex(0);
    setError(null);
    setStage('intro');
    startedMs.current = deps.nowMs();
    reported.current = false;
  };

  const exit = () => {
    take.cancel();
    if (!reported.current && scored.length > 0) finish(scores);
    props.onExit();
  };

  // Report a partly finished test once if the screen goes away with scored notes.
  const latest = useRef({ scores, finish });
  latest.current = { scores, finish };
  useEffect(
    () => () => {
      const { scores: s, finish: f } = latest.current;
      if (!reported.current && s.some((x) => x?.status === 'ok')) f(s);
    },
    [],
  );

  useSkillKeys({
    onReturn: () => {
      if (take.phase === 'listening') take.stop('key');
      else if (busy) return;
      else if (stage === 'intro') void sing();
      else if (stage === 'item') {
        if (current && current.status === 'ok') next();
        else void sing();
      } else if (stage === 'summary') restart();
    },
    onSpace: () => {
      if (take.phase === 'listening') take.stop('key');
      else if (stage === 'item') replay();
    },
  });

  const desktop = isDesktopKind(kind);
  const live = take.live?.midi != null && target ? foldCents((take.live.midi - target.midi) * 100) : null;

  return (
    <section className="sing-screen" aria-labelledby="pitch-test-title">
      <ScreenHead
        title="How accurate is my pitch?"
        eyebrow="Note accuracy"
        embedded={props.embedded}
        onExit={exit}
        lede={`You will hear ${count} notes, one at a time, spread over your comfortable range. Sing each one back on "ah" and hold it for about two seconds: the app stops listening by itself.`}
      />
      <span id="pitch-test-title" className="visually-hidden">
        Pitch accuracy test
      </span>
      <LiveRegion text={announce} />
      <ErrorNotice error={error} />

      {stage === 'intro' && (
        <div className="sing-card">
          <StrictnessLine strictness={props.prefs.strictness} toleranceCents={tolerance} />
          <p className="muted">
            Your range for this test: {noteName(range.lowMidi)} to {noteName(range.highMidi)}. Use headphones or keep the volume moderate. The microphone only
            opens after each note has finished playing.
          </p>
          <div className="button-row">
            <button type="button" className="button button--accent" onClick={() => void sing()} disabled={busy}>
              Start the test{desktop ? ' (Return)' : ''}
            </button>
          </div>
        </div>
      )}

      {stage === 'item' && target && (
        <div className="sing-card sing-item">
          <p className="sing-progress">
            Note {index + 1} of {targets.length} · {REGISTER_WORDS[target.register]} part of your range
          </p>
          <p className="sing-big" aria-label={`Target note ${noteName(target.midi)}`}>
            {noteName(target.midi)}
          </p>
          <TakeStatus phase={take.phase} kind={kind} elapsedSec={take.elapsedSec} onStop={() => take.stop('button')} hint="Hold the note steady; it stops by itself." noAudioText={take.noAudio ? 'No sound is reaching the app yet.' : null} />
          {take.phase === 'listening' && (
            <>
              <PitchNeedle centsNow={live} toleranceCents={tolerance} />
              <LiveTrace trace={take.trace} targets={[target.midi]} toleranceCents={tolerance} />
            </>
          )}
          {current && take.phase === 'idle' && (
            <div className="sing-result" aria-live="off">
              <h2 className="sing-result-title" tabIndex={-1} ref={resultRef}>
                Note {index + 1}: {current.status === 'ok' ? centsText(current.heldCents) : 'not scored'}
              </h2>
              {current.status === 'ok' ? (
                <>
                  <dl className="sing-stats">
                    <Stat label="Held" value={centsText(current.heldCents)} note={current.heldCents !== null ? centsMeaning(current.heldCents) : undefined} tone={accuracyOf(current.heldCents, tolerance)} />
                    <Stat label="Landing" value={centsText(current.landingCents)} note="the first moment of the note" />
                    <Stat label="Steadiness" value={current.stabilityCents !== null ? `±${Math.round(current.stabilityCents)} cents` : '–'} note="wobble, not counting vibrato" />
                    <Stat label="Time to land" value={current.timeToLandSec !== null ? seconds(current.timeToLandSec) : 'did not settle in the band'} />
                  </dl>
                  {current.octaveOffset !== 0 && (
                    <p className="sing-info">Right note, different octave: you sang it {Math.abs(current.octaveOffset) === 1 ? 'an octave' : `${Math.abs(current.octaveOffset)} octaves`} {current.octaveOffset < 0 ? 'lower' : 'higher'}. That is fine; the note name is what is judged.</p>
                  )}
                  <FindingList findings={current.findings} />
                </>
              ) : (
                <p>{current.status === 'too-quiet' ? TOO_QUIET_TEXT : NO_PITCH_TEXT}</p>
              )}
            </div>
          )}
          {take.phase === 'idle' && (
            <div className="button-row">
              {current && current.status === 'ok' ? (
                <>
                  <button type="button" className="button button--accent" onClick={next}>
                    {index + 1 >= targets.length ? 'See my results' : 'Next note'}
                    {desktop ? ' (Return)' : ''}
                  </button>
                  <button type="button" className="button" onClick={() => void sing()}>
                    Sing it again
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="button button--accent" onClick={() => void sing()}>
                    {current || error ? 'Try again' : 'Play and sing'}
                    {desktop ? ' (Return)' : ''}
                  </button>
                  {current && (
                    <button type="button" className="button" onClick={next}>
                      Skip this note
                    </button>
                  )}
                </>
              )}
              <button type="button" className="button button--ghost" onClick={replay}>
                Hear it again{desktop ? ' (Space)' : ''}
              </button>
              {scored.length > 0 && (
                <button type="button" className="button button--ghost" onClick={() => finish(scores)}>
                  Finish now
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {stage === 'summary' && summary && <PitchTestSummaryView summary={summary} scores={scores} tolerance={tolerance} headingRef={resultRef} onRestart={restart} onExit={exit} embedded={props.embedded} desktop={desktop} />}
    </section>
  );
}

function PitchTestSummaryView(props: {
  summary: PitchTestSummary;
  scores: readonly (HeldNoteScore | null)[];
  tolerance: number;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onRestart(): void;
  onExit(): void;
  embedded?: boolean;
  desktop: boolean;
}) {
  const s = props.summary;
  return (
    <div className="sing-card sing-summary">
      <h2 className="sing-result-title" tabIndex={-1} ref={props.headingRef}>
        Your results
      </h2>
      {s.scored === 0 ? (
        <p>No note could be scored this time. Check the microphone and try again a little louder.</p>
      ) : (
        <>
          <dl className="sing-stats">
            <Stat label="Average distance from the note" value={s.meanAbsCents !== null ? `${Math.round(s.meanAbsCents)} cents` : '–'} note={s.meanAbsCents !== null ? centsMeaning(s.meanAbsCents) : undefined} tone={accuracyOf(s.meanAbsCents, props.tolerance)} />
            <Stat label={`Inside ±${props.tolerance} cents`} value={percent(s.shareWithin)} note={`${percent(s.shareWithin50)} inside ±${WIDE_BAND_CENTS} cents`} />
            <Stat label="Tendency" value={s.biasCents !== null ? centsWords(s.biasCents) : '–'} note="on average, sharp (+) or flat (−)" />
            <Stat label="Steadiness" value={s.meanStabilityCents !== null ? `±${Math.round(s.meanStabilityCents)} cents` : '–'} note={s.meanTimeToLandSec !== null ? `settled in ${seconds(s.meanTimeToLandSec)} on average` : undefined} />
          </dl>
          <FindingList findings={s.findings} />
          <h3 className="subhead">By part of your range</h3>
          <table className="sing-table">
            <thead>
              <tr>
                <th scope="col">Part</th>
                <th scope="col">Notes</th>
                <th scope="col">Average distance</th>
                <th scope="col">Tendency</th>
                <th scope="col">In the band</th>
              </tr>
            </thead>
            <tbody>
              {(['low', 'mid', 'high'] as RegisterThird[]).map((r) => {
                const row = s.byRegister[r];
                return (
                  <tr key={r}>
                    <th scope="row">{REGISTER_WORDS[r]}</th>
                    <td>{row.n}</td>
                    <td>{row.meanAbsCents !== null ? `${Math.round(row.meanAbsCents)} cents` : '–'}</td>
                    <td>{row.biasCents !== null ? centsWords(row.biasCents) : '–'}</td>
                    <td>{percent(row.shareWithin)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <h3 className="subhead">Every note</h3>
          <div className="sing-table-wrap">
            <table className="sing-table">
              <thead>
                <tr>
                  <th scope="col">Note</th>
                  <th scope="col">Held</th>
                  <th scope="col">Landing</th>
                  <th scope="col">Steadiness</th>
                  <th scope="col">Time to land</th>
                </tr>
              </thead>
              <tbody>
                {props.scores.map((n, i) =>
                  n ? (
                    <tr key={i}>
                      <th scope="row">
                        {noteName(n.targetMidi)}
                        {n.octaveOffset !== 0 ? ' (other octave)' : ''}
                      </th>
                      {n.status === 'ok' ? (
                        <>
                          <td className={ACCURACY_CLASS[accuracyOf(n.heldCents, props.tolerance)]}>{centsText(n.heldCents)}</td>
                          <td>{centsText(n.landingCents)}</td>
                          <td>{n.stabilityCents !== null ? `±${Math.round(n.stabilityCents)}` : '–'}</td>
                          <td>{seconds(n.timeToLandSec)}</td>
                        </>
                      ) : (
                        <td colSpan={4}>not scored ({n.status === 'too-quiet' ? 'too quiet' : 'no steady note'})</td>
                      )}
                    </tr>
                  ) : null,
                )}
              </tbody>
            </table>
          </div>
          {s.unscored > 0 && <p className="muted">{s.unscored === 1 ? 'One note was' : `${s.unscored} notes were`} not scored and are left out of the averages.</p>}
          {s.octaveSlips > 0 && <p className="muted">You sang {s.octaveSlips === 1 ? 'one note' : `${s.octaveSlips} notes`} in another octave. That is fine: the note name is what counts.</p>}
        </>
      )}
      <div className="button-row">
        <button type="button" className="button button--accent" onClick={props.onRestart}>
          Take the test again{props.desktop ? ' (Return)' : ''}
        </button>
        {!props.embedded && (
          <button type="button" className="button" onClick={props.onExit}>
            Back to Skills
          </button>
        )}
        {props.embedded && (
          <button type="button" className="button" onClick={props.onExit}>
            Continue
          </button>
        )}
      </div>
    </div>
  );
}
