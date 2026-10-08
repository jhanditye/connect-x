// Full analysis of one take: pitch track -> frame features -> registers, phrases, notes, vibrato,
// runs, onsets -> StyleVector, recording quality and warnings.

import { extractVocalMelody } from '../dsp/melody/vocalMelody';
import { trackPitch } from '../dsp/pitch';
import { ANALYSIS_RATE, resample } from '../dsp/resample';
import { median, percentile } from '../dsp/stats';
import type { AnalysisIssue, AnalysisOptions, FrameFeatures, PassaggioZone, StyleVector, VoiceAnalysis } from '../types';
import { buildFrameTrack, type FrameTrack } from './features';
import { segmentNotes, buildNoteSegments } from './notes';
import { classifyOnsets } from './onsets';
import { analyzeMix } from './mixMode';
import { passaggioFor } from './passaggio';
import { findPhrases } from './phrases';
import { pitchSummary } from './pitchSummary';
import { clippingRatio, leadCheckWorthRunning, leadDisagrees, measureAccompaniment, measureLeadAgreement, measureQuality, qualityReport } from './quality';
import { detectFlips, estimateRegisters, registerShares } from './register';
import { detectRuns } from './runs';
import { computeStyle, SUSTAINED_NOTE_SEC } from './style';

export const HOP_SEC = 0.01;
export const MAX_ANALYSIS_SEC = 300;

const EMPTY_STYLE: StyleVector = {
  breathiness: null,
  brightness: null,
  rasp: null,
  vibratoPresence: null,
  vibratoRateHz: null,
  vibratoExtentCents: null,
  chestInUpperRange: null,
  mixInUpperRange: null,
  headInUpperRange: null,
  loudnessClimbDbPerSemitone: null,
  agility: null,
  dynamicRangeDb: null,
  softOnsetRatio: null,
  pitchAccuracyCents: null,
  flipsPerMinute: null,
};

function emptyAnalysis(durationSec: number, zone: PassaggioZone, warnings: string[], issues: AnalysisIssue[], mode?: 'mix'): VoiceAnalysis {
  return {
    version: 1,
    // Only a mix analysis carries `mode` (absent = solo), so an empty solo result is exactly what it always was.
    ...(mode ? { mode } : {}),
    durationSec,
    sampleRate: ANALYSIS_RATE,
    hopSec: HOP_SEC,
    frames: [],
    voicedRatio: 0,
    voicedSec: 0,
    pitch: {
      medianMidi: null,
      lowMidi: null,
      highMidi: null,
      tessituraLowMidi: null,
      tessituraHighMidi: null,
      tuningOffsetCents: 0,
    },
    passaggio: zone,
    tone: { h1h2Db: null, alphaRatioDb: null, centroidHz: null, tiltDbPerOct: null, cppDb: null, hnrDb: null },
    registerShares: { chest: 0, mix: 0, head: 0 },
    notes: [],
    phrases: [],
    onsets: [],
    runs: [],
    style: { ...EMPTY_STYLE },
    quality: { clippingRatio: 0, noiseFloorDb: -120, snrDb: 0 },
    warnings,
    issues,
  };
}

/** Wraps a progress callback so it only ever sees increasing values in 0..1. */
function progressReporter(cb?: (fraction: number) => void): (fraction: number) => void {
  let last = -1;
  return (fraction: number) => {
    if (!cb) return;
    const v = Math.min(1, Math.max(0, fraction));
    if (v <= last) return;
    last = v;
    cb(v);
  };
}

/** Zero-crossing rate per sample over ~23 ms around each unvoiced frame; NaN for voiced frames. */
function unvoicedZcr(x: Float32Array, sampleRate: number, frames: FrameFeatures[]): Float32Array {
  const out = new Float32Array(frames.length).fill(NaN);
  const half = Math.round(0.0115 * sampleRate);
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].voiced) continue;
    const c = Math.round(frames[i].t * sampleRate);
    const a = Math.max(1, c - half);
    const b = Math.min(x.length, c + half);
    let crossings = 0;
    for (let k = a; k < b; k++) if (x[k - 1] < 0 !== x[k] < 0) crossings++;
    if (b - a > 0) out[i] = crossings / (b - a);
  }
  return out;
}

/**
 * Unvoiced frames that sound like near-whisper singing: clearly above the noise floor and not far
 * below the singing, partly periodic (0.25-0.55; white noise and fricatives read < 0.2), and
 * noise-like in spectrum (zero-crossing rate >= 0.12 per sample; voiced rasp or a quiet voiced
 * frame stays well below). Used for the breathiness index, and as singing (not pauses) when the
 * gaps between phrases are checked for accompaniment.
 */
