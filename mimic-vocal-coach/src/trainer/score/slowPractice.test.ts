// Slow practice must score. A take that follows a guide played at 50-90 % speed runs 1 / rate times longer than the reference; the
// scorer lays the reference out at that speed (guideRate) and judges tempo against it, so a perfect slow copy is a perfect copy,
// with the turn-taking take (the singer hears the slowed guide, then sings) and with the sing-along take alike.
import { describe, expect, it } from 'vitest';
import { comparePhrase } from '../compare';
import { scoreAttempt } from './score';
import { PH_A, PH_RUN, attemptAnalysis, refAnalysis, tempo, type PNote } from './testkit';
import * as I from './testkit';

/** About 13 s: the long case (segmentation allows phrases up to 12 s). */
const LONG: PNote[] = [...PH_A, { midi: 60, durSec: 0.5 }, { midi: 62, durSec: 0.5 }, { midi: 64, durSec: 0.6 }, { midi: 67, durSec: 1.2 }];

describe('a perfect slow copy is a perfect copy', () => {
  for (const [label, notes] of [['9 s phrase', PH_A], ['phrase with a fast run', PH_RUN], ['13 s phrase', LONG]] as const) {
    it(`${label}: 0.5, 0.6, 0.75 and 0.9 speed, sung exactly at that speed`, () => {
      const ref = refAnalysis(notes);
      for (const rate of [0.9, 0.75, 0.6, 0.5]) {
        const att = attemptAnalysis({ notes: tempo(notes, 1 / rate), seed: 77, lead: 1.6 });
        const r = scoreAttempt(ref, att, { rate, mode: 'turn-taking' });
        expect(r.status, `rate ${rate}`).toBe('ok');
        expect(r.overall as number, `rate ${rate}`).toBeGreaterThanOrEqual(96);
        expect(r.skills.timing as number, `rate ${rate}`).toBeGreaterThanOrEqual(95);
        expect(Math.abs((r.timing.tempoRatio as number) - 1), `rate ${rate}`).toBeLessThan(0.03);
        expect(r.fixes, `rate ${rate}`).toEqual([]);
        // the reported windows stay in the reference's own time
        expect(r.perNote[3].refStart).toBeCloseTo(ref.notes[3].start, 6);
        expect(r.diagnostics.mode).toBe('turn-taking');
      }
    }, 120_000);
  }

  it('guideRate is the explicit name for the same thing, and wins over rate', () => {
    const ref = refAnalysis(PH_A);
    const att = attemptAnalysis({ notes: tempo(PH_A, 2), seed: 77, lead: 1.6 });
    const viaRate = scoreAttempt(ref, att, { rate: 0.5 });
    const viaGuide = scoreAttempt(ref, att, { guideRate: 0.5 });
    expect(viaGuide.overall).toBe(viaRate.overall);
    expect(viaGuide.status).toBe('ok');
    // told the guide was at full speed, the same take is twice as slow as expected (and is not a match)
    const wrong = scoreAttempt(ref, att, { rate: 0.5, guideRate: 1 });
    expect(wrong.status === 'no-match' || (wrong.timing.tempoRatio as number) > 1.7).toBe(true);
  });

  it('the sing-along take against a slowed guide: ok, the lag is found against the schedule', () => {
    const ref = refAnalysis(PH_A);
    for (const rate of [0.75, 0.5]) {
      const att = attemptAnalysis({ notes: tempo(PH_A, 1 / rate), seed: 77, lead: 2.15 + 0.1 });
      const c = comparePhrase(att, ref, { mode: 'sing-along', rate, keyMode: 'locked', refStartInCaptureSec: 2.0 });
      expect(c.score.status, `rate ${rate}`).toBe('ok');
      expect(c.score.overall as number, `rate ${rate}`).toBeGreaterThanOrEqual(90);
      expect(c.score.timing.lagMs).not.toBeNull();
      expect(Math.abs(c.score.timing.lagMs as number), `rate ${rate}`).toBeLessThan(400);
    }
  }, 120_000);
});

describe('slow takes are still judged: they can be a little off', () => {
  it('10 % faster and 10 % / 20 % slower than the chip are scored, with a tempo reading that says so', () => {
    const ref = refAnalysis(PH_A);
    for (const rate of [0.75, 0.5]) {
      for (const [err, lo, hi] of [[0.9, 0.86, 0.94], [1.1, 1.06, 1.14], [1.2, 1.16, 1.24]] as const) {
        const att = attemptAnalysis({ notes: tempo(PH_A, err / rate), seed: 77, lead: 1.6 });
        const r = scoreAttempt(ref, att, { rate });
        expect(r.status, `rate ${rate} x${err}`).toBe('ok');
        expect(r.timing.tempoRatio as number, `rate ${rate} x${err}`).toBeGreaterThan(lo);
        expect(r.timing.tempoRatio as number, `rate ${rate} x${err}`).toBeLessThan(hi);
        expect(r.skills.pitch as number).toBeGreaterThanOrEqual(97);
      }
    }
  }, 120_000);

  it('a wrong note at slow speed is still a wrong note', () => {
    const ref = refAnalysis(PH_A);
    const att = attemptAnalysis({ notes: tempo(I.wrongNote(PH_A, 2, 2), 2), seed: 77, lead: 1.6 });
    const r = scoreAttempt(ref, att, { rate: 0.5 });
    expect(r.status).toBe('ok');
    expect(r.fixes.map((f) => f.id)).toContain('pitch.wrong-notes');
  });
});

describe('the gate still protects: slowing the reference does not make everything match', () => {
  it('an unrelated melody and a scrambled phrase, sung at the slowed speed, are not a match', () => {
    const ref = refAnalysis(PH_A);
    const scrambled = I.clone(PH_A).map((n, i, a) => ({ ...n, midi: a[(i * 5 + 3) % a.length].midi, vibrato: null }));
    for (const rate of [1, 0.75, 0.5]) {
      for (const [label, notes] of [['PH_RUN', PH_RUN], ['scrambled', scrambled]] as const) {
        const r = scoreAttempt(ref, attemptAnalysis({ notes: tempo(notes, 1 / rate), seed: 9, lead: 1.5 }), { rate });
        expect(r.status, `${label} at rate ${rate}`).toBe('no-match');
        expect(r.fixes).toEqual([]);
      }
    }
  }, 120_000);

  it('the phrase sung twice as fast as a half-speed guide is not a match either (implausible tempo)', () => {
    const ref = refAnalysis(PH_A);
    const r = scoreAttempt(ref, attemptAnalysis({ notes: PH_A, seed: 77, lead: 1.6 }), { rate: 0.5 });
    expect(r.status).toBe('no-match');
  });
});
