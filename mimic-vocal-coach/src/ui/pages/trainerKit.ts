// Small pieces the Trainer screens share: moving focus to a page's heading when its sub-view changes, a backup download used by
// the library banner and by Settings, and grouping clips by singer.

import { isDesktopKind, platformKind } from '../../pwa/platform';
import { useEffect, useRef, type RefObject } from 'react';
import { exportFileName } from '../../storage/library';
import type { ExportReport, TrainerController } from '../../state/trainerContext';
import type { ClipRecord, SingerProfile } from '../../types';
import { saveFile, type SaveOutcome } from '../components/download';

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

export interface BackupResult {
  ok: boolean;
  message: string;
}

/** A file built by a tap whose share sheet the browser refused: the next tap shares it at once, with nothing awaited first. */
let readyBackup: { blob: Blob; name: string; report: ExportReport | null; at: number } | null = null;
/** How long a built backup stays shareable by a second tap. */
const READY_MS = 120_000;

/** Forgets a backup file that was built and is waiting for a second tap (a screen that unmounts, and tests). */
export function clearReadyBackup(): void {
  readyBackup = null;
}

/** The sentence about what a backup left out, for the end of a message. */
function leftOut(report: ExportReport | null): string {
  return report && report.warnings.length > 0 ? ` ${report.warnings.join(' ')}` : '';
}

/**
 * Saves the library (never audio) as a JSON file. Resolves with a sentence to show, and never rejects. The backup counts as made (the
 * reminder is cleared) only when the file was really handed to somewhere the person chose, and was complete:
 *  - a closed share sheet, a failed save, or a download an iPhone cannot confirm leaves the reminder on and says so;
 *  - a file that could not include everything (practice history that could not be read) is saved but called incomplete;
 *  - if the browser refuses the share sheet because the tap was used up while the file was being built, the file is kept and the next
 *    tap on the same button shares it at once.
 */
export async function downloadLibraryBackup(trainer: Pick<TrainerController, 'exportLibrary' | 'markExported' | 'lastExportReport'>): Promise<BackupResult> {
  try {
    let ready = readyBackup && Date.now() - readyBackup.at < READY_MS ? readyBackup : null;
    readyBackup = null;
    if (!ready) {
      const blob = await trainer.exportLibrary({ markDone: !trainer.markExported });
      ready = { blob, name: exportFileName(), report: trainer.lastExportReport?.() ?? null, at: Date.now() };
    }
    const { blob, name, report } = ready;
    const got: { outcome?: SaveOutcome } = {};
    const saved = await saveFile(blob, name, { retryOnBlocked: true, onOutcome: (o) => (got.outcome = o) });
    // A saveFile that does not report (a stand-in in a test) is read from its yes/no answer.
    const result: SaveOutcome = got.outcome ?? (saved === false ? 'cancelled' : 'saved');
    if (result === 'cancelled') return { ok: false, message: 'The backup was not saved because the share sheet was closed. Tap the same button again and choose Save to Files.' };
    if (result === 'needs-tap') {
      readyBackup = ready;
      return { ok: false, message: 'Your backup is ready, but the phone only opens the share sheet right after a tap. Tap the same button again to finish.' };
    }
    if (result === 'unverified') {
      return {
        ok: false,
        message: `The backup was handed to the browser as a download, but this app cannot tell whether it was saved. Open the Files app, then Downloads, and look for ${name} before you delete anything. The backup reminder stays on. Tap the same button again to use the share sheet instead.${leftOut(report)}`,
      };
    }
    if (report && !report.complete) {
      return { ok: false, message: `This backup is incomplete.${leftOut(report)} The backup reminder stays on; try again in a moment.` };
    }
    await trainer.markExported?.();
    const where = isDesktopKind(platformKind()) ? ` Look for ${name} in your Downloads folder (or wherever your browser keeps downloads).` : '';
    return { ok: true, message: `Backup saved.${where} It holds your clips, phrases and scores but no audio; the audio stays on this device.${leftOut(report)}` };
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
