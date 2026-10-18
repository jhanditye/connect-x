// Interval ear training (no microphone): two notes play (rising, falling or together) and the singer names the interval
// from buttons that offer only the current set. "Hear the degree" plays a cadence to set the key, then one note, and
// the singer names its scale degree. After a wrong answer the singer can hear their answer and the right one side by
// side. Keyboard: number keys answer, Space replays, Return moves on. See src/skills/SPEC.md sections 2 and 6.

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { isDesktopKind, platformKind } from '../../pwa/platform';
import { degreeKey, intervalSetWeakness } from '../../skills/progress/stats';
import { currentEarSet } from '../../skills/progress/workout';
import { degreeQuestion, intervalQuestion } from '../../skills/theory/generate';
import { EAR_LEVELS, earSetForLevel, INTERVAL_SONG_HINTS, intervalName, intervalPhrase, intervalShort, MAX_EAR_LEVEL } from '../../skills/theory/intervals';
import { compareIntervalEvents, concatEvents, earQuestionEvents, intervalEvents, noteEvents } from '../../skills/theory/prompts';
import { makeSkillsRng, type Rng } from '../../skills/theory/rng';
import { DEGREES, SCALE_MODE_LABELS, SCALE_STEPS, SOLFEGE, keyName, prettyAccidentals, spellDegree } from '../../skills/theory/scales';
import type {
  Degree,
  EarAnswer,
  EarPlan,
  EarQuestion,
  EarSession,
  EarSetMode,
  Finding,
  IntervalDirection,
  LabelMode,
  ScaleMode,
  SkillScreenProps,
  SkillsStats,
  ToneEvent,
} from '../../skills/types';
import { Icon } from '../components/Icon';
import { playPrompt, stopPrompt } from './kit/sound';
import { pct, plural, rangeFor, sessionBase } from './kit/session';
import { ANSWER_KEYS, useHotkeys } from './kit/useHotkeys';
import { BackToHub, FindingList, Segmented } from './kit/Widgets';
import './kit/skills-shell.css';

type EarMode = 'interval' | 'degree';
type Phase = 'setup' | 'ready' | 'question' | 'answered' | 'done';

export interface EarConfig {
  mode: EarMode;
  questions: number;
  /** Interval set (semitones, ascending) for interval questions. */
  set: number[];
  directions: IntervalDirection[];
  /** Weight weak intervals / degrees (from the saved stats). */
  adaptive: boolean;
  scaleMode: ScaleMode;
}

const QUESTION_COUNTS = [10, 20, 30] as const;
const DIRECTION_LABELS: Record<IntervalDirection, string> = { up: 'Rising', down: 'Falling', harmonic: 'Together' };
const DIRECTION_HINT: Record<IntervalDirection, string> = { up: 'Two notes, going up', down: 'Two notes, going down', harmonic: 'Two notes played together' };
/** Floor on adaptive weights so every item still comes up now and then. */
const WEIGHT_FLOOR = 0.15;

/** The interval-question weights for adaptive practice (same order as the set): weaker recognition = asked more often. */
export function intervalWeights(stats: SkillsStats, set: readonly number[], directions: readonly IntervalDirection[]): number[] {
  return set.map((s) => WEIGHT_FLOOR + intervalSetWeakness(stats, s, directions, 'hear'));
}

/** Weights for degrees 1..7 in "Hear the degree": unseen 0.5, else 1 - moving share right. */
export function degreeHearWeights(stats: SkillsStats, mode: ScaleMode): number[] {
  return DEGREES.map((d) => {
    const r = stats.hearDegree[degreeKey(mode, d)];
    return WEIGHT_FLOOR + (r ? 1 - r.ema : 0.5);
  });
}

/** The answer label for a degree in the chosen display mode, with the other names underneath. */
export function degreeAnswerLabel(d: Degree, mode: ScaleMode, labelMode: LabelMode, tonicMidi: number): { main: string; sub: string } {
  const solf = SOLFEGE[mode][d - 1];
  if (labelMode === 'solfege') return { main: solf, sub: String(d) };
  if (labelMode === 'names') return { main: prettyAccidentals(spellDegree({ tonicMidi, mode }, d)), sub: `${d} · ${solf}` };
  return { main: String(d), sub: solf };
}

