import { afterEach, describe, expect, it, vi } from 'vitest';
import { sine } from '../testing/synth';
import { AUDIO_ACCEPT, decodeAudioFile, DecodeError, downmix, relabelMp4Brand, UNKNOWN_LENGTH_BYTES } from './decode';
import { flacHeader, mp3Bytes } from './probeTestKit';
import { encodeWav } from './wav';

function wavBlob(channels: Float32Array | Float32Array[], rate: number, name = 'take.wav'): File {
  return new File([encodeWav(channels, rate)], name, { type: 'audio/wav' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('decodeAudioFile (WAV path)', () => {
  it('decodes a mono WAV at its native rate without an AudioContext', async () => {
    const x = sine(220, 0.5, 44100, 0.5);
    const out = await decodeAudioFile(wavBlob(x, 44100));
    expect(out.sampleRate).toBe(44100);
    expect(out.samples.length).toBe(x.length);
    expect(out.durationSec).toBeCloseTo(x.length / 44100, 6);
    let maxErr = 0;
    for (let i = 0; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(out.samples[i] - x[i]));
    // 16-bit quantisation error is at most one LSB.
    expect(maxErr).toBeLessThan(1 / 16384);
  });

  it('mixes stereo down to mono', async () => {
    const n = 1000;
    const left = new Float32Array(n).fill(0.5);
    const right = new Float32Array(n).fill(-0.25);
    const out = await decodeAudioFile(wavBlob([left, right], 48000));
    expect(out.samples.length).toBe(n);
    expect(out.samples[10]).toBeCloseTo(0.125, 3);
    expect(out.sampleRate).toBe(48000);
  });

  it('works on a plain Blob with no name or type', async () => {
    const blob = new Blob([encodeWav(new Float32Array(441).fill(0.1), 44100)]);
    const out = await decodeAudioFile(blob);
    expect(out.samples.length).toBe(441);
  });

  it('rejects an empty file with a readable message', async () => {
    await expect(decodeAudioFile(new File([], 'empty.wav'))).rejects.toThrow(/"empty.wav" is empty/);
  });

  it('rejects a WAV with no samples, saying it contains no audio (not that it could not be decoded)', async () => {
    const err = await decodeAudioFile(wavBlob(new Float32Array(0), 44100, 'silent.wav')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as Error).message).toBe('"silent.wav" contains no audio.');
  });

  it('decodes a WAV whose data size was never written (0), as the browsers do, instead of calling it empty', async () => {
    const x = sine(220, 2, 8000, 0.5);
    const buf = encodeWav(x, 8000);
    new DataView(buf).setUint32(40, 0, true);
    const out = await decodeAudioFile(new File([buf], 'crashed-recorder.wav', { type: 'audio/wav' }));
    expect(out.samples.length).toBe(x.length);
    expect(out.durationSec).toBeCloseTo(2, 6);
  });

  it('decodes only up to maxSeconds and reports the full length', async () => {
    const x = sine(220, 3, 8000, 0.5);
    const out = await decodeAudioFile(wavBlob(x, 8000), { maxSeconds: 2 });
    expect(out.samples.length).toBe(16000);
    expect(out.durationSec).toBe(2);
    expect(out.sourceDurationSec).toBeCloseTo(3, 6);
    expect(out.notices).toEqual([]);
  });

  it('keeps a file shorter than maxSeconds whole', async () => {
    const out = await decodeAudioFile(wavBlob(sine(220, 1, 8000, 0.5), 8000), { maxSeconds: 300 });
    expect(out.samples.length).toBe(8000);
    expect(out.sourceDurationSec).toBe(out.durationSec);
  });

  it('uses the louder channel when the stereo channels cancel each other (one phase-inverted)', async () => {
    const left = sine(220, 0.5, 8000, 0.5);
    const right = left.map((v) => -v);
    const out = await decodeAudioFile(wavBlob([left, right], 8000, 'inverted.wav'));
    let peak = 0;
    for (const v of out.samples) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.45);
    expect(out.notices.join(' ')).toMatch(/cancel each other out/);
  });

  it('still averages quiet stereo channels that do not cancel', async () => {
    const left = new Float32Array(1000).fill(0.01);
    const right = new Float32Array(1000).fill(0.005);
    const out = await decodeAudioFile(wavBlob([left, right], 8000));
    expect(out.samples[10]).toBeCloseTo(0.0075, 3);
    expect(out.notices).toEqual([]);
  });
});

describe('downmix', () => {
  it('averages channels, stops at the frame limit and returns a mono channel as is', () => {
    const a = new Float32Array([1, 1, 1, 1]);
    const b = new Float32Array([0, 0.5, 1, 0]);
    expect(Array.from(downmix([a, b], 3).samples)).toEqual([0.5, 0.75, 1]);
    expect(downmix([a]).samples).toBe(a);
    expect(downmix([a], 2).samples.length).toBe(2);
    expect(downmix([]).samples.length).toBe(0);
  });

  it('falls back to the loudest channel when the mix is 20 dB or more below it', () => {
    const a = new Float32Array([0.5, -0.5, 0.5, -0.5]);
    const b = a.map((v) => -v * 0.98);
    const r = downmix([a, b]);
    expect(r.cancelled).toBe(true);
    expect(Array.from(r.samples)).toEqual(Array.from(a));
  });
});

describe('decodeAudioFile (browser decoder path)', () => {
  it('rejects a very large compressed file before decoding it', async () => {
    const huge = {
      size: 70 * 1024 * 1024,
      name: 'rehearsal.m4a',
      type: 'audio/mp4',
      arrayBuffer: async () => new ArrayBuffer(16),
    } as unknown as Blob;
    await expect(decodeAudioFile(huge)).rejects.toThrow(/"rehearsal.m4a" is too large \(70 MB\)/);
  });

  it('keeps only maxSeconds of browser-decoded audio', async () => {
    const decoded = {
      sampleRate: 1000,
      length: 5000,
      numberOfChannels: 2,
      getChannelData: (c: number) => new Float32Array(5000).fill(c === 0 ? 0.2 : 0.4),
    };
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData = async () => decoded;
      },
    );
    const out = await decodeAudioFile(new File([new Uint8Array(64)], 'long.mp3', { type: 'audio/mpeg' }), { maxSeconds: 2 });
    expect(out.samples.length).toBe(2000);
    expect(out.samples[0]).toBeCloseTo(0.3, 5);
    expect(out.sourceDurationSec).toBe(5);
  });

  it('explains the problem when the browser has no audio decoder', async () => {
    vi.stubGlobal('OfflineAudioContext', undefined);
    vi.stubGlobal('AudioContext', undefined);
    const mp3 = new File([new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4, 5])], 'song.mp3', { type: 'audio/mpeg' });
    await expect(decodeAudioFile(mp3)).rejects.toThrow(/export the take as a WAV/i);
  });

  it('uses OfflineAudioContext.decodeAudioData for non-WAV files and mixes to mono', async () => {
    const decoded = {
      sampleRate: 48000,
      numberOfChannels: 2,
      getChannelData: (c: number) => new Float32Array(480).fill(c === 0 ? 0.2 : 0.4),
    };
    const decodeAudioData = vi.fn(async () => decoded);
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData = decodeAudioData;
      },
    );
    const m4a = new File([new Uint8Array(64)], 'memo.m4a', { type: 'audio/mp4' });
    const out = await decodeAudioFile(m4a);
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    expect(out.sampleRate).toBe(48000);
    expect(out.samples.length).toBe(480);
    expect(out.samples[0]).toBeCloseTo(0.3, 5);
    expect(out.durationSec).toBeCloseTo(0.01, 6);
  });

  it('supports the old callback form of decodeAudioData', async () => {
    const decoded = { sampleRate: 22050, numberOfChannels: 1, getChannelData: () => new Float32Array(100).fill(0.5) };
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData(_d: ArrayBuffer, ok: (b: unknown) => void) {
          setTimeout(() => ok(decoded), 0);
        }
      },
    );
    const out = await decodeAudioFile(new File([new Uint8Array(16)], 'x.ogg'));
    expect(out.samples.length).toBe(100);
  });

  it('turns a decoder failure into a readable DecodeError naming the file', async () => {
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData() {
          return Promise.reject(new DOMException('Unable to decode audio data', 'EncodingError'));
        }
      },
    );
    const bad = new File([new Uint8Array(32)], 'notes.txt', { type: 'text/plain' });
    const err = await decodeAudioFile(bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as Error).message).toMatch(/"notes.txt" \(text\/plain\) could not be decoded/);
  });
});

