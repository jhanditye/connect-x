// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLeaveGuard } from './leaveGuard';
import { clearPendingImport, peekPendingImport } from './trainerHandoff';
import { installWindowFileDrop, setSheetDropTarget } from './windowFileDrop';

function dragEvent(type: 'dragover' | 'drop', files: File[], types: string[] = ['Files']) {
  const e = new Event(type, { cancelable: true, bubbles: true }) as Event & { dataTransfer: { types: string[]; files: File[]; dropEffect: string } };
  e.dataTransfer = { types, files, dropEffect: 'move' };
  return e;
}
const song = () => new File(['x'], 'Song.m4a', { type: 'audio/mp4' });
const pdf = () => new File(['x'], 'Lyrics.pdf', { type: 'application/pdf' });

let ready = true;
let remove: () => void;

beforeEach(() => {
  ready = true;
  window.location.hash = '#settings';
  clearPendingImport();
  remove = installWindowFileDrop(() => ready);
});
afterEach(() => {
  remove();
  setSheetDropTarget(null);
  setLeaveGuard(null);
  clearPendingImport();
});

describe('a file dropped anywhere on the window', () => {
  it('is never opened by the browser: both the drag-over and the drop are cancelled', () => {
    const over = dragEvent('dragover', [song()]);
    window.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer.dropEffect).toBe('copy');
    const drop = dragEvent('drop', [pdf()]);
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(window.location.hash).toBe('#settings'); // a PDF goes nowhere
    expect(peekPendingImport()).toEqual([]);
  });

  it.each(['#settings', '#guide', '#more', '#results', '#progress', '#trainer', '#trainer/c/abc'])('hands a song to the Add clips sheet from %s', (hash) => {
    window.location.hash = hash;
    const f = song();
    const drop = dragEvent('drop', [f, pdf()]);
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(window.location.hash).toBe('#trainer/add');
    expect(peekPendingImport()).toEqual([f]);
  });

  it.each(['#studio', '#practice', '#trainer/c/abc/p/2'])('is swallowed but not followed on %s, where a take may be under way', (hash) => {
    window.location.hash = hash;
    const over = dragEvent('dragover', [song()]);
    window.dispatchEvent(over);
    expect(over.dataTransfer.dropEffect).toBe('none');
    const drop = dragEvent('drop', [song()]);
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(window.location.hash).toBe(hash);
    expect(peekPendingImport()).toEqual([]);
  });

  it('is swallowed, not followed, while the library is not open yet', () => {
    ready = false;
    const drop = dragEvent('drop', [song()]);
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(window.location.hash).toBe('#settings');
  });

  it('leaves alone a drop that a drop area already took', () => {
    const taken = dragEvent('drop', [song()]);
    taken.preventDefault();
    window.dispatchEvent(taken);
    expect(window.location.hash).toBe('#settings');
    expect(peekPendingImport()).toEqual([]);
  });

  it('leaves alone a drag that carries no files (selected text, a link)', () => {
    const e = dragEvent('dragover', [], ['text/plain']);
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    const d = dragEvent('drop', [], ['text/plain']);
    window.dispatchEvent(d);
    expect(d.defaultPrevented).toBe(false);
  });

  it('goes to the open Add clips sheet instead of navigating again', () => {
    window.location.hash = '#trainer/add';
    const take = vi.fn();
    setSheetDropTarget(take);
    const f = song();
    window.dispatchEvent(dragEvent('drop', [f]));
    expect(take).toHaveBeenCalledWith([f]);
    expect(peekPendingImport()).toEqual([]);
  });

  it('does not move on when a screen holding a take asks to keep the person there', () => {
    const guard = vi.fn(() => true);
    setLeaveGuard(guard);
    window.dispatchEvent(dragEvent('drop', [song()]));
    expect(guard).toHaveBeenCalledWith('#trainer/add');
    expect(window.location.hash).toBe('#settings');
    expect(peekPendingImport()).toEqual([]);
  });

  it('stops listening once removed', () => {
    remove();
    const drop = dragEvent('drop', [song()]);
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
    remove = installWindowFileDrop(() => ready);
  });
});
