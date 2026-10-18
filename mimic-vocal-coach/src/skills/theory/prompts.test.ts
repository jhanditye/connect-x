import { describe, expect, it } from 'vitest';
import { BREATH_SAFETY_NOTES, pacedBreathPlan, pacedPlanSeconds } from './breath';
import { PROMPT_TIMING, cadenceEvents, compareIntervalEvents, concatEvents, earQuestionEvents, eventsDuration, intervalEvents, lineEvents } from './prompts';

describe('prompt events', () => {
  it('melodic interval: two notes in order; harmonic: one chord', () => {
    const up = intervalEvents(60, 9, 'up');
    expect(up.map((e) => e.midis)).toEqual([[60], [69]]);
    expect(up[1].startSec).toBeCloseTo(PROMPT_TIMING.intervalNoteSec + PROMPT_TIMING.intervalGapSec, 9);
    expect(intervalEvents(60, 9, 'down')[1].midis).toEqual([51]);
    const h = intervalEvents(60, 4, 'harmonic');
    expect(h).toHaveLength(1);
    expect(h[0].midis).toEqual([60, 64]);
  });

  it('cadence: four chords then the tonic, in order, no overlap of the tonic', () => {
    const ev = cadenceEvents({ tonicMidi: 60, mode: 'major' });
    expect(ev.map((e) => e.role)).toEqual(['cadence', 'cadence', 'cadence', 'cadence', 'tonic']);
    expect(ev[4].midis).toEqual([60]);
    expect(ev[4].startSec).toBeGreaterThanOrEqual(ev[3].startSec + ev[3].durSec);
    for (let i = 1; i < ev.length; i++) expect(ev[i].startSec).toBeGreaterThan(ev[i - 1].startSec);
  });

  it('line events index each note', () => {
    const ev = lineEvents({ midis: [71, 69, 67] });
    expect(ev.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(eventsDuration(ev)).toBeCloseTo(2 * (PROMPT_TIMING.lineNoteSec + PROMPT_TIMING.lineGapSec) + PROMPT_TIMING.lineNoteSec, 9);
  });

  it('concat shifts the second list after the first plus the gap', () => {
    const a = intervalEvents(60, 7, 'up');
    const b = intervalEvents(60, 5, 'up');
    const c = concatEvents(a, b, 0.5);
    expect(c[2].startSec).toBeCloseTo(eventsDuration(a) + 0.5, 9);
    expect(a[0].startSec).toBe(0); // inputs untouched
  });

  it('degree question: cadence without the tonic, then the degree note', () => {
    const ev = earQuestionEvents({ kind: 'degree', id: 'x', key: { tonicMidi: 57, mode: 'major' }, degree: 5, midi: 64, choices: [1, 2, 3, 4, 5, 6, 7] });
    expect(ev.filter((e) => e.role === 'tonic')).toHaveLength(0);
    expect(ev[ev.length - 1].midis).toEqual([64]);
  });

  it('compare after a wrong answer: yours first, then the right one', () => {
    const ev = compareIntervalEvents(60, 5, 7, 'up');
    expect(ev.map((e) => e.midis[0])).toEqual([60, 65, 60, 67]);
    expect(ev.slice(0, 2).every((e) => e.role === 'answer')).toBe(true);
  });
});

describe('paced breathing', () => {
  it('default: 5 rounds of inhale 4, suspend 4, exhale 8 growing by 2', () => {
    expect(pacedBreathPlan().map((r) => r.exhale)).toEqual([8, 10, 12, 14, 16]);
    expect(pacedBreathPlan()[0]).toEqual({ inhale: 4, suspend: 4, exhale: 8 });
  });

  it('the exhale is capped', () => {
    expect(pacedBreathPlan({ rounds: 10 }).map((r) => r.exhale).slice(-3)).toEqual([20, 20, 20]);
  });

  it('plan length in seconds includes rests between rounds', () => {
    const plan = pacedBreathPlan({ rounds: 2 });
    expect(pacedPlanSeconds(plan, 1, 4)).toBe(16 + 4 + 18);
  });

  it('safety notes cover dizziness, normal breathing, the last air, throat tension and "not medical advice"', () => {
    const all = BREATH_SAFETY_NOTES.join(' ');
    for (const w of [/dizzy/, /normally between rounds/, /last air/, /throat/, /not medical advice/]) expect(all).toMatch(w);
  });
});
