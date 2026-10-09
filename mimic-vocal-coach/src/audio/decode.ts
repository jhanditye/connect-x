// Decode an audio file to mono Float32 at its native rate. WAV goes through our own parser first
// (exact samples, no browser resampling, works without an AudioContext); everything else goes to
// the browser's decoder.

import { isDesktopKind, platformKind } from '../pwa/platform';
import { probeContainerDurationSec, probeWav, wavBytesForSeconds } from './probe';
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
  /**
   * Refuse compressed files whose header says they are longer than this (seconds) before reading them: a compressed file is
   * decoded whole, so a long one needs hundreds of MB of Float32 samples. The length comes from the header: MP4/MOV/M4A (moov),
   * FLAC (STREAMINFO), MP3 (Xing/VBRI, else the first frame's bitrate) and Ogg (last page). A file whose length cannot be read
   * and is bigger than UNKNOWN_LENGTH_BYTES is refused as too large. Videos are always checked (MAX_VIDEO_SOURCE_SEC when this
   * is not set); audio files only when the caller asks. WAV files are never refused for length: only `maxSeconds` of them are read.
   */
  maxSourceSec?: number;
  /**
   * The rate the browser decodes compressed audio to (default 48 kHz, which keeps phone recordings close to native). The vocal separator
   * wants 44.1 kHz: asking for it here saves a 48 -> 44.1 -> 48 kHz round trip of the whole song (extra memory and seconds on a phone).
   * Ignored for WAV (decoded at its own rate, exactly) and when the browser has to fall back to a realtime context (its hardware rate).
   */
  sampleRate?: number;
}

/** Why a file was refused, for callers that want to show a tailored next step. */
export type DecodeFailure = 'empty' | 'unreadable' | 'too-large' | 'too-long' | 'protected' | 'no-decoder' | 'unsupported' | 'no-audio';

/**
 * What the upload inputs advertise (browsers vary; the decoder is the final judge).
 * iOS Safari does not honour the "audio/*" wildcard (WebKit bug 242110: MDN notes "does not support audio/*") and
 * has greyed out .m4a files (UTI com.apple.m4a-audio) under a bare wildcard, so every extension and the common
 * MIME types are listed explicitly. .qta is the "Editable" export of a Voice Memo on iOS 18+ (QuickTime audio). .m4p (an old iTunes
 * purchase with copy protection) is listed so the file can be chosen and answered with the plain "copy-protected" message, instead of
 * being greyed out in the picker or refused as "not audio" with no reason.
 */
export const AUDIO_ACCEPT = [
  'audio/*',
  '.m4a', '.mp3', '.wav', '.wave', '.aac', '.caf', '.aif', '.aiff', '.flac', '.ogg', '.oga', '.opus', '.webm', '.mp4', '.qta', '.m4p',
  'audio/mp4', 'audio/x-m4a', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/flac', 'audio/ogg', 'audio/webm', 'audio/x-caf', 'audio/aiff',
].join(',');

/**
 * AUDIO_ACCEPT plus phone videos (.mov from the Camera, .mp4/.m4v). iOS offers the Photo Library for video/*, so a clip
 * filmed on the phone can be picked without going through Files; only its audio track is used.
 */
export const MEDIA_ACCEPT = [AUDIO_ACCEPT, 'video/*', '.mov', '.m4v', 'video/mp4', 'video/quicktime', 'video/x-m4v'].join(',');

const MEDIA_EXT = /\.(wav|wave|mp3|m4a|m4b|m4p|aac|ogg|oga|opus|webm|flac|caf|mp4|m4v|mov|qta|aiff?)$/i;

/** True for audio or video files by MIME type or extension (the decoder is still the final judge). */
export function looksLikeMedia(file: { name?: string; type?: string }): boolean {
  return /^(audio|video)\//.test(file.type ?? '') || MEDIA_EXT.test(file.name ?? '');
}

/** A phone video (or any video container): only its audio track is read. A bare .mp4 with no type is treated as audio. */
export function isVideoFile(file: { name?: string; type?: string }): boolean {
  return /^video\//.test(file.type ?? '') || /\.(mov|m4v)$/i.test(file.name ?? '');
}

