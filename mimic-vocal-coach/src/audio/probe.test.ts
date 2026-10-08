import { describe, expect, it } from 'vitest';
import { id3v2Length, lastOggGranule, parseFlacDurationSec, parseMp3DurationSec, parseOggStart, parseWavRange, probeContainerDurationSec, probeWav, wavBytesForSeconds } from './probe';
import { ascii, flacHeader, mp3Bytes, oggPage, oggVorbis } from './probeTestKit';
import { encodeWav } from './wav';

describe('parseFlacDurationSec', () => {
  it('reads the length from STREAMINFO', () => {
    expect(parseFlacDurationSec(flacHeader(44100, 44100 * 60))).toBeCloseTo(60, 6);
    expect(parseFlacDurationSec(flacHeader(96000, 96000 * 5000, 2, 24))).toBeCloseTo(5000, 6);
    expect(parseFlacDurationSec(flacHeader(48000, 2 ** 32 + 48000 * 2))).toBeCloseTo(2 ** 32 / 48000 + 2, 3); // a 36-bit total
  });
  it('says nothing when the total is not stored or the file is not FLAC', () => {
    expect(parseFlacDurationSec(flacHeader(44100, 0))).toBeNull();
    expect(parseFlacDurationSec(new Uint8Array(42))).toBeNull();
    expect(parseFlacDurationSec(new Uint8Array(4))).toBeNull();
  });
});

describe('parseMp3DurationSec', () => {
  it('uses the frame count of a Xing/Info or VBRI header', () => {
    expect(parseMp3DurationSec(mp3Bytes({ xingFrames: 2000 }), 1e6)).toBeCloseTo((2000 * 1152) / 44100, 6);
    expect(parseMp3DurationSec(mp3Bytes({ vbriFrames: 4000 }), 1e6)).toBeCloseTo((4000 * 1152) / 44100, 6);
  });
  it('otherwise divides the audio bytes by the bitrate of the first frame', () => {
    expect(parseMp3DurationSec(mp3Bytes(), 1_600_000)).toBeCloseTo(100, 6); // 128 kbps = 16000 bytes per second
  });
  it('finds the first frame after padding, and skips things that only look like a frame', () => {
    const padded = new Uint8Array(100 + 4096);
    padded.set(mp3Bytes().subarray(0, 4), 100);
    expect(parseMp3DurationSec(padded, 160_000)).toBeCloseTo(10, 6);
    const reserved = new Uint8Array(64);
    reserved.set([0xff, 0xf1, 0x50, 0x80], 0); // an AAC ADTS header: layer bits 00
    expect(parseMp3DurationSec(reserved, 1e6)).toBeNull();
    expect(parseMp3DurationSec(new Uint8Array(64), 1e6)).toBeNull();
  });
  it('reads the ID3v2 tag length', () => {
    expect(id3v2Length(mp3Bytes({ id3: 5000 }))).toBe(5000);
    expect(id3v2Length(mp3Bytes())).toBe(0);
  });
});

describe('Ogg', () => {
  it('reads the rate from the first page and the length from the last granule position', () => {
    const bytes = oggVorbis(44100, 90);
    expect(parseOggStart(bytes)).toEqual({ rate: 44100, skip: 0 });
    expect(lastOggGranule(bytes.subarray(bytes.length - 2000))).toBe(44100 * 90);
  });
  it('reads Opus at 48 kHz minus the pre-skip', () => {
    const head = [...ascii('OpusHead'), 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0];
    expect(parseOggStart(oggPage(0, head, 2))).toEqual({ rate: 48000, skip: 312 });
  });
  it('ignores pages that carry no position', () => {
    const open = oggPage(0, [1], 0);
    new DataView(open.buffer).setUint32(6, 0xffffffff, true);
    new DataView(open.buffer).setUint32(10, 0xffffffff, true);
    expect(lastOggGranule(open)).toBeNull();
  });
});

describe('parseWavRange and wavBytesForSeconds', () => {
  const wav = new Uint8Array(encodeWav(new Float32Array(44100 * 4), 44100));
  it('finds where the audio starts and how many frames it holds', () => {
    expect(parseWavRange(wav.subarray(0, 64), wav.length)).toEqual({ sampleRate: 44100, channels: 1, bitsPerSample: 16, dataOffset: 44, totalFrames: 44100 * 4 });
  });
  it('treats a size of 0 (a recorder that never finished the header) as "to the end of the file"', () => {
    const open = wav.slice();
    new DataView(open.buffer).setUint32(40, 0, true);
    expect(parseWavRange(open.subarray(0, 64), open.length)?.totalFrames).toBe(44100 * 4);
  });
  it('says how many bytes cover the first seconds, and null when that is the whole file', () => {
    const r = parseWavRange(wav.subarray(0, 64), wav.length);
    expect(r && wavBytesForSeconds(r, 1, wav.length)).toBe(44 + 44100 * 2);
    expect(r && wavBytesForSeconds(r, 10, wav.length)).toBeNull();
  });
  it('gives up on a header it cannot read or an encoding it does not parse', () => {
    expect(parseWavRange(new Uint8Array(40), 40)).toBeNull();
    const adpcm = wav.slice();
    new DataView(adpcm.buffer).setUint16(20, 2, true);
    expect(parseWavRange(adpcm.subarray(0, 64), adpcm.length)).toBeNull();
  });
  it('probes a Blob by reading only its first bytes', async () => {
    expect((await probeWav(new Blob([wav])))?.totalFrames).toBe(44100 * 4);
    expect(await probeWav(new Blob([new Uint8Array(100)]))).toBeNull();
    expect(await probeWav({ size: 5 } as unknown as Blob)).toBeNull();
  });
});

describe('probeContainerDurationSec', () => {
  it('reads FLAC, MP3 (with and without a tag) and Ogg from a Blob', async () => {
    expect(await probeContainerDurationSec(new Blob([flacHeader(44100, 44100 * 600), new Uint8Array(10000)]))).toBeCloseTo(600, 3);
    expect(await probeContainerDurationSec(new Blob([mp3Bytes({ xingFrames: 10000 })]))).toBeCloseTo((10000 * 1152) / 44100, 3);
    const tagged = mp3Bytes({ id3: 200_000, size: 800_000 });
    expect(await probeContainerDurationSec(new Blob([tagged]))).toBeCloseTo(800_000 / 16000, 3);
    expect(await probeContainerDurationSec(new Blob([oggVorbis(48000, 30)]))).toBeCloseTo(30, 3);
  });
  it('says nothing for files it does not know, empty files and objects that cannot be sliced', async () => {
    expect(await probeContainerDurationSec(new Blob([new Uint8Array(5000)]))).toBeNull();
    expect(await probeContainerDurationSec(new Blob([new Uint8Array(0)]))).toBeNull();
    expect(await probeContainerDurationSec({ size: 9 } as unknown as Blob)).toBeNull();
    // A WebM does not start with an MP3 frame, however many frame-like bytes it holds later.
    const webm = new Uint8Array(5000).fill(0xff);
    webm.set([0x1a, 0x45, 0xdf, 0xa3], 0);
    expect(await probeContainerDurationSec(new Blob([webm]))).toBeNull();
  });
});
