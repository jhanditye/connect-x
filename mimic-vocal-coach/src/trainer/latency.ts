// The count-in clicks double as a probe: they show (a) whether the playback leaks into the microphone (speaker, leaky
// earbuds) and (b) the round-trip latency of the current audio route. Pure functions of the captured mic samples and the
// click times (seconds, in the capture clock; see audio/duplex.ts TakeResult.clickTimesInCaptureSec).

export interface ClickProbe {
  /** The mic can hear the clicks: playback is leaking into it. */
  bleed: boolean;
  /** Median click onset delay in the mic vs the scheduled time, ms (output + input latency + acoustic path); null if not heard. */
  roundTripMs: number | null;
  /** Mean level of the clicks above the room noise, dB. */
  clickOverFloorDb: number;
  /** Room noise above 1 kHz (where the clicks are), dBFS. */
  floorDb: number;
  clicksHeard: number;
  /** Clicks that were looked for (finite, non-negative times with audio after them). */
  clicksTried: number;
  /** Level of the loudest click heard, dBFS (-Infinity when none was heard). */
  peakDb: number;
  /** Largest minus smallest per-click delay, ms; null with fewer than two clicks heard. */
  spreadMs: number | null;
  /**
   * The round trip is a measurement, not noise that crossed the gate: at least three quarters of the clicks (and two) were heard,
   * and their delays agree within CONSISTENT_SPREAD_MS. A real leak is heard on every click; a hum or a beat in the room is not.
   */
  consistent: boolean;
}

/** A click counts as heard when its peak is this far above the room noise... */
export const CLICK_GATE_DB = 9;
/** ...and above this absolute level (dBFS): a leak that faint cannot disturb anything and is not worth a warning. */
export const MIN_CLICK_DB = -80;
/** Delays within this spread are taken to be the same click heard again. */
export const CONSISTENT_SPREAD_MS = 40;
/** The room noise is read from this long before the first click; fewer windows than MIN_FLOOR_WINDOWS means "no pre-roll". */
const PRE_ROLL_SEC = 0.3;
const PRE_ROLL_GUARD_SEC = 0.02;
const MIN_FLOOR_WINDOWS = 20;
const SILENT_DB = -180;

const db = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9));

/** The clicks are 1.8 and 2.4 kHz: below this the room (voices, hum, a bass line, a beep) is ignored. */
export const PROBE_HIGHPASS_HZ = 1000;

/** 4th-order Butterworth high-pass (two biquads). Returns a new array; NaN samples count as silence. */
function highPass(x: Float32Array, sr: number, cutoffHz: number): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] === x[i] ? x[i] : 0;
  const fc = Math.min(cutoffHz, sr * 0.4);
  const w0 = (2 * Math.PI * fc) / sr;
  const cos = Math.cos(w0);
  for (const q of [0.5412, 1.3066]) {
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    const b0 = (1 + cos) / 2 / a0;
    const b1 = -(1 + cos) / a0;
    const a1 = (-2 * cos) / a0;
    const a2 = (1 - alpha) / a0;
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < out.length; i++) {
      const xi = out[i];
      const y = b0 * xi + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = xi;
      y2 = y1;
      y1 = y;
      out[i] = y;
    }
  }
  return out;
}

function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return SILENT_DB;
  return sortedAscending[Math.min(sortedAscending.length - 1, Math.floor(sortedAscending.length * p))];
}

interface Frame {
  t: number;
  db: number;
}

/** Level envelope (2 ms RMS windows, 1 ms hop) of x[from..to). */
function envelope(x: Float32Array, sr: number, from: number, to: number): Frame[] {
  const w = Math.max(8, Math.round(0.002 * sr));
  const out: Frame[] = [];
  const end = Math.min(x.length, to);
  for (let s = Math.max(0, from); s + w <= end; s += w >> 1) {
    let e = 0;
    for (let k = 0; k < w; k++) {
      const v = x[s + k];
      if (v === v) e += v * v; // NaN counts as silence
    }
    out.push({ t: s / sr, db: db(Math.sqrt(e / w)) });
  }
  return out;
}

const EMPTY: ClickProbe = {
  bleed: false,
  roundTripMs: null,
  clickOverFloorDb: 0,
  floorDb: -90,
  clicksHeard: 0,
  clicksTried: 0,
  peakDb: -Infinity,
  spreadMs: null,
  consistent: false,
};

/**
 * Looks for the count-in clicks in the microphone take. `clickTimes` are in the capture clock. The room noise comes from the
 * pause the count-in starts with (the 280 ms before the first click); when there is no such pause the quietest quarter of
 * the take stands in, so a missing pre-roll cannot turn room noise into "bleed".
 */
export function probeClicks(mic: Float32Array, sr: number, clickTimes: number[], searchSec = 0.45): ClickProbe {
  if (!(sr > 0) || !Number.isFinite(sr) || mic.length === 0) return { ...EMPTY };
  const times = [...new Set(clickTimes.filter((t) => Number.isFinite(t) && t >= 0 && t * sr < mic.length))].sort((a, b) => a - b);
  if (times.length === 0) return { ...EMPTY };
  const x = highPass(mic, sr, PROBE_HIGHPASS_HZ);

  const first = times[0];
  const pre = envelope(x, sr, Math.round((first - PRE_ROLL_SEC) * sr), Math.round((first - PRE_ROLL_GUARD_SEC) * sr));
  let floorDb: number;
  if (pre.length >= MIN_FLOOR_WINDOWS) floorDb = percentile(pre.map((p) => p.db).sort((a, b) => a - b), 0.75);
  else floorDb = percentile(envelope(x, sr, 0, mic.length).map((p) => p.db).sort((a, b) => a - b), 0.25);
  const gate = Math.max(floorDb + CLICK_GATE_DB, MIN_CLICK_DB);

  const delays: number[] = [];
  const over: number[] = [];
  let peakDb = -Infinity;
  for (let k = 0; k < times.length; k++) {
    const tc = times[k];
    // Never reach into the next click's window: at high tempos the search would find the next click and call it latency.
    const reach = k + 1 < times.length ? Math.min(searchSec, times[k + 1] - tc - PRE_ROLL_GUARD_SEC) : searchSec;
    if (!(reach > 0.005)) continue;
    const env = envelope(x, sr, Math.round(tc * sr), Math.round((tc + reach) * sr));
    if (env.length === 0) continue;
    let peak = -Infinity;
    for (const e of env) if (e.db > peak) peak = e.db;
    if (peak < gate) continue;
    const hit = env.find((e) => e.db >= Math.max(gate, peak - 12));
    if (!hit) continue;
    delays.push((hit.t - tc) * 1000);
    over.push(peak - floorDb);
    if (peak > peakDb) peakDb = peak;
  }

  const sorted = [...delays].sort((a, b) => a - b);
  const spreadMs = sorted.length >= 2 ? sorted[sorted.length - 1] - sorted[0] : null;
  return {
    bleed: delays.length >= Math.min(2, times.length),
    roundTripMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    clickOverFloorDb: over.length ? over.reduce((s, v) => s + v, 0) / over.length : 0,
    floorDb,
    clicksHeard: delays.length,
    clicksTried: times.length,
    peakDb,
    spreadMs,
    consistent: sorted.length >= Math.max(2, Math.ceil(0.75 * times.length)) && spreadMs !== null && spreadMs <= CONSISTENT_SPREAD_MS,
  };
}
