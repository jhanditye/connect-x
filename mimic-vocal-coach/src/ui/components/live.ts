// Pure helpers for the live recording monitor (level meter, tuner and pitch trace).

/** RMS and peak of a block, RMS in dBFS relative to a full-scale sine (-3 dBFS), matching VoiceAnalysis.rmsDb. */
export function blockLevel(buf: ArrayLike<number>): { rmsDb: number; peak: number } {
  let ss = 0;
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    ss += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const ms = buf.length ? ss / buf.length : 0;
  return { rmsDb: ms > 0 ? 10 * Math.log10(ms) : -120, peak };
}

export type LevelState = 'silent' | 'quiet' | 'good' | 'hot';

/**
 * Level guidance while recording. The analysis wants sung phrases clearly above the room noise
 * (it flags takes whose voiced level is under ~-45 dBFS) and no clipping; peaks above ~0.9 of full
 * scale leave no headroom for a louder note.
 */
export function levelState(rmsDb: number, peak: number): LevelState {
  if (peak >= 0.9) return 'hot';
  if (rmsDb < -60) return 'silent';
  if (rmsDb < -42) return 'quiet';
  return 'good';
}

export const LEVEL_TEXT: Record<LevelState, string> = {
  silent: 'Waiting for sound',
  quiet: 'Quiet: move closer or sing out a little',
  good: 'Good level',
  hot: 'Too loud: move the phone back',
};

/** Meter fill 0..1 for a dBFS level on a -60..0 dB scale. */
export function meterFraction(rmsDb: number): number {
  return Math.max(0, Math.min(1, (rmsDb + 60) / 60));
}

/**
 * Vertical window (MIDI) for the scrolling trace: 18 semitones centred on the median of the
 * recent voiced pitches, so a phrase fits without rescaling on every note. Falls back to
 * `fallbackCentre` (the middle of the user's passaggio zone) before anything is sung.
 */
export function traceWindow(midis: ArrayLike<number>, fallbackCentre = 60, span = 18): { lo: number; hi: number } {
  const voiced: number[] = [];
  for (let i = 0; i < midis.length; i++) if (Number.isFinite(midis[i])) voiced.push(midis[i]);
  let centre = fallbackCentre;
  if (voiced.length) {
    voiced.sort((a, b) => a - b);
    centre = voiced[Math.floor(voiced.length / 2)];
  }
  const lo = Math.round(centre - span / 2);
  return { lo, hi: lo + span };
}
