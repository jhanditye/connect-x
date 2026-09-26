// Measured singer profiles: the builtin singers' targets rebuilt from clips of their real recordings
// that the user adds (isolated vocals or a cappella sections from music they own). Only the
// measurements are kept, never the audio. The singer's name, songs, signature moves, weights and
// coaching cues stay; the target numbers, traits and range come from the clips.

import type { MeasuredClip, SingerProfile, StyleKey, StyleVector, TargetBand, VoiceAnalysis, VoiceType } from '../types';
import { STYLE_KEYS } from './profiles';
import { BAND_SPECS, describeStyleTraits, targetsFromStyle } from './reference';

/**
 * Voice type the artists' clips are analysed as. All three builtin singers are male voices whose
 * register shifts sit around E4 (compare.ts SINGER_PASSAGGIO_LOW), which is the tenor zone's low note,
 * so their upper-range register shares are measured from the same point the key advice assumes.
 */
export const ARTIST_VOICE_TYPE: VoiceType = 'tenor';

/** More clips than this adds little and only grows local storage. */
export const MAX_CLIPS_PER_SINGER = 20;

/** Keys whose targets have safety caps (reference.ts safeBand); clip spread never widens them. */
const CAPPED: ReadonlySet<StyleKey> = new Set<StyleKey>(['rasp', 'chestInUpperRange', 'loudnessClimbDbPerSemitone', 'pitchAccuracyCents']);

/** The numbers worth keeping from one analysed clip of an artist. */
export function clipFromAnalysis(analysis: VoiceAnalysis, name: string, id: string, addedAt: string): MeasuredClip {
  const p = analysis.pitch;
  return {
    id,
    name,
    addedAt,
    durationSec: analysis.durationSec,
    voicedSec: analysis.voicedSec,
    style: { ...analysis.style },
    pitch: { lowMidi: p.lowMidi, highMidi: p.highMidi, tessituraLowMidi: p.tessituraLowMidi, tessituraHighMidi: p.tessituraHighMidi },
  };
}

function finite(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Per-dimension values measured across the clips, with each clip's singing time as its weight. */
function valuesByKey(clips: MeasuredClip[]): Map<StyleKey, { value: number; weight: number }[]> {
  const out = new Map<StyleKey, { value: number; weight: number }[]>();
  for (const clip of clips) {
    const weight = Math.max(clip.voicedSec, 0.1);
    for (const key of STYLE_KEYS) {
      const value = clip.style[key];
      if (!finite(value)) continue;
      const list = out.get(key) ?? [];
      list.push({ value, weight });
      out.set(key, list);
    }
  }
  return out;
}

/** Singing-time-weighted mean of each style dimension across the clips (null where no clip measured it). */
export function combinedStyle(clips: MeasuredClip[]): StyleVector {
  const byKey = valuesByKey(clips);
  const style = {} as StyleVector;
  for (const key of STYLE_KEYS) {
    const values = byKey.get(key);
    if (!values || values.length === 0) {
      style[key] = null;
      continue;
    }
    const total = values.reduce((s, v) => s + v.weight, 0);
    style[key] = values.reduce((s, v) => s + v.value * v.weight, 0) / total;
  }
  return style;
}

/** Weighted standard deviation across clips, or 0 with fewer than two measurements. */
function spread(values: { value: number; weight: number }[]): number {
  if (values.length < 2) return 0;
  const total = values.reduce((s, v) => s + v.weight, 0);
  const mean = values.reduce((s, v) => s + v.value * v.weight, 0) / total;
  const variance = values.reduce((s, v) => s + v.weight * (v.value - mean) ** 2, 0) / total;
  return Math.sqrt(variance);
}

/**
 * A singer varies from song to song, so when the clips disagree the on-style band widens to cover
 * that spread (never narrower than the single-clip band). Capped dimensions keep their safety limits.
 */
function widenBySpread(key: StyleKey, band: TargetBand, sd: number): TargetBand {
  if (CAPPED.has(key) || sd <= 0) return band;
  const spec = BAND_SPECS[key];
  const lo = spec.min ?? -Infinity;
  const hi = spec.max ?? Infinity;
  const low = Math.max(lo, Math.min(band.low, band.ideal - sd));
  const high = Math.min(hi, Math.max(band.high, band.ideal + sd));
  return { ...band, low, high };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function rangeFrom(clips: MeasuredClip[], base: SingerProfile): SingerProfile['typicalRange'] {
  const lows = clips.map((c) => c.pitch.lowMidi).filter(finite);
  const highs = clips.map((c) => c.pitch.highMidi).filter(finite);
  const tLows = clips.map((c) => c.pitch.tessituraLowMidi).filter(finite);
  const tHighs = clips.map((c) => c.pitch.tessituraHighMidi).filter(finite);
  if (!lows.length || !highs.length || !tLows.length || !tHighs.length) return { ...base.typicalRange };
  return {
    lowMidi: Math.min(...lows),
    highMidi: Math.max(...highs),
    tessituraLowMidi: Math.round(median(tLows)),
    tessituraHighMidi: Math.round(median(tHighs)),
  };
}

function sourceNote(base: SingerProfile, clips: MeasuredClip[]): string {
  const sec = Math.round(clips.reduce((s, c) => s + c.voicedSec, 0));
  const n = clips.length;
  return (
    `Targets measured from ${n} clip${n === 1 ? '' : 's'} of ${base.name} that you added (${sec} s of singing), ` +
    'analysed the same way as your takes. More clips from different songs give steadier targets. ' +
    'Tuning keeps a fixed "clean" target because released vocals are often pitch-corrected, and rasp, chest weight and ' +
    'loudness climb are capped at healthy levels whatever the recordings do.'
  );
}

/**
 * The builtin singer with targets measured from the clips. Without clips it returns the builtin
 * profile unchanged. The id stays the builtin id, so singer tabs, coaching cues, key advice and
 * progress history keep working.
 */
export function measuredProfile(base: SingerProfile, clips: MeasuredClip[]): SingerProfile {
  if (clips.length === 0) return base;
  const style = combinedStyle(clips);
  const byKey = valuesByKey(clips);
  const targets = targetsFromStyle(style, base);
  for (const key of Object.keys(targets) as StyleKey[]) {
    const band = targets[key];
    if (band) targets[key] = widenBySpread(key, band, spread(byKey.get(key) ?? []));
  }
  const traits = describeStyleTraits(style);
  return {
    ...base,
    traits: traits.length ? traits : [...base.traits],
    typicalRange: rangeFrom(clips, base),
    targets,
    source: 'measured',
    sourceNote: sourceNote(base, clips),
  };
}
