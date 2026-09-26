import { describe, expect, it, vi } from 'vitest';
import { APIConnectionError, APIUserAbortError } from '@anthropic-ai/sdk';
import aiSource from './ai.ts?raw';
import {
  AI_SYSTEM_PROMPT,
  AiCoachError,
  askAiCoach,
  buildAiMessages,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_QUESTION,
  loadSdk,
  summarizeForAi,
  toAiCoachError,
  type AiCoachDeps,
  type AiCoachInput,
} from './ai';
import {
  makeFakeAnalysis,
  makeFakeComparison,
  makeFakePlan,
  makeFakeProfile,
  makeFakeReferenceComparison,
} from '../testing/fixtures';
import type { AppSettings, FrameFeatures, NoteSegment, Phrase, VoiceAnalysis } from '../types';

const SETTINGS: AppSettings = { voiceType: 'baritone', a4Hz: 440, anthropicApiKey: 'sk-ant-test', aiModel: DEFAULT_AI_MODEL };

function baseInput(overrides: Partial<AiCoachInput> = {}): AiCoachInput {
  return {
    analysis: makeFakeAnalysis(),
    comparison: makeFakeComparison(),
    plan: makeFakePlan(),
    profile: makeFakeProfile(),
    ...overrides,
  };
}

/** Repeat the 12 s fixture 15 times: a 3-minute take with 180 notes and 30 phrases. */
function threeMinuteAnalysis(): VoiceAnalysis {
  const one = makeFakeAnalysis();
  const frames: FrameFeatures[] = [];
  const notes: NoteSegment[] = [];
  const phrases: Phrase[] = [];
  for (let k = 0; k < 15; k++) {
    const off = k * one.durationSec;
    for (const f of one.frames) frames.push({ ...f, t: f.t + off });
    for (const n of one.notes) notes.push({ ...n, start: n.start + off, end: n.end + off, centsOff: n.centsOff * (k % 4) });
    for (const p of one.phrases) phrases.push({ start: p.start + off, end: p.end + off });
  }
  return {
    ...one,
    durationSec: 180,
    frames,
    notes,
    phrases,
    onsets: phrases.map((p, i) => ({ t: p.start, type: i % 3 === 0 ? 'breathy' : 'balanced' })),
    runs: [{ start: 30, end: 31.2, noteCount: 9, notesPerSec: 7.5 }],
    warnings: ['The take is a little quiet; move closer to the microphone.'],
  };
}

function bigReference() {
  const r = makeFakeReferenceComparison();
  const path = Array.from({ length: 1500 }, (_, i) => ({ userT: i * 0.12, refT: i * 0.12, centsDiff: 10 }));
  const segments = Array.from({ length: 40 }, (_, i) => ({
    ...r.segments[0],
    refStart: i * 4.5,
    refEnd: i * 4.5 + 4,
    userStart: i * 4.5,
    userEnd: i * 4.5 + 4,
    meanAbsCents: (i * 7) % 60,
    note: 'The melody or ornaments differ from the reference here: only 55% of the phrase was within 50 cents of it, so check the notes and any runs against the original. You took about 12% longer than the reference, so you were falling behind its timing.',
  }));
  return { ...r, path, segments };
}

