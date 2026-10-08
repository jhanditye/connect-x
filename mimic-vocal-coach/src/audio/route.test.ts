import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RouteInfo } from './duplex';
import { classifyRoute, describeRoute, inputDevices, LOW_SAMPLE_RATE_HZ, micChoices, requestWakeLock, routeNotes, wakeLockSupported } from './route';

afterEach(() => {
  vi.unstubAllGlobals();
});

const input = (deviceId: string, label: string, groupId?: string) => ({ kind: 'audioinput' as const, deviceId, label, groupId });

describe('classifyRoute', () => {
  it.each([
    ['iPhone Microphone', 'builtin'],
    ['Built-in Microphone', 'builtin'],
    ['MacBook Pro Microphone', 'builtin'],
    ['Front Microphone', 'builtin'],
    ["Raj's AirPods Pro", 'bluetooth'],
    ['Bluetooth Headset', 'bluetooth'],
    ['Jabra Evolve2 65', 'bluetooth'],
    ['WH-1000XM5', 'bluetooth'],
    ['Powerbeats Pro', 'bluetooth'],
    ['Headset Microphone', 'wired'],
    ['EarPods', 'wired'],
    ['Lightning Headphones', 'wired'],
    ['USB Audio Device', 'unknown'],
    ['Studio Condenser', 'unknown'],
    ['', 'unknown'],
    ['   ', 'unknown'],
  ])('%s -> %s', (label, kind) => {
    expect(classifyRoute(label)).toBe(kind);
  });
});

describe('inputDevices', () => {
  it('keeps microphones only and drops the duplicate default and communications aliases', () => {
    const list = inputDevices([
      input('default', 'Default - Headset', 'g1'),
      input('communications', 'Communications - Headset', 'g1'),
      input('abc', 'Headset', 'g1'),
      input('def', 'Built-in Microphone', 'g2'),
      { kind: 'audiooutput', deviceId: 'out', label: 'Speakers' },
    ]);
    expect(list.map((d) => d.id)).toEqual(['abc', 'def']);
  });

  it('keeps an alias that has no real device behind it, and entries without an id', () => {
    expect(inputDevices([input('default', 'Default', 'only')]).map((d) => d.id)).toEqual(['default']);
    expect(inputDevices([input('', '')])).toHaveLength(1);
  });
});

describe('describeRoute', () => {
  it('finds the active microphone by id or by label', () => {
    const devices = [input('a', 'iPhone Microphone'), input('b', 'AirPods Pro')];
    expect(describeRoute(devices, 'b', 48000).inputLabel).toBe('AirPods Pro');
    expect(describeRoute(devices, 'AirPods Pro', 48000).kind).toBe('bluetooth');
    const first = describeRoute(devices, '', 44100);
    expect(first.inputLabel).toBe('iPhone Microphone');
    expect(first.sampleRate).toBe(44100);
  });

  it('thinks headphones are likely when any listed microphone is wired or Bluetooth, even if the iPhone one is active', () => {
    const r = describeRoute([input('a', 'iPhone Microphone'), input('b', 'AirPods Pro')], 'a', 48000);
    expect(r.kind).toBe('builtin');
    expect(r.headphonesLikely).toBe(true);
    expect(describeRoute([input('a', 'iPhone Microphone')], 'a').headphonesLikely).toBe(false);
  });

  it('flags hidden labels instead of guessing, and survives an empty list', () => {
    const hidden = describeRoute([input('a', ''), input('b', '')], '');
    expect(hidden.labelsHidden).toBe(true);
    expect(hidden.kind).toBe('unknown');
    expect(hidden.headphonesLikely).toBe(false);
    const none = describeRoute([], '', 48000, 16000);
    expect(none).toMatchObject({ inputs: [], inputLabel: '', labelsHidden: false, kind: 'unknown', inputSampleRate: 16000 });
  });
});

describe('micChoices', () => {
  const route = describeRoute([input('a', 'iPhone Microphone'), input('b', "Raj's AirPods"), input('c', '')], 'b', 48000);
  it('marks the one in use, recommends the phone mic while Bluetooth is active and names unnamed ones', () => {
    const choices = micChoices(route);
    expect(choices.map((c) => c.label)).toEqual(['iPhone Microphone', "Raj's AirPods", 'Microphone 3']);
    expect(choices.map((c) => c.current)).toEqual([false, true, false]);
    expect(choices.map((c) => c.recommended)).toEqual([true, false, false]);
  });

  it('recommends nothing when Bluetooth is not in use', () => {
    const r = describeRoute([input('a', 'iPhone Microphone'), input('b', 'AirPods')], 'a', 48000);
    expect(micChoices(r).some((c) => c.recommended)).toBe(false);
  });
});

