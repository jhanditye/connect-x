import { describe, expect, test } from 'vitest';
import { isAbortError } from '../../analysis/abort';
import { FRAME_LENGTH, FRAME_STEP, MODEL_BINS, MODEL_SAMPLE_RATE, PATCH_FRAMES, resolveParams } from './constants';
import { type MaskModel, type SeparationProgress, separateVocals } from './separate';
import { istft, stft, stftFrameCount } from './stft';

const SR = MODEL_SAMPLE_RATE;
const F = MODEL_BINS;
const GEOM = { frameLength: FRAME_LENGTH, frameStep: FRAME_STEP };
/** Frequency of STFT bin b: a tone here has a whole number of cycles in every 4096-sample window. */
const binFreq = (b: number) => (b * SR) / FRAME_LENGTH;

function tone(n: number, freq: number, amp: number, sr = SR): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return x;
}

function add(...xs: Float32Array[]): Float32Array {
  const y = new Float32Array(xs[0].length);
  for (const x of xs) for (let i = 0; i < y.length; i++) y[i] += x[i];
  return y;
}

/** Amplitude of the sine at `freq` in x[from, to), by correlation (exact when the range holds whole cycles). */
function amplitudeAt(x: Float32Array, freq: number, from: number, to: number, sr = SR): number {
  const w = (2 * Math.PI * freq) / sr;
  let c = 0;
  let s = 0;
  for (let i = from; i < to; i++) {
    c += x[i] * Math.cos(w * i);
    s += x[i] * Math.sin(w * i);
  }
  return (2 * Math.hypot(c, s)) / (to - from);
}

/** Amplitude envelope of a bin-centred tone around sample c, over one frame length (whole cycles, table-driven). */
function envelope(bin: number) {
  const cos = new Float64Array(FRAME_LENGTH);
  const sin = new Float64Array(FRAME_LENGTH);
  for (let i = 0; i < FRAME_LENGTH; i++) {
    cos[i] = Math.cos((2 * Math.PI * bin * i) / FRAME_LENGTH);
    sin[i] = Math.sin((2 * Math.PI * bin * i) / FRAME_LENGTH);
  }
  return (x: Float32Array, centre: number): number => {
    let c = 0;
    let s = 0;
    for (let i = centre - FRAME_LENGTH / 2; i < centre + FRAME_LENGTH / 2; i++) {
      c += x[i] * cos[i & (FRAME_LENGTH - 1)];
      s += x[i] * sin[i & (FRAME_LENGTH - 1)];
    }
    return (2 * Math.hypot(c, s)) / FRAME_LENGTH;
  };
}

const db = (ratio: number) => 20 * Math.log10(ratio);

/** Deterministic noise in [-1, 1). */
function noise(n: number, seed = 1): Float32Array {
  let s = seed >>> 0;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    x[i] = s / 2 ** 31 - 1;
  }
  return x;
}

function maskModel(fn: (f: number, t: number, c: number, call: number) => number): MaskModel & { calls: number } {
  const m = {
    calls: 0,
    async run(input: Float32Array): Promise<Float32Array> {
      const call = m.calls++;
      const out = new Float32Array(input.length);
      for (let i = 0; i < out.length; i++) {
        const c = i & 1;
        const f = (i >> 1) % F;
        const t = Math.floor(i / 2 / F);
        out[i] = fn(f, t, c, call);
      }
      return out;
    },
  };
  return m;
}
const onesModel = () => maskModel(() => 1);

/** Records every input patch it is given (copied, since the buffer is reused) and passes everything. */
function recordingModel(): MaskModel & { inputs: Float32Array[] } {
  const m = {
    inputs: [] as Float32Array[],
    async run(input: Float32Array): Promise<Float32Array> {
      m.inputs.push(Float32Array.from(input));
      return new Float32Array(input.length).fill(1);
    },
  };
  return m;
}

// 20 s: 866 STFT frames, so 2 patches without overlap and 3 with half-patch overlap.
const LONG = 20 * SR;
const A1 = 93; // bin of the main test tone, about 1.0 kHz

