// What happens around one take of the real practice engine (trainer/practiceEngine.ts), kept as small pure pieces so they can be
// tested without audio: cutting the count-in off the recording, the stored AttemptRecord, the notices that go with a result
// (speaker bleed, unclear key, gated takes), the words for every interruption and failure, and the live-pitch helpers.
//
// Every message here names the next step. Nothing here touches the microphone, the clock or the store.

import type { InterruptReason, RouteInfo, TakeResult } from '../audio/duplex';
import { RecorderError } from '../audio/recorder';
import type { Flavour } from '../coach/coach';
import type { AttemptNoteSummary, AttemptRecord, KeyMode, PhraseComparison, PlayMode, StyleVector } from '../types';
import { inOriginalTerms, type TrainerFix } from './feedback';
import type { ClickProbe } from './latency';
import { TRAINER_ANALYSIS_VERSION } from './phraseAnalysis';

// ---------------------------------------------------------------------------------------------
// The take

/** The count-in plays at this tempo (there is no per-phrase tempo yet). */
export const COUNT_IN_BPM = 100;
/** How long the recording keeps listening after the guide's last sample in sing-along. */
export const SING_ALONG_TAIL_SEC = 0.5;
/** Sing-along: this much of the recording before the guide's start is kept (a singer who knows the song comes in early); the clicks are further back. */
export const LEAD_KEEP_SEC = 0.3;

export interface TrimmedTake {
  samples: Float32Array;
  sampleRate: number;
  /** Where the guide's first sample sits in `samples` (sing-along); undefined in turn-taking. */
  refStartSec: number | undefined;
  /** Seconds removed from the front of the recording. */
  cutSec: number;
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * The part of the recording that is the singer. Sing-along: the room tone and the count-in clicks before the guide are cut (a
 * click that leaks into the microphone would read as a note), keeping LEAD_KEEP_SEC before the guide. Turn-taking: everything up to the
 * end of the guide is the guide leaking in, not the singer, so it is cut. `refStartSec` is re-based to the cut recording.
 */
export function trimTake(take: Pick<TakeResult, 'samples' | 'sampleRate' | 'refStartInCaptureSec' | 'guideEndInCaptureSec'>, mode: PlayMode): TrimmedTake {
  const sr = take.sampleRate;
  let cut = 0;
  if (mode === 'sing-along' && finite(take.refStartInCaptureSec)) cut = Math.max(0, take.refStartInCaptureSec - LEAD_KEEP_SEC);
  else if (mode === 'turn-taking' && finite(take.guideEndInCaptureSec)) cut = Math.max(0, take.guideEndInCaptureSec);
  const from = Math.min(take.samples.length, Math.max(0, Math.round(cut * sr)));
  const cutSec = from / sr;
  return {
    samples: from === 0 ? take.samples : take.samples.slice(from),
    sampleRate: sr,
    refStartSec: mode === 'sing-along' && finite(take.refStartInCaptureSec) ? take.refStartInCaptureSec - cutSec : undefined,
    cutSec,
  };
}

/** Beats left to show for the count-in `elapsedSec` after the take started (the first click is PRE_ROLL later). 1..beats. */
export function countInDisplay(elapsedSec: number, beats: number, preRollSec: number, beatSec: number): number {
  const clicksPlayed = Math.floor((elapsedSec - preRollSec) / beatSec);
  return Math.max(1, Math.min(beats, beats - Math.max(0, clicksPlayed)));
}

// ---------------------------------------------------------------------------------------------
// Live pitch

/** `midi` moved by whole octaves to the one nearest `target`: a singer an octave below the guide still lines up on the strip. */
export function octaveFold(midi: number, target: number): number {
  return midi + 12 * Math.round((target - midi) / 12);
}

/** Median of the last few readings: a single-frame YIN can flick an octave. null readings count as unvoiced and win when they are the majority. */
export function medianOfRecent(values: (number | null)[]): number | null {
  const voiced = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (voiced.length * 2 <= values.length) return null;
  return voiced[Math.floor(voiced.length / 2)];
}

// ---------------------------------------------------------------------------------------------
// Words

const semis = (n: number): string => (n === 0 ? 'the original key' : `${Math.abs(n)} semitone${Math.abs(n) === 1 ? '' : 's'} ${n < 0 ? 'below' : 'above'} the original`);

export const COPY = {
  noMatch: 'That take did not match this phrase closely enough to score, so it was not counted. Check you are singing the phrase shown, get a little closer to the microphone, and try again.',
  referenceTooShort: 'This phrase has too little singing in it to score against (it needs at least two notes and a second of voice), so the take was not counted. Edit the clip\'s phrases to take in more of the singing, or pick another phrase.',
  lowEvidence: 'There was not enough clear singing in that take to score it, so it was not counted. Sing the whole phrase a little louder and try again.',
  nothingHeard: 'I could not hear any singing in that take, so it was not scored. Check the microphone is not covered, sing a little louder or closer, and try again.',
  bleedSuspect: 'This take sounded like the playback, not like you, so it was not counted. Wear headphones, or switch to Listen then sing, and try again.',
  speakerBleed: 'The track was audible in your microphone, so this score could be measuring the playback instead of you. It was not counted. Use headphones, or switch to Listen then sing, and try again.',
  leakCaution: 'A little of the track leaks into your microphone, so the headphones may not be sealing. The score is probably fine; if it looks too good to be true, press them in or use Listen then sing.',
  gap: 'The recording had a gap in it (the phone was busy), so this take was not scored. Close other apps that use sound or the microphone, then tap Sing again.',
  empty: 'Nothing was recorded, so this take was not scored. Tap Sing to try again; if it keeps happening, check the microphone in Settings.',
  noSpeaker: 'Sing along needs headphones and none were detected, so Mimic switched to Listen then sing. Tap Sing to go on, or choose Sing along again to try it anyway.',
  cancelled: 'Take cancelled. Nothing was scored. Tap Sing to try again.',
  audioBusy: 'The sound could not start, because a call, Siri or another app is using the audio. Finish that or close the app, then tap Listen again.',
  unclearKey: (last: number, now: number): string =>
    `I could not tell which key you were singing in (${semis(last)} last time, ${semis(now)} this time) and only part of the phrase matched. Try again, or pick a guide key that suits your voice.`,
  notSaved: (why: string): string => `Your score could not be saved (${why}). Export a backup from Settings if this keeps happening, then try again.`,
  guideFailed: (why: string): string => `The slowed or transposed guide could not be prepared (${why}). Choose 100% speed and the original key, or tap Listen to try again.`,
  openFailed: (why: string): string => `This phrase could not be prepared (${why}). Go back to the clip and open the phrase again.`,
  analysisFailed: (why: string): string => `That take could not be analysed (${why}). Tap Sing to try again.`,
  playbackFailed: (why: string): string => `Playback did not start (${why}). Tap Listen to try again.`,
  noAudioApi: 'This browser cannot play audio here. Open Mimic in Safari or add it to your Home Screen, then try again.',
} as const;

/** The message for an interruption, in the words of what was interrupted. Always says what to tap next. */
export function interruptionMessage(reason: InterruptReason | null | undefined, what: 'take' | 'playback'): string {
  const take = what === 'take';
  const stopped = take ? 'this take was stopped and not scored' : 'the playback stopped';
  const again = take ? 'tap Sing to try again' : 'tap Listen to hear it again';
  switch (reason) {
    case 'hidden':
      return `Mimic went to the background, so ${stopped}. Keep Mimic open${take ? ' while you sing' : ''}, then ${again}.`;
    case 'mic-ended':
      return `The microphone stopped (it was unplugged, or another app took it), so ${stopped}. Check it is connected, then ${again}; Mimic will ask for it again.`;
    case 'device-change':
      return `Your headphones or microphone changed, so ${stopped}. Check the input shown above, then ${again}.`;
    case 'no-audio':
      return `No sound came from the microphone, so ${stopped}. Check that Mimic is allowed to use it (Settings, then Mimic or Safari, then Microphone), then ${again}.`;
    case 'audio-session':
    default:
      return `A call, alarm or another app interrupted the audio, so ${stopped}. When you are ready, ${again}.`;
  }
}

/** A microphone failure in plain words; permission and device problems say that Listen still works. */
export function microphoneMessage(err: unknown): string {
  if (err instanceof RecorderError) {
    return err.kind === 'unsupported' ? err.message : `${err.message} You can still tap Listen to hear the phrase.`;
  }
  const why = err instanceof Error && err.message ? err.message : 'unknown reason';
  return `The microphone could not be started (${why}). Check it in Settings, then tap Sing to try again. You can still tap Listen.`;
}

export function reasonOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'unknown reason';
}