function findWhisperFrames(frames: FrameFeatures[], zcr: Float32Array, noiseFloorDb: number): Uint8Array {
  const out = new Uint8Array(frames.length);
  const voicedLevels = frames.filter((f) => f.voiced).map((f) => f.rmsDb);
  const loud = voicedLevels.length > 0 ? median(voicedLevels) : percentile(frames.map((f) => f.rmsDb), 90);
  const gate = Math.max(-60, noiseFloorDb + 12, loud - 25);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.voiced || f.rmsDb < gate || f.periodicity < 0.25 || f.periodicity >= 0.55) continue;
    if (zcr[i] >= 0.12) out[i] = 1;
  }
  return out;
}

function medianOrNull(frames: FrameFeatures[], key: keyof FrameFeatures): number | null {
  const vals: number[] = [];
  for (const f of frames) if (f.voiced) vals.push(f[key] as number);
  const m = median(vals);
  return Number.isFinite(m) ? m : null;
}

/**
 * Full analysis of a take. `samples` is mono at any sample rate; resamples to ANALYSIS_RATE internally.
 * `opts.mode === 'mix'` analyses a full song instead (analysis/mixMode.ts): the lead vocal is extracted first and only the
 * measures that survive a mix are reported. Absent or 'solo' is the normal pipeline, unchanged.
 */
