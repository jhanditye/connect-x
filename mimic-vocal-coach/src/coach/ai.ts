// Optional AI coach: turns the numeric analysis into conversational feedback with Claude, using the
// user's own Anthropic API key. Only the compact summary built by summarizeForAi and the chat text
// are sent, never audio or per-frame data.

import Anthropic, {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import type {
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTextBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { midiToNoteName } from '../dsp/music';
import type {
  AppSettings,
  CoachingPlan,
  Comparison,
  ReferenceComparison,
  SingerProfile,
  StyleVector,
  TargetBand,
  VoiceAnalysis,
} from '../types';

export interface AiCoachInput {
  analysis: VoiceAnalysis;
  comparison: Comparison;
  plan: CoachingPlan;
  profile: SingerProfile;
  reference?: ReferenceComparison;
  question?: string;
  history?: { role: 'user' | 'assistant'; text: string }[];
}

export type AiCoachErrorKind = 'auth' | 'rate' | 'network' | 'refusal' | 'other';

export class AiCoachError extends Error {
  readonly kind: AiCoachErrorKind;
  /** HTTP status when the API answered with an error. */
  readonly status?: number;

  constructor(kind: AiCoachErrorKind, message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AiCoachError';
    this.kind = kind;
    this.status = options?.status;
  }
}

export const DEFAULT_AI_MODEL = 'claude-opus-5';

export const DEFAULT_AI_QUESTION = 'Give me feedback on this take and what to practise next.';
const DEFAULT_FOLLOW_UP = 'What should I practise next?';

/** Test seam: a custom fetch (and retry count) for the SDK client. The app never passes this. */
export interface AiCoachDeps {
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  maxRetries?: number;
}

// ---------------------------------------------------------------------------------------------
// Prompt

// Kept byte-for-byte stable (no dates, no per-take data) so the prompt prefix can be cached;
// everything volatile goes in the messages.
export const AI_SYSTEM_PROMPT = `You are an experienced contemporary vocal coach for pop, R&B and soul, and a specialist in mixed voice: blending chest and head registers so the voice stays connected and easy through the passaggio (the register-transition zone). You are working inside Mimic Vocal Coach, an app that analyses a singer's recorded take on their own device and compares it with the sound of a target singer: Shawn Mendes, Daniel Caesar, Jalen Ngonda, or a profile measured from a reference clip the singer uploaded.

What you receive
The first user message holds a JSON summary of the analysis inside <analysis> tags, followed by the singer's question. You never hear the audio; you only see these measurements:
- singer: the target profile, with a target band per style dimension (ideal, low-high band, weight = how much it matters to this singer's sound).
- comparison: the singer's value for each dimension, the target, a 0-100 closeness score and a direction ("more" = raise it, "less" = lower it, "ok" = on target).
- plan: the app's own prioritised coaching plan. Build on it rather than contradicting it, unless the numbers clearly point elsewhere.
- take: pitch range with note names, the passaggio zone, the style vector, tone medians, register shares, and summaries of notes, phrases (with their times), runs and onsets, plus recording quality and warnings.
- reference (optional): a phrase-by-phrase pitch comparison with a reference clip after transposing to the singer's key (transposeSemitones = singer minus reference; positive cents = singer sharp).

Style dimensions (0-1 indices unless a unit is given):
- breathiness: 0-0.2 pressed or very clean, 0.3-0.5 clear and balanced, 0.6-0.8 clearly airy (soft R&B), 0.9-1 near-whisper.
- brightness: 0-0.3 dark, covered, warm; 0.4-0.6 neutral; 0.7-1 bright, forward, twangy.
- rasp: 0-0.15 clean, 0.2-0.4 slight grit on louder notes, 0.5 and above obvious rasp.
- vibratoPresence: share of sustained notes with vibrato; vibratoRateHz; vibratoExtentCents (plus/minus semi-extent).
- chestInUpperRange, mixInUpperRange, headInUpperRange: shares of the singing at or above the bottom of the passaggio estimated as chest, mix or head.
- loudnessClimbDbPerSemitone: loudness gained per semitone climbed in the upper range; above about 0.8 suggests carrying chest weight upward.
- agility: notes per second inside runs (0 = no runs). dynamicRangeDb: loudness spread. softOnsetRatio: share of phrases that start with a breathy onset. pitchAccuracyCents: average deviation of held notes from the nearest semitone (lower is better). flipsPerMinute: sudden switches into head voice or falsetto.

How to coach
- Ground every observation in the numbers and quote the relevant one briefly in plain words (for example "about 55% of your singing above D4 read as chest"). Don't claim to have heard anything and don't invent measurements. If the data can't answer something, say so.
- Register labels and the tone indices are estimates from acoustic proxies (H1-H2, spectral tilt, alpha ratio, cepstral peak prominence, loudness against pitch), not certainties. Say "reads as" or "estimated", and mention recording warnings when they make a measurement less trustworthy.
- Coach toward the target singer's sound using the profile's targets. Describe the sound in listening terms; don't state biographical facts, quotes or claims about the singer beyond what the profile says.
- Give specific technique cues and one to three exercises the singer can do today, such as straw phonation or lip trills, sirens and slides through the passaggio, narrowing or modifying vowels as the line climbs (for example toward "uh" or "oo"), lighter onsets, and keeping the volume level as the pitch rises.
- Keep it safe. Never tell the singer to push louder, belt harder or power through strain. For high notes, cue less weight, less volume, narrower vowels and semi-occluded (straw, lip trill) work. Never suggest creating rasp or grit by squeezing the throat; if some grit is part of the target, treat it as optional and light, on an easy, well-supported tone, and tell them to stop if it hurts, tickles or leaves the voice hoarse. Recommend rest and water when strain shows up, and a voice specialist (an ENT doctor or speech-language pathologist) for hoarseness or pain that doesn't go away.
- Be concise and structured: a one-line overall read, then a few short bullets or short paragraphs on the one or two changes that will make the biggest difference. Use plain text with simple "-" bullets; no tables or headings.
- Finish by asking the singer to re-record something specific (a phrase by its time and top note, for example "the phrase at 0:32 that peaks on G4") with the single change to focus on.
- For follow-up questions, answer the question directly, using the same measurements.`;

// ---------------------------------------------------------------------------------------------
// Summary sent to the model

const MAX_PHRASES = 16;
const MAX_SEGMENTS = 10;
const MAX_OFF_NOTES = 5;
const MAX_TEXT = 280;

function num(x: number | null | undefined, digits: number): number | null {
  if (x === null || x === undefined || !Number.isFinite(x)) return null;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

function clip(s: string, max = MAX_TEXT): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function note(midi: number | null): string | null {
  return midi === null || !Number.isFinite(midi) ? null : midiToNoteName(midi);
}

/** 32.4 -> "0:32.4" */
function clock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

const span = (a: number, b: number): string => `${clock(a)}-${clock(b)}`;

function roundedStyle(style: StyleVector): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(style) as [string, number | null][]) out[k] = num(v, 2);
  return out;
}

function roundedBand(b: TargetBand): { ideal: number | null; low: number | null; high: number | null; weight: number | null } {
  return { ideal: num(b.ideal, 2), low: num(b.low, 2), high: num(b.high, 2), weight: num(b.weight, 2) };
}

function summarizeProfile(p: SingerProfile): object {
  const targets: Record<string, object> = {};
  for (const [k, band] of Object.entries(p.targets)) if (band) targets[k] = roundedBand(band);
  return {
    name: p.name,
    source: p.source === 'reference' ? 'measured from the singer\'s reference clip' : 'hand-authored estimate',
    description: clip(p.description, 600),
    typicalRange: `${note(p.typicalRange.lowMidi)}-${note(p.typicalRange.highMidi)}`,
    targets,
  };
}

function summarizeComparison(c: Comparison): object {
  return {
    overall: Math.round(c.overall),
    dimensions: c.dimensions.map((d) => ({
      key: d.key,
      value: num(d.value, 2),
      target: { ideal: num(d.target.ideal, 2), low: num(d.target.low, 2), high: num(d.target.high, 2) },
      score: Math.round(d.score),
      direction: d.direction,
    })),
    suggestedTransposeSemitones: c.suggestedTransposeSemitones,
    rangeNote: clip(c.rangeNote),
  };
}

function summarizePlan(p: CoachingPlan): object {
  return {
    headline: clip(p.headline, 400),
    items: p.items.map((i) => ({ priority: i.priority, title: clip(i.title, 120), whatWeHeard: clip(i.whatWeHeard) })),
  };
}

/** Per-phrase note range and upper-range register mix, so the coach can point at specific phrases. */
function summarizePhrases(a: VoiceAnalysis): object[] {
  const rows = a.phrases.map((ph) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const n of a.notes) {
      if (n.end <= ph.start || n.start >= ph.end) continue;
      lo = Math.min(lo, n.nearestMidi);
      hi = Math.max(hi, n.nearestMidi);
    }
    const reg = { chest: 0, mix: 0, head: 0 };
    let upper = 0;
    for (const f of a.frames) {
      if (f.t < ph.start || f.t >= ph.end || !f.voiced || !(f.midi >= a.passaggio.lowMidi) || f.register === null) continue;
      reg[f.register]++;
      upper++;
    }
    return { ph, lo, hi, reg, upper };
  });
  // Long takes: keep the phrases that reach highest (where mix matters most), then restore time order.
  const kept =
    rows.length > MAX_PHRASES
      ? [...rows].sort((x, y) => y.hi - x.hi).slice(0, MAX_PHRASES).sort((x, y) => x.ph.start - y.ph.start)
      : rows;
  return kept.map(({ ph, lo, hi, reg, upper }) => {
    const row: Record<string, string> = { at: span(ph.start, ph.end) };
    if (Number.isFinite(lo)) row.notes = lo === hi ? `${note(lo)}` : `${note(lo)}-${note(hi)}`;
    // Fewer than ~0.1 s of upper-range singing is too little to report a register mix for.
    if (upper >= 10) {
      const p = (k: keyof typeof reg): string => `${Math.round((reg[k] / upper) * 100)}%`;
      row.upperRange = `chest ${p('chest')}, mix ${p('mix')}, head ${p('head')}`;
    }
    return row;
  });
}

