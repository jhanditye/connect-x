// Pitch skill: note view (median error over each reference note's aligned frames) + contour view (every aligned frame).
// Both read the same per-bin errors from the contour DTW, so neither depends on how either take happened to be segmented into notes.
//
//   e        = (attemptPitch - referencePitch - T) * 100 - delta         cents, octave-folded, vibrato-free centre lines,
//                                                                         delta = constant detune ('free' key mode only)
//   noteG_k  = bell(median_k e, 10, 30)           ornaments: bell(., 25, 60);  octave-displaced note keeps 60 %
//   frameG   = bell(e, 15, 40)                    mean over the note's bins
//   pitch    = 100 * (0.6 * sum(w_k noteG_k)/sum(w_k) + 0.4 * sum(w_k frameG_k)/sum(w_k)),   w_k = max(dur_k, 0.15 s) * (ornament ? 0.4 : 1)
//
// Speech-like phrases: pitch = shape correlation of the two contours (+ a range check), not note accuracy.

import { median } from '../../dsp/stats';
import { midiName } from './contour';
import {
  OCTAVE_DISPLACED_CREDIT, OFF_CENTS, ORNAMENT_WEIGHT, PITCH_FRAME_DEAD, PITCH_FRAME_SIGMA, PITCH_FRAME_WEIGHT, PITCH_NOTE_DEAD, PITCH_NOTE_SIGMA,
  PITCH_NOTE_WEIGHT, PITCH_ORN_DEAD, PITCH_ORN_SIGMA, WRONG_NOTE_CENTS,
} from './constants';
import { combine, type Ctx, type Insight, type SkillResult } from './ctx';
import type { NoteFlag, ScoreComponent } from './types';
import { bell, pearson, round, theilSen, wmean } from './util';

export function noteWeight(ctx: Ctx, k: number): number {
  const r = ctx.ref.a.notes[k];
  return Math.max(r.end - r.start, 0.15) * (ctx.ornament[k] ? ORNAMENT_WEIGHT : 1);
}

