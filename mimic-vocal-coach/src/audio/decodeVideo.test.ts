import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUDIO_ACCEPT,
  decodeAudioFile,
  DecodeError,
  isVideoFile,
  looksLikeMedia,
  MAX_VIDEO_BYTES,
  MEDIA_ACCEPT,
  probeIsoDurationSec,
  VIDEO_SHORTCUT_TIP,
} from './decode';

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------
// A video-like container built in code: ftyp + mdat + moov(mvhd), the layout of an iPhone .MOV (header at the end).

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(ascii(type), 4);
  out.set(payload, 8);
  return out;
}

function mvhd(durationSec: number, timescale: number, version: 0 | 1): Uint8Array {
  const payload = new Uint8Array(version === 1 ? 108 : 96);
  const dv = new DataView(payload.buffer);
  payload[0] = version;
  if (version === 1) {
    dv.setUint32(20, timescale); // after version+flags(4), creation(8), modification(8)
    dv.setBigUint64(24, BigInt(Math.round(durationSec * timescale)));
  } else {
    dv.setUint32(12, timescale); // after version+flags(4), creation(4), modification(4)
    dv.setUint32(16, Math.round(durationSec * timescale));
  }
  return box('mvhd', payload);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function makeMov(opts: { durationSec: number; brand?: string; timescale?: number; version?: 0 | 1; moovFirst?: boolean; mdatBytes?: number }): Uint8Array {
  const ftyp = box('ftyp', new Uint8Array([...ascii(opts.brand ?? 'qt  '), 0, 0, 0, 0, ...ascii('qt  ')]));
  const wide = box('wide', new Uint8Array(0));
  const mdat = box('mdat', new Uint8Array(opts.mdatBytes ?? 256));
  const moov = box('moov', mvhd(opts.durationSec, opts.timescale ?? 600, opts.version ?? 0));
  return opts.moovFirst ? concatBytes(ftyp, moov, mdat) : concatBytes(ftyp, wide, mdat, moov);
}

const asFile = (bytes: Uint8Array, name: string, type: string): File => new File([bytes as BlobPart], name, { type });

/** A Blob-like object that reports a size without allocating it (the size gates run before any read). */
function bigFake(sizeBytes: number, name: string, type: string): Blob {
  return { size: sizeBytes, name, type, arrayBuffer: async () => new ArrayBuffer(64) } as unknown as Blob;
}

function stubDecoder(decodeAudioData: (data: ArrayBuffer) => Promise<unknown>): void {
  vi.stubGlobal(
    'OfflineAudioContext',
    class {
      decodeAudioData = decodeAudioData;
    },
  );
}

const DECODED = { sampleRate: 48000, numberOfChannels: 2, length: 480, getChannelData: (c: number) => new Float32Array(480).fill(c === 0 ? 0.1 : 0.3) };

describe('picking phone videos', () => {
  it('keeps every audio token and adds video/* with the movie extensions iOS needs', () => {
    const tokens = MEDIA_ACCEPT.split(',');
    for (const t of AUDIO_ACCEPT.split(',')) expect(tokens).toContain(t);
    for (const t of ['video/*', '.mov', '.m4v', '.mp4', 'video/mp4', 'video/quicktime']) expect(tokens).toContain(t);
  });

  it('recognises media by type or extension and videos separately', () => {
    expect(looksLikeMedia({ name: 'IMG_0042.MOV', type: 'video/quicktime' })).toBe(true);
    expect(looksLikeMedia({ name: 'IMG_0042.MOV', type: '' })).toBe(true);
    expect(looksLikeMedia({ name: 'take.m4v', type: '' })).toBe(true);
    expect(looksLikeMedia({ name: 'memo.qta', type: '' })).toBe(true);
    // a copy-protected iTunes purchase is let through so the person gets the copy-protection message, not "not audio"
    expect(looksLikeMedia({ name: 'Protected-Song.m4p', type: '' })).toBe(true);
    expect(MEDIA_ACCEPT.split(',')).toContain('.m4p');
    expect(looksLikeMedia({ name: 'notes.txt', type: 'text/plain' })).toBe(false);
    expect(isVideoFile({ name: 'IMG_0042.MOV', type: '' })).toBe(true);
    expect(isVideoFile({ name: 'clip.mp4', type: 'video/mp4' })).toBe(true);
    // A bare .mp4 or an audio/mp4 file is audio until proven otherwise.
    expect(isVideoFile({ name: 'clip.mp4', type: '' })).toBe(false);
    expect(isVideoFile({ name: 'memo.m4a', type: 'audio/mp4' })).toBe(false);
  });
});

describe('probeIsoDurationSec', () => {
  it('reads the length from a movie header placed after the media data (iPhone .MOV layout)', async () => {
    expect(await probeIsoDurationSec(asFile(makeMov({ durationSec: 83.5, mdatBytes: 5000 }), 'a.mov', 'video/quicktime'))).toBeCloseTo(83.5, 2);
  });

  it('reads a header at the front (fast-start MP4) and a 64-bit duration', async () => {
    expect(await probeIsoDurationSec(asFile(makeMov({ durationSec: 12, brand: 'mp42', moovFirst: true }), 'a.mp4', 'video/mp4'))).toBeCloseTo(12, 3);
    expect(await probeIsoDurationSec(asFile(makeMov({ durationSec: 4000, version: 1, timescale: 90000 }), 'a.mov', ''))).toBeCloseTo(4000, 2);
  });

  it('returns null for files that are not ISO base media, truncated headers and unsliceable objects', async () => {
    expect(await probeIsoDurationSec(new File([new Uint8Array(100)], 'x.mp3'))).toBeNull();
    expect(await probeIsoDurationSec(new File([makeMov({ durationSec: 5 }).slice(0, 40) as BlobPart], 'cut.mov'))).toBeNull();
    expect(await probeIsoDurationSec(new File([], 'empty.mov'))).toBeNull();
    expect(await probeIsoDurationSec({ size: 9, arrayBuffer: async () => new ArrayBuffer(9) } as unknown as Blob)).toBeNull();
  });
});

describe('decodeAudioFile with videos', () => {
  it('decodes the audio track of a .mov through the browser decoder and does not rewrite its brand', async () => {
    const seen: string[] = [];
    stubDecoder(async (data) => {
      seen.push(String.fromCharCode(...new Uint8Array(data, 8, 4)));
      return DECODED;
    });
    const out = await decodeAudioFile(asFile(makeMov({ durationSec: 3 }), 'IMG_0001.MOV', 'video/quicktime'));
    expect(seen).toEqual(['qt  ']);
    expect(out.sampleRate).toBe(48000);
    expect(out.samples.length).toBe(480);
    expect(out.samples[0]).toBeCloseTo(0.2, 5);
  });

  it('opens a video bigger than the 60 MB audio limit, up to 150 MB, and refuses one above it with the Shortcuts route', async () => {
    stubDecoder(async () => DECODED);
    const ok = await decodeAudioFile(bigFake(100 * 1024 * 1024, 'concert.mov', 'video/quicktime'));
    expect(ok.samples.length).toBe(480);

    const err = await decodeAudioFile(bigFake(MAX_VIDEO_BYTES + 1, 'concert.mov', 'video/quicktime')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).reason).toBe('too-large');
    expect((err as Error).message).toMatch(/"concert.mov" is a 150 MB video/);
    expect((err as Error).message).toContain('Encode Media');
    expect((err as Error).message).toContain('Audio Only');
    expect((err as Error).message).toContain('share it to Files');

    // An audio file keeps the old 60 MB limit.
    await expect(decodeAudioFile(bigFake(70 * 1024 * 1024, 'long.m4a', 'audio/mp4'))).rejects.toThrow(/is too large \(70 MB\)/);
  });

  it('refuses a video whose header says it is too long, without reading the file', async () => {
    stubDecoder(async () => DECODED);
    const file = asFile(makeMov({ durationSec: 20 * 60 }), 'wedding.mov', 'video/quicktime');
    const read = vi.spyOn(file, 'arrayBuffer');
    const err = await decodeAudioFile(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).reason).toBe('too-long');
    expect((err as Error).message).toMatch(/about 20 minutes long.*limit is 15 minutes/);
    expect((err as Error).message).toContain(VIDEO_SHORTCUT_TIP);
    expect(read).not.toHaveBeenCalled();
  });

  it('applies the same length check to audio files only when the caller sets maxSourceSec', async () => {
    stubDecoder(async () => DECODED);
    const memo = () => asFile(makeMov({ durationSec: 20 * 60, brand: 'M4A ' }), 'long memo.m4a', 'audio/mp4');
    const unlimited = await decodeAudioFile(memo());
    expect(unlimited.samples.length).toBe(480);
    const err = await decodeAudioFile(memo(), { maxSourceSec: 15 * 60 }).catch((e: unknown) => e);
    expect((err as DecodeError).reason).toBe('too-long');
    expect((err as Error).message).toMatch(/about 20 minutes long/);
    expect((err as Error).message).not.toContain('Encode Media');
    // Under the limit it decodes.
    const short = await decodeAudioFile(asFile(makeMov({ durationSec: 100, brand: 'M4A ' }), 'short.m4a', 'audio/mp4'), { maxSourceSec: 15 * 60 });
    expect(short.samples.length).toBe(480);
  });

  it('explains an unreadable video (no audio track or an unsupported codec) and names the fix', async () => {
    stubDecoder(() => Promise.reject(new DOMException('Unable to decode audio data', 'EncodingError')));
    const err = await decodeAudioFile(asFile(makeMov({ durationSec: 3 }), 'silent.mov', 'video/quicktime')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).reason).toBe('unsupported');
    expect((err as Error).message).toMatch(/"silent.mov" \(video\/quicktime\) is a video and its sound could not be read/);
    expect((err as Error).message).toContain('Encode Media');
  });
});

