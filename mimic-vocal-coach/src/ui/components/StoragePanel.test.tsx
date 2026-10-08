// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrainerExtrasContext, type TrainerExtras } from '../../state/TrainerProvider';
import { makeFakeTrainerController } from '../../testing/trainerFixtures';
import { tick, useScreen } from '../../testing/trainerUi';

let persisted = false;
const persist = vi.fn(async () => {
  persisted = true;
  return true;
});

import { MicrophoneSetting, StoragePanel } from './StoragePanel';

const screen = useScreen();
const refreshStorage = vi.fn(() => Promise.resolve({ supported: true, usage: 1, quota: 2, persisted: true }));

beforeEach(() => {
  persisted = false;
  persist.mockClear();
  refreshStorage.mockClear();
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { persisted: async () => persisted, persist, estimate: async () => ({ usage: 118 * 1048576, quota: 5.6 * 1073741824 }) },
  });
});

function panel(withTrainer = true, extras: Partial<TrainerExtras> = {}) {
  const e: TrainerExtras = {
    memoryReason: null,
    warnings: [],
    exportReminder: { due: false, message: null },
    storageNote: null,
    reload: () => Promise.resolve(),
    refreshStorage,
    requestPersistence: () => Promise.resolve(true),
    ...extras,
  };
  screen.mount(
    <TrainerExtrasContext.Provider value={e}>
      <StoragePanel />
    </TrainerExtrasContext.Provider>,
    withTrainer ? makeFakeTrainerController() : undefined,
  );
}
const row = (name: RegExp) => screen.qa('.status-row').find((r) => name.test(r.querySelector('dt')?.textContent ?? ''))!;

describe('Settings: Offline and storage (the one storage block)', () => {
  it('shows the Trainer library, the space used and whether the browser keeps the data, once each', async () => {
    panel();
    await tick();
    expect(row(/Trainer library/).querySelector('dd')!.textContent).toBe('1 clip, 12 phrases');
    expect(row(/Space used/).textContent).toMatch(/118 MB.*of about 5\.6 GB/);
    expect(screen.qa('.status-row').filter((r) => /Space used/.test(r.textContent ?? ''))).toHaveLength(1);
    expect(row(/Data kept safe/).textContent).toMatch(/Best effort/);
  });

  it('has one "keep my data" button, which asks the browser and refreshes the Trainer\'s numbers', async () => {
    panel();
    await tick();
    expect(screen.qa('button').filter((b) => /keep my/.test(b.textContent ?? ''))).toHaveLength(1);
    await screen.clickAsync(screen.button(/Ask the browser to keep my data/));
    expect(persist).toHaveBeenCalledOnce();
    expect(refreshStorage).toHaveBeenCalled();
    expect(screen.text()).toMatch(/marked persistent/);
  });

  it('says a memory-only library is lost when the app closes', async () => {
    screen.mount(<StoragePanel />, makeFakeTrainerController({ status: 'memory-only' }));
    await tick();
    expect(row(/Trainer library/).textContent).toMatch(/Lost when you close the app/);
  });

  it('has no Trainer row without a Trainer', async () => {
    const holder = document.createElement('div');
    document.body.appendChild(holder);
    const root = createRoot(holder);
    await act(async () => root.render(<StoragePanel />));
    await tick();
    expect(holder.textContent).toMatch(/Space used/);
    expect(holder.textContent).not.toMatch(/Trainer library/);
    act(() => root.unmount());
    holder.remove();
  });
});

describe('Settings: microphone picker', () => {
  const mount = async (devices: Partial<MediaDeviceInfo>[]) => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { enumerateDevices: async () => devices, addEventListener() {}, removeEventListener() {} },
    });
    screen.mount(<MicrophoneSetting />);
    await tick(10);
  };

  it('an empty device list still shows the picker, disabled, and says how to fill it', async () => {
    await mount([]);
    const select = screen.q<HTMLSelectElement>('#mic-choice');
    expect(select.disabled).toBe(true);
    expect(screen.text()).toMatch(/No microphones are listed yet\. Tap Record in the Studio, or Sing in the Trainer/);
  });

  it('a list with microphones is a normal enabled picker', async () => {
    await mount([{ kind: 'audioinput', deviceId: 'a', label: 'iPhone Microphone' }]);
    expect(screen.q<HTMLSelectElement>('#mic-choice').disabled).toBe(false);
    expect(screen.text()).toMatch(/iPhone Microphone/);
    expect(screen.text()).not.toMatch(/No microphones are listed yet/);
  });
});

