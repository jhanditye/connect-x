// Timing skill.
//
//   e_k   = (attemptOnset_k - (lag + tempo * refOnset_k)) * 1000           ms, + = late; read at transition onsets only (after a rest
//                                                                          or a pitch step) where the DTW corner is sharp. lag and tempo
//                                                                          are fitted (Theil-Sen), so a global delay or a different overall
//                                                                          speed is NOT an onset error
//   onset = mean_k bell(e_k, 30, 55)                                       ornaments: bell(e_k, 70, 100), weight 0.4
//   tempo = bell(ln(tempo * rate), ln 1.05, 0.08)                          only with >= 4 onset pairs over >= 1.5 s
//   dur   = mean_k bell(ln(attemptDur_k / (tempo * refDur_k)), 0.18, 0.30)  notes bounded by two transitions; long notes weigh more;
//                                                                          the last note and ornaments count 0.4
//   timing = 100 * (0.45 onset + 0.30 tempo + 0.25 dur)  over the parts that could be measured (onset needs >= 2 pairs)

import { median } from '../../dsp/stats';
import {
  DUR_DEAD, DUR_SIGMA, LATE_EARLY_MS, WRONG_NOTE_CENTS, ONSET_DEAD_MS, ONSET_ORN_DEAD_MS, ONSET_ORN_SIGMA_MS, ONSET_SIGMA_MS, ORNAMENT_WEIGHT, TEMPO_DEAD, TEMPO_SIGMA,
  TIMING_DUR_WEIGHT, TIMING_ONSET_WEIGHT, TIMING_TEMPO_WEIGHT,
} from './constants';
import { combine, type Ctx, type Insight, type SkillResult } from './ctx';
import type { ScoreComponent } from './types';
import { soundingEnd } from './transitions';
import { bell, mad, round, wmean } from './util';

