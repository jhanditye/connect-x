import { describe, expect, it, vi } from 'vitest';
import { analyzeTake } from '../analysis/analyze';
import { synthMelody, type MelodyNote } from '../testing/synth';
import { median } from './stats';
import { resample } from './resample';
import {
  abortError,
  chooseResampleTarget,
  createGuideJob,
  createResampleJob,
  createStretchJob,
  pitchShiftKeepDuration,
  renderGuide,
  renderGuideAsync,
  wsolaStretch,
} from './timestretch';

const SR = 22050;
// The 8-note line used across the trainer tests: G3 B3 D4 E4 D4 C4 A3 G3, 6.1 s, vowel a, vibrato from 0.25 s.
const NOTES: MelodyNote[] = [
  { midi: 55, durSec: 0.7 },
  { midi: 59, durSec: 0.5 },
  { midi: 62, durSec: 0.6 },
  { midi: 64, durSec: 1.2 },
  { midi: 62, durSec: 0.5 },
  { midi: 60, durSec: 0.6 },
  { midi: 57, durSec: 0.7 },
  { midi: 55, durSec: 1.3 },
];
const SYNTH = {
  sampleRate: SR,
  vowel: 'a',
  tiltDbPerOct: -12,
  breathNoise: 0.04,
  vibrato: { rateHz: 5.5, extentCents: 45, delaySec: 0.25 },
  jitter: 0.004,
  shimmer: 0.02,
  seed: 11,
} as const;
const line = synthMelody(NOTES, SYNTH);
const analyse = (x: Float32Array, sr = SR) => analyzeTake(x, sr, { voiceType: 'baritone' });
const reference = analyse(line);

/** Notes of the original that the processed take still has, matched by time (scaled by the speed) and pitch, as |cents error|. */
function noteErrors(y: Float32Array, rate: number, shiftSemitones = 0): number[] {
  const a1 = analyse(y);
  const errs: number[] = [];
  for (const n0 of reference.notes) {
    const m = a1.notes.find((n1) => Math.abs(n1.start - n0.start / rate) < 0.15 && Math.abs(n1.midi - (n0.midi + shiftSemitones)) < 1.5);
    if (m) errs.push(Math.abs((m.midi - (n0.midi + shiftSemitones)) * 100));
  }
  return errs;
}

describe('wsolaStretch', () => {
  it.each([1.25, 0.9, 0.75, 0.6, 0.5])('rate %s: exact duration, notes keep their pitch', (rate) => {
    const y = wsolaStretch(line, SR, rate);
    expect(Math.abs(y.length / SR - line.length / SR / rate)).toBeLessThan(0.02);
    const errs = noteErrors(y, rate);
    expect(errs.length).toBeGreaterThanOrEqual(reference.notes.length - 1);
    expect(median(errs)).toBeLessThan(12);
  });

  it('the exhaustive search is the same quality as the fast one', () => {
    const fast = noteErrors(wsolaStretch(line, SR, 0.75), 0.75);
    const full = noteErrors(wsolaStretch(line, SR, 0.75, { search: 'exhaustive' }), 0.75);
    expect(median(full)).toBeLessThan(12);
    expect(Math.abs(median(fast) - median(full))).toBeLessThan(6);
  });

  it('keeps tone: the style indices move by less than 0.05', () => {
    const a1 = analyse(wsolaStretch(line, SR, 0.75));
    expect(Math.abs((a1.style.breathiness ?? 0) - (reference.style.breathiness ?? 0))).toBeLessThan(0.05);
    expect(Math.abs((a1.style.brightness ?? 0) - (reference.style.brightness ?? 0))).toBeLessThan(0.05);
  });

  it('rate 1 returns an independent copy', () => {
    const y = wsolaStretch(line, SR, 1);
    expect(y).not.toBe(line);
    expect(Array.from(y.subarray(0, 50))).toEqual(Array.from(line.subarray(0, 50)));
  });

  it('never changes its input', () => {
    const copy = Float32Array.from(line);
    wsolaStretch(line, SR, 0.6);
    expect(line).toEqual(copy);
  });

  it('handles empty, tiny and shorter-than-a-window input without throwing', () => {
    expect(wsolaStretch(new Float32Array(0), SR, 0.75).length).toBe(0);
    for (const n of [1, 2, 100, 500]) {
      const x = Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin(i / 5));
      const y = wsolaStretch(x, SR, 0.5);
      expect(y.length).toBe(Math.max(1, Math.round(n / 0.5)));
      expect(Array.from(y).every(Number.isFinite)).toBe(true);
    }
  });

  it('turns NaN and Infinity in the input into silence instead of poisoning the output', () => {
    const x = Float32Array.from(line.subarray(0, SR));
    x[1000] = NaN;
    x[5000] = Infinity;
    x[6000] = -Infinity;
    const y = wsolaStretch(x, SR, 0.75);
    expect(Array.from(y).every(Number.isFinite)).toBe(true);
    expect(Math.max(...Array.from(y).map(Math.abs))).toBeLessThanOrEqual(1);
  });

  it('does not exceed full scale', () => {
    const loud = Float32Array.from({ length: SR }, (_, i) => Math.sin((2 * Math.PI * 220 * i) / SR));
    const y = wsolaStretch(loud, SR, 0.6);
    expect(Math.max(...Array.from(y).map(Math.abs))).toBeLessThanOrEqual(1);
  });

  it('rejects rates and sample rates that make no sense', () => {
    for (const rate of [0, -1, NaN, Infinity, 0.01, 50]) expect(() => wsolaStretch(line, SR, rate)).toThrow(RangeError);
    expect(() => wsolaStretch(line, 0, 0.75)).toThrow(RangeError);
    expect(() => wsolaStretch(line, NaN, 0.75)).toThrow(RangeError);
  });
});