describe('summarizeForAi', () => {
  it('includes the profile, comparison, plan and take summary with note names', () => {
    const s = summarizeForAi(baseInput({ reference: makeFakeReferenceComparison(), question: 'How is my mix?' })) as Record<string, any>;
    // "target" is the profile; "singer" means the user throughout the prompt.
    expect(s.singer).toBeUndefined();
    expect(s.target.name).toBe('Test Singer');
    expect(s.target.targets.mixInUpperRange).toEqual({ ideal: 0.5, low: 0.35, high: 0.65, weight: 1 });
    expect(s.comparison.overall).toBe(68);
    // The fake comparison has only two measured dimensions, so it can't be scored.
    expect(s.comparison.scoreable).toBe(false);
    expect(s.take.issues).toEqual([]);
    expect(s.comparison.dimensions[1]).toMatchObject({ key: 'mixInUpperRange', value: 0.3, score: 55, direction: 'more' });
    expect(s.plan.items[0]).toMatchObject({ title: 'Lighten into mix above E4' });
    expect(s.plan.items[0].whatWeHeard).toMatch(/55%/);
    expect(s.take.pitch).toMatchObject({ median: 'D4', range: 'G3-A4', tessitura: 'B3-F4', tuningOffsetCents: 6 });
    expect(s.take.passaggio).toBe('D4-G4');
    expect(s.take.style.mixInUpperRange).toBe(0.3);
    expect(s.take.tone.cppDb).toBe(17);
    expect(s.take.registerSharesAllSinging).toEqual({ chest: 0.6, mix: 0.25, head: 0.15 });
    expect(s.take.notes).toMatchObject({ count: 12, withVibratoShare: 0.67, meanAbsCentsOff: 5 });
    expect(s.take.phrases[0]).toMatchObject({ at: '0:00.1-0:05.9', notes: 'G3-E4' });
    expect(s.take.phrases[1].upperRange).toMatch(/chest \d+%, mix \d+%, head \d+%/);
    expect(s.take.onsets).toEqual({ count: 2, breathy: 1, balanced: 1, glottal: 0 });
    expect(s.take.runs).toEqual({ count: 0, fastestNotesPerSec: null });
    expect(s.reference.transposeSemitones).toBe(-12);
    expect(s.reference.path).toBeUndefined();
    expect(s.reference.phrases[0].note).toMatch(/flat/);
    expect(s.question).toBe('How is my mix?');
  });

  it('flags unscoreable takes and passes the issue codes on', () => {
    const analysis: VoiceAnalysis = { ...makeFakeAnalysis(), issues: ['accompaniment', 'noisy'] };
    const s = summarizeForAi(baseInput({ analysis })) as Record<string, any>;
    expect(s.comparison.scoreable).toBe(false);
    expect(s.take.issues).toEqual(['accompaniment', 'noisy']);
  });

  it('never includes per-frame data', () => {
    const json = JSON.stringify(summarizeForAi(baseInput({ reference: makeFakeReferenceComparison() })));
    expect(json).not.toMatch(/"frames"|"path"|"f0"|"periodicity"/);
  });

  it('stays under 12 KB for a 3-minute take with a long reference comparison', () => {
    const input = baseInput({
      analysis: threeMinuteAnalysis(),
      reference: bigReference(),
      question: 'What should I fix first?',
      history: [
        { role: 'user', text: DEFAULT_AI_QUESTION },
        { role: 'assistant', text: 'Lighten the top notes.' },
      ],
    });
    const json = JSON.stringify(summarizeForAi(input));
    expect(new TextEncoder().encode(json).length).toBeLessThan(12 * 1024);
    const s = JSON.parse(json);
    expect(s.take.phrases.length).toBeLessThanOrEqual(16);
    expect(s.reference.phrases.length).toBeLessThanOrEqual(10);
    expect(s.reference.phrasesCompared).toBe(40);
    expect(s.take.notes.mostOffPitch.length).toBeLessThanOrEqual(5);
    expect(s.take.runs).toEqual({ count: 1, fastestNotesPerSec: 7.5 });
    expect(s.conversationTurns).toBe(2);
  });
});

describe('AI_SYSTEM_PROMPT', () => {
  it('names the target profile "target" and keeps "singer" for the user', () => {
    expect(AI_SYSTEM_PROMPT).toMatch(/^- target: the target profile/m);
    expect(AI_SYSTEM_PROMPT).not.toMatch(/^- singer: the target profile/m);
    expect(AI_SYSTEM_PROMPT).toMatch(/transposeSemitones = singer minus reference/);
  });

  it('matches the app\'s coaching rules', () => {
    expect(AI_SYSTEM_PROMPT).toMatch(/scoreable = false/);
    expect(AI_SYSTEM_PROMPT).toMatch(/voice-type setting/);
    expect(AI_SYSTEM_PROMPT).toMatch(/breathiness: 0-0\.2 very clean and firm/);
    expect(AI_SYSTEM_PROMPT).not.toMatch(/0-0\.2 pressed/);
    expect(AI_SYSTEM_PROMPT).toMatch(/above about 0\.8 suggests carrying chest weight upward/);
    expect(AI_SYSTEM_PROMPT).toMatch(/suddenly cuts out.*laryngologist/);
  });
});

