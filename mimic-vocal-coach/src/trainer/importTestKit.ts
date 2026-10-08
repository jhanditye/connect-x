// Synthetic clips and containers for the import tests (and the import UI tests). Test support only: nothing in the app
// imports this file. Every signal is generated here from testing/synth.ts, never read from a recording.

import { encodeWav } from '../audio/wav';
import { concat, mix, silence, synthMelody, synthVoice, whiteNoise, type MelodyNote } from '../testing/synth';
import type { ClipKind, FrameFeatures, NoteSegment, VoiceAnalysis } from '../types';
import { makeFakeAnalysis } from '../testing/fixtures';
import type { PreparedClip } from './import';
import { segmentPhrases } from './segment';

export const KIT_RATE = 22050;

const SCALE = [55, 57, 59, 62, 60, 59, 57, 55];

// Synthesis is the slow part of these tests, so every generator below returns the same array for the same arguments. Callers
// must not modify what they get (encodeWav, map and slice all copy).
const memo = new Map<string, Float32Array>();
function cached(key: string, make: () => Float32Array): Float32Array {
  let v = memo.get(key);
  if (!v) {
    v = make();
    memo.set(key, v);
  }
  return v;
}

/** One sung phrase: `noteCount` notes of `noteSec` each, on a rising-falling pattern around `rootMidi`. */
export function phrase(opts: { noteCount?: number; noteSec?: number; rootMidi?: number; seed?: number; sampleRate?: number; amplitude?: number } = {}): Float32Array {
  return cached(`phrase:${JSON.stringify(opts)}`, () => {
    const n = opts.noteCount ?? 8;
    const root = opts.rootMidi ?? 0;
    const notes: MelodyNote[] = Array.from({ length: n }, (_, i) => ({ midi: SCALE[i % SCALE.length] + root, durSec: opts.noteSec ?? 0.5 }));
    return synthMelody(notes, { sampleRate: opts.sampleRate ?? KIT_RATE, vowel: 'a', amplitude: opts.amplitude ?? 0.4, seed: opts.seed ?? 1, vibrato: { rateHz: 5.5, extentCents: 35, delaySec: 0.3 } });
  });
}

/** A solo melody: `count` phrases separated by breaths (rests), with a short lead-in and tail. */
export function soloLine(opts: { count?: number; noteCount?: number; noteSec?: number; restSec?: number; leadSec?: number; tailSec?: number; sampleRate?: number } = {}): Float32Array {
  return cached(`soloLine:${JSON.stringify(opts)}`, () => {
    const sr = opts.sampleRate ?? KIT_RATE;
    const parts: Float32Array[] = [silence(opts.leadSec ?? 1.2, sr)];
    for (let i = 0; i < (opts.count ?? 5); i++) {
      parts.push(phrase({ noteCount: opts.noteCount, noteSec: opts.noteSec, seed: i + 1, sampleRate: sr }));
      parts.push(silence(opts.restSec ?? 1, sr));
    }
    parts.push(silence(opts.tailSec ?? 1.2, sr));
    return concat(...parts);
  });
}

/** RMS of the samples that are part of the singing (above a small threshold), so rests do not count. */
function singingRms(x: Float32Array): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) > 0.02) {
      s += x[i] * x[i];
      n++;
    }
  }
  return Math.sqrt(s / Math.max(1, n));
}

/**
 * The voice over a sustained four-note chord `dropDb` below it: reads as a song mix to the analysis. The chord is a few
 * harmonics per note (cheap to compute), steady under the rests too, which is what gives a band away.
 */
export function withBand(voice: Float32Array, dropDb = 6, sampleRate = KIT_RATE): Float32Array {
  return cached(`band:${voice.length}:${dropDb}:${sampleRate}:${voice[Math.floor(voice.length / 2)]}`, () => {
    const band = new Float32Array(voice.length);
    for (const hz of [110, 138.59, 164.81, 220]) {
      for (let h = 1; h <= 6; h++) {
        const w = (2 * Math.PI * hz * h) / sampleRate;
        const amp = 1 / (h * h);
        for (let i = 0; i < band.length; i++) band[i] += amp * Math.sin(w * i);
      }
    }
    const gain = (singingRms(voice) / Math.max(1e-9, singingRms(band))) * 10 ** (-dropDb / 20);
    return mix(voice, band.map((v) => v * gain));
  });
}

/** Short falling syllables with short gaps and no held note: reads as speech. */
export function speechLike(syllables = 26, sampleRate = KIT_RATE): Float32Array {
  return cached(`speech:${syllables}:${sampleRate}`, () => {
    const parts: Float32Array[] = [silence(0.4, sampleRate)];
    for (let i = 0; i < syllables; i++) {
      const dur = 0.1 + (0.18 * ((i * 7) % 11)) / 10;
      const f0 = 110 + (50 * ((i * 5) % 7)) / 6;
      parts.push(synthVoice({ sampleRate, durationSec: dur, f0: (t) => f0 * (1 - 0.6 * t), vowel: i % 2 ? 'e' : 'a', seed: i + 1 }));
      parts.push(silence(0.08 + 0.1 * (i % 3), sampleRate));
    }
    parts.push(silence(0.4, sampleRate));
    return concat(...parts);
  });
}

/** Noise at a low level: no singing at all. */
export function roomNoise(sec: number, sampleRate = KIT_RATE): Float32Array {
  return cached(`noise:${sec}:${sampleRate}`, () => whiteNoise(sec, 0.002, sampleRate, 7));
}

export function wavFile(samples: Float32Array | Float32Array[], sampleRate: number, name = 'clip.wav'): File {
  return new File([encodeWav(samples, sampleRate)], name, { type: 'audio/wav' });
}