/** Config for a run: a workout plan wins, otherwise the saved preferences. */
export function earConfigFrom(prefs: SkillScreenProps['prefs'], plan?: EarPlan): EarConfig {
  const directions = prefs.earDirections.length > 0 ? prefs.earDirections.slice() : (['up', 'down'] as IntervalDirection[]);
  const set = plan?.set && plan.set.length >= 2 ? plan.set.slice().sort((a, b) => a - b) : currentEarSet(prefs);
  return {
    mode: plan?.mode ?? 'interval',
    questions: Math.max(1, Math.round(plan?.questions ?? 10)),
    set,
    directions,
    adaptive: !plan?.set && prefs.earSetMode === 'adaptive',
    scaleMode: prefs.scaleMode,
  };
}

/** Plain-English findings for a finished run: the score, the most common mix-up, the clearest weak spot. */
export function earFindings(answers: readonly EarAnswer[], mode: EarMode): Finding[] {
  const out: Finding[] = [];
  const total = answers.length;
  if (total === 0) return out;
  const right = answers.filter((a) => a.correct).length;
  const share = right / total;
  if (share >= 0.9) out.push({ tone: 'good', text: `${right} of ${total} right. Your ear for these is solid.` });
  else if (share >= 0.6) out.push({ tone: 'good', text: `${right} of ${total} right: most of these are already in your ear.` });
  else out.push({ tone: 'info', text: `${right} of ${total} right. Early sessions are often like this; a few minutes a day moves it quickly.` });

  // The most common confusion (asked X, said Y).
  const pairs = new Map<string, { asked: number; said: number; n: number }>();
  for (const a of answers) {
    if (a.correct) continue;
    const k = `${a.correctValue}>${a.chosenValue}`;
    const p = pairs.get(k) ?? { asked: a.correctValue, said: a.chosenValue, n: 0 };
    p.n++;
    pairs.set(k, p);
  }
  const top = [...pairs.values()].sort((a, b) => b.n - a.n)[0];
  if (top) {
    const asked = mode === 'interval' ? `the ${intervalName(top.asked)}` : `degree ${top.asked}`;
    const said = mode === 'interval' ? `a ${intervalName(top.said)}`.replace(/^a ([aeiou]|octave)/, 'an $1') : `${top.said}`;
    const times = top.n === 1 ? 'once' : top.n === 2 ? 'twice' : `${top.n} times`;
    out.push({ tone: 'work', text: `You heard ${asked} as ${said} ${times}. Use "Hear both" after a miss to compare them side by side.` });
  }
  return out.slice(0, 3);
}

