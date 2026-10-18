// The singing screens of the Skills section (see src/skills/SPEC.md section 6). Each takes SkillScreenProps plus its
// plan, and an optional `deps` override (tests); SingDepsProvider overrides them for a whole subtree.
export { PitchTestScreen, type PitchTestScreenProps } from './PitchTestScreen';
export { MatchNoteScreen, type MatchNoteScreenProps } from './MatchNoteScreen';
export { SingIntervalsScreen, type SingIntervalsScreenProps } from './SingIntervalsScreen';
export { SequenceScreen, type SequenceScreenProps } from './SequenceScreen';
export { BreathScreen, BreathGuide, type BreathScreenProps } from './BreathScreen';
export { SingDepsProvider, DEFAULT_SING_DEPS, useSingDeps, type SingDeps } from './deps';
export { useSkillKeys, useTake, type TakeController, type TakeOutcome, type TakePhase } from './useTake';
export { DegreeStrip, FindingList, HeadphonesQuestion, LiveTrace, PitchNeedle, SafetyNote } from './widgets';