/** A minimal "ftyp" box: 4-byte size, "ftyp", major brand, minor version, one compatible brand. */
function ftyp(major: string): ArrayBuffer {
  const bytes = new Uint8Array(32);
  const put = (o: number, text: string) => [...text].forEach((c, i) => (bytes[o + i] = c.charCodeAt(0)));
  new DataView(bytes.buffer).setUint32(0, 24);
  put(4, 'ftyp');
  put(8, major);
  put(20, 'isom');
  return bytes.buffer;
}

describe('iOS-friendly file picking and decoding', () => {
  it('lists audio extensions and MIME types explicitly (iOS Safari ignores the audio/* wildcard)', () => {
    const tokens = AUDIO_ACCEPT.split(',');
    for (const t of ['.m4a', '.mp3', '.wav', '.caf', '.qta', 'audio/mp4', 'audio/x-m4a', 'audio/mpeg']) expect(tokens).toContain(t);
  });

  it('relabels an M4A major brand to mp42 on a copy and leaves other files alone', () => {
    const original = ftyp('M4A ');
    const fixed = relabelMp4Brand(original);
    expect(fixed).not.toBeNull();
    expect(String.fromCharCode(...new Uint8Array(fixed!, 8, 4))).toBe('mp42');
    expect(String.fromCharCode(...new Uint8Array(original, 8, 4))).toBe('M4A ');
    expect(relabelMp4Brand(ftyp('mp42'))).toBeNull();
    expect(relabelMp4Brand(ftyp('qt  '))).toBeNull();
    expect(relabelMp4Brand(new ArrayBuffer(4))).toBeNull();
  });

  it('retries once with the relabelled brand when the browser refuses an M4A', async () => {
    const decoded = { sampleRate: 48000, numberOfChannels: 1, getChannelData: () => new Float32Array(480).fill(0.25) };
    const seen: string[] = [];
    const decodeAudioData = vi.fn(async (data: ArrayBuffer) => {
      const brand = String.fromCharCode(...new Uint8Array(data, 8, 4));
      seen.push(brand);
      if (brand === 'M4A ') throw new DOMException('Unable to decode audio data', 'EncodingError');
      return decoded;
    });
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData = decodeAudioData;
      },
    );
    const out = await decodeAudioFile(new File([ftyp('M4A ')], 'Voice Memo.m4a', { type: 'audio/x-m4a' }));
    expect(seen).toEqual(['M4A ', 'mp42']);
    expect(out.samples.length).toBe(480);
  });

  it('does not retry files that are not relabellable and still reports a readable error', async () => {
    const decodeAudioData = vi.fn(async () => {
      throw new DOMException('Unable to decode audio data', 'EncodingError');
    });
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        decodeAudioData = decodeAudioData;
      },
    );
    const err = await decodeAudioFile(new File([ftyp('mp42')], 'x.m4a')).catch((e: unknown) => e);
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(DecodeError);
  });
});