export function analyzeTake(
  samples: Float32Array,
  sampleRate: number,
  opts: AnalysisOptions,
  onProgress?: (fraction: number) => void,
): VoiceAnalysis {
  const progress = progressReporter(onProgress);
  const zone = passaggioFor(opts.voiceType);
  const a4Hz = opts.a4Hz !== undefined && opts.a4Hz >= 380 && opts.a4Hz <= 500 ? opts.a4Hz : 440;
  const warnings: string[] = [];
  const issues: AnalysisIssue[] = [];
  const mixMode = opts.mode === 'mix';
  const emptyMode = mixMode ? 'mix' : undefined;

  if (!(sampleRate > 0) || !Number.isFinite(sampleRate) || sampleRate < 4000) {
    progress(1);
    return emptyAnalysis(
      0,
      zone,
      ['The audio has an invalid sample rate, so it could not be analysed. Try exporting it again as WAV or M4A.'],
      ['too-little-singing'],
      emptyMode,
    );
  }
  let durationSec = samples.length / sampleRate;
  let input = samples;
  if (durationSec > MAX_ANALYSIS_SEC) {
    input = samples.subarray(0, Math.round(MAX_ANALYSIS_SEC * sampleRate));
    warnings.push(
      mixMode
        ? `Only the first 5 minutes of this ${(durationSec / 60).toFixed(1)}-minute song were analysed. Pick the section you want to practise, or cut it shorter.`
        : `Only the first 5 minutes of this ${(durationSec / 60).toFixed(1)}-minute take were analysed. Shorter takes (under a minute) give the clearest feedback.`,
    );
    durationSec = MAX_ANALYSIS_SEC;
    issues.push('trimmed');
  }

  // Clean copy: non-finite samples become silence, DC offset is removed.
  let bad = 0;
  let sum = 0;
  const clean = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const v = input[i];
    if (Number.isFinite(v)) {
      clean[i] = v;
      sum += v;
    } else bad++;
  }
  if (input.length === 0 || bad === input.length) {
    progress(1);
    return emptyAnalysis(
      durationSec,
      zone,
      [
        ...warnings,
        input.length === 0
          ? 'The recording is empty. Record or upload a take with at least 10 seconds of singing.'
          : 'The recording contains no valid audio. Try recording again or exporting the file as WAV.',
      ],
      [...issues, 'too-little-singing'],
      emptyMode,
    );
  }
  if (bad > 0) warnings.push('Some samples in the audio were invalid and were treated as silence. If the analysis looks wrong, export the file again.');
  const dc = sum / (input.length - bad);
  if (Math.abs(dc) > 1e-4) for (let i = 0; i < clean.length; i++) clean[i] -= dc;
  const clipping = clippingRatio(input);
  progress(0.02);

  const x = resample(clean, sampleRate, ANALYSIS_RATE);
  progress(0.1);
  if (mixMode) {
    const mix = analyzeMix(x, null, ANALYSIS_RATE, opts, (f) => progress(0.1 + 0.9 * f), {
      warnings,
      issues,
      clippingRatio: clipping,
      durationSec,
    });
    progress(1);
    return mix;
  }
  const pitchTrack = trackPitch(x, ANALYSIS_RATE, { hopSec: HOP_SEC });
  progress(0.3);
  const track: FrameTrack = buildFrameTrack(x, ANALYSIS_RATE, pitchTrack, a4Hz, (f) => progress(0.3 + 0.55 * f));
  const { frames } = track;

  const lightness = estimateRegisters(track, zone);
  const phrases = findPhrases(frames, HOP_SEC);
  const events = segmentNotes(frames, phrases, HOP_SEC);
  const { notes, tuningOffsetCents } = buildNoteSegments(frames, events, HOP_SEC);
  progress(0.9);
  const runs = detectRuns(events);
  const quality = measureQuality(frames, clipping);
  const onsets = classifyOnsets(x, ANALYSIS_RATE, frames, phrases, quality.noiseFloorDb, HOP_SEC);
  const flips = detectFlips(frames, lightness, HOP_SEC);

  const voicedCount = frames.reduce((n, f) => n + (f.voiced ? 1 : 0), 0);
  const voicedSec = voicedCount * HOP_SEC;
  const zcr = unvoicedZcr(x, ANALYSIS_RATE, frames);
  const whisperFrames = findWhisperFrames(frames, zcr, quality.noiseFloorDb);
  const style = computeStyle({ track, whisperFrames, zone, notes, runs, onsets, flipCount: flips.length, voicedSec });
  progress(0.97);

  const shares = registerShares(frames);
  const medianVoicedDb = median(frames.filter((f) => f.voiced).map((f) => f.rmsDb));
  const reportInput = {
    voicedSec,
    quality,
    medianVoicedDb,
    levelP95Db: frames.length > 0 ? percentile(frames.map((f) => f.rmsDb), 95) : -120,
    heldNotes: notes.filter((n) => n.end - n.start >= SUSTAINED_NOTE_SEC - 1e-9).length,
    accompaniment: measureAccompaniment(frames, HOP_SEC, whisperFrames, zcr),
    voiceType: opts.voiceType,
  };
  let report = qualityReport(reportInput);
  // Vocal-forward songs: the pause checks cannot hear the band, so where the clip does not look like a clean solo take the
  // tracker is compared with the lead-vocal extractor (quality.ts, LEAD_MAX_AGREE). Clean takes never pay for this.
  if (
    !report.issues.includes('accompaniment') &&
    leadCheckWorthRunning({ voicedSec, medianPeriodicity: median(frames.filter((f) => f.voiced).map((f) => f.periodicity)), snrDb: quality.snrDb })
  ) {
    try {
      const lead = extractVocalMelody(x, null, ANALYSIS_RATE);
      const leadAgreement = measureLeadAgreement(frames, lead.track.f0, lead.track.voiced);
      if (leadDisagrees(leadAgreement)) report = qualityReport({ ...reportInput, leadAgreement });
    } catch {
      // The comparison is an extra opinion: if it cannot run (out of memory on a small phone), the solo analysis stands as it was.
    }
  }
  warnings.push(...report.warnings);
  for (const issue of report.issues) if (!issues.includes(issue)) issues.push(issue);

  const analysis: VoiceAnalysis = {
    version: 1,
    durationSec,
    sampleRate: ANALYSIS_RATE,
    hopSec: HOP_SEC,
    frames,
    voicedRatio: frames.length > 0 ? voicedCount / frames.length : 0,
    voicedSec,
    pitch: pitchSummary(frames, tuningOffsetCents),
    passaggio: zone,
    tone: {
      h1h2Db: medianOrNull(frames, 'h1h2Db'),
      alphaRatioDb: medianOrNull(frames, 'alphaRatioDb'),
      centroidHz: medianOrNull(frames, 'centroidHz'),
      tiltDbPerOct: medianOrNull(frames, 'tiltDbPerOct'),
      cppDb: medianOrNull(frames, 'cppDb'),
      hnrDb: medianOrNull(frames, 'hnrDb'),
    },
    registerShares: { chest: shares.chest, mix: shares.mix, head: shares.head },
    notes,
    phrases: phrases.map((p) => ({ start: p.start, end: p.end })),
    onsets,
    runs,
    style,
    quality,
    warnings,
    issues,
  };
  progress(1);
  return analysis;
}
