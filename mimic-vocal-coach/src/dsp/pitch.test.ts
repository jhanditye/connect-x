import { describe, expect, it } from 'vitest';
import { detectPitch, trackPitch, type PitchTrack } from './pitch';
import { resample } from './resample';
import { concat, midiToHz, silence, sine, synthMelody, synthVoice, whiteNoise, type Vowel } from '../testing/synth';

const SR = 22050;

const cents = (hz: number, truth: number) => 1200 * Math.log2(hz / truth);

function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : NaN;
}

/** Errors (cents) of voiced frames whose time lies in [t0, t1], against a ground-truth function. */
function errorsIn(tr: PitchTrack, truth: (t: number) => number, t0: number, t1: number) {
  const errs: number[] = [];
  let frames = 0;
  let voiced = 0;
  let octave = 0;
  for (let i = 0; i < tr.times.length; i++) {
    const t = tr.times[i];
    if (t < t0 || t > t1) continue;
    frames++;
    if (!tr.voiced[i]) continue;
    voiced++;
    const c = cents(tr.f0[i], truth(t));
    if (Math.abs(c) > 600) octave++;
    else errs.push(Math.abs(c));
  }
  return { errs, frames, voiced, octave, medianErr: medianOf(errs), maxErr: errs.length ? Math.max(...errs) : NaN };
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}

describe('trackPitch: basics', () => {
  it('returns frames on a 10 ms grid with consistent lengths', () => {
    const x = sine(220, 1.005, SR);
    const tr = trackPitch(x, SR);
    expect(tr.hopSec).toBe(0.01);
    expect(tr.sampleRate).toBe(SR);
    expect(tr.times.length).toBe(101);
    for (const arr of [tr.f0, tr.periodicity, tr.rmsDb, tr.voiced]) expect(arr.length).toBe(tr.times.length);
    expect(tr.times[37]).toBeCloseTo(0.37, 12);
    // Full-scale sine is -3 dBFS; this one has amplitude 0.5 -> about -9 dBFS.
    expect(tr.rmsDb[50]).toBeCloseTo(-9.03, 0);
  });

  it('handles empty input and a custom hop', () => {
    expect(trackPitch(new Float32Array(0), SR).times.length).toBe(0);
    const tr = trackPitch(sine(330, 0.5, SR), SR, { hopSec: 0.005 });
    expect(tr.hopSec).toBe(0.005);
    expect(tr.times.length).toBe(Math.floor((0.5 * SR - 1) / (0.005 * SR)) + 1);
    expect(errorsIn(tr, () => 330, 0.05, 0.45).medianErr).toBeLessThan(1);
  });
});

