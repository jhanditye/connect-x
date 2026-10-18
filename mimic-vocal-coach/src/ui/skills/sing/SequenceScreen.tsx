// Scale-degree lines (the singer's own ask: "7 6 5 4 3 2", "2 7 6 5"). A cadence sets the key, then the tonic; the
// screen shows the degrees and the singer sings the whole line in one go, on any syllable, at their own pace.
// "Read and sing" shows the degrees only; "Listen and repeat" plays the line first. Presets, a random line weighted
// to weak degrees, or a line typed in the box (the parser's errors are shown as you type). Results colour each
// degree by accuracy, with interval errors, drift and the octave note.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { isDesktopKind } from '../../../pwa/platform';
import { AUTO_STOP_RULES } from '../../../skills/audio';
import { degreeWeights } from '../../../skills/progress';
import { centsMeaning, countsForTuning } from '../../../skills/score';
import {
  cadenceEvents,
  concatEvents,
  degreeLabelText,
  fitSequence,
  keyName,
  lineEvents,
  lineLabels,
  makeSkillsRng,
  mixedLength,
  parseSequence,
  prettyAccidentals,
  randomLine,
  SCALE_MODE_LABELS,
  SCALE_MODES,
  SEQUENCE_EXAMPLE,
  SEQUENCE_PRESETS,
  sequenceText,
  spellDegreeWithOctave,
  tooWideMessage,
  type Rng,
} from '../../../skills/theory';
import type { LabelMode, ScaleMode, SequencePlan, SequenceScore, SequenceSession, SequenceTarget, SkillScreenProps, VoiceRange } from '../../../skills/types';
import { a4For, centsText, centsWords, NO_PITCH_TEXT, percent, rangeFor, sessionBase, toleranceFor, TOO_QUIET_TEXT, useFlushOnHide, centsCount } from './common';
import { useSingDeps, type SingDeps } from './deps';
import { outcomeError, useSkillKeys, useTake } from './useTake';
import { DegreeStrip, ErrorNotice, FindingList, LiveRegion, LiveTrace, ScreenHead, Stat, StrictnessLine, TakeStatus, useAnnounceFocus } from './widgets';

export type SequenceScreenProps = SkillScreenProps<SequenceSession> & { plan?: SequencePlan; deps?: Partial<SingDeps> };

type Item = SequenceSession['items'][number];

const LABEL_MODES: { value: LabelMode; label: string }[] = [
  { value: 'numbers', label: 'Numbers' },
  { value: 'solfege', label: 'Solfège' },
  { value: 'names', label: 'Note names' },
];

/** A playable line for typed text, or the reason it cannot be sung. */
export function buildLine(text: string, mode: ScaleMode, range: VoiceRange, rng: Rng): { ok: true; target: SequenceTarget } | { ok: false; error: string; at: number | null } {
  const p = parseSequence(text, mode);
  if (!p.ok) return { ok: false, error: p.error, at: p.at };
  const t = fitSequence(p.notes, mode, range, rng, p.normalized);
  if (!t) return { ok: false, error: tooWideMessage(p.notes, range), at: null };
  return { ok: true, target: t };
}

export function sequenceItem(s: SequenceScore, mode: 'read' | 'listen'): Item {
  return {
    mode,
    text: s.target.text,
    scaleMode: s.target.key.mode,
    tonicMidi: s.target.key.tonicMidi,
    status: s.status,
    noteAccuracy: s.noteAccuracy,
    meanAbsCents: s.meanAbsCents,
    meanAbsIntervalCents: s.meanAbsIntervalCents,
    driftCents: s.driftCents,
    octaveOffset: s.octaveOffset,
    // Only tuning errors feed the per-degree profile: wrong notes, octave slips and a line sung in another key do not.
    perNote: s.notes.filter((n) => countsForTuning(n, s)).map((n) => ({ degree: n.degree, cents: n.cents as number })),
    missing: s.missing,
    extras: s.extras.length,
  };
}

export function sequenceResultLine(s: SequenceScore): string {
  if (s.status === 'too-quiet') return 'Too quiet to score.';
  if (s.status === 'no-pitch') return 'No sung notes were found.';
  const inBand = s.notes.filter((n) => n.within).length;
  return `${inBand} of ${s.notes.length} notes in the band.`;
}

