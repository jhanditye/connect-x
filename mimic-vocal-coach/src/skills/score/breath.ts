// Breath exercises: the hiss test (how long and how evenly the singer can let air out on "sss") and the long tone.

import { trackPitch } from '../../dsp/pitch';
import { median, percentile, std } from '../../dsp/stats';
import type { Finding, HissScore, LongToneScore } from '../types';
import {
  HISS_ABOVE_FLOOR_DB,
  HISS_ABS_MIN_DB,
  HISS_BIT_UNEVEN_DB,
  HISS_BRIDGE_SEC,
  HISS_EDGE_SEC,
  HISS_FLOOR_SEC,
  HISS_FRAME_SEC,
  HISS_HF_HZ,
  HISS_MAX_PERIODICITY,
  HISS_MIN_HF_SHARE,
  HISS_MIN_RUN_SHARE,
  HISS_MIN_SEC,
  HISS_STEADY_DB,
  HISS_VERY_STEADY_DB,
  LEVEL_SMOOTH_SEC,
  LONG_TONE_BRIDGE_SEC,
  LONG_TONE_SKIP_START_SEC,
  LONG_TONE_STEADY_CENTS,
  LONG_TONE_VERY_STEADY_CENTS,
  LONG_TONE_WOBBLY_CENTS,
  SMOOTH_SEC,
  TRACE_STEP_SEC,
} from './constants';
import { analyseTake, heldPitch, sdCents, smoothRange, takeStatus, unscoredFinding, voicedStretches } from './frames';

const db = (ms: number) => (ms > 0 ? Math.max(-120, 10 * Math.log10(ms)) : -120);

/** Second-order Butterworth high-pass (RBJ cookbook), applied to a copy. */
function highPass(x: Float32Array, sampleRate: number, hz: number): Float64Array {
  const w0 = (2 * Math.PI * Math.min(hz, 0.45 * sampleRate)) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/** Centred moving mean; NaN inputs are skipped and stay NaN. */
function movingMean(x: ArrayLike<number>, window: number): Float64Array {
  const half = window >> 1;
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(x[i])) {
      out[i] = NaN;
      continue;
    }
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(x.length - 1, i + half); j++) {
      if (Number.isNaN(x[j])) continue;
      s += x[j];
      n++;
    }
    out[i] = s / n;
  }
  return out;
}

/** Values of `x` (frames of `frameSec`) every TRACE_STEP_SEC between frames a and b. */
function trace(x: ArrayLike<number>, a: number, b: number, frameSec: number): number[] {
  const step = Math.max(1, Math.round(TRACE_STEP_SEC / frameSec));
  const out: number[] = [];
  for (let i = a; i < b; i += step) {
    let s = 0;
    let n = 0;
    for (let j = i; j < Math.min(b, i + step); j++) {
      if (Number.isNaN(x[j])) continue;
      s += x[j];
      n++;
    }
    out.push(n ? Math.round((s / n) * 100) / 100 : NaN);
  }
  // Unvoiced steps repeat the previous value so a chart never drops to zero.
  for (let i = 0; i < out.length; i++) if (Number.isNaN(out[i])) out[i] = i > 0 ? out[i - 1] : NaN;
  return out.filter((v) => !Number.isNaN(v));
}

function steadinessWords(sd: number): string {
  if (sd <= HISS_VERY_STEADY_DB) return 'very steady';
  if (sd <= HISS_STEADY_DB) return 'steady';
  if (sd <= HISS_BIT_UNEVEN_DB) return 'a bit uneven';
  return 'uneven';
}

/**
 * Hiss test on "sss": 20 ms frames. The room's noise floor is the median level of the first 0.5 s (or the take's 10th
 * percentile, or its quietest 200 ms, when lower). A hiss frame is at least 8 dB above the floor, aperiodic (periodicity < 0.5) and
 * bright (>= 35 % of its energy above 2 kHz). Duration = the longest run of hiss frames, gaps up to 0.3 s of
 * non-voiced sound bridged; steadiness = SD of the 100 ms-smoothed level without 0.3 s at each end.
 */
