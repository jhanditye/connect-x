// Minimal WAV (RIFF) encoder/decoder. Used to save recordings, to decode WAV files without an
// AudioContext (tests, workers), and to generate fixtures.

export interface DecodedAudio {
  sampleRate: number;
  channels: Float32Array[];
  /** Channels in the file (with `mono: true`, `channels` holds one mix of them). */
  sourceChannels?: number;
  /** Frames in the whole file; more than `channels[0].length` when `maxSeconds` cut it short. */
  totalFrames?: number;
}

export interface DecodeWavOptions {
  /** Stop reading after this many seconds, so a long file never allocates more than it needs. */
  maxSeconds?: number;
  /** Average the channels while reading and return a single channel (one array instead of one per channel). */
  mono?: boolean;
}

/** Encode mono or multi-channel float samples (-1..1) as 16-bit PCM WAV. */
export function encodeWav(input: Float32Array | Float32Array[], sampleRate: number): ArrayBuffer {
  const channels = Array.isArray(input) ? input : [input];
  const numCh = channels.length;
  const len = channels[0]?.length ?? 0;
  const bytesPerSample = 2;
  const dataSize = len * numCh * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, numCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * numCh * bytesPerSample, true);
  v.setUint16(32, numCh * bytesPerSample, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      v.setInt16(off, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
      off += 2;
    }
  }
  return buf;
}

/**
 * Decode a PCM (8/16/24/32-bit int) or IEEE float (32/64-bit) WAV file.
 * Throws an Error with a readable message for anything else.
 * `opts.maxSeconds` reads only the start of the file; `opts.mono` mixes the channels as it reads.
 */
export function decodeWav(buffer: ArrayBuffer, opts: DecodeWavOptions = {}): DecodedAudio {
  const v = new DataView(buffer);
  const tag = (off: number) => String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
  if (buffer.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file.');
  let off = 12;
  let format = 0;
  let numCh = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buffer.byteLength) {
    const id = tag(off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      format = v.getUint16(body, true);
      numCh = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 40) format = v.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE sub-format
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(size, buffer.byteLength - body);
      break;
    }
    off = body + size + (size % 2);
  }
  if (dataOff < 0 || numCh === 0) throw new Error('WAV file has no audio data.');
  if (format !== 1 && format !== 3) throw new Error(`Unsupported WAV encoding (format ${format}).`);
  const bytes = bits / 8;
  const totalFrames = Math.floor(dataLen / (bytes * numCh));
  const limit = opts.maxSeconds !== undefined && opts.maxSeconds >= 0 && sampleRate > 0 ? Math.floor(opts.maxSeconds * sampleRate) : Infinity;
  const frames = Math.min(totalFrames, limit);
  const mono = !!opts.mono && numCh > 1;
  const channels = Array.from({ length: mono ? 1 : numCh }, () => new Float32Array(frames));
  const gain = 1 / numCh;
  let p = dataOff;
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < numCh; c++) {
      let s: number;
      if (format === 3) s = bits === 64 ? v.getFloat64(p, true) : v.getFloat32(p, true);
      else if (bits === 8) s = (v.getUint8(p) - 128) / 128;
      else if (bits === 16) s = v.getInt16(p, true) / 32768;
      else if (bits === 24) {
        let x = v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16);
        if (x & 0x800000) x |= ~0xffffff;
        s = x / 8388608;
      } else s = v.getInt32(p, true) / 2147483648;
      if (mono) sum += s;
      else channels[c][i] = s;
      p += bytes;
    }
    if (mono) channels[0][i] = sum * gain;
  }
  return { sampleRate, channels, sourceChannels: numCh, totalFrames };
}
