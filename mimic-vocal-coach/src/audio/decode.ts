// Decode an audio file to mono Float32 at its native rate. WAV goes through our own parser first
// (exact samples, no browser resampling, works without an AudioContext); everything else goes to
// the browser's decoder.

import { toMono } from '../dsp/resample';
import { decodeWav } from './wav';

export interface DecodedTake {
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
}

/** File extensions the upload inputs advertise (browsers vary; the decoder is the final judge). */
export const AUDIO_ACCEPT = 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.oga,.opus,.webm,.flac,.caf,.mp4';

/** Bigger files are almost certainly not a single sung take and would exhaust memory when decoded. */
const MAX_FILE_BYTES = 250 * 1024 * 1024;

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

/** Decode any browser-supported audio file to mono Float32 at its native rate. Uses decodeWav for WAV first, then AudioContext.decodeAudioData. */
export async function decodeAudioFile(file: Blob): Promise<DecodedTake> {
  if (file.size === 0) throw new DecodeError(`${fileLabel(file)} is empty.`);
  if (file.size > MAX_FILE_BYTES) {
    throw new DecodeError(`${fileLabel(file)} is too large (${Math.round(file.size / 1048576)} MB). Trim it to the part you sing and try again.`);
  }
  let buf: ArrayBuffer;
  try {
    buf = await file.arrayBuffer();
  } catch {
    throw new DecodeError(`${fileLabel(file)} could not be read.`);
  }

  if (isRiffWave(buf)) {
    try {
      const wav = decodeWav(buf);
      return finish(toMono(wav.channels), wav.sampleRate, file);
    } catch {
      // Compressed WAV variants (ADPCM, mu-law...) are not handled by decodeWav; the browser may manage.
    }
  }

  const ctx = createDecodingContext();
  if (!ctx) {
    throw new DecodeError('This browser cannot decode compressed audio here. Export the take as a WAV file and upload that instead.');
  }
  try {
    // decodeAudioData detaches its input, so hand it a copy.
    const audio = await decodeWith(ctx, buf.slice(0));
    return finish(toMono(channelsOf(audio)), audio.sampleRate, file);
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

function finish(samples: Float32Array, sampleRate: number, file: Blob): DecodedTake {
  if (!(sampleRate > 0) || samples.length === 0) throw new DecodeError(`${fileLabel(file)} contains no audio.`);
  return { samples, sampleRate, durationSec: samples.length / sampleRate };
}
