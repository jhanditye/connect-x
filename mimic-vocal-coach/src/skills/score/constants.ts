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

/** Drift finding: at least this many cents over the line, with at least DRIFT_MIN_NOTES matched notes. */
export const DRIFT_FINDING_CENTS = 20;
export const DRIFT_MIN_NOTES = 4;

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

/** Live lock-in: readings averaged over this window; a voicing dropout longer than DROPOUT resets the hold. */
export const LOCK_AVERAGE_SEC = 0.2;
export const LOCK_DROPOUT_SEC = 0.15;
export const LOCK_HOLD_SEC = 1.5;
