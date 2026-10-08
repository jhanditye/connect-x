// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ios = { value: true };
vi.mock('../../pwa/platform', async (orig) => ({ ...(await orig<typeof import('../../pwa/platform')>()), isIos: () => ios.value }));

import { saveFile, saveFileOutcome } from './download';

const blob = new Blob(['{}'], { type: 'application/json' });

function stubShare(share: (data: unknown) => Promise<void>, canShare = true) {
  const fn = vi.fn(share);
  Object.defineProperty(navigator, 'share', { configurable: true, value: fn });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => canShare });
  return fn;
}

const clicked: string[] = [];
beforeEach(() => {
  ios.value = true;
  clicked.length = 0;
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:x';
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this.download);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete (navigator as unknown as Record<string, unknown>).share;
  delete (navigator as unknown as Record<string, unknown>).canShare;
});

describe('saveFileOutcome', () => {
  it('opens the share sheet in the same tick as the call, before anything is awaited (the tap is only good for about five seconds)', async () => {
    const share = stubShare(async () => undefined);
    const pending = saveFileOutcome(blob, 'backup.json');
    expect(share).toHaveBeenCalledTimes(1);
    expect(await pending).toBe('shared');
    expect(clicked).toEqual([]);
  });

  it('a closed share sheet is a cancel and saves nothing', async () => {
    stubShare(async () => {
      throw new DOMException('closed', 'AbortError');
    });
    expect(await saveFileOutcome(blob, 'backup.json')).toBe('cancelled');
    expect(clicked).toEqual([]);
    expect(await saveFile(blob, 'backup.json')).toBe(false);
  });

  it('a tap that was used up is reported as needs-tap when asked, and nothing is downloaded behind the person\'s back', async () => {
    stubShare(async () => {
      throw new DOMException('needs a user gesture', 'NotAllowedError');
    });
    expect(await saveFileOutcome(blob, 'backup.json', { retryOnBlocked: true })).toBe('needs-tap');
    expect(clicked).toEqual([]);
    const seen: string[] = [];
    expect(await saveFile(blob, 'backup.json', { retryOnBlocked: true, onOutcome: (o) => seen.push(o) })).toBe(false);
    expect(seen).toEqual(['needs-tap']);
  });

  it('without that option the old behaviour stays: a refused share falls back to a download', async () => {
    stubShare(async () => {
      throw new DOMException('needs a user gesture', 'NotAllowedError');
    });
    expect(await saveFileOutcome(blob, 'take.wav')).toBe('unverified');
    expect(clicked).toEqual(['take.wav']);
    expect(await saveFile(blob, 'take.wav')).toBe(true);
  });

  it('an iPhone that cannot share files falls back to a download it cannot confirm', async () => {
    stubShare(async () => undefined, false);
    expect(await saveFileOutcome(blob, 'backup.json')).toBe('unverified');
    expect(clicked).toEqual(['backup.json']);
  });

  it('a desktop or Android browser downloads, which it shows, and that counts as saved', async () => {
    ios.value = false;
    const share = stubShare(async () => undefined);
    expect(await saveFileOutcome(blob, 'backup.json')).toBe('saved');
    expect(share).not.toHaveBeenCalled();
    expect(clicked).toEqual(['backup.json']);
  });
});
