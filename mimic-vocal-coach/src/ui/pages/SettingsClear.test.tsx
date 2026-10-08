// @vitest-environment jsdom
// "Delete everything" says "All data cleared." only when the library was really emptied: a failing delete is reported, and can be retried.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../../state/AppProvider';
import { TrainerProvider } from '../../state/TrainerProvider';
import { createMemoryClipStore, type ClipStore } from '../../storage/clips';
import { makeFakeClip } from '../../testing/trainerFixtures';
import { SettingsPage } from './Settings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let store: ClipStore;

const settle = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
const button = (re: RegExp): HTMLButtonElement => {
  const b = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((el) => re.test(el.textContent ?? ''));
  if (!b) throw new Error(`No button ${re}`);
  return b;
};

beforeEach(async () => {
  localStorage.clear();
  store = createMemoryClipStore();
  await store.putClip(makeFakeClip());
  await store.writeAudio('fake-clip', 'mix', new Int16Array(44100), 44100);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <AppProvider>
        <TrainerProvider store={store}>
          <SettingsPage />
        </TrainerProvider>
      </AppProvider>,
    ),
  );
  await settle();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Settings: Delete everything', () => {
  it('says "All data cleared." and leaves nothing behind when the library was emptied', async () => {
    await act(async () => button(/^Delete everything, including settings$/).click());
    await act(async () => button(/Yes, delete everything/).click());
    await settle();
    expect(container.textContent).toContain('All data cleared.');
    expect(container.querySelector('.field-error')).toBeNull();
    expect(await store.usage()).toEqual({ clips: 0, attempts: 0, audioBytes: 0 });
  });

  it('does not claim success when the clips could not be deleted: it names what is left, keeps the question open and works on a retry', async () => {
    const real = store.clearAll.bind(store);
    store.clearAll = () => Promise.reject(new DOMException('The database is locked', 'InvalidStateError'));
    await act(async () => button(/^Delete everything, including settings$/).click());
    await act(async () => button(/Yes, delete everything/).click());
    await settle();
    expect(container.textContent).not.toContain('All data cleared.');
    const alert = container.querySelector('[role="alert"].field-error');
    expect(alert?.textContent).toMatch(/Not everything was deleted.*your clips and practice scores could not be removed.*try again.*Website Data/);
    expect((await store.usage()).clips).toBe(1);
    expect(() => button(/Yes, delete everything/)).not.toThrow(); // still asking, so one tap tries again

    store.clearAll = real;
    await act(async () => button(/Yes, delete everything/).click());
    await settle();
    expect(container.textContent).toContain('All data cleared.');
    expect(container.querySelector('[role="alert"].field-error')).toBeNull();
    expect((await store.usage()).clips).toBe(0);
  });
});
