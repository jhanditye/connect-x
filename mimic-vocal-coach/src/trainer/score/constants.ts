// Every tunable number of the scorer in one place, with where it comes from.
// "E1" = out/noise.json (feature repeatability under mic/noise/room/level/key/tempo changes, 7 subjects).
// "E2" = injected-error calibration on synthetic ground truth (out/inj.log). "E3" = human-like profiles (out/human.log).
// "E4" = real clips (out/real.log). "E5" = practical cases (out/practical.log). "E6" = tone-index key dependence and injected tone changes (out/tone.log).

/** Skill weights. Pitch and timing are what a teacher checks first; tone is limited by anatomy and the recording chain. */
export const WEIGHTS_SUNG = { pitch: 0.4, timing: 0.25, tone: 0.2, expression: 0.15 } as const;
/** Speech-like phrases: melody is loosely defined, rhythm and delivery carry the imitation. */
export const WEIGHTS_SPEECH = { pitch: 0.15, timing: 0.45, tone: 0.25, expression: 0.15 } as const;

// ---- pitch (cents) -------------------------------------------------------------------------------------------
/** Note level: dead zone = natural intonation scatter of trained singers (15-20 cents mean error in the literature) minus margin; sigma sets 50 cents -> 0.5. */
export const PITCH_NOTE_DEAD = 10;
export const PITCH_NOTE_SIGMA = 30;
/** Frame (contour) level, vibrato removed: wider, because frames wander more than note medians. */
export const PITCH_FRAME_DEAD = 15;
export const PITCH_FRAME_SIGMA = 40;
/** Ornaments / run notes / notes < 0.2 s: nobody copies a melisma to the cent. */
export const PITCH_ORN_DEAD = 25;
export const PITCH_ORN_SIGMA = 60;
export const PITCH_NOTE_WEIGHT = 0.6;
export const PITCH_FRAME_WEIGHT = 0.4;
/** |error| (after the key shift, constant detune removed) at or beyond this is a wrong note. */
export const WRONG_NOTE_CENTS = 150;
/** flat/sharp finding threshold. */
export const OFF_CENTS = 25;
/** Octave-displaced note (high note taken an octave down) keeps this share of the note's pitch credit. */
export const OCTAVE_DISPLACED_CREDIT = 0.6;

// ---- timing (ms, ratios) ------------------------------------------------------------------------------------
/** Onset residual after removing global lag and tempo. Ensemble onset scatter is 30-50 ms (Rasch 1979); the analysis itself adds ~20 ms. */
export const ONSET_DEAD_MS = 30;
export const ONSET_SIGMA_MS = 55;
export const ONSET_ORN_DEAD_MS = 70;
export const ONSET_ORN_SIGMA_MS = 100;
/** A note this far early/late gets the early/late flag. */
export const LATE_EARLY_MS = 100;
/** Tempo: ~5 % is the just-noticeable tempo change. */
export const TEMPO_DEAD = Math.log(1.05);
export const TEMPO_SIGMA = 0.08;
export const DUR_DEAD = 0.18;
export const DUR_SIGMA = 0.3;
export const TIMING_ONSET_WEIGHT = 0.45;
export const TIMING_TEMPO_WEIGHT = 0.3;
export const TIMING_DUR_WEIGHT = 0.25;
export const MIN_PAIRS_FOR_TEMPO = 4;
export const MIN_SPAN_FOR_TEMPO_SEC = 1.5;

// ---- expression ---------------------------------------------------------------------------------------------
export const EXPR_DYNAMICS_WEIGHT = 0.35;
export const EXPR_VIBRATO_WEIGHT = 0.25;
/** Onset type flipped between two renderings of the SAME real clip in 10 of 20 comparisons (E4b): kept as a light touch only. */
export const EXPR_ATTACK_WEIGHT = 0.05;
export const EXPR_SCOOP_WEIGHT = 0.15;
export const EXPR_ORNAMENT_WEIGHT = 0.15;
/** Per-note relative level difference: dead zone 3 dB, sigma 4 dB. */
export const LEVEL_DEAD_DB = 3;
export const LEVEL_SIGMA_DB = 3.5;
export const VIB_RATE_DEAD_HZ = 0.7;
export const VIB_RATE_SIGMA_HZ = 1.0;
/** Vibrato extent compared as a ratio: dead zone ~ +-30 %. */
export const VIB_EXTENT_DEAD = 0.26;
export const VIB_EXTENT_SIGMA = 0.4;
export const VIB_DELAY_DEAD_SEC = 0.15;
export const VIB_DELAY_SIGMA_SEC = 0.25;
/** Straight tone where the reference has vibrato (or the other way round) keeps this credit: a style choice, not an error. */
export const VIB_MISMATCH_CREDIT = 0.4;
/** ...but when the vibrato that one take has is weak (under 30 cents; the detector's own threshold is 15), the mismatch is mostly detector noise. */
export const VIB_WEAK_CENTS = 30;
export const VIB_WEAK_MISMATCH_CREDIT = 0.8;
export const SCOOP_DEAD = 15;
export const SCOOP_SIGMA = 35;
export const SCOOP_MIN_NOTE_SEC = 0.35;
/** A scoop / fall-off is 'present' on a note when either take has at least this many cents of it. */
export const SCOOP_PRESENT = 20;
/** Scoop / fall-off readings beyond this are measurement failures: identity copies of real clips gave outliers of 200-2800 cents (median difference 8 cents). */
export const SCOOP_MAX = 200;
export const SCOOP_FINDING = 50;