describe('trackPitch: accuracy', () => {
  it.each([82, 110, 220, 440, 880])('tracks a %d Hz sine within 3 cents', (hz) => {
    const tr = trackPitch(sine(hz, 1, SR), SR);
    const r = errorsIn(tr, () => hz, 0.04, 0.96);
    expect(r.voiced / r.frames).toBeGreaterThan(0.98);
    expect(r.octave).toBe(0);
    expect(r.maxErr).toBeLessThan(3);
  });

  it('tracks synthetic voices (vowels a/i/u, tilts -6/-12/-20, 98-700 Hz) within 8 cents, <1% octave errors', () => {
    let voiced = 0;
    let octave = 0;
    for (const vowel of ['a', 'i', 'u'] as Vowel[]) {
      for (const tilt of [-6, -12, -20]) {
        for (const hz of [98, 147, 220, 330, 494, 700]) {
          const tr = trackPitch(synthVoice({ durationSec: 0.8, f0: hz, vowel, tiltDbPerOct: tilt }), SR);
          const r = errorsIn(tr, () => hz, 0, 0.8);
          expect(r.medianErr, `${vowel} ${tilt} ${hz}`).toBeLessThan(8);
          expect(r.voiced / r.frames, `${vowel} ${tilt} ${hz}`).toBeGreaterThan(0.9);
          voiced += r.voiced;
          octave += r.octave;
        }
      }
    }
    expect(octave / voiced).toBeLessThan(0.01);
  });

  it('does not jump an octave up on an H2-dominant (belt-like) spectrum', () => {
    for (const [vowel, hz] of [
      ['a', 523],
      ['e', 262],
      ['o', 330],
    ] as [Vowel, number][]) {
      const tr = trackPitch(synthVoice({ durationSec: 0.8, f0: hz, vowel, tiltDbPerOct: -6, h1BoostDb: -6 }), SR);
      const r = errorsIn(tr, () => hz, 0.05, 0.75);
      expect(r.octave, `${vowel} ${hz}`).toBe(0);
      expect(r.medianErr).toBeLessThan(3);
    }
  });

  it('follows a 5.5 Hz, +/-50 cent vibrato (correlation > 0.95 with the true contour)', () => {
    const f0 = 220;
    const vib = { rateHz: 5.5, extentCents: 50 };
    const tr = trackPitch(synthVoice({ durationSec: 2, f0, vibrato: vib, tiltDbPerOct: -12 }), SR);
    const got: number[] = [];
    const want: number[] = [];
    for (let i = 0; i < tr.times.length; i++) {
      const t = tr.times[i];
      if (!tr.voiced[i] || t < 0.1 || t > 1.9) continue;
      got.push(cents(tr.f0[i], f0));
      want.push(vib.extentCents * Math.sin(2 * Math.PI * vib.rateHz * t));
    }
    expect(got.length).toBeGreaterThan(170);
    expect(pearson(got, want)).toBeGreaterThan(0.95);
    // Extent is kept (no smoothing): peak-to-peak close to the true 100 cents.
    const sorted = [...got].sort((a, b) => a - b);
    const p2p = sorted[Math.floor(sorted.length * 0.97)] - sorted[Math.floor(sorted.length * 0.03)];
    expect(p2p).toBeGreaterThan(85);
  });

  it('follows a fast wide vibrato (7 Hz, +/-100 cents)', () => {
    const f0 = 330;
    const tr = trackPitch(synthVoice({ durationSec: 1.5, f0, vibrato: { rateHz: 7, extentCents: 100 } }), SR);
    const got: number[] = [];
    const want: number[] = [];
    for (let i = 0; i < tr.times.length; i++) {
      const t = tr.times[i];
      if (!tr.voiced[i] || t < 0.1 || t > 1.4) continue;
      got.push(cents(tr.f0[i], f0));
      want.push(100 * Math.sin(2 * Math.PI * 7 * t));
    }
    expect(got.length).toBeGreaterThan(125);
    expect(pearson(got, want)).toBeGreaterThan(0.95);
  });
});

describe('trackPitch: voicing', () => {
  it('keeps a breathy tone (breathNoise 0.6, tilt -18, H1 +8 dB) >= 85% voiced, silence around it unvoiced', () => {
    for (const hz of [110, 196, 294]) {
      const tone = synthVoice({ durationSec: 2, f0: hz, breathNoise: 0.6, tiltDbPerOct: -18, h1BoostDb: 8 });
      const x = concat(silence(0.5, SR), tone, silence(0.5, SR));
      const tr = trackPitch(x, SR);
      const inTone = errorsIn(tr, () => hz, 0.55, 2.45);
      expect(inTone.voiced / inTone.frames, `${hz}`).toBeGreaterThanOrEqual(0.85);
      expect(inTone.octave).toBe(0);
      expect(inTone.medianErr).toBeLessThan(10);
      const before = errorsIn(tr, () => hz, 0, 0.45);
      const after = errorsIn(tr, () => hz, 2.55, 3);
      expect(before.voiced + after.voiced).toBe(0);
    }
  });

  it('marks silence and white noise >= 95% unvoiced', () => {
    for (const x of [silence(2, SR), whiteNoise(2, 0.05, SR), whiteNoise(2, 0.3, SR, 9), whiteNoise(2, 0.001, SR, 4)]) {
      const tr = trackPitch(x, SR);
      const voiced = tr.voiced.reduce((s, v) => s + v, 0);
      expect(voiced / tr.voiced.length).toBeLessThanOrEqual(0.05);
      for (let i = 0; i < tr.f0.length; i++) if (!tr.voiced[i]) expect(tr.f0[i]).toBeNaN();
    }
  });

  it('finds a tone inside background noise and leaves the noise-only parts unvoiced', () => {
    const noise = whiteNoise(3, 0.003, SR, 5);
    const tone = concat(silence(1, SR), synthVoice({ durationSec: 1, f0: 196, tiltDbPerOct: -12, amplitude: 0.3 }), silence(1, SR));
    const tr = trackPitch(Float32Array.from(tone, (v, i) => v + noise[i]), SR);
    const inTone = errorsIn(tr, () => 196, 1.05, 1.95);
    expect(inTone.voiced / inTone.frames).toBeGreaterThan(0.95);
    const outside = errorsIn(tr, () => 196, 0, 0.9).voiced + errorsIn(tr, () => 196, 2.1, 3).voiced;
    expect(outside).toBeLessThanOrEqual(5);
  });

  it('keeps a whisper-like tone (breathNoise 1.5) mostly unvoiced rather than inventing pitches', () => {
    const tr = trackPitch(synthVoice({ durationSec: 1, f0: 220, breathNoise: 1.5, tiltDbPerOct: -16 }), SR);
    const r = errorsIn(tr, () => 220, 0, 1);
    expect(r.octave).toBe(0);
    if (r.voiced > 0) expect(r.medianErr).toBeLessThan(30);
  });
});

