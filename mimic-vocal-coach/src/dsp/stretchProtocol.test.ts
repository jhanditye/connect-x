import { describe, expect, it } from 'vitest';
import { runRenderJob, type RenderRequest, type RenderResponse } from './stretchProtocol';
import { renderGuide } from './timestretch';

const SR = 16000;
const tone = (sec: number): Float32Array => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR));

function run(req: unknown): RenderResponse[] {
  const out: RenderResponse[] = [];
  runRenderJob(req as RenderRequest, (m) => out.push(m));
  return out;
}

describe('runRenderJob', () => {
  it('posts progress and then exactly one result with the same samples as renderGuide', () => {
    const x = tone(3);
    const spec = { rate: 0.75, semitones: 0, outRate: 24000 };
    const msgs = run({ type: 'render', id: 7, samples: x, sampleRate: SR, spec });
    const last = msgs.at(-1);
    expect(last?.type).toBe('result');
    expect(msgs.filter((m) => m.type === 'result')).toHaveLength(1);
    expect(msgs.every((m) => m.type === 'progress' || m.type === 'result')).toBe(true);
    expect(msgs.every((m) => !('id' in m) || m.id === 7)).toBe(true);
    if (last?.type === 'result') {
      expect(last.sampleRate).toBe(24000);
      expect(last.samples).toEqual(renderGuide(x, SR, spec));
    }
    let prev = -1;
    for (const m of msgs) {
      if (m.type !== 'progress') continue;
      expect(m.value).toBeGreaterThanOrEqual(prev);
      prev = m.value;
    }
  });

  it('reports the input rate when no conversion was asked for', () => {
    const msgs = run({ type: 'render', id: 1, samples: tone(0.5), sampleRate: SR, spec: { rate: 0.9, semitones: 0 } });
    const last = msgs.at(-1);
    expect(last?.type === 'result' && last.sampleRate).toBe(SR);
  });

  it('answers an invalid request with one error and does not throw', () => {
    for (const bad of [undefined, null, {}, { type: 'render', id: 3, samples: [1, 2, 3], sampleRate: SR, spec: { rate: 1, semitones: 0 } }, { type: 'render', id: 3, samples: tone(1), sampleRate: SR, spec: null }]) {
      const msgs = run(bad);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe('error');
    }
  });

  it('turns a render failure (a rate that makes no sense) into an error that names the problem', () => {
    const msgs = run({ type: 'render', id: 9, samples: tone(1), sampleRate: SR, spec: { rate: 0, semitones: 0 } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ type: 'error', id: 9 });
    expect((msgs[0] as { message: string }).message).toMatch(/rate/);
  });
});