export function SequenceScreen(props: SequenceScreenProps) {
  const deps = useSingDeps(props.deps);
  const take = useTake(deps);
  const kind = deps.platform();
  const desktop = isDesktopKind(kind);
  const { voiceType } = props.settings;
  const { rangeOverride } = props.prefs;
  const range = useMemo(() => rangeFor(voiceType, rangeOverride), [voiceType, rangeOverride]);
  const tolerance = toleranceFor(props);
  const a4Hz = a4For(props);
  const rngRef = useRef(makeSkillsRng(props.seed));
  const planTexts = props.plan?.texts && props.plan.texts.length > 0 ? props.plan.texts : null;
  const [scaleMode, setScaleMode] = useState<ScaleMode>(props.prefs.scaleMode);
  const [labelMode, setLabelMode] = useState<LabelMode>(props.prefs.labelMode);
  const [mode, setMode] = useState<'read' | 'listen'>(props.plan?.mode ?? 'read');
  const [planIndex, setPlanIndex] = useState(0);
  const [text, setText] = useState(planTexts ? planTexts[0] : SEQUENCE_EXAMPLE);
  const [target, setTarget] = useState<SequenceTarget | null>(() => {
    const b = buildLine(planTexts ? planTexts[0] : SEQUENCE_EXAMPLE, props.prefs.scaleMode, range, rngRef.current);
    return b.ok ? b.target : null;
  });
  const [lineError, setLineError] = useState<string | null>(null);
  const [score, setScore] = useState<SequenceScore | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [active, setActive] = useState<number | null>(null);
  const [finished, setFinished] = useState(false);
  const startedMs = useRef(deps.nowMs());
  const reported = useRef(0);
  const headingRef = useAnnounceFocus(score ?? (finished ? 'done' : null));
  const busy = take.phase !== 'idle';

  // Live parse of what is typed (errors only; the line changes when the singer presses Use this line).
  const typed = useMemo(() => (text.trim() ? parseSequence(text, scaleMode) : null), [text, scaleMode]);
  const typedError = typed && !typed.ok ? typed : null;

  const labels = useMemo(() => (target ? lineLabels(target.notes, target.key.mode, labelMode, target.key) : []), [target, labelMode]);

  // Saves the takes not saved yet as one session (Finish, Back, leaving the screen, or the page being hidden/closed).
  const report = (list: Item[]) => {
    const fresh = list.slice(reported.current);
    if (!fresh.some((i) => i.status === 'ok')) return;
    reported.current = list.length;
    props.onDone({ ...sessionBase(props, deps, startedMs.current), kind: 'sequence', items: fresh });
    startedMs.current = deps.nowMs();
  };

  const chooseLine = (t: string, m: ScaleMode = scaleMode) => {
    const b = buildLine(t, m, range, rngRef.current);
    setScore(null);
    setError(null);
    if (!b.ok) {
      setLineError(b.error);
      return false;
    }
    setLineError(null);
    setTarget(b.target);
    setText(b.target.text);
    return true;
  };

  const randomPick = () => {
    const rng = rngRef.current;
    const notes = randomLine(rng, mixedLength(rng), scaleMode, { degreeWeights: degreeWeights(props.stats, scaleMode) });
    chooseLine(sequenceText(notes));
  };

  const promptEvents = (t: SequenceTarget) => (mode === 'listen' ? concatEvents(cadenceEvents(t.key), lineEvents(t), 0.5) : cadenceEvents(t.key));

  const itemRef = useRef<HTMLDivElement>(null);
  /** Brings the line, the status, Stop and the trace on screen (on a 780 px Mac window they sit below the chooser). */
  const showItem = () => {
    try {
      itemRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    } catch {
      // jsdom and some embedded browsers do not scroll.
    }
  };

  const sing = async () => {
    if (!target || busy) return;
    const t = target;
    setError(null);
    setScore(null);
    showItem();
    const out = await take.run({
      events: promptEvents(t),
      rule: AUTO_STOP_RULES.sequence(t.midis.length),
      a4Hz,
      onEvent: (e) => setActive(e.role === 'line' && e.index !== undefined ? e.index : null),
      score: (tk) => deps.scoreSequence(tk.samples, tk.sampleRate, t, { a4Hz, toleranceCents: tolerance }),
    });
    setActive(null);
    if (out.kind !== 'scored') {
      setError(outcomeError(out));
      return;
    }
    const s = out.value;
    setScore(s);
    setAnnounce(sequenceResultLine(s));
    if (s.status === 'ok') setItems((prev) => [...prev, sequenceItem(s, mode)]);
  };

  const replay = () => {
    if (!target || busy) return;
    void take.play(promptEvents(target), a4Hz, (e) => setActive(e.role === 'line' && e.index !== undefined ? e.index : null)).then(() => setActive(null));
  };

  const nextPlanned = () => {
    if (!planTexts || busy) return;
    if (planIndex + 1 >= planTexts.length) {
      setFinished(true);
      report(items);
      return;
    }
    const i = planIndex + 1;
    setPlanIndex(i);
    chooseLine(planTexts[i]);
  };

  const newKey = () => {
    if (target) chooseLine(target.text);
  };

  const exit = () => {
    take.cancel();
    report(items);
    props.onExit();
  };

  const latest = useRef({ items, report });
  latest.current = { items, report };
  useEffect(() => () => latest.current.report(latest.current.items), []);
  useFlushOnHide(() => latest.current.report(latest.current.items), planTexts !== null);

  useSkillKeys({
    onReturn: () => {
      if (take.phase === 'listening') take.stop('key');
      else if (busy || finished) return;
      else if (planTexts && score?.status === 'ok') nextPlanned();
      else void sing();
    },
    onSpace: () => {
      if (take.phase === 'listening') take.stop('key');
      else if (!finished) replay();
    },
  });

  const changeScaleMode = (m: ScaleMode) => {
    setScaleMode(m);
    props.onPrefs?.({ scaleMode: m });
    if (target) chooseLine(target.text, m);
  };
  const changeLabelMode = (m: LabelMode) => {
    setLabelMode(m);
    props.onPrefs?.({ labelMode: m });
  };

  const scored = items.filter((i) => i.status === 'ok');

  return (
    <section className="sing-screen" aria-label="Scale-degree lines">
      <ScreenHead
        title="Sing scale-degree lines"
        eyebrow="Note accuracy in a key"
        embedded={props.embedded}
        onExit={exit}
        lede="The chords set the key and then the home note (1) plays. Sing the whole line in one go, on any syllable, at your own pace. Singing it an octave lower or higher is fine."
      />
      <LiveRegion text={announce} />
      <ErrorNotice error={error} />

      {!finished && (
        <div className="sing-card">
          {!planTexts && (
            <div className="sing-chooser">
              <p className="field-label" id="seq-presets-label">
                Pick a line
              </p>
              <div className="sing-presets" role="group" aria-labelledby="seq-presets-label">
                {SEQUENCE_PRESETS.map((p) => (
                  <button key={p.id} type="button" className={`button button--small${target?.text === parseNormalized(p.text, scaleMode) ? ' button--accent' : ''}`} disabled={busy} onClick={() => chooseLine(p.text)}>
                    <span className="sing-preset-text">{p.text}</span>
                    <span className="visually-hidden"> ({p.label})</span>
                  </button>
                ))}
                <button type="button" className="button button--small" disabled={busy} onClick={randomPick}>
                  Mixed (random)
                </button>
              </div>
              <form
                className="sing-type"
                onSubmit={(e) => {
                  e.preventDefault();
                  chooseLine(text);
                }}
              >
                <label className="field-label" htmlFor="seq-text">
                  Or type your own
                </label>
                <div className="input-row">
                  <input
                    id="seq-text"
                    className="text-input"
                    value={text}
                    inputMode="text"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={typedError ? 'true' : 'false'}
                    aria-describedby="seq-text-help seq-text-error"
                    onChange={(e) => setText(e.target.value)}
                    disabled={busy}
                  />
                  <button type="submit" className="button" disabled={busy || !!typedError || !text.trim()}>
                    Use this line
                  </button>
                </div>
                <p className="field-hint" id="seq-text-help">
                  Degrees 1 to 8, with spaces or commas: "7 6 5 4 3 2" or "2 7 6 5". Each number stays between 1 and 8 unless the step would be wider than a 5th ("1 5" goes up). Add - after a degree for the octave below ("1 7- 1", "1 5-"), + for the octave above.
                </p>
                <p className="field-error" id="seq-text-error" role="alert">
                  {typedError ? `${typedError.error}${typedError.at !== null ? ` (at character ${typedError.at + 1})` : ''}` : (lineError ?? '')}
                </p>
              </form>
              <div className="sing-pickers">
                <fieldset className="segmented">
                  <legend className="field-label">How</legend>
                  <div className="segmented-options">
                    <label className="segmented-option">
                      <input type="radio" name="seq-mode" checked={mode === 'read'} disabled={busy} onChange={() => setMode('read')} />
                      <span>Read and sing</span>
                    </label>
                    <label className="segmented-option">
                      <input type="radio" name="seq-mode" checked={mode === 'listen'} disabled={busy} onChange={() => setMode('listen')} />
                      <span>Listen and repeat</span>
                    </label>
                  </div>
                </fieldset>
                <fieldset className="segmented">
                  <legend className="field-label">Key</legend>
                  <div className="segmented-options">
                    {SCALE_MODES.map((m) => (
                      <label key={m} className="segmented-option">
                        <input type="radio" name="seq-scale" checked={scaleMode === m} disabled={busy} onChange={() => changeScaleMode(m)} />
                        <span>{SCALE_MODE_LABELS[m]}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="segmented">
                  <legend className="field-label">Show as</legend>
                  <div className="segmented-options">
                    {LABEL_MODES.map((l) => (
                      <label key={l.value} className="segmented-option">
                        <input type="radio" name="seq-labels" checked={labelMode === l.value} onChange={() => changeLabelMode(l.value)} />
                        <span>{l.label}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            </div>
          )}

          {planTexts && (
            <p className="sing-progress">
              Line {planIndex + 1} of {planTexts.length}
            </p>
          )}
          {target && (
            <div className="sing-item" ref={itemRef}>
              <p className="sing-key">
                In {keyName(target.key)} · 1 = {prettyAccidentals(spellDegreeWithOctave(target.key, 1, target.key.tonicMidi))}
              </p>
              <DegreeStrip labels={labels} results={score?.status === 'ok' ? score.notes : null} activeIndex={active} toleranceCents={tolerance} />
              <StrictnessLine strictness={props.prefs.strictness} toleranceCents={tolerance} />
              <TakeStatus phase={take.phase} kind={kind} elapsedSec={take.elapsedSec} onStop={() => take.stop('button')} hint={`Sing all ${target.midis.length} notes at your own pace. It stops after a short silence at the end${take.phase === 'listening' ? ` (or in ${Math.max(0, Math.ceil(AUTO_STOP_RULES.sequence(target.midis.length).capSec - take.elapsedSec))} s)` : ''}.`} />
              {take.phase === 'listening' && (
                <LiveTrace trace={take.trace} targets={target.midis} toleranceCents={tolerance} windowSec={Math.min(12, 3 + target.midis.length)} hideTargets={mode === 'read'} />
              )}
              {score && take.phase === 'idle' && <SequenceResult score={score} labels={labels.map(degreeLabelText)} headingRef={headingRef} />}
              {take.phase === 'idle' && (
                <div className="button-row">
                  {planTexts && score?.status === 'ok' ? (
                    <button type="button" className="button button--accent" onClick={nextPlanned}>
                      {planIndex + 1 >= planTexts.length ? 'Finish' : 'Next line'}
                      {desktop ? ' (Return)' : ''}
                    </button>
                  ) : (
                    <button type="button" className="button button--accent" onClick={() => void sing()}>
                      {score || error ? 'Sing it again' : mode === 'listen' ? 'Play the line and sing' : 'Play the key and sing'}
                      {desktop ? ' (Return)' : ''}
                    </button>
                  )}
                  {planTexts && score?.status === 'ok' && (
                    <button type="button" className="button" onClick={() => void sing()}>
                      Sing it again
                    </button>
                  )}
                  <button type="button" className="button button--ghost" onClick={replay}>
                    {mode === 'listen' ? 'Hear it again' : 'Hear the key again'}
                    {desktop ? ' (Space)' : ''}
                  </button>
                  {!planTexts && (
                    <button type="button" className="button button--ghost" onClick={newKey}>
                      Same line, new key
                    </button>
                  )}
                  {scored.length > 0 && !planTexts && (
                    <button
                      type="button"
                      className="button button--ghost"
                      onClick={() => {
                        setFinished(true);
                        report(items);
                      }}
                    >
                      Finish
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {finished && (
        <div className="sing-card sing-summary">
          <h2 className="sing-result-title" tabIndex={-1} ref={headingRef}>
            {scored.length} {scored.length === 1 ? 'line' : 'lines'} sung
          </h2>
          <table className="sing-table">
            <thead>
              <tr>
                <th scope="col">Line</th>
                <th scope="col">Notes in the band</th>
                <th scope="col">Average distance</th>
                <th scope="col">Drift</th>
              </tr>
            </thead>
            <tbody>
              {scored.map((i, k) => (
                <tr key={k}>
                  <th scope="row">{i.text}</th>
                  <td>{percent(i.noteAccuracy)}</td>
                  <td>{i.meanAbsCents !== null ? `${centsCount(i.meanAbsCents)}` : '–'}</td>
                  <td>{centsText(i.driftCents)}</td>
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

function parseNormalized(text: string, mode: ScaleMode): string | null {
  const p = parseSequence(text, mode);
  return p.ok ? p.normalized : null;
}

function SequenceResult(props: { score: SequenceScore; labels: string[]; headingRef: RefObject<HTMLHeadingElement | null> }) {
  const s = props.score;
  if (s.status !== 'ok') {
    return (
      <div className="sing-result">
        <h2 className="sing-result-title" tabIndex={-1} ref={props.headingRef}>
          Not scored
        </h2>
        <p>{s.status === 'too-quiet' ? TOO_QUIET_TEXT : NO_PITCH_TEXT}</p>
      </div>
    );
  }
  const inBand = s.notes.filter((n) => n.within).length;
  return (
    <div className="sing-result">
      <h2 className="sing-result-title" tabIndex={-1} ref={props.headingRef}>
        {inBand} of {s.notes.length} notes in the band
      </h2>
      <dl className="sing-stats">
        <Stat label="Notes in the band" value={percent(s.noteAccuracy)} tone={s.noteAccuracy !== null && s.noteAccuracy >= 0.8 ? 'within' : s.noteAccuracy !== null && s.noteAccuracy >= 0.5 ? 'near' : 'off'} />
        <Stat label="Average distance" value={s.meanAbsCents !== null ? `${centsCount(s.meanAbsCents)}` : '–'} note={s.meanAbsCents !== null ? centsMeaning(s.meanAbsCents) : undefined} />
        <Stat label="Steps between notes" value={s.meanAbsIntervalCents !== null ? `${centsCount(s.meanAbsIntervalCents)} off` : '–'} note="average error of each jump" />
        <Stat label="Drift over the line" value={centsText(s.driftCents)} note={s.driftCents !== null ? (Math.abs(s.driftCents) < 20 ? 'the key held steady' : `slid ${s.driftCents < 0 ? 'flat' : 'sharp'} from start to end`) : undefined} />
      </dl>
      {s.octaveOffset !== 0 && !s.findings.some((f) => /^You sang the line .*octave/.test(f.text)) && (
        <p className="sing-info">
          You sang the line {Math.abs(s.octaveOffset) === 1 ? 'an octave' : `${Math.abs(s.octaveOffset)} octaves`} {s.octaveOffset < 0 ? 'lower' : 'higher'} than it played. That is fine: the notes are judged by name.
        </p>
      )}
      {(s.missing > 0 || s.extras.length > 0) && (
        <p className="muted">
          {s.missing > 0 ? `${s.missing} ${s.missing === 1 ? 'note was' : 'notes were'} not heard (shown as "missed"). ` : ''}
          {s.extras.length > 0 ? `${s.extras.length} extra ${s.extras.length === 1 ? 'note was' : 'notes were'} left out of the score.` : ''}
        </p>
      )}
      <FindingList findings={s.findings} />
      <details className="sing-details">
        <summary>Every note</summary>
        <table className="sing-table">
          <thead>
            <tr>
              <th scope="col">Degree</th>
              <th scope="col">Note</th>
              <th scope="col">Step from the last note</th>
            </tr>
          </thead>
          <tbody>
            {s.notes.map((n, i) => (
              <tr key={i}>
                <th scope="row">{props.labels[i] ?? n.written}</th>
                <td>{n.sung ? `${centsText(n.cents)} (${centsWords(n.cents)})${n.octaveSlip ? ', other octave' : ''}` : 'missed'}</td>
                <td>{i === 0 ? '–' : centsText(n.intervalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
