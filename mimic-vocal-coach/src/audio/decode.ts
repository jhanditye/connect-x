// Decode an audio file to mono Float32 at its native rate. WAV goes through our own parser first
// (exact samples, no browser resampling, works without an AudioContext); everything else goes to
// the browser's decoder.

import { decodeWav } from './wav';

export interface DecodedTake {
  samples: Float32Array;
  sampleRate: number;
  /** Length of `samples`, s. */
  durationSec: number;
  /** Length of the whole file, s: more than durationSec when `maxSeconds` cut it short. */
  sourceDurationSec: number;
  /** Notes for the user about how the file was read (e.g. stereo channels that cancel out). */
  notices: string[];
}

export interface DecodeOptions {
  /** Keep only the first this-many seconds. WAV files are then only decoded that far. */
  maxSeconds?: number;
}

/**
 * What the upload inputs advertise (browsers vary; the decoder is the final judge).
 * iOS Safari does not honour the "audio/*" wildcard (WebKit bug 242110: MDN notes "does not support audio/*") and
 * has greyed out .m4a files (UTI com.apple.m4a-audio) under a bare wildcard, so every extension and the common
 * MIME types are listed explicitly. .qta is the "Editable" export of a Voice Memo on iOS 18+ (QuickTime audio).
 */
export const AUDIO_ACCEPT = [
  'audio/*',
  '.m4a', '.mp3', '.wav', '.wave', '.aac', '.caf', '.aif', '.aiff', '.flac', '.ogg', '.oga', '.opus', '.webm', '.mp4', '.qta',
  'audio/mp4', 'audio/x-m4a', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/flac', 'audio/ogg', 'audio/webm', 'audio/x-caf', 'audio/aiff',
].join(',');

/** Bigger files are almost certainly not a single sung take and would exhaust memory when decoded. */
const MAX_FILE_BYTES = 250 * 1024 * 1024;
/**
 * Compressed audio is decoded in full by the browser (about 11 MB of samples per minute at 48 kHz
 * stereo), so a smaller file size already means a very long recording.
 */
const MAX_COMPRESSED_BYTES = 60 * 1024 * 1024;
/** A mono mix this far below the loudest channel means the channels cancel (one is phase-inverted). */
const CANCEL_DB = 20;
/** WAV mixes quieter than this (-30 dBFS RMS) are re-checked for cancelling channels. */
const QUIET_MIX_RMS = 10 ** (-30 / 20);

const CANCEL_NOTICE =
  'The two channels of this file cancel each other out when mixed (one is phase-inverted, as some interfaces and mics do), so only the louder channel was analysed.';

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

function fileLabel(file: Blob): string {
  const name = (file as File).name;
  return name ? `"${name}"` : 'This file';
}

function isRiffWave(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false;
  const b = new Uint8Array(buf, 0, 12);
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  return tag(0) === 'RIFF' && tag(8) === 'WAVE';
}

type DecodingContext = {
  decodeAudioData(
    data: ArrayBuffer,
    ok?: (b: AudioBuffer) => void,
    fail?: (e: DOMException | null) => void,
  ): Promise<AudioBuffer> | void;
  close?: () => Promise<void>;
};

/**
 * An offline context is preferred: it needs no audio output device and no user gesture. Its rate
 * sets the decode rate, so 48 kHz keeps phone recordings (usually 44.1/48 kHz) close to native.
 */
function createDecodingContext(): DecodingContext | null {
  const g = globalThis as unknown as {
    OfflineAudioContext?: new (ch: number, len: number, rate: number) => DecodingContext;
    webkitOfflineAudioContext?: new (ch: number, len: number, rate: number) => DecodingContext;
    AudioContext?: new () => DecodingContext;
    webkitAudioContext?: new () => DecodingContext;
  };
  const Offline = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  if (Offline) {
    try {
      return new Offline(1, 1, 48000);
    } catch {
      // Some browsers reject unusual rates; fall through to a realtime context.
    }
  }
  const Realtime = g.AudioContext ?? g.webkitAudioContext;
  if (Realtime) {
    try {
      return new Realtime();
    } catch {
      return null;
    }
  }
  return null;
}

/** ISO base media brands that Safari 26 - 27.1 was reported to refuse in decodeAudioData (fixed in Safari 27.2 beta: "valid AAC and M4A files whose file brand is not mp4"). */
const RELABELLABLE_BRANDS = ['M4A ', 'M4B ', 'F4A '];

/**
 * A copy of an MP4/M4A file whose major brand is relabelled "mp42", or null when the file is not one of the
 * brands above. Used only as a second attempt after decodeAudioData refused the original: the audio is
 * untouched, only the 4-byte brand in the leading "ftyp" box changes. (Voice Memos writes "M4A ".)
 */
export function relabelMp4Brand(buf: ArrayBuffer): ArrayBuffer | null {
  if (buf.byteLength < 12) return null;
  const b = new Uint8Array(buf, 0, 12);
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(4) !== 'ftyp' || !RELABELLABLE_BRANDS.includes(tag(8))) return null;
  const copy = buf.slice(0);
  new Uint8Array(copy, 8, 4).set([0x6d, 0x70, 0x34, 0x32]); // "mp42"
  return copy;
}

