import { beforeAll, describe, expect, it, vi } from 'vitest';
import { analyzeTake } from '../analysis/analyze';
import { analyzeMix } from '../analysis/mixMode';
import { DecodeError } from '../audio/decode';
import { floatToInt16 } from '../audio/pcm';
import { trackPitch } from '../dsp/pitch';
import { median } from '../dsp/stats';
import { createMemoryClipStore, QuotaError, type ClipStore } from '../storage/clips';
import { measuredFromClip } from '../storage/library';
import { DEFAULT_SETTINGS } from '../storage/settings';
import { sine } from '../testing/synth';
import { makeFakePreparedClip } from '../testing/trainerFixtures';
import type { AnalysisOptions, AppSettings, ClipRecord, VoiceAnalysis } from '../types';
import { MIX_REASON, SPEECH_REASON } from './importCopy';
import {
  analysisFromSpans,
  fakeAudioBuffer,
  KIT_RATE,
  movFile,
  roomNoise,
  soloLine,
  speechLike,
  wavFile,
  withBand,
} from './importTestKit';
import {
  blockersOf,
  buildView,
  classifyClip,
  commitClip,
  defaultTitle,
  effectiveAnalysis,
  estimateStoredBytes,
  findRelinkMatches,
  leadConfidenceOf,
  prepareClip,
  preparedKind,
  reanalyzeClip,
  relinkAudio,
  renderContourTone,
  sameSource,
  sourceFingerprint,
  normalizeStem,
  stemProblem,
  targetEligibility,
  trimStartOf,
  withoutVocalStem,
  withVocalStem,
  type CommitEdits,
  type ImportDeps,
  type ImportProgress,
  type PreparedClip,
} from './import';
import { segmentPhrases, setHidden, toPhraseRecords } from './segment';

// The default analysis entry runs in a worker; here it runs analyzeTake directly.
vi.mock('../analysis/client', () => ({
  analyzeInWorker: async (s: Float32Array, sr: number, opts: Parameters<typeof analyzeTake>[2], onProgress?: (f: number) => void) => analyzeTake(s, sr, opts, onProgress),
}));

const SETTINGS: AppSettings = { ...DEFAULT_SETTINGS, a4Hz: 440 };

/** The analysis entry with the full-song front end (what the worker does): `mode: 'mix'` reads the lead vocal. */
const withMixSupport: Pick<ImportDeps, 'analyze'> = {
  analyze: async (s, sr, opts, onProgress) => (opts.mode === 'mix' ? analyzeMix(s, null, sr, opts, onProgress) : analyzeTake(s, sr, { ...opts, mode: undefined }, onProgress)),
};
/** An analyzer that ignores `mode: 'mix'` and always hands back a solo analysis (a broken build, or a fake). */
const withoutMixSupport: Pick<ImportDeps, 'analyze'> = {
  analyze: async (s, sr, opts, onProgress) => analyzeTake(s, sr, { ...opts, mode: undefined }, onProgress),
};

let line: Float32Array;
let band: Float32Array;
let speech: Float32Array;

beforeAll(() => {
  line = soloLine({ count: 5 });
  band = withBand(soloLine({ count: 4 }));
  speech = speechLike();
});

function edits(p: PreparedClip, over: Partial<CommitEdits> = {}): CommitEdits {
  return {
    title: 'My clip',
    singerId: null,
    singerLabel: '',
    kind: preparedKind(p),
    phrases: p.stem ? p.stem.phrases : p.phrases,
    contributeToSinger: false,
    ownedConfirmed: true,
    ...over,
  };
}

describe('classifyClip', () => {
  it('calls a clean synthetic melody solo, with no reason', () => {
    const a = analyzeTake(line, KIT_RATE, { voiceType: 'tenor' });
    expect(classifyClip(a)).toEqual({ kind: 'solo', reason: null });
  });

  it('calls singing over a band a full song and explains it', () => {
    const a = analyzeTake(band, KIT_RATE, { voiceType: 'tenor' });
    expect(a.issues).toContain('accompaniment');
    expect(classifyClip(a)).toEqual({ kind: 'mix', reason: MIX_REASON });
  });

  it('blocks speech-like syllables and names the next step', () => {
    const a = analyzeTake(speech, KIT_RATE, { voiceType: 'tenor' });
    expect(a.issues).toContain('speech-like');
    const c = classifyClip(a);
    expect(c.kind).toBe('blocked');
    expect(c.reason).toBe(SPEECH_REASON);
    expect(c.reason).toMatch(/sung section/);
  });

  it('blocks a clip with no singing, with the seconds heard when there are a few', () => {
    const noise = classifyClip(analyzeTake(roomNoise(6), KIT_RATE, { voiceType: 'tenor' }));
    expect(noise.kind).toBe('blocked');
    expect(noise.reason).toMatch(/No clear singing could be heard/);
    expect(noise.reason).toMatch(/This is a full song/);
    const few = classifyClip(analysisFromSpans([{ start: 1, end: 3.5 }], 6, { issues: ['too-little-singing'] }));
    expect(few.reason).toMatch(/Only 2\.\d s of clear singing could be heard/);
  });

  it('lets a full-song analysis through and prefers "full song" when both issues are flagged', () => {
    expect(classifyClip(analysisFromSpans([{ start: 1, end: 9 }], 10, { mode: 'mix' })).kind).toBe('mix');
    expect(classifyClip(analysisFromSpans([{ start: 1, end: 3 }], 10, { issues: ['accompaniment', 'too-little-singing'] })).kind).toBe('mix');
    expect(classifyClip(analysisFromSpans([{ start: 1, end: 3 }], 10, { mode: 'mix', issues: ['too-little-singing'] })).kind).toBe('blocked');
  });

  it('only warns about noise, clipping and quiet recordings', () => {
    for (const issue of ['noisy', 'clipping', 'too-quiet', 'trimmed'] as const) {
      expect(classifyClip(analysisFromSpans([{ start: 1, end: 9 }], 10, { issues: [issue] })).kind).toBe('solo');
    }
  });
});

