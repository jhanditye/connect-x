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
    await expect(saveFile(new Blob(['{}']), 'a.json')).resolves.toBeUndefined();
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
