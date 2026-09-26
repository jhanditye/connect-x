import { afterEach, describe, expect, it, vi } from 'vitest';
import { sine } from '../testing/synth';
import { decodeAudioFile, DecodeError, downmix } from './decode';
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
