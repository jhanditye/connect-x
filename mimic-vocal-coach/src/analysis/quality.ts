// Recording-quality measures and the plain-English warnings built from them, with the matching
// machine-readable issue codes (VoiceAnalysis.issues).

import { median, percentile } from '../dsp/stats';
import type { AnalysisIssue, AudioQuality, FrameFeatures, VoiceAnalysis, VoiceType } from '../types';
import { ROUGH_GUIDE_PURITY } from './leadTrust';
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

/**
 * A second opinion on the melody: vocal-forward songs (the voice a few dB above a steady band) look like a clean recording to
 * the pause checks above, because there is no real pause, and the plain tracker follows the bass or a guitar half of the time.
 * The lead-vocal extractor (dsp/melody) suppresses sounds that sit still in every bin and so mostly follows the singer; on a
 * solo recording the two agree. So, over the frames where both report a pitch, the share of frames within 1 semitone of
 * each other (`agree`) and the same with octave errors forgiven (`agreeOctave`, 150 cents: either tracker alone can land an octave
 * off a clean voice, a raspy one or one in a reverberant room, which says nothing about a band) tell the two cases apart. Measured on proxy mixes (songMix.ts: chord, bass
 * and drum band; moving bass line; backing voices), 12 real or synthetic solo and speech clips with 14 noisy variants:
 * solo and speech never went below agree 0.82 / agreeOctave 0.88 except when one tracker is an octave off (agreeOctave >= 0.95);
 * mixes with the voice 3 dB over the band 0.43-0.60 / 0.58-0.86, at 0 dB 0.30-0.41 / 0.55-0.80, 6 dB over the band 0.56-0.77 / 0.70-0.89.
 * Both must be low, and the check only runs where the cheap cues already look suspicious (see leadCheckWorthRunning).
 */
export const LEAD_MAX_AGREE = 0.75;
export const LEAD_MAX_AGREE_OCTAVE = 0.88;
/** Fewest frames (0.5 s) where both trackers report a pitch before their agreement means anything. */
export const LEAD_MIN_BOTH_FRAMES = 50;
/** Pitch classes count as agreeing within this many cents (wider than the 100 for the exact pitch: a subharmonic or reverberant voice puts the octave-off tracker 100-150 cents out). */
export const LEAD_OCTAVE_TOLERANCE_CENTS = 150;
/** Clean solo takes have a median YIN periodicity of 0.97-1 and an SNR of 25 dB or more; only clips beyond these are checked. */
const LEAD_CLEAN_PERIODICITY = 0.95;
const LEAD_CLEAN_SNR_DB = 25;

export interface LeadAgreement {
  /** Frames where the plain tracker and the extractor both report a pitch. */
  bothFrames: number;
  /** Share of those within 100 cents of each other. */
  agree: number;
  /** Share within LEAD_OCTAVE_TOLERANCE_CENTS of the same pitch class (octave errors forgiven). */
  agreeOctave: number;
}

/** Frame-by-frame agreement between the analysis frames (YIN) and the extractor's track (same 10 ms grid). */
export function measureLeadAgreement(frames: FrameFeatures[], leadF0: ArrayLike<number>, leadVoiced: ArrayLike<number>): LeadAgreement {
  const n = Math.min(frames.length, leadF0.length, leadVoiced.length);
  let both = 0;
  let agree = 0;
  let agreeOctave = 0;
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    if (!f.voiced || !leadVoiced[i] || !(leadF0[i] > 0) || !(f.f0 > 0)) continue;
    both++;
    const cents = Math.abs(1200 * Math.log2(leadF0[i] / f.f0));
    if (cents < 100) agree++;
    const folded = cents % 1200;
    if (Math.min(folded, 1200 - folded) < LEAD_OCTAVE_TOLERANCE_CENTS) agreeOctave++;
  }
  return { bothFrames: both, agree: both > 0 ? agree / both : 1, agreeOctave: both > 0 ? agreeOctave / both : 1 };
}