export function isAbort(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError';
}

// ---------------------------------------------------------------------------------------------
// The result

export function flavourOf(singerId: string | null): Flavour {
  switch (singerId) {
    case 'shawn-mendes':
      return 'shawn';
    case 'daniel-caesar':
      return 'daniel';
    case 'jalen-ngonda':
      return 'jalen';
    default:
      return 'generic';
  }
}

/** The comparison with its trust lowered (never raised) and the reason added: the engine knows things the scorer does not (the click probe). */
export function withTrust(c: PhraseComparison, level: 'caution' | 'invalid', reason: string): PhraseComparison {
  const current = c.score.trust.level;
  const worse = current === 'invalid' || level === 'invalid' ? 'invalid' : 'caution';
  return {
    ...c,
    bleedSuspect: c.bleedSuspect || level === 'invalid',
    score: { ...c.score, trust: { level: worse, reasons: c.score.trust.reasons.includes(reason) ? c.score.trust.reasons : [...c.score.trust.reasons, reason] } },
  };
}

const mod12 = (n: number): number => ((n % 12) + 12) % 12;

/** The key found now is not an octave away from the one found last time, and little of the phrase matched: the key is in doubt. */
export function keyLooksUnclear(c: Pick<PhraseComparison, 'transposeSemitones' | 'coverage'>, keyHint: number | null): boolean {
  return keyHint !== null && mod12(c.transposeSemitones - keyHint) !== 0 && c.coverage < 0.7;
}

