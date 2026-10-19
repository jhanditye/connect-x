// Every threshold the Skills scorers use, in one place (see src/skills/SPEC.md section 3 and score/README.md for the
// calibration that backs them). Pitch frames come from trackPitch at 10 ms.

/** Fewer voiced seconds than this: nothing to score. */
export const MIN_VOICED_SEC = 0.3;
/** The 90th-percentile level of the voiced frames must reach this (dBFS) or the take is "too quiet". */
export const QUIET_P90_DB = -50;
/**
 * A take with too little voicing is reported as "no-pitch" (sound but no sung note) instead of "too-quiet" when the
 * 90th-percentile level of all frames reaches this: noise, speech-like sound or a hiss where a note was expected.
 */
export const NO_PITCH_LOUD_DB = -45;

/** Smoothing for steadiness, landing, stability and lock-in: one vibrato cycle at 5 Hz. */
export const SMOOTH_SEC = 0.2;
/** Steady part of a held note: skip this much after the onset and before the release... */
export const STEADY_SKIP_START_SEC = 0.25;
export const STEADY_SKIP_END_SEC = 0.15;
/** ...but on short notes (lines) never more than these shares of the note. */
export const STEADY_SKIP_START_SHARE = 0.25;
export const STEADY_SKIP_END_SHARE = 0.15;
/** Frames whose smoothed pitch is further than this from the note median are not part of its steady part. */
export const STEADY_BAND_CENTS = 50;

/** Landing: the first 200 ms after the smoothed slope first drops under 3 semitones per second. */
export const LANDING_WINDOW_SEC = 0.2;
export const LANDING_SLOPE_ST_PER_SEC = 3;
/** Time to land: the smoothed pitch must stay inside the tolerance this long. */
export const LAND_STAY_SEC = 0.3;

/** Shortest note in a line. */
export const NOTE_MIN_SEC = 0.12;
/** A boundary inside a voiced stretch: the 200 ms means either side differ by more than this. */
export const SPLIT_CENTS = 60;
export const SPLIT_WINDOW_SEC = 0.2;
/** Both means need at least this much voiced pitch (a shorter window is too exposed to vibrato). */
export const SPLIT_MIN_SIDE_SEC = 0.08;
/**
 * A pitch boundary inside a stretch is kept only if the step, with the take's vibrato fitted across both sides, is at
 * least SPLIT_CENTS. Each side uses at most this much of its note.
 */
export const VIB_STEP_WINDOW_SEC = 0.35;
/** Scoops and falls: a span of at most RAMP_MAX_SEC that is a straight ramp (R^2 >= RAMP_MIN_R2; vibrato on the ramp
 * lowers it) over at least max(RAMP_MIN_ST, RAMP_VIB_FACTOR * vibrato extent) semitones, ending within RAMP_REACH_ST
 * of the next note it heads into (or starting that close to the previous note it leaves), belongs to that note. */
export const RAMP_MAX_SEC = 0.3;
export const RAMP_MIN_R2 = 0.5;
export const RAMP_MIN_ST = 0.6;
export const RAMP_VIB_FACTOR = 2;
export const RAMP_REACH_ST = 2;

/** Note confidence: a steady part shorter than this is too short to trust. */
export const CONFIDENT_STEADY_SEC = 0.2;
/** A vibrato this wide (semitones) or wider must be caught over at least one whole cycle. (Relaxing this to 0.12 s and
 * 0.6 cycle when the take's rate is known let 0.3 s notes through 47 cents off, so it stays strict.) */
export const VIB_CONFIDENCE_AMP = 0.15;
/** Centre check on short notes (segment.ts centreAgrees): the centres fitted on the first and on the last 70 % of the
 * steady frames must agree within 10 cents. */
export const CENTRE_CHECK_SHARE = 0.7;
export const CENTRE_CHECK_CENTS = 10;
/** No vibrato centre fitted and the pitch swung this far (half the 10-90 % range, semitones): the median is a guess. */
export const UNFITTED_SPREAD_ST = 0.3;
/**
 * A held note (pitch test, match) needs this much steady pitch for its number to be more than rough. Measured on the
 * calibration singer (steady part / largest error, cents, at A2, A3 and E4): 0.35 s notes 0.22 s / 9, 0.4 s notes
 * 0.24 s / 6.2, 0.45 s notes 0.28 s / 3.5, 0.6 s notes 0.36 s / 1.8. So notes from about 0.45 s are trusted.
 */
