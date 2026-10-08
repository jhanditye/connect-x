// Mix mode of analyzeTake (AnalysisOptions.mode === 'mix'): the audio is a full song. The pitch track comes from the
// lead-vocal melody extractor (dsp/melody) instead of YIN, and the per-frame spectral measures are NOT computed: on
// a mix they are biased or uncorrelated with the singer's tone (evaluation: breathiness r -0.02, rasp r -0.10,
// register shares r 0.1-0.4, brightness biased +0.1 by the band's treble). Everything downstream of the pitch track
// (phrases, notes, vibrato, runs) is the unchanged solo code, so a mix analysis has the same shape as a solo one.
//
// What a mix analysis holds:
//   measured:  pitch contour and range, phrases, notes, vibrato (presence, rate, extent), agility, the loudness
//              contour (`frames[i].rmsDb`, relative, of the extracted harmonics) and `leadExtraction.confidence`.
//   not shown: tone, breathiness, brightness, rasp, registers, loudness climb, dynamic range, onsets, pitch accuracy
//              in cents. Those StyleVector entries are null, `tone` is null, `onsets` is empty, and `warnings` says so.
//   `issues` carries 'accompaniment' on purpose (see below).
//
// Frames: `periodicity` holds the extractor's per-frame confidence (probability the pitch is right, 0..1), not a YIN
// periodicity.
//
// How much of the extracted line is the singer (for scorers): `leadExtraction.noteTrust[i]` is the probability that
// `notes[i]` is the lead voice and not the band, `purity` the time-weighted mean of that, `trustedNotes` the expected number
// of lead notes and `roughGuide` is true when purity is under 0.7. The frame confidence above is NOT a substitute: it stays
// at 0.8-0.9 while the extractor follows a bass line (analysis/leadTrust.ts has the model, its fit and its limits).

import { extractVocalMelody } from '../dsp/melody/vocalMelody';
import { HOP_SEC } from '../dsp/melody/stft';
import { ANALYSIS_RATE } from '../dsp/resample';
import type { AnalysisIssue, AnalysisOptions, StyleVector, VoiceAnalysis } from '../types';
import { buildFrameTrack } from './features';
import { noteTrust, purityOf, ROUGH_GUIDE_PURITY } from './leadTrust';
import { segmentNotes, buildNoteSegments } from './notes';
import { passaggioFor } from './passaggio';
import { findPhrases } from './phrases';
import { pitchSummary } from './pitchSummary';
import { mixReport } from './quality';
import { registerShares } from './register';
import { detectRuns } from './runs';
import { computeStyle } from './style';

/** Style measures that stay meaningful on a mix (see the evaluation); the others are nulled. */
export const MIX_RELIABLE: (keyof StyleVector)[] = ['vibratoPresence', 'vibratoRateHz', 'vibratoExtentCents', 'agility'];

export const MIX_NOTE =
  'Analysed as a full song mix: the lead vocal was separated from the band, so the pitch contour, phrases, timing and vibrato are measured. Tone, breathiness, brightness, register and absolute loudness measures are not shown, because the band changes them.';

/** What the lead-vocal extractor knows about a mix analysis. */
export interface LeadExtraction {
  /**
   * Clip-level 0..1: the expected raw pitch accuracy of the voiced frames (mean of the per-frame confidence). Calibrated on
   * synthetic mixes only, so read it as a ranking; below about 0.8 the lead vocal was hard to follow (quality.ts mixReport).
   * It stays high (0.9) when the extractor follows a moving bass line, so do not read "high" as "right": use `purity`.
   */
  confidence: number;
  /** Side/mid energy ratio in dB; null for mono or dual-mono input (no stereo cue was used). */
  sideToMidDb: number | null;
  /**
   * Per-note probability (0..1) that the note is the lead voice and not the band, same order and length as `VoiceAnalysis.notes`
   * (see analysis/leadTrust.ts for the model and its limits). Absent on analyses made before this field existed. For a scorer:
   * a reference note with a low trust (below about 0.4) is as likely a bass or guitar note as a sung one, so a singer who does
   * not sing it should not be charged for a missed note, and a wrong-pitch verdict on it is not reliable either.
   */
  noteTrust?: number[];
  /** Sum of `noteTrust`: the expected number of lead-voice notes among `notes` (compare it with the number of notes the singer sang). */
  trustedNotes?: number;
  /**
   * Time-weighted mean of `noteTrust` (0..1): the expected share of the extracted singing that is the lead voice. About 0.85
   * with the voice 3 dB over a band, 0.7 level with it, 0.55 with the voice 6 dB under it (measured on proxy mixes; optimistic by
   * up to 0.15 below 0 dB).
   */
  purity?: number;
  /** True when `purity` is under ROUGH_GUIDE_PURITY: the extracted line is a rough guide and has band notes in it. */
  roughGuide?: boolean;
  /** Median share of the cleaned spectral energy of the voiced frames that sits on the harmonics of the extracted pitch (0.46 voice well over the band, 0.24 under it). */
  harmonicShare?: number;
}

/** A VoiceAnalysis made in mix mode. `leadExtraction` is not part of VoiceAnalysis (see leadExtractionOf). */
export type MixAnalysis = VoiceAnalysis & { mode: 'mix'; leadExtraction: LeadExtraction };

