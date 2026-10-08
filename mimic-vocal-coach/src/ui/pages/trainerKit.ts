// Small pieces the Trainer screens share: moving focus to a page's heading when its sub-view changes, a backup download used by
// the library banner and by Settings, and grouping clips by singer.

import { useEffect, useRef, type RefObject } from 'react';
import { exportFileName } from '../../storage/library';
import type { TrainerController } from '../../state/trainerContext';
import type { ClipRecord, SingerProfile } from '../../types';
import { saveFile } from '../components/download';

/**
 * A ref for a page's heading. When `enabled`, the page scrolls to the top and the heading takes focus as the screen appears, so
 * keyboard and screen-reader users land on the new screen (the person moved from the library to a clip, or to a phrase). The
 * first screen of a visit is left alone: the shell has just focused the page.
 */
export function useFocusOnMount<T extends HTMLElement>(enabled: boolean): RefObject<T | null> {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!enabled) return;
    try {
      window.scrollTo({ top: 0 });
    } catch {
      // jsdom and some embedded browsers do not implement scrolling.
    }
    ref.current?.focus({ preventScroll: true });
    // Only when the screen appears.
  }, []);
  return ref;
}

/** Saves the library (never audio) as a JSON file. Resolves with a sentence to show, and never rejects. */
export async function downloadLibraryBackup(trainer: Pick<TrainerController, 'exportLibrary'>): Promise<{ ok: boolean; message: string }> {
  try {
    const blob = await trainer.exportLibrary();
    await saveFile(blob, exportFileName());
    return { ok: true, message: 'Backup saved. It holds your clips, phrases and scores but no audio; the audio stays on this device.' };
  } catch (err) {
    const why = err instanceof Error && err.message ? ` ${err.message}` : '';
    return { ok: false, message: `The backup could not be saved.${why} Try again, or reload the app first.` };
  }
}

export interface ClipGroup {
  key: string;
  name: string;
  singer: SingerProfile | null;
  clips: ClipRecord[];
}

/** Clips grouped by singer: the builtin singers in their usual order, then everyone else by the name the person typed. */
export function groupClips(clips: readonly ClipRecord[], singers: readonly SingerProfile[]): ClipGroup[] {
  const out = new Map<string, ClipGroup>();
  for (const s of singers) out.set(s.id, { key: s.id, name: s.name, singer: s, clips: [] });
  for (const c of clips) {
    const known = c.singerId !== null ? singers.find((s) => s.id === c.singerId) : undefined;
    if (known) {
      out.get(known.id)?.clips.push(c);
      continue;
    }
    const label = c.singerLabel.trim();
    const key = `other:${label.toLowerCase()}`;
    let g = out.get(key);
    if (!g) {
      g = { key, name: label || 'Someone else', singer: null, clips: [] };
      out.set(key, g);
    }
    g.clips.push(c);
  }
  return [...out.values()].filter((g) => g.clips.length > 0);
}

/** The singer for a clip, or null for "someone else". */
export function singerOf(clip: ClipRecord, singers: readonly SingerProfile[]): SingerProfile | null {
  return clip.singerId === null ? null : (singers.find((s) => s.id === clip.singerId) ?? null);
}

/** "Shawn Mendes", the typed name, or "Someone else". */
export function singerName(clip: ClipRecord, singers: readonly SingerProfile[]): string {
  return singerOf(clip, singers)?.name ?? (clip.singerLabel.trim() || 'Someone else');
}
