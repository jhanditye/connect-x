// Recording-quality measures and the plain-English warnings built from them, with the matching
// machine-readable issue codes (VoiceAnalysis.issues).

import { median, percentile } from '../dsp/stats';
import type { AnalysisIssue, AudioQuality, FrameFeatures, VoiceType } from '../types';
import { VOICE_TYPE_NAMES } from './passaggio';
import { PHRASE_MERGE_GAP_SEC } from './phrases';

export const CLIP_LEVEL = 0.999;
const MIN_UNVOICED_FOR_FLOOR = 50;
const SILENCE_DB = -120;

export const WARN_MIN_VOICED_SEC = 3;
export const WARN_MAX_CLIPPING = 0.001;
export const WARN_MIN_SNR_DB = 20;
export const WARN_MIN_LEVEL_DB = -40;
/** With no singing found, a take whose loudest frames (95th percentile) are below this is too quiet to judge. */
export const WARN_QUIET_INPUT_DB = -50;
const DIGITAL_SILENCE_DB = -100;

/**
 * Singing over instruments. Pauses between phrases (unvoiced stretches of at least 0.25 s between
 * the first and last voiced frame) are near-silent in a solo take: 25-50 dB below the singing on
 * real a cappella and speech recordings. In a song mix they carry the band, only 0-9 dB below the
 * voice. Loud pauses alone are not enough (a very noisy room gets there too), so the pauses must
 * also sound like several instruments at once: pitched but not cleanly periodic, median YIN
 * periodicity 0.3-0.45 in mixes, under 0.1 for fans, hiss and traffic. Clean periodicity (0.97-1)
 * in an unvoiced pause means one source that only missed the voicing gate: singing too quiet to
 * pass the -60 dBFS floor, or a reverb tail (whose median level also stays 20 dB or more down).
 */
const ACC_MIN_PAUSE_SEC = 0.5;
const ACC_MAX_PAUSE_DROP_DB = 12;
const ACC_MIN_PAUSE_PERIODICITY = 0.25;
const ACC_MAX_PAUSE_PERIODICITY = 0.7;
/**
 * Airy singing looks like a mix on level and periodicity alone: its aspiration often drops below
 * the voicing gate mid-phrase, at the singing level with periodicity 0.3-0.45. What differs is the
 * spectrum. Accompaniment in a pause is tonal (bass, chords, pads): zero-crossing rate 0.02-0.06
 * per sample at the median in real mixes, 0.2 or less for 90% of frames. Aspiration and breath
 * noise read 0.35-0.5. Pause frames at or above this rate are left out of the pause measurements.
 */
const ACC_MAX_TONAL_ZCR = 0.3;
/**
 * A second cue for the higher (female) voice types: a pitch track mostly below C3 means the
 * tracker followed a bass line (not used for male voices: low baritones really sing there). With
 * it, fainter pitched pauses (down to 20 dB below the voice) also count as accompaniment; without
 * pitched pauses it only gets a hint to check the voice type.
 */
const LOW_TRACK_MIDI = 48;
const LOW_TRACK_SHARE = 0.3;
const ACC_LOW_TRACK_MAX_DROP_DB = 20;
const HIGH_VOICE_TYPES: VoiceType[] = ['alto', 'mezzo', 'soprano'];

/** Share of samples at or beyond +/-CLIP_LEVEL (non-finite samples are ignored). */
export function clippingRatio(x: Float32Array): number {
  if (x.length === 0) return 0;
  let clipped = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) >= CLIP_LEVEL) clipped++;
  return clipped / x.length;
}