export const HELD_CONFIDENT_STEADY_SEC = 0.26;
/**
 * Line notes measured with low confidence are kept out of the figures, but they are not ignored: a rough reading is
 * trusted only to within its margin, its own swing (the whole 10-90 % range of the steady pitch, or twice the vibrato
 * extent found) and at least LOW_CONF_MARGIN_CENTS. A rough note more than ROUGH_WRONG_NOTE_CENTS beyond its margin is
 * nearer another semitone whatever the error, so it is named as a different note; one that reads off by more than the
 * tolerance and beyond its margin is named as a rough reading and blocks praise. (Calibration singer, in tune: 0.15 s
 * notes read up to 27 cents off, 0.3 s notes up to 13; with a +/-100-cent vibrato 0.3 s notes read up to 72 off,
 * inside their swing of 150 or more.)
 */
export const LOW_CONF_MARGIN_CENTS = 30;
export const ROUGH_WRONG_NOTE_CENTS = 50;
/** Praise and an accuracy figure need this share of a line's notes measured with confidence (else "not scored"). */
export const MIN_COUNTED_SHARE = 0.5;
/** "Too short to measure" is said only of a note voiced for less than this; a longer one failed for another reason. */
export const SHORT_NOTE_MAX_SEC = 0.6;

/** A steady stretch of voicing at least this long that is still too short to score is named as "too short". */
export const SHORT_NOTE_MIN_SEC = 0.08;
/**
 * Voice check (frames.ts isPureTone) switched OFF. In review it refused 25 of 648 synthetic straight-tone voices (pure "oo"
 * falsetto looks like a sine) while still letting quiet sines, sines with vibrato and square tones through. Refusing a real
 * singer is the worse error, and the prompts play before the microphone opens, so leakage only matters with the drone
 * (which asks about headphones first). The measurement stays for a later, better check.
 */
export const PURE_TONE_REFUSAL = false;
/** Voice check (frames.ts isPureTone): harmonics 2..10 under this share of the fundamental's energy (-30 dB)... */
export const PURE_TONE_HARMONIC_RATIO = 1e-3;
/** ...and pitch roughness under this (cents): a steady pure tone, not a voice. */
export const PURE_TONE_ROUGHNESS_CENTS = 2.5;
/** Held note / long tone: the pitch over the last END_DRIFT_SEC against the steady part before it, reported when it
 * moved END_DRIFT_FINDING_CENTS or more (a sag at the end is not averaged away). The note needs END_DRIFT_MIN_SEC of
 * steady pitch before that window. */
export const END_DRIFT_SEC = 0.5;
export const LONG_TONE_END_DRIFT_SEC = 0.6;
export const END_DRIFT_MIN_SEC = 0.5;
export const END_DRIFT_FINDING_CENTS = 10;

/** Unvoiced gaps shorter than this are bridged. */
export const GAP_BRIDGE_SEC = 0.06;
/** Gaps from GAP_BRIDGE_SEC up to this are bridged only when the level does not dip (a pitch-tracker dropout). */
export const GAP_MAYBE_SEC = 0.1;
/** A level dip this deep below both sides separates repeated notes. */
export const LEVEL_DIP_DB = 6;
/** Frames moving faster than this (smoothed) belong to a glide, not a note. */
export const GLIDE_SLOPE_ST_PER_SEC = 4;

/** Alignment costs (in semitone-ish units: a match costs min(|cents|, 400) / 100). */
export const ALIGN_MATCH_CAP_CENTS = 400;
export const ALIGN_MISSING_COST = 2.5;
export const ALIGN_EXTRA_COST = 1.5;
export const ALIGN_SHORT_EXTRA_COST = 0.5;
export const ALIGN_SHORT_EXTRA_SEC = 0.2;
/** Extra cost of matching a note an octave away from the rest of the take (folded and flagged). */
export const ALIGN_OCTAVE_SLIP_COST = 1;
/** Whole-take octave offsets tried. */
export const OCTAVE_OFFSETS: readonly number[] = [0, -1, 1, -2, 2];