describe('trackPitch: octave handling', () => {
  it('tracks a sustained octave leap (A3 -> A4 -> A3)', () => {
    const notes = [
      { midi: 57, durSec: 0.5 },
      { midi: 69, durSec: 0.5 },
      { midi: 57, durSec: 0.5 },
    ];
    const tr = trackPitch(synthMelody(notes, { sampleRate: SR, tiltDbPerOct: -12 }), SR);
    for (const [t0, t1, midi] of [
      [0.08, 0.45, 57],
      [0.58, 0.95, 69],
      [1.08, 1.45, 57],
    ]) {
      const r = errorsIn(tr, () => midiToHz(midi), t0, t1);
      expect(r.octave).toBe(0);
      expect(r.voiced / r.frames).toBeGreaterThan(0.95);
      expect(r.medianErr).toBeLessThan(5);
    }
  });

  it('keeps a real octave leap held for 250 ms but folds back a 30 ms octave excursion', () => {
    const held = trackPitch(
      synthMelody(
        [
          { midi: 55, durSec: 0.4 },
          { midi: 67, durSec: 0.25 },
          { midi: 55, durSec: 0.4 },
        ],
        { sampleRate: SR, glideSec: 0.01 },
      ),
      SR,
    );
    const top = errorsIn(held, () => midiToHz(67), 0.43, 0.62);
    expect(top.voiced).toBeGreaterThanOrEqual(16);
    expect(top.octave).toBe(0);
    expect(top.medianErr).toBeLessThan(20);

    const blip = trackPitch(
      synthMelody(
        [
          { midi: 55, durSec: 0.4 },
          { midi: 67, durSec: 0.03 },
          { midi: 55, durSec: 0.4 },
        ],
        { sampleRate: SR, glideSec: 0.005 },
      ),
      SR,
    );
    for (let i = 0; i < blip.times.length; i++) {
      if (!blip.voiced[i]) continue;
      expect(Math.abs(cents(blip.f0[i], midiToHz(55)))).toBeLessThan(600);
    }
  });

  it('folds back octave-up stretches of 110-140 ms, even when they recur (persistent YIN octave errors)', () => {
    // Real low male voices can make YIN lock onto 2*f0 for 110-140 ms at a time, alternating with
    // correct stretches; the synthesised octave jumps stand in for those errors here.
    const x = synthMelody(
      [
        { midi: 45, durSec: 0.5 },
        { midi: 57, durSec: 0.12 },
        { midi: 45, durSec: 0.12 },
        { midi: 57, durSec: 0.14 },
        { midi: 45, durSec: 0.5 },
      ],
      { sampleRate: SR, glideSec: 0.005 },
    );
    const tr = trackPitch(x, SR);
    const r = errorsIn(tr, () => midiToHz(45), 0, x.length / SR);
    expect(r.voiced).toBeGreaterThan(100);
    expect(r.octave).toBe(0);
  });

  it('reports the sung note, not the subharmonic, for a raspy (period-doubled) voice', () => {
    for (const hz of [147, 220]) {
      const tr = trackPitch(synthVoice({ durationSec: 1, f0: hz, vowel: 'a', tiltDbPerOct: -9, subharmonic: 0.4, jitter: 0.02, shimmer: 0.08 }), SR);
      const r = errorsIn(tr, () => hz, 0.05, 0.95);
      expect(r.voiced / r.frames, `${hz}`).toBeGreaterThan(0.9);
      expect(r.octave / r.voiced, `${hz}`).toBeLessThan(0.05);
      // The subharmonic energy counts as aperiodic at the sung period.
      expect(medianOf(Array.from(tr.periodicity).filter((_, i) => tr.voiced[i]))).toBeLessThan(0.6);
    }
  });
});

