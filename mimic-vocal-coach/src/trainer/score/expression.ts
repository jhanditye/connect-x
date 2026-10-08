// Expression skill: dynamics (relative loudness contour), vibrato match, phrase attack, scoops/fall-offs, ornaments.
// Everything is RELATIVE to the take's own median (level) or to the matched reference note, so mic gain, distance and the
// reference's mastering do not count against the singer.

import { detectVibrato } from '../../analysis/vibrato';
import { median } from '../../dsp/stats';
import type { OnsetType } from '../../types';
import {
  EXPR_ATTACK_WEIGHT, EXPR_DYNAMICS_WEIGHT, EXPR_ORNAMENT_WEIGHT, EXPR_SCOOP_WEIGHT, EXPR_VIBRATO_WEIGHT, LEVEL_DEAD_DB, LEVEL_SIGMA_DB, SCOOP_DEAD,
  SCOOP_FINDING, SCOOP_MAX, SCOOP_MIN_NOTE_SEC, SCOOP_PRESENT, SCOOP_SIGMA, VIB_DELAY_DEAD_SEC, VIB_DELAY_SIGMA_SEC, VIB_EXTENT_DEAD, VIB_EXTENT_SIGMA, VIB_MISMATCH_CREDIT, VIB_WEAK_CENTS, VIB_WEAK_MISMATCH_CREDIT, VIB_RATE_DEAD_HZ, VIB_RATE_SIGMA_HZ,
} from './constants';
import { windowMedian, type Prep } from './contour';
import { combine, win, type Ctx, type Insight, type SkillResult } from './ctx';
import type { ScoreComponent } from './types';
import { bell, round, theilSen, wmean } from './util';

/** Seconds from the start of a held note until its vibrato is under way (running amplitude reaches 50 % of its maximum). */
export function vibratoStart(p: Prep, t0: number, t1: number): number | null {
  const i0 = Math.max(0, Math.round(t0 / p.hop));
  const i1 = Math.min(p.fine.length, Math.round(t1 / p.hop));
  const n = i1 - i0;
  if (n * p.hop < 0.6) return null;
  const c: number[] = [];
  for (let i = i0; i < i1; i++) c.push(Number.isFinite(p.fine[i]) ? p.fine[i] * 100 : NaN);
  const w = Math.round(0.3 / p.hop) | 1;
  const dev = c.map((v, i) => {
    if (!Number.isFinite(v)) return NaN;
    let s = 0;
    let m = 0;
    for (let k = Math.max(0, i - (w >> 1)); k <= Math.min(n - 1, i + (w >> 1)); k++) if (Number.isFinite(c[k])) (s += c[k]), m++;
    return v - s / m;
  });
  const win = Math.round(0.25 / p.hop);
  const amp: number[] = [];
  for (let i = 0; i + win <= n; i++) {
    let ss = 0;
    let m = 0;
    for (let k = i; k < i + win; k++) if (Number.isFinite(dev[k])) (ss += dev[k] * dev[k]), m++;
    amp.push(m >= win * 0.7 ? Math.sqrt(ss / m) * Math.SQRT2 : NaN);
  }
  const finite = amp.filter(Number.isFinite);
  if (finite.length === 0) return null;
  const top = Math.max(...finite);
  if (!(top >= 12)) return null;
  const first = amp.findIndex((v) => Number.isFinite(v) && v >= 0.5 * top);
  return first < 0 ? null : (first + win / 2) * p.hop;
}

/** Pitch shape at a note's start / end, cents: how far below the settled pitch the note starts (scoop) and above it ends (fall). */
export function scoopFall(p: Prep, t0: number, t1: number): { scoop: number | null; fall: number | null } {
  if (t1 - t0 < SCOOP_MIN_NOTE_SEC) return { scoop: null, fall: null };
  // the start uses the raw contour (vibrato usually starts later); the end uses the vibrato-smoothed centre line
  const a = windowMedian(p.fine, p, t0 + 0.02, t0 + 0.08, 3);
  const b = windowMedian(p.fine, p, t0 + 0.2, t0 + 0.32, 4);
  const c = windowMedian(p.centre, p, t1 - 0.25, t1 - 0.15, 3);
  const d = windowMedian(p.centre, p, t1 - 0.07, t1 - 0.02, 3);
  return {
    scoop: Number.isFinite(a) && Number.isFinite(b) ? (a - b) * 100 : null,
    fall: Number.isFinite(c) && Number.isFinite(d) ? (d - c) * 100 : null,
  };
}

