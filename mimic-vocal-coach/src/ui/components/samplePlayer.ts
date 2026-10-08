// A tiny player for the import review: play mono samples (a phrase of the clip, or the detected melody as a tone) and say
// where it is, so the strip can draw a playhead. One AudioContext for the life of the review, created on the first tap (iOS
// needs a user gesture), closed on dispose. The phrase player for practice is audio/player.ts; this one only previews.

import { setAudioSessionType } from '../../audio/audioSession';

export interface SamplePlayOptions {
  /** The clip time of sample 0, so `position()` is in clip time (default 0). */
  fromSec?: number;
  onEnded?: () => void;
}

export interface SamplePlayer {
  /** Stops anything playing and plays the samples. Resolves false when the browser has no Web Audio or refused to start it. */
  play(samples: Float32Array, sampleRate: number, opts?: SamplePlayOptions): Promise<boolean>;
  stop(): void;
  /** Clip time right now, or null when nothing is playing. */
  position(): number | null;
  readonly playing: boolean;
  /** Stops and closes the audio context. The player can be used again afterwards (it opens a new one). */
  dispose(): void;
}

function contextConstructor(): (new () => AudioContext) | null {
  const g = globalThis as unknown as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

export function createSamplePlayer(): SamplePlayer {
  let ctx: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  let startedAt = 0;
  let fromSec = 0;
  let length = 0;
  let active = false;
  /** Bumped by every play and stop, so a play that was superseded while it awaited the context does nothing. */
  let token = 0;

  function stop(): void {
    token++;
    const s = source;
    source = null;
    active = false;
    if (!s) return;
    s.onended = null;
    try {
      s.stop();
    } catch {
      // Already stopped.
    }
    try {
      s.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  return {
    async play(samples, sampleRate, opts = {}) {
      stop();
      const my = token;
      const Ctor = contextConstructor();
      if (!Ctor || samples.length === 0 || !(sampleRate > 0)) return false;
      try {
        // The ring/silent switch mutes plain Web Audio on iPhone; 'playback' ignores it.
        setAudioSessionType('playback');
        ctx ??= new Ctor();
        // resume() must be started inside the tap that called play(), before the first await.
        const resumed = ctx.state === 'suspended' ? ctx.resume() : Promise.resolve();
        await resumed;
        if (my !== token || !ctx) return false;
        const buffer = ctx.createBuffer(1, samples.length, sampleRate);
        if (typeof buffer.copyToChannel === 'function') buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
        else buffer.getChannelData(0).set(samples);
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(ctx.destination);
        node.onended = () => {
          if (token !== my) return;
          active = false;
          source = null;
          opts.onEnded?.();
        };
        node.start();
        source = node;
        startedAt = ctx.currentTime;
        fromSec = opts.fromSec ?? 0;
        length = samples.length / sampleRate;
        active = true;
        return true;
      } catch {
        stop();
        return false;
      }
    },
    stop,
    position() {
      if (!active || !ctx) return null;
      return fromSec + Math.max(0, Math.min(length, ctx.currentTime - startedAt));
    },
    get playing() {
      return active;
    },
    dispose() {
      stop();
      const c = ctx;
      ctx = null;
      setAudioSessionType('auto');
      if (c && typeof c.close === 'function') void c.close().catch(() => undefined);
    },
  };
}