// ---------------------------------------------------------------------------------------------
// Not reading more of a file than the import can use

function stubDecoder(frames = 480, rate = 48000) {
  const decoded = { sampleRate: rate, length: frames, numberOfChannels: 1, getChannelData: () => new Float32Array(frames).fill(0.2) };
  const decodeAudioData = vi.fn(async () => decoded);
  vi.stubGlobal(
    'OfflineAudioContext',
    class {
      decodeAudioData = decodeAudioData;
    },
  );
  return decodeAudioData;
}

describe('decodeAudioFile: a WAV is read only as far as maxSeconds needs', () => {
  it('slices the header and the first seconds instead of the whole file, and still reports the whole length', async () => {
    const rate = 8000;
    const file = wavBlob(sine(220, 12, rate, 0.4), rate, 'long.wav');
    const whole = vi.spyOn(file, 'arrayBuffer');
    const slices: [number | undefined, number | undefined][] = [];
    const slice = file.slice.bind(file);
    vi.spyOn(file, 'slice').mockImplementation((a, b, c) => (slices.push([a, b]), slice(a, b, c)));
    const out = await decodeAudioFile(file, { maxSeconds: 5 });
    expect(out.samples.length).toBe(5 * rate);
    expect(out.sourceDurationSec).toBeCloseTo(12, 3);
    expect(whole).not.toHaveBeenCalled();
    expect(slices.some(([a, b]) => a === 0 && b === 44 + 5 * rate * 2)).toBe(true);
  });

  it('reads a stereo WAV the same way and keeps the channel mix', async () => {
    const rate = 8000;
    const left = new Float32Array(rate * 6).fill(0.5);
    const right = new Float32Array(rate * 6).fill(-0.25);
    const out = await decodeAudioFile(wavBlob([left, right], rate), { maxSeconds: 2 });
    expect(out.samples.length).toBe(2 * rate);
    expect(out.samples[100]).toBeCloseTo(0.125, 3);
    expect(out.sourceDurationSec).toBeCloseTo(6, 3);
  });

  it('reads a file that is shorter than maxSeconds whole, with no notice of a cut', async () => {
    const rate = 8000;
    const out = await decodeAudioFile(wavBlob(sine(220, 2, rate, 0.4), rate), { maxSeconds: 5 });
    expect(out.samples.length).toBe(2 * rate);
    expect(out.sourceDurationSec).toBeCloseTo(2, 3);
  });
});

