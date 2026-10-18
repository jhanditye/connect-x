// "Sing intervals": the reference note plays and the screen says "Sing the note, then a major 6th up"; the singer
// sings both in one take. Scored separately: the first note against the reference, the INTERVAL SIZE (the core
// skill, independent of where you started) and the second note against the absolute target. "Listen and repeat"
// plays both notes first.

import { useEffect, useMemo, useRef, useState } from 'react';
import { isDesktopKind } from '../../../pwa/platform';
import { AUTO_STOP_RULES } from '../../../skills/audio';
import { intervalSetWeakness } from '../../../skills/progress';
import { centsMeaning } from '../../../skills/score';
import {
  cleanIntervalSet,
  earSetForLevel,
  INTERVAL_SONG_HINTS,
  intervalEvents,
  intervalName,
  intervalPhrase,
  intervalTargetOf,
  makeSkillsRng,
  noteEvents,
  singIntervalTarget,
} from '../../../skills/theory';
import type { IntervalTarget, SingIntervalsPlan, SingIntervalsSession, SkillScreenProps, SungDirection, SungIntervalScore } from '../../../skills/types';
import { a4For, accuracyOf, centsText, centsWords, meanAbs, NO_PITCH_TEXT, noteName, rangeFor, sessionBase, toleranceFor, TOO_QUIET_TEXT } from './common';
import { useSingDeps, type SingDeps } from './deps';
import { outcomeError, useSkillKeys, useTake } from './useTake';
import { ACCURACY_CLASS, ErrorNotice, FindingList, LiveRegion, LiveTrace, ScreenHead, Stat, StrictnessLine, TakeStatus, useAnnounceFocus } from './widgets';

export type SingIntervalsScreenProps = SkillScreenProps<SingIntervalsSession> & { plan?: SingIntervalsPlan; deps?: Partial<SingDeps> };

type Item = SingIntervalsSession['items'][number];

/** The intervals to sing: the custom set, or the ear level's set; unisons are dropped. */
export function singSet(prefs: SkillScreenProps['prefs']): number[] {
  const set = prefs.earSetMode === 'custom' && prefs.earCustom.length > 0 ? cleanIntervalSet(prefs.earCustom) : earSetForLevel(prefs.earLevel);
  const out = set.filter((s) => s > 0 && s <= 12);
  return out.length > 0 ? out : [5, 7, 12, 4];
}

export function singDirections(prefs: SkillScreenProps['prefs']): SungDirection[] {
  const d = prefs.earDirections.filter((x): x is SungDirection => x === 'up' || x === 'down');
  return d.length > 0 ? d : ['up', 'down'];
}

/** "Sing the note, then a major 6th up". */
export function intervalInstruction(t: IntervalTarget, mode: 'read' | 'listen'): string {
  if (mode === 'listen') return `Listen to both notes (${intervalPhrase(t.semitones, t.direction)}), then sing them back`;
  return `Sing the note, then ${intervalPhrase(t.semitones, t.direction)}`;
}

export function intervalResultLine(s: SungIntervalScore, tolerance: number): string {
  if (s.status === 'too-quiet') return 'Too quiet to score.';
  if (s.status === 'no-pitch' || s.intervalCents === null) return 'Two clear notes were not found.';
  if (s.wrongDirection) return `The second note went the other way (${s.target.direction === 'up' ? 'down instead of up' : 'up instead of down'}).`;
  const size = Math.abs(s.intervalCents) <= tolerance ? 'the right size' : `${Math.round(Math.abs(s.intervalCents))} cents too ${s.intervalCents > 0 ? 'wide' : 'narrow'}`;
  return `Interval ${size}.`;
}

