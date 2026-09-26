import { afterEach, describe, expect, it, vi } from 'vitest';
import { sine } from '../testing/synth';
import { decodeAudioFile, DecodeError } from './decode';
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

  it('rejects a WAV with no samples', async () => {
    await expect(decodeAudioFile(wavBlob(new Float32Array(0), 44100, 'silent.wav'))).rejects.toThrow(DecodeError);
  });
});

describe('decodeAudioFile (browser decoder path)', () => {
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
