// Reading a file's length from its header, without decoding it. A compressed file is decoded whole by the browser (about 11 MB of
// samples per minute at 48 kHz stereo, held twice while it is mixed down), so the import asks "how long is this?" first and
// refuses what a phone cannot hold. The MP4/MOV/M4A header is read in decode.ts (probeIsoDurationSec); this file covers the other
// containers: FLAC (STREAMINFO), MP3 (Xing/VBRI frame count, else the bitrate of the first frame), Ogg Vorbis and Opus (the last
// page's position), and WAV (where the audio starts and how much of it to read). Each parser works on bytes already read, so it
// is testable without a File; the async wrappers read only a few KB with Blob.slice.
//
// Every function answers null for "cannot tell": the caller then decides by size.

const fourcc = (b: Uint8Array, o: number): string => (o + 4 <= b.length ? String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) : '');

// ---------------------------------------------------------------------------------------------
// WAV

export interface WavRange {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Where the audio data starts, bytes. */
  dataOffset: number;
  /** Frames in the data (to the end of the file when the header's size is 0 or runs past it). */
  totalFrames: number;
}

/** Where the audio of a WAV starts and how long it is, from its first bytes (null if the header is not within them or is unusual). */
export function parseWavRange(head: Uint8Array, fileSize: number): WavRange | null {
  if (head.length < 12 || fourcc(head, 0) !== 'RIFF' || fourcc(head, 8) !== 'WAVE') return null;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let off = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  while (off + 8 <= head.length) {
    const id = fourcc(head, off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      if (body + 16 > head.length) return null;
      format = v.getUint16(body, true);
      channels = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
      if (format === 0xfffe) {
        if (size < 40 || body + 26 > head.length) return null;
        format = v.getUint16(body + 24, true);
      }
    } else if (id === 'data') {
      if ((format !== 1 && format !== 3) || channels < 1 || !(sampleRate > 0) || ![8, 16, 24, 32, 64].includes(bits)) return null;
      const remain = Math.max(0, fileSize - body);
      const dataLen = size === 0 || size > remain ? remain : size;
      return { sampleRate, channels, bitsPerSample: bits, dataOffset: body, totalFrames: Math.floor(dataLen / (channels * (bits / 8))) };
    }
    off = body + size + (size % 2);
  }
  return null;
}

/** Bytes of a WAV file that hold the header and the first `seconds` of audio; null when that is the whole file (or the header is unreadable). */
export function wavBytesForSeconds(range: WavRange, seconds: number, fileSize: number): number | null {
  const frames = Math.min(range.totalFrames, Math.floor(seconds * range.sampleRate));
  const end = range.dataOffset + frames * range.channels * (range.bitsPerSample / 8);
  return end < fileSize ? end : null;
}

// ---------------------------------------------------------------------------------------------
// FLAC

/** Length in seconds from the STREAMINFO block at the start of a FLAC file; null if the total is not stored. */
export function parseFlacDurationSec(head: Uint8Array): number | null {
  if (head.length < 26 || fourcc(head, 0) !== 'fLaC' || (head[4] & 0x7f) !== 0) return null;
  const rate = (head[18] << 12) | (head[19] << 4) | (head[20] >> 4);
  const total = (head[21] & 0x0f) * 2 ** 32 + (head[22] * 2 ** 24 + (head[23] << 16) + (head[24] << 8) + head[25]);
  return rate > 0 && total > 0 ? total / rate : null;
}

// ---------------------------------------------------------------------------------------------
// MP3

const MP3_BITRATES = {
  v1l1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  v1l2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2l1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  v2l23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
} as const;
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] } as const;

/** Bytes before the first MP3 frame that an ID3v2 tag takes (0 when there is none). Needs the first 10 bytes. */
export function id3v2Length(head: Uint8Array): number {
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0;
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
  return 10 + size + (head[5] & 0x10 ? 10 : 0);
}

/**
 * Length in seconds of an MP3 from the bytes that start at its first frame (after any ID3v2 tag): the frame count of a Xing/Info
 * or VBRI header when there is one, else the file's audio bytes at the first frame's bitrate (exact for constant bitrate files,
 * a guess for variable bitrate files that carry no header). `audioBytes` is the file size minus the tag. `maxScan` is how many
 * bytes to search for the first frame (1 when the file has no ID3 tag: then the frame must start the file).
 */
