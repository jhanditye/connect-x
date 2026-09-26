// Shared helpers for the hand-built SVG charts: container sizing, scales, ticks, value formatting
// per style dimension, and the theme-aware singer colour mapping. Pure functions apart from the hooks.

import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { RegisterLabel, StyleKey } from '../../types';

/** True minus sign for negative numbers (typographically matches the plus sign). */
export const MINUS = '−';

/**
 * Width of a container element in CSS px, tracked with a ResizeObserver. Renders with `fallback`
 * first (server rendering, tests, browsers without ResizeObserver) and updates after mount.
 */
export function useContainerWidth<T extends HTMLElement>(fallback: number): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Floor so a sub-pixel change cannot bounce between two widths.
    const apply = (w: number) => {
      if (w > 0) setWidth((prev) => (Math.floor(w) !== prev ? Math.floor(w) : prev));
    };
    apply(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) apply(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** A document-unique id that is safe inside `url(#...)` references. */
export function useSvgId(prefix: string): string {
  return `${prefix}-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Linear map from [d0, d1] to [r0, r1]; a zero-width domain maps to the middle of the range. */
export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const span = d1 - d0;
  if (span === 0) return () => (r0 + r1) / 2;
  const k = (r1 - r0) / span;
  return (v) => r0 + (v - d0) * k;
}

/** Round to one decimal for compact SVG path data. */
export function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Smallest 1/2/5 x 10^k step that splits `span` into at most `maxTicks` intervals. */
export function niceStep(span: number, maxTicks: number): number {
  if (!(span > 0) || !(maxTicks >= 1)) return 1;
  const raw = span / maxTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5]) if (m * mag >= raw - 1e-12) return m * mag;
  return 10 * mag;
}

/** Multiples of a nice step inside [lo, hi]. */
export function niceTicks(lo: number, hi: number, maxTicks: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return [];
  const step = niceStep(hi - lo, maxTicks);
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

// Musically/clock-friendly steps for a time axis in seconds.
const TIME_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Tick times for a seconds axis, at most `maxTicks` intervals. */
export function timeTicks(durationSec: number, maxTicks: number): number[] {
  if (!(durationSec > 0)) return [0];
  const raw = durationSec / Math.max(1, maxTicks);
  const step = TIME_STEPS.find((s) => s >= raw) ?? Math.ceil(raw / 600) * 600;
  const out: number[] = [];
  for (let t = 0; t <= durationSec + 1e-9; t += step) out.push(Number(t.toFixed(6)));
  return out;
}

/** "0s", "12s", "1.5s", or "1:30" once the axis reaches a minute. */
export function formatTick(t: number, axisMaxSec: number): string {
  if (axisMaxSec >= 60) {
    const s = Math.round(t);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  return Number.isInteger(t) ? `${t}s` : `${t.toFixed(1)}s`;
}

/** Fixed decimals with a true minus sign; "-0.0" collapses to "0.0". */
export function fmt(v: number, digits: number): string {
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return s;
  return v < 0 ? `${MINUS}${s}` : s;
}

export function fmtSigned(v: number, digits: number): string {
  const s = fmt(v, digits);
  return v > 0 && Number(Math.abs(v).toFixed(digits)) !== 0 ? `+${s}` : s;
}

// ---------------------------------------------------------------------------------------------
// Colours

const SINGER_VARS: Record<string, string> = {
  'shawn-mendes': 'var(--singer-shawn)',
  'daniel-caesar': 'var(--singer-daniel)',
  'jalen-ngonda': 'var(--singer-jalen)',
  reference: 'var(--singer-custom)',
};

/** Builtin singer ids map to their theme-aware CSS variables; other profiles use their own hex. */
export function singerVar(id: string | undefined, color?: string): string {
  if (id && SINGER_VARS[id]) return SINGER_VARS[id];
  return color && color.trim() ? color : 'var(--singer-custom)';
}

export const REGISTER_VARS: Record<RegisterLabel, string> = {
  chest: 'var(--reg-chest)',
  mix: 'var(--reg-mix)',
  head: 'var(--reg-head)',
};

export function registerVar(reg: RegisterLabel | null): string {
  return reg ? REGISTER_VARS[reg] : 'var(--ink-3)';
}

// ---------------------------------------------------------------------------------------------
// Style dimensions: how each one is displayed. Kept local (instead of reading coach/profiles.ts)
// so the charts only depend on types.ts; names mirror STYLE_LABELS, units follow the StyleVector docs.

type ValueKind = 'index' | 'share' | 'hz' | 'cents' | 'centsExtent' | 'db' | 'dbPerSemitone' | 'notesPerSec' | 'perMin';

interface DimDisplay {
  /** Axis label for tight spaces (radar spokes), <= 12 characters. */
  short: string;
  /** Plain-words name, used where no DimensionResult label is at hand. */
  name: string;
  kind: ValueKind;
  /** Physical bounds of the measure, used to keep meter tracks from showing impossible values. */
  min?: number;
  max?: number;
}

export const DIM_DISPLAY: Record<StyleKey, DimDisplay> = {
  breathiness: { short: 'Breathiness', name: 'Breathiness', kind: 'index', min: 0, max: 1 },
  brightness: { short: 'Brightness', name: 'Brightness', kind: 'index', min: 0, max: 1 },
  rasp: { short: 'Rasp', name: 'Rasp', kind: 'index', min: 0, max: 1 },
  vibratoPresence: { short: 'Vibrato use', name: 'Vibrato on held notes', kind: 'share', min: 0, max: 1 },
  vibratoRateHz: { short: 'Vib. speed', name: 'Vibrato speed', kind: 'hz', min: 0 },
  vibratoExtentCents: { short: 'Vib. width', name: 'Vibrato width', kind: 'centsExtent', min: 0 },
  chestInUpperRange: { short: 'Chest up top', name: 'Chest above the passaggio', kind: 'share', min: 0, max: 1 },
  mixInUpperRange: { short: 'Mix up top', name: 'Mix above the passaggio', kind: 'share', min: 0, max: 1 },
  headInUpperRange: { short: 'Head up top', name: 'Falsetto/head above the passaggio', kind: 'share', min: 0, max: 1 },
  loudnessClimbDbPerSemitone: { short: 'Volume climb', name: 'Loudness climb', kind: 'dbPerSemitone' },
  agility: { short: 'Run speed', name: 'Run speed', kind: 'notesPerSec', min: 0 },
  dynamicRangeDb: { short: 'Dynamics', name: 'Dynamic range', kind: 'db', min: 0 },
  softOnsetRatio: { short: 'Soft onsets', name: 'Soft (airy) onsets', kind: 'share', min: 0, max: 1 },
  pitchAccuracyCents: { short: 'Tuning', name: 'Pitch accuracy', kind: 'cents', min: 0 },
  flipsPerMinute: { short: 'Flips', name: 'Register flips', kind: 'perMin', min: 0 },
};

/** The number part of a dimension value: shares as %, Hz 1 decimal, cents integer, dB 1 decimal. */
export function formatDimNumber(key: StyleKey, v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  switch (DIM_DISPLAY[key]?.kind ?? 'index') {
    case 'share':
      return `${Math.round(v * 100)}%`;
    case 'cents':
      return `${fmt(Math.round(v), 0)}¢`;
    case 'centsExtent':
      return `±${Math.round(Math.abs(v))}¢`;
    case 'dbPerSemitone':
      return fmtSigned(v, 1);
    case 'hz':
    case 'db':
    case 'notesPerSec':
    case 'perMin':
      return fmt(v, 1);
    case 'index':
      return fmt(v, 2);
  }
}

const UNIT_SUFFIX: Record<ValueKind, string> = {
  index: '',
  share: '',
  cents: '',
  centsExtent: '',
  hz: ' Hz',
  db: ' dB',
  dbPerSemitone: ' dB/semitone',
  notesPerSec: ' notes/s',
  perMin: '/min',
};

/** Unit written after a number (empty when the number already carries it, like % or ¢). */
export function dimUnitSuffix(key: StyleKey): string {
  return UNIT_SUFFIX[DIM_DISPLAY[key]?.kind ?? 'index'];
}

/** A dimension value with its unit, e.g. "42%", "5.4 Hz", "18¢", "14.0 dB", "0.42". */
export function formatDimValue(key: StyleKey, v: number | null | undefined): string {
  const n = formatDimNumber(key, v);
  return n === '–' ? n : `${n}${dimUnitSuffix(key)}`;
}

/** Radar/axis label: the result's own label when short enough, else the dimension's short name. */
export function shortDimLabel(key: StyleKey, label?: string): string {
  if (label && label.length <= 12) return label;
  return DIM_DISPLAY[key]?.short ?? label ?? key;
}

export type ScoreTone = 'good' | 'warn' | 'bad';

/** >= 80 good, 60-79 warn, < 60 bad. */
export function scoreTone(score: number): ScoreTone {
  return score >= 80 ? 'good' : score >= 60 ? 'warn' : 'bad';
}

/** Rough rendered width of a text run, for layout decisions without measuring the DOM. */
export function textWidth(text: string, fontPx: number, mono = false): number {
  return text.length * fontPx * (mono ? 0.62 : 0.56);
}
