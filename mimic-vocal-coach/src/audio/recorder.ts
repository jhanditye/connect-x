// Microphone capture as raw PCM. The browser's voice-call processing (echo cancellation, noise
// suppression, automatic gain) is switched off because it gates quiet breathy tone, pumps the
// level and smears harmonics, which would corrupt every measurement the analysis makes.

export type RecorderErrorKind = 'denied' | 'unsupported' | 'no-device';

export class RecorderError extends Error {
  readonly kind: RecorderErrorKind;
  constructor(kind: RecorderErrorKind, message: string) {
    super(message);
    this.name = 'RecorderError';
    this.kind = kind;
  }
}

export interface Recorder {
  start(): Promise<void>;
  stop(): Promise<{ samples: Float32Array; sampleRate: number }>;
  cancel(): void;
  /** For level meter / live pitch; null until start() resolves and after stop/cancel. */
  readonly analyser: AnalyserNode | null;
}

/** Hard cap on one take; the UI stops at this point and further samples are dropped. */
export const MAX_RECORD_SEC = 300;

const MSG_UNSUPPORTED = 'This browser does not give web pages microphone access.';
const MSG_INSECURE = 'The microphone only works on secure (https) pages, and this page is not one.';
const MSG_FRAME = 'This page is embedded in a frame that does not allow the microphone.';
const MSG_DENIED = 'Microphone access was blocked. Allow it in your browser’s site settings, then try again.';
const MSG_NO_DEVICE = 'No microphone was found. Plug one in or check your system sound settings.';
const MSG_BUSY = 'The microphone is busy or failed to start (another app may be using it).';

/** Why recording cannot work here, detected before asking for permission; null when it might. */
export function microphoneUnavailableReason(): string | null {
  const g = globalThis as unknown as {
    isSecureContext?: boolean;
    navigator?: Navigator;
    document?: Document & { permissionsPolicy?: { allowsFeature(f: string): boolean }; featurePolicy?: { allowsFeature(f: string): boolean } };
  };
  if (g.isSecureContext === false) return MSG_INSECURE;
  if (!g.navigator?.mediaDevices?.getUserMedia) return MSG_UNSUPPORTED;
  const policy = g.document?.permissionsPolicy ?? g.document?.featurePolicy;
  try {
    if (policy && !policy.allowsFeature('microphone')) return MSG_FRAME;
  } catch {
    // Policy API present but not usable: let getUserMedia decide.
  }
  return null;
}

/** Map a getUserMedia / AudioContext failure to a RecorderError with a readable message. */
export function toRecorderError(err: unknown): RecorderError {
  if (err instanceof RecorderError) return err;
  const name = (err as { name?: string } | null)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return new RecorderError('denied', MSG_DENIED);
    case 'SecurityError':
      return new RecorderError('denied', `${MSG_FRAME} (or the browser blocked it for security reasons).`);
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return new RecorderError('no-device', MSG_NO_DEVICE);
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new RecorderError('no-device', MSG_BUSY);
    default:
      return new RecorderError('unsupported', `${MSG_UNSUPPORTED}${err instanceof Error && err.message ? ` (${err.message})` : ''}`);
  }
}

// The worklet batches 128-frame render quanta into ~4096-sample chunks so the main thread gets a
// few dozen messages per second instead of hundreds. Channel 0 only: the stream asks for mono.
const WORKLET_SOURCE = `
class MimicCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; this.port.onmessage = (e) => { if (e.data === 'flush') this.flush(); }; }
  flush() { if (this.n > 0) { const out = this.buf.slice(0, this.n); this.port.postMessage(out, [out.buffer]); this.n = 0; } this.port.postMessage('flushed'); }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const take = Math.min(ch.length - i, this.buf.length - this.n);
        this.buf.set(ch.subarray(i, i + take), this.n);
        this.n += take; i += take;
        if (this.n === this.buf.length) { const out = this.buf; this.port.postMessage(out, [out.buffer]); this.buf = new Float32Array(4096); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('mimic-capture', MimicCapture);
`;

type AudioContextCtor = new (opts?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/** Concatenate captured chunks, keeping at most `maxSamples`. */
export function joinChunks(chunks: Float32Array[], maxSamples = Infinity): Float32Array {
  const total = Math.min(
    maxSamples,
    chunks.reduce((n, c) => n + c.length, 0),
  );
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    if (off >= total) break;
    const n = Math.min(c.length, total - off);
    out.set(n === c.length ? c : c.subarray(0, n), off);
    off += n;
  }
  return out;
}

