// The daily workout (about 10 minutes): runs the exercise screens one after another, embedded, with the plan each step
// asks for (src/skills/progress/workout.ts buildWorkout). Every finished step is saved straight away as its own session
// with the workout's id (onStepDone), so stopping half way loses nothing; at the end one WorkoutSession ties them
// together and the summary compares each step with last time. Any step can be skipped.

import { useEffect, useMemo, useRef, useState } from 'react';
import { isDesktopKind, platformKind } from '../../pwa/platform';
import { sessionHeadline } from '../../skills/progress/history';
import { skillsId } from '../../skills/progress/store';
import { buildWorkout, workoutFindings, workoutSeconds } from '../../skills/progress/workout';
import { makeSkillsRng } from '../../skills/theory/rng';
import type { SkillScreenProps, SkillsSession, SkillsStore, WorkoutSession, WorkoutStep } from '../../skills/types';
import { Icon } from '../components/Icon';
import { EarTrainingScreen } from './EarTrainingScreen';
import { BreathScreen } from './sing/BreathScreen';
import { MatchNoteScreen } from './sing/MatchNoteScreen';
import { SequenceScreen } from './sing/SequenceScreen';
import { SingIntervalsScreen } from './sing/SingIntervalsScreen';
import { stopPrompt } from './kit/sound';
import { aboutMinutes, sessionBase } from './kit/session';
import { useHotkeys } from './kit/useHotkeys';
import { BackToHub, BreathSafety, FindingList } from './kit/Widgets';
import './kit/skills-shell.css';

type Phase = 'intro' | 'step' | 'between' | 'done';

interface StepRecord {
  index: number;
  status: 'done' | 'skipped';
  session: SkillsSession | null;
}

export type WorkoutScreenProps = SkillScreenProps<WorkoutSession> & { store: SkillsStore; onStepDone(s: SkillsSession): void };

/** Seed for step `i` when the workout itself is seeded (tests): different per step, the same every run. */
export function stepSeed(seed: number | undefined, i: number): number | undefined {
  return seed === undefined ? undefined : (seed + 1009 * (i + 1)) >>> 0;
}