/** Drift finding: at least this many cents over the line, with at least DRIFT_MIN_NOTES matched notes (on 4 notes one
 * flat last note reads as a slide). */
export const DRIFT_FINDING_CENTS = 20;
export const DRIFT_MIN_NOTES = 5;

/** A note this far (or further) from the written one is a different note, not a tuning error: it is named, counted
 * separately and kept out of the tuning averages (70 cents is nearer the neighbouring semitone than the target). */
export const WRONG_NOTE_CENTS = 70;
/** "Right note, other octave" only when the pitch-class error is within this; otherwise it is a different note. */
export const OCTAVE_MATCH_CENTS = 150;
/** A whole line this far from the key with every note within LINE_SHIFT_SPREAD_CENTS of that shift: right shape, wrong key. */
export const LINE_SHIFT_CENTS = 40;
export const LINE_SHIFT_SPREAD_CENTS = 20;
/** Sung intervals: a single sung note is split in two when its halves differ by at least this (a narrow semitone). */
export const FORCE_SPLIT_MIN_CENTS = 30;

/** Wrong direction in an interval: the sung step must move at least this far the wrong way. */
export const WRONG_DIRECTION_CENTS = 50;

/** Findings thresholds (pitch test). */
export const BIAS_FINDING_CENTS = 10;
export const BIAS_FINDING_MIN_NOTES = 5;
export const REGISTER_FINDING_CENTS = 20;
export const REGISTER_FINDING_MIN_NOTES = 2;
export const SCOOP_FINDING_CENTS = -30;
export const WANDER_FINDING_CENTS = 20;
export const PRAISE_SHARE = 0.8;
export const MAX_FINDINGS = 3;

/** Hiss detector. */
export const HISS_FRAME_SEC = 0.02;
export const HISS_FLOOR_SEC = 0.5;
export const HISS_ABOVE_FLOOR_DB = 8;
export const HISS_MAX_PERIODICITY = 0.5;
export const HISS_HF_HZ = 2000;
export const HISS_MIN_HF_SHARE = 0.35;
export const HISS_BRIDGE_SEC = 0.3;
export const HISS_EDGE_SEC = 0.3;
/** A hiss shorter than this is not scored (speech sibilants, a single "s"). */
export const HISS_MIN_SEC = 1;
/** Within the hiss run, at least this share of frames must be hiss frames. */
export const HISS_MIN_RUN_SHARE = 0.7;
/** Nothing quieter than this (dBFS) counts as a hiss, whatever the room. */
export const HISS_ABS_MIN_DB = -65;
/** Steadiness bands (SD of the 100 ms-smoothed level, dB). */
export const HISS_VERY_STEADY_DB = 1.5;
export const HISS_STEADY_DB = 3;
export const HISS_BIT_UNEVEN_DB = 5;

/** Long tone. */
export const LONG_TONE_BRIDGE_SEC = 0.15;
export const LONG_TONE_SKIP_START_SEC = 0.3;
export const LONG_TONE_VERY_STEADY_CENTS = 10;
export const LONG_TONE_STEADY_CENTS = 20;
export const LONG_TONE_WOBBLY_CENTS = 35;
export const LEVEL_SMOOTH_SEC = 0.1;
export const TRACE_STEP_SEC = 0.1;

/**
 * Live lock-in: readings averaged over this window; a voicing dropout longer than DROPOUT resets the hold. 0.5 s
 * covers two or more whole cycles of any vibrato from 4 to 7 Hz, so a centred ±100-cent vibrato leaves at most about
 * 13 cents in the average (a 200 ms window left up to 25 and a centred vibrato often never locked under Strict).
 */
export const LOCK_AVERAGE_SEC = 0.5;
/** Time to land uses the same averaging window, for the same reason. */
export const LAND_SMOOTH_SEC = 0.5;
export const LOCK_DROPOUT_SEC = 0.15;
export const LOCK_HOLD_SEC = 1.5;
