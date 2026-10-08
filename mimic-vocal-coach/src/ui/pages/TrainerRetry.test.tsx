// @vitest-environment jsdom
// A library that failed to open in a way that can pass: the Trainer says so, offers "Try again", and keeps the focus on the page.
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { TrainerExtrasContext, type TrainerExtras } from '../../state/TrainerProvider';
import { FAKE_NOW, makeFakeTrainerController } from '../../testing/trainerFixtures';
import { tick, useScreen } from '../../testing/trainerUi';
import { TrainerPage } from './Trainer';

const screen = useScreen();

function page(extras: Partial<TrainerExtras>) {
  const base: TrainerExtras = {
    memoryReason: null,
    warnings: [],
    exportReminder: { due: false, message: null },
    storageNote: null,
    reload: () => Promise.resolve(),
    refreshStorage: () => Promise.resolve({ supported: true, usage: 1, quota: 2, persisted: false }),
    requestPersistence: () => Promise.resolve(true),
    ...extras,
  };
  return screen.mount(
    <TrainerExtrasContext.Provider value={base}>
      <TrainerPage now={FAKE_NOW} />
    </TrainerExtrasContext.Provider>,
    makeFakeTrainerController({ clips: [], status: 'memory-only' }),
  );
}

describe('Trainer: a library that did not open', () => {
  it('says the saved clips are not deleted, and offers Try again only when trying again can help', async () => {
    const reload = vi.fn(() => Promise.resolve());
    page({ memoryReason: 'Your library is taking too long to open. Your saved clips are not deleted.', canRetryOpen: true, reload });
    expect(screen.q('.notice--warn').textContent).toMatch(/Your library did not open/);
    expect(screen.q('.notice--warn').textContent).toMatch(/not deleted/);
    expect(screen.q('.notice--warn').textContent).toMatch(/copied into it/);
    await act(async () => screen.button(/Try again/).click());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps the button in the page while it works (aria-disabled, not disabled) and ignores a second tap', async () => {
    let finish!: () => void;
    const reload = vi.fn(() => new Promise<void>((r) => (finish = r)));
    page({ memoryReason: 'slow', canRetryOpen: true, reload });
    const button = screen.button(/Try again/);
    button.focus();
    await act(async () => button.click());
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.textContent).toMatch(/Trying again/);
    await act(async () => button.click());
    expect(reload).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await tick();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('a refusal that trying again will not change keeps the old wording and no Try again button', () => {
    page({ memoryReason: 'This browser is blocking IndexedDB.', canRetryOpen: false });
    expect(screen.q('.notice--warn').textContent).toMatch(/Clips will be lost when you close the app/);
    expect(screen.q('.notice--warn').textContent).toMatch(/Home Screen/);
    expect(screen.text()).not.toMatch(/Try again/);
  });
});
