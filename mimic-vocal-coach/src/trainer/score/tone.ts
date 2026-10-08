// Tone skill: how the voice is colored, compared only through the normalised StyleVector indices and only against what the
// measurement can resolve.
//
//   d_key   = (attempt - reference) - keyBias(key, T) - userBias(key)                 index units
//   score   = 100 * bell(d_key, TONE_DEAD[key] + TONE_DEAD_PER_SEMITONE[key] * |T|, TONE_SIGMA[key])
//   tone    = weighted mean over breathiness .35, brightness .30, rasp .15 (only when present), register .20 (only in a comparable key)
//
// NOT compared, on purpose: absolute H1-H2 / alpha ratio / centroid / CPP / HNR in dB or Hz, MFCC or mel-spectral distance,
// formants, absolute level. Between different singers (and between a studio stem and a phone) they differ for reasons that
// are anatomy and recording chain, not technique (see the E1 table).

import { median } from '../../dsp/stats';
import { keyBias, TONE_DEAD, TONE_DEAD_PER_SEMITONE, TONE_SIGMA, TONE_WEIGHTS } from './constants';
import type { FrameFeatures, RegisterLabel, StyleVector } from '../../types';
import { combine, win, type Ctx, type Insight, type SkillResult } from './ctx';
import type { ScoreComponent } from './types';
import { bell, round } from './util';

type ToneKey = 'breathiness' | 'brightness' | 'rasp';
/** Reference rasp above this is not asked for (the app's safety caps: never coach manufactured grit). */
export const MAX_RASP_REFERENCE = 0.25;
const ORD = { chest: 0, mix: 1, head: 2 } as const;
const LABEL: Record<ToneKey, string> = { breathiness: 'Breathiness', brightness: 'Brightness', rasp: 'Rasp' };

export interface ToneDiff {
  key: ToneKey;
  user: number;
  ref: number;
  raw: number;
  corrected: number;
  dead: number;
}

/**
 * Attempt-minus-reference differences of the normalised tone indices, after the expected key effect and the singer's own
 * microphone / room offset are taken out. Only these indices are ever compared (never raw dB features). Both takes must have
 * measured the index; rasp is compared only when either take has some, and the reference's rasp is capped (never asked for).
 */
export function toneIndexDiffs(attempt: StyleVector, reference: StyleVector, T: number, toneBias: Partial<Record<ToneKey, number>> = {}): ToneDiff[] {
  const out: ToneDiff[] = [];
  for (const key of ['breathiness', 'brightness', 'rasp'] as const) {
    const u = attempt[key];
    let r = reference[key];
    if (u === null || r === null) continue;
    if (key === 'rasp') {
      r = Math.min(r, MAX_RASP_REFERENCE);
      if (Math.max(u, r) < 0.1) continue; // both clean: a match that carries no information
    }
    const raw = u - r;
    const corrected = raw - keyBias(key, T) - (toneBias[key] ?? 0);
    const dead = TONE_DEAD[key] + TONE_DEAD_PER_SEMITONE[key] * Math.min(12, Math.abs(T));
    out.push({ key, user: u, ref: r, raw, corrected, dead });
  }
  return out;
}

export function toneDiffs(ctx: Ctx, T: number): ToneDiff[] {
  return toneIndexDiffs(ctx.att.a.style, ctx.ref.a.style, T, ctx.toneBias);
}

/** A personal offset larger than this would hide a real technique difference, so it is never applied. */
export const TONE_BIAS_MAX = 0.15;

/**
 * Median attempt-minus-reference offset per index over a user's past attempts: their mic / room / anatomy offset, to pass as
 * `toneBias`. Needs at least `minAttempts` attempts per index, is capped at +-TONE_BIAS_MAX, and never covers rasp
 * (a grit difference is never calibrated away, and never coached toward).
 */
