// The normalised StyleVector, mapped from raw measures onto the anchors documented in src/types.ts.
//
// Calibration comes from the synthesiser (src/testing/synth.ts; see the DSP calibration table in
// src/dsp/spectral.ts), except breathiness, whose absolute level is anchored on real recordings
// (the synthesiser's source has a stronger first harmonic than real voices). Real voices still sit
// at different absolute values (recording noise, microphone, vowels), so the indices are best
// read relative to each other and over time, on the same microphone.

import { clamp, linearRegression, mean, median, percentile } from '../dsp/stats';
import type { FrameFeatures, NoteSegment, Onset, PassaggioZone, Run, StyleVector } from '../types';
import type { FrameTrack } from './features';
import { registerShares } from './register';

// ---------------------------------------------------------------------------------------------
// Per-frame indices

/**
 * Breathiness of one voiced frame, 0..1.
 *
 *   B = 0.30 + 0.017 * clamp(H, -10, 12) + 0.01 * max(0, H - 12) + 0.3 * A
 *
 * H = normalised H1-H2 (dB), A = aspiration index. H1-H2 carries the low end (how firmly the folds
 * close) and the aspiration index the high end; above 12 dB a strong H1 says more about register
 * than air, so it counts less.
 *
 * Anchored on real voices: clean, modal solo singing (four male singers, amateur to trained, and
 * one clean high voice) reads normalised H1-H2 of about -2.5 to +6 dB with no aspiration (CPP
 * 23-32 dB), which maps to ~0.28-0.44, the "clear, balanced" band of the StyleVector. No real
 * breathy singing was available to calibrate the top: a voice that adds +5-10 dB of H1-H2 and
 * aspiration (A 0.3-0.6) should read about 0.6-0.75, so treat that end as provisional. The
 * synthesiser keeps the same order but sits higher, because its source has a stronger H1 than a
 * real voice (take medians on vowel /a/, G3-D4): pressed (tilt -6) 0.44, modal (tilt -12) 0.52,
 * breathy (breath 0.6) 0.80; /o/ reads about 0.1 lower. Frames firmer than H = -10 dB (belting,
 * or a microphone that cuts the bass, which lowers H1) all read 0.13. The value depends on the
 * microphone's bass response (a phone-like 250 Hz roll-off lowers it by 0.1-0.15), so compare takes
 * made on the same device. Near-whisper frames that are too noisy to be voiced count as
 * WHISPER_BREATHINESS.
 */
export function breathinessIndex(h1h2NormDb: number, aspiration: number): number {
  if (Number.isNaN(h1h2NormDb) || Number.isNaN(aspiration)) return NaN;
  const h = h1h2NormDb;
  return clamp(0.3 + 0.017 * clamp(h, -10, 12) + 0.01 * Math.max(0, h - 12) + 0.3 * aspiration, 0, 1);
}

/** Breathiness assigned to near-whisper frames: sound with some periodicity but too noisy to be voiced. */
export const WHISPER_BREATHINESS = 0.92;

/**
 * Brightness from the pitch-normalised harmonic slope (features.harmonicSlope, dB/oct), piecewise
 * linear through the synthesiser anchors on vowel /a/ over G3-D4: output slope -6 dB/oct reads
 * about -2.6 -> 0.8, -12 dB/oct about -4.8 -> 0.5, -20 dB/oct about -10 -> 0.2. Aspiration noise is
 * excluded by the measure, so a breathy tone is judged by its harmonics. Rounder or closed vowels
 * read darker (/o/ about 3 dB/oct lower, /e/ about 5), which matches how they sound.
 */
const BRIGHTNESS_KNOTS: [number, number][] = [
  [-16, 0.03],
  [-10, 0.2],
  [-4.8, 0.5],
  [-2.6, 0.8],
  [0, 0.95],
];

