// @vitest-environment jsdom
// The real AppProvider, the real TrainerProvider (memory store) and the real importer with real analysis of synthetic audio:
// the one-tap "add to singer targets" path from import to the singer's card, its undo, mixes never contributing, and
// "delete everything" reaching the library. No fakes for the data layers; only the store is in memory.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeWav } from '../audio/wav';
import { createMemoryClipStore, type ClipStore } from '../storage/clips';
import { measuredFromClip } from '../storage/library';
import { loadMeasurements } from '../storage/measurements';
import { KIT_RATE, soloLine, withBand } from '../trainer/importTestKit';
import type { ClipRecord } from '../types';
import { AppProvider } from './AppProvider';
import { useApp, type AppController } from './context';
import { TrainerProvider } from './TrainerProvider';
import { useTrainer, type TrainerController } from './trainerContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Live {
  app: AppController;
  trainer: TrainerController;
}

let root: Root;
let container: HTMLDivElement;
let live: Live;
let store: ClipStore;

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

function Probe() {
  live = { app: useApp(), trainer: useTrainer() };
  return null;
}

beforeEach(async () => {
  localStorage.clear();
  store = createMemoryClipStore();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <AppProvider>
        <TrainerProvider store={store}>
          <Probe />
        </TrainerProvider>
      </AppProvider>,
    ),
  );
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  localStorage.clear();
});

const wav = (samples: Float32Array, name: string) => new File([encodeWav(samples, KIT_RATE)], name, { type: 'audio/wav' });
const singer = (id: string) => live.app.builtins.find((b) => b.id === id)!;

async function importClip(file: File, over: { singerId?: string; contribute?: boolean; kind?: 'solo' | 'mix'; trim?: { startSec: number; endSec: number } } = {}): Promise<ClipRecord> {
  const prepared = await live.trainer.prepareClip(file);
  const clip = await live.trainer.commitClip(prepared, {
    title: file.name.replace(/\.wav$/, ''),
    singerId: over.singerId ?? 'shawn-mendes',
    singerLabel: '',
    kind: over.kind ?? prepared.suggestedKind,
    phrases: prepared.phrases,
    trim: over.trim,
    contributeToSinger: over.contribute ?? false,
    ownedConfirmed: true,
  });
  await settle();
  return clip;
}

