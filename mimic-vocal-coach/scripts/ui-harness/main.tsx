// Dev-only harness for scripts/ui-layout-check.mjs: the real app shell with the fake Trainer controller from
// src/testing/trainerFixtures.ts, so every Trainer screen can be opened in a browser without audio, IndexedDB or a microphone.
// Choose the library with ?s=library|empty|loading|error|memory (default library), a screen with the hash (#trainer/c/fake-clip/p/5).
// Nothing here ships: it is not part of the app build.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/styles/tokens.css';
import '../../src/styles/app.css';
import '../../src/styles/viz.css';
import '../../src/styles/trainer.css';
import { App } from '../../src/App';
import { applyTheme, loadTheme } from '../../src/state/theme';
import { FAKE_NOW, makeFakeClip, makeFakeTrainerController, type FakeControllerOptions } from '../../src/testing/trainerFixtures';
import type { ClipRecord } from '../../src/types';

// A fixed "now" so statuses (review due) do not depend on the day the check runs.
const realNow = Date.now.bind(Date);
const started = realNow();
Date.now = () => FAKE_NOW + (realNow() - started);

applyTheme(loadTheme());

function clips(): ClipRecord[] {
  const base = makeFakeClip();
  const second: ClipRecord = {
    ...makeFakeClip({ id: 'clip-daniel', title: 'Best Part, vocal stem with a rather long title to check wrapping', singerId: 'daniel-caesar' }),
    phrases: makeFakeClip().phrases.slice(0, 7).map((p, i) => ({
      ...p,
      id: `clip-daniel-p${i + 1}`,
      srs: { rung: 0, dueAt: null, masteredAt: null },
      stats: { attempts: 0, fullSpeedAttempts: 0, best: null, last: null, recent: [], lastAt: null },
      keyHint: null,
    })),
    durationSec: 49,
  };
  const mix: ClipRecord = { ...makeFakeClip({ id: 'clip-jalen', title: 'Full song, chorus', singerId: 'jalen-ngonda', kind: 'mix', analysisKind: 'mix-melody' }), contributesToSinger: false };
  const other: ClipRecord = makeFakeClip({ id: 'clip-other', title: 'A friend singing', singerId: null, singerLabel: 'Alicia' });
  const missing: ClipRecord = makeFakeClip({ id: 'clip-missing', title: 'Restored from a backup', singerId: 'shawn-mendes', audioMissing: true });
  return [base, second, mix, other, missing];
}

const params = new URLSearchParams(window.location.search);
const scenario = params.get('s') ?? 'library';
const opts: FakeControllerOptions = {};
if (scenario === 'empty') opts.clips = [];
else opts.clips = clips();
if (scenario === 'loading') opts.status = 'loading';
if (scenario === 'error') {
  opts.status = 'error';
  opts.error = 'The place where clips are kept did not answer.';
  opts.clips = [];
}
if (scenario === 'memory') opts.status = 'memory-only';
if (scenario === 'bluetooth') {
  opts.engine = { route: { inputLabel: 'AirPods Pro', inputs: [{ id: 'a', label: 'AirPods Pro' }, { id: 'b', label: 'iPhone Microphone' }], kind: 'bluetooth', headphonesLikely: true, sampleRate: 16000, inputSampleRate: 16000 } };
}
if (scenario === 'speaker') {
  opts.engine = { route: { inputLabel: 'iPhone Microphone', inputs: [{ id: 'b', label: 'iPhone Microphone' }], kind: 'builtin', headphonesLikely: false, sampleRate: 48000 } };
}
if (scenario === 'interrupted') opts.engine = { failSing: { state: 'interrupted', message: 'Interrupted by another app. Nothing was scored. Tap Try again.' } };
if (scenario === 'practice-error') opts.engine = { initialState: 'error', script: ['flat'] };
if (scenario === 'preparing') opts.engine = { initialState: 'preparing' };
const script = params.get('script');
if (script) opts.engine = { ...opts.engine, script: script.split(',') as never };

const controller = makeFakeTrainerController(opts);
(window as unknown as { __controller: unknown }).__controller = controller;

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element.');
createRoot(root).render(
  <StrictMode>
    <App trainerController={controller} />
  </StrictMode>,
);