export function WorkoutScreen(props: WorkoutScreenProps) {
  const { settings, store } = props;
  const desk = isDesktopKind(platformKind());
  // The plan is fixed when the screen opens: saving step sessions changes the store, not today's steps.
  const [steps] = useState<WorkoutStep[]>(() => buildWorkout(store, settings, makeSkillsRng(props.seed)));
  const [workoutId] = useState(() => skillsId());
  const [phase, setPhase] = useState<Phase>('intro');
  const [index, setIndex] = useState(0);
  const [records, setRecords] = useState<StepRecord[]>([]);
  const [workout, setWorkout] = useState<WorkoutSession | null>(null);
  const startedAt = useRef(0);
  const doneOnce = useRef(false);
  const handled = useRef(new Set<number>());
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => () => stopPrompt(), []);
  useEffect(() => {
    if (phase === 'between' || phase === 'done') headingRef.current?.focus({ preventScroll: true });
  }, [phase, index]);

  const finish = (list: StepRecord[]) => {
    stopPrompt();
    const done = list.filter((r) => r.status === 'done' && r.session);
    if (done.length === 0) {
      props.onExit();
      return;
    }
    const w: WorkoutSession = {
      ...sessionBase(settings, store.prefs, startedAt.current),
      kind: 'workout',
      partIds: done.map((r) => (r.session as SkillsSession).id),
      completedSteps: done.length,
      totalSteps: steps.length,
    };
    setWorkout(w);
    setPhase('done');
    if (!doneOnce.current) {
      doneOnce.current = true;
      props.onDone(w);
    }
  };

  const advance = (list: StepRecord[], from: number) => {
    if (from + 1 >= steps.length) finish(list);
    else {
      setIndex(from + 1);
      setPhase('step');
    }
  };

  const stepDone = (i: number) => (s: SkillsSession) => {
    if (handled.current.has(i)) return;
    handled.current.add(i);
    const tagged = { ...s, workoutId } as SkillsSession;
    props.onStepDone(tagged);
    const list = [...records.filter((r) => r.index !== i), { index: i, status: 'done' as const, session: tagged }];
    setRecords(list);
    setPhase('between');
  };

  const skip = (i: number) => {
    if (handled.current.has(i)) return;
    handled.current.add(i);
    stopPrompt();
    const list = [...records, { index: i, status: 'skipped' as const, session: null }];
    setRecords(list);
    advance(list, i);
  };

  const start = () => {
    startedAt.current = Date.now();
    setIndex(0);
    setPhase('step');
  };

  useHotkeys(phase === 'intro' || phase === 'between', {
    Enter: () => (phase === 'intro' ? start() : advance(records, index)),
  });

  const totalSec = useMemo(() => workoutSeconds(steps), [steps]);
  const step = steps[index];
  const lastRecord = records.find((r) => r.index === index);
  const doneCount = records.filter((r) => r.status === 'done').length;

  const renderStep = (s: WorkoutStep, i: number) => {
    const common = {
      settings,
      prefs: store.prefs,
      stats: store.stats,
      seed: stepSeed(props.seed, i),
      embedded: true,
      onExit: () => skip(i),
      onPrefs: props.onPrefs,
    };
    switch (s.kind) {
      case 'breath':
        return <BreathScreen key={`step-${i}`} {...common} plan={s.plan} onDone={stepDone(i)} />;
      case 'match':
        return <MatchNoteScreen key={`step-${i}`} {...common} plan={s.plan} onDone={stepDone(i)} />;
      case 'ear':
        return <EarTrainingScreen key={`step-${i}`} {...common} plan={s.plan} onDone={stepDone(i)} />;
      case 'sing-intervals':
        return <SingIntervalsScreen key={`step-${i}`} {...common} plan={s.plan} onDone={stepDone(i)} />;
      case 'sequence':
        return <SequenceScreen key={`step-${i}`} {...common} plan={s.plan} onDone={stepDone(i)} />;
    }
  };

  const stepState = (i: number): 'done' | 'skipped' | 'current' | 'todo' => {
    const r = records.find((x) => x.index === i);
    if (r) return r.status;
    if (phase === 'step' && i === index) return 'current';
    return 'todo';
  };

  return (
    <div className="sk-screen sk-workout">
      <header className="page-head">
        <BackToHub onExit={props.onExit} />
        <p className="eyebrow">Skills · daily</p>
        <h1 className="page-title">Today’s workout</h1>
        {phase === 'intro' && (
          <p className="lede">
            {aboutMinutes(totalSec)}, in {steps.length} steps. The ear and singing steps lean towards what you have found hardest so far. Each step
            starts when you press its button, and you can skip any of them.
          </p>
        )}
      </header>

      {phase === 'intro' && (
        <section className="sk-card" aria-label="The steps">
          <ol className="sk-steps">
            {steps.map((s, i) => (
              <li key={i}>
                <span>{s.label}</span>
                <span className="sk-steps-time">{Math.max(1, Math.round(s.estSec / 60))} min</span>
              </li>
            ))}
          </ol>
          <BreathSafety compact />
          <div className="button-row sk-start-row">
            <button type="button" className="button button--accent" onClick={start}>
              <Icon name="play" size={16} /> Start the workout
              {desk && <kbd className="sk-kbd sk-kbd--on-accent">Return</kbd>}
            </button>
          </div>
        </section>
      )}

      {(phase === 'step' || phase === 'between') && step && (
        <div className="sk-workout-bar">
          <span className="sk-workout-bar-text">
            Step <span className="num">{index + 1}</span> of <span className="num">{steps.length}</span>: {step.label}
          </span>
          <span className="sk-workout-progress" role="progressbar" aria-label="Workout progress" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={records.length}>
            <span style={{ width: `${Math.round((records.length / steps.length) * 100)}%` }} />
          </span>
          <span className="button-row" style={{ marginTop: 0 }}>
            {phase === 'step' && (
              <button type="button" className="button button--small button--ghost" onClick={() => skip(index)}>
                Skip this step
              </button>
            )}
            <button type="button" className="button button--small button--ghost" onClick={() => finish(records)}>
              End workout
            </button>
          </span>
        </div>
      )}

      {phase === 'step' && step && renderStep(step, index)}

      {phase === 'between' && step && (
        <section className="sk-card" aria-labelledby="sk-between-h" aria-live="polite">
          <h2 id="sk-between-h" ref={headingRef} tabIndex={-1} className="sk-between-title">
            {step.label}: done
          </h2>
          {lastRecord?.session && <p className="sk-feedback-text">{sessionHeadline(lastRecord.session).text}.</p>}
          {index + 1 < steps.length ? (
            <p className="muted">Next: {steps[index + 1].label}.</p>
          ) : (
            <p className="muted">That was the last step.</p>
          )}
          <div className="button-row">
            <button type="button" className="button button--accent" onClick={() => advance(records, index)}>
              {index + 1 < steps.length ? 'Next step' : 'See the summary'}
              {desk && <kbd className="sk-kbd sk-kbd--on-accent">Return</kbd>}
            </button>
          </div>
        </section>
      )}

      {phase === 'done' && workout && (
        <section className="sk-card sk-summary" aria-labelledby="sk-wsum-h">
          <h2 id="sk-wsum-h" ref={headingRef} tabIndex={-1} className="sk-summary-title">
            Workout done: <span className="num">{doneCount}</span> of <span className="num">{steps.length}</span> steps
          </h2>
          <FindingList findings={workoutFindings(store, workout)} />
          <ol className="sk-steps" aria-label="Steps">
            {steps.map((s, i) => {
              const r = records.find((x) => x.index === i);
              return (
                <li key={i} data-state={stepState(i) === 'done' ? 'done' : undefined}>
                  <span>
                    {s.label}: {r?.session ? sessionHeadline(r.session).text : r?.status === 'skipped' ? 'skipped' : 'not reached'}
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="button-row">
            <button type="button" className="button button--accent" onClick={props.onExit}>
              Back to Skills
            </button>
            <a className="button" href="#skills/progress">
              Your progress
            </a>
          </div>
        </section>
      )}
    </div>
  );
}
