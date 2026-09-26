// Small display formatters shared by pages. Pure functions, no DOM.

import { midiToNoteName } from '../../dsp/music';

/** 75.4 -> "1:15". */
export function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 12.345 -> "12.3 s"; 75 -> "1:15". */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec)) return '–';
  return sec < 60 ? `${sec.toFixed(1)} s` : formatClock(sec);
}

/** Signed cents with a true minus sign: 12 -> "+12¢", -7.4 -> "−7¢". */
export function formatCents(c: number): string {
  if (!Number.isFinite(c)) return '–';
  const r = Math.round(c);
  if (r === 0) return '0¢';
  return `${r > 0 ? '+' : '−'}${Math.abs(r)}¢`;
}

/** Signed semitone transposition in words: -2 -> "2 semitones down". */
export function formatTranspose(semitones: number): string {
  const r = Math.round(semitones);
  if (!Number.isFinite(r) || r === 0) return 'Original key';
  const n = Math.abs(r);
  return `${n} semitone${n === 1 ? '' : 's'} ${r > 0 ? 'up' : 'down'}`;
}

export function noteName(midi: number | null | undefined): string {
  return midi === null || midi === undefined || !Number.isFinite(midi) ? '–' : midiToNoteName(midi);
}

export function noteRange(low: number | null | undefined, high: number | null | undefined): string {
  if (low === null || low === undefined || high === null || high === undefined) return '–';
  return `${noteName(low)}–${noteName(high)}`;
}

export function percent(x: number | null | undefined): string {
  return x === null || x === undefined || !Number.isFinite(x) ? '–' : `${Math.round(x * 100)}%`;
}

/** A signed number with a fixed number of decimals and a true minus sign. */
export function signed(x: number, digits = 2): string {
  if (!Number.isFinite(x)) return '–';
  const s = Math.abs(x).toFixed(digits);
  if (Number(s) === 0) return (0).toFixed(digits);
  return `${x > 0 ? '+' : '−'}${s}`;
}

/** Cents offset of `hz` from the nearest equal-tempered note, plus that note's MIDI number. */
export function tunerReading(hz: number, a4Hz = 440): { midi: number; name: string; cents: number } | null {
  if (!(hz > 0) || !Number.isFinite(hz)) return null;
  const exact = 69 + 12 * Math.log2(hz / a4Hz);
  const midi = Math.round(exact);
  return { midi, name: midiToNoteName(midi), cents: (exact - midi) * 100 };
}

export const A4_MIN = 415;
export const A4_MAX = 466;

/** Parses an A4 tuning field; null outside 415-466 Hz (about a semitone either side of 440, beyond which "A4" means another note). */
export function parseA4(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!t) return null;
  const v = Number(t);
  if (!Number.isFinite(v) || v < A4_MIN || v > A4_MAX) return null;
  return Math.round(v * 10) / 10;
}
