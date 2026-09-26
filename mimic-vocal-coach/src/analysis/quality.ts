// Recording-quality measures and the plain-English warnings built from them.

import { median, percentile } from '../dsp/stats';
import type { AudioQuality, FrameFeatures } from '../types';

export const CLIP_LEVEL = 0.999;
const MIN_UNVOICED_FOR_FLOOR = 50;
const SILENCE_DB = -120;

export const WARN_MIN_VOICED_SEC = 3;
export const WARN_MAX_CLIPPING = 0.001;
export const WARN_MIN_SNR_DB = 20;
export const WARN_MIN_LEVEL_DB = -40;

/** Share of samples at or beyond +/-CLIP_LEVEL (non-finite samples are ignored). */
export function clippingRatio(x: Float32Array): number {
  if (x.length === 0) return 0;
  let clipped = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= CLIP_LEVEL) clipped++;
  return clipped / x.length;
}

/**
 * Noise floor = 10th percentile of frame RMS. Measured over unvoiced frames when there are enough
 * of them (>= 0.5 s): a take that is sung almost throughout would otherwise put its "noise floor"
 * at the quietest singing and report a bad SNR for a clean recording.
 */
export function measureQuality(frames: FrameFeatures[], clipping: number): AudioQuality {
  const unvoiced: number[] = [];
  const all: number[] = [];
  const voiced: number[] = [];
  for (const f of frames) {
    all.push(f.rmsDb);
    if (f.voiced) voiced.push(f.rmsDb);
    else unvoiced.push(f.rmsDb);
  }
  const base = unvoiced.length >= MIN_UNVOICED_FOR_FLOOR ? unvoiced : all;
  const floor = base.length > 0 ? Math.max(SILENCE_DB, percentile(base, 10)) : SILENCE_DB;
  const voicedLevel = median(voiced);
  return {
    clippingRatio: clipping,
    noiseFloorDb: floor,
    snrDb: Number.isNaN(voicedLevel) ? 0 : voicedLevel - floor,
  };
}

function fmt(x: number, digits = 0): string {
  return x.toFixed(digits);
}

/** Warnings about the recording itself, each with the fix. */
export function qualityWarnings(input: {
  voicedSec: number;
  quality: AudioQuality;
  medianVoicedDb: number;
}): string[] {
  const w: string[] = [];
  const { voicedSec, quality, medianVoicedDb } = input;
  if (voicedSec < WARN_MIN_VOICED_SEC) {
    w.push(
      voicedSec < 0.2
        ? 'No clear singing was detected. Sing at least 10 seconds of sustained notes (not whispering or speaking) and try again.'
        : `Only ${fmt(voicedSec, 1)} s of singing was detected, which is too little for reliable measurements. Record at least 10 seconds of singing.`,
    );
  }
  if (quality.clippingRatio > WARN_MAX_CLIPPING) {
    w.push(
      `The recording is clipping (${fmt(quality.clippingRatio * 100, 1)}% of samples hit full scale), which distorts the tone measurements. Move back from the microphone or lower the input gain.`,
    );
  }
  if (voicedSec >= 0.2 && quality.snrDb < WARN_MIN_SNR_DB) {
    w.push(
      `There is a lot of background noise (singing is only ${fmt(quality.snrDb)} dB above it), so breathiness and tone readings are less reliable. Record in a quieter room, away from fans and traffic, and a little closer to the microphone.`,
    );
  }
  if (voicedSec >= 0.2 && Number.isFinite(medianVoicedDb) && medianVoicedDb < WARN_MIN_LEVEL_DB) {
    w.push(
      `The recording is very quiet (typical singing level ${fmt(medianVoicedDb)} dBFS). Move closer to the microphone or raise the input gain.`,
    );
  }
  return w;
}