/**
 * Noise floor = 10th percentile of frame RMS, measured over unvoiced frames when there are enough
 * of them (>= 0.5 s). A take that is sung almost throughout (tightly trimmed, legato) has no
 * silence to measure: its floor falls back to all frames, which is really the quietest singing.
 * That fallback is still used as a level gate (onsets, whisper frames), but the SNR is then
 * unknown and reported as NaN (null in JSON) rather than as a bad SNR for a clean recording.
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
  const floorMeasured = unvoiced.length >= MIN_UNVOICED_FOR_FLOOR;
  const base = floorMeasured ? unvoiced : all;
  const floor = base.length > 0 ? Math.max(SILENCE_DB, percentile(base, 10)) : SILENCE_DB;
  const voicedLevel = median(voiced);
  return {
    clippingRatio: clipping,
    noiseFloorDb: floor,
    snrDb: Number.isNaN(voicedLevel) ? 0 : floorMeasured ? voicedLevel - floor : NaN,
  };
}

/** What the pauses between phrases sound like, and where the pitch track sits (see ACC_* above). */
export interface AccompanimentCues {
  /** Seconds of pauses of at least 0.25 s between the first and last voiced frame (tonal frames only). */
  pauseSec: number;
  /** Median frame RMS in those pauses minus the median voiced RMS, dB; NaN without pauses. */
  pauseLevelDb: number;
  /** Median YIN periodicity in those pauses; NaN without pauses. */
  pausePeriodicity: number;
  /** Share of voiced frames below C3 (MIDI 48). */
  belowC3Share: number;
}

/**
 * `singing` marks unvoiced frames that are still the singer (analyze.ts's near-whisper frames:
 * aspiration clearly above the noise floor, partly periodic, noise-like); they are not pauses.
 * `zcr` is each unvoiced frame's zero-crossing rate per sample: noise-like pause frames (see
 * ACC_MAX_TONAL_ZCR) are left out, which also covers airy takes with no silence to measure the
 * noise floor from (where the whisper gate is too high).
 */
export function measureAccompaniment(frames: FrameFeatures[], hopSec: number, singing?: Uint8Array, zcr?: Float32Array): AccompanimentCues {
  let first = -1;
  let last = -1;
  const voicedLevels: number[] = [];
  let low = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (!f.voiced) continue;
    if (first < 0) first = i;
    last = i;
    voicedLevels.push(f.rmsDb);
    if (f.midi < LOW_TRACK_MIDI) low++;
  }
  const pauseLevels: number[] = [];
  const pausePeriodicity: number[] = [];
  const minPause = Math.round(PHRASE_MERGE_GAP_SEC / hopSec);
  const sung = (k: number) => frames[k].voiced || singing?.[k] === 1;
  let i = first;
  while (first >= 0 && i <= last) {
    if (sung(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j <= last && !sung(j)) j++;
    if (j - i >= minPause) {
      for (let k = i; k < j; k++) {
        if (zcr !== undefined && zcr[k] >= ACC_MAX_TONAL_ZCR) continue;
        pauseLevels.push(frames[k].rmsDb);
        pausePeriodicity.push(frames[k].periodicity);
      }
    }
    i = j;
  }
  const hasPauses = pauseLevels.length > 0 && voicedLevels.length > 0;
  return {
    pauseSec: pauseLevels.length * hopSec,
    pauseLevelDb: hasPauses ? median(pauseLevels) - median(voicedLevels) : NaN,
    pausePeriodicity: hasPauses ? median(pausePeriodicity) : NaN,
    belowC3Share: voicedLevels.length > 0 ? low / voicedLevels.length : 0,
  };
}

function pitchedPauses(c: AccompanimentCues, maxDropDb: number): boolean {
  return (
    c.pauseSec >= ACC_MIN_PAUSE_SEC - 1e-9 &&
    c.pauseLevelDb > -maxDropDb &&
    c.pausePeriodicity >= ACC_MIN_PAUSE_PERIODICITY &&
    c.pausePeriodicity < ACC_MAX_PAUSE_PERIODICITY
  );
}

function fmt(x: number, digits = 0): string {
  const s = x.toFixed(digits);
  return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}

export interface QualityInput {
  voicedSec: number;
  quality: AudioQuality;
  medianVoicedDb: number;
  /** 95th percentile of frame RMS over the whole take, dBFS (how loud its loudest sounds are). */
  levelP95Db?: number;
  /** Number of held notes (at least SUSTAINED_NOTE_SEC long). */
  heldNotes?: number;
  accompaniment?: AccompanimentCues;
  voiceType?: VoiceType;
}