describe('pitchShiftKeepDuration', () => {
  it.each([12, 7, -5, -12])('moves the notes by %i semitones and keeps the duration', (n) => {
    const y = pitchShiftKeepDuration(line, SR, n);
    expect(Math.abs(y.length / SR - line.length / SR)).toBeLessThan(0.03);
    const errs = noteErrors(y, 1, n);
    expect(errs.length).toBeGreaterThanOrEqual(reference.notes.length - 1);
    expect(median(errs)).toBeLessThan(15);
  });

  it('allows a fraction of a semitone and ignores a shift of zero', () => {
    const y = pitchShiftKeepDuration(line, SR, 0.35);
    const errs = noteErrors(y, 1, 0.35);
    expect(median(errs)).toBeLessThan(15);
    const same = pitchShiftKeepDuration(line, SR, 0);
    expect(same).not.toBe(line);
    expect(same.length).toBe(line.length);
  });

  it('refuses a shift that is not a number or too large', () => {
    expect(() => renderGuide(line, SR, { rate: 1, semitones: 30 })).toThrow(RangeError);
    expect(() => renderGuide(line, SR, { rate: 1, semitones: NaN })).toThrow(RangeError);
    expect(pitchShiftKeepDuration(line, SR, NaN).length).toBe(line.length);
  });
});

describe('renderGuide (speed and key in one pass)', () => {
  it('slows to 75 % and moves down 5 semitones in one go, at another output rate', () => {
    const y = renderGuide(line, SR, { rate: 0.75, semitones: -5, outRate: 32000 });
    expect(Math.abs(y.length / 32000 - line.length / SR / 0.75)).toBeLessThan(0.03);
    const a1 = analyze(y, 32000);
    const errs: number[] = [];
    for (const n0 of reference.notes) {
      const m = a1.notes.find((n1) => Math.abs(n1.start - n0.start / 0.75) < 0.2 && Math.abs(n1.midi - (n0.midi - 5)) < 1.5);
      if (m) errs.push(Math.abs((m.midi - (n0.midi - 5)) * 100));
    }
    expect(errs.length).toBeGreaterThanOrEqual(reference.notes.length - 2);
    expect(median(errs)).toBeLessThan(15);
  });

  it('converts only the sample rate when speed and key are unchanged', () => {
    const y = renderGuide(line, SR, { rate: 1, semitones: 0, outRate: 32000 });
    expect(Math.abs(y.length / 32000 - line.length / SR)).toBeLessThan(0.002);
    const a1 = analyze(y, 32000);
    expect(a1.notes.length).toBe(reference.notes.length);
  });

  it('is deterministic', () => {
    const a = renderGuide(line, SR, { rate: 0.6, semitones: 3 });
    const b = renderGuide(line, SR, { rate: 0.6, semitones: 3 });
    expect(a).toEqual(b);
  });
});

function analyze(x: Float32Array, sr: number) {
  return analyzeTake(x, sr, { voiceType: 'baritone' });
}

describe('chooseResampleTarget', () => {
  it('leaves a rate that is already an integer alone', () => {
    expect(chooseResampleTarget(44100, 48000)).toEqual({ to: 48000, m: 147 });
    expect(chooseResampleTarget(48000, 48000)).toEqual({ to: 48000, m: 1 });
  });

  it('rounds a fractional rate to an integer under a cent away, picking one the input rate shares a big factor with', () => {
    for (const from of [22050, 44100, 48000]) {
      for (const st of [-12, -7, -5, -1, 1, 3, 5, 7, 12]) {
        const ideal = 48000 / 2 ** (st / 12);
        const { to, m } = chooseResampleTarget(from, ideal);
        expect(Number.isInteger(to)).toBe(true);
        const cents = Math.abs(1200 * Math.log2(to / ideal));
        expect(cents).toBeLessThan(1);
        expect(m).toBeLessThanOrEqual(from);
        expect(m).toBeLessThan(2000); // a repeat of the output grid within 45 ms of input: slices of 0.25 s fit it
      }
    }
  });

  it('copes with a fractional input rate by not claiming a grid', () => {
    const r = chooseResampleTarget(44100.5, 48000 / 2 ** (3 / 12));
    expect(Number.isInteger(r.to)).toBe(true);
  });
});

