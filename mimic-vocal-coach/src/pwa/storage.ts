// Is this app's data safe? Safari clears the storage of sites you have not used for a while, but a
// Home Screen web app counts its own days of use and can also ask for "persistent" storage.
// Everything here is feature-detected: it must never throw.

export interface StorageStatus {
  /** navigator.storage exists at all. */
  api: boolean;
  /** true = the browser promised not to evict; false = best effort; null = unknown. */
  persisted: boolean | null;
  usageBytes: number | null;
  quotaBytes: number | null;
}

type StorageLike = Pick<StorageManager, 'persisted' | 'persist' | 'estimate'> | undefined;

function manager(): StorageLike {
  try {
    return (globalThis.navigator as Navigator | undefined)?.storage;
  } catch {
    return undefined;
  }
}

export async function readStorageStatus(storage: StorageLike = manager()): Promise<StorageStatus> {
  if (!storage) return { api: false, persisted: null, usageBytes: null, quotaBytes: null };
  const [persisted, estimate] = await Promise.all([
    typeof storage.persisted === 'function' ? storage.persisted().catch(() => null) : Promise.resolve(null),
    typeof storage.estimate === 'function' ? storage.estimate().catch(() => null) : Promise.resolve(null),
  ]);
  return {
    api: true,
    persisted,
    usageBytes: estimate && typeof estimate.usage === 'number' ? estimate.usage : null,
    quotaBytes: estimate && typeof estimate.quota === 'number' ? estimate.quota : null,
  };
}

/**
 * Ask the browser to keep this origin's data. Safari decides on its own, with no prompt (WebKit weighs
 * things like being opened as a Home Screen web app), so false is a normal answer in a browser tab.
 */
export async function requestPersistence(storage: StorageLike = manager()): Promise<boolean | null> {
  if (!storage || typeof storage.persist !== 'function') return null;
  try {
    return await storage.persist();
  } catch {
    return null;
  }
}

export function formatBytes(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'unknown';
  if (n < 1024 * 1024) return `${Math.max(0, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}