/** Warnings about the recording itself, each with the fix, and the matching issue codes. */
export function qualityReport(input: QualityInput): { warnings: string[]; issues: AnalysisIssue[] } {
  const w: string[] = [];
  const issues: AnalysisIssue[] = [];
  const flag = (issue: AnalysisIssue) => {
    if (!issues.includes(issue)) issues.push(issue);
  };
  const { voicedSec, quality, medianVoicedDb, levelP95Db, heldNotes, accompaniment, voiceType } = input;

  if (voicedSec < WARN_MIN_VOICED_SEC) {
    flag('too-little-singing');
    if (voicedSec < 0.2) {
      let text = 'No clear singing was detected. Sing at least 10 seconds of sustained notes (not whispering or speaking) and try again.';
      if (levelP95Db !== undefined && levelP95Db < WARN_QUIET_INPUT_DB) {
        text +=
          levelP95Db <= DIGITAL_SILENCE_DB
            ? ' The recording is silent: check that the right microphone is selected and not muted.'
            : ` The input is very quiet (its loudest sounds are around ${fmt(levelP95Db)} dBFS): check that the right microphone is selected and raise its input gain.`;
        flag('too-quiet');
      }
      w.push(text);
    } else {
      w.push(`Only ${fmt(voicedSec, 1)} s of singing was detected, which is too little for reliable measurements. Record at least 10 seconds of singing.`);
    }
  }

  let backed = false;
  if (accompaniment && voicedSec >= 0.2) {
    const highVoice = voiceType !== undefined && HIGH_VOICE_TYPES.includes(voiceType);
    const lowTrack = highVoice && accompaniment.belowC3Share > LOW_TRACK_SHARE;
    backed = pitchedPauses(accompaniment, ACC_MAX_PAUSE_DROP_DB) || (lowTrack && pitchedPauses(accompaniment, ACC_LOW_TRACK_MAX_DROP_DB));
    if (backed) {
      flag('accompaniment');
      const drop = -accompaniment.pauseLevelDb;
      const level = drop < 1.5 ? 'between phrases the music is about as loud as the voice' : `between phrases the music is only ${fmt(drop)} dB quieter than the voice`;
      w.push(
        `This sounds like singing over instruments or a backing track (${level}). The analysis follows the loudest pitched sound, which can be the bass or another instrument rather than the singer${
          lowTrack ? ' (much of the pitch it tracked sits below C3, so it probably followed the bass)' : ''
        }, so these measurements are not reliable. Use an isolated vocal or an a cappella section, or record yourself with the backing track in headphones rather than on a speaker.`,
      );
    } else if (lowTrack && voiceType) {
      w.push(
        `Much of the pitch we tracked sits below C3, which is unusual for a ${VOICE_TYPE_NAMES[voiceType].toLowerCase()}. If there is music behind the voice, the analysis may be following the bass: use an isolated vocal. If the voice really is that low, choose a lower voice type in Settings.`,
      );
    }
  }

  if (heldNotes !== undefined && voicedSec >= WARN_MIN_VOICED_SEC && heldNotes === 0) {
    flag('speech-like');
    w.push(
      'We heard only short, speech-like sounds and no held notes, so the tone, vibrato and register numbers may not reflect your singing. Sing a melody with a few held notes.',
    );
  }
  if (quality.clippingRatio > WARN_MAX_CLIPPING) {
    flag('clipping');
    w.push(
      `The recording is clipping (${fmt(quality.clippingRatio * 100, 1)}% of samples hit full scale), which distorts the tone measurements. Move back from the microphone or lower the input gain.`,
    );
  }
  // A song mix also reads as a low SNR; the accompaniment warning above gives the right fix.
  if (!backed && voicedSec >= 0.2 && Number.isFinite(quality.snrDb) && quality.snrDb < WARN_MIN_SNR_DB) {
    flag('noisy');
    w.push(
      `There is a lot of background noise (singing is only ${fmt(quality.snrDb)} dB above it), so breathiness and tone readings are less reliable. Record in a quieter room, away from fans and traffic, and a little closer to the microphone.`,
    );
  }
  if (voicedSec >= 0.2 && Number.isFinite(medianVoicedDb) && medianVoicedDb < WARN_MIN_LEVEL_DB) {
    flag('too-quiet');
    w.push(`The recording is very quiet (typical singing level ${fmt(medianVoicedDb)} dBFS). Move closer to the microphone or raise the input gain.`);
  }
  return { warnings: w, issues };
}

/** Warnings about the recording itself, each with the fix (see qualityReport for the issue codes). */
export function qualityWarnings(input: QualityInput): string[] {
  return qualityReport(input).warnings;
}
