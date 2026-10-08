// What to tell the singer after an attempt: at most three prioritised fixes in plain words, relative to the original, each with
// a drill (an existing exercise from coach/exercises.ts chosen through the FIXES table of coach/coach.ts, or a slow loop of the
// weak region), and the plain-words sentence for each tone difference.
//
// The ranking is the score's own: the fixes are the scorer's `score.fixes`, ordered by the points each would gain
// (trainer/score/score.ts), so the order of the list always agrees with the score. This module only words them for the
// practice screen, finds the drill, and keeps the voice safe: it never coaches more rasp, more grit or more volume.

import { FIXES, type Flavour } from '../coach/coach';
import type { CoachingItem, Fix, NoteCompare, PhraseComparison, SkillKey, StyleKey, ToneFinding } from '../types';
import { fixEvidence } from './score/score';

export type FixCategory = 'pitch' | 'timing' | 'duration' | 'tone' | 'coverage' | 'tempo';

export interface TrainerFix {
  /** Stable id, as stored in AttemptRecord.fixIds: 'pitch-flat', 'wrong-notes', 'timing-late', 'tempo', 'duration-short', 'tone-breathiness', 'expr-vibrato', 'coverage', ... */
  id: string;
  /** The scorer's own id for the same fix ('pitch.flat', 'timing.late', 'tone.breathiness', 'expr.vibrato', 'coverage', ...). */
  scorerId: string;
  category: FixCategory;
  skill: SkillKey;
  /** Imperative, a few words. */
  title: string;
  /** What we heard, relative to the original, with numbers and note names in the singer's key. */
  evidence: string;
  /** One technique cue (safe: never "push", "louder" or "more grit"). */
  cue: string;
  /** Points of the 0-100 score this costs (the scorer's gainPoints). Ranks the fixes. */
  loss: number;
  /** Reference note indices (0-based) involved. */
  notes: number[];
  /** Reference-time region to loop for the drill (seconds in the phrase window), if the fix is local. */
  loop?: { from: number; to: number; rate: number };
  /** The first suggested exercise (an id from coach/exercises.ts). */
  exerciseId?: string;
  /** Up to two suggested exercises, the first one being exerciseId. */
  exerciseIds: string[];
}

/** At most this many fixes of one category, so the list is not three flavours of "flat". */
const MAX_PER_CATEGORY = 2;
/** A loop covering nearly the whole phrase is just the phrase: no local drill then. */
const LOOP_MAX_SHARE = 0.9;
const LOOP_RATE = 0.75;
const LOOP_PAD_SEC = 0.2;

const join = (xs: string[]): string => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const sign = (v: number): string => (v >= 0 ? '+' : '−');