/** decodeAudioData in both its promise and (old Safari) callback forms. */
function decodeWith(ctx: DecodingContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    try {
      const maybe = ctx.decodeAudioData(data, resolve, (e) => reject(e ?? new Error('decode failed')));
      if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
}

function channelsOf(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
}

function rms(x: Float32Array, n = x.length): number {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += x[i] * x[i];
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

/**
 * The first `frames` frames mixed to mono. When the mix is far quieter than the loudest channel
 * (a phase-inverted channel cancels the other), that channel is used instead.
 */
export function downmix(channels: Float32Array[], frames = Infinity): { samples: Float32Array; cancelled: boolean } {
  if (channels.length === 0) return { samples: new Float32Array(0), cancelled: false };
  const n = Math.max(0, Math.min(frames, ...channels.map((c) => c.length)));
  if (channels.length === 1) return { samples: channels[0].length === n ? channels[0] : channels[0].slice(0, n), cancelled: false };
  const out = new Float32Array(n);
  const g = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] * g;
  let loudest = 0;
  let loudestRms = 0;
  channels.forEach((ch, c) => {
    const r = rms(ch, n);
    if (r > loudestRms) {
      loudestRms = r;
      loudest = c;
    }
  });
  if (loudestRms > 0 && rms(out) < loudestRms * 10 ** (-CANCEL_DB / 20)) {
    return { samples: channels[loudest].slice(0, n), cancelled: true };
  }
  return { samples: out, cancelled: false };
}

function frameLimit(maxSeconds: number | undefined, sampleRate: number): number {
  return maxSeconds !== undefined && maxSeconds >= 0 ? Math.floor(maxSeconds * sampleRate) : Infinity;
}

/** Our own WAV parser: exact samples, and only as much of a long file as `maxSeconds` asks for. */
function decodeWavFile(buf: ArrayBuffer, file: Blob, maxSeconds: number | undefined): DecodedTake {
  const wav = decodeWav(buf, { maxSeconds, mono: true });
  let samples = wav.channels[0] ?? new Float32Array(0);
  let cancelled = false;
  // Mixing while reading keeps memory down; a quiet multi-channel mix is re-read per channel in
  // case the channels cancel each other.
  if ((wav.sourceChannels ?? 1) > 1 && rms(samples) < QUIET_MIX_RMS) {
    ({ samples, cancelled } = downmix(decodeWav(buf, { maxSeconds }).channels));
  }
  const total = wav.totalFrames ?? samples.length;
  return finish(samples, wav.sampleRate, file, total / wav.sampleRate, cancelled);
}

function tooLarge(file: Blob): DecodeError {
  return new DecodeError(`${fileLabel(file)} is too large (${Math.round(file.size / 1048576)} MB). Trim it to the part you sing and try again.`);
}

/**
 * Decode any browser-supported audio file to mono Float32 at its native rate. Uses decodeWav for WAV
 * first, then AudioContext.decodeAudioData. `opts.maxSeconds` keeps only the start of a long file.
 */
export async function decodeAudioFile(file: Blob, opts: DecodeOptions = {}): Promise<DecodedTake> {
  if (file.size === 0) throw new DecodeError(`${fileLabel(file)} is empty.`);
  if (file.size > MAX_FILE_BYTES) throw tooLarge(file);
  let buf: ArrayBuffer;
  try {
    buf = await file.arrayBuffer();
  } catch {
    throw new DecodeError(`${fileLabel(file)} could not be read.`);
  }

  if (isRiffWave(buf)) {
    try {
      return decodeWavFile(buf, file, opts.maxSeconds);
    } catch (err) {
      // A readable WAV with no samples says so; compressed WAV variants (ADPCM, mu-law...) are not
      // handled by decodeWav, and the browser may manage them.
      if (err instanceof DecodeError) throw err;
    }
  }
  if (file.size > MAX_COMPRESSED_BYTES) throw tooLarge(file);

  const ctx = createDecodingContext();
  if (!ctx) {
    throw new DecodeError('This browser cannot decode compressed audio here. Export the take as a WAV file and upload that instead.');
  }
  try {
    // decodeAudioData detaches its input, so the relabelled copy for the second attempt is made first.
    const retryBuf = relabelMp4Brand(buf);
    let audio: AudioBuffer;
    try {
      audio = await decodeWith(ctx, buf);
    } catch (first) {
      if (!retryBuf) throw first;
      audio = await decodeWith(ctx, retryBuf);
    }
    const { samples, cancelled } = downmix(channelsOf(audio), frameLimit(opts.maxSeconds, audio.sampleRate));
    return finish(samples, audio.sampleRate, file, audio.length / audio.sampleRate, cancelled);
  } catch (err) {
    if (err instanceof DecodeError) throw err;
    const type = file.type ? ` (${file.type})` : '';
    throw new DecodeError(
      `${fileLabel(file)}${type} could not be decoded as audio in this browser. Try WAV, MP3 or M4A; if it is a video, export just the audio.`,
    );
  } finally {
    ctx.close?.().catch(() => undefined);
  }
}

function finish(samples: Float32Array, sampleRate: number, file: Blob, sourceDurationSec: number, cancelled: boolean): DecodedTake {
  if (!(sampleRate > 0) || samples.length === 0) throw new DecodeError(`${fileLabel(file)} contains no audio.`);
  const durationSec = samples.length / sampleRate;
  return {
    samples,
    sampleRate,
    durationSec,
    sourceDurationSec: Number.isFinite(sourceDurationSec) ? Math.max(durationSec, sourceDurationSec) : durationSec,
    notices: cancelled ? [CANCEL_NOTICE] : [],
  };
}