/** A video this big is not read into memory: iPhone Safari would run out before the audio is decoded. */
export const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
/** Longest video (by its header) whose audio is decoded: 15 minutes is about 350 MB of decoded stereo samples. */
export const MAX_VIDEO_SOURCE_SEC = 15 * 60;

/** What to do with a video that is too big to open here (iPhone). Shown in the import sheet and the Guide as well. */
export const VIDEO_SHORTCUT_TIP =
  'Make an audio-only copy first: in the Shortcuts app use the "Encode Media" action with Audio Only switched on, ' +
  'or trim the video in Photos so it is shorter, share it to Files, and add that file here.';

/** VIDEO_SHORTCUT_TIP in the words of a Mac or another computer (QuickTime Player instead of the Shortcuts app); the phone words elsewhere. */
export function videoShortcutTip(): string {
  return isDesktopKind(platformKind())
    ? 'Make an audio-only copy first: in QuickTime Player choose File, then Export As, then Audio Only, or trim the video so it is shorter, and add that file here.'
    : VIDEO_SHORTCUT_TIP;
}

export const PROTECTED_FILE_TIP = 'Use a DRM-free copy of a song you own, for example a purchased download, a CD rip or a file from your computer.';

/** Bigger files are almost certainly not a single sung take and would exhaust memory when decoded. */
const MAX_FILE_BYTES = 250 * 1024 * 1024;
/**
 * Compressed audio is decoded in full by the browser (about 11 MB of samples per minute at 48 kHz
 * stereo), so a smaller file size already means a very long recording.
 */
const MAX_COMPRESSED_BYTES = 60 * 1024 * 1024;
/**
 * A compressed file whose length cannot be read from its header (WebM, bare AAC, a variable-bitrate MP3 without a header...) is
 * only opened up to this size: 15 minutes at 320 kbps is 36 MB, so this is a long song at an ordinary bitrate, not a recording.
 */
export const UNKNOWN_LENGTH_BYTES = 30 * 1024 * 1024;
/** A mono mix this far below the loudest channel means the channels cancel (one is phase-inverted). */
const CANCEL_DB = 20;
/** WAV mixes quieter than this (-30 dBFS RMS) are re-checked for cancelling channels. */
const QUIET_MIX_RMS = 10 ** (-30 / 20);

const CANCEL_NOTICE =
  'The two channels of this file cancel each other out when mixed (one is phase-inverted, as some interfaces and mics do), so only the louder channel was analysed.';

