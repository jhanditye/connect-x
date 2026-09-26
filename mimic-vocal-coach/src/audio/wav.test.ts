import { describe, expect, it } from 'vitest';
import { decodeWav, encodeWav } from './wav';

function ramp(n: number, scale: number): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => ((i % 100) / 100 - 0.5) * scale);
}

describe('decodeWav options', () => {
  it('without options decodes every channel and frame', () => {
    const l = ramp(1000, 1);
    const r = ramp(1000, 0.5);
    const out = decodeWav(encodeWav([l, r], 8000));
    expect(out.sampleRate).toBe(8000);
    expect(out.channels).toHaveLength(2);
    expect(out.channels[0].length).toBe(1000);
    expect(out.sourceChannels).toBe(2);
    expect(out.totalFrames).toBe(1000);
    expect(out.channels[1][10]).toBeCloseTo(r[10], 3);
  });

  it('maxSeconds stops reading early but reports the full length', () => {
    const out = decodeWav(encodeWav(ramp(8000, 1), 8000), { maxSeconds: 0.25 });
    expect(out.channels[0].length).toBe(2000);
    expect(out.totalFrames).toBe(8000);
  });

  it('mono mixes the channels while reading, into a single array', () => {
    const l = ramp(1000, 1);
    const r = ramp(1000, 0.5);
    const out = decodeWav(encodeWav([l, r], 8000), { mono: true, maxSeconds: 0.1 });
    expect(out.channels).toHaveLength(1);
    expect(out.channels[0].length).toBe(800);
    expect(out.sourceChannels).toBe(2);
    for (const i of [0, 7, 450, 799]) expect(out.channels[0][i]).toBeCloseTo((l[i] + r[i]) / 2, 3);
  });

  it('mono on a mono file returns that channel', () => {
    const x = ramp(500, 0.8);
    const out = decodeWav(encodeWav(x, 8000), { mono: true });
    expect(out.channels).toHaveLength(1);
    expect(out.channels[0][123]).toBeCloseTo(x[123], 3);
  });
});

/** A WAV as a recorder that never finalised its header leaves it: the data chunk size is 0. */
function unfinalised(buf: ArrayBuffer): ArrayBuffer {
  new DataView(buf).setUint32(40, 0, true);
  return buf;
}

describe('decodeWav data chunk size', () => {
  it('reads a data chunk whose size was left at 0 to the end of the file', () => {
    const x = ramp(1200, 0.8);
    const out = decodeWav(unfinalised(encodeWav(x, 8000)));
    expect(out.channels[0].length).toBe(1200);
    expect(out.totalFrames).toBe(1200);
    expect(out.channels[0][321]).toBeCloseTo(x[321], 3);
  });

  it('still honours maxSeconds and mono on such a file', () => {
    const out = decodeWav(unfinalised(encodeWav([ramp(8000, 1), ramp(8000, 0.5)], 8000)), { maxSeconds: 0.5, mono: true });
    expect(out.channels).toHaveLength(1);
    expect(out.channels[0].length).toBe(4000);
    expect(out.totalFrames).toBe(8000);
  });

  it('cuts a size that runs past the end (truncated or streamed 0xFFFFFFFF) to what is there', () => {
    const buf = encodeWav(ramp(1000, 1), 8000);
    new DataView(buf).setUint32(40, 0xffffffff, true);
    expect(decodeWav(buf).channels[0].length).toBe(1000);
  });

  it('keeps a genuinely empty data chunk empty, even when another chunk follows it', () => {
    expect(decodeWav(encodeWav(new Float32Array(0), 8000)).channels[0].length).toBe(0);
    // Empty data chunk, then a 4-byte LIST chunk.
    const empty = encodeWav(new Float32Array(0), 8000);
    const buf = new Uint8Array(empty.byteLength + 12);
    buf.set(new Uint8Array(empty));
    const v = new DataView(buf.buffer);
    [...'LIST'].forEach((c, i) => v.setUint8(44 + i, c.charCodeAt(0)));
    v.setUint32(48, 4, true);
    [...'INFO'].forEach((c, i) => v.setUint8(52 + i, c.charCodeAt(0)));
    expect(decodeWav(buf.buffer).channels[0].length).toBe(0);
  });
});