describe('buildAiMessages', () => {
  it('opens with the analysis JSON and the default question', () => {
    const msgs = buildAiMessages(baseInput());
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    const text = msgs[0].content as string;
    expect(text).toMatch(/<analysis>\n\{.*\}\n<\/analysis>/s);
    expect(text.endsWith(DEFAULT_AI_QUESTION)).toBe(true);
  });

  it('appends history unchanged and keeps the first message byte-identical across turns', () => {
    const first = buildAiMessages(baseInput({ question: 'How was my mix?' }));
    const later = buildAiMessages(
      baseInput({
        question: 'And my vibrato?',
        history: [
          { role: 'user', text: 'How was my mix?' },
          { role: 'assistant', text: 'Mostly chest above D4.' },
        ],
      }),
    );
    expect(later.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(later[0].content).toBe(first[0].content);
    expect(later[1].content).toBe('Mostly chest above D4.');
    expect(later[2].content).toBe('And my vibrato?');
  });

  it('never ends on an assistant turn and skips blank turns', () => {
    const msgs = buildAiMessages(
      baseInput({
        history: [
          { role: 'user', text: 'Hi' },
          { role: 'assistant', text: 'Hello.' },
          { role: 'user', text: 'More?' },
          { role: 'assistant', text: '   ' },
        ],
      }),
    );
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[2].content).toBe('More?');
    const tail = buildAiMessages(baseInput({ history: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello.' }] }));
    expect(tail[tail.length - 1].role).toBe('user');
  });
});

// ---------------------------------------------------------------------------------------------
// Request / error handling with an injected fetch (no network)

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

function sse(events: object[]): Response {
  const body = events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function messageEvents(texts: string[], stopReason: string, model = 'claude-opus-5'): object[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 1 },
      },
    },
    ...(texts.length
      ? [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          ...texts.map((t) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })),
          { type: 'content_block_stop', index: 0 },
        ]
      : []),
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 12 } },
    { type: 'message_stop' },
  ];
}

function errorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(respond: () => Response | Promise<Response>, captured: Captured[] = []): AiCoachDeps {
  return {
    maxRetries: 0,
    fetch: async (input, init) => {
      captured.push({
        url: String(input instanceof Request ? input.url : input),
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
      });
      return respond();
    },
  };
}

async function expectAiError(p: Promise<unknown>): Promise<AiCoachError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AiCoachError);
    return err as AiCoachError;
  }
  throw new Error('expected askAiCoach to throw');
}

