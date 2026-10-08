// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

type ClaudeWindow = Window & { claude?: { use: (name: string) => Promise<unknown> } };

afterEach(() => {
  delete (window as ClaudeWindow).claude;
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('saveFile', () => {
  it('saves through the artifact viewer when its downloads capability is available', async () => {
    const save = vi.fn().mockResolvedValue({ status: 'saved' });
    (window as ClaudeWindow).claude = { use: vi.fn().mockResolvedValue({ save }) };
    const { saveFile } = await import('./download');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const blob = new Blob(['{}'], { type: 'application/json' });
    await saveFile(blob, 'take-analysis.json');
    expect(save).toHaveBeenCalledWith({ filename: 'take-analysis.json', data: blob });
    expect(click).not.toHaveBeenCalled();
  });

  it('treats a declined save as a normal outcome', async () => {
    const save = vi.fn().mockRejectedValue({ code: 'declined', message: 'no' });
    (window as ClaudeWindow).claude = { use: vi.fn().mockResolvedValue({ save }) };
    const { saveFile } = await import('./download');
    await expect(saveFile(new Blob(['{}']), 'a.json')).resolves.toBe(true);
  });

  it('falls back to a normal browser download outside the viewer', async () => {
    const { saveFile, hostDownloads } = await import('./download');
    expect(await hostDownloads()).toBeNull();
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await saveFile(new Blob(['x']), 'take.wav');
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe('saveFile on iOS', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';

  function iphone(share: unknown, canShare: unknown) {
    vi.stubGlobal('navigator', { userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5, share, canShare });
  }
  afterEach(() => vi.unstubAllGlobals());

  it('offers the file to the share sheet and does not download', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    iphone(share, vi.fn(() => true));
    const { saveFile } = await import('./download');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await saveFile(new Blob(['x'], { type: 'audio/wav' }), 'take.wav');
    expect(share).toHaveBeenCalledTimes(1);
    const arg = share.mock.calls[0][0] as { files: File[] };
    expect(arg.files[0].name).toBe('take.wav');
    expect(arg.files[0].type).toBe('audio/wav');
    expect(click).not.toHaveBeenCalled();
  });

  it('treats closing the share sheet as a cancel, not a failure', async () => {
    iphone(vi.fn().mockRejectedValue(Object.assign(new Error('cancel'), { name: 'AbortError' })), vi.fn(() => true));
    const { saveFile } = await import('./download');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    // false tells a caller that records "saved" (a backup) that nothing was saved.
    await expect(saveFile(new Blob(['x']), 'take.wav')).resolves.toBe(false);
    expect(click).not.toHaveBeenCalled();
  });

  it('says it saved when the share sheet took the file', async () => {
    iphone(vi.fn().mockResolvedValue(undefined), vi.fn(() => true));
    const { saveFile } = await import('./download');
    await expect(saveFile(new Blob(['x']), 'take.wav')).resolves.toBe(true);
  });

  it('falls back to a download when files cannot be shared', async () => {
    iphone(vi.fn(), vi.fn(() => false));
    const { saveFile } = await import('./download');
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await saveFile(new Blob(['x']), 'take.wav');
    expect(click).toHaveBeenCalledTimes(1);
  });
});
