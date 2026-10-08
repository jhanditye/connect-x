// @vitest-environment jsdom
// The library backup through the real screens and the real data layers: Settings export (the real saveFile path, with the share
// sheet or download stubbed at the browser edge), wipe, import, the "needs its file again" prompt in the library, and re-attaching
// the audio by fingerprint through the Add clips sheet. Real AppProvider, real TrainerProvider (memory store), real importer.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../state/AppProvider';
import { useApp, type AppController } from '../state/context';
import { TrainerProvider } from '../state/TrainerProvider';
import { useTrainer, type TrainerController } from '../state/trainerContext';
import { encodeWav } from '../audio/wav';
import { createMemoryClipStore, type ClipStore } from '../storage/clips';
import { installBrowserStubs } from '../testing/trainerUi';
import { KIT_RATE, soloLine } from '../trainer/importTestKit';
import type { AttemptRecord, ClipRecord } from '../types';
import { FakeTrainerEngine, FAKE_NOW, makeFakeAttempts, makeFakeClip } from '../testing/trainerFixtures';
import type { PracticeSession } from '../state/TrainerProvider';
import { PhraseProgress } from './components/PhraseProgress';
import { TrainerSettings } from './components/TrainerSettings';
import { TrainerPage } from './pages/Trainer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The save goes through the real saveFile; only the browser's download is stubbed (an anchor click), and what it was given is kept.
const saved: { name: string; text: Promise<string> }[] = [];

let container: HTMLDivElement;
let root: Root;
let live: { app: AppController; trainer: TrainerController };
let store: ClipStore;

function Probe() {
  live = { app: useApp(), trainer: useTrainer() };
  return null;
}

const settle = async (rounds = 10) => {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
};

async function mountApp(s: ClipStore, body: ReactNode = (
  <>
    <TrainerSettings />
    <TrainerPage />
  </>
)) {
  store = s;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <AppProvider>
        <TrainerProvider store={s}>
          <Probe />
          {body}
        </TrainerProvider>
      </AppProvider>,
    ),
  );
  await settle();
}