// ---- tone (index units) -------------------------------------------------------------------------------------
// Dead zones = p90 of |delta| for the same voice through different mics / noise / rooms / keys (E1), rounded up.
export const TONE_DEAD = { breathiness: 0.12, brightness: 0.1, rasp: 0.08 } as const;
export const TONE_SIGMA = { breathiness: 0.12, brightness: 0.12, rasp: 0.1 } as const;
/** Extra dead zone per semitone of key difference (the indices carry a pitch dependence, E1: breathiness -0.22 at -12 st). */
export const TONE_DEAD_PER_SEMITONE = { breathiness: 0.008, brightness: 0.005, rasp: 0.002 } as const;
export const TONE_WEIGHTS = { breathiness: 0.35, brightness: 0.3, rasp: 0.15, register: 0.2 } as const;
/**
 * Expected attempt-minus-reference shift of a PERFECT copy sung T semitones away, subtracted from the measured difference.
 * The indices carry a mild pitch dependence (the app's H1-H2 pitch normalisation is an average over vowels): measured on formant-
 * preserving shifts of 7 real/synthetic voices (E1, PSOLA) breathiness moved -0.22 at -12 st, -0.14 at -7, +0.04..+0.15 at +7;
 * on 6 held-out synthetic voices with exactly fixed formants (E6a) -0.14, -0.09, +0.06. The two disagree in size and the
 * between-voice spread is as large as the effect (sd ~0.15 at +-12 st), so only a conservative, symmetric de-bias is applied
 * (it halves the bias on average) and the dead zone is widened with |T| as well. Linear, flat beyond +-12.
 */
export function keyBias(key: 'breathiness' | 'brightness' | 'rasp', t: number): number {
  const c = Math.max(-12, Math.min(12, t));
  switch (key) {
    case 'breathiness':
      return 0.011 * c;
    case 'brightness':
      return -0.006 * c;
    default:
      return 0;
  }
}

// ---- alignment / coverage -----------------------------------------------------------------------------------
export const COMPLETE_AT = 0.9;
/** Reference notes shorter than this, or inside a run, are ornaments. */
export const ORNAMENT_NOTE_SEC = 0.2;
export const ORNAMENT_WEIGHT = 0.4;
export const MIN_VOICED_SEC = 1.0;
export const MIN_REF_NOTES = 2;

// ---- "is this even the same phrase?" ----------------------------------------------------------------------------
// Measured on synthetic takes of the same phrase (good/weak/poor singers: rigid100 >= 0.44, warp RMS <= 303 ms) against unrelated
// or scrambled melodies (rigid100 <= 0.39 except a true sub-phrase, warp RMS 300-700 ms).
export const NO_MATCH_RIGID = 0.4;
export const NO_MATCH_WARP_MS = 400;
/** Nobody copies a phrase more than two octaves away: a key shift beyond this means the take is of something else. */
export const MAX_KEY_SHIFT = 24;

// ---- which fixes are listed ------------------------------------------------------------------------------------------
/** A fix must be worth at least this many points of the overall to exist at all. */
export const FIX_LISTED_POINTS = 0.7;
/**
 * ...and this many to be shown. Identical performances through phone-like channels (noise, level, roll-off, reverb) moved the top
 * fix by about a point and changed which fix came first in 56 % of takes; at 1.5 points that falls to about a fifth. Below it a fix
 * is still shown when it is the one thing to say about a take that is not near-perfect (overall under FIX_ONLY_BELOW).
 */
export const FIX_SHOWN_POINTS = 1.5;
export const FIX_ONLY_BELOW = 95;
/** Median level of the voiced frames (dBFS) below which a take counts as very quiet: unmatched notes at its start and end may simply not have been heard. */
export const QUIET_VOICED_DB = -40;

// ---- references whose melody is a rough guide (full songs) ----------------------------------------------------------------
/** The original has at least this many times the notes the take has... */
export const ROUGH_NOTE_RATIO = 1.4;
/** ...while the take still matches at least this share of the original's time span. (Measured on 103 synthetic takes of 9-note phrases over a band, 0 dB to -6 dB: flags every complete take that scored under 85, no half-sung or 60 % take.) */
export const ROUGH_SPAN_SHARE = 0.6;
/** Extractor confidence below this (the app's own MIX_CONFIDENCE_WARN): the reference is uncertain and its takes are not counted toward mastery. */
export const ROUGH_CONFIDENCE = 0.8;

// ---- words for a score ----------------------------------------------------------------------------------------------------
/** 'excellent' normally starts at 90; when pitch is under this, it starts at EXCELLENT_IF_PITCH_LOOSE (see scoreBand). */
export const EXCELLENT_PITCH_MIN = 85;
export const EXCELLENT_IF_PITCH_LOOSE = 93;
/** A reference note the extractor gives less than this probability of being the lead voice (MIX `leadExtraction.noteTrust`) is not charged as missed, and a far-off answer to it is not a wrong note. */
export const DOUBTFUL_NOTE_TRUST = 0.4;