describe('one-tap "add to singer targets", end to end', () => {
  it('after contributing a solo clip the singer is measured, and the stored clip says so', async () => {
    const estimated = singer('shawn-mendes');
    expect(estimated.source).not.toBe('measured');
    const clip = await importClip(wav(soloLine({ count: 3 }), 'verse.wav'), { contribute: true });
    expect(clip.contributesToSinger).toBe(true);
    const measured = singer('shawn-mendes');
    expect(measured.source).toBe('measured');
    expect(measured.sourceNote).toMatch(/measured from 1 clip/);
    expect(measured.targets).not.toEqual(estimated.targets);
    // The selected profile (what the next take is scored against) is the measured one.
    act(() => live.app.selectProfile('shawn-mendes'));
    expect(live.app.profile?.source).toBe('measured');
    // The other singers are untouched.
    expect(singer('daniel-caesar').source).not.toBe('measured');
    // The clip as listed says it counts (flag and targets agree), and the numbers are saved with the browser.
    expect(live.trainer.getClip(clip.id)?.contributesToSinger).toBe(true);
    expect(loadMeasurements()['shawn-mendes']?.map((m) => m.id)).toEqual([clip.id]);
  });

  it('is the same number whether the clip counted at import or was switched on afterwards, whatever part of the file was kept', async () => {
    const song = soloLine({ count: 4 });
    const kept = await importClip(wav(song, 'a.wav'), { contribute: true, trim: { startSec: 0, endSec: 10 } });
    const atImport = live.app.state.measurements['shawn-mendes'][0];
    expect(atImport).toEqual(measuredFromClip((await store.getClip(kept.id)) as ClipRecord));
    await act(async () => live.trainer.setContributes(kept.id, false));
    expect(live.app.state.measurements['shawn-mendes'] ?? []).toEqual([]);
    expect(singer('shawn-mendes').source).not.toBe('measured');
    await act(async () => live.trainer.setContributes(kept.id, true));
    expect(live.app.state.measurements['shawn-mendes'][0]).toEqual(atImport);
    expect(atImport.voicedSec).toBeLessThan(song.length / KIT_RATE);
    expect(atImport.durationSec).toBeCloseTo(((await store.getClip(kept.id)) as ClipRecord).analysis.durationSec, 6);
  }, 60000);

  it('removing and undoing works: off returns to estimates, on measures again, deleting the clip takes it out', async () => {
    const clip = await importClip(wav(soloLine({ count: 3 }), 'verse.wav'), { contribute: true });
    await act(async () => live.trainer.setContributes(clip.id, false));
    expect(singer('shawn-mendes').source).not.toBe('measured');
    expect(live.trainer.getClip(clip.id)?.contributesToSinger).toBe(false);
    expect(loadMeasurements()['shawn-mendes'] ?? []).toEqual([]);
    await act(async () => live.trainer.setContributes(clip.id, true));
    expect(singer('shawn-mendes').source).toBe('measured');
    await act(async () => live.trainer.deleteClip(clip.id));
    await settle();
    expect(singer('shawn-mendes').source).not.toBe('measured');
    expect(live.trainer.clips).toEqual([]);
  }, 60000);

  it('moves the clip with its singer, and two changes in one go both reach the browser store', async () => {
    const clip = await importClip(wav(soloLine({ count: 3 }), 'verse.wav'), { contribute: true });
    await act(async () => live.trainer.updateClip(clip.id, { singerId: 'daniel-caesar' }));
    await settle();
    expect(singer('shawn-mendes').source).not.toBe('measured');
    expect(singer('daniel-caesar').source).toBe('measured');
    const saved = loadMeasurements();
    expect(Object.keys(saved)).toEqual(['daniel-caesar']);

    // Two singers changed in the same tick: neither write may undo the other.
    const other = measuredFromClip((await store.getClip(clip.id)) as ClipRecord);
    act(() => {
      live.app.addMeasuredClip('shawn-mendes', { ...other, id: 'x-1' });
      live.app.addMeasuredClip('jalen-ngonda', { ...other, id: 'x-2' });
      live.app.removeMeasuredClip('daniel-caesar', clip.id);
    });
    expect(Object.keys(loadMeasurements()).sort()).toEqual(['jalen-ngonda', 'shawn-mendes']);
  }, 60000);

  it('a full song never contributes: not at import, not afterwards, and the message says why', async () => {
    const song = withBand(soloLine({ count: 3 }));
    const prepared = await live.trainer.prepareClip(wav(song, 'song.wav'));
    expect(prepared.suggestedKind).toBe('mix');
    expect(prepared.analysis.mode).toBe('mix');
    const clip = await importClip(wav(song, 'song.wav'), { contribute: true, kind: 'mix' });
    expect(clip.kind).toBe('mix');
    expect(clip.contributesToSinger).toBe(false);
    expect(singer('shawn-mendes').source).not.toBe('measured');
    await expect(live.trainer.setContributes(clip.id, true)).rejects.toThrow(/full song mix cannot set a singer/);
    expect(live.app.state.measurements['shawn-mendes'] ?? []).toEqual([]);
  }, 60000);
});

describe('delete everything', () => {
  it('clearAllData empties the library, its audio, the targets and the small stores in the browser', async () => {
    const clip = await importClip(wav(soloLine({ count: 3 }), 'verse.wav'), { contribute: true });
    localStorage.setItem('mimic.micDeviceId', JSON.stringify('abc'));
    localStorage.setItem('mimic.trainerPrefs', JSON.stringify({ keepRecordings: true }));
    expect((await store.usage()).audioBytes).toBeGreaterThan(0);
    await act(async () => {
      live.app.clearAllData();
    });
    await settle();
    expect(live.trainer.clips).toEqual([]);
    expect(await store.getClip(clip.id)).toBeFalsy();
    expect(await store.usage()).toEqual({ clips: 0, attempts: 0, audioBytes: 0 });
    expect(singer('shawn-mendes').source).not.toBe('measured');
    expect(Object.keys(localStorage).filter((k) => /^mimic[.:]/.test(k))).toEqual([]);
  }, 60000);

  it('a hook that fails does not stop the rest of "delete everything"', async () => {
    let ran = 0;
    const off = live.app.onClear!(() => {
      throw new Error('boom');
    });
    const off2 = live.app.onClear!(() => Promise.reject(new Error('later')));
    const off3 = live.app.onClear!(() => void ran++);
    await act(async () => {
      live.app.clearAllData();
    });
    await settle();
    expect(ran).toBe(1);
    off();
    off2();
    off3();
  });
});
