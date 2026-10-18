// The Skills section (#skills/...): owns the Skills store (useSyncExternalStore on the progress store, so another tab
// or "Delete everything" shows up at once), reads the sub-view from the hash and renders the hub, an exercise screen,
// the daily workout or the progress screen. Finished sessions and preference changes are saved here.
// See src/skills/SPEC.md section 6.

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { goSkills, useSkillsPath } from '../../state/routing';
import { loadSkillsStore, recordSkillsSession, saveSkillsStore, subscribeSkillsStore, updateSkillsPrefs } from '../../skills/progress/store';
import type { SkillsPrefs, SkillsSession, SkillsView } from '../../skills/types';
import type { AppSettings } from '../../types';
import { EarTrainingScreen } from './EarTrainingScreen';
import { SkillsHub } from './SkillsHub';
import { SkillsProgressScreen } from './SkillsProgressScreen';
import { WorkoutScreen } from './WorkoutScreen';
import { BreathScreen } from './sing/BreathScreen';
import { MatchNoteScreen } from './sing/MatchNoteScreen';
import { PitchTestScreen } from './sing/PitchTestScreen';
import { SequenceScreen } from './sing/SequenceScreen';
import { SingIntervalsScreen } from './sing/SingIntervalsScreen';
import { loadPromptVolume, stopPrompt } from './kit/sound';
import './kit/skills-shell.css';

/** Saves a finished session on top of the newest stored copy (never a stale snapshot). */
export function recordSession(s: SkillsSession): boolean {
  return saveSkillsStore(recordSkillsSession(loadSkillsStore(), s));
}

/** Saves a preference change on top of the newest stored copy. */
export function savePrefs(patch: Partial<SkillsPrefs>): boolean {
  return saveSkillsStore(updateSkillsPrefs(loadSkillsStore(), patch));
}

export function SkillsPage(props: { settings: AppSettings }) {
  const { settings } = props;
  const store = useSyncExternalStore(subscribeSkillsStore, loadSkillsStore, loadSkillsStore);
  const path = useSkillsPath();
  const seed = path.seed ?? undefined;
  const rootRef = useRef<HTMLDivElement>(null);
  const firstView = useRef(true);

  useEffect(() => {
    loadPromptVolume();
    return () => stopPrompt();
  }, []);

  // A new sub-view starts at the top with focus on it (keyboard and screen-reader users), as a new page does.
  useEffect(() => {
    stopPrompt();
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    try {
      window.scrollTo?.({ top: 0 });
    } catch {
      // jsdom and some embedded browsers do not scroll.
    }
    rootRef.current?.focus({ preventScroll: true });
  }, [path.view, path.seed]);

  const open = useCallback((view: SkillsView) => goSkills({ view }), []);
  const exit = useCallback(() => goSkills({ view: 'hub' }), []);
  const onDone = useCallback((s: SkillsSession) => void recordSession(s), []);
  const onPrefs = useCallback((patch: Partial<SkillsPrefs>) => void savePrefs(patch), []);

  const common = { settings, prefs: store.prefs, stats: store.stats, seed, onExit: exit, onPrefs, onDone };
  const key = `${path.view}-${path.seed ?? 'r'}`;

  let body;
  switch (path.view) {
    case 'hub':
      body = <SkillsHub store={store} settings={settings} onOpen={open} onPrefs={onPrefs} />;
      break;
    case 'pitch-test':
      body = <PitchTestScreen key={key} {...common} />;
      break;
    case 'match':
      body = <MatchNoteScreen key={key} {...common} />;
      break;
    case 'ear':
      body = <EarTrainingScreen key={key} {...common} />;
      break;
    case 'sing-intervals':
      body = <SingIntervalsScreen key={key} {...common} />;
      break;
    case 'sequence':
      body = <SequenceScreen key={key} {...common} />;
      break;
    case 'breath':
      body = <BreathScreen key={key} {...common} />;
      break;
    case 'workout':
      body = <WorkoutScreen key={key} {...common} store={store} onStepDone={onDone} />;
      break;
    case 'progress':
      body = <SkillsProgressScreen store={store} settings={settings} onExit={exit} />;
      break;
  }

  return (
    <div className="page page--skills" ref={rootRef} tabIndex={-1} data-view={path.view}>
      {body}
    </div>
  );
}
