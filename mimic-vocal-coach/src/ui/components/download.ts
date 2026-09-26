// File downloads and the JSON export of a result.

import type { CoachingPlan, Comparison, ReferenceComparison, SingerProfile, VoiceAnalysis } from '../../types';

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