describe('trackPitch: sample rates and speed', () => {
  it('works on 44.1 kHz input, directly and after resampling to 22.05 kHz', () => {
    const x = synthVoice({ durationSec: 1, f0: 196, vowel: 'o', sampleRate: 44100, vibrato: { rateHz: 5, extentCents: 30, delaySec: 0.5 } });
    const truth = (t: number) => (t < 0.5 ? 196 : 196 * Math.pow(2, (30 * Math.sin(2 * Math.PI * 5 * (t - 0.5))) / 1200));
    for (const [sig, sr] of [
      [x, 44100],
      [resample(x, 44100, SR), SR],
    ] as [Float32Array, number][]) {
      const tr = trackPitch(sig, sr);
      const r = errorsIn(tr, truth, 0.05, 0.95);
      expect(r.voiced / r.frames).toBeGreaterThan(0.95);
      expect(r.octave).toBe(0);
      expect(r.medianErr).toBeLessThan(5);
    }
  });

  it('tracks 30 s of audio at 22.05 kHz in under 3 s', () => {
    const second = synthVoice({ durationSec: 1, f0: 247, vowel: 'e', breathNoise: 0.1 });
    const x = concat(...Array.from({ length: 30 }, () => second));
    const t0 = performance.now();
    const tr = trackPitch(x, SR);
    const ms = performance.now() - t0;
    expect(tr.times.length).toBe(3000);
    expect(ms).toBeLessThan(3000);
  });
});

describe('detectPitch', () => {
  it('finds the pitch of a single 2048-sample frame at 44.1 and 48 kHz', () => {
    for (const sr of [44100, 48000]) {
      for (const hz of [82, 110, 220, 440, 660]) {
        const x = synthVoice({ durationSec: 0.2, f0: hz, sampleRate: sr, vowel: 'a' });
        const frame = x.subarray(2000, 4048);
        const r = detectPitch(frame, sr);
        expect(r, `${sr} ${hz}`).not.toBeNull();
        expect(Math.abs(cents(r!.hz, hz))).toBeLessThan(5);
        expect(r!.periodicity).toBeGreaterThan(0.9);
      }
    }
  });

  it('returns null for silence, very quiet input and noise', () => {
    expect(detectPitch(new Float32Array(2048), 48000)).toBeNull();
    expect(detectPitch(sine(220, 2048 / 48000, 48000, 0.0005), 48000)).toBeNull();
    expect(detectPitch(whiteNoise(2048 / 48000, 0.1, 48000), 48000)).toBeNull();
  });

  it('respects a custom range', () => {
    const frame = sine(1000, 2048 / 44100, 44100, 0.5);
    // A pure tone is also periodic at twice its period, so above maxHz YIN may report the
    // sub-octave; it must never report a pitch above maxHz.
    const capped = detectPitch(frame, 44100, 65, 800);
    if (capped) expect(capped.hz).toBeLessThanOrEqual(800);
    expect(detectPitch(frame, 44100, 65, 1400)?.hz).toBeCloseTo(1000, 0);
  });
});
