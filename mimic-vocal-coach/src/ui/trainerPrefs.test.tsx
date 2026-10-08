// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TRAINER_PREFS, loadTrainerPrefs, parseTrainerPrefs, saveTrainerPrefs, useTrainerPrefs } from './trainerPrefs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('trainer preferences', () => {
  it('start from the defaults: full speed, three beats, automatic, recordings not kept', () => {
    expect(loadTrainerPrefs()).toEqual(DEFAULT_TRAINER_PREFS);
    expect(DEFAULT_TRAINER_PREFS).toEqual({ defaultRate: 1, countInBeats: 3, startMode: 'auto', keepRecordings: false });
  });

  it('save merges a change and load reads it back', () => {
    expect(saveTrainerPrefs({ keepRecordings: true })).toMatchObject({ keepRecordings: true, defaultRate: 1 });
    saveTrainerPrefs({ defaultRate: 0.75, startMode: 'turn-taking' });
    expect(loadTrainerPrefs()).toEqual({ defaultRate: 0.75, countInBeats: 3, startMode: 'turn-taking', keepRecordings: true });
  });

  it('snaps odd stored numbers to a choice and ignores garbage', () => {
    expect(parseTrainerPrefs({ defaultRate: 0.8, countInBeats: 9 })).toMatchObject({ defaultRate: 0.75, countInBeats: 4 });
    expect(parseTrainerPrefs({ defaultRate: 'fast', countInBeats: null, startMode: 'loud', keepRecordings: 'yes' })).toEqual(DEFAULT_TRAINER_PREFS);
    expect(parseTrainerPrefs(null)).toEqual(DEFAULT_TRAINER_PREFS);
    expect(parseTrainerPrefs([1, 2])).toEqual(DEFAULT_TRAINER_PREFS);
  });

  it('survive unreadable stored text', () => {
    localStorage.setItem('mimic.trainerPrefs', '{not json');
    expect(loadTrainerPrefs()).toEqual(DEFAULT_TRAINER_PREFS);
  });

  it('a change made in one place shows up in every screen that reads them', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    document.body.append(a, b);
    const seen: string[] = [];
    function Reader({ name }: { name: string }) {
      const [prefs, update] = useTrainerPrefs();
      seen.push(`${name}:${prefs.countInBeats}`);
      return <button onClick={() => update({ countInBeats: 4 })}>{name}</button>;
    }
    const ra = createRoot(a);
    const rb = createRoot(b);
    act(() => {
      ra.render(<Reader name="a" />);
      rb.render(<Reader name="b" />);
    });
    act(() => a.querySelector('button')?.click());
    expect(seen).toContain('b:4');
    expect(loadTrainerPrefs().countInBeats).toBe(4);
    act(() => {
      ra.unmount();
      rb.unmount();
    });
    a.remove();
    b.remove();
  });
});
