// Practice: the plan's focus exercises first, then a reference pitch and the rest of the library,
// with a pattern player transposed to the user's voice type (start note = passaggio low + the
// exercise's offset). Library cards keep their steps behind a disclosure so the page stays short on
// phones; the focus cards start open.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { passaggioFor, VOICE_TYPE_NAMES } from '../../analysis/passaggio';
import { audioSupported, patternSchedule, patternStartMidi, playNote, playPattern, startDrone, type PatternPlayer } from '../../audio/tones';
import { EXERCISES } from '../../coach/exercises';
import { STYLE_LABELS } from '../../coach/profiles';
import { midiToNoteName } from '../../dsp/music';
import type { AppSettings, Exercise, StyleKey } from '../../types';
import { DIM_DISPLAY } from '../charts/chartKit';
import { Icon } from '../components/Icon';

type Pattern = NonNullable<Exercise['pattern']>;

const LIBRARY: readonly Exercise[] = EXERCISES;

interface NowPlaying {
  id: string;
  midi: number | null;
  rep: number;
}

function styleLabel(key: StyleKey): string {
  return STYLE_LABELS[key]?.label ?? DIM_DISPLAY[key]?.name ?? key;
}

const KIND_LABELS: Record<Pattern['kind'], string> = {
  scale: 'Scale',
  arpeggio: 'Arpeggio',
  siren: 'Siren glide',
  sustain: 'Held notes',
};

/** "Scale · 5 notes at 120 bpm · 4 rounds, up 1 semitone each". */
export function describePattern(p: Pattern): string {
  const parts = [KIND_LABELS[p.kind] ?? 'Pattern'];
  if (p.kind !== 'siren') parts.push(`${p.steps.length} note${p.steps.length === 1 ? '' : 's'} at ${p.bpm} bpm`);
  const reps = Math.max(1, Math.floor(p.repetitions));
  const step = Math.round(p.stepUpSemitones);
  const move = step === 0 ? 'same key each time' : `${step > 0 ? 'up' : 'down'} ${Math.abs(step)} semitone${Math.abs(step) === 1 ? '' : 's'} each time`;
  parts.push(reps === 1 ? 'one round' : `${reps} rounds, ${move}`);
  return parts.join(' · ');
}

/** Lowest and highest note the whole pattern plays for this passaggio. */
export function patternSpan(p: Pattern, passaggioLowMidi: number): [number, number] | null {
  const { events } = patternSchedule(p, passaggioLowMidi);
  if (events.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of events) {
    lo = Math.min(lo, e.midi);
    hi = Math.max(hi, e.peakMidi ?? e.midi);
  }
  return [lo, hi];
}