describe('decodeAudioFile: the length of a compressed file is read from its header before it is opened', () => {
  it('refuses an MP3 whose Xing header says it is longer than the limit, without decoding it', async () => {
    const decode = stubDecoder();
    const frames = Math.ceil((40 * 60 * 44100) / 1152); // 40 minutes
    const file = new File([mp3Bytes({ xingFrames: frames, size: 20000 })], 'long.mp3', { type: 'audio/mpeg' });
    const err = await decodeAudioFile(file, { maxSourceSec: 15 * 60 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).reason).toBe('too-long');
    expect((err as Error).message).toMatch(/about 40 minutes long.*limit is 15 minutes/);
    expect(decode).not.toHaveBeenCalled();
  });

  it('refuses a constant-bitrate MP3 by its size and bitrate (no Xing header)', async () => {
    stubDecoder();
    // 128 kbps = 16000 bytes/s: 20 minutes is 19.2 MB, under every size limit.
    const file = new File([mp3Bytes({ size: 20 * 60 * 16000 })], 'podcast.mp3', { type: 'audio/mpeg' });
    await expect(decodeAudioFile(file, { maxSourceSec: 15 * 60 })).rejects.toMatchObject({ reason: 'too-long' });
  });

  it('refuses a long FLAC and opens a FLAC under the limit even above 30 MB', async () => {
    const decode = stubDecoder();
    const long = new File([flacHeader(44100, 44100 * 45 * 60), new Uint8Array(1000)], 'long.flac', { type: 'audio/flac' });
    await expect(decodeAudioFile(long, { maxSourceSec: 15 * 60 })).rejects.toMatchObject({ reason: 'too-long' });
    expect(decode).not.toHaveBeenCalled();
    const song = new File([flacHeader(44100, 44100 * 5 * 60), new Uint8Array(40 * 1024 * 1024)], 'song.flac', { type: 'audio/flac' });
    const out = await decodeAudioFile(song, { maxSourceSec: 15 * 60 });
    expect(out.samples.length).toBe(480);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('opens an MP3 under the limit', async () => {
    const decode = stubDecoder();
    const file = new File([mp3Bytes({ xingFrames: Math.ceil((4 * 60 * 44100) / 1152), size: 20000 })], 'song.mp3', { type: 'audio/mpeg' });
    await decodeAudioFile(file, { maxSourceSec: 15 * 60 });
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('refuses a file of a kind whose length cannot be read once it is bigger than a long song at an ordinary bitrate', async () => {
    const decode = stubDecoder();
    const webm = new Uint8Array(UNKNOWN_LENGTH_BYTES + 1024);
    webm.set([0x1a, 0x45, 0xdf, 0xa3], 0);
    const err = await decodeAudioFile(new File([webm], 'meeting.webm', { type: 'audio/webm' }), { maxSourceSec: 15 * 60 }).catch((e: unknown) => e);
    expect((err as DecodeError).reason).toBe('too-large');
    expect(decode).not.toHaveBeenCalled();
    // The same kind of file under the limit is opened, as before.
    await decodeAudioFile(new File([new Uint8Array(2 * 1024 * 1024)], 'memo.webm', { type: 'audio/webm' }), { maxSourceSec: 15 * 60 });
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('does not apply the unknown-length limit to uncompressed AIFF', async () => {
    const decode = stubDecoder();
    const aiff = new Uint8Array(UNKNOWN_LENGTH_BYTES + 1024);
    aiff.set([0x46, 0x4f, 0x52, 0x4d], 0); // FORM
    await decodeAudioFile(new File([aiff], 'take.aiff', { type: 'audio/aiff' }), { maxSourceSec: 15 * 60 });
    expect(decode).toHaveBeenCalledTimes(1);
  });
});