describe('prepareClip: a solo melody', () => {
  it('decodes, analyses once, classifies and segments, reporting each phase in order', async () => {
    const file = wavFile(line, KIT_RATE, 'Verse and chorus.wav');
    const events: ImportProgress[] = [];
    const prepared = await prepareClip(file, SETTINGS, (p) => events.push(p));

    expect(prepared.file).toEqual({ name: 'Verse and chorus.wav', size: file.size });
    expect(prepared.sampleRate).toBe(KIT_RATE);
    expect(prepared.durationSec).toBeCloseTo(line.length / KIT_RATE, 3);
    expect(prepared.suggestedKind).toBe('solo');
    expect(preparedKind(prepared)).toBe('solo');
    expect(prepared.blockers).toEqual([]);
    expect(prepared.warnings).toEqual([]);
    expect(prepared.phrases).toHaveLength(5);
    expect(prepared.phrases.every((p) => !p.fragment)).toBe(true);
    expect(prepared.analysis.mode).toBeUndefined();
    expect(prepared.options).toEqual({ voiceType: 'tenor', a4Hz: 440 });
    expect(prepared.sourceKind).toBe('audio');
    expect(prepared.fingerprint).toMatch(/^\d+:\d+:[0-9a-f]{16}$/);
    expect(prepared.fingerprint.startsWith(`${file.size}:${Math.round(prepared.durationSec * 1000)}:`)).toBe(true);

    const phases = [...new Set(events.map((e) => e.phase))];
    expect(phases).toEqual(['reading', 'decoding', 'analysing', 'segmenting']);
    expect(events.every((e) => e.name === 'Verse and chorus.wav' && e.fileIndex === 0 && e.fileCount === 1)).toBe(true);
    expect(events.every((e) => e.fraction >= 0 && e.fraction <= 1)).toBe(true);
    const analysing = events.filter((e) => e.phase === 'analysing').map((e) => e.fraction);
    expect(analysing[analysing.length - 1]).toBe(1);
    expect([...analysing].sort((a, b) => a - b)).toEqual(analysing);
  }, 30000);

  it('carries the position in a batch and the tuning from the settings into the analysis', async () => {
    const seen: number[] = [];
    const analyze: ImportDeps['analyze'] = async (s, sr, opts, p) => {
      seen.push(opts.a4Hz ?? 0);
      return analyzeTake(s, sr, { ...opts, mode: undefined }, p);
    };
    const events: ImportProgress[] = [];
    await prepareClip(wavFile(soloLine({ count: 1 }), KIT_RATE, 'a.wav'), { ...SETTINGS, a4Hz: 432 }, (p) => events.push(p), { index: 2, count: 4, deps: { analyze } });
    expect(seen).toEqual([432]);
    expect(events.every((e) => e.fileIndex === 2 && e.fileCount === 4)).toBe(true);
  }, 30000);

  it('reduces a high sample rate to 48 kHz before analysing', async () => {
    const decode: ImportDeps['decode'] = async () => ({ samples: sine(300, 2, 96000, 0.3), sampleRate: 96000, durationSec: 2, sourceDurationSec: 2, notices: [] });
    const analyze = vi.fn(async (_s: Float32Array, sr: number) => ({ ...analysisFromSpans([{ start: 0.2, end: 1.8 }], 2), sampleRate: sr }));
    const prepared = await prepareClip(wavFile(sine(300, 0.1, 8000), 8000), SETTINGS, undefined, { deps: { decode, analyze } });
    expect(prepared.sampleRate).toBe(48000);
    expect(prepared.samples.length).toBeCloseTo(96000, -2);
    expect(prepared.durationSec).toBeCloseTo(2, 2);
    expect(analyze.mock.calls[0][1]).toBe(48000);
  });

  it('tells the user when only the first five minutes of a long file are used', async () => {
    const decode: ImportDeps['decode'] = async () => ({ samples: sine(300, 3, 8000, 0.3), sampleRate: 8000, durationSec: 300, sourceDurationSec: 612, notices: ['Stereo note.'] });
    const analyze = async () => analysisFromSpans([{ start: 0.2, end: 2.8 }], 3);
    const prepared = await prepareClip(wavFile(sine(300, 0.1, 8000), 8000, 'Long take.wav'), SETTINGS, undefined, { deps: { decode, analyze } });
    expect(prepared.notices).toHaveLength(2);
    expect(prepared.notices[0]).toBe('Stereo note.');
    expect(prepared.notices[1]).toMatch(/Only the first 5 minutes of Long take.wav \(10\.2 minutes long\) were used/);
  });

  it('works without crypto.subtle (plain HTTP pages) by falling back to a simple hash', async () => {
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a, randomUUID: () => 'x' });
    try {
      const prepared = await prepareClip(wavFile(soloLine({ count: 1 }), KIT_RATE, 'a.wav'), SETTINGS, undefined, { deps: withoutMixSupport });
      expect(prepared.fingerprint).toMatch(/^\d+:\d+:[0-9a-f]{16}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30000);

  it('uses the default worker entry when no analyzer is injected', async () => {
    const prepared = await prepareClip(wavFile(soloLine({ count: 2 }), KIT_RATE, 'two.wav'), SETTINGS);
    expect(prepared.phrases.length).toBeGreaterThanOrEqual(1);
    expect(prepared.blockers).toEqual([]);
  }, 30000);
});

describe('prepareClip: a melody over a band', () => {
  it('detects the full song and runs the full-song front end, keeping the solo reading for the toggle', async () => {
    const analyzeCalls: (string | undefined)[] = [];
    const analyze: ImportDeps['analyze'] = (s, sr, opts, p) => {
      analyzeCalls.push(opts.mode);
      return withMixSupport.analyze(s, sr, opts, p);
    };
    const events: ImportProgress[] = [];
    const prepared = await prepareClip(wavFile(band, KIT_RATE, 'Song.wav'), SETTINGS, (p) => events.push(p), { deps: { analyze } });
    expect(analyzeCalls).toEqual(['solo', 'mix']);
    expect(prepared.suggestedKind).toBe('mix');
    expect(preparedKind(prepared)).toBe('mix');
    expect(prepared.analysis.mode).toBe('mix');
    expect(prepared.blockers).toEqual([]);
    expect(prepared.warnings[0]).toBe(MIX_REASON);
    expect(prepared.phrases.length).toBeGreaterThanOrEqual(1);
    expect(prepared.views?.solo?.analysis.mode).toBeUndefined();
    expect(prepared.views?.mix?.analysis.mode).toBe('mix');
    const analysing = events.filter((e) => e.phase === 'analysing').map((e) => e.fraction);
    expect(analysing[analysing.length - 1]).toBe(1);
    expect([...analysing].sort((a, b) => a - b)).toEqual(analysing);
  }, 60000);

  it('reads the song in the worker path by default: solo first, then the lead vocal, with a confidence', async () => {
    const prepared = await prepareClip(wavFile(band, KIT_RATE, 'Song.wav'), SETTINGS);
    expect(prepared.analysis.mode).toBe('mix');
    expect(preparedKind(prepared)).toBe('mix');
    expect(prepared.blockers).toEqual([]);
    const lead = leadConfidenceOf(prepared.analysis);
    expect(lead).not.toBeNull();
    expect(lead!.confidence).toBeGreaterThan(0);
    expect(['high', 'ok', 'low', 'poor']).toContain(lead!.band);
    expect(leadConfidenceOf(prepared.views!.solo!.analysis)).toBeNull();
  }, 60000);

  it('adds the extractor\'s own warning when the lead vocal was hard to follow, and none when it was easy', () => {
    const hard = analysisFromSpans([{ start: 1, end: 12 }], 14, { mode: 'mix', issues: ['accompaniment'] });
    (hard as VoiceAnalysis & { leadExtraction: { confidence: number; sideToMidDb: null } }).leadExtraction = { confidence: 0.62, sideToMidDb: null };
    const view = buildView('mix', hard);
    expect(view.warnings[0]).toBe(MIX_REASON);
    expect(view.warnings.join(' ')).toMatch(/very hard to follow/);
    expect(leadConfidenceOf(hard)).toMatchObject({ band: 'poor' });

    const easy = analysisFromSpans([{ start: 1, end: 12 }], 14, { mode: 'mix', issues: ['accompaniment'] });
    (easy as VoiceAnalysis & { leadExtraction: { confidence: number; sideToMidDb: null } }).leadExtraction = { confidence: 0.9, sideToMidDb: null };
    expect(buildView('mix', easy).warnings).toEqual([MIX_REASON]);
  });

  it('blocks a full song whose lead vocal is too short, with words for songs rather than for solo clips', () => {
    const brief = analysisFromSpans([{ start: 1, end: 2 }], 8, { mode: 'mix', issues: ['accompaniment', 'too-little-singing'] });
    const view = buildView('mix', brief);
    expect(view.blockers).toHaveLength(1);
    expect(view.blockers[0]).toMatch(/lead vocal/);
    expect(view.blockers[0]).toMatch(/vocal-only version/);
    expect(view.phrases).toEqual([]);
  });

  it('shows the solo reading with the reason and a way to retry when the automatic full-song pass fails', async () => {
    let calls = 0;
    const analyze: ImportDeps['analyze'] = async (s, sr, opts, p) => {
      if (opts.mode === 'mix' && calls++ === 0) throw new Error('The analysis worker stopped unexpectedly.');
      return withMixSupport.analyze(s, sr, opts, p);
    };
    const prepared = await prepareClip(wavFile(band, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { deps: { analyze } });
    expect(preparedKind(prepared)).toBe('solo');
    expect(prepared.suggestedKind).toBe('mix');
    expect(prepared.warnings[0]).toMatch(/could not follow the lead vocal automatically \(The analysis worker stopped unexpectedly\)/);
    expect(prepared.warnings[0]).toMatch(/Switch on "This is a full song"/);
    expect(prepared.warnings.join(' ')).not.toMatch(/sounds like it has instruments/);
    expect(prepared.views?.mix).toBeUndefined();
    // The toggle runs the full-song pass again, and this time it works.
    const again = await reanalyzeClip(prepared, 'mix', undefined, { deps: { analyze } });
    expect(preparedKind(again)).toBe('mix');
    expect(again.analysis.mode).toBe('mix');
    expect(again.blockers).toEqual([]);
  }, 60000);

  it('does not pass a solo reading off as a full song when the analyzer ignores the mode', async () => {
    const prepared = await prepareClip(wavFile(band, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { deps: withoutMixSupport });
    expect(preparedKind(prepared)).toBe('solo');
    expect(prepared.analysis.mode).toBeUndefined();
    expect(prepared.warnings[0]).toMatch(/could not follow the lead vocal automatically \(The full-song reading did not run\)/);
    await expect(reanalyzeClip(prepared, 'mix', undefined, { deps: withoutMixSupport })).rejects.toThrow(/did not run/);
  }, 60000);

  it('lets the user say "this is solo" after all: the solo reading is already there and carries a warning', async () => {
    const analyze = vi.fn(withMixSupport.analyze);
    const prepared = await prepareClip(wavFile(band, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { deps: { analyze } });
    const calls = analyze.mock.calls.length;
    const solo = await reanalyzeClip(prepared, 'solo', undefined, { deps: { analyze } });
    expect(analyze.mock.calls.length).toBe(calls);
    expect(preparedKind(solo)).toBe('solo');
    expect(solo.blockers).toEqual([]);
    expect(solo.warnings[0]).toMatch(/sounds like it has instruments/);
    expect(solo.phrases.length).toBeGreaterThanOrEqual(1);
    // And back again without a new analysis.
    const again = await reanalyzeClip(solo, 'mix', undefined, { deps: { analyze } });
    expect(analyze.mock.calls.length).toBe(calls);
    expect(again.blockers).toEqual([]);
    expect(again.analysis.mode).toBe('mix');
  }, 60000);
});

describe('prepareClip: clips that cannot be used', () => {
  it('blocks speech and says what to do', async () => {
    const prepared = await prepareClip(wavFile(speech, KIT_RATE, 'talking.wav'), SETTINGS, undefined, { deps: withoutMixSupport });
    expect(prepared.suggestedKind).toBe('solo');
    expect(prepared.blockers).toEqual([SPEECH_REASON]);
    expect(prepared.phrases).toEqual([]);
  }, 30000);

  it('blocks a clip with too little singing, and one with none', async () => {
    const short = await prepareClip(wavFile(soloLine({ count: 1, noteCount: 2 }), KIT_RATE, 'two-notes.wav'), SETTINGS, undefined, { deps: withoutMixSupport });
    expect(short.blockers).toHaveLength(1);
    expect(short.blockers[0]).toMatch(/clear singing could be heard/);
    expect(short.phrases).toEqual([]);
    const none = await prepareClip(wavFile(roomNoise(5), KIT_RATE, 'hiss.wav'), SETTINGS, undefined, { deps: withoutMixSupport });
    expect(none.blockers[0]).toMatch(/No clear singing/);
  }, 30000);

  it('warns, but does not block, about a noisy recording', async () => {
    const noisy = soloLine({ count: 3 }).map((v, i) => v + 0.12 * Math.sin(i * 12.9898) * Math.sin(i * 78.233));
    const prepared = await prepareClip(wavFile(noisy, KIT_RATE, 'noisy.wav'), SETTINGS, undefined, { deps: withoutMixSupport });
    if (prepared.analysis.issues.includes('noisy')) expect(prepared.warnings.join(' ')).toMatch(/background noise/);
    expect(prepared.blockers.every((b) => !/noise/.test(b))).toBe(true);
  }, 30000);

  it('rejects undecodable, empty and protected files with the decoder\'s message', async () => {
    await expect(prepareClip(new File([], 'empty.wav'), SETTINGS)).rejects.toThrow(/"empty.wav" is empty/);
    const protectedErr = await prepareClip(new File([new Uint8Array(40)], 'Song.m4p'), SETTINGS).catch((e: unknown) => e);
    expect(protectedErr).toBeInstanceOf(DecodeError);
    expect((protectedErr as Error).message).toMatch(/copy-protected.*DRM-free copy of a song you own/);
  });

  it('can be cancelled before it starts and while it analyses', async () => {
    const early = new AbortController();
    early.abort();
    await expect(prepareClip(wavFile(line, KIT_RATE), SETTINGS, undefined, { signal: early.signal })).rejects.toMatchObject({ name: 'AbortError' });

    const late = new AbortController();
    const analyze: ImportDeps['analyze'] = async (s, sr, opts, p) => {
      const out = await withoutMixSupport.analyze(s, sr, opts, p);
      late.abort();
      return out;
    };
    await expect(prepareClip(wavFile(soloLine({ count: 2 }), KIT_RATE), SETTINGS, undefined, { signal: late.signal, deps: { analyze } })).rejects.toMatchObject({ name: 'AbortError' });
  }, 30000);
});

describe('prepareClip: phone videos', () => {
  function stubVideoDecoder(samples: Float32Array, rate: number) {
    const decodeAudioData = vi.fn(async () => fakeAudioBuffer(samples, rate, 2));
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData = decodeAudioData;
      },
    );
    return decodeAudioData;
  }

  it('reads the audio track of a .mov, says so, and finds the phrases', async () => {
    const decodeAudioData = stubVideoDecoder(soloLine({ count: 3 }), KIT_RATE);
    try {
      const prepared = await prepareClip(movFile(30, 'IMG_0042.MOV'), SETTINGS, undefined, { deps: withoutMixSupport });
      expect(decodeAudioData).toHaveBeenCalledTimes(1);
      expect(prepared.sourceKind).toBe('video');
      expect(prepared.notices[0]).toBe('Used the sound of the video.');
      expect(prepared.sampleRate).toBe(KIT_RATE);
      expect(prepared.blockers).toEqual([]);
      expect(prepared.phrases).toHaveLength(3);
      expect(prepared.fingerprint).toMatch(/^\d+:\d+:[0-9a-f]{16}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 30000);

  it('refuses a video that is too big or too long, naming the Shortcuts route, without decoding anything', async () => {
    const decodeAudioData = stubVideoDecoder(new Float32Array(100), 8000);
    try {
      const tooBig = { size: 160 * 1024 * 1024, name: 'concert.mov', type: 'video/quicktime', arrayBuffer: async () => new ArrayBuffer(8), slice: undefined } as unknown as File;
      const err = await prepareClip(tooBig, SETTINGS).catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/160 MB video, more than this app can open at once/);
      expect((err as Error).message).toContain('"Encode Media" action with Audio Only');
      expect((err as Error).message).toContain('share it to Files');

      const tooLong = await prepareClip(movFile(25 * 60, 'long.mov'), SETTINGS).catch((e: unknown) => e);
      expect((tooLong as DecodeError).reason).toBe('too-long');
      expect((tooLong as Error).message).toMatch(/about 25 minutes long/);
      expect(decodeAudioData).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('reanalyzeClip and the vocal-only stem', () => {
  it('switches a solo clip to the full-song reading once and caches it', async () => {
    const analyze = vi.fn(withMixSupport.analyze);
    const prepared = await prepareClip(wavFile(soloLine({ count: 3 }), KIT_RATE, 'a.wav'), SETTINGS, undefined, { deps: { analyze } });
    expect(analyze).toHaveBeenCalledTimes(1);
    await expect(reanalyzeClip(prepared, 'solo')).resolves.toBe(prepared);
    const mix = await reanalyzeClip(prepared, 'mix', undefined, { deps: { analyze } });
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(analyze.mock.calls[1][2]).toMatchObject({ mode: 'mix', voiceType: 'tenor' });
    expect(preparedKind(mix)).toBe('mix');
    expect(mix.analysis.mode).toBe('mix');
    expect(mix.suggestedKind).toBe('solo'); // the app's first verdict is kept
    const back = await reanalyzeClip(mix, 'solo', undefined, { deps: { analyze } });
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(back.phrases).toEqual(prepared.phrases);
  }, 60000);

  it('falls back to default options for a prepared clip that carries none', async () => {
    const fake = makeFakePreparedClip();
    const analyze = vi.fn(async (_s: Float32Array, _sr: number, _o: AnalysisOptions) => analysisFromSpans([{ start: 1, end: 8 }], 10, { mode: 'mix' }));
    const mix = await reanalyzeClip(fake, 'mix', undefined, { deps: { analyze } });
    expect(analyze.mock.calls[0][2]).toEqual({ voiceType: 'tenor', a4Hz: 440, mode: 'mix' });
    expect(preparedKind(mix)).toBe('mix');
    expect(mix.phrases.length).toBeGreaterThan(0);
  });

  it('pairs a song with its vocal-only file when they are the same length and the stem has singing', () => {
    const mix = makeFakePreparedClip({ durationSec: 60, suggestedKind: 'mix', phrases: [] });
    const stem = makeFakePreparedClip({ durationSec: 60.1 });
    expect(stemProblem(mix, stem)).toBeNull();
    const paired = withVocalStem(mix, stem);
    expect(paired.stem).toBe(stem);
    expect(blockersOf(paired)).toEqual([]);
    expect(effectiveAnalysis(paired)).toBe(stem.analysis);
    expect(withoutVocalStem(paired).stem).toBeUndefined();

    expect(stemProblem(mix, makeFakePreparedClip({ durationSec: 61 }))).toMatch(/61\.0 s long but the song is 60\.0 s.*same length/);
    expect(stemProblem(mix, makeFakePreparedClip({ durationSec: 60, blockers: ['No clear singing could be heard in this clip.'] }))).toBe('No clear singing could be heard in this clip.');
    expect(() => withVocalStem(mix, makeFakePreparedClip({ durationSec: 90 }))).toThrow(/same length/);
  });

  it('reads a file the user calls the vocal as a single voice, even when it still sounds like it has a band', async () => {
    const mix = await prepareClip(wavFile(band, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { deps: withMixSupport });
    // The "stem" is itself flagged as a full song; its solo reading was kept when it was prepared.
    const flagged = await prepareClip(wavFile(band, KIT_RATE, 'Not really a stem.wav'), SETTINGS, undefined, { deps: withMixSupport });
    expect(preparedKind(flagged)).toBe('mix');
    const solo = normalizeStem(flagged);
    expect(solo).not.toBeNull();
    expect(preparedKind(solo!)).toBe('solo');
    expect(solo!.analysis.mode).toBeUndefined();
    expect(solo!.warnings[0]).toMatch(/sounds like it has instruments/);
    expect(stemProblem(mix, flagged)).toBeNull();
    const paired = withVocalStem(mix, flagged);
    expect(preparedKind(paired.stem!)).toBe('solo');
    expect(effectiveAnalysis(paired).mode).toBeUndefined();
    // Without a solo reading to fall back on there is nothing to use.
    expect(normalizeStem({ ...flagged, views: undefined })).toBeNull();
    expect(stemProblem(mix, { ...flagged, views: undefined })).toMatch(/could not be read as a single voice/);
    expect(normalizeStem(makeFakePreparedClip())).not.toBeNull();
  }, 60000);

  it('says whether a clip can count toward a singer\'s targets', async () => {
    const solo = await prepareClip(wavFile(line, KIT_RATE, 'a.wav'), SETTINGS, undefined, { deps: withoutMixSupport });
    expect(targetEligibility(solo, 'solo').eligible).toBe(true);
    expect(targetEligibility(solo, 'mix')).toMatchObject({ eligible: false });
    expect(targetEligibility(solo, 'mix').reason).toMatch(/Full songs cannot count/);
    const short = makeFakePreparedClip({ analysis: analysisFromSpans([{ start: 1, end: 3 }], 4) });
    expect(targetEligibility(short, 'solo').eligible).toBe(false);
    expect(targetEligibility(short, 'solo').reason).toMatch(/too little/);
  }, 30000);
});

describe('commitClip', () => {
  let prepared: PreparedClip;
  beforeAll(async () => {
    prepared = await prepareClip(wavFile(line, KIT_RATE, 'Chorus take.wav'), SETTINGS, undefined, { deps: withoutMixSupport });
  }, 30000);

  const whole = () => ({ startSec: 0, endSec: prepared.durationSec });

  it('stores the audio and the clip record with its phrases, and nothing else', async () => {
    const store = createMemoryClipStore();
    const events: ImportProgress[] = [];
    const { clip, measured } = await commitClip(prepared, edits(prepared, { title: '  Chorus  ', trim: whole() }), store, (p) => events.push(p));

    expect(measured).toBeNull();
    expect(await store.getClip(clip.id)).toEqual(clip);
    expect(clip).toMatchObject({
      schema: 1,
      title: 'Chorus',
      singerId: null,
      singerLabel: '',
      sourceFileName: 'Chorus take.wav',
      sourceBytes: prepared.file.size,
      kind: 'solo',
      analysisKind: 'solo',
      audioMissing: false,
      contributesToSinger: false,
      notes: '',
      tags: [],
    });
    expect(clip.fingerprint).toBe(prepared.fingerprint);
    expect(clip.durationSec).toBeCloseTo(prepared.durationSec, 3);
    expect(clip.audio.mix).toMatchObject({ kind: 'mix', sampleRate: KIT_RATE, frames: prepared.samples.length });
    expect(clip.audio.vocal).toBeNull();
    expect(clip.addedAt).toBe(clip.updatedAt);
    expect(clip.ownedConfirmedAt).toBe(clip.addedAt);
    expect([1, 2, 3]).toContain(clip.difficulty);
    expect(clip.analysis).toMatchObject({ analysisVersion: 1, voiceType: 'tenor', a4Hz: 440, usableAsTarget: true, unusableReason: null, issues: [] });
    expect(clip.analysis.voicedSec).toBeGreaterThan(15);
    expect(clip.analysis.pitch.medianMidi).not.toBeNull();

    expect(clip.phrases).toHaveLength(5);
    expect(new Set(clip.phrases.map((p) => p.id)).size).toBe(5);
    expect(clip.phrases.map((p) => p.index)).toEqual([0, 1, 2, 3, 4]);
    for (const p of clip.phrases) {
      expect(p.summary?.noteCount).toBeGreaterThan(3);
      expect(p.summary?.lowMidi).not.toBeNull();
      expect(p.hidden).toBe(false);
      expect(p.stats.attempts).toBe(0);
      expect(p.end).toBeLessThanOrEqual(clip.durationSec + 1e-9);
    }

    // The stored audio is the clip, to Int16 precision.
    const back = await store.readAudio(clip.id, clip.audio.mix, 0, clip.durationSec);
    expect(back.length).toBe(prepared.samples.length);
    let worst = 0;
    for (let i = 0; i < back.length; i += 97) worst = Math.max(worst, Math.abs(back[i] - prepared.samples[i]));
    expect(worst).toBeLessThan(1 / 16000);

    expect((await store.listClips()).map((c) => c.id)).toEqual([clip.id]);
    expect(events.every((e) => e.phase === 'storing')).toBe(true);
    expect(events[events.length - 1].fraction).toBe(1);
  }, 30000);

  it('keeps only the span with singing by default and writes where the excerpt starts into the fingerprint', async () => {
    const store = createMemoryClipStore();
    const { clip } = await commitClip(prepared, edits(prepared), store);
    expect(clip.durationSec).toBeLessThan(prepared.durationSec);
    expect(clip.durationSec).toBeGreaterThan(prepared.durationSec - 2.6);
    const start = trimStartOf(clip.fingerprint);
    expect(start).toBeCloseTo(prepared.phrases[0].voicedStart - 1, 1);
    expect(sourceFingerprint(clip.fingerprint)).toBe(prepared.fingerprint);
    expect(sameSource(clip.fingerprint, prepared.fingerprint)).toBe(true);
    // Phrases are in the excerpt's time.
    expect(clip.phrases[0].voicedStart).toBeCloseTo(prepared.phrases[0].voicedStart - start, 2);
    expect(clip.phrases[clip.phrases.length - 1].end).toBeLessThanOrEqual(clip.durationSec + 1e-9);
    // The audio matches the original from the offset on.
    const back = await store.readAudio(clip.id, clip.audio.mix, 3, 4);
    const from = Math.round((start + 3) * KIT_RATE);
    let worst = 0;
    for (let i = 0; i < back.length; i += 53) worst = Math.max(worst, Math.abs(back[i] - prepared.samples[from + i]));
    expect(worst).toBeLessThan(1 / 16000);
  }, 30000);

  it('keeps a chosen span, clips the phrases it cuts and drops the ones it leaves out', async () => {
    const store = createMemoryClipStore();
    const p2 = prepared.phrases[1];
    const p4 = prepared.phrases[3];
    const { clip } = await commitClip(prepared, edits(prepared, { trim: { startSec: p2.start, endSec: p4.end } }), store);
    expect(clip.phrases).toHaveLength(3);
    expect(clip.phrases[0].start).toBeCloseTo(0, 2);
    expect(clip.durationSec).toBeCloseTo(p4.end - p2.start, 2);
    expect(clip.phrases.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(trimStartOf(clip.fingerprint)).toBeCloseTo(p2.start, 2);
  }, 30000);

  it('uses what the user edited: hidden phrases are stored hidden, and a clip with none visible is refused', async () => {
    const store = createMemoryClipStore();
    const { clip } = await commitClip(prepared, edits(prepared, { trim: whole(), phrases: setHidden(prepared.phrases, 2, true) }), store);
    expect(clip.phrases.map((p) => p.hidden)).toEqual([false, false, true, false, false]);
    let allHidden = prepared.phrases;
    for (let i = 0; i < allHidden.length; i++) allHidden = setHidden(allHidden, i, true);
    await expect(commitClip(prepared, edits(prepared, { phrases: allHidden }), createMemoryClipStore())).rejects.toThrow(/Keep at least one phrase/);
    await expect(commitClip(prepared, edits(prepared, { trim: { startSec: 0, endSec: 1 } }), createMemoryClipStore())).rejects.toThrow(/No phrase is left inside the part you chose/);
  }, 30000);

  it('refuses without the ownership tick, and for a clip with blockers', async () => {
    const store = createMemoryClipStore();
    await expect(commitClip(prepared, { ...edits(prepared), ownedConfirmed: false as unknown as true }, store)).rejects.toThrow(/Confirm that this is a file you own/);
    const speechPrepared = await prepareClip(wavFile(speech, KIT_RATE, 'talk.wav'), SETTINGS, undefined, { deps: withoutMixSupport });
    await expect(commitClip(speechPrepared, edits(speechPrepared, { phrases: [] }), store)).rejects.toThrow(/speech-like/);
    expect(await store.listClips()).toEqual([]);
  }, 30000);

  it('counts a usable solo clip toward its singer\'s targets when asked, and hands back the measurements', async () => {
    const store = createMemoryClipStore();
    const { clip, measured } = await commitClip(prepared, edits(prepared, { singerId: 'shawn-mendes', singerLabel: 'ignored', contributeToSinger: true, title: 'Study clip' }), store);
    expect(clip.contributesToSinger).toBe(true);
    expect(clip.singerId).toBe('shawn-mendes');
    expect(clip.singerLabel).toBe('');
    expect(measured).not.toBeNull();
    expect(measured).toMatchObject({ id: clip.id, name: 'Study clip', addedAt: clip.addedAt });
    expect(measured!.voicedSec).toBeCloseTo(prepared.analysis.voicedSec, 3);
    expect(measured!.style).toEqual(prepared.analysis.style);
  }, 30000);

  it('weights a trimmed clip by the singing in the kept excerpt, the same numbers a later "add to targets" tap builds', async () => {
    const store = createMemoryClipStore();
    const keep = { startSec: 0, endSec: Math.min(prepared.durationSec, 6) };
    const { clip, measured } = await commitClip(prepared, edits(prepared, { singerId: 'shawn-mendes', contributeToSinger: true, trim: keep }), store);
    expect(measured).toEqual(measuredFromClip(clip));
    expect(clip.durationSec).toBeLessThan(prepared.durationSec);
    expect(measured!.durationSec).toBeCloseTo(clip.analysis.durationSec, 6);
    expect(measured!.voicedSec).toBeLessThan(prepared.analysis.voicedSec);
    expect(measured!.voicedSec).toBeCloseTo(clip.analysis.voicedSec, 6);
    // Style and range are the whole reading's numbers; only the singing-time weight follows the excerpt.
    expect(measured!.style).toEqual(prepared.analysis.style);
  }, 30000);

  it('never counts a clip toward targets when it is for someone else, a full song, or has too little singing', async () => {
    const store = createMemoryClipStore();
    const someone = await commitClip(prepared, edits(prepared, { singerId: null, singerLabel: '  A friend ', contributeToSinger: true }), store);
    expect(someone.measured).toBeNull();
    expect(someone.clip.contributesToSinger).toBe(false);
    expect(someone.clip.singerLabel).toBe('A friend');

    const mixed = await commitClip(prepared, edits(prepared, { kind: 'mix', singerId: 'shawn-mendes', contributeToSinger: true }), store, undefined, { deps: withMixSupport });
    expect(mixed.measured).toBeNull();
    expect(mixed.clip.contributesToSinger).toBe(false);
    expect(mixed.clip.kind).toBe('mix');
    expect(mixed.clip.analysisKind).toBe('mix-melody');
    expect(mixed.clip.analysis.usableAsTarget).toBe(false);
    expect(mixed.clip.analysis.unusableReason).toMatch(/Full songs cannot count/);

    const briefly = await prepareClip(wavFile(soloLine({ count: 1, noteCount: 7 }), KIT_RATE, 'brief.wav'), SETTINGS, undefined, { deps: withoutMixSupport });
    expect(briefly.blockers).toEqual([]);
    const shortOne = await commitClip(briefly, edits(briefly, { singerId: 'shawn-mendes', contributeToSinger: true }), store);
    expect(shortOne.clip.analysis.usableAsTarget).toBe(false);
    expect(shortOne.measured).toBeNull();
    expect(shortOne.clip.contributesToSinger).toBe(false);
  }, 60000);

  it('re-reads the clip as a full song when the edits say so', async () => {
    const analyze = vi.fn(withMixSupport.analyze);
    const store = createMemoryClipStore();
    const { clip } = await commitClip(prepared, edits(prepared, { kind: 'mix', trim: whole() }), store, undefined, { deps: { analyze } });
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0][2]).toMatchObject({ mode: 'mix' });
    expect(clip.kind).toBe('mix');
  }, 60000);

  it('stores a vocal-only stem next to the song and analyses phrases from the stem', async () => {
    const stemWav = wavFile(soloLine({ count: 4, sampleRate: 16000 }), 16000, 'vocals.wav');
    const stem = await prepareClip(stemWav, SETTINGS, undefined, { deps: withoutMixSupport });
    const mix = await prepareClip(wavFile(band, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { deps: withMixSupport });
    expect(mix.blockers).toEqual([]);
    expect(mix.analysis.mode).toBe("mix");
    expect(Math.abs(mix.durationSec - stem.durationSec)).toBeLessThan(0.2);

    const paired = withVocalStem(mix, stem);
    const store = createMemoryClipStore();
    const { clip, measured } = await commitClip(paired, edits(paired, { kind: 'mix', trim: { startSec: 0, endSec: mix.durationSec }, contributeToSinger: true, singerId: 'shawn-mendes' }), store);
    expect(measured).toBeNull();
    expect(clip.kind).toBe('mix');
    expect(clip.analysisKind).toBe('solo');
    expect(clip.audio.mix).toMatchObject({ kind: 'mix', sampleRate: KIT_RATE });
    expect(clip.audio.vocal).toMatchObject({ kind: 'vocal', sampleRate: 16000 });
    expect(clip.phrases.length).toBe(stem.phrases.length);
    const vocal = await store.readAudio(clip.id, clip.audio.vocal!, 0, 5);
    expect(vocal.length).toBe(5 * 16000);
    expect(clip.analysis.issues).not.toContain('accompaniment');
    expect(estimateStoredBytes(paired, { startSec: 0, endSec: 10 })).toBe(10 * KIT_RATE * 2 + 10 * 16000 * 2);
    expect(estimateStoredBytes(withoutVocalStem(paired), { startSec: 0, endSec: 10 })).toBe(10 * KIT_RATE * 2);

    await expect(commitClip(paired, edits(paired, { kind: 'mix', vocalStem: makeFakePreparedClip({ durationSec: 99 }) }), createMemoryClipStore())).rejects.toThrow(/same length/);
  }, 60000);

  describe('when the store fails', () => {
    function wrapped(base: ClipStore, fail: { vocal?: boolean; put?: boolean; mix?: boolean }): ClipStore {
      return {
        ...base,
        writeAudio: async (id, kind, pcm, sr) => {
          if ((kind === 'vocal' && fail.vocal) || (kind === 'mix' && fail.mix)) throw new QuotaError('Not enough room on this device.');
          return base.writeAudio(id, kind, pcm, sr);
        },
        putClip: async (c) => {
          if (fail.put) throw new Error('The library could not save the clip.');
          return base.putClip(c);
        },
      };
    }

    it('stores nothing when the song does not fit', async () => {
      const base = createMemoryClipStore();
      await expect(commitClip(prepared, edits(prepared), wrapped(base, { mix: true }))).rejects.toBeInstanceOf(QuotaError);
      expect(await base.listClips()).toEqual([]);
    }, 30000);

    it('takes back the written audio when the clip record cannot be saved', async () => {
      const base = createMemoryClipStore();
      const deleted: string[] = [];
      const store: ClipStore = { ...wrapped(base, { put: true }), deleteAudio: async (id, kind) => (deleted.push(kind), base.deleteAudio(id, kind)) };
      await expect(commitClip(prepared, edits(prepared), store)).rejects.toThrow(/could not save the clip/);
      expect(deleted).toEqual(['mix']);
      expect(await base.listClips()).toEqual([]);
    }, 30000);

    it('takes back the song audio when the stem does not fit', async () => {
      const stem = await prepareClip(wavFile(soloLine({ count: 4 }), KIT_RATE, 'v.wav'), SETTINGS, undefined, { deps: withoutMixSupport });
      const mix = await prepareClip(wavFile(band, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { deps: withMixSupport });
      const base = createMemoryClipStore();
      const deleted: string[] = [];
      const store: ClipStore = { ...wrapped(base, { vocal: true }), deleteAudio: async (id, kind) => (deleted.push(kind), base.deleteAudio(id, kind)) };
      const paired = withVocalStem(mix, stem);
      await expect(commitClip(paired, edits(paired, { kind: 'mix' }), store)).rejects.toBeInstanceOf(QuotaError);
      expect(deleted).toEqual(['mix']);
      expect(await base.listClips()).toEqual([]);
    }, 60000);
  });
});

describe('relinkAudio', () => {
  let file: File;
  let prepared: PreparedClip;
  let original: ClipRecord;
  let originalStore: ClipStore;

  beforeAll(async () => {
    file = wavFile(soloLine({ count: 4 }), KIT_RATE, 'Song.wav');
    prepared = await prepareClip(file, SETTINGS, undefined, { deps: withoutMixSupport });
    originalStore = createMemoryClipStore();
    original = (await commitClip(prepared, edits(prepared), originalStore)).clip;
  }, 30000);

  /** What a library import leaves behind: the record with its history, no audio. */
  function lost(): { clip: ClipRecord; store: ClipStore } {
    const clip: ClipRecord = {
      ...original,
      audioMissing: true,
      phrases: original.phrases.map((p, i) => ({ ...p, stats: { ...p.stats, attempts: i + 1, best: 80 }, keyHint: -12 })),
    };
    return { clip, store: createMemoryClipStore() };
  }

  it('re-attaches the audio of the same file at the right offset and keeps phrases and history', async () => {
    const { clip, store } = lost();
    expect(trimStartOf(clip.fingerprint)).toBeGreaterThan(0);
    const again = await prepareClip(file, SETTINGS, undefined, { deps: withoutMixSupport });
    expect(findRelinkMatches([clip], again)).toEqual([clip]);
    const relinked = await relinkAudio(clip, again, store);
    expect(relinked.audioMissing).toBe(false);
    expect(relinked.phrases).toEqual(clip.phrases);
    expect(relinked.title).toBe(clip.title);
    expect(relinked.audio.mix.frames).toBeCloseTo(clip.audio.mix.frames, -1);
    expect(relinked.analysisKind).toBe('solo');
    expect(await store.getClip(clip.id)).toEqual(relinked);
    // The audio equals what was stored the first time.
    const a = await store.readAudio(clip.id, relinked.audio.mix, 2, 6);
    const b = await originalStore.readAudio(original.id, original.audio.mix, 2, 6);
    expect(a.length).toBe(b.length);
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    expect(worst).toBeLessThan(1e-6);
  }, 30000);

  it('refuses a different file, a clip that still has its audio, and a file that is too short', async () => {
    const { clip, store } = lost();
    const other = await prepareClip(wavFile(soloLine({ count: 2, noteCount: 6 }), KIT_RATE, 'Other.wav'), SETTINGS, undefined, { deps: withoutMixSupport });
    expect(findRelinkMatches([clip], other)).toEqual([]);
    await expect(relinkAudio(clip, other, store)).rejects.toThrow(/does not look like the file for "My clip" \(Song.wav\)/);
    await expect(relinkAudio(original, prepared, store)).rejects.toThrow(/already has its audio/);

    // Same name and nearly the same length passes the match, but a truncated take does not have the excerpt.
    const shortAgain = { ...prepared, durationSec: clip.durationSec, samples: prepared.samples.slice(0, Math.round(2 * KIT_RATE)), fingerprint: 'x:1:y' };
    await expect(relinkAudio(clip, shortAgain, store)).rejects.toThrow(/shorter than "My clip" should be/);
    expect(await store.listClips()).toEqual([]);
  }, 30000);

  it('matches by file name and length when the fingerprint differs (a re-exported copy)', async () => {
    const { clip } = lost();
    const whole = { ...clip, fingerprint: 'other:1:hash', durationSec: prepared.durationSec };
    const copy = { ...prepared, fingerprint: 'new:2:hash' };
    expect(findRelinkMatches([whole], copy)).toEqual([whole]);
    expect(findRelinkMatches([{ ...whole, sourceFileName: 'Different.wav' }], copy)).toEqual([]);
    expect(findRelinkMatches([{ ...whole, durationSec: whole.durationSec + 1 }], copy)).toEqual([]);
    expect(findRelinkMatches([{ ...whole, audioMissing: false }], copy)).toEqual([]);
  });

  it('needs the stem again for a clip that had one, and otherwise falls back to the full mix', async () => {
    const stem = await prepareClip(wavFile(soloLine({ count: 4 }), KIT_RATE, 'vocals.wav'), SETTINGS, undefined, { deps: withoutMixSupport });
    const mix = await prepareClip(wavFile(band, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { deps: withMixSupport });
    const paired = withVocalStem(mix, stem);
    const made = (await commitClip(paired, edits(paired, { kind: 'mix', trim: { startSec: 0, endSec: mix.durationSec } }), createMemoryClipStore())).clip;
    const missing: ClipRecord = { ...made, audioMissing: true };
    expect(missing.audio.vocal).not.toBeNull();

    const store = createMemoryClipStore();
    const noStem = await relinkAudio(missing, mix, store);
    expect(noStem.audio.vocal).toBeNull();
    expect(noStem.analysisKind).toBe('mix-melody');

    const store2 = createMemoryClipStore();
    const withStem = await relinkAudio(missing, mix, store2, stem);
    expect(withStem.audio.vocal).toMatchObject({ kind: 'vocal' });
    expect(withStem.analysisKind).toBe('solo');
    await expect(relinkAudio({ ...original, audioMissing: true }, prepared, store2, stem)).rejects.toThrow(/was not added with a vocal-only file/);
  }, 60000);
});

describe('the detected-melody check on a full song', () => {
  it('plays the lead-vocal contour (not the band), and the phrases come from that contour', async () => {
    const prepared = await prepareClip(wavFile(band, KIT_RATE, 'Song.wav'), SETTINGS, undefined, { deps: withMixSupport });
    expect(prepared.analysis.mode).toBe('mix');
    const first = prepared.phrases[0];
    const tone = renderContourTone(prepared.analysis, 22050, { startSec: first.start, endSec: first.end });
    expect(tone.length).toBeGreaterThan(22050);
    const heard = median(Array.from(trackPitch(tone, 22050).f0).filter((v) => Number.isFinite(v)));
    const contour = median(prepared.analysis.frames.filter((f) => f.voiced && f.t >= first.start && f.t < first.end).map((f) => f.f0));
    // The tone sits on the extracted melody, within a semitone.
    expect(Math.abs(Math.log2(heard / contour)) * 12).toBeLessThan(1);
    // The sung line of withBand(soloLine) is around G3-E4 (MIDI 55-64); the band chord is at A2-A3 and below. The contour is the voice.
    const midi = 69 + 12 * Math.log2(contour / 440);
    expect(midi).toBeGreaterThan(52);
    // Phrases are cut from the contour: each one starts and ends where it has voiced frames.
    for (const p of prepared.phrases) {
      expect(prepared.analysis.frames.some((f) => f.voiced && f.t >= p.start && f.t < p.end)).toBe(true);
    }
  }, 60000);
});

describe('renderContourTone', () => {
  function constantContour(hz: number, sec: number, voicedFrom = 0, voicedTo = sec): VoiceAnalysis {
    const a = analysisFromSpans([{ start: voicedFrom, end: voicedTo }], sec);
    for (const f of a.frames) {
      f.voiced = f.t >= voicedFrom && f.t < voicedTo;
      f.f0 = f.voiced ? hz : NaN;
      f.midi = f.voiced ? 69 + 12 * Math.log2(hz / 440) : NaN;
    }
    return a;
  }

  it('renders a pitch the tracker hears at the contour\'s frequency', () => {
    for (const hz of [110, 220, 440]) {
      const tone = renderContourTone(constantContour(hz, 2));
      expect(tone.length).toBe(2 * 22050);
      const track = trackPitch(tone, 22050);
      const f0 = median(Array.from(track.f0).filter((v) => Number.isFinite(v)));
      expect(Math.abs(f0 / hz - 1)).toBeLessThan(0.01);
    }
  });

  it('is silent where the contour is unvoiced, never louder than 0.4, and has no clicks at the edges', () => {
    const tone = renderContourTone(constantContour(220, 3, 1, 2), 22050);
    const at = (s: number) => Math.round(s * 22050);
    const silent = [...tone.subarray(0, at(0.98)), ...tone.subarray(at(2.03))];
    expect(Math.max(...silent.map(Math.abs))).toBe(0);
    expect(Math.max(...tone.map(Math.abs))).toBeLessThan(0.4);
    expect(Math.max(...tone.map(Math.abs))).toBeGreaterThan(0.25);
    let jump = 0;
    for (let i = 1; i < tone.length; i++) jump = Math.max(jump, Math.abs(tone[i] - tone[i - 1]));
    expect(jump).toBeLessThan(0.15);
  });

  it('renders a part of the clip when asked, starting at that time', () => {
    const a = constantContour(220, 4, 0, 4);
    for (const f of a.frames) if (f.t >= 2) f.f0 = 440;
    const part = renderContourTone(a, 22050, { startSec: 2.2, endSec: 3.7 });
    expect(part.length).toBe(Math.round(1.5 * 22050));
    const f0 = median(Array.from(trackPitch(part, 22050).f0).filter((v) => Number.isFinite(v)));
    expect(Math.abs(f0 / 440 - 1)).toBeLessThan(0.02);
    expect(renderContourTone(a, 22050, { startSec: 5, endSec: 6 }).length).toBe(0);
    expect(renderContourTone(a, 22050, { startSec: -2, endSec: 0.5 }).length).toBe(Math.round(0.5 * 22050));
  });

  it('follows the melody of real analysed audio within half a semitone', () => {
    const a = analyzeTake(soloLine({ count: 2 }), KIT_RATE, { voiceType: 'tenor' });
    const tone = renderContourTone(a, 22050);
    const track = trackPitch(tone, 22050);
    const diffs: number[] = [];
    for (const f of a.frames) {
      if (!f.voiced) continue;
      const i = Math.round(f.t / track.hopSec);
      const hz = track.f0[i];
      if (Number.isFinite(hz)) diffs.push(Math.abs(69 + 12 * Math.log2(hz / 440) - f.midi));
    }
    expect(diffs.length).toBeGreaterThan(300);
    expect(median(diffs)).toBeLessThan(0.5);
  }, 20000);

  it('copes with an empty analysis, NaN pitches and absurd frequencies', () => {
    expect(renderContourTone(analysisFromSpans([], 0)).length).toBe(0);
    expect(renderContourTone({ ...analysisFromSpans([], 2), frames: [] }, 22050).length).toBe(0);
    const a = constantContour(220, 1);
    a.frames[10].f0 = NaN;
    a.frames[20].f0 = 1e9;
    a.frames[30].f0 = -5;
    const tone = renderContourTone(a);
    expect(tone.every((v) => Number.isFinite(v))).toBe(true);
    expect(renderContourTone(a, 0).length).toBe(0);
  });
});

describe('small helpers', () => {
  it('names a clip after its file', () => {
    expect(defaultTitle('Verse 2 (take 3).m4a')).toBe('Verse 2 (take 3)');
    expect(defaultTitle('  spaced   out .wav')).toBe('spaced out');
    expect(defaultTitle('.wav')).toBe('Untitled clip');
    expect(defaultTitle('IMG_0042.MOV')).toBe('IMG_0042');
  });

  it('reads the excerpt offset out of a fingerprint', () => {
    expect(trimStartOf('100:5000:abcd')).toBe(0);
    expect(trimStartOf('100:5000:abcd@12340')).toBeCloseTo(12.34, 6);
    expect(trimStartOf('100:5000:abcd@junk')).toBe(0);
    expect(sourceFingerprint('100:5000:abcd@12340')).toBe('100:5000:abcd');
    expect(sameSource('1:2:a@5', '1:2:a')).toBe(true);
    expect(sameSource('1:2:a', '1:2:b')).toBe(false);
  });

  it('turns segments into records the way commitClip does (floatToInt16 keeps its contract)', () => {
    const a = analysisFromSpans([{ start: 1, end: 6 }], 8);
    const recs = toPhraseRecords(segmentPhrases(a), a, () => 'id');
    expect(recs).toHaveLength(1);
    expect(floatToInt16(new Float32Array([1, -1, 0]))[0]).toBe(32767);
  });
});