/** The app speaks of "the original"; the scorer's findings say "the reference". */
export function inOriginalTerms(text: string): string {
  return text
    .replace(/\bThe reference's\b/g, "The original's")
    .replace(/\bthe reference's\b/g, "the original's")
    .replace(/\bThe reference\b/g, 'The original')
    .replace(/\bthe reference\b/g, 'the original')
    .replace(/\breference's\b/g, "original's");
}

// A cue that would send the singer the wrong way is replaced, not shown. (The sources are already written safely; this guards the future.)
const UNSAFE = /\b(louder|sing louder|more volume|push harder|power through|more rasp|more grit|add (some )?(rasp|grit)|squeeze)\b/i;
const SAFE_CUE = 'Keep it easy and relaxed, at a comfortable volume; if anything feels tight or scratchy, stop and rest your voice.';
export function safeCue(text: string): string {
  return UNSAFE.test(text) ? SAFE_CUE : text;
}

const LEGACY_IDS: Record<string, string> = {
  'pitch.wrong-notes': 'wrong-notes',
  'timing.tempo': 'tempo',
  'timing.short-notes': 'duration-short',
  'timing.long-notes': 'duration-long',
};

/** The stable id of a scorer fix: the dashed form the stored attempts and the screens have always used. */
export function trainerFixId(scorerId: string): string {
  return LEGACY_IDS[scorerId] ?? scorerId.replace(/\./g, '-');
}

export function categoryOf(id: string): FixCategory {
  if (id === 'coverage') return 'coverage';
  if (id === 'timing.tempo') return 'tempo';
  if (id === 'timing.short-notes' || id === 'timing.long-notes') return 'duration';
  if (id.startsWith('timing.')) return 'timing';
  if (id.startsWith('pitch.')) return 'pitch';
  return 'tone'; // tone.* and expr.* (vibrato, dynamics, note shaping) are the "how it sounds" fixes
}

// ---------------------------------------------------------------------------------------------
// Tone findings in plain words

type Dir = 'more' | 'less';

export interface ToneWords {
  /** Short heading, e.g. "Breathiness". */
  label: string;
  /** One sentence relative to the original, e.g. "Airier than the original". */
  text: string;
  /** How big: only for the indices that have a size ('a little' | 'clearly' | 'much'), else null. */
  size: 'a little' | 'clearly' | 'much' | null;
  /** True for findings that are low confidence or not coachable: shown as detail, never as a fix of their own. */
  detailOnly: boolean;
}

const sizeOf = (strength: number): ToneWords['size'] => (strength < 1.6 ? 'a little' : strength < 2.6 ? 'clearly' : 'much');

/** A tone difference (attempt minus original) in plain words. Normalised indices and vibrato only; never raw dB. */
export function toneWords(t: ToneFinding): ToneWords {
  const d = t.diff;
  switch (t.key) {
    case 'breathiness':
      return { label: 'Breathiness', size: sizeOf(t.strength), detailOnly: false, text: d > 0 ? 'Airier than the original' : 'Clearer and firmer than the original, which is airier here' };
    case 'brightness':
      return { label: 'Brightness', size: sizeOf(t.strength), detailOnly: false, text: d > 0 ? 'Brighter and more forward than the original' : 'Darker and more covered than the original' };
    case 'rasp':
      return { label: 'Rasp', size: sizeOf(t.strength), detailOnly: d < 0, text: d > 0 ? 'Grittier than the original' : "The original has an edge here; don't force it" };
    case 'vibratoPresence':
      return { label: 'Vibrato', size: null, detailOnly: false, text: d < 0 ? 'The original lets the long notes wobble into vibrato; yours stayed straight' : 'You added vibrato where the original holds a straight tone' };
    case 'vibratoStart':
      return { label: 'Vibrato start', size: null, detailOnly: false, text: `Vibrato starts about ${Math.abs(d).toFixed(1)} s ${d > 0 ? 'later' : 'earlier'} than in the original` };
    case 'vibratoRateHz':
      return { label: 'Vibrato speed', size: null, detailOnly: false, text: `Vibrato ${d > 0 ? 'faster' : 'slower'} than the original by ${Math.abs(d).toFixed(1)} Hz` };
    case 'vibratoExtentCents':
      return { label: 'Vibrato width', size: null, detailOnly: false, text: `Vibrato ${d > 0 ? 'wider' : 'narrower'} than the original by about ${Math.round(Math.abs(d))} cents` };
    case 'level':
      return {
        label: 'Loudness',
        size: null,
        detailOnly: d < 0,
        text:
          d > 0
            ? `Louder than the original on ${t.detail ?? 'some notes'} compared with the rest of your take; it stays softer there`
            : `Softer than the original on ${t.detail ?? 'some notes'} compared with the rest of your take; that is fine, there is no need to push to match`,
      };
    case 'onset': {
      const [a, b] = (t.detail ?? '').split('>');
      return { label: 'Phrase start', size: null, detailOnly: true, text: a && b ? `The original starts the phrase ${onsetWord(a)}; yours starts ${onsetWord(b)} (low confidence)` : 'The phrase start differs (low confidence)' };
    }
    case 'register': {
      const parts = (t.detail ?? '').split(',').filter(Boolean).slice(0, 3).map((p) => {
        const [note, change] = p.split(':');
        const [from, to] = (change ?? '').split('>');
        return `${note}: original ${from}, yours ${to}`;
      });
      return { label: 'Register', size: null, detailOnly: false, text: `Register differs${parts.length ? ` (${parts.join('; ')})` : ''}; register readings are an estimate` };
    }
  }
}

function onsetWord(type: string): string {
  return type === 'breathy' ? 'softly with air' : type === 'glottal' ? 'with a firm click' : 'cleanly';
}

// ---------------------------------------------------------------------------------------------
// Fixes

const nameList = (ns: NoteCompare[]): string => join(ns.slice(0, 3).map((n) => n.refName)) + (ns.length > 3 ? '…' : '');

function titleFor(f: Fix, c: PhraseComparison): string {
  const rows = f.notes.map((k) => c.notes[k]).filter((n): n is NoteCompare => n !== undefined);
  const diff = (key: ToneFinding['key']): number | undefined => c.tone.find((t) => t.key === key)?.diff;
  switch (f.id) {
    case 'coverage':
      return c.score.perNote.every((n) => !n.matched) ? 'Sing the whole phrase' : 'Finish the phrase';
    case 'pitch.wrong-notes':
      return rows.length === 1 ? `Check the note on ${rows[0].refName}` : 'Check the melody';
    case 'pitch.drift':
      return /flat/i.test(f.title) ? 'Stay up to the end' : 'Stay relaxed to the end';
    case 'pitch.height':
      return /sharp/i.test(f.title) ? 'Lighten the high notes' : 'Support the high notes';
    case 'pitch.leaps':
      return 'Land the leaps';
    case 'pitch.flat':
      return 'Lift the flat notes';
    case 'pitch.sharp':
      return 'Bring the sharp notes down';
    case 'timing.tempo':
      return /drag/i.test(f.title) ? 'Keep up with the track' : "Don't rush";
    case 'timing.entrances':
      return /late/i.test(f.title) ? 'Breathe earlier' : 'Wait for the beat';
    case 'timing.late':
      return 'Come in on time';
    case 'timing.early':
      return 'Hold back a touch';
    case 'timing.short-notes':
      return 'Hold the long notes longer';
    case 'timing.long-notes':
      return 'Let go sooner';
    case 'tone.breathiness':
      return (diff('breathiness') ?? (/air/i.test(f.title) ? 1 : -1)) > 0 ? 'Clear up the tone' : 'Let more air in';
    case 'tone.brightness':
      return (diff('brightness') ?? (/bright/i.test(f.title) && !/dark/i.test(f.title) ? 1 : -1)) > 0 ? 'Warm the sound' : 'Brighten the sound';
    case 'tone.rasp':
      return 'Clean up the edge';
    case 'tone.register':
      return 'Check the register';
    case 'expr.vibrato': {
      const presence = diff('vibratoPresence');
      if (presence !== undefined) return presence < 0 ? 'Add the vibrato' : 'Keep the long notes straight';
      const start = diff('vibratoStart');
      if (start !== undefined && diff('vibratoRateHz') === undefined && diff('vibratoExtentCents') === undefined) return start > 0 ? 'Start the vibrato sooner' : 'Let the note settle first';
      const rate = diff('vibratoRateHz');
      if (rate !== undefined) return rate > 0 ? 'Slow the vibrato' : 'Speed up the vibrato';
      const ext = diff('vibratoExtentCents');
      if (ext !== undefined) return ext > 0 ? 'Narrow the vibrato' : 'Widen the vibrato';
      const refVib = c.notes.filter((n) => n.refVibrato).length;
      const userVib = c.notes.filter((n) => n.userVibrato).length;
      return refVib > userVib ? 'Add the vibrato' : userVib > refVib ? 'Keep the long notes straight' : 'Match the vibrato';
    }
    case 'expr.scoops':
      return 'Shape the note starts and ends';
    case 'expr.dynamics':
      return 'Match the loudness shape';
    case 'expr.level-trend':
      return /fading/i.test(f.title) ? 'Keep the ends alive' : 'Stay level';
    case 'expr.attack':
      return 'Match the phrase start';
    case 'expr.runs':
      return 'Practise the run slowly';
    default:
      return f.title;
  }
}

/** The FIXES-table cell that fits a fix, or null when the table has nothing for it (pure timing, pitch, coverage). */
function drillCell(f: Fix, c: PhraseComparison): { key: StyleKey; dir: Dir } | null {
  const diff = (key: ToneFinding['key']): number | undefined => c.tone.find((t) => t.key === key)?.diff;
  switch (f.id) {
    case 'tone.breathiness':
      return { key: 'breathiness', dir: (diff('breathiness') ?? (/air/i.test(f.title) ? 1 : -1)) > 0 ? 'less' : 'more' };
    case 'tone.brightness':
      return { key: 'brightness', dir: (diff('brightness') ?? (/bright/i.test(f.title) && !/dark/i.test(f.title) ? 1 : -1)) > 0 ? 'less' : 'more' };
    case 'tone.rasp':
      return { key: 'rasp', dir: 'less' }; // only "more grit than the original" is ever a fix; a lack of grit is not coached
    case 'tone.register':
      return { key: 'mixInUpperRange', dir: 'more' };
    case 'expr.vibrato': {
      const presence = diff('vibratoPresence');
      if (presence !== undefined) return { key: 'vibratoPresence', dir: presence < 0 ? 'more' : 'less' };
      const rate = diff('vibratoRateHz');
      if (rate !== undefined) return { key: 'vibratoRateHz', dir: rate > 0 ? 'less' : 'more' };
      const ext = diff('vibratoExtentCents');
      if (ext !== undefined) return { key: 'vibratoExtentCents', dir: ext > 0 ? 'less' : 'more' };
      const start = diff('vibratoStart');
      if (start !== undefined) return { key: 'vibratoPresence', dir: start > 0 ? 'more' : 'less' };
      const refVib = c.notes.filter((n) => n.refVibrato).length;
      const userVib = c.notes.filter((n) => n.userVibrato).length;
      return refVib === userVib ? null : { key: 'vibratoPresence', dir: refVib > userVib ? 'more' : 'less' };
    }
    case 'expr.level-trend':
      return /louder|grows|getting/i.test(f.title) ? { key: 'loudnessClimbDbPerSemitone', dir: 'less' } : null; // never "get louder"
    case 'expr.attack': {
      const onset = c.tone.find((t) => t.key === 'onset');
      const [a, b] = (onset?.detail ?? '').split('>');
      if (!a || !b) return null;
      return { key: 'softOnsetRatio', dir: b === 'breathy' ? 'less' : a === 'breathy' ? 'more' : 'less' };
    }
    case 'expr.runs':
      return { key: 'agility', dir: 'more' };
    default:
      return null;
  }
}

const PITCH_DRILLS: Record<string, string[]> = {
  'pitch.wrong-notes': ['drone-tuning'],
  'pitch.flat': ['drone-tuning'],
  'pitch.sharp': ['drone-tuning'],
  'pitch.drift': ['drone-tuning'],
  'pitch.height': ['vowel-narrowing', 'drone-tuning'],
  'pitch.leaps': ['drone-tuning', 'octave-slide-wee-oo'],
};

function drillFor(f: Fix, c: PhraseComparison, flavour: Flavour): { cue?: string; exerciseIds: string[] } {
  const pitch = PITCH_DRILLS[f.id];
  if (pitch) return { exerciseIds: pitch };
  const cell = drillCell(f, c);
  const fix = cell ? FIXES[cell.key]?.[cell.dir] : undefined;
  if (!fix) return { exerciseIds: [] };
  const ids = [...(fix.singerExercises?.[flavour] ?? []), ...fix.exercises];
  return { cue: fix.singerCues?.[flavour]?.[0] ?? fix.cues[0], exerciseIds: ids.filter((id, i) => ids.indexOf(id) === i).slice(0, 2) };
}

function loopFor(f: Fix, c: PhraseComparison): TrainerFix['loop'] {
  if (f.id === 'timing.tempo' || f.notes.length === 0 || (f.skill !== 'pitch' && f.skill !== 'timing')) return undefined;
  const rows = f.notes.map((k) => c.notes[k]).filter((n): n is NoteCompare => n !== undefined);
  if (rows.length === 0) return undefined;
  const from = Math.max(0, Math.min(...rows.map((n) => n.refStart)) - LOOP_PAD_SEC);
  const to = Math.max(...rows.map((n) => n.refEnd)) + LOOP_PAD_SEC;
  const first = Math.min(...c.notes.map((n) => n.refStart));
  const last = Math.max(...c.notes.map((n) => n.refEnd));
  if (to - from >= LOOP_MAX_SHARE * (last - first)) return undefined;
  return { from, to, rate: LOOP_RATE };
}

/** The tone findings (plain words) that belong to a fix id, in order of strength. */
const FINDINGS_FOR: Record<string, ToneFinding['key'][]> = {
  'tone.breathiness': ['breathiness'],
  'tone.brightness': ['brightness'],
  'tone.rasp': ['rasp'],
  'tone.register': ['register'],
  'expr.vibrato': ['vibratoPresence', 'vibratoStart', 'vibratoRateHz', 'vibratoExtentCents'],
  'expr.dynamics': ['level'],
  'expr.level-trend': ['level'],
  'expr.attack': ['onset'],
};

/** Evidence for a fix when the scorer attached no text: the tone finding in words, or the numbers from the note table. */
function evidenceFallback(f: Fix, c: PhraseComparison): string {
  const keys = FINDINGS_FOR[f.id];
  if (keys) {
    const finding = c.tone.find((t) => keys.includes(t.key));
    if (finding) return `${toneWords(finding).text}.`;
  }
  const rows = f.notes.map((k) => c.notes[k]).filter((n): n is NoteCompare => n !== undefined && n.matched);
  if (rows.length === 0) return inOriginalTerms(f.advice);
  if (f.skill === 'pitch') {
    return `${join(rows.slice(0, 3).map((n) => `On ${n.refName} you sang ${n.userName ?? 'a different note'} (${sign(n.cents ?? 0)}${Math.round(Math.abs(n.cents ?? 0))} cents)`))}.`;
  }
  if (f.skill === 'timing') return `${nameList(rows)} differed from the original in timing.`;
  return inOriginalTerms(f.advice);
}

function trainerFix(f: Fix, c: PhraseComparison, flavour: Flavour): TrainerFix {
  const drill = drillFor(f, c, flavour);
  const loop = loopFor(f, c);
  const text = fixEvidence(c.score, f.id);
  return {
    id: trainerFixId(f.id),
    scorerId: f.id,
    category: categoryOf(f.id),
    skill: f.skill,
    title: titleFor(f, c),
    evidence: text ? inOriginalTerms(text) : evidenceFallback(f, c),
    cue: safeCue(inOriginalTerms(drill.cue ?? f.advice)),
    loss: f.gainPoints,
    notes: [...f.notes],
    ...(loop ? { loop } : {}),
    ...(drill.exerciseIds.length > 0 ? { exerciseId: drill.exerciseIds[0] } : {}),
    exerciseIds: drill.exerciseIds,
  };
}

/**
 * The most useful fixes for this attempt, at most `maxFixes` (default 3) and at most two of one category, in the order of the
 * points each would gain. Nothing is returned when the score itself is not to be believed (no match, too little singing,
 * the reference leaked into the microphone), because advice about a take that was not measured would only mislead.
 */
export function buildFixes(c: PhraseComparison, flavour: Flavour = 'generic', maxFixes = 3): TrainerFix[] {
  if (c.score.status !== 'ok' || c.score.trust.level === 'invalid') return [];
  const out: TrainerFix[] = [];
  const perCategory = new Map<FixCategory, number>();
  for (const f of c.score.fixes) {
    const category = categoryOf(f.id);
    if ((perCategory.get(category) ?? 0) >= MAX_PER_CATEGORY) continue;
    perCategory.set(category, (perCategory.get(category) ?? 0) + 1);
    out.push(trainerFix(f, c, flavour));
    if (out.length >= maxFixes) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Adapter to the existing coaching card

const DIMENSION: Record<string, CoachingItem['dimension']> = {
  'tone.breathiness': 'breathiness',
  'tone.brightness': 'brightness',
  'tone.rasp': 'rasp',
  'tone.register': 'mixInUpperRange',
  'expr.vibrato': 'vibratoPresence',
  'expr.level-trend': 'loudnessClimbDbPerSemitone',
  'expr.dynamics': 'dynamicRangeDb',
  'expr.attack': 'softOnsetRatio',
  'expr.runs': 'agility',
};

function whyItMatters(f: TrainerFix): string {
  const pts = f.loss >= 9.5 ? Math.round(f.loss) : Math.round(f.loss * 10) / 10;
  const worth = `Fixing this is worth about ${pts} point${pts === 1 ? '' : 's'} of your score.`;
  return f.category === 'tone' ? `${worth} Tone readings are estimates and shift a little with your microphone and key.` : worth;
}

/** The fix as a CoachingItem, so the existing CoachingItemCard can show it. `rank` is 0 for the first fix. */
export function fixToCoachingItem(f: TrainerFix, rank = 0): CoachingItem {
  return {
    id: f.id,
    priority: Math.max(1, Math.min(3, rank + 1)) as CoachingItem['priority'],
    dimension: DIMENSION[f.scorerId] ?? (f.category === 'pitch' ? 'pitchAccuracyCents' : 'recording'),
    title: f.title,
    whatWeHeard: f.evidence,
    whyItMatters: whyItMatters(f),
    howToFix: f.cue ? [f.cue] : [],
    exerciseIds: f.exerciseIds,
  };
}

/** "Loop 1.8–3.4 s at 75%". */
export function loopLabel(loop: NonNullable<TrainerFix['loop']>): string {
  return `Loop ${loop.from.toFixed(1)}–${loop.to.toFixed(1)} s at ${Math.round(loop.rate * 100)}%`;
}
