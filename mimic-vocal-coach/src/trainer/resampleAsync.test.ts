import { describe, expect, it, vi } from 'vitest';
import { resample } from '../dsp/resample';
import { resampleAsync } from './resampleAsync';

/** A deterministic signal with energy at several frequencies, so a slice edge that was filtered wrongly would show. */
function signal(seconds: number, rate: number): Float32Array {
  const x = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate) + 0.2 * Math.sin((2 * Math.PI * 1710 * i) / rate + 1) + 0.1 * Math.sin((2 * Math.PI * 9100 * i) / rate);
  return x;
}

describe('resampleAsync', () => {
  for (const [from, to, seconds] of [
    [96000, 48000, 3],
    [88200, 48000, 3],
    [192000, 48000, 2],
    [64000, 48000, 3],
    [176400, 48000, 2],
  ] as const) {
    it(`gives exactly the numbers resample() gives, ${from} -> ${to}`, async () => {
      const x = signal(seconds, from);
      const slow = await resampleAsync(x, from, to, { sliceMs: 0, yieldToPage: async () => undefined });
      const whole = resample(x, from, to);
      expect(slow.length).toBe(whole.length);
      let worst = 0;
      for (let i = 0; i < whole.length; i++) worst = Math.max(worst, Math.abs(slow[i] - whole[i]));
      expect(worst).toBe(0);
    });
  }

  it('hands the page a turn between slices, reports progress that only grows, and ends at 1', async () => {
    const x = signal(4, 96000);
    const turns = vi.fn(async () => undefined);
    const seen: number[] = [];
    await resampleAsync(x, 96000, 48000, { sliceMs: 0, yieldToPage: turns, onProgress: (f) => seen.push(f) });
    expect(turns.mock.calls.length).toBeGreaterThan(5);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('works for no more than a slice of time before giving the page a turn', async () => {
    const x = signal(4, 96000);
    let clock = 0;
    const turns: number[] = [];
    await resampleAsync(x, 96000, 48000, {
      sliceMs: 10,
      now: () => (clock += 4), // every check costs 4 ms of "work"
      yieldToPage: async () => void turns.push(clock),
    });
    // 8 slices; each check costs 4 ms, so the page gets a turn about every third slice (10 ms), never after all of them at once.
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(turns.length).toBeLessThanOrEqual(3);
  });

  it('stops with an AbortError when cancelled while it waits for the page', async () => {
    const x = signal(4, 96000);
    const ctl = new AbortController();
    const pending = resampleAsync(x, 96000, 48000, { sliceMs: 0, signal: ctl.signal, yieldToPage: async () => ctl.abort() });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const early = new AbortController();
    early.abort();
    await expect(resampleAsync(x, 96000, 48000, { signal: early.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('returns the input untouched at the same rate, converts short signals in one call and handles rates that do not reduce', async () => {
    const x = signal(0.2, 96000);
    expect(await resampleAsync(x, 48000, 48000)).toBe(x);
    expect(Array.from(await resampleAsync(x, 96000, 48000))).toEqual(Array.from(resample(x, 96000, 48000)));
    const odd = signal(1.5, 96000);
    expect(Array.from(await resampleAsync(odd, 96000.5, 48000))).toEqual(Array.from(resample(odd, 96000.5, 48000)));
    expect((await resampleAsync(new Float32Array(0), 96000, 48000)).length).toBe(0);
  });
});