describe('stft / istft', () => {
  test('reconstruct a broadband signal to better than -80 dB error, edges included', () => {
    const n = 3 * SR + 123;
    const x = add(noise(n), tone(n, 440, 0.5), tone(n, 7000, 0.2));
    const y = istft(stft(x, GEOM), GEOM, n);
    expect(y.length).toBe(n);
    let err = 0;
    let sig = 0;
    for (let i = 0; i < n; i++) {
      err += (y[i] - x[i]) ** 2;
      sig += x[i] ** 2;
    }
    expect(db(Math.sqrt(err / sig))).toBeLessThan(-80);
    // Not just on average: the very first and last samples come back too (the lead-in covers them).
    for (const i of [0, 1, 2, 500, n - 3, n - 2, n - 1]) expect(Math.abs(y[i] - x[i])).toBeLessThan(1e-4);
  });

  test('frame count follows Spleeter (front pad of one frame, pad_end) and the transform is unnormalised', () => {
    expect(stftFrameCount(0, GEOM)).toBe(0);
    expect(stftFrameCount(1, GEOM)).toBe(5);
    expect(stftFrameCount(LONG, GEOM)).toBe(Math.ceil((FRAME_LENGTH + LONG) / FRAME_STEP));
    const x = tone(SR, binFreq(A1), 0.5);
    const s = stft(x, GEOM);
    const t = 20; // well inside the signal
    const mag = Math.hypot(s.re[t * s.bins + A1], s.im[t * s.bins + A1]);
    expect(mag).toBeGreaterThan(0.5 * 1024 * 0.995); // amplitude * sum(hann) / 2
    expect(mag).toBeLessThan(0.5 * 1024 * 1.005);
  });
});

// Golden values computed once with numpy, independent of this code, following Spleeter's graph (spleeter/model/__init__.py):
// one frame of zeros in front, pad_end, periodic Hann of 4096 at hop 1024, unscaled rfft, inverse = irfft x window,
// overlap-add, x 2/3. The stereo test signal is 0.5 * noise() + a sine per channel; the mask is
// left ((7 f) % 10) / 9, right ((3 f + 5) % 10) / 9 on bins f < 1024. A window shape, alignment, scale or channel-order
// slip changes these numbers; the self-consistency tests above cannot see such slips.
describe('agreement with the reference STFT pipeline (numpy golden values)', () => {
  const n = 9000;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  {
    const a = noise(n, 11);
    const b = noise(n, 23);
    for (let i = 0; i < n; i++) {
      left[i] = 0.5 * a[i] + 0.3 * Math.sin((2 * Math.PI * 440 * i) / 44100);
      right[i] = 0.5 * b[i] + 0.2 * Math.sin((2 * Math.PI * 1500 * i) / 44100);
    }
  }

  test('stft bins (frame, bin, re, im) match', () => {
    const s = stft(left, GEOM);
    expect(s.frames).toBe(13);
    const golden: Array<[number, number, number, number]> = [
      [1, 40, 8.09349, -24.45564],
      [2, 40, 89.83993, -93.18571],
      [3, 7, 1.42655, 1.20013],
      [5, 93, 5.09548, 7.20739],
      [5, 500, 2.57467, -15.07067],
      [9, 1023, -13.60077, -15.21124],
      [12, 7, 1.61731, 1.24377],
      [12, 1000, 0.47922, -0.27756],
      [4, 2048, -18.97005, 0],
    ];
    for (const [t, b, re, im] of golden) {
      expect(s.re[t * s.bins + b]).toBeCloseTo(re, 3);
      expect(s.im[t * s.bins + b]).toBeCloseTo(im, 3);
    }
    // The first frame lies wholly in the lead-in of zeros.
    for (let b = 0; b < s.bins; b++) expect(s.re[b]).toBe(0);
  });

  test('separateVocals with a per-bin, per-channel mask gives the reference samples', async () => {
    const model = maskModel((f, _t, c) => (c === 0 ? ((f * 7) % 10) / 9 : ((f * 3 + 5) % 10) / 9));
    const res = await separateVocals({ channels: [left, right], sampleRate: SR, model });
    const idx = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500, 8000, 8500, 8999];
    const golden = [
      -0.0846563, -0.0576138, -0.0692728, -0.0697561, -0.0832825, 0.0828254, 0.0751001, -0.0897753, -0.0169855, -0.1128859,
      0.1113039, 0.0457726, 0.0999064, -0.0966351, -0.034289, -0.0103085, -0.0776789, 0.0121168, -0.0212748,
    ];
    expect(res.frames).toBe(13);
    idx.forEach((i, k) => expect(Math.abs(res.vocals[i] - golden[k])).toBeLessThan(2e-5));
  });
});