export function SingIntervalsScreen(props: SingIntervalsScreenProps) {
  const deps = useSingDeps(props.deps);
  const take = useTake(deps);
  const kind = deps.platform();
  const desktop = isDesktopKind(kind);
  const { voiceType } = props.settings;
  const { rangeOverride } = props.prefs;
  const range = useMemo(() => rangeFor(voiceType, rangeOverride), [voiceType, rangeOverride]);
  const tolerance = toleranceFor(props);
  const a4Hz = a4For(props);
  const count = Math.max(1, Math.min(30, Math.round(props.plan?.count ?? 8)));
  const [mode, setMode] = useState<'read' | 'listen'>(props.plan?.mode ?? 'read');
  const rngRef = useRef(makeSkillsRng(props.seed));
  const set = useMemo(() => singSet(props.prefs), [props.prefs]);
  const dirs = useMemo(() => singDirections(props.prefs), [props.prefs]);
  const pickTarget = () => {
    const weights = set.map((s) => 0.15 + intervalSetWeakness(props.stats, s, dirs, 'sing'));
    return singIntervalTarget(rngRef.current, set, range, { directions: dirs, weights });
  };
  const [target, setTarget] = useState<IntervalTarget>(pickTarget);
  const [items, setItems] = useState<Item[]>([]);
  const [current, setCurrent] = useState<SungIntervalScore | null>(null);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [finished, setFinished] = useState(false);
  const startedMs = useRef(deps.nowMs());
  const reported = useRef(false);
  const headingRef = useAnnounceFocus(current ?? (finished ? 'done' : null));
  const busy = take.phase !== 'idle';
  const second = intervalTargetOf(target);
  const scoredItems = items.filter((i) => i.status === 'ok');

  const report = (list: Item[]) => {
    if (reported.current || !list.some((i) => i.status === 'ok')) return;
    reported.current = true;
    props.onDone({
      ...sessionBase(props, deps, startedMs.current),
      kind: 'sing-intervals',
      items: list,
      meanAbsIntervalCents: meanAbs(list.map((i) => i.intervalCents)),
    });
  };

  const promptEvents = () => (mode === 'listen' ? intervalEvents(target.referenceMidi, target.semitones, target.direction) : noteEvents(target.referenceMidi));

  const sing = async () => {
    if (busy) return;
    setError(null);
    setCurrent(null);
    const out = await take.run({
      events: promptEvents(),
      rule: AUTO_STOP_RULES.interval(),
      a4Hz,
      score: (t) => deps.scoreSungInterval(t.samples, t.sampleRate, target, { a4Hz, toleranceCents: tolerance }),
    });
    if (out.kind !== 'scored') {
      setError(outcomeError(out));
      return;
    }
    const s = out.value;
    setCurrent(s);
    setAnnounce(intervalResultLine(s, tolerance));
    if (s.status === 'ok') {
      setItems((prev) => [
        ...prev,
        {
          mode,
          semitones: target.semitones,
          direction: target.direction,
          referenceMidi: target.referenceMidi,
          status: s.status,
          referenceCents: s.referenceCents,
          intervalCents: s.intervalCents,
          targetCents: s.targetCents,
        },
      ]);
    }
  };

  const next = () => {
    if (busy) return;
    setCurrent(null);
    setError(null);
    const done = scoredItems.length >= count;
    if (done) {
      setFinished(true);
      report(items);
      return;
    }
    setTarget(pickTarget());
  };

  const replay = () => {
    if (busy) return;
    void take.play(promptEvents(), a4Hz);
  };

  const exit = () => {
    take.cancel();
    report(items);
    props.onExit();
  };

  const latest = useRef({ items, report });
  latest.current = { items, report };
  useEffect(() => () => latest.current.report(latest.current.items), []);

  useSkillKeys({
    onReturn: () => {
      if (take.phase === 'listening') take.stop('key');
      else if (busy || finished) return;
      else if (current && current.status === 'ok') next();
      else void sing();
    },
    onSpace: () => {
      if (take.phase === 'listening') take.stop('key');
      else if (!finished) replay();
    },
  });

  const hint = target.direction === 'up' ? INTERVAL_SONG_HINTS[target.semitones] : undefined;

  return (
    <section className="sing-screen" aria-label="Sing intervals">
      <ScreenHead
        title="Sing intervals"
        eyebrow="Intervals"
        embedded={props.embedded}
        onExit={exit}
        lede="Sing two notes in one go. The size of the jump is what matters most: it is measured from the note you actually started on, so a slightly off first note does not spoil it."
      />
      <LiveRegion text={announce} />
      <ErrorNotice error={error} />
      {!finished && (
        <div className="sing-card sing-item">
          {!props.plan && (
            <fieldset className="segmented">
              <legend className="field-label">How</legend>
              <div className="segmented-options">
                <label className="segmented-option">
                  <input type="radio" name="sing-int-mode" checked={mode === 'read'} disabled={busy} onChange={() => setMode('read')} />
                  <span>Read and sing</span>
                </label>
                <label className="segmented-option">
                  <input type="radio" name="sing-int-mode" checked={mode === 'listen'} disabled={busy} onChange={() => setMode('listen')} />
                  <span>Listen and repeat</span>
                </label>
              </div>
            </fieldset>
          )}
          <StrictnessLine strictness={props.prefs.strictness} toleranceCents={tolerance} />
          <p className="sing-progress">
            {scoredItems.length} of {count} done
          </p>
          <p className="sing-instruction">{intervalInstruction(target, mode)}</p>
          <p className="sing-big sing-big--pair" aria-label={`From ${noteName(target.referenceMidi)} to ${noteName(second)}`}>
            {noteName(target.referenceMidi)} <span aria-hidden="true">{target.direction === 'up' ? '↗' : '↘'}</span> <span className="sing-big-faint">{mode === 'listen' || current ? noteName(second) : '?'}</span>
          </p>
          {hint && mode === 'read' && <p className="muted">Hint: {intervalName(target.semitones)} up starts {hint}.</p>}
          <TakeStatus phase={take.phase} kind={kind} elapsedSec={take.elapsedSec} onStop={() => take.stop('button')} hint="Sing the first note, then the second. It stops after a short silence." />
          {take.phase === 'listening' && <LiveTrace trace={take.trace} targets={[target.referenceMidi, second]} toleranceCents={tolerance} />}
          {current && take.phase === 'idle' && (
            <div className="sing-result">
              <h2 className="sing-result-title" tabIndex={-1} ref={headingRef}>
                {intervalResultLine(current, tolerance)}
              </h2>
              {current.status === 'ok' ? (
                <>
                  <dl className="sing-stats">
                    <Stat
                      label={`Interval size (${intervalName(target.semitones)})`}
                      value={current.intervalCents !== null ? `${centsText(current.intervalCents)}` : '–'}
                      note={current.intervalCents !== null ? `${current.intervalCents > 0 ? 'too wide' : current.intervalCents < 0 ? 'too narrow' : 'exact'}: ${centsMeaning(current.intervalCents)}` : undefined}
                      tone={accuracyOf(current.intervalCents, tolerance)}
                    />
                    <Stat label="First note" value={centsText(current.referenceCents)} note={`against ${noteName(target.referenceMidi)}: ${centsWords(current.referenceCents)}`} tone={accuracyOf(current.referenceCents, tolerance)} />
                    <Stat label="Second note" value={centsText(current.targetCents)} note={`against ${noteName(second)}: ${centsWords(current.targetCents)}`} tone={accuracyOf(current.targetCents, tolerance)} />
                  </dl>
                  {current.octaveOffset !== 0 && <p className="sing-info">You sang it in another octave. That is fine: the notes are judged by name.</p>}
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
                    {scoredItems.length >= count ? 'See the summary' : 'Next interval'}
                    {desktop ? ' (Return)' : ''}
                  </button>
                  <button type="button" className="button" onClick={() => void sing()}>
                    Sing it again
                  </button>
                </>
              ) : (
                <button type="button" className="button button--accent" onClick={() => void sing()}>
                  {current || error ? 'Try again' : mode === 'listen' ? 'Play both and sing' : 'Play the note and sing'}
                  {desktop ? ' (Return)' : ''}
                </button>
              )}
              <button type="button" className="button button--ghost" onClick={replay}>
                Hear it again{desktop ? ' (Space)' : ''}
              </button>
              {scoredItems.length > 0 && (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => {
                    setFinished(true);
                    report(items);
                  }}
                >
                  Finish now
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {finished && (
        <div className="sing-card sing-summary">
          <h2 className="sing-result-title" tabIndex={-1} ref={headingRef}>
            {scoredItems.length} {scoredItems.length === 1 ? 'interval' : 'intervals'} sung
          </h2>
          <dl className="sing-stats">
            <Stat
              label="Average interval error"
              value={(() => {
                const m = meanAbs(scoredItems.map((i) => i.intervalCents));
                return m !== null ? `${Math.round(m)} cents` : '–';
              })()}
              note="the size of the jump, whatever note you started on"
            />
          </dl>
          <table className="sing-table">
            <thead>
              <tr>
                <th scope="col">Interval</th>
                <th scope="col">Size error</th>
                <th scope="col">First note</th>
                <th scope="col">Second note</th>
              </tr>
            </thead>
            <tbody>
              {scoredItems.map((i, k) => (
                <tr key={k}>
                  <th scope="row">{intervalPhrase(i.semitones, i.direction).replace(/^an? /, '')}</th>
                  <td className={ACCURACY_CLASS[accuracyOf(i.intervalCents, tolerance)]}>{centsText(i.intervalCents)}</td>
                  <td>{centsText(i.referenceCents)}</td>
                  <td>{centsText(i.targetCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