export function brightnessFromSlope(slopeDbPerOct: number): number {
  if (Number.isNaN(slopeDbPerOct)) return NaN;
  const k = BRIGHTNESS_KNOTS;
  if (slopeDbPerOct <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (slopeDbPerOct <= k[i][0]) {
      const [x0, y0] = k[i - 1];
      const [x1, y1] = k[i];
      return y0 + ((slopeDbPerOct - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return k[k.length - 1][1];
}

/**
 * Rasp of one voiced frame, 0..1: subharmonic energy, confirmed by irregular vibration and
 * discounted by breath.
 *
 *   r = S * (0.3 + 0.7 * max(P, J)) * (1 - 0.6 * A)
 *
 * S = subharmonic level mapped -36 dB -> 0, -18 dB -> 1 (DSP: clean -60, breath-type voices -35 to
 *     -51, rasp -13 to -30; a clean 1 % jitter can read about -30 at high pitch, hence the
 *     stricter lower end than the DSP's suggested -45).
 * P = aperiodicity despite a voiced frame: periodicity 0.97 -> 0, 0.72 -> 1 (rasp reads 0.1-0.65
 *     because the subharmonics count as aperiodic energy).
 * J = frame-to-frame pitch perturbation (median |second difference|, cents) 3 -> 0, 9 -> 1:
 *     jittery vibration (rasp 5-22 cents) versus breathy (1.5-3) or vibrato (~2).
 * A = aspiration index. Breath noise also lowers periodicity, but it lowers CPP as well, which
 *     rasp does not; this term keeps a breathy-but-clean voice from reading as rough.
 */
export function raspIndex(subharmonicDb: number, periodicity: number, perturbationCents: number, aspiration: number): number {
  if (Number.isNaN(subharmonicDb) || Number.isNaN(aspiration)) return NaN;
  const s = clamp((subharmonicDb + 36) / 18, 0, 1);
  if (s === 0) return 0;
  const p = clamp((0.97 - periodicity) / 0.25, 0, 1);
  const j = Number.isNaN(perturbationCents) ? 0 : clamp((perturbationCents - 3) / 6, 0, 1);
  return clamp(s * (0.3 + 0.7 * Math.max(p, j)) * (1 - 0.6 * aspiration), 0, 1);
}

/** Local pitch perturbation: median over +/-5 frames of |second difference| of the contour, cents. */
export function pitchPerturbation(frames: FrameFeatures[]): Float64Array {
  const n = frames.length;
  const d2 = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n - 1; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    const c = frames[i + 1];
    if (a.voiced && b.voiced && c.voiced) d2[i] = Math.abs(100 * (b.midi - 0.5 * (a.midi + c.midi)));
  }
  const out = new Float64Array(n).fill(NaN);
  const vals: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!frames[i].voiced) continue;
    vals.length = 0;
    for (let k = Math.max(0, i - 5); k <= Math.min(n - 1, i + 5); k++) if (!Number.isNaN(d2[k])) vals.push(d2[k]);
    if (vals.length >= 3) out[i] = median(vals);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Take-level StyleVector

export interface StyleInput {
  track: FrameTrack;
  /** Per-frame flag: unvoiced but whisper-like (see analyze.ts). */
  whisperFrames: Uint8Array;
  zone: PassaggioZone;
  notes: NoteSegment[];
  runs: Run[];
  onsets: Onset[];
  flipCount: number;
  voicedSec: number;
}

const MIN_TONE_SEC = 0.5;
const MIN_UPPER_SEC = 0.5;
const MIN_CLIMB_SEC = 1;
const MIN_CLIMB_SPREAD = 3;
const CLIMB_BELOW_PASSAGGIO = 3;
const MIN_AGILITY_SEC = 3;
const MIN_DYNAMICS_SEC = 1;
const MIN_FLIP_SEC = 3;
/**
 * Pitch accuracy is judged on held notes only. Shorter notes are mostly syllables, glides and
 * ornaments whose "pitch" is a passing value, and made even speech read like singing.
 */
const ACCURACY_NOTE_SEC = 0.4;
const ACCURACY_MIN_NOTES = 3;
/** A held note: long enough for vibrato (vibrato.ts) and for the speech-like check (analyze.ts). */
export const SUSTAINED_NOTE_SEC = 0.45;

const orNull = (x: number): number | null => (Number.isFinite(x) ? x : null);

export function computeStyle(input: StyleInput): StyleVector {
  const { track, whisperFrames, zone, notes, runs, onsets, flipCount, voicedSec } = input;
  const { frames, hopSec } = track;
  const minFrames = (sec: number) => Math.round(sec / hopSec);

  const breath: number[] = [];
  const slopes: number[] = [];
  const voicedLevels: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.voiced) {
      const b = breathinessIndex(track.h1h2Norm[i], track.aspiration[i]);
      if (!Number.isNaN(b)) breath.push(b);
      if (!Number.isNaN(track.harmonicSlope[i])) slopes.push(track.harmonicSlope[i]);
      voicedLevels.push(f.rmsDb);
    } else if (whisperFrames[i]) {
      breath.push(WHISPER_BREATHINESS);
    }
  }
  const breathiness = breath.length >= minFrames(MIN_TONE_SEC) ? median(breath) : NaN;
  const brightness = slopes.length >= minFrames(MIN_TONE_SEC) ? brightnessFromSlope(median(slopes)) : NaN;

  // Rasp: mean over the louder half of voiced frames ("grit on louder notes").
  const medianLevel = median(voicedLevels);
  const perturbation = pitchPerturbation(frames);
  const raspVals: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!f.voiced || f.rmsDb < medianLevel) continue;
    const r = raspIndex(track.subharmonicDb[i], f.periodicity, perturbation[i], track.aspiration[i]);
    if (!Number.isNaN(r)) raspVals.push(r);
  }
  const rasp = voicedLevels.length >= minFrames(MIN_TONE_SEC) && raspVals.length > 0 ? mean(raspVals) : NaN;

  // Vibrato over sustained notes.
  const sustained = notes.filter((n) => n.end - n.start >= SUSTAINED_NOTE_SEC - 1e-9);
  const withVib = sustained.filter((n) => n.vibrato !== null);
  const vibratoPresence = sustained.length > 0 ? withVib.length / sustained.length : NaN;
  const vibratoRateHz = withVib.length > 0 ? median(withVib.map((n) => n.vibrato?.rateHz ?? NaN)) : NaN;
  const vibratoExtentCents = withVib.length > 0 ? median(withVib.map((n) => n.vibrato?.extentCents ?? NaN)) : NaN;

  // Registers in the upper range.
  const upper = registerShares(frames, (f) => f.midi >= zone.lowMidi);
  const upperOk = upper.count >= minFrames(MIN_UPPER_SEC);

  // Loudness climb across the upper range and the three semitones below it.
  const climbMidi: number[] = [];
  const climbDb: number[] = [];
  for (const f of frames) {
    if (!f.voiced || f.midi < zone.lowMidi - CLIMB_BELOW_PASSAGGIO) continue;
    climbMidi.push(f.midi);
    climbDb.push(f.rmsDb);
  }
  let loudnessClimb = NaN;
  if (climbMidi.length >= minFrames(MIN_CLIMB_SEC) && percentile(climbMidi, 95) - percentile(climbMidi, 5) >= MIN_CLIMB_SPREAD) {
    loudnessClimb = linearRegression(climbMidi, climbDb).slope;
  }

  const agility = voicedSec < MIN_AGILITY_SEC ? NaN : runs.length === 0 ? 0 : median(runs.map((r) => r.notesPerSec));
  const dynamicRangeDb =
    voicedSec < MIN_DYNAMICS_SEC ? NaN : percentile(voicedLevels, 95) - percentile(voicedLevels, 5);
  const softOnsetRatio = onsets.length >= 2 ? onsets.filter((o) => o.type === 'breathy').length / onsets.length : NaN;
  const accuracyNotes = notes.filter((n) => n.end - n.start >= ACCURACY_NOTE_SEC - 1e-9);
  const pitchAccuracyCents =
    accuracyNotes.length >= ACCURACY_MIN_NOTES ? mean(accuracyNotes.map((n) => Math.abs(n.centsOff))) : NaN;
  const flipsPerMinute = voicedSec < MIN_FLIP_SEC ? NaN : flipCount / (voicedSec / 60);

  return {
    breathiness: orNull(breathiness),
    brightness: orNull(brightness),
    rasp: orNull(rasp),
    vibratoPresence: orNull(vibratoPresence),
    vibratoRateHz: orNull(vibratoRateHz),
    vibratoExtentCents: orNull(vibratoExtentCents),
    chestInUpperRange: upperOk ? upper.chest : null,
    mixInUpperRange: upperOk ? upper.mix : null,
    headInUpperRange: upperOk ? upper.head : null,
    loudnessClimbDbPerSemitone: orNull(loudnessClimb),
    agility: orNull(agility),
    dynamicRangeDb: orNull(dynamicRangeDb),
    softOnsetRatio: orNull(softOnsetRatio),
    pitchAccuracyCents: orNull(pitchAccuracyCents),
    flipsPerMinute: orNull(flipsPerMinute),
  };
}