describe('separateVocals', () => {
  test('an all-ones mask returns the mix limited to the kept band: 1 kHz passes, 15 kHz is removed', async () => {
    const n = 14 * SR;
    const low = tone(n, binFreq(A1), 0.4);
    const mix = add(low, tone(n, 15000, 0.3));
    const model = onesModel();
    const res = await separateVocals({ channels: [mix, mix], sampleRate: SR, model });
    expect(res.vocals.length).toBe(n);
    expect(res.patches).toBe(2);
    expect(model.calls).toBe(2);
    const a = FRAME_LENGTH * 2;
    const b = n - FRAME_LENGTH * 2;
    expect(amplitudeAt(res.vocals, binFreq(A1), a, b)).toBeGreaterThan(0.4 * 0.995);
    expect(amplitudeAt(res.vocals, binFreq(A1), a, b)).toBeLessThan(0.4 * 1.005);
    expect(db(amplitudeAt(res.vocals, 15000, a, b) / 0.3)).toBeLessThan(-70);
    // The whole signal equals the kept-band part of the mix. The first and last 2048 samples are left out: the test
    // tone starts and stops abruptly there, which is broadband, so band-limiting it really does change those samples.
    const skip = 2048;
    let err = 0;
    let sig = 0;
    for (let i = skip; i < n - skip; i++) {
      err += (res.vocals[i] - low[i]) ** 2;
      sig += low[i] ** 2;
    }
    expect(db(Math.sqrt(err / sig))).toBeLessThan(-90);
  });

  test('an all-zeros mask gives exact silence', async () => {
    const x = add(noise(5 * SR), tone(5 * SR, 300, 0.5));
    const res = await separateVocals({ channels: [x, x], sampleRate: SR, model: maskModel(() => 0) });
    expect(res.vocals.length).toBe(x.length);
    expect(res.vocals.every((v) => v === 0)).toBe(true);
  });

  for (const overlap of [0, 0.5] as const) {
    test(`a mask that keeps one of two tones isolates it by more than 30 dB (overlap ${overlap})`, async () => {
      const bLow = 40;
      const bHigh = 280;
      const mix = add(tone(LONG, binFreq(bLow), 0.4), tone(LONG, binFreq(bHigh), 0.3));
      const keepHigh = maskModel((f) => (f >= 150 && f < 450 ? 1 : 0));
      const res = await separateVocals({ channels: [mix, mix], sampleRate: SR, model: keepHigh, overlap });
      const a = FRAME_LENGTH * 2;
      const b = LONG - FRAME_LENGTH * 2;
      const kept = amplitudeAt(res.vocals, binFreq(bHigh), a, b);
      const leaked = amplitudeAt(res.vocals, binFreq(bLow), a, b);
      expect(kept).toBeGreaterThan(0.3 * 0.99);
      expect(db(kept / Math.max(leaked, 1e-12))).toBeGreaterThan(30);
    });
  }

  test('the model gets [t][f][c] magnitudes: both channels, T x F x 2 values, unnormalised STFT', async () => {
    const n = 5 * SR;
    const left = tone(n, binFreq(A1), 0.5);
    const right = tone(n, binFreq(200), 0.25);
    const rec = recordingModel();
    await separateVocals({ channels: [left, right], sampleRate: SR, model: rec });
    expect(rec.inputs.length).toBe(1);
    const inp = rec.inputs[0];
    expect(inp.length).toBe(PATCH_FRAMES * F * 2);
    const t = 100;
    const at = (f: number, c: number) => inp[(t * F + f) * 2 + c];
    expect(at(A1, 0)).toBeGreaterThan(512 * 0.99);
    expect(at(A1, 0)).toBeLessThan(512 * 1.01);
    expect(at(200, 1)).toBeGreaterThan(256 * 0.99);
    expect(at(200, 1)).toBeLessThan(256 * 1.01);
    let top0 = 0;
    let top1 = 0;
    for (let f = 0; f < F; f++) {
      if (at(f, 0) > at(top0, 0)) top0 = f;
      if (at(f, 1) > at(top1, 1)) top1 = f;
    }
    expect([top0, top1]).toEqual([A1, 200]);
    // Past the end of the song (zero padding up to a whole patch) the magnitudes are zero.
    expect(inp[(PATCH_FRAMES - 1) * F * 2 + A1 * 2]).toBe(0);
  });

  test('mono input is duplicated for the model and matches the same song as identical stereo', async () => {
    const n = 6 * SR;
    const x = add(noise(n, 7), tone(n, 500, 0.4));
    const rec = recordingModel();
    const mono = await separateVocals({ channels: [x], sampleRate: SR, model: rec });
    const inp = rec.inputs[0];
    for (const i of [0, 2, 77 * 2, 5000 * 2, 100000 * 2]) expect(inp[i]).toBe(inp[i + 1]);
    expect(inp.some((v) => v > 1)).toBe(true);
    const stereo = await separateVocals({ channels: [x, Float32Array.from(x)], sampleRate: SR, model: onesModel() });
    expect(mono.vocals.length).toBe(n);
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(mono.vocals[i] - stereo.vocals[i]));
    expect(worst).toBeLessThan(1e-6);
  });

  test('stereo vocals are the mono mix of the two masked channels', async () => {
    const n = 6 * SR;
    const left = tone(n, binFreq(A1), 0.4);
    const right = tone(n, binFreq(200), 0.2);
    const res = await separateVocals({ channels: [left, right], sampleRate: SR, model: onesModel() });
    const a = FRAME_LENGTH * 2;
    const b = n - FRAME_LENGTH * 2;
    expect(amplitudeAt(res.vocals, binFreq(A1), a, b)).toBeCloseTo(0.2, 3);
    expect(amplitudeAt(res.vocals, binFreq(200), a, b)).toBeCloseTo(0.1, 3);
    // Each channel has its own mask: pass only channel 1 (the right tone) and the left tone must vanish.
    const rightOnly = await separateVocals({ channels: [left, right], sampleRate: SR, model: maskModel((_f, _t, c) => c) });
    expect(amplitudeAt(rightOnly.vocals, binFreq(A1), a, b)).toBeLessThan(1e-4);
    expect(amplitudeAt(rightOnly.vocals, binFreq(200), a, b)).toBeCloseTo(0.1, 3);
    const leftOnly = await separateVocals({ channels: [left, right], sampleRate: SR, model: maskModel((_f, _t, c) => 1 - c) });
    expect(amplitudeAt(leftOnly.vocals, binFreq(A1), a, b)).toBeCloseTo(0.2, 3);
    expect(amplitudeAt(leftOnly.vocals, binFreq(200), a, b)).toBeLessThan(1e-4);
  });

  for (const overlap of [0, 0.5] as const) {
    test(`patches line up: a continuous tone has no discontinuity at patch boundaries (overlap ${overlap})`, async () => {
      const x = tone(LONG, binFreq(A1), 0.5);
      const res = await separateVocals({ channels: [x, x], sampleRate: SR, model: onesModel(), overlap });
      expect(res.patches).toBe(overlap === 0 ? 2 : 3);
      const hop = overlap === 0 ? PATCH_FRAMES : PATCH_FRAMES / 2;
      let maxDiffX = 0;
      for (let i = 1; i < LONG; i++) maxDiffX = Math.max(maxDiffX, Math.abs(x[i] - x[i - 1]));
      for (let p = 1; p < res.patches; p++) {
        const centre = p * hop * FRAME_STEP - FRAME_LENGTH / 2; // sample where the new patch's first frame is centred
        let worstErr = 0;
        let worstStep = 0;
        for (let i = centre - 8192; i < centre + 8192; i++) {
          worstErr = Math.max(worstErr, Math.abs(res.vocals[i] - x[i]));
          worstStep = Math.max(worstStep, Math.abs(res.vocals[i] - res.vocals[i - 1]));
        }
        expect(worstErr).toBeLessThan(1e-4);
        expect(worstStep).toBeLessThanOrEqual(maxDiffX * 1.001 + 1e-5);
      }
    });
  }

  test('frames are assigned to the right patch: a mask on only the second half of every patch', async () => {
    const x = tone(LONG, binFreq(A1), 0.5);
    const secondHalf = maskModel((_f, t) => (t >= PATCH_FRAMES / 2 ? 1 : 0));
    const res = await separateVocals({ channels: [x, x], sampleRate: SR, model: secondHalf, overlap: 0 });
    const env = envelope(A1);
    const centreOf = (frame: number) => frame * FRAME_STEP - FRAME_LENGTH / 2;
    expect(env(res.vocals, centreOf(128))).toBeLessThan(0.01); // patch 0, t = 128: off
    expect(env(res.vocals, centreOf(384))).toBeGreaterThan(0.495); // patch 0, t = 384: on
    expect(env(res.vocals, centreOf(640))).toBeLessThan(0.01); // patch 1, t = 128: off
    expect(env(res.vocals, centreOf(800))).toBeGreaterThan(0.495); // patch 1, t = 288: on
  });

  test('overlap 0.5 cross-fades the masks of neighbouring patches; overlap 0 switches hard', async () => {
    const x = tone(LONG, binFreq(A1), 0.5);
    const alternating = () => maskModel((_f, _t, _c, call) => (call % 2 === 0 ? 1 : 0));
    const env = envelope(A1);
    const centreOf = (frame: number) => frame * FRAME_STEP - FRAME_LENGTH / 2;
    const profile = async (overlap: 0 | 0.5) => {
      const res = await separateVocals({ channels: [x, x], sampleRate: SR, model: alternating(), overlap });
      const a: number[] = [];
      for (let i = 100; i < 840; i++) a.push(env(res.vocals, centreOf(i)) / 0.5);
      return a; // index j is frame j + 100
    };
    const maxStep = (a: number[]) => a.slice(1).reduce((m, v, i) => Math.max(m, Math.abs(v - a[i])), 0);

    const soft = await profile(0.5);
    // Patches 0, 1, 2 start at frames 0, 256, 512 and answer 1, 0, 1. Mask by frame: 1 until 256, falls to 0 at 512,
    // rises to 1 at 768.
    expect(soft[100 - 100 + 0]).toBeGreaterThan(0.98); // frame 100
    expect(soft[384 - 100]).toBeGreaterThan(0.45);
    expect(soft[384 - 100]).toBeLessThan(0.55);
    expect(soft[512 - 100]).toBeLessThan(0.03);
    expect(soft[640 - 100]).toBeGreaterThan(0.45);
    expect(soft[640 - 100]).toBeLessThan(0.55);
    expect(soft[820 - 100]).toBeGreaterThan(0.98);
    expect(maxStep(soft)).toBeLessThan(0.02);

    const hard = await profile(0);
    // Patches 0 and 1 start at frames 0 and 512 and answer 1 and 0.
    expect(hard[400 - 100]).toBeGreaterThan(0.98);
    expect(hard[650 - 100]).toBeLessThan(0.02);
    expect(maxStep(hard)).toBeGreaterThan(0.15);
  });

  test('overlap 0.5 gives the same output as overlap 0 for a constant mask', async () => {
    const x = add(tone(LONG, 700, 0.3), tone(LONG, 3300, 0.2));
    const a = await separateVocals({ channels: [x, x], sampleRate: SR, model: onesModel(), overlap: 0 });
    const b = await separateVocals({ channels: [x, x], sampleRate: SR, model: onesModel(), overlap: 0.5 });
    let worst = 0;
    for (let i = 0; i < LONG; i++) worst = Math.max(worst, Math.abs(a.vocals[i] - b.vocals[i]));
    expect(worst).toBeLessThan(1e-5);
  });

  test('the output is exactly as long as the input, for odd lengths too', async () => {
    const small = { patchFrames: 16 };
    for (const n of [1, 100, 4095, 4096, 4097, 10000, 123457]) {
      for (const overlap of [0, 0.5] as const) {
        const x = noise(n, n);
        const res = await separateVocals({ channels: [x], sampleRate: SR, model: onesModel(), params: small, overlap });
        expect(res.vocals.length).toBe(n);
        expect(res.vocals.every(Number.isFinite)).toBe(true);
      }
    }
    const empty = await separateVocals({ channels: [new Float32Array(0)], sampleRate: SR, model: onesModel() });
    expect(empty.vocals.length).toBe(0);
    expect(empty.patches).toBe(0);
  });

  test('masks outside [0, 1] are clamped and NaN counts as 0', async () => {
    const x = tone(3 * SR, 800, 0.4);
    const ones = await separateVocals({ channels: [x], sampleRate: SR, model: onesModel() });
    const big = await separateVocals({ channels: [x], sampleRate: SR, model: maskModel(() => 5) });
    const nan = await separateVocals({ channels: [x], sampleRate: SR, model: maskModel(() => NaN) });
    // Compared with a loop, not toEqual on the arrays: on a mismatch vitest takes minutes to diff 132k-sample arrays.
    let worst = 0;
    for (let i = 0; i < ones.vocals.length; i++) worst = Math.max(worst, Math.abs(big.vocals[i] - ones.vocals[i]));
    expect(big.vocals.length).toBe(ones.vocals.length);
    expect(worst).toBe(0);
    let nonZero = 0;
    for (let i = 0; i < nan.vocals.length; i++) if (nan.vocals[i] !== 0) nonZero++;
    expect(nonZero).toBe(0);
  });

  describe('non-finite audio samples', () => {
    for (const [label, bad] of [['NaN', NaN], ['+Infinity', Infinity], ['-Infinity', -Infinity]] as const) {
      for (const sr of [SR, 48000]) {
        test(`a single ${label} sample at ${sr} Hz is replaced by silence and reaches neither the model nor the output`, async () => {
          const n = 3 * sr;
          const x = noise(n, 5);
          const clean = Float32Array.from(x);
          x[60000] = bad;
          clean[60000] = 0;
          const rec = recordingModel();
          const res = await separateVocals({ channels: [x], sampleRate: sr, model: rec });
          let badInput = 0;
          for (const inp of rec.inputs) for (let i = 0; i < inp.length; i++) if (!Number.isFinite(inp[i])) badInput++;
          let badOutput = 0;
          for (let i = 0; i < res.vocals.length; i++) if (!Number.isFinite(res.vocals[i])) badOutput++;
          expect(badInput).toBe(0);
          expect(badOutput).toBe(0);
          expect(Number.isNaN(x[60000]) || !Number.isFinite(x[60000])).toBe(true); // the caller's array is left alone
          // Same result as the song with that sample set to 0 by hand.
          const ref = await separateVocals({ channels: [clean], sampleRate: sr, model: onesModel() });
          let worst = 0;
          for (let i = 0; i < ref.vocals.length; i++) worst = Math.max(worst, Math.abs(res.vocals[i] - ref.vocals[i]));
          expect(worst).toBe(0);
        });
      }
    }
  });

  test('progress never goes backwards, starts at 0 and ends at exactly 1', async () => {
    const x = tone(LONG, 440, 0.3);
    for (const overlap of [0, 0.5] as const) {
      const seen: Array<[number, SeparationProgress]> = [];
      const res = await separateVocals({
        channels: [x, x],
        sampleRate: SR,
        model: onesModel(),
        overlap,
        onProgress: (f, info) => seen.push([f, info]),
      });
      const fr = seen.map(([f]) => f);
      expect(fr[0]).toBe(0);
      expect(fr[fr.length - 1]).toBe(1);
      for (let i = 1; i < fr.length; i++) expect(fr[i]).toBeGreaterThanOrEqual(fr[i - 1]);
      expect(fr.every((f) => f >= 0 && f <= 1)).toBe(true);
      const last = seen[seen.length - 1][1];
      expect(last.stage).toBe('done');
      expect(last.patch).toBe(res.patches);
      expect(last.patches).toBe(res.patches);
      expect(new Set(seen.map(([, i]) => i.patch)).size).toBe(res.patches + 1); // every patch reported
    }
  });

  test('abort: an already-aborted signal rejects before the model is touched', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const model = onesModel();
    const x = tone(SR, 440, 0.3);
    const err = await separateVocals({ channels: [x], sampleRate: SR, model, signal: ctl.signal }).catch((e) => e);
    expect(isAbortError(err)).toBe(true);
    expect(model.calls).toBe(0);
  });

  test('abort: cancelling during a patch stops before the next one', async () => {
    const ctl = new AbortController();
    const x = tone(LONG, 440, 0.3);
    let calls = 0;
    const model: MaskModel = {
      async run(input) {
        calls++;
        if (calls === 2) ctl.abort();
        return new Float32Array(input.length).fill(1);
      },
    };
    const err = await separateVocals({ channels: [x, x], sampleRate: SR, model, overlap: 0.5, signal: ctl.signal }).catch((e) => e);
    expect(isAbortError(err)).toBe(true);
    expect(calls).toBe(2); // three patches were planned
  });

  test('abort: cancelling after the first channel is resampled stops before the second channel and before the model', async () => {
    const ctl = new AbortController();
    const model = onesModel();
    const x = tone(48000, 440, 0.3, 48000);
    const seen: Array<[number, SeparationProgress]> = [];
    const err = await separateVocals({
      channels: [x, x],
      sampleRate: 48000,
      model,
      signal: ctl.signal,
      onProgress: (f, info) => {
        seen.push([f, info]);
        // The report that follows the first channel's resample is the first one above 0 (0.02 of the 0.04 share).
        if (info.stage === 'prepare' && f > 0) ctl.abort();
      },
    }).catch((e) => e);
    expect(isAbortError(err)).toBe(true);
    expect(model.calls).toBe(0);
    expect(seen.length).toBe(2); // the initial 0 and the first channel; the second channel's report (0.04) never came
    expect(seen[1][0]).toBeGreaterThan(0);
    expect(seen[1][0]).toBeLessThan(0.04);
    expect(seen.every(([, i]) => i.stage === 'prepare')).toBe(true);
  });

  test('rejects unusable input with a clear message', async () => {
    const x = new Float32Array(1000);
    const model = onesModel();
    await expect(separateVocals({ channels: [], sampleRate: SR, model })).rejects.toThrow(/1 or 2 channels/);
    await expect(separateVocals({ channels: [x, x, x], sampleRate: SR, model })).rejects.toThrow(/1 or 2 channels/);
    await expect(separateVocals({ channels: [x, new Float32Array(999)], sampleRate: SR, model })).rejects.toThrow(/same length/);
    await expect(separateVocals({ channels: [x], sampleRate: 0, model })).rejects.toThrow(/sample rate/);
    await expect(separateVocals({ channels: [x], sampleRate: SR, model, overlap: 0.25 as 0 })).rejects.toThrow(/overlap/);
    const wrong: MaskModel = { run: async () => new Float32Array(10) };
    await expect(separateVocals({ channels: [x], sampleRate: SR, model: wrong })).rejects.toThrow(/expected 1048576 mask values/);
    expect(() => resolveParams({ patchFrames: 7 })).toThrow(/even/);
    expect(() => resolveParams({ frameStep: 2048 })).toThrow(/75 %/);
  });

  describe('sample-rate conversion', () => {
    const small = { patchFrames: 16 };

    test('48 kHz in, 48 kHz out: same length, 1 kHz kept, 15 kHz removed', async () => {
      const sr = 48000;
      const n = 4 * sr;
      const mix = add(tone(n, 1000, 0.4, sr), tone(n, 15000, 0.3, sr));
      const seen: SeparationProgress[] = [];
      const model = onesModel();
      const res = await separateVocals({
        channels: [mix, mix],
        sampleRate: sr,
        model,
        params: small,
        onProgress: (_f, i) => seen.push(i),
      });
      expect(res.sampleRate).toBe(sr);
      expect(res.vocals.length).toBe(n);
      // The model ran on the 44.1 kHz version of the song.
      expect(res.frames).toBe(stftFrameCount(Math.round((n * SR) / sr), GEOM));
      expect(res.patches).toBe(Math.ceil(res.frames / 16));
      expect(model.calls).toBe(res.patches);
      expect(seen.some((i) => i.stage === 'prepare')).toBe(true);
      const kept = amplitudeAt(res.vocals, 1000, 9600, n - 9600, sr);
      expect(kept).toBeGreaterThan(0.4 * 0.99);
      expect(kept).toBeLessThan(0.4 * 1.01);
      expect(db(amplitudeAt(res.vocals, 15000, 9600, n - 9600, sr) / 0.3)).toBeLessThan(-60);
    });

    test('22.05 kHz in, 22.05 kHz out: same length, content below the model band preserved', async () => {
      const sr = 22050;
      const n = 4 * sr;
      const mix = add(tone(n, 1000, 0.4, sr), tone(n, 9000, 0.3, sr));
      const res = await separateVocals({ channels: [mix], sampleRate: sr, model: onesModel(), params: small });
      expect(res.vocals.length).toBe(n);
      const a = 4410;
      const b = n - 4410;
      expect(amplitudeAt(res.vocals, 1000, a, b, sr)).toBeGreaterThan(0.4 * 0.98);
      expect(amplitudeAt(res.vocals, 1000, a, b, sr)).toBeLessThan(0.4 * 1.02);
      expect(amplitudeAt(res.vocals, 9000, a, b, sr)).toBeGreaterThan(0.3 * 0.95);
      expect(amplitudeAt(res.vocals, 9000, a, b, sr)).toBeLessThan(0.3 * 1.05);
    });

    // Amplitude checks cannot see a time shift (the correlation ignores phase), so compare sample by sample: with an
    // all-ones mask a band-limited signal must come back where it was, delayed by nothing, at every rate.
    for (const sr of [48000, 32000, 22050]) {
      test(`${sr} Hz: a band-limited signal comes back sample for sample (no delay, error below -80 dB)`, async () => {
        const n = 4 * sr + 5;
        const x = add(tone(n, 500, 0.25, sr), tone(n, 1230, 0.2, sr), tone(n, 3100, 0.15, sr));
        const res = await separateVocals({ channels: [x, x], sampleRate: sr, model: onesModel(), params: small });
        expect(res.vocals.length).toBe(n);
        // The tones start and stop abruptly, which is broadband and gets band-limited, so leave the ends out.
        const from = Math.ceil((2 * FRAME_LENGTH * sr) / SR);
        const to = n - from;
        let err = 0;
        let sig = 0;
        let worst = 0;
        for (let i = from; i < to; i++) {
          err += (res.vocals[i] - x[i]) ** 2;
          sig += x[i] ** 2;
          worst = Math.max(worst, Math.abs(res.vocals[i] - x[i]));
        }
        expect(db(Math.sqrt(err / sig))).toBeLessThan(-80);
        expect(worst).toBeLessThan(2e-3);
      });
    }

    test('an odd rate (32 kHz) also returns exactly the input length and keeps a tone', async () => {
      const sr = 32000;
      const n = 3 * sr + 17;
      const x = tone(n, 2000, 0.4, sr);
      const res = await separateVocals({ channels: [x, x], sampleRate: sr, model: onesModel(), params: small });
      expect(res.vocals.length).toBe(n);
      expect(amplitudeAt(res.vocals, 2000, 6400, 6400 + 64000, sr)).toBeGreaterThan(0.4 * 0.98);
    });
  });
});