beforeEach(() => {
  installBrowserStubs();
  localStorage.clear();
  window.location.hash = '#trainer';
  saved.length = 0;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    const href = this.href;
    saved.push({ name: this.download, text: fetch(href).then((r) => r.text()) });
  });
  const urls = new Map<string, Blob>();
  let n = 0;
  URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
    const u = `blob:test/${n++}`;
    urls.set(u, b as Blob);
    return u;
  });
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal('fetch', async (u: string) => ({ text: async () => (urls.get(u) as Blob).text() }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const button = (name: RegExp) => [...document.querySelectorAll('button')].find((b) => name.test(b.textContent ?? '')) as HTMLButtonElement;
const click = async (el: Element | undefined) => {
  expect(el).toBeTruthy();
  await act(async () => (el as HTMLElement).click());
};
async function chooseFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function until(check: () => boolean, what: string, ms = 30000) {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what}`);
    await settle(3);
  }
}

describe('library backup: export, wipe, import, add the files again', () => {
  it('keeps phrases and scores, never audio, and re-attaches the audio by the file\'s contents', async () => {
    const wavBytes = encodeWav(soloLine({ count: 3 }), KIT_RATE);
    const original = () => new File([wavBytes], 'Verse take.wav', { type: 'audio/wav' });
    await mountApp(createMemoryClipStore());

    // A clip with a practice attempt on one phrase.
    const prepared = await live.trainer.prepareClip(original());
    const clip = await live.trainer.commitClip(prepared, {
      title: 'Verse take',
      singerId: 'shawn-mendes',
      singerLabel: '',
      kind: 'solo',
      phrases: prepared.phrases,
      contributeToSinger: true,
      ownedConfirmed: true,
    });
    const phrase = clip.phrases[0];
    const attempt: AttemptRecord = {
      id: 'a-1',
      clipId: clip.id,
      phraseId: phrase.id,
      at: Date.now(),
      mode: 'turn-taking',
      keyMode: 'locked',
      rate: 1,
      transposeSemitones: 0,
      scores: { overall: 88, pitch: 90, timing: 85, tone: 80, expression: 82 },
      trust: 'ok',
      coverage: 1,
      wrongNotes: 0,
      syncOffsetMs: null,
      tempoRatio: null,
      fixIds: [],
      notes: [],
      analysisVersion: 1,
      hasAudio: false,
    } as unknown as AttemptRecord;
    await store.addAttempt(attempt);
    await settle();

    // Export through Settings: the real saveFile path (no host viewer, not iOS: a download).
    expect(document.body.textContent).toMatch(/Export my library/);
    await click(button(/Export my library/));
    await settle();
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toMatch(/^mimic-library-\d{4}-\d{2}-\d{2}\.json$/);
    const backupText = await saved[0].text;
    expect(document.body.textContent).toMatch(/Backup saved\. It holds your clips, phrases and scores but no audio/);
    const backup = JSON.parse(backupText);
    expect(backup.clips).toHaveLength(1);
    expect(backup.attempts).toHaveLength(1);
    expect(backupText).not.toMatch(/"pcm"|"samples"|"chunks"/);
    expect(backup.clips[0].audioMissing).toBeFalsy(); // the file says nothing about audio; import marks it missing
    expect(backup.clips[0].fingerprint).toBe(clip.fingerprint);

    // Wipe everything (what "Clear all data" does).
    await act(async () => {
      live.app.clearAllData();
    });
    await settle();
    expect(live.trainer.clips).toEqual([]);
    expect((await store.usage()).audioBytes).toBe(0);
    expect(live.app.builtins.find((b) => b.id === 'shawn-mendes')?.source).not.toBe('measured');

    // Import the backup through Settings.
    const input = document.querySelector<HTMLInputElement>('.tr-file input[type="file"]') as HTMLInputElement;
    await chooseFile(input, new File([backupText], 'backup.json', { type: 'application/json' }));
    await until(() => /Backup restored/.test(document.body.textContent ?? ''), 'the restore note');
    const restored = live.trainer.clips[0];
    expect(restored.id).toBe(clip.id);
    expect(restored.audioMissing).toBe(true);
    expect(restored.phrases.map((p) => p.id)).toEqual(clip.phrases.map((p) => p.id));
    expect(restored.phrases[0].stats.attempts).toBe(1);
    expect(await store.listAttempts({ clipId: clip.id })).toHaveLength(1);
    // The note says how to add the files again.
    expect(document.body.textContent).toMatch(/A backup holds no audio, so open the Trainer and tap "Choose the files"/);
    expect(document.body.textContent).toMatch(/recognises each file by its contents/);

    // The library prompts for the file, names the clip, and cannot practise it yet.
    await until(() => /One clip needs its audio file again/.test(document.body.textContent ?? ''), 'the library prompt');
    expect(document.body.textContent).toMatch(/Needs the file again/);
    expect(document.body.textContent).toMatch(/Nothing can be practised until the audio files are added again/);
    expect(live.trainer.queue).toEqual([]);

    // Tapping "Choose the files" opens the Add clips sheet; picking the same file offers to re-attach it (matched by fingerprint).
    await click(button(/Choose the files/));
    await until(() => !!document.querySelector('[role="dialog"] input[type="file"]'), 'the Add clips sheet');
    const sheetInput = () => document.querySelector<HTMLInputElement>('[role="dialog"] input[type="file"]') as HTMLInputElement;
    await chooseFile(sheetInput(), original());
    await until(() => /This is the file for/.test(document.body.textContent ?? ''), 'the re-attach offer', 60000);
    expect(document.body.textContent).toMatch(/This is the file for "Verse take"/);
    await click(button(/Re-attach the audio/));
    await until(() => /audio re-attached/.test(document.body.textContent ?? ''), 'the re-attach result', 30000);

    const back = live.trainer.getClip(clip.id) as ClipRecord;
    expect(back.audioMissing).toBe(false);
    expect(back.phrases.map((p) => p.id)).toEqual(clip.phrases.map((p) => p.id));
    expect(back.phrases[0].stats.attempts).toBe(1);
    expect((await store.listClips()).length).toBe(1); // re-attached, not added as a second clip
    expect(await store.readAudio(clip.id, back.audio.mix, 0, 1)).toHaveLength(Math.min(back.audio.mix.frames, back.audio.mix.sampleRate));
    expect(live.trainer.queue.length).toBeGreaterThan(0);
    // The singer's targets come back with the clip.
    expect(live.app.builtins.find((b) => b.id === 'shawn-mendes')?.source).toBe('measured');
  }, 180000);
});

describe('Progress, Phrases: real attempts from the store', () => {
  it('counts what is in the store, picks up a new take, and empties when everything is deleted', async () => {
    const seeded = createMemoryClipStore();
    const clip = makeFakeClip();
    await seeded.putClip(clip);
    await seeded.writeAudio(clip.id, 'mix', new Int16Array(44100), 44100);
    const stored = makeFakeAttempts();
    for (const a of stored) await seeded.addAttempt(a);
    const sessions: PracticeSession[] = [];
    store = seeded;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <AppProvider>
          <TrainerProvider store={seeded} now={() => FAKE_NOW} openPractice={async (x) => (sessions.push(x), new FakeTrainerEngine({ clip: x.clip, phrase: x.phrase }))}>
            <Probe />
            <PhraseProgress now={FAKE_NOW} />
          </TrainerProvider>
        </AppProvider>,
      ),
    );
    await settle();
    const text = () => container.textContent ?? '';
    // Counts come from the clips' stored stats, the streak and the chart from the stored attempts themselves.
    expect(text()).toMatch(/Mastered/);
    expect(container.querySelectorAll('.pp-day--on').length).toBeGreaterThan(0);
    const before = container.querySelectorAll('.pp-day--on').length;
    expect(text()).toMatch(/One phrase over time/);
    expect(text()).not.toMatch(/No practice yet/);

    // A new take today is added to the streak without reloading.
    const target = live.trainer.queue[0].phraseId;
    await act(async () => void (await live.trainer.openPractice(clip.id, target)));
    const take = { ...stored[0], id: 'today-1', clipId: clip.id, phraseId: target, at: FAKE_NOW, trust: 'ok' as const, hasAudio: false };
    await act(async () => void (await sessions[0].recordAttempt(take)));
    await settle();
    expect(container.querySelectorAll('.pp-day--on').length).toBeGreaterThanOrEqual(before);
    expect(container.querySelector('.pp-day--on:last-child')).not.toBeNull();
    expect(text()).toMatch(/in a row|day in a row/);

    // Delete everything: the section goes back to its empty state.
    await act(async () => live.trainer.clearAll());
    await settle();
    expect(text()).toMatch(/No clips in the Trainer yet/);
    expect(container.querySelectorAll('.pp-day--on')).toHaveLength(0);
  }, 60000);
});