describe('createResampleJob', () => {
  const sig = (sr: number, sec: number): Float32Array => Float32Array.from({ length: Math.round(sr * sec) }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 330 * i) / sr) + 0.2 * Math.sin((2 * Math.PI * 1234.5 * i) / sr));

  it.each([
    [44100, 48000],
    [44100, 64000],
    [48000, 35000],
    [22050, 31031],
    [44100, 44100 / 2 ** (7 / 12) > 0 ? chooseResampleTarget(44100, 48000 / 2 ** (7 / 12)).to : 0],
  ])('%i -> %i in slices equals one call over the whole signal', (from, to) => {
    const x = sig(from, 1.7);
    const { m } = chooseResampleTarget(from, to);
    const job = createResampleJob(x, from, to, m);
    let slices = 0;
    while (!job.run(0)) slices++;
    expect(slices).toBeGreaterThan(3);
    const sliced = job.result();
    const whole = resample(x, from, to);
    expect(sliced.length).toBe(whole.length);
    let worst = 0;
    for (let i = 0; i < whole.length; i++) worst = Math.max(worst, Math.abs(sliced[i] - whole[i]));
    expect(worst).toBeLessThan(2e-3);
  });

  it('a guide with a key shift is cut into many slices on a 12 second phrase', () => {
    const x = sig(44100, 12);
    const job = createGuideJob(x, 44100, { rate: 0.75, semitones: -5, outRate: 48000 });
    let during = 0;
    while (job.progress < 0.1 && !job.run(0)) during++;
    expect(during).toBeGreaterThan(20);
    while (!job.run(0));
    expect(job.result().length).toBeGreaterThan(0);
  });
});

describe('jobs', () => {
  it('a job run in tiny slices gives exactly the one-shot result and reports rising progress', () => {
    const whole = wsolaStretch(line, SR, 0.75);
    const job = createStretchJob(line, SR, 0.75);
    expect(job.done).toBe(false);
    expect(() => job.result()).toThrow();
    let last = -1;
    let slices = 0;
    while (!job.run(0)) {
      expect(job.progress).toBeGreaterThanOrEqual(last);
      last = job.progress;
      slices++;
      expect(slices).toBeLessThan(10000);
    }
    expect(slices).toBeGreaterThan(5);
    expect(job.done).toBe(true);
    expect(job.progress).toBe(1);
    expect(job.result()).toEqual(whole);
    expect(job.run(0)).toBe(true);
  });

  it('a guide job reports no progress before it starts and refuses result() until done', () => {
    const job = createGuideJob(line, SR, { rate: 0.75, semitones: 2 });
    expect(job.progress).toBe(0);
    expect(() => job.result()).toThrow();
    while (!job.run(0));
    expect(job.result().length).toBeGreaterThan(line.length);
  });
});

describe('renderGuideAsync', () => {
  it('gives the same samples as renderGuide, yielding between slices and reporting progress', async () => {
    const yieldFn = vi.fn(() => Promise.resolve());
    const seen: number[] = [];
    const y = await renderGuideAsync(line, SR, { rate: 0.75, semitones: 0 }, { sliceMs: 0, yieldFn, onProgress: (p) => seen.push(p) });
    expect(y).toEqual(renderGuide(line, SR, { rate: 0.75, semitones: 0 }));
    expect(yieldFn.mock.calls.length).toBeGreaterThan(3);
    expect(seen.at(-1)).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it('rejects with an AbortError when the signal aborts in the middle, and stops working', async () => {
    const ctl = new AbortController();
    let calls = 0;
    const yieldFn = (): Promise<void> => {
      if (++calls === 2) ctl.abort();
      return Promise.resolve();
    };
    await expect(renderGuideAsync(line, SR, { rate: 0.5, semitones: 0 }, { sliceMs: 0, yieldFn, signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(2);
  });

  it('rejects at once for a signal that is already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(renderGuideAsync(line, SR, { rate: 0.75, semitones: 0 }, { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(abortError().name).toBe('AbortError');
  });

  it('works with the default event-loop yield', async () => {
    const y = await renderGuideAsync(line.subarray(0, SR), SR, { rate: 0.75, semitones: 0 }, { sliceMs: 1 });
    expect(Math.abs(y.length - SR / 0.75)).toBeLessThan(2);
  });
});