export function scoreHiss(samples: Float32Array, sampleRate: number): HissScore {
  const fl = Math.max(1, Math.round(HISS_FRAME_SEC * sampleRate));
  const nF = Math.floor(samples.length / fl);
  const hp = highPass(samples, sampleRate, HISS_HF_HZ);
  const level = new Float64Array(nF);
  const hfShare = new Float64Array(nF);
  for (let f = 0; f < nF; f++) {
    let e = 0;
    let h = 0;
    for (let i = f * fl; i < (f + 1) * fl; i++) {
      e += samples[i] * samples[i];
      h += hp[i] * hp[i];
    }
    level[f] = db(e / fl);
    hfShare[f] = e > 0 ? h / e : 0;
  }
  // Periodicity and voicing from the pitch tracker (10 ms frames): a frame is periodic/voiced if either half is.
  const tr = trackPitch(samples, sampleRate);
  const per = new Float64Array(nF);
  const voiced = new Uint8Array(nF);
  const ratio = HISS_FRAME_SEC / tr.hopSec;
  for (let f = 0; f < nF; f++) {
    let p = 0;
    let v = 0;
    for (let k = Math.round(f * ratio); k < Math.min(tr.f0.length, Math.round((f + 1) * ratio)); k++) {
      p = Math.max(p, tr.periodicity[k]);
      v = Math.max(v, tr.voiced[k]);
    }
    per[f] = p;
    voiced[f] = v;
  }
  const floorFrames = Math.min(nF, Math.max(1, Math.round(HISS_FLOOR_SEC / HISS_FRAME_SEC)));
  // The quietest 200 ms anywhere also counts, so a hiss that starts the instant capture opens (no room to calibrate
  // on) still finds the floor in the silence after it (auto-stop waits 0.8 s of quiet).
  let quietest = Infinity;
  const qw = Math.max(1, Math.round(0.2 / HISS_FRAME_SEC));
  for (let k = 0; k + qw <= nF; k += Math.max(1, qw >> 1)) quietest = Math.min(quietest, median(level.subarray(k, k + qw)));
  const floorDb = nF ? Math.min(median(level.subarray(0, floorFrames)), percentile(level, 10), quietest) : -120;
  const thr = Math.max(floorDb + HISS_ABOVE_FLOOR_DB, HISS_ABS_MIN_DB);
  const loud = new Uint8Array(nF);
  const hiss = new Uint8Array(nF);
  let loudCount = 0;
  let loudVoiced = 0;
  for (let f = 0; f < nF; f++) {
    if (level[f] < thr) continue;
    loud[f] = 1;
    loudCount++;
    if (voiced[f]) loudVoiced++;
    if (!voiced[f] && per[f] < HISS_MAX_PERIODICITY && hfShare[f] >= HISS_MIN_HF_SHARE) hiss[f] = 1;
  }
  // Longest run of hiss frames; gaps up to 0.3 s are bridged when they hold no voiced sound.
  const bridge = Math.round(HISS_BRIDGE_SEC / HISS_FRAME_SEC);
  let best: [number, number] | null = null;
  let f = 0;
  while (f < nF) {
    if (!hiss[f]) {
      f++;
      continue;
    }
    const a = f;
    let b = f + 1;
    let g = b;
    while (g < nF) {
      if (hiss[g]) {
        b = g + 1;
        g++;
        continue;
      }
      if (voiced[g] || g - b >= bridge) break;
      g++;
    }
    let count = 0;
    for (let k = a; k < b; k++) count += hiss[k];
    if (count / (b - a) >= HISS_MIN_RUN_SHARE && (!best || b - a > best[1] - best[0])) best = [a, b];
    f = b;
  }
  const base: HissScore = {
    status: 'too-quiet',
    durationSec: 0,
    steadinessDb: null,
    noiseFloorDb: Math.round(floorDb * 10) / 10,
    startSec: null,
    endSec: null,
    levelTrace: [],
    findings: [],
  };
  const durationSec = best ? (best[1] - best[0]) * HISS_FRAME_SEC : 0;
  if (!best || durationSec < HISS_MIN_SEC) {
    if (loudCount > 0 && loudVoiced / loudCount > 0.5) {
      return { ...base, status: 'voiced', findings: [{ tone: 'info', text: 'That sounded like voice rather than a hiss. Let the air out on a steady "sss" with no voice.' }] };
    }
    return { ...base, findings: [{ tone: 'info', text: 'I did not hear a steady hiss. Try a firm "sss", a hand’s width from the microphone.' }] };
  }
  const [a, b] = best;
  // Steadiness over the hiss frames only: a bridged catch in the airflow counts in the duration, not as unevenness.
  const hissLevel = Array.from(level.subarray(a, b), (v, k) => (hiss[a + k] ? v : NaN));
  const sm = movingMean(hissLevel, Math.max(1, Math.round(LEVEL_SMOOTH_SEC / HISS_FRAME_SEC)));
  const edge = Math.round(HISS_EDGE_SEC / HISS_FRAME_SEC);
  const inner = sm.length > 2 * edge + 5 ? sm.subarray(edge, sm.length - edge) : sm;
  const steadinessDb = std(inner);
  const findings: Finding[] = [
    { tone: 'good', text: `${durationSec.toFixed(1)} seconds of hiss on one breath, ${steadinessWords(steadinessDb)} (level varied ${steadinessDb.toFixed(1)} dB).` },
  ];
  if (steadinessDb > HISS_STEADY_DB) {
    findings.push({ tone: 'work', text: 'Aim for an even stream of air: the same "sss" from start to finish, no pushing at the end.' });
  }
  findings.push({ tone: 'info', text: 'Stop well before you run out of air; never squeeze out the last drop.' });
  return {
    status: 'ok',
    durationSec,
    steadinessDb,
    noiseFloorDb: base.noiseFloorDb,
    startSec: a * HISS_FRAME_SEC,
    endSec: b * HISS_FRAME_SEC,
    levelTrace: trace(level, a, b, HISS_FRAME_SEC),
    findings: findings.slice(0, 3),
  };
}

