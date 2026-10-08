// Real-voice regression for the scorer. The clips (a cappella singing and speech) live outside the repository and are never copied
// into it; every test here is skipped cleanly when its files are missing (see realVoice.ts). Copies are made from the same voice with
// formant-preserving PSOLA, so the ground truth of every injected change is known.
import { describe, expect, it } from 'vitest';
import { resample } from '../../dsp/resample';
import { concat, silence, whiteNoise } from '../../testing/synth';
import { hasRealVoice, loadRealVoice } from './realVoice';
import { scoreAttempt } from './score';
import { PH_A, SR, addNoise, analyse, attemptAudio, centsToFactor, micRolloff, psolaHQ, refAnalysis, renderPhrase, roomNoise } from './testkit';

const ref = refAnalysis(PH_A);
const opts = { mode: 'sing-along' as const, refStartInCaptureSec: 2, latencyMs: 120 };

describe('real singing and speech', () => {
  it.skipIf(!hasRealVoice('vocadito10.wav', 'vignesh.wav', 'crepetest.wav', 'long_voice.wav'))('real singing re-synthesised with PSOLA (formants kept) scores >= 88 on four clips, also in another key', () => {
    for (const name of ['vocadito10.wav', 'vignesh.wav', 'crepetest.wav', 'long_voice.wav']) {
      const w = loadRealVoice(name, 30);
      const x = resample(w.samples, w.sampleRate, SR);
      const r0 = analyse(concat(silence(0.15, SR), x, silence(0.2, SR)));
      for (const shift of [0, 3]) {
        const y = psolaHQ(x, { durationSec: x.length / SR, timeMap: (t) => t, pitchFactor: () => centsToFactor(shift * 100) });
        const r = scoreAttempt(r0, analyse(roomNoise(concat(silence(1.8, SR), y, silence(0.6, SR)), 0.0012, 9)));
        expect(r.status, name).toBe('ok');
        expect(r.overall, `${name} +${shift}`).toBeGreaterThanOrEqual(88);
        expect(r.transposeSemitones, name).toBe(shift);
      }
    }
  }, 120_000);

  it.skipIf(!hasRealVoice('libri3.wav'))('junk before and after the take (silence, breath noise, talking, a hum) changes the overall by <= 3', () => {
    const clean = attemptAudio({ notes: PH_A, key: -3, lead: 1, tail: 0.5 });
    const r0 = scoreAttempt(ref, analyse(clean));
    const w = loadRealVoice('libri3.wav', 12);
    const sp = resample(w.samples, w.sampleRate, SR);
    const hum = renderPhrase([{ midi: 52, durSec: 1.5 }], undefined, { leadIn: 0, tail: 0 });
    for (const junk of [silence(6, SR), whiteNoise(2, 0.02, SR, 4), sp.subarray(0, Math.round(2.5 * SR)), hum, sp.subarray(0, 4 * SR)]) {
      const r = scoreAttempt(ref, analyse(roomNoise(concat(junk, silence(0.5, SR), clean, silence(0.5, SR), junk.subarray(0, Math.min(junk.length, 2 * SR))), 0.0012, 5)));
      expect(r.status).toBe('ok');
      expect(Math.abs((r.overall as number) - (r0.overall as number))).toBeLessThanOrEqual(3);
    }
  }, 90_000);

  it.skipIf(!hasRealVoice('vocadito10.wav'))('a real person following the playback (natural wobble) is not flagged', () => {
    const w = loadRealVoice('vocadito10.wav', 20);
    const x = resample(w.samples, w.sampleRate, SR);
    const refR = analyse(concat(silence(0.15, SR), x, silence(0.2, SR)));
    const wob = psolaHQ(x, { durationSec: x.length / SR, timeMap: (t) => t + 0.03 * Math.sin(t * 3), pitchFactor: (t) => centsToFactor(18 * Math.sin(t * 5.1)) });
    const r = scoreAttempt(refR, analyse(roomNoise(concat(silence(2.33, SR), wob, silence(0.6, SR)), 0.0012, 4)), opts);
    expect(r.trust.level).not.toBe('invalid');
    expect(r.timing.lagMs).not.toBeNull();
    // the exact copy of the same clip is flagged
    const exact = scoreAttempt(refR, analyse(roomNoise(concat(silence(2.33, SR), x, silence(0.6, SR)), 0.0012, 4)), opts);
    expect(exact.trust.level).toBe('invalid');
  }, 60_000);

  it.skipIf(!hasRealVoice('libri1.wav', 'libri2.wav'))('speech-like reference: a copy (also in another key or a bit slower) scores >= 88; a different speech clip is no-match', () => {
    const w = loadRealVoice('libri1.wav', 14);
    const x = resample(w.samples, w.sampleRate, SR);
    const r0 = analyse(concat(silence(0.15, SR), x, silence(0.2, SR)));
    expect(r0.issues).toContain('speech-like');
    const take = (y: Float32Array): ReturnType<typeof analyse> => analyse(roomNoise(concat(silence(1.5, SR), y, silence(0.5, SR)), 0.0012, 3));
    const dur = x.length / SR;
    for (const y of [x, psolaHQ(x, { durationSec: dur, timeMap: (t) => t, pitchFactor: () => centsToFactor(400) }), psolaHQ(x, { durationSec: dur * 1.12, timeMap: (t) => t / 1.12, pitchFactor: () => 1 })]) {
      const r = scoreAttempt(r0, take(y));
      expect(r.kind).toBe('speech-like');
      expect(r.overall as number).toBeGreaterThanOrEqual(88);
    }
    const v = loadRealVoice('libri2.wav', 14);
    expect(scoreAttempt(r0, take(resample(v.samples, v.sampleRate, SR))).status).toBe('no-match');
  }, 120_000);

  it.skipIf(!hasRealVoice('vocadito10.wav', 'long_voice.wav', 'vignesh.wav'))('different songs sung by different people do not match', () => {
    const load = (name: string) => resample(loadRealVoice(name, 30).samples, loadRealVoice(name, 30).sampleRate, SR);
    const refA = analyse(concat(silence(0.15, SR), load('vocadito10.wav'), silence(0.2, SR)));
    for (const other of ['long_voice.wav', 'vignesh.wav']) {
      const r = scoreAttempt(refA, analyse(roomNoise(concat(silence(1.8, SR), load(other), silence(0.6, SR)), 0.0012, 9)));
      expect(r.status, other).toBe('no-match');
      expect(r.overall as number, other).toBeLessThanOrEqual(20);
      expect(r.fixes, other).toEqual([]);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// The same voice re-timed, re-pitched and re-channelled with PSOLA: the ground truth of every change is known.

const CLIPS = ['vocadito10.wav', 'long_voice.wav', 'crepetest.wav', 'vignesh.wav'] as const;
/** Key shifts that push a low voice under the 65 Hz floor of the pitch tracker: not a scorer fault, the take must say so. */
const BELOW_FLOOR: Record<string, number[]> = { 'vocadito10.wav': [-12], 'crepetest.wav': [-5, -12] };

interface Variant {
  label: string;
  make: (x: Float32Array, dur: number) => Float32Array;
  lead?: number;
  shift?: number;
  /** The least the overall may be (a sanity floor a little under what was measured when the scorer was calibrated). */
  atLeast?: number;
  /** Partial takes: the overall must be at most this and the coverage inside the range. */
  partial?: { atMost: number; coverage: [number, number] };
}
const same = (x: Float32Array, dur: number, shift: number, stretch = 1): Float32Array =>
  psolaHQ(x, { durationSec: dur * stretch, timeMap: (t) => t / stretch, pitchFactor: () => centsToFactor(shift * 100) });
const VARIANTS: Variant[] = [
  { label: 'identity', make: (x, d) => same(x, d, 0), atLeast: 85, shift: 0 },
  { label: 'key -5 st', make: (x, d) => same(x, d, -5), atLeast: 82, shift: -5 },
  { label: 'key +3 st', make: (x, d) => same(x, d, 3), atLeast: 83, shift: 3 },
  { label: 'tempo x1.08 (slower)', make: (x, d) => same(x, d, 0, 1.08), atLeast: 85, shift: 0 },
  { label: 'tempo x0.92 (faster)', make: (x, d) => same(x, d, 0, 0.92), atLeast: 85, shift: 0 },
  { label: 'whole phrase +40 cents', make: (x, d) => same(x, d, 0.4), atLeast: 85, shift: 0 },
  { label: 'phone channel (HP 250, LP 4k, SNR 25)', make: (x, d) => addNoise(micRolloff(same(x, d, 0), 250, 4000), 25, 5), atLeast: 82, shift: 0 },
  { label: 'first 60 % only', make: (x, d) => same(x, d, 0).subarray(0, Math.round(x.length * 0.6)), partial: { atMost: 85, coverage: [0.3, 0.8] }, shift: 0 },
];

describe('real clips re-timed and re-pitched with PSOLA', () => {
  const printed: string[] = [];
  for (const name of CLIPS) {
    it.skipIf(!hasRealVoice(name))(`${name}: copies score high, key changes are free, partial takes are told apart, range limits are explained`, () => {
      const w = loadRealVoice(name, 30);
      const x = resample(w.samples, w.sampleRate, SR);
      const dur = x.length / SR;
      const r0 = analyse(concat(silence(0.15, SR), x, silence(0.2, SR)));
      for (const v of VARIANTS) {
        const y = v.make(x, dur);
        const r = scoreAttempt(r0, analyse(roomNoise(concat(silence(v.lead ?? 1.8, SR), y, silence(0.6, SR)), 0.0012, 9)));
        printed.push(`| ${name} | ${v.label} | ${r.status} | ${r.overall} | ${r.skills.pitch ?? '-'} | ${r.skills.timing ?? '-'} | ${r.skills.tone ?? '-'} | ${r.skills.expression ?? '-'} | ${r.transposeSemitones} |`);
        const limited = v.shift !== undefined && (BELOW_FLOOR[name] ?? []).includes(v.shift);
        if (limited) {
          if (r.status !== 'ok') expect(r.notes.join(' '), `${name} ${v.label}`).toMatch(/C2/);
          continue;
        }
        if (v.partial) {
          expect(r.overall as number, `${name} ${v.label}`).toBeLessThanOrEqual(v.partial.atMost);
          expect(r.coverage, `${name} ${v.label} coverage`).toBeGreaterThanOrEqual(v.partial.coverage[0]);
          expect(r.coverage, `${name} ${v.label} coverage`).toBeLessThanOrEqual(v.partial.coverage[1]);
          continue;
        }
        expect(r.status, `${name} ${v.label}`).toBe('ok');
        expect(r.overall as number, `${name} ${v.label}`).toBeGreaterThanOrEqual(v.atLeast as number);
        if (v.shift !== undefined) expect(r.transposeSemitones, `${name} ${v.label}`).toBe(v.shift);
      }
    }, 300_000);
  }

  it('prints the measured table when MIMIC_PRINT_TABLE is set', () => {
    if (!process.env.MIMIC_PRINT_TABLE || printed.length === 0) return;
    console.log(['| clip | variant | status | overall | pitch | timing | tone | expression | key |', '|---|---|---|---|---|---|---|---|---|', ...printed].join('\n'));
  });
});
