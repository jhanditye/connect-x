// Small pure helpers shared by the singing screens: range, tolerance, session base fields, accuracy classes and the
// plain-English labels for numbers.

import { useEffect, useRef } from 'react';
import { midiToNoteName } from '../../../dsp/music';
import * as C from '../../../skills/score/constants';
import { formatCents } from '../../../skills/score';
import { comfortableRange } from '../../../skills/theory';
import type { VoiceType } from '../../../types';
import { STRICTNESS_CENTS, WIDE_BAND_CENTS, type SkillScreenProps, type VoiceRange } from '../../../skills/types';
import type { SingDeps } from './deps';

export function rangeFor(voiceType: VoiceType, override: VoiceRange | null): VoiceRange {
  return comfortableRange(voiceType, override);
}

export function toleranceFor(props: Pick<SkillScreenProps, 'prefs'>): number {
  return STRICTNESS_CENTS[props.prefs.strictness] ?? STRICTNESS_CENTS.standard;
}

export function a4For(props: Pick<SkillScreenProps, 'settings'>): number {
  const a = props.settings.a4Hz;
  return Number.isFinite(a) && a > 0 ? a : 440;
}

/** The fields every session shares. */
export function sessionBase(props: Pick<SkillScreenProps, 'settings' | 'prefs'>, deps: SingDeps, startedMs: number) {
  return {
    id: deps.newId(),
    at: new Date(deps.nowMs()).toISOString(),
    durationSec: Math.max(0, Math.round((deps.nowMs() - startedMs) / 100) / 10),
    strictness: props.prefs.strictness,
    voiceType: props.settings.voiceType,
    a4Hz: a4For(props),
  };
}

/** "A3" with a real sharp sign. */
export function noteName(midi: number): string {
  return midiToNoteName(midi).replace('#', '♯');
}

export type Accuracy = 'within' | 'near' | 'off' | 'none';

/** within = inside the strictness band; near = inside 50 cents; off = further; none = not measured. */
export function accuracyOf(cents: number | null | undefined, tolerance: number): Accuracy {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return 'none';
  const a = Math.abs(cents);
  if (a <= tolerance) return 'within';
  if (a <= WIDE_BAND_CENTS) return 'near';
  return 'off';
}

export const ACCURACY_WORDS: Record<Accuracy, string> = {
  within: 'in the band',
  near: 'close',
  off: 'off',
  none: 'not measured',
};

/** "+12 cents" or "–". */
export function centsText(c: number | null | undefined): string {
  return c === null || c === undefined || !Number.isFinite(c) ? '–' : formatCents(c);
}

/** "12 cents flat", "8 cents sharp", "right on pitch", or "not measured". */
export function centsWords(c: number | null | undefined): string {
  if (c === null || c === undefined || !Number.isFinite(c)) return 'not measured';
  const a = Math.round(Math.abs(c));
  if (a === 0) return 'right on pitch';
  return `${a} ${a === 1 ? 'cent' : 'cents'} ${c > 0 ? 'sharp' : 'flat'}`;
}

export function percent(share: number | null | undefined): string {
  return share === null || share === undefined || !Number.isFinite(share) ? '–' : `${Math.round(share * 100)}%`;
}

export function seconds(s: number | null | undefined, digits = 1): string {
  return s === null || s === undefined || !Number.isFinite(s) ? '–' : `${s.toFixed(digits)} s`;
}

export function hissSteadinessLabel(sd: number | null): string {
  if (sd === null || !Number.isFinite(sd)) return 'not measured';
  if (sd <= C.HISS_VERY_STEADY_DB) return 'very steady';
  if (sd <= C.HISS_STEADY_DB) return 'steady';
  if (sd <= C.HISS_BIT_UNEVEN_DB) return 'a bit uneven';
  return 'uneven';
}

export function pitchSteadinessLabel(sd: number | null): string {
  if (sd === null || !Number.isFinite(sd)) return 'not measured';
  if (sd <= C.LONG_TONE_VERY_STEADY_CENTS) return 'very steady';
  if (sd <= C.LONG_TONE_STEADY_CENTS) return 'steady';
  if (sd <= C.LONG_TONE_WOBBLY_CENTS) return 'a little wobbly';
  return 'wandering';
}

/** Mean of finite numbers, or null. */
export function meanOf(xs: readonly (number | null | undefined)[]): number | null {
  let s = 0;
  let n = 0;
  for (const x of xs) {
    if (x === null || x === undefined || !Number.isFinite(x)) continue;
    s += x;
    n++;
  }
  return n > 0 ? s / n : null;
}

export function meanAbs(xs: readonly (number | null | undefined)[]): number | null {
  return meanOf(xs.map((x) => (x === null || x === undefined ? null : Math.abs(x))));
}

/** Folds a pitch by whole octaves into [lo, hi] when it is outside (for traces of a take sung an octave away). */
export function foldInto(midi: number, lo: number, hi: number): number {
  let m = midi;
  while (m > hi && m - 12 >= lo - 6) m -= 12;
  while (m < lo && m + 12 <= hi + 6) m += 12;
  return m;
}

/** What status line shows while the take runs. */
export const TOO_QUIET_TEXT = 'Too quiet to score: the microphone hardly heard you. Sing a little louder or come a little closer, then try again.';
export const NO_PITCH_TEXT = 'No steady sung note was found in that take. Sing on an open vowel like "ah" and hold the note, then try again.';

/**
 * Calls `flush` when the page is being unloaded (a reload or a closed tab, where React never unmounts the screen) and,
 * unless `unloadOnly`, also when the page is hidden (an iPhone may throw away a hidden tab without another event). The
 * screens' flush saves only takes not saved yet, so a later Finish does not count them twice.
 */
export function useFlushOnHide(flush: () => void, unloadOnly = false): void {
  const ref = useRef(flush);
  ref.current = flush;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHide = () => ref.current();
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') ref.current();
    };
    window.addEventListener('pagehide', onHide);
    if (!unloadOnly) document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [unloadOnly]);
}

/** "1 cent", "12 cents" (rounded; no sign). */
export function centsCount(c: number): string {
  const a = Math.round(c);
  return `${a} ${Math.abs(a) === 1 ? 'cent' : 'cents'}`;
}
