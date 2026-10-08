// File downloads and the JSON export of a result.

import { isIos } from '../../pwa/platform';
import type { CoachingPlan, Comparison, ReferenceComparison, SingerProfile, VoiceAnalysis } from '../../types';

/**
 * The claude.ai artifact viewer's `downloads` capability. Inside that viewer a plain <a download>
 * does nothing, so saves go through `claude.use("downloads")`; everywhere else (GitHub Pages, local
 * dev) `window.claude` is absent and this resolves null.
 */
interface HostDownloads {
  save(request: { filename: string; data: Blob }): Promise<unknown>;
}
type HostWindow = Window & { claude?: { use?: (name: string) => Promise<unknown> } };

let hostDownloadsPromise: Promise<HostDownloads | null> | null = null;

export function hostDownloads(): Promise<HostDownloads | null> {
  if (!hostDownloadsPromise) {
    const claude = typeof window === 'undefined' ? undefined : (window as HostWindow).claude;
    hostDownloadsPromise =
      claude && typeof claude.use === 'function'
        ? claude.use('downloads').then(
            (ns) => (ns as HostDownloads | null) ?? null,
            () => null,
          )
        : Promise.resolve(null);
  }
  return hostDownloadsPromise;
}

/**
 * iPhone and iPad: hand the file to the system share sheet ("Save to Files", AirDrop, Voice Memos...).
 * A blob <a download> works in a Safari tab but has been unreliable in Home Screen web apps (it can open the
 * file in a window with no way back), and Save to Files is what people want for a take anyway.
 * navigator.share() must be called inside the tap that asked for it, so nothing is awaited before it.
 * Resolves 'shared' when the share sheet took it, 'cancelled' when the user closed the sheet without choosing anything, and
 * 'unavailable' when the share sheet cannot be used (the caller falls back to a download).
 */
async function shareFile(blob: Blob, filename: string): Promise<'shared' | 'cancelled' | 'unavailable'> {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return 'unavailable';
    const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
    if (!navigator.canShare({ files: [file] })) return 'unavailable';
    await navigator.share({ files: [file] });
    return 'shared';
  } catch (err) {
    // Closing the sheet rejects with AbortError: that is a cancel, not a failure.
    if ((err as { name?: string } | null)?.name === 'AbortError') return 'cancelled';
    return 'unavailable';
  }
}

/**
 * Save a generated file: through the host viewer when there is one, the share sheet on iOS, else a normal browser download.
 * Resolves false only when the person closed the iPhone share sheet without saving anywhere, so a caller that records "this was
 * saved" (a backup) can tell; every other path resolves true.
 */
export async function saveFile(blob: Blob, filename: string): Promise<boolean> {
  const inHostViewer = typeof window !== 'undefined' && typeof (window as HostWindow).claude?.use === 'function';
  if (!inHostViewer && isIos()) {
    const shared = await shareFile(blob, filename);
    if (shared === 'shared') return true;
    if (shared === 'cancelled') return false;
  }
  const host = await hostDownloads();
  if (host) {
    // The viewer shows its own confirmation; a decline is the viewer's choice, not an error to show.
    await host.save({ filename, data: blob }).catch(() => undefined);
    return true;
  }
  downloadBlob(blob, filename);
  return true;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke later: some browsers start the download asynchronously after click().
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** "My take (2)!" -> "my-take-2". */
export function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'take';
}

export interface ExportInput {
  takeName: string;
  source: string;
  analysis: VoiceAnalysis;
  profile: SingerProfile;
  comparison: Comparison;
  plan: CoachingPlan;
  referenceComparison?: ReferenceComparison | null;
  referenceName?: string;
}

/** A JSON-able export. Per-frame features are omitted (they are large and re-derivable from the WAV). */
export function buildAnalysisExport(input: ExportInput, exportedAt = new Date()): object {
  const { frames, ...analysis } = input.analysis;
  return {
    app: 'Mimic Vocal Coach',
    exportedAt: exportedAt.toISOString(),
    take: { name: input.takeName, source: input.source, durationSec: input.analysis.durationSec },
    profile: { id: input.profile.id, name: input.profile.name, source: input.profile.source, sourceNote: input.profile.sourceNote },
    analysis: { ...analysis, frameCount: frames.length },
    comparison: input.comparison,
    plan: input.plan,
    ...(input.referenceComparison
      ? { reference: { name: input.referenceName ?? 'Reference clip', comparison: input.referenceComparison } }
      : {}),
  };
}

/** JSON.stringify turns NaN into null already; this also rounds long floats so the file stays readable. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v) ? Math.round(v * 10000) / 10000 : v), 2);
}