export function parseMp3DurationSec(frames: Uint8Array, audioBytes: number, maxScan = 4096): number | null {
  const scan = Math.min(frames.length - 4, maxScan);
  for (let i = 0; i < scan; i++) {
    if (frames[i] !== 0xff || (frames[i + 1] & 0xe0) !== 0xe0) continue;
    const b1 = frames[i + 1];
    const b2 = frames[i + 2];
    const b3 = frames[i + 3];
    const version = (b1 >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5, 1 = reserved
    const layer = (b1 >> 1) & 3; // 3 = layer I, 2 = layer II, 1 = layer III, 0 = reserved
    const bitrateIdx = b2 >> 4;
    const rateIdx = (b2 >> 2) & 3;
    if (version === 1 || layer === 0 || bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) continue;
    const table = version === 3 ? (layer === 3 ? MP3_BITRATES.v1l1 : layer === 2 ? MP3_BITRATES.v1l2 : MP3_BITRATES.v1l3) : layer === 3 ? MP3_BITRATES.v2l1 : MP3_BITRATES.v2l23;
    const kbps = table[bitrateIdx];
    const sampleRate = MP3_RATES[version as 3 | 2 | 0][rateIdx];
    const samplesPerFrame = layer === 3 ? 384 : layer === 2 ? 1152 : version === 3 ? 1152 : 576;
    const mono = (b3 >> 6) === 3;
    const sideInfo = version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
    const crc = (b1 & 1) === 0 ? 2 : 0;
    const v = new DataView(frames.buffer, frames.byteOffset, frames.byteLength);
    const xing = i + 4 + crc + sideInfo;
    const tag = fourcc(frames, xing);
    if ((tag === 'Xing' || tag === 'Info') && xing + 12 <= frames.length && (v.getUint32(xing + 4) & 1) !== 0) {
      const count = v.getUint32(xing + 8);
      if (count > 0) return (count * samplesPerFrame) / sampleRate;
    }
    const vbri = i + 4 + 32;
    if (fourcc(frames, vbri) === 'VBRI' && vbri + 18 <= frames.length) {
      const count = v.getUint32(vbri + 14);
      if (count > 0) return (count * samplesPerFrame) / sampleRate;
    }
    return audioBytes > 0 ? (audioBytes * 8) / (kbps * 1000) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Ogg (Vorbis, Opus)

/** The sample rate of the first Ogg page's codec header, and what to subtract from the last granule position (Opus pre-skip). */
export function parseOggStart(head: Uint8Array): { rate: number; skip: number } | null {
  if (head.length < 28 || fourcc(head, 0) !== 'OggS') return null;
  const segments = head[26];
  const p = 27 + segments;
  if (p + 16 > head.length) return null;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head[p] === 1 && fourcc(head, p + 1) === 'vorb' && head[p + 5] === 0x69 && head[p + 6] === 0x73) return { rate: v.getUint32(p + 12, true), skip: 0 };
  if (fourcc(head, p) === 'Opus' && fourcc(head, p + 4) === 'Head') return { rate: 48000, skip: v.getUint16(p + 10, true) };
  return null;
}

/** The granule position (samples) of the last Ogg page in these bytes (the end of the file), or null. */
export function lastOggGranule(tail: Uint8Array): number | null {
  const v = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  for (let i = tail.length - 27; i >= 0; i--) {
    if (tail[i] !== 0x4f || fourcc(tail, i) !== 'OggS') continue;
    const lo = v.getUint32(i + 6, true);
    const hi = v.getUint32(i + 10, true);
    if (hi === 0xffffffff && lo === 0xffffffff) continue; // a page in the middle of a packet has no position
    return hi * 2 ** 32 + lo;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Reading

async function readSlice(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, Math.min(file.size, end)).arrayBuffer());
}

/** The header facts of a WAV file: where its audio starts and how long it is. Null for any other file or a header not in the first 64 KB. */
export async function probeWav(file: Blob): Promise<WavRange | null> {
  if (typeof file.slice !== 'function') return null;
  try {
    return parseWavRange(await readSlice(file, 0, 65536), file.size);
  } catch {
    return null;
  }
}

/** Length in seconds of a FLAC, MP3 or Ogg (Vorbis, Opus) file from a few KB of it; null for anything else or when the header does not say. */
export async function probeContainerDurationSec(file: Blob): Promise<number | null> {
  if (typeof file.slice !== 'function') return null;
  try {
    const head = await readSlice(file, 0, 1024);
    const magic = fourcc(head, 0);
    if (magic === 'fLaC') return parseFlacDurationSec(head);
    if (magic === 'OggS') {
      const start = parseOggStart(await readSlice(file, 0, 512));
      if (!start || start.rate <= 0) return null;
      const granule = lastOggGranule(await readSlice(file, Math.max(0, file.size - 65536), file.size));
      return granule === null ? null : Math.max(0, granule - start.skip) / start.rate;
    }
    const tag = id3v2Length(head);
    const frames = await readSlice(file, tag, tag + 4200);
    return parseMp3DurationSec(frames, file.size - tag, tag > 0 ? 4096 : 1);
  } catch {
    return null;
  }
}
