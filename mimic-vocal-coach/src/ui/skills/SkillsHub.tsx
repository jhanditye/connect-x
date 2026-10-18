// The Skills hub: the daily workout first, then one card per exercise with its last result, then the preferences
// every Skills screen shares (strictness, how degrees are shown, the key mode, prompt volume, the comfortable range).
// See src/skills/SPEC.md section 6.

import { useMemo, useState, type MouseEvent } from 'react';
import { VOICE_TYPE_NAMES } from '../../analysis/passaggio';
import { midiToNoteName } from '../../dsp/music';
import { isDesktopKind, platformKind } from '../../pwa/platform';
import { skillsHash } from '../../state/routing';
import { lastSessionOf, practiceDays, sessionHeadline } from '../../skills/progress/history';
import { buildWorkout, workoutSeconds } from '../../skills/progress/workout';
import { noteEvents } from '../../skills/theory/prompts';
import { mulberry32 } from '../../skills/theory/rng';
import { SCALE_MODE_LABELS } from '../../skills/theory/scales';
import {
  STRICTNESS_CENTS,
  STRICTNESS_LABELS,
  type LabelMode,
  type ScaleMode,
  type SkillsExerciseKind,
  type SkillsPrefs,
  type SkillsSession,
  type SkillsStore,
  type SkillsView,
  type Strictness,
} from '../../skills/types';
import type { AppSettings } from '../../types';
import { Icon } from '../components/Icon';
import { loadPromptVolume, playPrompt, savePromptVolume } from './kit/sound';
import { aboutMinutes, plural, rangeFor } from './kit/session';
import { Segmented } from './kit/Widgets';
import './kit/skills-shell.css';

export interface HubCard {
  view: Exclude<SkillsView, 'hub' | 'workout' | 'progress'>;
  kind: SkillsExerciseKind;
  tag: string;
  name: string;
  about: string;
}

/** The exercise cards, in the order a singer would usually work through them. */
export const HUB_CARDS: readonly HubCard[] = [
  {
    view: 'pitch-test',
    kind: 'pitch-test',
    tag: 'Test',
    name: 'How accurate is my pitch?',
    about: 'Ten notes across your range. Hear each one, sing it back and hold it: see how close you land, how steady you hold, and whether you tend sharp or flat.',
  },
  {
    view: 'match',
    kind: 'match',
    tag: 'Practise',
    name: 'Match the note',
    about: 'A note plays, then a live needle shows where your voice is against it. Lock in for 1.5 seconds to pass.',
  },
  {
    view: 'ear',
    kind: 'ear',
    tag: 'Listen',
    name: 'Interval ear training',
    about: 'Hear two notes and name the interval, or hear a note in a key and name its scale degree. No microphone needed.',
  },
  {
    view: 'sing-intervals',
    kind: 'sing-intervals',
    tag: 'Sing',
    name: 'Sing intervals',
    about: 'Sing a starting note, then a major 6th up (or any interval). The size of the jump is scored on its own, whatever note you started on.',
  },
  {
    view: 'sequence',
    kind: 'sequence',
    tag: 'Sing',
    name: 'Scale-degree lines',
    about: 'The key is set by a few chords, then you sing a line like 7 6 5 4 3 2 or 2 7 6 5 in one go. Every note is checked against the key.',
  },
  {
    view: 'breath',
    kind: 'breath',
    tag: 'Breathe',
    name: 'Breath control',
    about: 'Paced breathing with a guide, a steady "sss" hiss test, and a long held note: how long, and how steady.',
  },
];

/** "today", "yesterday", "3 days ago", or a date. */
export function whenText(at: string, now: Date = new Date()): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return '';
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(new Date(t))) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  try {
    return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(t);
  } catch {
    return new Date(t).toISOString().slice(0, 10);
  }
}

/** The last result of a kind as a short line, or null when it has never been done. */
export function lastResultLine(sessions: readonly SkillsSession[], kind: SkillsExerciseKind, now?: Date): { text: string; when: string } | null {
  const s = lastSessionOf(sessions, kind);
  if (!s) return null;
  return { text: sessionHeadline(s).text, when: whenText(s.at, now) };
}

const STRICTNESS_HINT: Record<Strictness, string> = {
  gentle: 'Within 50 cents (half a semitone) counts as in tune. Good for a first week.',
  standard: 'Within 25 cents (a quarter of a semitone) counts as in tune. A careful listener hears more than this as out of tune.',
  strict: 'Within 15 cents counts as in tune: close to what a good choir aims for.',
};