export function scorePitch(ctx: Ctx): SkillResult {
  if (ctx.speech) return scoreSpeechPitch(ctx);
  const { al, perNote } = ctx;
  const rn = ctx.ref.a.notes;
  const K = rn.length;
  const noteG: (number | null)[] = new Array(K).fill(null);
  const contG: (number | null)[] = new Array(K).fill(null);
  const cents: (number | null)[] = new Array(K).fill(null);

  for (const nm of al.notes) {
    const k = nm.k;
    const row = perNote[k];
    row.refName = midiName(al.refPitch[k] + al.teff);
    if (!nm.matched || !Number.isFinite(nm.err)) continue; // stays flagged 'missed'
    const c = nm.err;
    const displaced = nm.octaves !== 0 && Math.abs(c) <= 80;
    const far = Math.abs(c) >= WRONG_NOTE_CENTS || nm.octaves !== 0;
    // In a rough guide a note the take answers with a pitch far from it is more likely the band's note than the singer's mistake: it is
    // treated as a note the take did not sing (neither credited nor charged), not as a wrong note.
    if ((ctx.rough || ctx.doubtful.has(k)) && far && !displaced) continue; // stays flagged 'missed'
    row.matched = true;
    row.userName = Number.isFinite(nm.userPitch) ? midiName(nm.userPitch) : null;
    row.cents = c;
    row.semitones = Number.isFinite(nm.userPitch) ? round(nm.userPitch - (al.refPitch[k] + al.teff), 1) : null;
    const flags: NoteFlag[] = [];
    if (ctx.ornament[k]) flags.push('ornament');
    // A run note or very short note is "judged loosely" (see expression.ts): far off, it is flat or sharp, never a wrong note.
    if (displaced) flags.push('octave-displaced');
    else if (far && !ctx.ornament[k]) flags.push('wrong-note');
    else if (c <= -OFF_CENTS) flags.push('flat');
    else if (c >= OFF_CENTS) flags.push('sharp');
    row.flags = flags;
    cents[k] = c;
    let g = ctx.ornament[k] ? bell(c, PITCH_ORN_DEAD, PITCH_ORN_SIGMA) : bell(c, PITCH_NOTE_DEAD, PITCH_NOTE_SIGMA);
    if (displaced) g *= OCTAVE_DISPLACED_CREDIT;
    noteG[k] = g;
    row.pitchScore = round(100 * g, 1);
    if (nm.binErr.length >= 2) {
      const gs = nm.binErr.map((e, i) => {
        let gg = ctx.ornament[k] ? bell(e, PITCH_ORN_DEAD, PITCH_ORN_SIGMA) : bell(e, PITCH_FRAME_DEAD, PITCH_FRAME_SIGMA);
        if (nm.binOct[i] !== 0) gg *= Math.abs(e) <= 80 ? OCTAVE_DISPLACED_CREDIT : 0;
        return gg;
      });
      contG[k] = gs.reduce((a, b) => a + b, 0) / gs.length;
      row.contourScore = round(100 * contG[k], 1);
    }
  }

  const idx = noteG.map((g, k) => (g !== null ? k : -1)).filter((k) => k >= 0);
  if (idx.length === 0) return { score: null, components: [], insights: [], stats: {} };
  const w = idx.map((k) => noteWeight(ctx, k));
  const noteScore = 100 * wmean(idx.map((k) => noteG[k] as number), w);
  const cidx = idx.filter((k) => contG[k] !== null);
  const contourScore = cidx.length ? 100 * wmean(cidx.map((k) => contG[k] as number), cidx.map((k) => noteWeight(ctx, k))) : null;
  const abs = idx.map((k) => Math.abs(cents[k] as number));
  const comps: ScoreComponent[] = [
    { id: 'pitch.notes', skill: 'pitch', label: 'Note pitch', score: noteScore, weight: PITCH_NOTE_WEIGHT, value: `${round(median(abs), 0)} cents median error`, n: idx.length },
    { id: 'pitch.contour', skill: 'pitch', label: 'Pitch contour', score: contourScore, weight: PITCH_FRAME_WEIGHT, value: contourScore === null ? undefined : 'vibrato removed', n: cidx.length },
  ];
  const score = combine(comps) as number;

  // ---- insights ------------------------------------------------------------------------------------------
  const insights: Insight[] = [];
  const totalW = w.reduce((a, b) => a + b, 0);
  const cw = comps.reduce((a, c) => a + (c.score !== null ? c.weight : 0), 0);
  const cwt = cidx.reduce((a, kk) => a + noteWeight(ctx, kk), 0);
  const noteLoss = (k: number): number => {
    let l = (PITCH_NOTE_WEIGHT / cw) * (noteWeight(ctx, k) / totalW) * (1 - (noteG[k] as number)) * 100;
    if (contG[k] !== null && contourScore !== null) l += (PITCH_FRAME_WEIGHT / cw) * (noteWeight(ctx, k) / cwt) * (1 - (contG[k] as number)) * 100;
    return l;
  };
  const consumed = new Set<number>();
  const nm = (k: number): string => `note ${k + 1} (${perNote[k].refName})`;
  const list = (ks: number[]): string => (ks.length <= 3 ? ks.map(nm).join(', ') : `${ks.slice(0, 3).map(nm).join(', ')} and ${ks.length - 3} more`);

  const wrong = idx.filter((k) => perNote[k].flags.includes('wrong-note'));
  if (wrong.length) {
    wrong.forEach((k) => consumed.add(k));
    // The words come from the measured error (the same number that raised the flag), never from a second reading of the take.
    const semis = (k: number): number => Math.sign(cents[k] as number) * Math.max(1, Math.round(Math.abs(cents[k] as number) / 100));
    const sungAs = (k: number): string | null => {
      const u = al.notes[k].userPitch;
      const d = Number.isFinite(u) ? Math.round(u - (al.refPitch[k] + al.teff)) : NaN;
      return perNote[k].userName !== null && d === semis(k) ? perNote[k].userName : null;
    };
    const parts = wrong.slice(0, 3).map((k) => {
      const n = Math.abs(semis(k));
      const how = `${n === 1 ? 'about a semitone' : `about ${n} semitones`} ${semis(k) > 0 ? 'above' : 'below'} it`;
      const name = sungAs(k);
      return `${nm(k)}: ${name ? `you sang ${name}, ` : 'you were '}${how}`;
    });
    insights.push({
      id: 'pitch.wrong-notes', skill: 'pitch', kind: 'fix', title: wrong.length === 1 ? 'A wrong note' : `${wrong.length} wrong notes`,
      text: `Wrong pitch on ${wrong.length === 1 ? 'one note' : `${wrong.length} notes`}. ${parts.join('; ')}.`,
      advice: 'Play the reference note, hum it quietly, then sing it again: land on the pitch softly before adding words.',
      lossSkill: wrong.reduce((a, k) => a + noteLoss(k), 0), notes: wrong,
    });
  }
  const disp = idx.filter((k) => perNote[k].flags.includes('octave-displaced'));
  if (disp.length) {
    disp.forEach((k) => consumed.add(k));
    insights.push({
      id: 'pitch.octave', skill: 'pitch', kind: 'info', title: 'Octave-displaced notes',
      text: `${list(disp)} ${disp.length === 1 ? 'was' : 'were'} sung an octave away from the rest of the line. The note name is right; that is fine if it was out of your range.`,
      advice: 'If it is within your range, try the note in the line\'s octave in a lighter, mixed sound.',
      lossSkill: disp.reduce((a, k) => a + noteLoss(k), 0), notes: disp,
    });
  }
  const live = idx.filter((k) => !consumed.has(k));
  // drift over time
  if (live.length >= 5) {
    const xs = live.map((k) => rn[k].start);
    const span = xs[xs.length - 1] - xs[0];
    if (span >= 2) {
      const f = theilSen(xs, live.map((k) => cents[k] as number));
      const total = f.slope * span;
      if (Math.abs(total) >= 30) {
        const involved = live.filter((k) => Math.sign(cents[k] as number) === Math.sign(total) && Math.abs(cents[k] as number) >= OFF_CENTS);
        if (involved.length >= 3) {
          involved.forEach((k) => consumed.add(k));
          insights.push({
            id: 'pitch.drift', skill: 'pitch', kind: 'fix', title: total < 0 ? 'Going flat over the phrase' : 'Creeping sharp over the phrase',
            text: `Your pitch drifted ${total < 0 ? 'flat' : 'sharp'} by about ${Math.round(Math.abs(total))} cents between the first and last note.`,
            advice: total < 0 ? 'Keep the breath steady to the end of the line and aim the last notes slightly higher; check you are not running out of air.' : 'Stay relaxed as the phrase goes on; do not lean into the later notes.',
            lossSkill: involved.reduce((a, k) => a + noteLoss(k), 0), notes: involved,
          });
        }
      }
    }
  }
  // error vs pitch height
  const live2 = live.filter((k) => !consumed.has(k));
  if (live2.length >= 5) {
    const hs = live2.map((k) => al.refPitch[k]);
    const range = Math.max(...hs) - Math.min(...hs);
    if (range >= 5) {
      const f = theilSen(hs, live2.map((k) => cents[k] as number), 0.5);
      const eff = f.slope * range;
      if (Math.abs(eff) >= 35) {
        const med = median(hs);
        // notes the pattern explains: sharp above the middle of the range, or flat below it
        const hi = live2.filter((k) => Math.sign(cents[k] as number) === Math.sign(eff) * Math.sign(al.refPitch[k] - med) && Math.abs(cents[k] as number) >= OFF_CENTS);
        if (hi.length >= 2) {
          hi.forEach((k) => consumed.add(k));
          insights.push({
            id: 'pitch.height', skill: 'pitch', kind: 'fix', title: eff > 0 ? 'Sharp on the high notes' : 'Flat on the high notes',
            text: `You went ${eff > 0 ? 'sharp' : 'flat'} as the line climbs (about ${Math.round(Math.abs(eff))} cents across the range). Worst on ${list(hi)}.`,
            advice: eff > 0 ? 'On the higher notes lighten the sound and think "narrower vowel, less weight"; pushing up in volume pulls the pitch sharp.' : 'On the higher notes keep the support and the vowel narrow; they go flat when the sound gets heavy or the jaw tightens.',
            lossSkill: hi.reduce((a, k) => a + noteLoss(k), 0), notes: hi,
          });
        }
      }
    }
  }
  // leaps
  const leapUnder: number[] = [];
  const leapErr: number[] = [];
  for (let a = 0; a + 1 < idx.length; a++) {
    const k0 = idx[a];
    const k1 = idx[a + 1];
    if (k1 !== k0 + 1 || consumed.has(k1)) continue;
    const interval = al.refPitch[k1] - al.refPitch[k0];
    if (Math.abs(interval) < 4) continue;
    const extra = ((cents[k1] as number) - (cents[k0] as number)) * Math.sign(interval);
    leapErr.push(extra);
    if (extra <= -OFF_CENTS) leapUnder.push(k1);
  }
  if (leapUnder.length >= 2 && median(leapErr) <= -20) {
    leapUnder.forEach((k) => consumed.add(k));
    insights.push({
      id: 'pitch.leaps', skill: 'pitch', kind: 'fix', title: 'Undershooting the leaps',
      text: `Your leaps are narrower than the reference's (${list(leapUnder)} landed short by about ${Math.round(Math.abs(median(leapErr)))} cents).`,
      advice: 'Hear the target note before the jump, breathe in for it, and aim a touch above it, then relax onto the pitch (a small siren or octave-glide drill helps).',
      lossSkill: leapUnder.reduce((a, k) => a + noteLoss(k), 0), notes: leapUnder,
    });
  }
  // remaining off-pitch notes
  const rest = idx.filter((k) => !consumed.has(k) && (perNote[k].flags.includes('flat') || perNote[k].flags.includes('sharp')));
  for (const [group, word] of [[rest.filter((k) => perNote[k].flags.includes('flat')), 'flat'], [rest.filter((k) => perNote[k].flags.includes('sharp')), 'sharp']] as const) {
    if (group.length === 0) continue;
    const worst = [...group].sort((a, b) => Math.abs(cents[b] as number) - Math.abs(cents[a] as number)).slice(0, 3);
    insights.push({
      id: `pitch.${word}`, skill: 'pitch', kind: 'fix', title: `${group.length === 1 ? 'A note' : `${group.length} notes`} ${word}`,
      text: `${group.length === 1 ? 'One note was' : `${group.length} notes were`} ${word}: ${worst.map((k) => `${nm(k)} by ${Math.round(Math.abs(cents[k] as number))} cents`).join('; ')}.`,
      advice: word === 'flat' ? 'Support the note through to its end and think "up and over" the pitch; slow the phrase to half speed and check each long note with a tuner.' : 'Ease the weight off; sharp notes usually come from pushing. Sing them lighter and a little rounder.',
      lossSkill: group.reduce((a, k) => a + noteLoss(k), 0), notes: group,
    });
  }
  const within25 = idx.filter((k) => Math.abs(cents[k] as number) <= 25).length / idx.length;
  if (score >= 88) {
    insights.push({ id: 'pitch.good', skill: 'pitch', kind: 'good', title: 'Pitch', text: `Pitch is accurate: ${Math.round(within25 * 100)}% of the notes within 25 cents of the reference${ctx.keyMode === 'free' && al.teff !== 0 ? ` (in your own key, ${Math.abs(al.teff)} semitone${Math.abs(al.teff) === 1 ? '' : 's'} ${al.teff < 0 ? 'below' : 'above'})` : ''}.`, advice: '', lossSkill: 0, notes: [] });
  }
  return {
    score,
    components: comps,
    insights,
    stats: {
      meanAbsCents: round(abs.reduce((a, b) => a + b, 0) / abs.length, 1),
      medianAbsCents: round(median(abs), 1),
      within25,
      within50: idx.filter((k) => Math.abs(cents[k] as number) <= 50).length / idx.length,
      matchedNotes: idx.length,
    },
  };
}