/** The reference notes the singer sang as a different note (mastery needs none). */
export function wrongNoteCount(c: Pick<PhraseComparison, 'notes'>): number {
  return c.notes.filter((n) => n.flags.includes('wrong-note') || n.flags.includes('octave-displaced')).length;
}

export interface Verdict {
  /** The comparison to show, with trust lowered when the engine has reason to. */
  comparison: PhraseComparison;
  /** Counts toward the history and the review ladder. */
  countable: boolean;
  /** Why it was not counted, or what to doubt; names the next step. null when fine. */
  notice: string | null;
}

/**
 * Decides what a scored take is worth. Gated takes (no match, low evidence) are shown honestly and never counted. A take that
 * sounds like the playback is never counted. Speaker bleed seen by the click probe on a route without headphones is not counted;
 * on headphones it is only doubted. An unclear key is counted but flagged.
 */
export function judgeTake(p: {
  comparison: PhraseComparison;
  mode: PlayMode;
  probe: ClickProbe | null;
  headphonesLikely: boolean;
  keyHint: number | null;
  voicedSec: number;
  /** The reference phrase has enough singing to be scored against (two notes, a second of voice). */
  referenceUsable?: boolean;
}): Verdict {
  const { comparison: c } = p;
  const s = c.score;
  // The scorer's range hint (the pitch tracker cannot follow below about C2) is worth keeping next to the generic words.
  const floorHint = s.notes.find((n) => /below about C2/.test(n));
  const withHint = (text: string): string => (floorHint ? `${text} ${inOriginalTerms(floorHint)}` : text);
  if (s.status === 'no-match') return { comparison: c, countable: false, notice: withHint(COPY.noMatch) };
  if (s.status === 'low-evidence') {
    if (p.referenceUsable === false) return { comparison: c, countable: false, notice: COPY.referenceTooShort };
    return { comparison: c, countable: false, notice: p.voicedSec < 0.5 ? COPY.nothingHeard : withHint(COPY.lowEvidence) };
  }
  if (c.bleedSuspect || s.trust.level === 'invalid') {
    return { comparison: withTrust(c, 'invalid', COPY.bleedSuspect), countable: false, notice: COPY.bleedSuspect };
  }
  const leaking = p.mode === 'sing-along' && !!p.probe && p.probe.bleed && p.probe.consistent;
  if (leaking && !p.headphonesLikely) {
    return { comparison: withTrust(c, 'invalid', COPY.speakerBleed), countable: false, notice: COPY.speakerBleed };
  }
  if (leaking) return { comparison: withTrust(c, 'caution', COPY.leakCaution), countable: true, notice: COPY.leakCaution };
  if (keyLooksUnclear(c, p.keyHint)) return { comparison: c, countable: true, notice: COPY.unclearKey(p.keyHint as number, c.transposeSemitones) };
  return { comparison: c, countable: true, notice: null };
}

/** The stored attempt for a comparison (what recordAttempt writes, and what the result sheet shows when it was not saved). */
export function buildAttemptRecord(p: {
  id: string;
  at: number;
  clipId: string;
  phraseId: string;
  mode: PlayMode;
  keyMode: KeyMode;
  rate: number;
  comparison: PhraseComparison;
  routeKind: RouteInfo['kind'] | 'unknown';
  style: StyleVector;
  fixes: TrainerFix[];
}): AttemptRecord {
  const c = p.comparison;
  const notes: AttemptNoteSummary[] = c.notes.map((n) => ({
    i: n.refIndex,
    refName: n.refName,
    userName: n.userName,
    cents: n.cents === null ? null : Math.round(n.cents),
    onsetMs: n.onsetMs === null ? null : Math.round(n.onsetMs),
    durationDeltaMs: n.durationDeltaMs === null ? null : Math.round(n.durationDeltaMs),
    flags: [...n.flags],
  }));
  return {
    id: p.id,
    clipId: p.clipId,
    phraseId: p.phraseId,
    at: p.at,
    mode: p.mode,
    keyMode: p.keyMode,
    rate: p.rate,
    transposeSemitones: c.transposeSemitones,
    scores: { overall: c.scores.overall, pitch: c.scores.pitch, timing: c.scores.timing, tone: c.scores.tone, expression: c.scores.expression },
    trust: c.score.trust.level,
    coverage: c.coverage,
    wrongNotes: wrongNoteCount(c),
    syncOffsetMs: c.syncOffsetMs,
    tempoRatio: c.tempoRatio,
    route: p.routeKind,
    notes,
    style: p.style,
    tone: c.tone.map((t) => ({ key: t.key, diff: t.diff })),
    fixIds: p.fixes.map((f) => f.id),
    analysisVersion: TRAINER_ANALYSIS_VERSION,
    hasAudio: false,
  };
}

/** The latency to remember for a route: the new click-probe reading blended into the old one unless the route clearly changed. */
export function blendLatency(previous: number | undefined, measured: number): number {
  if (!finite(previous) || previous <= 0 || Math.abs(measured - previous) >= 60) return Math.round(measured);
  return Math.round((previous * 2 + measured) / 3);
}