describe('askAiCoach', () => {
  it('streams text deltas and sends the documented request', async () => {
    const captured: Captured[] = [];
    const deltas: string[] = [];
    const text = await askAiCoach(
      baseInput(),
      SETTINGS,
      (d) => deltas.push(d),
      undefined,
      fakeFetch(() => sse(messageEvents(['Lighten ', 'the top ', 'notes.'], 'end_turn')), captured),
    );
    expect(text).toBe('Lighten the top notes.');
    expect(deltas).toEqual(['Lighten ', 'the top ', 'notes.']);

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.url).toMatch(/\/v1\/messages/);
    expect(req.headers.get('x-api-key')).toBe('sk-ant-test');
    expect(req.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(req.headers.get('anthropic-dangerous-direct-browser-access')).toBe('true');
    expect(req.body).toMatchObject({
      model: 'claude-opus-5',
      max_tokens: 16000,
      stream: true,
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: AI_SYSTEM_PROMPT,
    });
    expect(req.body.messages).toHaveLength(1);
    expect(req.body.messages[0].content).toContain('<analysis>');
    expect(req.body.betas).toBeUndefined();
  });

  it('uses the model from settings and only sends options that model supports', async () => {
    const captured: Captured[] = [];
    const ok = (): Response => sse(messageEvents(['ok'], 'end_turn'));
    await askAiCoach(baseInput(), { ...SETTINGS, aiModel: 'claude-sonnet-5' }, () => {}, undefined, fakeFetch(ok, captured));
    expect(captured[0].body.model).toBe('claude-sonnet-5');
    expect(captured[0].body.thinking).toEqual({ type: 'adaptive' });
    expect(captured[0].body.fallbacks).toBeUndefined();
    expect(captured[0].headers.get('anthropic-beta')).toBeNull();
    await askAiCoach(baseInput(), { ...SETTINGS, aiModel: 'claude-haiku-4-5' }, () => {}, undefined, fakeFetch(ok, captured));
    expect(captured[1].body.thinking).toBeUndefined();
    expect(captured[1].body.output_config).toBeUndefined();
    await askAiCoach(baseInput(), { ...SETTINGS, aiModel: '  ' }, () => {}, undefined, fakeFetch(ok, captured));
    expect(captured[2].body.model).toBe(DEFAULT_AI_MODEL);
  });

  it('keeps the system prompt stable across takes', async () => {
    const captured: Captured[] = [];
    const ok = (): Response => sse(messageEvents(['ok'], 'end_turn'));
    await askAiCoach(baseInput(), SETTINGS, () => {}, undefined, fakeFetch(ok, captured));
    await askAiCoach(baseInput({ analysis: threeMinuteAnalysis(), question: 'Other?' }), SETTINGS, () => {}, undefined, fakeFetch(ok, captured));
    expect(captured[0].body.system).toBe(captured[1].body.system);
  });

  it('turns a refusal into an AiCoachError of kind refusal', async () => {
    const err = await expectAiError(
      askAiCoach(baseInput(), SETTINGS, () => {}, undefined, fakeFetch(() => sse(messageEvents(['Partial'], 'refusal')))),
    );
    expect(err.kind).toBe('refusal');
    expect(err.message).toMatch(/declined/);
  });

  it('asks for a key before calling the API', async () => {
    const captured: Captured[] = [];
    const err = await expectAiError(
      askAiCoach(baseInput(), { ...SETTINGS, anthropicApiKey: null }, () => {}, undefined, fakeFetch(() => sse([]), captured)),
    );
    expect(err.kind).toBe('auth');
    expect(err.message).toMatch(/Settings/);
    expect(captured).toHaveLength(0);
  });

  it('maps 401 and 403 to auth', async () => {
    for (const [status, type] of [
      [401, 'authentication_error'],
      [403, 'permission_error'],
    ] as const) {
      const err = await expectAiError(
        askAiCoach(baseInput(), SETTINGS, () => {}, undefined, fakeFetch(() => errorResponse(status, type, 'invalid x-api-key'))),
      );
      expect(err.kind).toBe('auth');
      expect(err.status).toBe(status);
      expect(err.message).toMatch(/API key was rejected/);
    }
  });

  it('maps 429 to rate', async () => {
    const err = await expectAiError(
      askAiCoach(baseInput(), SETTINGS, () => {}, undefined, fakeFetch(() => errorResponse(429, 'rate_limit_error', 'slow down'))),
    );
    expect(err.kind).toBe('rate');
  });

  it('maps a failed fetch (e.g. blocked by CSP) to network', async () => {
    const err = await expectAiError(
      askAiCoach(baseInput(), SETTINGS, () => {}, undefined, fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')))),
    );
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/run the app locally/);
  });

  it('maps other API errors to other with the status', async () => {
    const bad = await expectAiError(
      askAiCoach(baseInput(), SETTINGS, () => {}, undefined, fakeFetch(() => errorResponse(400, 'invalid_request_error', 'model: unknown'))),
    );
    expect(bad.kind).toBe('other');
    expect(bad.status).toBe(400);
    expect(bad.message).toMatch(/model: unknown/);
    const down = await expectAiError(
      askAiCoach(baseInput(), SETTINGS, () => {}, undefined, fakeFetch(() => errorResponse(529, 'overloaded_error', 'Overloaded'))),
    );
    expect(down.kind).toBe('other');
    expect(down.message).toMatch(/status 529/);
  });

  it('reports "Stopped." when aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const early = await expectAiError(askAiCoach(baseInput(), SETTINGS, () => {}, ctrl.signal, fakeFetch(() => sse([]))));
    expect(early).toMatchObject({ kind: 'other', message: 'Stopped.' });

    const mid = new AbortController();
    const hanging: AiCoachDeps = {
      maxRetries: 0,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          setTimeout(() => mid.abort(), 5);
        }),
    };
    const err = await expectAiError(askAiCoach(baseInput(), SETTINGS, () => {}, mid.signal, hanging));
    expect(err).toMatchObject({ kind: 'other', message: 'Stopped.' });
  });
});

describe('toAiCoachError', () => {
  it('maps SDK classes most-specific first', async () => {
    await loadSdk();
    expect(toAiCoachError(new APIUserAbortError()).message).toBe('Stopped.');
    expect(toAiCoachError(new APIConnectionError({ message: 'Connection error.' })).kind).toBe('network');
    const passthrough = new AiCoachError('refusal', 'x');
    expect(toAiCoachError(passthrough)).toBe(passthrough);
    expect(toAiCoachError(new Error('boom')).kind).toBe('other');
  });
});

describe('SDK loading', () => {
  it('only imports the SDK as types at the top level, so it stays out of the main bundle', () => {
    const valueImports = aiSource.split('\n').filter((line) => /^import (?!type\b).*['"]@anthropic-ai\/sdk/.test(line));
    expect(valueImports).toEqual([]);
    expect(aiSource).toMatch(/await import\('@anthropic-ai\/sdk'\)/);
  });

  it('loads the SDK once and caches it', async () => {
    const a = await loadSdk();
    expect(typeof a.default).toBe('function');
    expect(await loadSdk()).toBe(a);
  });

  it('maps a failure before the SDK has loaded (e.g. offline) to a network error', async () => {
    vi.resetModules();
    const fresh = await import('./ai');
    const err = fresh.toAiCoachError(new TypeError('Failed to fetch dynamically imported module'));
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/Couldn't reach the Claude API/);
    const ctrl = new AbortController();
    ctrl.abort();
    expect(fresh.toAiCoachError(new Error('x'), ctrl.signal).message).toBe('Stopped.');
  });
});