export function estimateToneBias(history: { diffs: Partial<Record<ToneKey, number>> }[], minAttempts = 6): Partial<Record<ToneKey, number>> {
  const out: Partial<Record<ToneKey, number>> = {};
  for (const key of ['breathiness', 'brightness'] as const) {
    const v = history.map((h) => h.diffs[key]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    if (v.length >= minAttempts) out[key] = Math.max(-TONE_BIAS_MAX, Math.min(TONE_BIAS_MAX, median(v)));
  }
  return out;
}

/**
 * The tone bias from stored attempts: each attempt's own StyleVector against the style of the phrase it was sung against
 * (PhraseRecord.summary.style), with the key effect removed. Attempts whose phrase has no tone measurement (mix clips) are skipped.
 */
export function toneBiasFromAttempts(
  items: { transposeSemitones: number; style: StyleVector; refStyle: StyleVector | null }[],
  minAttempts = 6,
): Partial<Record<ToneKey, number>> {
  const history: { diffs: Partial<Record<ToneKey, number>> }[] = [];
  for (const i of items) {
    if (i.refStyle === null) continue;
    const diffs: Partial<Record<ToneKey, number>> = {};
    for (const d of toneIndexDiffs(i.style, i.refStyle, i.transposeSemitones)) diffs[d.key] = d.corrected;
    history.push({ diffs });
  }
  return estimateToneBias(history, minAttempts);
}

export function registerComparable(ctx: Ctx, T: number): boolean {
  const dz = ctx.att.a.passaggio.lowMidi - ctx.ref.a.passaggio.lowMidi;
  return Math.abs(T - dz) <= 2;
}

export function scoreTone(ctx: Ctx, T: number): SkillResult {
  const insights: Insight[] = [];
  if (ctx.att.a.voicedSec < 1 || ctx.ref.a.voicedSec < 1) return { score: null, components: [], insights, stats: {} };
  const diffs = toneDiffs(ctx, T);
  const comps: ScoreComponent[] = [];
  for (const d of diffs) {
    const score = 100 * bell(d.corrected, d.dead, TONE_SIGMA[d.key]);
    comps.push({
      id: `tone.${d.key}`, skill: 'tone', label: LABEL[d.key], score, weight: TONE_WEIGHTS[d.key],
      value: `${d.user.toFixed(2)} vs ${d.ref.toFixed(2)} (${d.corrected >= 0 ? '+' : ''}${d.corrected.toFixed(2)} after key/mic allowance)`,
    });
  }
  // register, only when the line sits the same way against each singer's own passaggio
  let regScore: number | null = null;
  const regKs: number[] = [];
  if (registerComparable(ctx, T)) {
    const g: number[] = [];
    for (const nm of ctx.al.notes) {
      const w = win(ctx, nm.k);
      const r = ctx.ref.a.notes[nm.k];
      if (!w || r.end - r.start < 0.3 || !r.register) continue;
      const ur = majorityRegister(ctx.att.a.frames, Math.round(w.u0 / ctx.att.hop), Math.round(w.u1 / ctx.att.hop));
      if (!ur) continue;
      const dist = Math.abs(ORD[r.register] - ORD[ur]);
      g.push(dist === 0 ? 1 : dist === 1 ? 0.5 : 0);
      if (dist > 0) regKs.push(nm.k);
    }
    if (g.length >= 3) regScore = (100 * g.reduce((a, b) => a + b, 0)) / g.length;
  }
  comps.push({ id: 'tone.register', skill: 'tone', label: 'Register (chest/mix/head)', score: regScore, weight: TONE_WEIGHTS.register, value: regScore === null ? undefined : `${regKs.length} notes in a different register (estimate)` });
  const score = combine(comps);
  if (score === null) return { score: null, components: comps, insights, stats: {} };

  const cw = comps.reduce((a, c) => a + (c.score !== null ? c.weight : 0), 0);
  const loss = (id: string): number => {
    const c = comps.find((x) => x.id === id);
    return c && c.score !== null ? (c.weight / cw) * (100 - c.score) : 0;
  };
  for (const d of diffs) {
    const c = comps.find((x) => x.id === `tone.${d.key}`) as ScoreComponent;
    if ((c.score as number) >= 75) continue;
    const mag = Math.abs(d.corrected);
    const size = mag < d.dead + 0.1 ? 'a little' : mag < d.dead + 0.25 ? 'clearly' : 'much';
    const more = d.corrected > 0;
    if (d.key === 'breathiness') {
      insights.push({
        id: 'tone.breathiness', skill: 'tone', kind: 'fix', title: more ? 'Airier than the reference' : 'Firmer than the reference',
        text: `Your tone is ${size} ${more ? 'airier' : 'firmer and cleaner'} than the reference (breathiness ${d.user.toFixed(2)} vs ${d.ref.toFixed(2)}).`,
        advice: more ? 'Close the sound up a little: say "nay" or "gee" on the melody at a comfortable volume, then relax it into the vowel. Do not push; it should feel easy.' : 'Let a little more air into the tone, like a sung sigh on the vowel, staying light and relaxed.',
        lossSkill: loss(c.id), notes: [],
      });
    } else if (d.key === 'brightness') {
      insights.push({
        id: 'tone.brightness', skill: 'tone', kind: 'fix', title: more ? 'Brighter than the reference' : 'Darker than the reference',
        text: `Your tone is ${size} ${more ? 'brighter and more forward' : 'darker and rounder'} than the reference (brightness ${d.user.toFixed(2)} vs ${d.ref.toFixed(2)}).`,
        advice: more ? 'Round the vowel a touch (more "oh" shape), relax the jaw and keep the sound at the same easy volume.' : 'Narrow the vowel slightly toward "ee"/"eh" and aim the sound forward; do not get louder to do it.',
        lossSkill: loss(c.id), notes: [],
      });
    } else if (more) {
      insights.push({
        id: 'tone.rasp', skill: 'tone', kind: 'fix', title: 'More grit than the reference',
        text: `There is more rasp in your tone than in the reference (${d.user.toFixed(2)} vs ${d.ref.toFixed(2)}).`,
        advice: 'Back off to a cleaner tone: lighter, more breath flow. If your throat feels scratchy or tight, stop and rest your voice.',
        lossSkill: loss(c.id), notes: [],
      });
    } else {
      insights.push({
        id: 'tone.rasp', skill: 'tone', kind: 'info', title: 'Cleaner than the reference',
        text: `The reference has a little grit that your clean tone does not (${d.ref.toFixed(2)} vs ${d.user.toFixed(2)}). That is not something to force.`,
        advice: 'Do not manufacture grit by squeezing; a clean tone is a healthy choice.', lossSkill: 0, notes: [],
      });
    }
  }
  if (regScore !== null && regScore < 70) {
    insights.push({
      id: 'tone.register', skill: 'tone', kind: 'fix', title: 'Different register',
      text: `The sound sits in a different register from the reference on ${regKs.length} note${regKs.length === 1 ? '' : 's'} (an acoustic estimate: chest, mix or head).`,
      advice: 'Lighten the weight on those notes (narrower vowel, less volume) to carry mix higher, as the reference does; or add a little weight if yours is flipping into head voice.',
      lossSkill: loss('tone.register'), notes: regKs,
    });
  }
  if (score >= 85) insights.push({ id: 'tone.good', skill: 'tone', kind: 'good', title: 'Tone', text: 'Your tone colour is close to the reference (within what the microphone and key can resolve).', advice: '', lossSkill: 0, notes: [] });
  return { score, components: comps, insights, stats: Object.fromEntries(diffs.map((d) => [`diff_${d.key}`, round(d.corrected, 3)])) };
}

function majorityRegister(frames: FrameFeatures[], i0: number, i1: number): RegisterLabel | null {
  const counts = { chest: 0, mix: 0, head: 0 };
  for (let i = Math.max(0, i0); i < Math.min(frames.length, i1); i++) {
    const r = frames[i].register;
    if (r) counts[r]++;
  }
  const total = counts.chest + counts.mix + counts.head;
  if (total < 5) return null;
  if (counts.chest >= counts.mix && counts.chest >= counts.head) return 'chest';
  return counts.mix >= counts.head ? 'mix' : 'head';
}