describe('copy-protected files', () => {
  it('names the problem and the fix for an .m4p file without reading it', async () => {
    const file = new File([new Uint8Array(64)], 'Song.m4p');
    const read = vi.spyOn(file, 'arrayBuffer');
    const err = await decodeAudioFile(file).catch((e: unknown) => e);
    expect((err as DecodeError).reason).toBe('protected');
    expect((err as Error).message).toMatch(/copy-protected/);
    expect((err as Error).message).toContain('DRM-free copy of a song you own');
    expect(read).not.toHaveBeenCalled();
  });

  it('also catches the FairPlay brand inside a file with another extension', async () => {
    stubDecoder(async () => DECODED);
    const err = await decodeAudioFile(asFile(makeMov({ durationSec: 3, brand: 'M4P ' }), 'renamed.m4a', 'audio/mp4')).catch((e: unknown) => e);
    expect((err as DecodeError).reason).toBe('protected');
  });
});

describe('DecodeError reasons for the older failures', () => {
  it('carries a reason for empty, no-decoder and no-audio files', async () => {
    expect(await decodeAudioFile(new File([], 'e.wav')).catch((e: unknown) => (e as DecodeError).reason)).toBe('empty');
    vi.stubGlobal('OfflineAudioContext', undefined);
    vi.stubGlobal('AudioContext', undefined);
    expect(await decodeAudioFile(new File([new Uint8Array(16)], 'x.mp3')).catch((e: unknown) => (e as DecodeError).reason)).toBe('no-decoder');
  });
});