export function EarTrainingScreen(props: SkillScreenProps<EarSession> & { plan?: EarPlan }) {
  const { settings, prefs, stats, plan, embedded } = props;
  const a4 = Number.isFinite(settings.a4Hz) && settings.a4Hz > 0 ? settings.a4Hz : 440;
  const range = useMemo(() => rangeFor(settings, prefs), [settings, prefs]);
  const desk = isDesktopKind(platformKind());

  const [config, setConfig] = useState<EarConfig>(() => earConfigFrom(prefs, plan));
  const [phase, setPhase] = useState<Phase>(plan || embedded ? 'ready' : 'setup');
  const [question, setQuestion] = useState<EarQuestion | null>(null);
  const [answers, setAnswers] = useState<EarAnswer[]>([]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [session, setSession] = useState<EarSession | null>(null);

  const rngRef = useRef<Rng>(makeSkillsRng(props.seed));
  const startedAt = useRef(0);
  const shownAt = useRef(0);
  const replays = useRef(0);
  const doneOnce = useRef(false);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const questionRef = useRef<HTMLHeadingElement>(null);
  const summaryRef = useRef<HTMLHeadingElement>(null);
  const playSeq = useRef(0);

  useEffect(() => () => stopPrompt(), []);
  // Focus follows the screen: the new question, the feedback after an answer, the summary at the end. Keyboard and
  // screen-reader users land on what changed, and Space / Return keep working as shortcuts from there.
  useEffect(() => {
    const el = phase === 'question' ? questionRef.current : phase === 'answered' ? feedbackRef.current : phase === 'done' ? summaryRef.current : null;
    el?.focus({ preventScroll: true });
  }, [phase, question]);

  const updateConfig = (patch: Partial<EarConfig>, prefPatch?: Parameters<NonNullable<typeof props.onPrefs>>[0]) => {
    setConfig((c) => ({ ...c, ...patch }));
    if (prefPatch) props.onPrefs?.(prefPatch);
  };

  const play = (events: ToneEvent[]) => {
    const seq = ++playSeq.current;
    setStalled(false);
    setPlaying(true);
    const p = playPrompt(events, a4);
    void p.done.then(() => {
      if (seq !== playSeq.current) return;
      setPlaying(false);
      if (p.stalled) setStalled(true);
    });
  };

  const makeQuestion = (prev: EarQuestion | null): EarQuestion => {
    const rng = rngRef.current;
    for (let tries = 0; ; tries++) {
      let q: EarQuestion;
      if (config.mode === 'interval') {
        const weights = config.adaptive ? intervalWeights(stats, config.set, config.directions) : undefined;
        q = intervalQuestion(rng, config.set, range, { directions: config.directions, weights });
      } else {
        q = degreeQuestion(rng, config.scaleMode, range, config.adaptive ? degreeHearWeights(stats, config.scaleMode) : undefined);
      }
      const same =
        prev !== null &&
        prev.kind === q.kind &&
        (q.kind === 'interval' && prev.kind === 'interval' ? q.semitones === prev.semitones && q.direction === prev.direction : q.kind === 'degree' && prev.kind === 'degree' && q.degree === prev.degree);
      if (!same || tries >= 2) return q;
    }
  };

  const ask = (prev: EarQuestion | null) => {
    const q = makeQuestion(prev);
    setQuestion(q);
    setChosen(null);
    replays.current = 0;
    shownAt.current = Date.now();
    setPhase('question');
    play(earQuestionEvents(q));
  };

  const start = () => {
    startedAt.current = Date.now();
    doneOnce.current = false;
    setAnswers([]);
    setSession(null);
    ask(null);
  };

  const replay = () => {
    if (!question) return;
    replays.current++;
    play(earQuestionEvents(question));
  };

  const finish = (list: EarAnswer[]) => {
    stopPrompt();
    if (list.length === 0) {
      props.onExit();
      return;
    }
    const correct = list.filter((a) => a.correct).length;
    const s: EarSession = { ...sessionBase(settings, prefs, startedAt.current), kind: 'ear', mode: config.mode, answers: list, correct, total: list.length };
    setSession(s);
    setPhase('done');
    if (!doneOnce.current) {
      doneOnce.current = true;
      props.onDone(s);
    }
  };

  const choose = (value: number) => {
    if (phase !== 'question' || !question) return;
    const correctValue = question.kind === 'interval' ? question.semitones : question.degree;
    const a: EarAnswer = {
      questionId: question.id,
      kind: question.kind,
      correctValue,
      chosenValue: value,
      correct: value === correctValue,
      direction: question.kind === 'interval' ? question.direction : null,
      mode: question.kind === 'degree' ? question.key.mode : null,
      replays: replays.current,
      responseMs: Math.max(0, Date.now() - shownAt.current),
    };
    setAnswers((list) => [...list, a]);
    setChosen(value);
    setPhase('answered');
  };

  const next = () => {
    if (phase !== 'answered') return;
    if (answers.length >= config.questions) finish(answers);
    else ask(question);
  };

  // Comparison prompts after an answer.
  const degreeMidi = (q: Extract<EarQuestion, { kind: 'degree' }>, d: number) => q.key.tonicMidi + SCALE_STEPS[q.key.mode][d - 1];
  const hearYours = () => {
    if (!question || chosen === null) return;
    if (question.kind === 'interval') play(intervalEvents(question.firstMidi, chosen, question.direction).map((e) => ({ ...e, role: 'answer' as const })));
    else play(concatEvents(noteEvents(question.key.tonicMidi, 0.8, 'tonic'), noteEvents(degreeMidi(question, chosen), 1.0, 'answer'), 0.15));
  };
  const hearRight = () => {
    if (!question) return;
    if (question.kind === 'interval') play(intervalEvents(question.firstMidi, question.semitones, question.direction));
    else play(concatEvents(noteEvents(question.key.tonicMidi, 0.8, 'tonic'), noteEvents(question.midi, 1.0, 'target'), 0.15));
  };
  const hearBoth = () => {
    if (!question || chosen === null) return;
    if (question.kind === 'interval') play(compareIntervalEvents(question.firstMidi, chosen, question.semitones, question.direction));
    else {
      const yours = concatEvents(noteEvents(question.key.tonicMidi, 0.8, 'tonic'), noteEvents(degreeMidi(question, chosen), 1.0, 'answer'), 0.15);
      const right = concatEvents(noteEvents(question.key.tonicMidi, 0.8, 'tonic'), noteEvents(question.midi, 1.0, 'target'), 0.15);
      play(concatEvents(yours, right, 0.6));
    }
  };

  const choiceValues: number[] = question ? (question.kind === 'interval' ? question.choices : question.choices.slice()) : [];

  const keys: Record<string, () => void> = {};
  if (phase === 'question') {
    keys.Space = replay;
    choiceValues.forEach((v, i) => {
      const k = question?.kind === 'degree' ? String(v) : ANSWER_KEYS[i];
      if (k) keys[k] = () => choose(v);
    });
  } else if (phase === 'answered') {
    keys.Space = replay;
    keys.Enter = next;
  } else if (phase === 'ready' || phase === 'setup') {
    keys.Enter = start;
  }
  useHotkeys(phase !== 'done', keys);

  const asked = answers.length + (phase === 'question' ? 1 : 0);
  const rightSoFar = answers.filter((a) => a.correct).length;
  const last = answers[answers.length - 1];

  const title = config.mode === 'interval' ? 'Interval ear training' : 'Hear the degree';

  return (
    <div className={`sk-screen sk-ear${embedded ? ' sk-screen--embedded' : ''}`}>
      {!embedded && (
        <header className="page-head">
          <BackToHub onExit={props.onExit} />
          <p className="eyebrow">Skills · listening</p>
          <h1 className="page-title">{title}</h1>
          <p className="lede">
            {config.mode === 'interval'
              ? 'Hear two notes and name the distance between them. Naming intervals by ear is what lets you find them with your voice.'
              : 'A short chord progression sets the key, then one note plays. Name its scale degree: where it sits in the key.'}{' '}
            No microphone needed.
          </p>
        </header>
      )}
      {embedded && <h2 className="section-title sk-embedded-title">{title}</h2>}

      {phase === 'setup' && (
        <EarSetup
          config={config}
          prefs={prefs}
          onChange={updateConfig}
          onStart={start}
          desk={desk}
        />
      )}

      {phase === 'ready' && (
        <section className="sk-card sk-ready">
          <p>
            {config.mode === 'interval'
              ? `${plural(config.questions, 'question')} on ${config.set.map((s) => intervalShort(s)).join(', ')}.`
              : `${plural(config.questions, 'question')} in ${SCALE_MODE_LABELS[config.scaleMode].toLowerCase()}.`}{' '}
            Listen, then pick the answer{desk ? ' (or press its number key)' : ''}.
          </p>
          <div className="button-row">
            <button type="button" className="button button--accent" onClick={start}>
              <Icon name="play" size={16} /> Play the first question
            </button>
          </div>
        </section>
      )}

      {(phase === 'question' || phase === 'answered') && question && (
        <section className="sk-card sk-question" aria-labelledby="sk-ear-q">
          <div className="sk-question-top">
            <p className="sk-count">
              Question <span className="num">{Math.min(asked, config.questions)}</span> of <span className="num">{config.questions}</span>
              {answers.length > 0 && (
                <>
                  {' '}
                  · <span className="num">{rightSoFar}</span> right
                </>
              )}
            </p>
            <button type="button" className="link-button sk-finish-early" onClick={() => finish(answers)}>
              {answers.length > 0 ? 'Finish here' : 'Leave'}
            </button>
          </div>
          <h2 id="sk-ear-q" ref={questionRef} tabIndex={-1} className="sk-question-title">
            {question.kind === 'interval' ? 'Which interval?' : 'Which degree?'}
          </h2>
          <p className="sk-question-hint">
            {question.kind === 'interval' ? DIRECTION_HINT[question.direction] : `Key of ${keyName(question.key)}: the chords, then one note`}
          </p>
          <div className="button-row sk-replay-row">
            <button type="button" className="button" onClick={replay} aria-describedby={desk ? 'sk-ear-space' : undefined}>
              <Icon name="loop" size={16} /> {playing ? 'Playing…' : 'Play again'}
              {desk && (
                <kbd className="sk-kbd" id="sk-ear-space">
                  Space
                </kbd>
              )}
            </button>
          </div>
          {stalled && (
            <p className="notice notice--warn sk-stalled" role="alert">
              No sound came out. {desk ? 'Click' : 'Tap'} Play again; if it stays silent, check the volume{desk ? '' : ' and the silent switch'}.
            </p>
          )}

          <div className={`sk-answers sk-answers--${question.kind}`} role="group" aria-label="Answers">
            {choiceValues.map((v, i) => {
              const keyHint = question.kind === 'degree' ? String(v) : ANSWER_KEYS[i];
              const correctValue = question.kind === 'interval' ? question.semitones : question.degree;
              const state = phase === 'answered' ? (v === correctValue ? 'right' : v === chosen ? 'wrong' : 'idle') : 'idle';
              const label =
                question.kind === 'interval'
                  ? { main: intervalShort(v), sub: intervalName(v) }
                  : degreeAnswerLabel(v as Degree, question.key.mode, prefs.labelMode, question.key.tonicMidi);
              return (
                <button
                  key={v}
                  type="button"
                  className={`sk-answer sk-answer--${state}`}
                  onClick={() => choose(v)}
                  disabled={phase === 'answered'}
                  aria-label={`${question.kind === 'interval' ? intervalName(v, true) : `Degree ${v} (${label.sub})`}${state === 'right' ? ', the right answer' : state === 'wrong' ? ', your answer' : ''}`}
                >
                  <span className="sk-answer-main">{label.main}</span>
                  <span className="sk-answer-sub">{label.sub}</span>
                  {desk && keyHint && <kbd className="sk-kbd sk-answer-key">{keyHint}</kbd>}
                </button>
              );
            })}
          </div>

          <div className="sk-feedback-slot" aria-live="polite">
            {phase === 'answered' && last && (
              <div ref={feedbackRef} tabIndex={-1} className={`sk-feedback sk-feedback--${last.correct ? 'right' : 'wrong'}`}>
                <p className="sk-feedback-text">
                  {feedbackText(question, last)}
                </p>
                {question.kind === 'interval' && question.direction === 'up' && INTERVAL_SONG_HINTS[question.semitones] && (
                  <p className="sk-feedback-hint">Listening hook: {INTERVAL_SONG_HINTS[question.semitones]}.</p>
                )}
                <div className="button-row">
                  {!last.correct && (
                    <>
                      <button type="button" className="button button--small" onClick={hearYours}>
                        Hear yours
                      </button>
                      <button type="button" className="button button--small" onClick={hearRight}>
                        Hear the right one
                      </button>
                      <button type="button" className="button button--small" onClick={hearBoth}>
                        Hear both, side by side
                      </button>
                    </>
                  )}
                  <button type="button" className="button button--accent" onClick={next}>
                    {answers.length >= config.questions ? 'See how you did' : 'Next question'}
                    {desk && <kbd className="sk-kbd sk-kbd--on-accent">Return</kbd>}
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {phase === 'done' && session && (
        <EarSummary
          session={session}
          config={config}
          headingRef={summaryRef}
          embedded={!!embedded}
          canLevelUp={!plan && prefs.earSetMode === 'level' && config.mode === 'interval' && prefs.earLevel < MAX_EAR_LEVEL}
          level={prefs.earLevel}
          onLevelUp={() => {
            const lv = Math.min(MAX_EAR_LEVEL, prefs.earLevel + 1);
            props.onPrefs?.({ earLevel: lv });
            setConfig((c) => ({ ...c, set: earSetForLevel(lv) }));
          }}
          onAgain={() => {
            setPhase(plan || embedded ? 'ready' : 'setup');
            setSession(null);
            setAnswers([]);
          }}
          onExit={props.onExit}
        />
      )}
    </div>
  );
}

function feedbackText(q: EarQuestion, a: EarAnswer): string {
  if (q.kind === 'interval') {
    const right = intervalPhrase(q.semitones, q.direction);
    if (a.correct) return `Right: ${right}.`;
    return `Not quite: that was ${right}. You chose ${intervalPhrase(a.chosenValue, q.direction).replace(/ \(both notes together\)| up| down/, '')}.`;
  }
  const solf = (d: number) => SOLFEGE[q.key.mode][d - 1];
  if (a.correct) return `Right: degree ${q.degree} (${solf(q.degree)}).`;
  return `Not quite: that was degree ${q.degree} (${solf(q.degree)}). You chose ${a.chosenValue} (${solf(a.chosenValue)}).`;
}

function EarSetup(props: {
  config: EarConfig;
  prefs: SkillScreenProps['prefs'];
  desk: boolean;
  onChange(patch: Partial<EarConfig>, prefPatch?: Partial<SkillScreenProps['prefs']>): void;
  onStart(): void;
}) {
  const { config, prefs } = props;
  const setMode: EarSetMode = prefs.earSetMode;
  const toggleCustom = (s: number) => {
    const has = config.set.includes(s);
    const next = (has ? config.set.filter((x) => x !== s) : [...config.set, s]).sort((a, b) => a - b);
    if (next.length < 2) return;
    props.onChange({ set: next }, { earCustom: next });
  };
  const toggleDir = (d: IntervalDirection) => {
    const has = config.directions.includes(d);
    const next = has ? config.directions.filter((x) => x !== d) : [...config.directions, d];
    if (next.length === 0) return;
    props.onChange({ directions: next }, { earDirections: next });
  };
  return (
    <section className="sk-card sk-setup" aria-label="Set up">
      <Segmented<EarMode>
        legend="What to practise"
        value={config.mode}
        options={[
          { value: 'interval', label: 'Intervals' },
          { value: 'degree', label: 'Hear the degree' },
        ]}
        onChange={(mode) => props.onChange({ mode })}
      />

      {config.mode === 'interval' ? (
        <>
          <Segmented<EarSetMode>
            legend="Which intervals"
            value={setMode}
            options={[
              { value: 'level', label: 'By level' },
              { value: 'custom', label: 'Custom' },
              { value: 'adaptive', label: 'Adaptive' },
            ]}
            onChange={(m) => {
              const set = m === 'custom' ? currentEarSet({ ...prefs, earSetMode: 'custom' }) : earSetForLevel(prefs.earLevel);
              props.onChange({ set, adaptive: m === 'adaptive' }, { earSetMode: m });
            }}
            hint={
              setMode === 'adaptive'
                ? 'The intervals of your level, asked more often where you have been missing them (easy ones still come up).'
                : setMode === 'custom'
                  ? 'Pick at least two.'
                  : 'Start with the Starter set; add more when you get 9 in 10 right.'
            }
          />
          {setMode !== 'custom' ? (
            <div className="field sk-field">
              <label className="field-label" htmlFor="sk-ear-level">
                Level
              </label>
              <select
                id="sk-ear-level"
                className="select"
                value={prefs.earLevel}
                onChange={(e) => {
                  const lv = Number(e.target.value);
                  props.onChange({ set: earSetForLevel(lv) }, { earLevel: lv });
                }}
              >
                {EAR_LEVELS.map((l) => (
                  <option key={l.level} value={l.level}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <fieldset className="sk-checks">
              <legend className="field-label">Intervals in your set</legend>
              <div className="sk-check-grid">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((s) => (
                  <label key={s} className="sk-check">
                    <input type="checkbox" checked={config.set.includes(s)} onChange={() => toggleCustom(s)} />
                    <span>
                      <strong>{intervalShort(s)}</strong> {intervalName(s)}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <p className="sk-set-chips" aria-label="The set">
            {config.set.map((s) => (
              <span key={s} className="chip">
                {intervalShort(s)}
              </span>
            ))}
          </p>
          <fieldset className="sk-checks">
            <legend className="field-label">Directions</legend>
            <div className="sk-check-row">
              {(['up', 'down', 'harmonic'] as IntervalDirection[]).map((d) => (
                <label key={d} className="sk-check">
                  <input type="checkbox" checked={config.directions.includes(d)} onChange={() => toggleDir(d)} />
                  <span>{DIRECTION_LABELS[d]}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </>
      ) : (
        <>
          <Segmented<ScaleMode>
            legend="Key"
            value={config.scaleMode}
            options={(['major', 'natural-minor', 'harmonic-minor'] as ScaleMode[]).map((m) => ({ value: m, label: SCALE_MODE_LABELS[m] }))}
            onChange={(scaleMode) => props.onChange({ scaleMode }, { scaleMode })}
          />
          <Segmented<'plain' | 'adaptive'>
            legend="Which degrees"
            value={config.adaptive ? 'adaptive' : 'plain'}
            options={[
              { value: 'plain', label: 'All evenly' },
              { value: 'adaptive', label: 'Adaptive' },
            ]}
            onChange={(v) => props.onChange({ adaptive: v === 'adaptive' })}
          />
        </>
      )}

      <Segmented<string>
        legend="Questions"
        value={String(config.questions)}
        options={QUESTION_COUNTS.map((n) => ({ value: String(n), label: String(n) }))}
        onChange={(v) => props.onChange({ questions: Number(v) })}
      />

      <div className="button-row sk-start-row">
        <button type="button" className="button button--accent" onClick={props.onStart}>
          <Icon name="play" size={16} /> Start
          {props.desk && <kbd className="sk-kbd sk-kbd--on-accent">Return</kbd>}
        </button>
      </div>
      {props.desk && <p className="caveat">Keys: numbers answer, Space plays again, Return moves on.</p>}
    </section>
  );
}

function EarSummary(props: {
  session: EarSession;
  config: EarConfig;
  headingRef: RefObject<HTMLHeadingElement | null>;
  embedded: boolean;
  canLevelUp: boolean;
  level: number;
  onLevelUp(): void;
  onAgain(): void;
  onExit(): void;
}) {
  const { session, config } = props;
  const share = session.total ? session.correct / session.total : 0;
  const rows = useMemo(() => breakdown(session), [session]);
  const findings = earFindings(session.answers, session.mode);
  const nextLevel = EAR_LEVELS.find((l) => l.level === props.level + 1);
  const ready = props.canLevelUp && session.total >= 10 && share >= 0.9 && nextLevel;
  return (
    <section className="sk-card sk-summary" aria-labelledby="sk-ear-sum">
      <h2 id="sk-ear-sum" ref={props.headingRef} tabIndex={-1} className="sk-summary-title">
        <span className="num">{session.correct}</span> of <span className="num">{session.total}</span> right
        <span className="sk-summary-pct"> ({pct(share)})</span>
      </h2>
      <FindingList findings={findings} />
      {ready && (
        <div className="sk-levelup">
          <p>
            Ready for more? {nextLevel.label} adds {nextLevel.adds.map((s) => intervalName(s)).join(' and ')}.
          </p>
          <button type="button" className="button button--small" onClick={props.onLevelUp}>
            Move to {nextLevel.label.split(':')[0].toLowerCase()}
          </button>
        </div>
      )}
      {rows.length > 0 && (
        <table className="sk-table sk-ear-table">
          <caption className="visually-hidden">Answers by {config.mode === 'interval' ? 'interval' : 'degree'}</caption>
          <thead>
            <tr>
              <th scope="col">{config.mode === 'interval' ? 'Interval' : 'Degree'}</th>
              <th scope="col">Right</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">{r.label}</th>
                <td className={`num ${r.right === r.asked ? 'sk-good' : r.right === 0 ? 'sk-work' : ''}`}>
                  {r.right} of {r.asked}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!props.embedded && (
        <div className="button-row">
          <button type="button" className="button button--accent" onClick={props.onAgain}>
            Go again
          </button>
          <button type="button" className="button" onClick={props.onExit}>
            Back to Skills
          </button>
        </div>
      )}
    </section>
  );
}

/** Answers grouped by what was asked ("Perfect 5th up: 3 of 3"), hardest first. */
export function breakdown(session: Pick<EarSession, 'answers' | 'mode'>): { key: string; label: string; asked: number; right: number }[] {
  const m = new Map<string, { key: string; label: string; asked: number; right: number; order: number }>();
  for (const a of session.answers) {
    const key = session.mode === 'interval' ? `${a.correctValue}${a.direction ?? ''}` : `${a.mode ?? ''}${a.correctValue}`;
    const label =
      session.mode === 'interval'
        ? `${intervalName(a.correctValue, true)}${a.direction === 'up' ? ' up' : a.direction === 'down' ? ' down' : a.direction === 'harmonic' ? ' together' : ''}`
        : `${a.correctValue} (${SOLFEGE[a.mode ?? 'major'][a.correctValue - 1] ?? ''})`;
    const row = m.get(key) ?? { key, label, asked: 0, right: 0, order: a.correctValue };
    row.asked++;
    if (a.correct) row.right++;
    m.set(key, row);
  }
  return [...m.values()].sort((a, b) => a.right / a.asked - b.right / b.asked || a.order - b.order).map(({ key, label, asked, right }) => ({ key, label, asked, right }));
}
