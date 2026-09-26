import { describe, expect, it } from 'vitest';
import { concat, silence, synthMelody } from '../testing/synth';
import { runAnalysisJob, type AnalyzeRequest, type WorkerResponse } from './workerProtocol';

const SR = 22050;

describe('runAnalysisJob', () => {
  it('posts throttled, increasing progress then exactly one result', () => {
    const samples = concat(silence(0.3, SR), synthMelody([{ midi: 57, durSec: 1.5 }], { sampleRate: SR }), silence(0.3, SR));
    const out: WorkerResponse[] = [];
    runAnalysisJob({ type: 'analyze', samples, sampleRate: SR, opts: { voiceType: 'tenor' } }, (m) => out.push(m));
    const progress = out.filter((m) => m.type === 'progress').map((m) => (m.type === 'progress' ? m.value : NaN));
    expect(progress.length).toBeGreaterThan(3);
    expect(progress.length).toBeLessThanOrEqual(52);
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThan(progress[i - 1]);
    expect(progress[progress.length - 1]).toBe(1);
    const last = out[out.length - 1];
    expect(last.type).toBe('result');
    if (last.type === 'result') {
      expect(last.analysis.passaggio).toEqual({ lowMidi: 64, highMidi: 69 });
      expect(last.analysis.notes).toHaveLength(1);
    }
    expect(out.filter((m) => m.type !== 'progress')).toHaveLength(1);
  });

  it('answers a malformed request with an error message', () => {
    const out: WorkerResponse[] = [];
    runAnalysisJob({ type: 'analyze', samples: [1, 2, 3] } as unknown as AnalyzeRequest, (m) => out.push(m));
    expect(out).toEqual([{ type: 'error', message: 'The analysis worker received an invalid request.' }]);
  });

  it('turns an exception inside the analysis into an error message', () => {
    const out: WorkerResponse[] = [];
    const bad = { type: 'analyze', samples: new Float32Array(10), sampleRate: SR, opts: null } as unknown as AnalyzeRequest;
    runAnalysisJob(bad, (m) => out.push(m));
    expect(out[out.length - 1].type).toBe('error');
    const last = out[out.length - 1];
    if (last.type === 'error') expect(last.message).toMatch(/^The analysis failed/);
  });
});
