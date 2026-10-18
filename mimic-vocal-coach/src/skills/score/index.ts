// Skills scoring engine: pure scorers over a mono take (Float32Array + sample rate). See src/skills/SPEC.md section 3
// and README.md in this folder for the calibration numbers.
export { scoreHeldNote, summarisePitchTest, createLockTracker, differentNoteWords, isWrongHeldNote, type LockState } from './held';
export { segmentNotes } from './segment';
export { alignNotes } from './align';
export { scoreSequence, scoreSungInterval, countsForTuning, isWrongNote, sungStepPhrase } from './line';
export { scoreHiss, scoreLongTone } from './breath';
export { formatCents, centsMeaning, sharpFlat, MINUS } from './format';
export { foldCents, octaveAndCents } from './frames';
export * as SCORE_CONSTANTS from './constants';