// -------------------------------------------------------------------------------------------------------------------
// Speech-like phrases: the melody is loose, so judge the SHAPE of the intonation (correlation of the two aligned contours)
// and the pitch range, not the notes.

function scoreSpeechPitch(ctx: Ctx): SkillResult {
  const { al, perNote } = ctx;
  const rs: number[] = [];
  const us: number[] = [];
  for (const nm of al.notes) {
    if (!nm.matched) continue;
    perNote[nm.k].matched = true;
    perNote[nm.k].refName = midiName(al.refPitch[nm.k] + al.teff);
    perNote[nm.k].flags = ['ok' as NoteFlag];
    nm.mappedBins.forEach((i, n) => {
      // reference pitch and the attempt's aligned pitch, both in semitones (offset-free for the correlation)
      const r = al.refC.m[i];
      rs.push(r);
      us.push(r + nm.binErr[n] / 100);
    });
  }
  if (rs.length < 20) return { score: null, components: [], insights: [], stats: {} };
  const rho = pearson(rs, us);
  const sd = (xs: number[]): number => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };
  const ratio = sd(us) / Math.max(0.3, sd(rs));
  const shape = Number.isFinite(rho) ? Math.max(0, Math.min(1, (rho - 0.2) / 0.7)) : 0;
  const rangeOk = ratio >= 0.5 && ratio <= 2 ? 1 : 0.85;
  const comps: ScoreComponent[] = [
    { id: 'pitch.shape', skill: 'pitch', label: 'Intonation shape', score: 100 * shape, weight: 0.8, value: `correlation ${round(rho, 2)}`, n: Math.round(rs.length / 10) },
    { id: 'pitch.range', skill: 'pitch', label: 'Pitch range', score: 100 * rangeOk, weight: 0.2, value: `${round(ratio, 2)}x the reference's spread`, n: Math.round(rs.length / 10) },
  ];
  const score = combine(comps) as number;
  const insights: Insight[] = [];
  if (shape < 0.7) {
    insights.push({
      id: 'pitch.shape', skill: 'pitch', kind: 'fix', title: 'Intonation shape differs',
      text: 'The rise and fall of your voice differs from the reference (this phrase is speech-like, so only its melody shape is compared, not exact notes).',
      advice: 'Mark where the reference lifts and where it drops, then exaggerate those two moves slowly before speeding up.',
      lossSkill: 0.8 * (100 - 100 * shape), notes: [],
    });
  }
  if (ratio < 0.5) insights.push({ id: 'pitch.flat-speech', skill: 'pitch', kind: 'fix', title: 'Flatter than the reference', text: 'Your melody is flatter than the reference\'s: it moves over a much narrower pitch range.', advice: 'Let the voice move more on the stressed syllables; keep it relaxed.', lossSkill: 3, notes: [] });
  return { score, components: comps, insights, stats: { correlation: round(rho, 3), rangeRatio: round(ratio, 2) } };
}