function summarizeNotes(a: VoiceAnalysis): object {
  const n = a.notes.length;
  const withVibrato = a.notes.filter((x) => x.vibrato !== null).length;
  const absOff = a.notes.filter((x) => Number.isFinite(x.centsOff)).map((x) => Math.abs(x.centsOff));
  const mostOff = [...a.notes]
    .filter((x) => Number.isFinite(x.centsOff) && Math.abs(x.centsOff) >= 20)
    .sort((x, y) => Math.abs(y.centsOff) - Math.abs(x.centsOff))
    .slice(0, MAX_OFF_NOTES)
    .sort((x, y) => x.start - y.start)
    .map((x) => ({ at: clock(x.start), note: note(x.nearestMidi), centsOff: Math.round(x.centsOff) }));
  return {
    count: n,
    withVibratoShare: n ? num(withVibrato / n, 2) : null,
    meanAbsCentsOff: absOff.length ? num(absOff.reduce((s, x) => s + x, 0) / absOff.length, 0) : null,
    mostOffPitch: mostOff,
  };
}

function summarizeTake(a: VoiceAnalysis): object {
  const p = a.pitch;
  const onsets = { breathy: 0, balanced: 0, glottal: 0 };
  for (const o of a.onsets) onsets[o.type]++;
  return {
    durationSec: num(a.durationSec, 1),
    voicedSec: num(a.voicedSec, 1),
    pitch: {
      median: note(p.medianMidi),
      range: p.lowMidi !== null && p.highMidi !== null ? `${note(p.lowMidi)}-${note(p.highMidi)}` : null,
      tessitura: p.tessituraLowMidi !== null && p.tessituraHighMidi !== null ? `${note(p.tessituraLowMidi)}-${note(p.tessituraHighMidi)}` : null,
      tuningOffsetCents: num(p.tuningOffsetCents, 0),
    },
    passaggio: `${note(a.passaggio.lowMidi)}-${note(a.passaggio.highMidi)}`,
    style: roundedStyle(a.style),
    tone: {
      h1h2Db: num(a.tone.h1h2Db, 1),
      alphaRatioDb: num(a.tone.alphaRatioDb, 1),
      centroidHz: num(a.tone.centroidHz, 0),
      tiltDbPerOct: num(a.tone.tiltDbPerOct, 1),
      cppDb: num(a.tone.cppDb, 1),
      hnrDb: num(a.tone.hnrDb, 1),
    },
    registerSharesAllSinging: {
      chest: num(a.registerShares.chest, 2),
      mix: num(a.registerShares.mix, 2),
      head: num(a.registerShares.head, 2),
    },
    notes: summarizeNotes(a),
    phrases: summarizePhrases(a),
    runs: {
      count: a.runs.length,
      fastestNotesPerSec: a.runs.length ? num(Math.max(...a.runs.map((r) => r.notesPerSec)), 1) : null,
    },
    onsets: { count: a.onsets.length, ...onsets },
    quality: {
      snrDb: num(a.quality.snrDb, 0),
      clippingPercent: num(a.quality.clippingRatio * 100, 2),
      noiseFloorDb: num(a.quality.noiseFloorDb, 0),
    },
    warnings: a.warnings.map((w) => clip(w, 200)),
  };
}