export function scoreTiming(ctx: Ctx): SkillResult {
  const { al, perNote } = ctx;
  const rn = ctx.ref.a.notes;
  const insights: Insight[] = [];
  const onsetK: number[] = [];
  const onsetE: number[] = [];
  const onsetG: number[] = [];
  const onsetW: number[] = [];
  const durK: number[] = [];
  const durG: number[] = [];
  const durW: number[] = [];

  // An entrance that follows a note sung at a clearly different pitch cannot be read from the pitch step that marks it (the step is
  // missing or reversed in the take, so the aligner keeps a stale corner): such pairs would invent "starts early / late" fixes for what
  // is a pitch error. Pitch is scored before timing, so the flags are already there. An entrance after a rest is a voiced-run start
  // and does not depend on the neighbour's pitch.
  const wrongish = (k: number): boolean => {
    const r = perNote[k];
    return !!r && r.matched && (r.flags.includes('wrong-note') || r.flags.includes('octave-displaced') || Math.abs(r.cents ?? 0) >= WRONG_NOTE_CENTS);
  };
  const isAfterRest = (k: number): boolean => k === 0 || rn[k].start - rn[k - 1].end >= 0.08;
  const pairs = al.onsetPairs.filter((p) => p.found && perNote[p.k].matched && !(wrongish(p.k) || (!isAfterRest(p.k) && wrongish(p.k - 1))));
  for (const p of pairs) {
    const k = p.k;
    const row = perNote[k];
    const e = (p.user - al.at(p.ref)) * 1000;
    row.onsetMs = e;
    const g = ctx.ornament[k] ? bell(e, ONSET_ORN_DEAD_MS, ONSET_ORN_SIGMA_MS) : bell(e, ONSET_DEAD_MS, ONSET_SIGMA_MS);
    row.onsetScore = round(100 * g, 1);
    onsetK.push(k);
    onsetE.push(e);
    onsetG.push(g);
    onsetW.push(ctx.ornament[k] ? ORNAMENT_WEIGHT : 1);
    if (e >= LATE_EARLY_MS) row.flags.push('late');
    else if (e <= -LATE_EARLY_MS) row.flags.push('early');
  }

  // durations: both ends must be sharp (start = transition onset; end = next note's transition onset, or the end of the voiced run)
  const endOf = new Map<number, { ref: number; user: number }>();
  for (const e of al.endPairs) endOf.set(e.k, e);
  const startOf = new Map<number, { ref: number; user: number }>();
  for (const p of pairs) startOf.set(p.k, p);
  for (const nm of al.notes) {
    const k = nm.k;
    const st = startOf.get(k);
    if (!nm.matched || !st) continue;
    const r = rn[k];
    if (r.end - r.start < 0.2) continue;
    const last = k === rn.length - 1;
    let e: { ref: number; user: number } | null = endOf.get(k) ?? null;
    if (!e) {
      // runs into the next note: the end is where the voice stops before it (a gap = a note cut short), else the next entrance
      const nx = rn[k + 1] && rn[k + 1].start - r.end < 0.08 ? startOf.get(k + 1) : undefined;
      if (nx) e = { ref: soundingEnd(ctx.ref, nx.ref), user: soundingEnd(ctx.att, nx.user) };
    }
    if (!e) continue;
    const dRef = e.ref - st.ref;
    const q = (e.user - st.user) / (al.tempo * dRef);
    if (!(dRef > 0.15) || !(q > 0)) continue;
    const row = perNote[k];
    row.durRatio = q;
    const g = bell(Math.log(q), DUR_DEAD, DUR_SIGMA);
    row.durScore = round(100 * g, 1);
    durK.push(k);
    durG.push(g);
    durW.push((last || ctx.ornament[k] ? ORNAMENT_WEIGHT : 1) * Math.min(1.5, Math.max(0.2, dRef)));
    const lim = Math.log(1.3);
    if (!last && Math.log(q) <= -lim) row.flags.push('short');
    else if (!last && Math.log(q) >= lim) row.flags.push('long');
  }

  const comps: ScoreComponent[] = [];
  const nOn = onsetG.length;
  const onsetScore = nOn >= 2 ? 100 * wmean(onsetG, onsetW) : null;
  const madMs = nOn >= 2 ? mad(onsetE) : null;
  comps.push({ id: 'timing.onsets', skill: 'timing', label: 'Note entrances', score: onsetScore, weight: TIMING_ONSET_WEIGHT, value: nOn >= 2 ? `${round(median(onsetE.map(Math.abs)), 0)} ms median offset` : undefined, n: nOn });
  const rho = al.tempo; // 1 = the speed the guide was played at (the reference is laid out at that speed)
  const tempoScore = al.tempoFitted && nOn >= 2 ? 100 * bell(Math.log(rho), TEMPO_DEAD, TEMPO_SIGMA) : null;
  comps.push({ id: 'timing.tempo', skill: 'timing', label: 'Tempo', score: tempoScore, weight: TIMING_TEMPO_WEIGHT, value: al.tempoFitted ? `${round(rho, 2)}x the reference tempo` : undefined, n: nOn });
  const durScore = durG.length >= 2 ? 100 * wmean(durG, durW) : null;
  comps.push({ id: 'timing.durations', skill: 'timing', label: 'Note lengths', score: durScore, weight: TIMING_DUR_WEIGHT, value: durG.length >= 2 ? `${round(median(durK.map((k) => Math.abs(Math.log(perNote[k].durRatio as number)))) * 100, 0)}% median length error` : undefined, n: durG.length });
  const score = nOn >= 2 ? combine(comps) : null;
  if (score === null) return { score: null, components: comps, insights, stats: { onsetPairs: nOn } };

  // ---- insights -----------------------------------------------------------------------------------------
  const cw = comps.reduce((a, c) => a + (c.score !== null ? c.weight : 0), 0);
  const onsetW2 = onsetW.reduce((a, b) => a + b, 0);
  const onsetLoss = (i: number): number => (TIMING_ONSET_WEIGHT / cw) * (onsetW[i] / onsetW2) * (1 - onsetG[i]) * 100;
  const nm = (k: number): string => `note ${k + 1} (${perNote[k].refName})`;
  const used = new Set<number>();

  if (tempoScore !== null && tempoScore < 80) {
    // rho is time per reference time (> 1 = longer = slower); the percentage is the change of SPEED, the same figure whichever way it went
    const pct = Math.round(Math.abs(1 / rho - 1) * 100);
    const slow = rho > 1;
    const word = ctx.mode === 'sing-along' ? (slow ? 'you fell behind the track' : 'you ran ahead of the track') : slow ? 'you dragged' : 'you rushed';
    insights.push({
      id: 'timing.tempo', skill: 'timing', kind: 'fix', title: slow ? 'Dragging' : 'Rushing',
      text: `Overall ${word}: your phrase ran about ${pct}% ${slow ? 'slower' : 'faster'} than the reference${ctx.rate !== 1 ? ' at this practice speed' : ''}.`,
      advice: slow ? 'Count the pulse and breathe on the reference\'s breaths; aim to land each long note a little sooner.' : 'Settle on the pulse: sing the long notes for their full length and take the reference\'s breaths.',
      lossSkill: (TIMING_TEMPO_WEIGHT / cw) * (100 - (tempoScore as number)), notes: [],
    });
  }
  const afterRest: number[] = [];
  const others: number[] = [];
  onsetK.forEach((k, i) => {
    const prevEnd = k > 0 ? rn[k - 1].end : -Infinity;
    (rn[k].start - prevEnd >= 0.25 ? afterRest : others).push(onsetE[i]);
  });
  const lateAfterRest = afterRest.length >= 2 && median(afterRest) >= 80 && (others.length === 0 || median(others) < 50);
  const earlyAfterRest = afterRest.length >= 2 && median(afterRest) <= -80 && (others.length === 0 || median(others) > -50);
  if (lateAfterRest || earlyAfterRest) {
    const ks = onsetK.filter((k) => k > 0 && rn[k].start - rn[k - 1].end >= 0.25);
    insights.push({
      id: 'timing.entrances', skill: 'timing', kind: 'fix', title: lateAfterRest ? 'Late after breaths' : 'Early after breaths',
      text: `You come in ${lateAfterRest ? 'late' : 'early'} after rests (about ${Math.round(Math.abs(median(afterRest)))} ms), while notes inside the phrase are on time.`,
      advice: lateAfterRest ? 'Take the breath earlier, during the rest, so the first note starts on the beat instead of after the inhale.' : 'Wait for the beat before the first note of each phrase; use the rest to breathe.',
      lossSkill: ks.reduce((a, k) => a + onsetLoss(onsetK.indexOf(k)), 0), notes: ks,
    });
    ks.forEach((k) => used.add(k));
  }
  const late = onsetK.filter((k, i) => !used.has(k) && onsetE[i] >= LATE_EARLY_MS);
  const early = onsetK.filter((k, i) => !used.has(k) && onsetE[i] <= -LATE_EARLY_MS);
  for (const [group, word] of [[late, 'late'], [early, 'early']] as const) {
    if (group.length === 0) continue;
    const ms = (k: number): number => Math.abs(onsetE[onsetK.indexOf(k)]);
    const worst = [...group].sort((a, b) => ms(b) - ms(a)).slice(0, 3);
    insights.push({
      id: `timing.${word}`, skill: 'timing', kind: 'fix', title: `${group.length === 1 ? 'A note' : `${group.length} notes`} ${word}`,
      text: `${group.length === 1 ? 'One note starts' : `${group.length} notes start`} ${word}: ${worst.map((k) => `${nm(k)} by ${Math.round(ms(k))} ms`).join('; ')}.`,
      advice: word === 'late' ? 'Listen for where the reference note begins relative to the one before and think the next note a beat early.' : 'The reference holds the previous note longer; wait a little before moving on.',
      lossSkill: group.reduce((a, k) => a + onsetLoss(onsetK.indexOf(k)), 0), notes: group,
    });
  }
  const shortK = durK.filter((k) => perNote[k].flags.includes('short'));
  const longK = durK.filter((k) => perNote[k].flags.includes('long'));
  const durW2 = durW.reduce((a, b) => a + b, 0);
  const durLoss = (k: number): number => {
    const i = durK.indexOf(k);
    return (TIMING_DUR_WEIGHT / cw) * (durW[i] / durW2) * (1 - durG[i]) * 100;
  };
  for (const [group, word] of [[shortK, 'short'], [longK, 'long']] as const) {
    if (group.length === 0) continue;
    const worst = [...group].sort((a, b) => Math.abs(Math.log(perNote[b].durRatio as number)) - Math.abs(Math.log(perNote[a].durRatio as number))).slice(0, 3);
    insights.push({
      id: `timing.${word}-notes`, skill: 'timing', kind: 'fix', title: word === 'short' ? 'Cutting notes short' : 'Holding notes too long',
      text: `${group.length === 1 ? 'One note was' : `${group.length} notes were`} ${word === 'short' ? 'cut short' : 'held too long'} compared with the reference: ${worst.map((k) => `${nm(k)} (${Math.round((perNote[k].durRatio as number) * 100)}% of its length)`).join('; ')}.`,
      advice: word === 'short' ? 'Keep the breath flowing to the end of long notes; release when the reference releases.' : 'Let go of the note where the reference lets go; the release is part of the phrasing.',
      lossSkill: group.reduce((a, k) => a + durLoss(k), 0), notes: group,
    });
  }
  if (score >= 88) {
    insights.push({ id: 'timing.good', skill: 'timing', kind: 'good', title: 'Timing', text: `Timing is tight: note entrances within ${Math.max(10, Math.round(median(onsetE.map(Math.abs)) / 10) * 10)} ms of the reference's rhythm${al.tempoFitted ? ' and the same tempo' : ''}.`, advice: '', lossSkill: 0, notes: [] });
  }
  return {
    score,
    components: comps,
    insights,
    stats: { onsetPairs: nOn, onsetMadMs: madMs === null ? null : round(madMs, 1), medianAbsOnsetMs: round(median(onsetE.map(Math.abs)), 1), tempoRatio: round(rho, 3) },
  };
}
