import { describe, expect, it } from 'vitest';
import { makeRng, mix } from '../testing/synth';
import { CLICK_GATE_DB, CONSISTENT_SPREAD_MS, MIN_CLICK_DB, probeClicks } from './latency';

const SR = 22050;

/** The count-in click as the app plays it, as a short decaying 1.8 kHz burst. */
function click(sr = SR): Float32Array {
  const n = Math.round(0.004 * sr);
  return Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 1800 * i) / sr) * Math.exp(-i / (0.0012 * sr)));
}
const gain = (x: Float32Array, db: number): Float32Array => Float32Array.from(x, (v) => v * 10 ** (db / 20));
/** Click train heard `lat` seconds late at `levelDb` (dBFS peak). */
function place(clickTimes: number[], lat: number, levelDb: number, dur: number, sr = SR): Float32Array {
  const out = new Float32Array(Math.round(dur * sr));
  const c = gain(click(sr), levelDb);
  for (const t of clickTimes) out.set(c, Math.round((t + lat) * sr));
  return out;
}
function room(dur: number, rmsDb: number, seed = 5, sr = SR): Float32Array {
  const rng = makeRng(seed);
  return Float32Array.from({ length: Math.round(dur * sr) }, () => (rng() - 0.5) * 2 * 10 ** (rmsDb / 20) * Math.sqrt(3));
}

const CLICKS = [0.45, 1.05, 1.65];
/** The probe reads 2 ms RMS windows; this burst's loudest window sits about 8 dB under its peak sample. */
const PEAK_OVER_WINDOW_DB = 8;
/** Peak level (dBFS) of a click that reads `over` dB above a room at `floorDb`. */
const peakFor = (floorDb: number, over: number): number => floorDb + over + PEAK_OVER_WINDOW_DB;