describe('routeNotes', () => {
  const base: RouteInfo = { inputLabel: 'iPhone Microphone', inputs: [{ id: 'a', label: 'iPhone Microphone' }], kind: 'builtin', headphonesLikely: false, sampleRate: 48000 };

  it('Bluetooth in use: warns, and offers the phone microphone only when there is one', () => {
    const withBuiltin: RouteInfo = { ...base, kind: 'bluetooth', inputLabel: 'AirPods', inputs: [{ id: 'a', label: 'iPhone Microphone' }, { id: 'b', label: 'AirPods' }], headphonesLikely: true };
    const notes = routeNotes(withBuiltin);
    expect(notes[0]).toMatchObject({ id: 'bluetooth-mic', level: 'warn', action: 'use-builtin-mic' });
    expect(notes[0].message).toMatch(/iPhone microphone/);
    const noBuiltin: RouteInfo = { ...withBuiltin, inputs: [{ id: 'b', label: 'AirPods' }] };
    expect(routeNotes(noBuiltin)[0].action).toBeUndefined();
  });

  it('a 16 kHz microphone is phone-call quality; a wideband one is not mentioned', () => {
    const low = routeNotes({ ...base, inputSampleRate: 16000, headphonesLikely: true });
    expect(low.find((n) => n.id === 'low-sample-rate')?.message).toMatch(/16 kHz/);
    expect(routeNotes({ ...base, inputSampleRate: 48000, headphonesLikely: true })).toEqual([]);
    expect(LOW_SAMPLE_RATE_HZ).toBe(32000);
  });

  it('an audio engine running below 32 kHz is an info note', () => {
    const notes = routeNotes({ ...base, sampleRate: 22050, headphonesLikely: true });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ id: 'low-sample-rate', level: 'info' });
  });

  it('sing-along on the speaker is the one that warns, with the way out', () => {
    const along = routeNotes(base, 'sing-along');
    expect(along).toHaveLength(1);
    expect(along[0]).toMatchObject({ id: 'speaker-sing-along', level: 'warn', action: 'listen-then-sing' });
    const turn = routeNotes(base, 'turn-taking');
    expect(turn[0]).toMatchObject({ id: 'no-headphones', level: 'info' });
    expect(turn[0].action).toBeUndefined();
  });

  it('headphones present: nothing to say', () => {
    expect(routeNotes({ ...base, kind: 'wired', headphonesLikely: true, inputLabel: 'Headset Microphone' }, 'sing-along')).toEqual([]);
  });

  it('hidden labels ask the singer to allow the microphone, instead of claiming there are no headphones', () => {
    const notes = routeNotes({ ...base, inputLabel: '', inputs: [{ id: 'x', label: '' }], kind: 'unknown', labelsHidden: true }, 'sing-along');
    expect(notes.map((n) => n.id)).toEqual(['labels-hidden']);
    expect(notes[0].action).toBe('allow-microphone');
  });
});

describe('wake lock', () => {
  it('takes the lock and releases it once when asked', async () => {
    const release = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({ release, addEventListener: vi.fn() }));
    vi.stubGlobal('navigator', { wakeLock: { request } });
    expect(wakeLockSupported()).toBe(true);
    const off = await requestWakeLock();
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith('screen');
    off();
    off();
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('is not reported as supported where it is known to do nothing (a Home Screen app before iOS 18.4)', () => {
    vi.stubGlobal('navigator', {
      wakeLock: { request: async () => ({}) },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      platform: 'iPhone',
      maxTouchPoints: 5,
      standalone: true,
    });
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(wakeLockSupported()).toBe(false);
  });

  it('does nothing, without throwing, where the browser has no wake lock or refuses it', async () => {
    vi.stubGlobal('navigator', {});
    expect(wakeLockSupported()).toBe(false);
    const off = await requestWakeLock();
    expect(() => off()).not.toThrow();
    vi.stubGlobal('navigator', { wakeLock: { request: async () => Promise.reject(new Error('NotAllowedError')) } });
    const off2 = await requestWakeLock();
    await Promise.resolve();
    expect(() => off2()).not.toThrow();
  });

  it('a lock released before the browser answered is let go as soon as it arrives', async () => {
    const release = vi.fn(async () => undefined);
    let answer!: (v: unknown) => void;
    vi.stubGlobal('navigator', { wakeLock: { request: () => new Promise((r) => (answer = r)) } });
    const off = await requestWakeLock();
    off();
    answer({ release, addEventListener: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
