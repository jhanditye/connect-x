// Skills audio: prompt playback (piano voice, AudioContext clock) and one-response microphone capture with live
// pitch and auto-stop. See README.md and src/skills/SPEC.md section 4.
export * from './prompts';
export * from './autoStop';
export {
  CAPTURE_TUNING,
  createLiveSmoother,
  promptThenCapture,
  readLive,
  startSkillCapture,
  type PromptThenCaptureOptions,
  type SkillCapture,
  type SkillCaptureOptions,
  type SkillCaptureResult,
} from './capture';