export class DecodeError extends Error {
  readonly reason: DecodeFailure;
  constructor(message: string, reason: DecodeFailure = 'unsupported') {
    super(message);
    this.name = 'DecodeError';
    this.reason = reason;
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
function createDecodingContext(rate = 48000): DecodingContext | null {
  const g = globalThis as unknown as {
    OfflineAudioContext?: new (ch: number, len: number, rate: number) => DecodingContext;
    webkitOfflineAudioContext?: new (ch: number, len: number, rate: number) => DecodingContext;
    AudioContext?: new () => DecodingContext;
    webkitAudioContext?: new () => DecodingContext;
  };
  const Offline = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  if (Offline) {
    try {
      return new Offline(1, 1, rate);
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
function decodeWavFile(buf: ArrayBuffer, file: Blob, maxSeconds: number | undefined, totalFrames?: number): DecodedTake {
  const wav = decodeWav(buf, { maxSeconds, mono: true });
  let samples = wav.channels[0] ?? new Float32Array(0);
  let cancelled = false;
  // Mixing while reading keeps memory down; a quiet multi-channel mix is re-read per channel in
  // case the channels cancel each other.
  if ((wav.sourceChannels ?? 1) > 1 && rms(samples) < QUIET_MIX_RMS) {
    ({ samples, cancelled } = downmix(decodeWav(buf, { maxSeconds }).channels));
  }
  const total = totalFrames ?? wav.totalFrames ?? samples.length;
  return finish(samples, wav.sampleRate, file, total / wav.sampleRate, cancelled);
}

function tooLarge(file: Blob): DecodeError {
  return new DecodeError(
    `${fileLabel(file)} is too large (${Math.round(file.size / 1048576)} MB). Trim it to the part you sing and try again.`,
    'too-large',
  );
}

function videoTooLarge(file: Blob): DecodeError {
  return new DecodeError(
    `${fileLabel(file)} is a ${Math.round(file.size / 1048576)} MB video, more than this app can open at once (the limit is ${Math.round(MAX_VIDEO_BYTES / 1048576)} MB). ${videoShortcutTip()}`,
    'too-large',
  );
}

function tooLong(file: Blob, durationSec: number, limitSec: number, video: boolean): DecodeError {
  const min = (s: number) => Math.round(s / 60);
  return new DecodeError(
    `${fileLabel(file)} is about ${min(durationSec)} minutes long, more than this app can open at once (the limit is ${min(limitSec)} minutes). ` +
      (video ? videoShortcutTip() : 'Cut it down to the part with the singing and add it again.'),
    'too-long',
  );
}

function protectedFile(file: Blob): DecodeError {
  return new DecodeError(`${fileLabel(file)} is copy-protected, so this app cannot read it. ${PROTECTED_FILE_TIP}`, 'protected');
}

const fourcc = (b: Uint8Array, o: number): string => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** Boxes walked at the top level of an MP4/MOV before giving up (an iPhone movie has about five). */
const MAX_BOX_WALK = 64;
/** A movie header (moov) bigger than this is not parsed. */
const MAX_MOOV_BYTES = 32 * 1024 * 1024;

async function readSlice(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** Duration in seconds from the movie header (mvhd) inside the bytes of a moov box, or null. */
function durationFromMoov(body: Uint8Array): number | null {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let p = 0;
  while (p + 8 <= body.length) {
    let size = dv.getUint32(p);
    const type = fourcc(body, p + 4);
    if (size === 0) size = body.length - p;
    if (size < 8) return null;
    if (type === 'mvhd') {
      const version = body[p + 8];
      let timescale: number;
      let duration: number;
      if (version === 1) {
        if (p + 40 > body.length) return null;
        timescale = dv.getUint32(p + 28);
        duration = Number(dv.getBigUint64(p + 32));
      } else {
        if (p + 28 > body.length) return null;
        timescale = dv.getUint32(p + 20);
        duration = dv.getUint32(p + 24);
      }
      return timescale > 0 && Number.isFinite(duration) ? duration / timescale : null;
    }
    p += size;
  }
  return null;
}

/**
 * Length in seconds of an MP4, MOV or M4A file from its header, without reading the file: walks the top-level boxes
 * with small slices (an iPhone movie keeps the header at the end, behind the media data) and reads only the moov box.
 * Null when the file is not an ISO base media file, the header is missing or odd, or the Blob cannot be sliced.
 */
export async function probeIsoDurationSec(file: Blob): Promise<number | null> {
  if (typeof file.slice !== 'function') return null;
  try {
    let pos = 0;
    for (let n = 0; n < MAX_BOX_WALK && pos + 8 <= file.size; n++) {
      const head = await readSlice(file, pos, Math.min(file.size, pos + 16));
      if (head.length < 8) return null;
      const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
      let size = dv.getUint32(0);
      const type = fourcc(head, 4);
      let headerLen = 8;
      if (n === 0 && type !== 'ftyp') return null;
      if (size === 1) {
        if (head.length < 16) return null;
        size = Number(dv.getBigUint64(8));
        headerLen = 16;
      } else if (size === 0) {
        size = file.size - pos;
      }
      if (!(size >= headerLen)) return null;
      if (type === 'moov') {
        if (size > MAX_MOOV_BYTES) return null;
        return durationFromMoov(await readSlice(file, pos + headerLen, Math.min(file.size, pos + size)));
      }
      pos += size;
    }
  } catch {
    // An unreadable header only means "length unknown"; decoding decides.
  }
  return null;
}

/** AIFF and CAF hold uncompressed audio: their size already tells their length, so the unknown-length limit does not apply. */
async function isUncompressedPcmContainer(file: Blob): Promise<boolean> {
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const tag = fourcc(head, 0);
    return tag === 'FORM' || tag === 'caff';
  } catch {
    return false;
  }
}

/** "M4P " is the brand of FairPlay-protected AAC (iTunes and Apple Music downloads). */
function hasProtectedBrand(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 12) return false;
  const b = new Uint8Array(buf, 0, 12);
  return fourcc(b, 4) === 'ftyp' && fourcc(b, 8) === 'M4P ';
}

/**
 * Decode any browser-supported audio file to mono Float32 at its native rate. Uses decodeWav for WAV
 * first, then AudioContext.decodeAudioData (and once more with an M4A brand relabelled when Safari refuses it).
 * Phone videos (.mov, .mp4, .m4v) work the same way: the browser decodes their audio track. `opts.maxSeconds` keeps
 * only the start of a long file. Failures are DecodeErrors whose message names the fix and whose `reason` says why.
 */
export async function decodeAudioFile(file: Blob, opts: DecodeOptions = {}): Promise<DecodedTake> {
  if (file.size === 0) throw new DecodeError(`${fileLabel(file)} is empty.`, 'empty');
  const video = isVideoFile(file as { name?: string; type?: string });
  if (/\.m4p$/i.test((file as File).name ?? '')) throw protectedFile(file);
  if (video ? file.size > MAX_VIDEO_BYTES : file.size > MAX_FILE_BYTES) throw video ? videoTooLarge(file) : tooLarge(file);

  // A WAV is read only as far as `maxSeconds` needs: its header says where the audio starts and how long it is.
  const wavHeader = video ? null : await probeWav(file);
  let readBytes: number | null = null;
  if (wavHeader && opts.maxSeconds !== undefined && opts.maxSeconds >= 0) readBytes = wavBytesForSeconds(wavHeader, opts.maxSeconds, file.size);

  const sourceLimit = opts.maxSourceSec ?? (video ? MAX_VIDEO_SOURCE_SEC : undefined);
  if (!wavHeader) {
    const lengthSec = sourceLimit !== undefined || !video ? ((await probeIsoDurationSec(file)) ?? (video ? null : await probeContainerDurationSec(file))) : null;
    if (sourceLimit !== undefined && lengthSec !== null && lengthSec > sourceLimit) throw tooLong(file, lengthSec, sourceLimit, video);
    if (!video && lengthSec === null && file.size > UNKNOWN_LENGTH_BYTES && !(await isUncompressedPcmContainer(file))) throw tooLarge(file);
  }

  let buf: ArrayBuffer;
  try {
    buf = await (readBytes !== null ? file.slice(0, readBytes) : file).arrayBuffer();
  } catch {
    throw new DecodeError(`${fileLabel(file)} could not be read.`, 'unreadable');
  }
  if (hasProtectedBrand(buf)) throw protectedFile(file);

  if (isRiffWave(buf)) {
    try {
      return decodeWavFile(buf, file, opts.maxSeconds, readBytes !== null ? wavHeader?.totalFrames : undefined);
    } catch (err) {
      // A readable WAV with no samples says so; compressed WAV variants (ADPCM, mu-law...) are not
      // handled by decodeWav, and the browser may manage them.
      if (err instanceof DecodeError) throw err;
    }
  }
  if (!video && file.size > MAX_COMPRESSED_BYTES) throw tooLarge(file);

  const ctx = createDecodingContext(opts.sampleRate !== undefined && opts.sampleRate >= 8000 && opts.sampleRate <= 96000 ? Math.round(opts.sampleRate) : 48000);
  if (!ctx) {
    throw new DecodeError('This browser cannot decode compressed audio here. Export the take as a WAV file and upload that instead.', 'no-decoder');
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
    if (video) {
      throw new DecodeError(
        `${fileLabel(file)}${type} is a video and its sound could not be read in this browser. It may have no audio track or use a format ${isDesktopKind(platformKind()) ? 'this browser' : 'Safari'} cannot open. ${videoShortcutTip()}`,
        'unsupported',
      );
    }
    throw new DecodeError(
      `${fileLabel(file)}${type} could not be decoded as audio in this browser. Try WAV, MP3 or M4A; if it is a video, export just the audio.`,
      'unsupported',
    );
  } finally {
    ctx.close?.().catch(() => undefined);
  }
}

function finish(samples: Float32Array, sampleRate: number, file: Blob, sourceDurationSec: number, cancelled: boolean): DecodedTake {
  if (!(sampleRate > 0) || samples.length === 0) throw new DecodeError(`${fileLabel(file)} contains no audio.`, 'no-audio');
  const durationSec = samples.length / sampleRate;
  return {
    samples,
    sampleRate,
    durationSec,
    sourceDurationSec: Number.isFinite(sourceDurationSec) ? Math.max(durationSec, sourceDurationSec) : durationSec,
    notices: cancelled ? [CANCEL_NOTICE] : [],
  };
}