describe('probeClicks', () => {
  it.each([
    ['speaker, 110 ms, loud click', 0.11, 30, -60],
    ['speaker, 45 ms, quieter click', 0.045, 20, -60],
    ['leaky earbud, 190 ms, 14 dB over the room', 0.19, 14, -62],
    ['speaker in a noisy room, 13 dB over', 0.11, 13, -45],
  ])('%s: hears the clicks and recovers the round trip within 6 ms', (_label, lat, over, floor) => {
    const level = peakFor(floor, over);
    const mic = mix(room(3, floor), place(CLICKS, lat, level, 3));
    const p = probeClicks(mic, SR, CLICKS);
    expect(p.bleed).toBe(true);
    expect(p.clicksHeard).toBe(3);
    expect(p.clicksTried).toBe(3);
    expect(Math.abs((p.roundTripMs ?? 999) - lat * 1000)).toBeLessThan(6);
    expect(p.consistent).toBe(true);
    expect(p.spreadMs).toBeLessThan(CONSISTENT_SPREAD_MS);
    expect(p.clickOverFloorDb).toBeGreaterThan(CLICK_GATE_DB);
    expect(Math.abs(p.clickOverFloorDb - over)).toBeLessThan(4);
    expect(p.peakDb).toBeLessThan(0);
    expect(p.floorDb).toBeLessThan(level);
  });

  it('sealed headphones (nothing leaks): no bleed, no round trip', () => {
    const p = probeClicks(room(3, -60), SR, CLICKS);
    expect(p.bleed).toBe(false);
    expect(p.roundTripMs).toBeNull();
    expect(p.clicksHeard).toBe(0);
    expect(p.consistent).toBe(false);
    expect(p.peakDb).toBe(-Infinity);
  });

  it('works at the sample rates a phone runs at', () => {
    for (const sr of [44100, 48000]) {
      const mic = mix(room(3, -60, 7, sr), place(CLICKS, 0.085, -35, 3, sr));
      const p = probeClicks(mic, sr, CLICKS);
      expect(Math.abs((p.roundTripMs ?? 999) - 85)).toBeLessThan(5);
    }
  });

  it('a click 12 dB over the noise is heard, one 5 dB over is not', () => {
    const noise = room(3, -50);
    const heard = probeClicks(mix(noise, place(CLICKS, 0.1, peakFor(-50, 12), 3)), SR, CLICKS);
    expect(heard.bleed).toBe(true);
    const faint = probeClicks(mix(noise, place(CLICKS, 0.1, peakFor(-50, 5), 3)), SR, CLICKS);
    expect(faint.bleed).toBe(false);
  });

  it('ignores a leak fainter than the absolute floor even in a digitally silent room', () => {
    const mic = place(CLICKS, 0.1, MIN_CLICK_DB - 10, 3);
    const p = probeClicks(mic, SR, CLICKS);
    expect(p.bleed).toBe(false);
    const loud = probeClicks(place(CLICKS, 0.1, MIN_CLICK_DB + 20, 3), SR, CLICKS);
    expect(loud.bleed).toBe(true);
  });

  it('one heard click out of three is not bleed; with a single scheduled click it is', () => {
    const mic = mix(room(3, -60), place([CLICKS[1]], 0.1, -35, 3));
    const p = probeClicks(mic, SR, CLICKS);
    expect(p.clicksHeard).toBe(1);
    expect(p.bleed).toBe(false);
    expect(p.consistent).toBe(false);
    const single = probeClicks(mic, SR, [CLICKS[1]]);
    expect(single.bleed).toBe(true);
    expect(Math.abs((single.roundTripMs ?? 999) - 100)).toBeLessThan(6);
  });

  it('two of four clicks heard at the same delay is bleed but not a clean reading', () => {
    const four = [0.45, 0.95, 1.45, 1.95];
    const mic = mix(room(3, -60), place([four[0], four[2]], 0.08, peakFor(-60, 20), 3));
    const p = probeClicks(mic, SR, four);
    expect(p.clicksHeard).toBe(2);
    expect(p.bleed).toBe(true);
    expect(Math.abs((p.roundTripMs ?? 999) - 80)).toBeLessThan(6);
    expect(p.consistent).toBe(false);
    // Three of four is enough.
    const three = probeClicks(mix(room(3, -60), place(four.slice(0, 3), 0.08, peakFor(-60, 20), 3)), SR, four);
    expect(three.clicksHeard).toBe(3);
    expect(three.consistent).toBe(true);
  });

  it('random noise bursts at unrelated delays are heard but not called consistent', () => {
    const mic = mix(room(3, -60), mix(place([CLICKS[0]], 0.05, -30, 3), mix(place([CLICKS[1]], 0.25, -30, 3), place([CLICKS[2]], 0.38, -30, 3))));
    const p = probeClicks(mic, SR, CLICKS);
    expect(p.clicksHeard).toBe(3);
    expect(p.consistent).toBe(false);
    expect(p.spreadMs).toBeGreaterThan(CONSISTENT_SPREAD_MS);
  });

  it('does not take the next click for a late echo of this one at a fast tempo', () => {
    const fast = [0.45, 0.75, 1.05, 1.35]; // 200 bpm
    const mic = mix(room(2.5, -60), place(fast, 0.04, -35, 2.5));
    const p = probeClicks(mic, SR, fast);
    expect(p.clicksHeard).toBe(4);
    expect(Math.abs((p.roundTripMs ?? 999) - 40)).toBeLessThan(6);
  });

  it('with no pause before the first click the quietest part of the take sets the noise floor', () => {
    const early = [0.03, 0.63, 1.23];
    const quiet = mix(room(3, -60), place(early, 0.1, -35, 3));
    const p = probeClicks(quiet, SR, early);
    expect(p.floorDb).toBeLessThan(-50);
    expect(p.clicksHeard).toBe(3);
    // Room noise alone must not become bleed just because the pre-roll is missing.
    expect(probeClicks(room(3, -60), SR, early).bleed).toBe(false);
  });

  it('copes with empty input, junk click times and clicks outside the take', () => {
    const none = probeClicks(new Float32Array(0), SR, CLICKS);
    expect(none).toMatchObject({ bleed: false, roundTripMs: null, clicksHeard: 0, clicksTried: 0 });
    const mic = room(1, -60);
    expect(probeClicks(mic, SR, [])).toMatchObject({ bleed: false, roundTripMs: null });
    expect(probeClicks(mic, SR, [NaN, Infinity, -1, 99])).toMatchObject({ bleed: false, clicksTried: 0 });
    expect(probeClicks(mic, 0, CLICKS).bleed).toBe(false);
    expect(probeClicks(mic, NaN, CLICKS).bleed).toBe(false);
  });

  it('is not fooled by NaN samples and takes unsorted, duplicated click times', () => {
    const mic = mix(room(3, -60), place(CLICKS, 0.1, -35, 3));
    mic[100] = NaN;
    mic[30000] = NaN;
    const p = probeClicks(mic, SR, [CLICKS[2], CLICKS[0], CLICKS[1], CLICKS[0]]);
    expect(p.clicksTried).toBe(3);
    expect(p.clicksHeard).toBe(3);
    expect(Number.isFinite(p.floorDb)).toBe(true);
  });

  it('a loud low hum does not hide the clicks or raise the noise floor', () => {
    const hum = Float32Array.from({ length: 3 * SR }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 100 * i) / SR));
    const mic = mix(mix(room(3, -60), hum), place(CLICKS, 0.1, peakFor(-60, 20), 3));
    const p = probeClicks(mic, SR, CLICKS);
    expect(p.floorDb).toBeLessThan(-50);
    expect(p.clicksHeard).toBe(3);
    expect(Math.abs((p.roundTripMs ?? 999) - 100)).toBeLessThan(6);
  });

  it('a periodic low beep (a fake microphone, a ticking device) is not taken for a click', () => {
    const beeps = new Float32Array(3 * SR);
    for (let t = 0.2; t < 2.9; t += 1) for (let i = 0; i < 0.1 * SR; i++) beeps[Math.round(t * SR) + i] = 0.8 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const p = probeClicks(mix(room(3, -60), beeps), SR, [0.45, 1.05, 1.65]);
    expect(p.bleed).toBe(false);
    expect(p.roundTripMs).toBeNull();
  });

  it('digital silence is not bleed', () => {
    const p = probeClicks(new Float32Array(3 * SR), SR, CLICKS);
    expect(p.bleed).toBe(false);
    expect(p.clicksHeard).toBe(0);
  });
});