function ExerciseCard(props: {
  ex: Exercise;
  passaggioLow: number;
  voiceLabel: string;
  canPlay: boolean;
  now: NowPlaying | null;
  onToggle: (ex: Exercise) => void;
  onRecordDrill?: (id: string) => void;
  focus?: boolean;
}): JSX.Element {
  const { ex, now } = props;
  const headingId = `ex-${ex.id}`;
  const playingThis = now?.id === ex.id;
  // The focus cards are the ones to do now, so their steps start open; the rest start closed.
  const [open, setOpen] = useState(!!props.focus);
  const span = ex.pattern ? patternSpan(ex.pattern, props.passaggioLow) : null;
  const reps = ex.pattern ? Math.max(1, Math.floor(ex.pattern.repetitions)) : 1;
  return (
    <article className={`ex-card${props.focus ? ' ex-card--focus' : ''}`} aria-labelledby={headingId}>
      <header className="ex-head">
        <h3 id={headingId} className="ex-name">
          {ex.name}
        </h3>
        <span className="ex-duration num">{ex.durationMin} min</span>
      </header>
      <p className="ex-goal">{ex.goal}</p>
      {ex.helps.length > 0 && (
        <ul className="ex-helps" aria-label="Helps with">
          {ex.helps.map((k) => (
            <li key={k} className="chip">
              {styleLabel(k)}
            </li>
          ))}
        </ul>
      )}
      {ex.steps.length > 0 && (
        <details className="ex-details" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary className="ex-details-summary">
            How to do it <span className="ex-details-count">({ex.steps.length} step{ex.steps.length === 1 ? '' : 's'})</span>
          </summary>
          <ol className="ex-steps">
            {ex.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </details>
      )}
      {ex.cautions && ex.cautions.length > 0 && (
        <div className="ex-cautions">
          <p className="ex-cautions-title">Take care</p>
          <ul>
            {ex.cautions.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {ex.pattern && (
        <div className="ex-pattern">
          <p className="ex-pattern-desc">
            {describePattern(ex.pattern)}. Starts on <span className="num">{midiToNoteName(patternStartMidi(ex.pattern, props.passaggioLow))}</span> for your{' '}
            {props.voiceLabel.toLowerCase()} voice
            {span && span[1] > span[0] ? (
              <>
                {' '}
                and covers <span className="num">{`${midiToNoteName(span[0])}–${midiToNoteName(span[1])}`}</span>
              </>
            ) : null}
            .
          </p>
          <div className="ex-player">
            <button
              type="button"
              className={`button button--small${playingThis ? ' button--accent' : ''}`}
              aria-pressed={playingThis}
              onClick={() => props.onToggle(ex)}
              disabled={!props.canPlay}
            >
              <Icon name={playingThis ? 'stop' : 'play'} size={14} /> {playingThis ? 'Stop' : 'Play pattern'}
            </button>
            {/* Visual only: a screen reader hears the page-level status (rounds, start and stop), not every note. */}
            <span className="ex-now num" aria-hidden="true">
              {playingThis && now?.midi !== null && now?.midi !== undefined ? `${midiToNoteName(now.midi)} · round ${now.rep + 1} of ${reps}` : ''}
            </span>
          </div>
        </div>
      )}
      {props.onRecordDrill && (
        <div className="ex-actions">
          <button type="button" className="button button--ghost button--small" onClick={() => props.onRecordDrill?.(ex.id)}>
            <Icon name="mic" size={14} /> Record this drill
          </button>
        </div>
      )}
    </article>
  );
}

function ReferencePitch(props: {
  passaggioLow: number;
  passaggioHigh: number;
  canPlay: boolean;
  droneOn: boolean;
  onPlay: (midi: number) => void;
  onDrone: (midi: number | null) => void;
}): JSX.Element {
  const lo = props.passaggioLow - 12;
  const hi = props.passaggioHigh + 5;
  const [midi, setMidi] = useState(props.passaggioLow);
  const note = Math.min(hi, Math.max(lo, midi));
  // A new voice type moves the passaggio; re-centre the picker on it.
  useEffect(() => setMidi(props.passaggioLow), [props.passaggioLow]);

  const options: number[] = [];
  for (let m = lo; m <= hi; m++) options.push(m);

  return (
    <section className="refpitch" aria-labelledby="refpitch-heading">
      <h2 id="refpitch-heading" className="subhead">
        Reference pitch
      </h2>
      <div className="refpitch-row">
        <label className="visually-hidden" htmlFor="refpitch-note">
          Note
        </label>
        <select
          id="refpitch-note"
          className="select refpitch-select num"
          value={note}
          onChange={(e) => {
            const m = Number(e.target.value);
            setMidi(m);
            if (props.droneOn) props.onDrone(m);
          }}
        >
          {options.map((m) => (
            <option key={m} value={m}>
              {midiToNoteName(m)}
              {m === props.passaggioLow ? ' (passaggio starts)' : ''}
            </option>
          ))}
        </select>
        <button type="button" className="button button--small" disabled={!props.canPlay} onClick={() => props.onPlay(note)}>
          <Icon name="play" size={14} /> Play
        </button>
        <button
          type="button"
          className={`button button--small${props.droneOn ? ' button--accent' : ''}`}
          aria-pressed={props.droneOn}
          disabled={!props.canPlay}
          onClick={() => props.onDrone(props.droneOn ? null : note)}
        >
          {props.droneOn ? 'Stop drone' : 'Hold drone'}
        </button>
      </div>
    </section>
  );
}

export function PracticePage(props: { settings: AppSettings; focusExerciseIds?: string[]; onRecordDrill?: (exerciseId: string) => void }): JSX.Element {
  const { settings, onRecordDrill } = props;
  const passaggio = passaggioFor(settings.voiceType);
  // Running text needs the bare name ("your baritone voice"), not the option-list gloss.
  const voiceLabel = VOICE_TYPE_NAMES[settings.voiceType] ?? settings.voiceType;
  const canPlay = audioSupported();
  const [filter, setFilter] = useState<StyleKey | 'all'>('all');
  const [now, setNow] = useState<NowPlaying | null>(null);
  const playerRef = useRef<PatternPlayer | null>(null);
  const runRef = useRef(0);
  const droneRef = useRef<{ stop(): void } | null>(null);
  const [droneOn, setDroneOn] = useState(false);
  // What the screen-reader status says: start, each new round, the end or a stop. Never each note.
  const [announce, setAnnounce] = useState('');

  const byId = useMemo(() => new Map(LIBRARY.map((e) => [e.id, e])), []);
  const focus = useMemo(() => {
    const seen = new Set<string>();
    const out: Exercise[] = [];
    for (const id of props.focusExerciseIds ?? []) {
      const ex = byId.get(id);
      if (ex && !seen.has(id)) {
        seen.add(id);
        out.push(ex);
      }
    }
    return out;
  }, [props.focusExerciseIds, byId]);
  const focusIds = new Set(focus.map((e) => e.id));

  const filterKeys = useMemo(() => {
    const keys: StyleKey[] = [];
    for (const e of LIBRARY) for (const k of e.helps) if (!keys.includes(k)) keys.push(k);
    return keys;
  }, []);
  const activeFilter = filter !== 'all' && filterKeys.includes(filter) ? filter : 'all';
  const library = LIBRARY.filter((e) => !focusIds.has(e.id) && (activeFilter === 'all' || e.helps.includes(activeFilter)));

  const stopPattern = () => {
    const wasPlaying = playerRef.current !== null;
    runRef.current++;
    playerRef.current?.stop();
    playerRef.current = null;
    setNow(null);
    if (wasPlaying) setAnnounce('Pattern stopped.');
  };
  const stopDrone = () => {
    droneRef.current?.stop();
    droneRef.current = null;
    setDroneOn(false);
  };
  // Leaving the page silences everything.
  useEffect(
    () => () => {
      runRef.current++;
      playerRef.current?.stop();
      droneRef.current?.stop();
    },
    [],
  );

  // Only one sound source at a time: the drone, a single note, or a pattern.
  const onDrone = (midi: number | null) => {
    stopPattern();
    stopDrone();
    if (midi === null) return;
    droneRef.current = startDrone(midi, { a4Hz: settings.a4Hz });
    setDroneOn(true);
  };
  const onPlayNote = (midi: number) => {
    stopPattern();
    stopDrone();
    playNote(midi, 1.5, { a4Hz: settings.a4Hz });
  };

  const toggle = (ex: Exercise) => {
    if (now?.id === ex.id) return stopPattern();
    stopPattern();
    stopDrone();
    const run = runRef.current;
    const reps = ex.pattern ? Math.max(1, Math.floor(ex.pattern.repetitions)) : 1;
    let lastRep = -1;
    setNow({ id: ex.id, midi: null, rep: 0 });
    setAnnounce(`Playing ${ex.name}.`);
    playerRef.current = playPattern(ex, passaggio.lowMidi, {
      a4Hz: settings.a4Hz,
      onStep: (midi, rep) => {
        if (runRef.current !== run) return;
        setNow({ id: ex.id, midi, rep });
        if (rep !== lastRep) {
          lastRep = rep;
          const where = `starting on ${midiToNoteName(midi)}`;
          const round = reps > 1 ? `round ${rep + 1} of ${reps}, ${where}` : where;
          setAnnounce(rep === 0 ? `Playing ${ex.name}: ${round}.` : `Round ${rep + 1} of ${reps}, ${where}.`);
        }
      },
      onEnd: () => {
        if (runRef.current !== run) return;
        playerRef.current = null;
        setNow(null);
        setAnnounce('Pattern finished.');
      },
    });
  };

  const card = (ex: Exercise, isFocus = false) => (
    <ExerciseCard
      key={ex.id}
      ex={ex}
      focus={isFocus}
      passaggioLow={passaggio.lowMidi}
      voiceLabel={voiceLabel}
      canPlay={canPlay}
      now={now}
      onToggle={toggle}
      onRecordDrill={onRecordDrill}
    />
  );

  return (
    <div className="page page--practice">
      <header className="page-head">
        <p className="eyebrow">Practice</p>
        <h1 className="page-title">Drills for your mix</h1>
        <p className="lede">
          Patterns are pitched for your {voiceLabel.toLowerCase()} voice, whose passaggio sits around{' '}
          <span className="num">{`${midiToNoteName(passaggio.lowMidi)}–${midiToNoteName(passaggio.highMidi)}`}</span>. Change your voice type in{' '}
          <a href="#settings">Settings</a>.
        </p>
        <p className="practice-safety">
          Keep every drill light and easy. If anything scratches, tightens or hurts, stop, sip water and rest. Skip notes that feel out of
          reach today; you don’t need to finish every round.
        </p>
      </header>

      <p className="visually-hidden" role="status" aria-live="polite">
        {announce}
      </p>

      {!canPlay && (
        <p className="practice-noaudio" role="status">
          This browser cannot play practice tones, so the pattern player is off. The steps below still work on their own, or with a piano app.
        </p>
      )}

      {focus.length > 0 && (
        <section className="practice-section" aria-labelledby="practice-focus">
          <div className="section-head">
            <h2 id="practice-focus" className="section-title">
              For you
            </h2>
            <p className="section-sub">Picked from your latest coaching plan, most useful first.</p>
          </div>
          <div className="ex-grid">{focus.map((ex) => card(ex, true))}</div>
        </section>
      )}

      <ReferencePitch
        passaggioLow={passaggio.lowMidi}
        passaggioHigh={passaggio.highMidi}
        canPlay={canPlay}
        droneOn={droneOn}
        onPlay={onPlayNote}
        onDrone={onDrone}
      />

      <section className="practice-section" aria-labelledby="practice-library">
        <div className="section-head">
          <h2 id="practice-library" className="section-title">
            {focus.length > 0 ? 'More exercises' : 'Exercise library'}
          </h2>
        </div>
        {filterKeys.length > 0 && (
          <div className="filter-chips" role="group" aria-label="Show exercises that help with">
            <button type="button" className="filter-chip" aria-pressed={activeFilter === 'all'} onClick={() => setFilter('all')}>
              All
            </button>
            {filterKeys.map((k) => (
              <button key={k} type="button" className="filter-chip" aria-pressed={activeFilter === k} onClick={() => setFilter(k)}>
                {styleLabel(k)}
              </button>
            ))}
          </div>
        )}
        {library.length > 0 ? (
          <div className="ex-grid">{library.map((ex) => card(ex))}</div>
        ) : (
          <p className="muted">
            {activeFilter === 'all' ? 'Every exercise is in your “For you” list above.' : 'No other exercises target this yet. Try another filter.'}
          </p>
        )}
      </section>
    </div>
  );
}