const LABEL_OPTIONS: { value: LabelMode; label: string }[] = [
  { value: 'numbers', label: '1 2 3' },
  { value: 'solfege', label: 'do re mi' },
  { value: 'names', label: 'C D E' },
];

export function SkillsHub(props: { store: SkillsStore; settings: AppSettings; onOpen(view: SkillsView): void; onPrefs(patch: Partial<SkillsPrefs>): void }) {
  const { store, settings } = props;
  const prefs = store.prefs;
  const desk = isDesktopKind(platformKind());
  const days = practiceDays(store.sessions);
  // A fixed seed: the estimate only needs the shape of today's workout, not its notes.
  const workout = useMemo(() => buildWorkout(store, settings, mulberry32(1)), [store, settings]);
  const range = rangeFor(settings, prefs);
  const [volume, setVolume] = useState(() => loadPromptVolume());
  const lastWorkout = lastResultLine(store.sessions, 'workout');

  const open = (view: SkillsView) => (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    props.onOpen(view);
  };

  return (
    <div className="sk-screen sk-hub">
      <header className="page-head">
        <p className="eyebrow">Skills</p>
        <h1 className="page-title">Build the fundamentals</h1>
        <p className="lede">
          Short, focused practice for the basics every singer needs: landing notes in tune, hearing and singing intervals, singing scale-degree
          lines in one go, and breath control. Pitch is measured in cents: 100 cents is one semitone.
        </p>
      </header>

      {store.sessions.length > 0 && (
        <ul className="sk-stats-strip" aria-label="Your practice">
          <li>
            <strong>{days.days}</strong> {days.days === 1 ? 'day' : 'days'} practised
          </li>
          {days.streak > 0 && (
            <li>
              Streak <strong>{days.streak}</strong> {days.streak === 1 ? 'day' : 'days'}
              {!days.practisedToday ? ' (practise today to keep it)' : ''}
            </li>
          )}
          <li>
            <strong>{days.last7}</strong> {days.last7 === 1 ? 'session' : 'sessions'} this week
          </li>
        </ul>
      )}

      <section className="sk-card sk-feature" aria-labelledby="sk-workout-h">
        <div>
          <p className="sk-hub-card-tag">Daily</p>
          <h2 id="sk-workout-h" className="sk-feature-title">
            Today’s workout
          </h2>
          <p>
            {aboutMinutes(workoutSeconds(workout))}, built from what you find hardest: breathing, matching notes, intervals by ear and by voice,
            two scale-degree lines and a hiss test. Skip any step you like.
          </p>
          {lastWorkout && (
            <p className="sk-hub-card-last">
              Last workout: {lastWorkout.text} <span className="sk-hub-card-when">· {lastWorkout.when}</span>
            </p>
          )}
          <div className="button-row">
            <a className="button button--accent" href={skillsHash({ view: 'workout' })} onClick={open('workout')}>
              <Icon name="play" size={16} /> Start the workout
            </a>
            <a className="button" href={skillsHash({ view: 'progress' })} onClick={open('progress')}>
              <Icon name="progress" size={16} /> Your progress
            </a>
          </div>
        </div>
        <ol className="sk-steps" aria-label="Workout steps">
          {workout.map((s, i) => (
            <li key={i}>
              <span>{s.label}</span>
              <span className="sk-steps-time">{Math.max(1, Math.round(s.estSec / 60))} min</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="sk-section" aria-labelledby="sk-ex-h">
        <h2 id="sk-ex-h" className="section-title">
          Exercises
        </h2>
        <p className="section-sub">Each one on its own, as often as you like. Note accuracy is the place to start.</p>
        <ul className="sk-hub-grid">
          {HUB_CARDS.map((c) => {
            const last = lastResultLine(store.sessions, c.kind);
            return (
              <li key={c.view}>
                <a className="sk-hub-card" href={skillsHash({ view: c.view })} onClick={open(c.view)} data-view={c.view}>
                  <span className="sk-hub-card-tag">{c.tag}</span>
                  <span className="sk-hub-card-name">{c.name}</span>
                  <span className="sk-hub-card-about">{c.about}</span>
                  {last ? (
                    <span className="sk-hub-card-last">
                      Last time: {last.text} <span className="sk-hub-card-when">· {last.when}</span>
                    </span>
                  ) : (
                    <span className="sk-hub-card-last sk-hub-card-last--none">Not tried yet</span>
                  )}
                </a>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="sk-section" aria-labelledby="sk-prefs-h">
        <h2 id="sk-prefs-h" className="section-title">
          Skills preferences
        </h2>
        <p className="section-sub">These apply to every Skills exercise and are kept on this device.</p>
        <div className="sk-card sk-prefs">
          <div>
            <Segmented<Strictness>
              legend="Strictness"
              value={prefs.strictness}
              options={(['gentle', 'standard', 'strict'] as Strictness[]).map((s) => ({ value: s, label: `${STRICTNESS_LABELS[s]} · ${STRICTNESS_CENTS[s]}¢` }))}
              onChange={(strictness) => props.onPrefs({ strictness })}
              hint={STRICTNESS_HINT[prefs.strictness]}
            />
            <Segmented<LabelMode>
              legend="Show scale degrees as"
              value={prefs.labelMode}
              options={LABEL_OPTIONS}
              onChange={(labelMode) => props.onPrefs({ labelMode })}
              hint={
                prefs.labelMode === 'solfege'
                  ? 'Movable do: do is always the key note. Minor keys use me, le and te for the lowered notes.'
                  : prefs.labelMode === 'names'
                    ? 'Note names in the key of each exercise.'
                    : 'Numbers: 1 is the key note, 8 the key note an octave up.'
              }
            />
            <Segmented<ScaleMode>
              legend="Key for lines and degrees"
              value={prefs.scaleMode}
              options={(['major', 'natural-minor', 'harmonic-minor'] as ScaleMode[]).map((m) => ({ value: m, label: SCALE_MODE_LABELS[m] }))}
              onChange={(scaleMode) => props.onPrefs({ scaleMode })}
            />
          </div>
          <div>
            <div className="field sk-field">
              <label className="field-label" htmlFor="sk-volume">
                Prompt volume
              </label>
              <div className="sk-volume">
                <input
                  id="sk-volume"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={volume}
                  onChange={(e) => setVolume(savePromptVolume(Number(e.target.value)))}
                  aria-valuetext={`${Math.round(volume * 100)} percent`}
                />
                <button type="button" className="button button--small" onClick={() => playPrompt(noteEvents(Math.round((range.lowMidi + range.highMidi) / 2), 1), settings.a4Hz)}>
                  <Icon name="play" size={14} /> Test note
                </button>
              </div>
              <p className="field-hint">
                The piano notes that set each exercise up. They always finish before the microphone opens, so they never end up in your take.
              </p>
            </div>
            <div className="field sk-field">
              <p className="field-label">Comfortable range</p>
              <p className="settings-text">
                <span className="num">{midiToNoteName(range.lowMidi)}</span> to <span className="num">{midiToNoteName(range.highMidi)}</span>
                {prefs.rangeOverride ? ' (your own range)' : ` for a ${VOICE_TYPE_NAMES[settings.voiceType] ?? settings.voiceType}`}. Every note an exercise asks
                for sits inside it. {prefs.rangeOverride ? null : <>Change your voice type in <a href="#settings">Settings</a>.</>}
              </p>
              {prefs.rangeOverride && (
                <button type="button" className="button button--small" onClick={() => props.onPrefs({ rangeOverride: null })}>
                  Use my voice type’s range
                </button>
              )}
            </div>
            {prefs.headphones !== null && (
              <div className="field sk-field">
                <p className="field-label">Headphones</p>
                <p className="settings-text">
                  You said you {prefs.headphones ? 'practise with' : 'practise without'} headphones
                  {prefs.headphones ? ', so Match the note can keep a drone sounding while you sing.' : '.'}
                </p>
                <button type="button" className="button button--small" onClick={() => props.onPrefs({ headphones: null })}>
                  Ask me again
                </button>
              </div>
            )}
          </div>
        </div>
        {desk && <p className="caveat">On a keyboard: Space plays or replays, Return starts and stops singing, number keys answer.</p>}
        <p className="caveat">
          {plural(store.sessions.length, 'Skills session')} saved on this device. They are included in a library backup and removed by “Delete
          everything” in Settings. No audio is kept.
        </p>
      </section>
    </div>
  );
}