/** The extractor's confidence, stereo cue and note-trust fields for a mix analysis, null for a solo analysis (or one without them). */
export function leadExtractionOf(analysis: VoiceAnalysis): LeadExtraction | null {
  if (analysis.mode !== 'mix') return null;
  const le = (analysis as { leadExtraction?: Partial<LeadExtraction> }).leadExtraction;
  if (!le || typeof le.confidence !== 'number' || !Number.isFinite(le.confidence)) return null;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const out: LeadExtraction = { confidence: le.confidence, sideToMidDb: finite(le.sideToMidDb) ? le.sideToMidDb : null };
  // The note-trust fields travel together; one that does not line up with the notes is ignored.
  if (Array.isArray(le.noteTrust) && le.noteTrust.length === analysis.notes.length && le.noteTrust.every(finite) && finite(le.purity)) {
    out.noteTrust = le.noteTrust;
    out.trustedNotes = finite(le.trustedNotes) ? le.trustedNotes : le.noteTrust.reduce((a, b) => a + b, 0);
    out.purity = le.purity;
    out.roughGuide = typeof le.roughGuide === 'boolean' ? le.roughGuide : le.purity < ROUGH_GUIDE_PURITY;
    if (finite(le.harmonicShare)) out.harmonicShare = le.harmonicShare;
  }
  return out;
}

/** What analyzeTake already knows when it hands the audio over (trimming, bad samples, clipping). */
export interface MixContext {
  warnings?: string[];
  issues?: AnalysisIssue[];
  clippingRatio?: number;
  durationSec?: number;
}

/**
 * Analyses a full song. `left` (and `right`, or null for mono) at any sample rate from 4 kHz; the extractor resamples to
 * ANALYSIS_RATE itself (a no-op when analyzeTake has done it already). `onProgress` gets increasing values ending at 1.
 *
 * Issues: 'accompaniment' is always present. It is true (this is a song with a band), and it is what keeps every existing
 * gate shut that must not see a mix: isScoreable (no score against a singer's tone targets), referenceUsability and the
 * measured-singer path (no targets from a mix). Phrase comparison asks referenceUsability(ref, 'comparison') instead.
 */
export function analyzeMix(
  left: Float32Array,
  right: Float32Array | null,
  sampleRate: number,
  opts: AnalysisOptions,
  onProgress?: (fraction: number) => void,
  ctx: MixContext = {},
): MixAnalysis {
  const zone = passaggioFor(opts.voiceType);
  const a4Hz = opts.a4Hz !== undefined && opts.a4Hz >= 380 && opts.a4Hz <= 500 ? opts.a4Hz : 440;
  const vm = extractVocalMelody(left, right, sampleRate, { onProgress: onProgress && ((f) => onProgress(0.9 * f)) });
  const pt = vm.track;
  const n = pt.f0.length;
  const track = buildFrameTrack(left, sampleRate, pt, a4Hz, undefined, { spectral: false });
  const { frames } = track;
  const phrases = findPhrases(frames, HOP_SEC);
  const events = segmentNotes(frames, phrases, HOP_SEC);
  const { notes, tuningOffsetCents } = buildNoteSegments(frames, events, HOP_SEC);
  const runs = detectRuns(events);
  const voicedCount = frames.reduce((c, f) => c + (f.voiced ? 1 : 0), 0);
  const voicedSec = voicedCount * HOP_SEC;
  // Registers stay null on every frame (they need the spectral fields); computeStyle is given no onsets and no flips.
  const style = computeStyle({ track, whisperFrames: new Uint8Array(n), zone, notes, runs, onsets: [], flipCount: 0, voicedSec });
  const reliable = new Set<keyof StyleVector>(MIX_RELIABLE);
  for (const k of Object.keys(style) as (keyof StyleVector)[]) if (!reliable.has(k)) style[k] = null;

  const shares = registerShares(frames);
  const relLevelDb = Float64Array.from(pt.rmsDb, (v) => v - vm.cues.levelRefDb);
  const trust = noteTrust({ notes, frames, confidence: pt.periodicity, relLevelDb, clipShare: vm.harmonicShare, hopSec: HOP_SEC });
  const purity = purityOf(notes, trust);
  const report = mixReport({ confidence: vm.confidence, voicedSec, purity: notes.length > 0 ? purity : undefined });
  const issues: AnalysisIssue[] = [...(ctx.issues ?? [])];
  for (const issue of ['accompaniment', ...report.issues] as AnalysisIssue[]) if (!issues.includes(issue)) issues.push(issue);
  onProgress?.(1);
  return {
    version: 1,
    mode: 'mix',
    durationSec: ctx.durationSec ?? (sampleRate > 0 && Number.isFinite(sampleRate) ? left.length / sampleRate : 0),
    sampleRate: pt.sampleRate || ANALYSIS_RATE,
    hopSec: HOP_SEC,
    frames,
    voicedRatio: n > 0 ? voicedCount / n : 0,
    voicedSec,
    pitch: pitchSummary(frames, tuningOffsetCents),
    passaggio: zone,
    tone: { h1h2Db: null, alphaRatioDb: null, centroidHz: null, tiltDbPerOct: null, cppDb: null, hnrDb: null },
    registerShares: { chest: shares.chest, mix: shares.mix, head: shares.head },
    notes,
    phrases: phrases.map((p) => ({ start: p.start, end: p.end })),
    onsets: [],
    runs,
    style,
    quality: { clippingRatio: ctx.clippingRatio ?? 0, noiseFloorDb: -120, snrDb: NaN },
    warnings: [...(ctx.warnings ?? []), MIX_NOTE, ...report.warnings],
    issues,
    leadExtraction: {
      confidence: vm.confidence,
      sideToMidDb: Number.isFinite(vm.sideToMidDb) ? vm.sideToMidDb : null,
      noteTrust: trust,
      trustedNotes: trust.reduce((a, b) => a + b, 0),
      purity,
      roughGuide: notes.length > 0 && purity < ROUGH_GUIDE_PURITY,
      harmonicShare: vm.harmonicShare,
    },
  };
}