function summarizeReference(r: ReferenceComparison): object {
  const segs =
    r.segments.length > MAX_SEGMENTS
      ? [...r.segments].sort((a, b) => b.meanAbsCents - a.meanAbsCents).slice(0, MAX_SEGMENTS).sort((a, b) => a.refStart - b.refStart)
      : r.segments;
  const styleDiff: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(r.styleDiff)) styleDiff[k] = num(v, 2);
  return {
    transposeSemitones: r.transposeSemitones,
    meanAbsCents: num(r.meanAbsCents, 0),
    withinFiftyCentsShare: num(r.withinFiftyCents, 2),
    phrasesCompared: r.segments.length,
    phrases: segs.map((s) => ({
      reference: span(s.refStart, s.refEnd),
      singer: span(s.userStart, s.userEnd),
      meanAbsCents: num(s.meanAbsCents, 0),
      meanSignedCents: num(s.meanSignedCents, 0),
      note: clip(s.note),
    })),
    styleDiffSingerMinusReference: styleDiff,
  };
}

/** Compact JSON-able summary of an analysis (no per-frame data) — what gets sent to the model. */
export function summarizeForAi(input: AiCoachInput): object {
  const out: Record<string, unknown> = {
    singer: summarizeProfile(input.profile),
    comparison: summarizeComparison(input.comparison),
    plan: summarizePlan(input.plan),
    take: summarizeTake(input.analysis),
  };
  if (input.reference) out.reference = summarizeReference(input.reference);
  const question = input.question?.trim();
  if (question) out.question = question;
  if (input.history?.length) out.conversationTurns = input.history.length;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Conversation

/**
 * The first user message carries the analysis JSON plus the first question; earlier turns follow
 * unchanged and the new question goes last. The JSON is built without question/history so the
 * first message is byte-identical on every turn, which keeps the cached prefix valid.
 */
export function buildAiMessages(input: AiCoachInput): BetaMessageParam[] {
  const data = JSON.stringify(summarizeForAi({ ...input, question: undefined, history: undefined }));
  const intro = `Here is the analysis of my latest take:\n<analysis>\n${data}\n</analysis>`;
  // The API rejects empty text blocks, so blank turns (e.g. a stopped reply) are skipped.
  const history = (input.history ?? []).filter((h) => h.text.trim().length > 0);
  const question = input.question?.trim();
  const messages: BetaMessageParam[] = [];

  let rest = history;
  if (history.length > 0 && history[0].role === 'user') {
    messages.push({ role: 'user', content: `${intro}\n\n${history[0].text}` });
    rest = history.slice(1);
  } else if (history.length > 0) {
    messages.push({ role: 'user', content: intro });
  }
  for (const turn of rest) messages.push({ role: turn.role, content: turn.text });

  if (messages.length === 0) {
    messages.push({ role: 'user', content: `${intro}\n\n${question || DEFAULT_AI_QUESTION}` });
  } else if (question) {
    messages.push({ role: 'user', content: question });
  } else if (messages[messages.length - 1].role === 'assistant') {
    // The last turn must be the user's (these models don't accept an assistant prefill).
    messages.push({ role: 'user', content: DEFAULT_FOLLOW_UP });
  }
  return messages;
}

/** Server-side refusal fallback is only offered on the Opus 5 / Fable 5 families. */
function supportsServerFallback(model: string): boolean {
  return /^claude-(opus|fable)-5/.test(model);
}

/** Haiku models reject adaptive thinking and the effort setting. */
function supportsAdaptiveThinking(model: string): boolean {
  return !/haiku/.test(model);
}

export function buildAiRequest(input: AiCoachInput, model: string): BetaMessageStreamParams {
  const params: BetaMessageStreamParams = {
    model,
    max_tokens: 16000,
    system: AI_SYSTEM_PROMPT,
    messages: buildAiMessages(input),
    // Caches the whole conversation prefix, so follow-up questions re-read it cheaply.
    cache_control: { type: 'ephemeral' },
  };
  if (supportsAdaptiveThinking(model)) {
    params.thinking = { type: 'adaptive' };
    params.output_config = { effort: 'medium' };
  }
  if (supportsServerFallback(model)) {
    // If the model declines, the API re-runs the request on Anthropic's recommended fallback model
    // within the same stream instead of returning a refusal.
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  return params;
}

// ---------------------------------------------------------------------------------------------
// Errors

const MSG_NO_KEY = 'Add your Anthropic API key in Settings to use the AI coach.';
const MSG_AUTH =
  'The API key was rejected. Check the key in Settings (it starts with "sk-ant-") and that your Anthropic account can use the selected model.';
const MSG_RATE = 'The Claude API is rate-limiting this key right now. Wait a minute and try again.';
const MSG_NETWORK =
  "Couldn't reach the Claude API. Check your internet connection. If the app is open inside a sandboxed page or preview, that page may block outside requests: run the app locally (npm run dev) or open it from its own site instead.";
const MSG_REFUSAL =
  'Claude declined to answer this one. Try rephrasing the question, or ask about a specific phrase or technique.';
const MSG_STOPPED = 'Stopped.';

function apiErrorDetail(err: APIError): string | null {
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const msg = body?.error?.message;
  return typeof msg === 'string' && msg.trim() ? clip(msg.trim(), 200) : null;
}

function apiErrorMessage(err: APIError): string {
  const status = err.status;
  const detail = apiErrorDetail(err);
  const suffix = detail ? ` (${detail})` : '';
  if (status === 400) return `The Claude API rejected the request${suffix}. If you changed the model in Settings, check its name.`;
  if (status === 404) return `The Claude API returned "not found"${suffix}. Check the model name in Settings.`;
  if (status !== undefined && status >= 500) return `The Claude API is having a temporary problem (status ${status}). Try again in a moment.`;
  return `The Claude API returned an error${status !== undefined ? ` (status ${status})` : ''}${suffix}.`;
}

/** Maps anything thrown while talking to the API to an AiCoachError, most specific SDK class first. */
export function toAiCoachError(err: unknown, signal?: AbortSignal): AiCoachError {
  if (err instanceof AiCoachError) return err;
  if (err instanceof APIUserAbortError) return new AiCoachError('other', MSG_STOPPED, { cause: err });
  if (signal?.aborted) return new AiCoachError('other', MSG_STOPPED, { cause: err });
  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return new AiCoachError('auth', MSG_AUTH, { cause: err, status: err.status });
  }
  if (err instanceof RateLimitError) return new AiCoachError('rate', MSG_RATE, { cause: err, status: err.status });
  // Covers timeouts and failed fetches, including requests blocked by a host page's CSP (the SDK
  // wraps the browser's TypeError in APIConnectionError).
  if (err instanceof APIConnectionError) return new AiCoachError('network', MSG_NETWORK, { cause: err });
  if (err instanceof APIError) return new AiCoachError('other', apiErrorMessage(err), { cause: err, status: err.status });
  return new AiCoachError('other', 'Something went wrong while talking to the AI coach.', { cause: err });
}

// ---------------------------------------------------------------------------------------------
// Request

/** Streams coaching text from Claude using the user's API key. Throws AiCoachError with a user-facing message on failure. */
export async function askAiCoach(
  input: AiCoachInput,
  settings: AppSettings,
  onText: (delta: string) => void,
  signal?: AbortSignal,
  deps: AiCoachDeps = {},
): Promise<string> {
  const apiKey = settings.anthropicApiKey?.trim();
  if (!apiKey) throw new AiCoachError('auth', MSG_NO_KEY);
  if (signal?.aborted) throw new AiCoachError('other', MSG_STOPPED);
  const model = settings.aiModel?.trim() || DEFAULT_AI_MODEL;

  // The app has no server: the browser calls the API directly with a key the user typed into
  // Settings, which is stored only in this browser. dangerouslyAllowBrowser acknowledges that the
  // key is visible to this page, which is acceptable because the key and the page are the user's own.
  const client = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.maxRetries !== undefined ? { maxRetries: deps.maxRetries } : {}),
  });

  try {
    const stream = client.beta.messages.stream(buildAiRequest(input, model), { signal });
    stream.on('text', (delta) => onText(delta));
    const message = await stream.finalMessage();
    // A refusal can arrive before any output or after some text has streamed; either way the
    // partial text is not a usable answer.
    if (message.stop_reason === 'refusal') throw new AiCoachError('refusal', MSG_REFUSAL);
    return message.content
      .filter((b): b is BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    throw toAiCoachError(err, signal);
  }
}