/** True when the two trackers follow different melodies: a song with the voice only a little above the band. */
export function leadDisagrees(c: LeadAgreement): boolean {
  return c.bothFrames >= LEAD_MIN_BOTH_FRAMES && c.agree < LEAD_MAX_AGREE && c.agreeOctave < LEAD_MAX_AGREE_OCTAVE;
}

/**
 * Whether the (slower) extractor check is worth running: not for a clip that already looks like a clean solo take (the
 * caller skips it for a clip the pause checks already flagged). `medianPeriodicity` is the median YIN periodicity of the voiced frames, `snrDb` NaN when no silence was found.
 */
export function leadCheckWorthRunning(input: { voicedSec: number; medianPeriodicity: number; snrDb: number }): boolean {
  if (input.voicedSec < WARN_MIN_VOICED_SEC) return false;
  const clean = input.medianPeriodicity >= LEAD_CLEAN_PERIODICITY && Number.isFinite(input.snrDb) && input.snrDb >= LEAD_CLEAN_SNR_DB;
  return !clean;
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
  /** Agreement of the plain tracker with the lead-vocal extractor, when it was measured (see LEAD_MAX_AGREE). */
  leadAgreement?: LeadAgreement;
  voiceType?: VoiceType;
}

/** Warnings about the recording itself, each with the fix, and the matching issue codes. */
export function qualityReport(input: QualityInput): { warnings: string[]; issues: AnalysisIssue[] } {
  const w: string[] = [];
  const issues: AnalysisIssue[] = [];
  const flag = (issue: AnalysisIssue) => {
    if (!issues.includes(issue)) issues.push(issue);
  };
  const { voicedSec, quality, medianVoicedDb, levelP95Db, heldNotes, accompaniment, leadAgreement, voiceType } = input;

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
  // Vocal-forward song: no real pauses to hear the band in, but a second way of following the melody disagrees with the first.
  if (!backed && leadAgreement && voicedSec >= WARN_MIN_VOICED_SEC && leadDisagrees(leadAgreement)) {
    backed = true;
    flag('accompaniment');
    w.push(
      `This sounds like a song with instruments behind the voice: two ways of following the melody disagreed on ${fmt((1 - leadAgreement.agree) * 100)}% of it, which usually means one of them was following the bass or a guitar instead of the singer. The measurements are not reliable as they are. Use the full-song reading, an isolated vocal or an a cappella section, or record yourself with the backing track in headphones rather than on a speaker.`,
    );
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

// ---------------------------------------------------------------------------------------------
// Full-song (mix) mode: routing and the confidence warnings. The numbers come from the proxy-mix evaluation of the
// lead-vocal extractor (dsp/melody): clips with confidence 0.70-0.80 had a raw pitch accuracy of about 0.55, 0.80-0.88
// about 0.80 and above 0.88 about 0.87. The confidence itself was calibrated on synthetic mixes: a ranking, not a promise.

/** Below this the lead vocal was hard to follow: warn. */
export const MIX_CONFIDENCE_WARN = 0.8;
/** Below this the contour is a rough guide at best. */
export const MIX_CONFIDENCE_POOR = 0.7;
/** At or above this the extraction was clear. */
export const MIX_CONFIDENCE_HIGH = 0.88;

export type MixConfidenceBand = 'high' | 'ok' | 'low' | 'poor';

/** high >= 0.88, ok 0.80-0.88, low 0.70-0.80 (warned), poor < 0.70 (warned, stem recommended). Non-finite counts as poor. */
export function mixConfidenceBand(confidence: number): MixConfidenceBand {
  if (!(confidence >= MIX_CONFIDENCE_POOR)) return 'poor';
  if (confidence < MIX_CONFIDENCE_WARN) return 'low';
  return confidence < MIX_CONFIDENCE_HIGH ? 'ok' : 'high';
}

/**
 * Whether a solo analysis suggests the audio is a full song, so the caller may offer (or just run) the same audio again
 * in mix mode. The pause checks alone flagged 'accompaniment' on about 78% of mixes and missed the vocal-forward ones (proxy
 * mixes over a chord, bass and drum band: 0 of 5 at +3 dB, 1 of 5 at 0 dB; over a moving bass line 0 of 5 down to -6 dB). With
 * the second opinion from the lead-vocal extractor (LEAD_MAX_AGREE) the same grid is flagged 14 of 15 at +3 dB and 15 of 15 at 0
 * dB and below (8 of 15 at +6 dB, 3 of 15 at +9 dB, none at +12 dB, where the solo reading is fine), with no false alarm of its
 * own on 207 solo, speech, breathy, raspy, noisy and reverberant clips (the pause checks already raise two on speech with 15 dB
 * of mains hum). Mixes with a melodic instrument in unison with the voice (a violin line, the real clip 'varnam') are still
 * missed, which is why there is also a manual full-song choice.
 */
export function suggestsFullSong(analysis: Pick<VoiceAnalysis, 'mode' | 'issues'>): boolean {
  return analysis.mode !== 'mix' && (analysis.issues ?? []).includes('accompaniment');
}

/**
 * How far to trust a mix-mode extraction, from its clip confidence and (when present) the note-trust purity. The confidence
 * ranks clips but stays high when the extractor follows a moving bass line; purity (leadTrust.ts) is what catches a line that is
 * partly the band, so a rough guide (purity under ROUGH_GUIDE_PURITY) is never better than 'low', and under 0.5 it is 'poor'.
 */
export function mixTrustBand(le: { confidence: number; purity?: number }): MixConfidenceBand {
  const band = mixConfidenceBand(le.confidence);
  if (le.purity === undefined || !Number.isFinite(le.purity)) return band;
  if (le.purity < 0.5) return 'poor';
  if (le.purity < ROUGH_GUIDE_PURITY && (band === 'high' || band === 'ok')) return 'low';
  return band;
}

/** Warnings and issue codes for a mix-mode analysis from the extractor's clip confidence, the singing it found and how much of it is the voice. */
export function mixReport(input: { confidence: number; voicedSec: number; purity?: number }): { warnings: string[]; issues: AnalysisIssue[] } {
  const warnings: string[] = [];
  const issues: AnalysisIssue[] = [];
  const { confidence, voicedSec, purity } = input;
  if (!(voicedSec >= WARN_MIN_VOICED_SEC)) {
    issues.push('too-little-singing');
    warnings.push(
      voicedSec < 0.2
        ? 'No lead vocal could be followed in this clip. It may be an instrumental section, or the voice is too far below the band. Try a section with continuous singing, or use a vocal-only file.'
        : `Only ${fmt(voicedSec, 1)} s of lead vocal could be followed, which is too little to compare. Pick a section with continuous singing, or use a vocal-only file.`,
    );
    return { warnings, issues };
  }
  const band = mixConfidenceBand(confidence);
  if (band === 'poor') {
    warnings.push(
      'The lead vocal was very hard to follow in this song, so treat the contour as a rough guide and check it against the music. A vocal-only file (a vocal stem or an a cappella section) works far better.',
    );
  } else if (band === 'low') {
    warnings.push(
      'The lead vocal was hard to follow in places, so check the contour against the song before trusting it. A section where the voice is more forward, or a vocal-only file, works better.',
    );
  } else if (purity !== undefined && purity < ROUGH_GUIDE_PURITY) {
    // The confidence looks fine (a steady bass line scores as well as a voice) but the line has too many band-like notes in it.
    warnings.push(
      `Only about ${fmt(Math.max(0, purity) * 100)}% of the melody that was followed looks like the lead voice; the rest is probably the band (bass, guitar or keys). Treat the contour as a rough guide: notes you do not sing may be the band's, not yours to hit. A vocal-only file works far better.`,
    );
  }
  return { warnings, issues };
}