// ---------------------------------------------------------------------------------------------
// A video-like container in code: ftyp + wide + mdat + moov(mvhd), the layout of an iPhone .MOV.

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(ascii(type), 4);
  out.set(payload, 8);
  return out;
}

function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The bytes of a QuickTime-style movie that says it lasts `durationSec`. There is no real media in it: tests stub the decoder. */
export function movBytes(durationSec: number, brand = 'qt  ', timescale = 600): Uint8Array {
  const mvhdPayload = new Uint8Array(96);
  const dv = new DataView(mvhdPayload.buffer);
  dv.setUint32(12, timescale);
  dv.setUint32(16, Math.round(durationSec * timescale));
  return joinBytes(
    box('ftyp', new Uint8Array([...ascii(brand), 0, 0, 0, 0, ...ascii('qt  ')])),
    box('wide', new Uint8Array(0)),
    box('mdat', new Uint8Array(512)),
    box('moov', box('mvhd', mvhdPayload)),
  );
}

export function movFile(durationSec: number, name = 'IMG_0001.MOV'): File {
  return new File([movBytes(durationSec) as BlobPart], name, { type: 'video/quicktime' });
}

/** A decoded AudioBuffer stand-in for stubbing OfflineAudioContext.decodeAudioData. */
export function fakeAudioBuffer(samples: Float32Array, sampleRate: number, channels = 2): { sampleRate: number; length: number; numberOfChannels: number; getChannelData: (c: number) => Float32Array } {
  return { sampleRate, length: samples.length, numberOfChannels: channels, getChannelData: () => samples };
}

// ---------------------------------------------------------------------------------------------
// Hand-built analyses for the pure tests (no DSP): sung spans become voiced frames, notes and analysis phrases.

export interface Span {
  start: number;
  end: number;
  /** Pitch of the span as a MIDI number (default 60). */
  midi?: number;
  /** Notes per second inside the span (default 2). */
  noteRate?: number;
  vibrato?: boolean;
}

export function analysisFromSpans(spans: Span[], durationSec: number, over: Partial<VoiceAnalysis> = {}): VoiceAnalysis {
  const base = makeFakeAnalysis();
  const hop = 0.01;
  const n = Math.round(durationSec / hop);
  const frames: FrameFeatures[] = [];
  const notes: NoteSegment[] = [];
  for (const sp of spans) {
    const rate = sp.noteRate ?? 2;
    const len = 1 / rate;
    for (let t = sp.start; t + len * 0.5 < sp.end; t += len) {
      const end = Math.min(sp.end, t + len * 0.9);
      notes.push({
        start: t,
        end,
        midi: (sp.midi ?? 60) + (notes.length % 4),
        nearestMidi: Math.round((sp.midi ?? 60) + (notes.length % 4)),
        centsOff: 0,
        vibrato: sp.vibrato ? { rateHz: 5.5, extentCents: 40 } : null,
        register: 'chest',
        meanRmsDb: -24,
      });
    }
  }
  for (let i = 0; i < n; i++) {
    const t = i * hop;
    const span = spans.find((s) => t >= s.start && t < s.end);
    const note = notes.find((nt) => t >= nt.start && t < nt.end);
    const voiced = !!span && !!note;
    frames.push({
      ...base.frames[0],
      t,
      voiced,
      f0: voiced ? 440 * 2 ** ((note.midi - 69) / 12) : NaN,
      midi: voiced ? note.midi : NaN,
      rmsDb: voiced ? -24 : -62,
      periodicity: voiced ? 0.9 : 0.1,
      register: null,
    });
  }
  const voicedCount = frames.filter((f) => f.voiced).length;
  return {
    ...base,
    durationSec,
    frames,
    notes,
    phrases: spans.map((s) => ({ start: s.start, end: s.end })),
    runs: [],
    voicedSec: voicedCount * hop,
    voicedRatio: voicedCount / Math.max(1, n),
    issues: [],
    warnings: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// A PreparedClip for the review UI tests: consistent audio, analysis and phrases, built without DSP.

export function fakePrepared(
  over: {
    name?: string;
    durationSec?: number;
    spans?: Span[];
    kind?: ClipKind;
    blockers?: string[];
    warnings?: string[];
    notices?: string[];
    sampleRate?: number;
    fingerprint?: string;
    analysis?: Partial<VoiceAnalysis>;
    size?: number;
  } = {},
): PreparedClip {
  const durationSec = over.durationSec ?? 22;
  const sampleRate = over.sampleRate ?? 8000;
  const spans = over.spans ?? [
    { start: 1, end: 6.5, vibrato: true },
    { start: 8, end: 13.5 },
    { start: 15, end: 20.5, noteRate: 5 },
  ];
  const analysis = analysisFromSpans(spans, durationSec, over.analysis);
  const samples = new Float32Array(Math.round(durationSec * sampleRate));
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    if (spans.some((s) => t >= s.start && t < s.end)) samples[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t);
  }
  const blockers = over.blockers ?? [];
  const kind = over.kind ?? 'solo';
  return {
    file: { name: over.name ?? 'Verse take.wav', size: over.size ?? 2_000_000 },
    samples,
    sampleRate,
    durationSec,
    analysis,
    suggestedKind: kind,
    warnings: over.warnings ?? [],
    blockers,
    phrases: blockers.length > 0 ? [] : segmentPhrases(analysis),
    fingerprint: over.fingerprint ?? `2000000:${Math.round(durationSec * 1000)}:0123456789abcdef`,
    notices: over.notices ?? [],
    kind,
    options: { voiceType: 'tenor', a4Hz: 440 },
    sourceKind: 'audio',
  };
}