/** getUserMedia with echoCancellation/noiseSuppression/autoGainControl OFF (they wreck voice analysis). Throws RecorderError('denied'|'unsupported'|'no-device'). */
export function createRecorder(): Recorder {
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let sink: GainNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let workletUrl: string | null = null;
  let chunks: Float32Array[] = [];
  let captured = 0;
  let maxSamples = Infinity;
  let active = false;

  const push = (chunk: Float32Array) => {
    if (!active || captured >= maxSamples) return;
    chunks.push(chunk);
    captured += chunk.length;
  };

  const release = () => {
    active = false;
    try {
      source?.disconnect();
      worklet?.disconnect();
      processor?.disconnect();
      sink?.disconnect();
      analyser?.disconnect();
    } catch {
      // Already disconnected.
    }
    if (processor) processor.onaudioprocess = null;
    if (worklet) worklet.port.onmessage = null;
    stream?.getTracks().forEach((t) => t.stop());
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => undefined);
    if (workletUrl) URL.revokeObjectURL(workletUrl);
    stream = null;
    ctx = null;
    analyser = null;
    source = null;
    sink = null;
    worklet = null;
    processor = null;
    workletUrl = null;
  };

  async function attachWorklet(c: AudioContext, src: MediaStreamAudioSourceNode, out: GainNode): Promise<boolean> {
    if (!c.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
    try {
      workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
      await c.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(c, 'mimic-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
      node.port.onmessage = (e: MessageEvent<Float32Array | string>) => {
        if (e.data instanceof Float32Array) push(e.data);
      };
      src.connect(node);
      node.connect(out);
      worklet = node;
      return true;
    } catch {
      // Blob-URL modules can be blocked by a strict CSP; the ScriptProcessor path still works.
      return false;
    }
  }

  function attachScriptProcessor(c: AudioContext, src: MediaStreamAudioSourceNode, out: GainNode): void {
    const node = c.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => push(Float32Array.from(e.inputBuffer.getChannelData(0)));
    src.connect(node);
    node.connect(out);
    processor = node;
  }

  /** Waits for the worklet to post its partially filled buffer, so the last ~90 ms are not lost. */
  function flushWorklet(): Promise<void> {
    const node = worklet;
    if (!node) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 250);
      const prev = node.port.onmessage;
      node.port.onmessage = (e: MessageEvent<Float32Array | string>) => {
        if (e.data === 'flushed') {
          clearTimeout(timer);
          resolve();
        } else prev?.call(node.port, e);
      };
      node.port.postMessage('flush');
    });
  }

  return {
    get analyser() {
      return analyser;
    },

    async start() {
      if (active) return;
      const reason = microphoneUnavailableReason();
      if (reason) throw new RecorderError(reason === MSG_FRAME ? 'denied' : 'unsupported', reason);
      const Ctor = audioContextCtor();
      if (!Ctor) throw new RecorderError('unsupported', MSG_UNSUPPORTED);
      // Create and resume the context before awaiting the permission prompt: iOS Safari only lets
      // audio start synchronously inside the tap that called start().
      let resumed: Promise<void> = Promise.resolve();
      try {
        ctx = new Ctor();
        if (ctx.state === 'suspended') resumed = ctx.resume().catch(() => undefined);
      } catch (err) {
        release();
        throw toRecorderError(err);
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        });
      } catch (err) {
        release();
        throw toRecorderError(err);
      }
      try {
        if (!ctx) throw new RecorderError('unsupported', MSG_UNSUPPORTED);
        await resumed;
        source = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser);
        // Capture nodes must reach the destination to be pulled by the render graph; a zero gain
        // keeps the microphone out of the speakers.
        sink = ctx.createGain();
        sink.gain.value = 0;
        sink.connect(ctx.destination);
        chunks = [];
        captured = 0;
        maxSamples = Math.round(MAX_RECORD_SEC * ctx.sampleRate);
        active = true;
        if (!(await attachWorklet(ctx, source, sink))) attachScriptProcessor(ctx, source, sink);
      } catch (err) {
        release();
        throw toRecorderError(err);
      }
    },

    async stop() {
      const rate = ctx?.sampleRate ?? 48000;
      await flushWorklet();
      const samples = joinChunks(chunks, maxSamples);
      chunks = [];
      release();
      return { samples, sampleRate: rate };
    },

    cancel() {
      chunks = [];
      release();
    },
  };
}