const ONSET_ORDER: Record<OnsetType, number> = { breathy: 0, balanced: 1, glottal: 2 };

export function scoreExpression(ctx: Ctx): SkillResult {
  const { ref, att, al, perNote } = ctx;
  const rn = ref.a.notes;
  const insights: Insight[] = [];
  const comps: ScoreComponent[] = [];
  // level of a window: median frame level over its middle 60 % (attacks and releases are not the note's level)
  const levelIn = (p: typeof att, t0: number, t1: number): number => {
    const d = t1 - t0;
    const v: number[] = [];
    const i0 = Math.max(0, Math.round((t0 + 0.2 * d) / p.hop));
    const i1 = Math.min(p.level.length, Math.round((t1 - 0.2 * d) / p.hop));
    for (let i = i0; i < i1; i++) if (Number.isFinite(p.level[i])) v.push(p.level[i]);
    return v.length >= 3 ? median(v) : NaN;
  };

  // ---- dynamics: per-note level relative to each take's own median over the matched notes --------------------
  const dk: number[] = [];
  const rl: number[] = [];
  const ul: number[] = [];
  for (const nm of al.notes) {
    const w = win(ctx, nm.k);
    if (!w) continue;
    const r = rn[nm.k];
    const u = levelIn(att, w.u0, w.u1);
    const rv = levelIn(ref, r.start, r.end);
    if (Number.isFinite(rv) && Number.isFinite(u)) {
      dk.push(nm.k);
      rl.push(rv);
      ul.push(u);
    }
  }
  let dynScore: number | null = null;
  let dynN = 0;
  let dyn: number[] = [];
  if (dk.length >= 3) {
    const mr = median(rl);
    const mu = median(ul);
    dyn = dk.map((_, i) => ul[i] - mu - (rl[i] - mr));
    const dw = dk.map((k) => Math.max(rn[k].end - rn[k].start, 0.15));
    dk.forEach((k, i) => (perNote[k].levelDeltaDb = dyn[i]));
    dynScore = 100 * wmean(dyn.map((d) => bell(d, LEVEL_DEAD_DB, LEVEL_SIGMA_DB)), dw);
    dynN = dk.length;
  }
  comps.push({ id: 'expr.dynamics', skill: 'expression', label: 'Loudness contour', score: dynScore, weight: EXPR_DYNAMICS_WEIGHT, value: dyn.length ? `${round(median(dyn.map(Math.abs)), 1)} dB median difference` : undefined, n: dynN });

  // ---- vibrato (read straight from the attempt's frames inside the mapped window, not from its note list) ----
  const presence: number[] = [];
  const rate: number[] = [];
  const extent: number[] = [];
  const delay: number[] = [];
  const vibNotes: number[] = [];
  const rateDesc: [number, number][] = [];
  const extDesc: [number, number][] = [];
  let refVibCount = 0;
  let userVibCount = 0;
  for (const nm of al.notes) {
    const w = win(ctx, nm.k);
    const r = rn[nm.k];
    if (!w || r.end - r.start < 0.45 || w.u1 - w.u0 < 0.4) continue;
    const i0 = Math.max(0, Math.round(w.u0 / att.hop));
    const i1 = Math.min(att.a.frames.length, Math.round(w.u1 / att.hop));
    const uv = detectVibrato(att.a.frames, i0, i1, Number.isFinite(nm.userPitch) ? nm.userPitch : al.refPitch[nm.k] + al.teff, att.hop);
    const rv = r.vibrato;
    perNote[nm.k].refVibrato = !!rv;
    perNote[nm.k].userVibrato = !!uv;
    if (!rv && !uv) continue;
    vibNotes.push(nm.k);
    if (rv) refVibCount++;
    if (uv) userVibCount++;
    if (rv && uv) {
      presence.push(1);
      rate.push(bell(uv.rateHz - rv.rateHz, VIB_RATE_DEAD_HZ, VIB_RATE_SIGMA_HZ));
      extent.push(bell(Math.log(uv.extentCents / rv.extentCents), VIB_EXTENT_DEAD, VIB_EXTENT_SIGMA));
      rateDesc.push([uv.rateHz, rv.rateHz]);
      extDesc.push([uv.extentCents, rv.extentCents]);
      const a = vibratoStart(att, w.u0, w.u1);
      const b = vibratoStart(ref, r.start, r.end);
      if (a !== null && b !== null) delay.push(bell(a - b * al.tempo, VIB_DELAY_DEAD_SEC, VIB_DELAY_SIGMA_SEC));
    } else {
      // one take has vibrato and the other does not. A weak vibrato (< 30 cents) is borderline for the detector itself, so the
      // mismatch is probably not a real difference; a clear one (the reference swells with +-45 cents and yours is straight) is.
      const weak = (rv ?? uv)!.extentCents < VIB_WEAK_CENTS;
      presence.push(weak ? VIB_WEAK_MISMATCH_CREDIT : VIB_MISMATCH_CREDIT);
    }
  }
  let vibScore: number | null = null;
  if (presence.length > 0) {
    const parts: [number, number][] = [[0.4, mean(presence)]];
    if (rate.length) parts.push([0.2, mean(rate)], [0.25, mean(extent)]);
    if (delay.length) parts.push([0.15, mean(delay)]);
    const wsum = parts.reduce((a, [w]) => a + w, 0);
    vibScore = (100 * parts.reduce((a, [w, v]) => a + w * v, 0)) / wsum;
  }
  comps.push({ id: 'expr.vibrato', skill: 'expression', label: 'Vibrato', score: vibScore, weight: EXPR_VIBRATO_WEIGHT, value: presence.length ? `reference vibrato on ${refVibCount}, yours on ${userVibCount} of ${presence.length} held notes` : undefined, n: presence.length });

  // ---- attack (phrase onset type) ---------------------------------------------------------------------------
  const attackG: number[] = [];
  let attackNote = '';
  for (const ro of ref.a.onsets) {
    const exp = al.at(ro.t);
    let best: { t: number; type: OnsetType } | null = null;
    for (const uo of att.a.onsets) if (Math.abs(uo.t - exp) <= 0.6 && (best === null || Math.abs(uo.t - exp) < Math.abs(best.t - exp))) best = uo;
    if (!best) continue;
    const dist = Math.abs(ONSET_ORDER[ro.type] - ONSET_ORDER[best.type]);
    attackG.push(dist === 0 ? 1 : dist === 1 ? 0.75 : 0);
    if (dist > 1 && !attackNote) attackNote = `The reference starts the phrase ${ro.type === 'balanced' ? 'cleanly' : ro.type === 'breathy' ? 'with a soft breathy onset' : 'with a firm glottal onset'}; yours is ${best.type === 'balanced' ? 'clean' : best.type}.`;
  }
  const attackScore = attackG.length ? 100 * mean(attackG) : null;
  comps.push({ id: 'expr.attack', skill: 'expression', label: 'Phrase attack', score: attackScore, weight: EXPR_ATTACK_WEIGHT, n: attackG.length });

  // ---- scoops and fall-offs (only on notes where one of the two takes actually has one) ----------------------
  const sg: number[] = [];
  const scoopNotes: { k: number; diff: number; kind: 'scoop' | 'fall' }[] = [];
  for (const nm of al.notes) {
    const w = win(ctx, nm.k);
    if (!w) continue;
    const r = rn[nm.k];
    const a = scoopFall(ref, r.start, r.end);
    const b = scoopFall(att, w.u0, w.u1);
    // readings beyond +-SCOOP_MAX cents are measurement failures (a window that caught the neighbouring note), not shaping
    const ok = (v: number | null): v is number => v !== null && Math.abs(v) <= SCOOP_MAX;
    if (ok(a.scoop) && ok(b.scoop) && Math.max(Math.abs(a.scoop), Math.abs(b.scoop)) >= SCOOP_PRESENT) {
      const diff = b.scoop - a.scoop;
      sg.push(bell(diff, SCOOP_DEAD, SCOOP_SIGMA));
      if (Math.abs(diff) >= SCOOP_FINDING) scoopNotes.push({ k: nm.k, diff, kind: 'scoop' });
    }
    if (ok(a.fall) && ok(b.fall) && !r.vibrato && !perNote[nm.k].userVibrato && Math.max(Math.abs(a.fall), Math.abs(b.fall)) >= SCOOP_PRESENT) {
      const diff = b.fall - a.fall;
      sg.push(bell(diff, SCOOP_DEAD, SCOOP_SIGMA));
      if (Math.abs(diff) >= SCOOP_FINDING) scoopNotes.push({ k: nm.k, diff, kind: 'fall' });
    }
  }
  const scoopScore = sg.length >= 1 ? 100 * mean(sg) : null;
  comps.push({ id: 'expr.scoops', skill: 'expression', label: 'Scoops and fall-offs', score: scoopScore, weight: EXPR_SCOOP_WEIGHT, n: sg.length });

  // ---- ornaments (runs) --------------------------------------------------------------------------------------
  const runScores: number[] = [];
  const runInfo: { start: number; end: number; frac: number; userRun: boolean }[] = [];
  for (const run of ref.a.runs) {
    const ks = rn.map((n, k) => (n.start >= run.start - 0.02 && n.end <= run.end + 0.02 ? k : -1)).filter((k) => k >= 0);
    if (ks.length < 3) continue;
    const frac = ks.filter((k) => al.notes[k].matched).length / ks.length;
    const u0 = al.at(run.start) - 0.3;
    const u1 = al.at(run.end) + 0.3;
    const userRun = att.a.runs.some((ur) => ur.end >= u0 && ur.start <= u1);
    runScores.push(0.5 * frac + 0.5 * (userRun ? 1 : 0.2));
    runInfo.push({ start: run.start, end: run.end, frac, userRun });
  }
  const runScore = runScores.length ? 100 * mean(runScores) : null;
  comps.push({ id: 'expr.ornaments', skill: 'expression', label: 'Runs and ornaments', score: runScore, weight: EXPR_ORNAMENT_WEIGHT, n: runScores.length });

  const score = combine(comps);
  if (score === null) return { score: null, components: comps, insights, stats: {} };

  // ---- insights -----------------------------------------------------------------------------------------------
  const cw = comps.reduce((a, c) => a + (c.score !== null ? c.weight : 0), 0);
  const loss = (id: string, share = 1): number => {
    const c = comps.find((x) => x.id === id);
    return c && c.score !== null ? (c.weight / cw) * (100 - c.score) * share : 0;
  };
  const nm = (k: number): string => `note ${k + 1} (${perNote[k].refName})`;

  if (dynScore !== null && dynScore < 85) {
    const idx = dyn.map((_, i) => i).filter((i) => Math.abs(dyn[i]) >= 5);
    const louder = idx.filter((i) => dyn[i] > 0);
    const softer = idx.filter((i) => dyn[i] < 0);
    const f = dk.length >= 5 ? theilSen(dk.map((k) => rn[k].start), dyn, 0.3) : null;
    const span = f ? rn[dk[dk.length - 1]].start - rn[dk[0]].start : 0;
    const trend = f ? f.slope * span : 0;
    if (Math.abs(trend) >= 5 && span >= 2) {
      insights.push({
        id: 'expr.level-trend', skill: 'expression', kind: 'fix', title: trend < 0 ? 'Fading out' : 'Getting louder',
        text: trend < 0 ? `Your level falls away across the phrase compared with the reference (about ${Math.round(-trend)} dB lower by the end).` : `Your level grows across the phrase compared with the reference (about ${Math.round(trend)} dB more by the end).`,
        advice: trend < 0 ? 'Keep the breath flowing so the last notes keep their body; stay relaxed, no pushing.' : 'Keep the level even as you climb; ease the weight off rather than adding to it.',
        lossSkill: loss('expr.dynamics'), notes: [],
      });
    } else if (louder.length || softer.length) {
      const ks = [...louder, ...softer].map((i) => dk[i]);
      const worst = [...ks].sort((a, b) => Math.abs(perNote[b].levelDeltaDb as number) - Math.abs(perNote[a].levelDeltaDb as number)).slice(0, 3);
      insights.push({
        id: 'expr.dynamics', skill: 'expression', kind: 'fix', title: 'Loudness shape differs',
        text: `Your loudness shape differs from the reference on ${ks.length} note${ks.length === 1 ? '' : 's'}: ${worst.map((k) => `${nm(k)} is ${Math.round(Math.abs(perNote[k].levelDeltaDb as number))} dB ${(perNote[k].levelDeltaDb as number) > 0 ? 'stronger' : 'softer'} relative to the rest`).join('; ')}.`,
        advice: 'Match the shape, not the volume: where the reference leans in, add a little breath and warmth; where it pulls back, lighten. Never force it.',
        lossSkill: loss('expr.dynamics'), notes: ks,
      });
    }
  }
  if (dk.length >= 4) {
    const sdU = std(ul);
    const sdR = std(rl);
    if (sdR >= 2.5 && sdU < 0.5 * sdR) {
      insights.push({ id: 'expr.flat', skill: 'expression', kind: 'info', title: 'Flatter dynamics', text: `Your loudness varies much less than the reference's (${round(sdU, 1)} dB vs ${round(sdR, 1)} dB between notes): the phrase sounds flatter.`, advice: 'Let the stressed notes bloom slightly and the ends of phrases soften.', lossSkill: 0, notes: [] });
    }
  }
  if (vibScore !== null && vibScore < 75) {
    const text =
      refVibCount > 0 && userVibCount === 0
        ? `The reference lets ${refVibCount} held note${refVibCount === 1 ? '' : 's'} shimmer with vibrato; yours stay straight.`
        : userVibCount > 0 && refVibCount === 0
          ? 'Your held notes carry vibrato where the reference sings them straight.'
          : `Your vibrato differs from the reference's (rate ${rateDesc.length ? `${round(median(rateDesc.map((x) => x[0])), 1)} Hz vs ${round(median(rateDesc.map((x) => x[1])), 1)} Hz` : 'n/a'}, width ${extDesc.length ? `±${Math.round(median(extDesc.map((x) => x[0])))} vs ±${Math.round(median(extDesc.map((x) => x[1])))} cents` : 'n/a'}).`;
    insights.push({
      id: 'expr.vibrato', skill: 'expression', kind: 'fix', title: 'Vibrato', text,
      advice: refVibCount > userVibCount ? 'Vibrato comes from a relaxed, steady tone: hold the note straight first, then let it start late in the note, as the reference does. Do not wobble the voice on purpose.' : 'Hold these notes straight and let any movement arrive late in the note.',
      lossSkill: loss('expr.vibrato'), notes: vibNotes,
    });
  }
  if (attackScore !== null && attackScore < 60 && attackNote) {
    insights.push({ id: 'expr.attack', skill: 'expression', kind: 'fix', title: 'Phrase attack', text: attackNote, advice: 'Start the first note from a light breath onset for a soft start, or from a clean "uh" onset for a firm one, never a hard push.', lossSkill: loss('expr.attack'), notes: [] });
  }
  if (scoopScore !== null && scoopScore < 70 && scoopNotes.length) {
    const sc = scoopNotes.filter((s) => s.kind === 'scoop');
    const fl = scoopNotes.filter((s) => s.kind === 'fall');
    const parts: string[] = [];
    if (sc.length) parts.push(`${sc.length} note start${sc.length === 1 ? '' : 's'} ${median(sc.map((s) => s.diff)) > 0 ? 'with less of a scoop up into the note than' : 'with more of a scoop up into the note than'} the reference`);
    if (fl.length) parts.push(`${fl.length} note end${fl.length === 1 ? '' : 's'} ${median(fl.map((s) => s.diff)) > 0 ? 'rise instead of falling away like' : 'fall away more than'} the reference`);
    insights.push({
      id: 'expr.scoops', skill: 'expression', kind: 'fix', title: 'Scoops and fall-offs', text: `Note shaping differs: ${parts.join('; ')}.`,
      advice: 'Listen to the first 100 ms of the held notes: the reference slides into some of them from below. Copy that slide gently, slowly at first.',
      lossSkill: loss('expr.scoops'), notes: scoopNotes.map((s) => s.k),
    });
  }
  if (runScore !== null && runScore < 70) {
    insights.push({ id: 'expr.runs', skill: 'expression', kind: 'fix', title: 'Runs', text: `The reference has ${runInfo.length} fast run${runInfo.length === 1 ? '' : 's'}${runInfo.some((r) => !r.userRun) ? ' that you smoothed over or sang as fewer notes' : ''}. Runs are judged loosely (the gist of the shape), so this costs little.`, advice: 'Sing the run at half speed on one vowel, then speed up until the notes blur; the shape matters more than every note.', lossSkill: loss('expr.ornaments'), notes: [] });
  }
  if (score >= 85) insights.push({ id: 'expr.good', skill: 'expression', kind: 'good', title: 'Expression', text: 'Your shaping (loudness, vibrato, note starts and ends) follows the reference well.', advice: '', lossSkill: 0, notes: [] });
  return { score, components: comps, insights, stats: { dynamicsN: dynN, vibratoNotes: presence.length, scoopN: sg.length } };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function std(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