/**
 * Long tone: the longest voiced run (gaps up to 150 ms bridged). Pitch steadiness = SD of the 200 ms-smoothed pitch
 * after the first 300 ms (vibrato not counted); loudness steadiness = SD of the 100 ms-smoothed level.
 */
export function scoreLongTone(samples: Float32Array, sampleRate: number, opts: { a4Hz: number }): LongToneScore {
  const fr = analyseTake(samples, sampleRate, opts.a4Hz);
  const status = takeStatus(fr);
  const base: LongToneScore = {
    status,
    durationSec: 0,
    midi: null,
    pitchSdCents: null,
    loudnessSdDb: null,
    levelTrace: [],
    pitchTrace: [],
    findings: [],
  };
  if (status !== 'ok') return { ...base, findings: [unscoredFinding(status)] };
  let best: [number, number] | null = null;
  for (const s of voicedStretches(fr, LONG_TONE_BRIDGE_SEC)) if (!best || s[1] - s[0] > best[1] - best[0]) best = s;
  if (!best) return { ...base, status: 'no-pitch', findings: [unscoredFinding('no-pitch')] };
  const [a, b] = best;
  const hop = fr.hop;
  const durationSec = (b - a) * hop;
  const sm = smoothRange(fr.midi, a, b, Math.max(3, Math.round(SMOOTH_SEC / hop) | 1));
  const skip = Math.min(Math.round(LONG_TONE_SKIP_START_SEC / hop), Math.floor(sm.length / 4));
  const pitchSdCents = sdCents(sm.subarray(skip, Math.max(skip + 1, sm.length - Math.round(0.15 / hop))));
  const lv: number[] = [];
  for (let k = a; k < b; k++) lv.push(fr.voiced[k] ? fr.rmsDb[k] : NaN);
  const lvSm = movingMean(lv, Math.max(1, Math.round(LEVEL_SMOOTH_SEC / hop)));
  const loudnessSdDb = std(lvSm.subarray(skip, Math.max(skip + 1, lvSm.length - Math.round(0.15 / hop))));
  const midi = heldPitch(fr.midi.subarray(a + skip, b), undefined, hop);
  const findings: Finding[] = [];
  const words =
    pitchSdCents <= LONG_TONE_VERY_STEADY_CENTS
      ? 'very steady'
      : pitchSdCents <= LONG_TONE_STEADY_CENTS
        ? 'steady'
        : pitchSdCents <= LONG_TONE_WOBBLY_CENTS
          ? 'a little wobbly'
          : 'wobbly';
  findings.push({ tone: pitchSdCents <= LONG_TONE_STEADY_CENTS ? 'good' : 'work', text: `${durationSec.toFixed(1)} seconds, pitch ${words} (it moved about ${Math.round(pitchSdCents)} cents, vibrato not counted).` });
  if (loudnessSdDb > HISS_STEADY_DB) findings.push({ tone: 'work', text: `The volume varied by about ${loudnessSdDb.toFixed(1)} dB. Keep a steady medium volume all the way.` });
  else findings.push({ tone: 'good', text: `Even volume (varied ${loudnessSdDb.toFixed(1)} dB).` });
  return {
    status: 'ok',
    durationSec,
    midi: Number.isFinite(midi) ? midi : null,
    pitchSdCents,
    loudnessSdDb,
    levelTrace: trace(fr.rmsDb, a, b, hop),
    pitchTrace: trace(sm, 0, sm.length, hop),
    findings,
  };
}
