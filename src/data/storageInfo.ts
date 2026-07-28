/**
 * Storage persistence and the eviction tripwire. PLAN.md risk 3.
 *
 * Safari clears script-writable storage after ~7 days without interaction unless the site is
 * installed to the home screen or has been granted persistence. We cannot prevent that; what
 * we CAN do is ask for persistence everywhere, and detect afterwards that it happened so the
 * user gets an explanation instead of an empty library and the conclusion that we lost their
 * work.
 */

const TRIPWIRE_KEY = 'lines.hadData';

export interface StorageStatus {
  persisted: boolean;
  usageBytes: number | null;
  quotaBytes: number | null;
  /** True when localStorage says we had data but IndexedDB is empty: an eviction happened. */
  evictionDetected: boolean;
}

export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function readStorageStatus(hasDocuments: boolean): Promise<StorageStatus> {
  let persisted = false;
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;

  try {
    persisted = (await navigator.storage?.persisted?.()) ?? false;
    const est = await navigator.storage?.estimate?.();
    usageBytes = est?.usage ?? null;
    quotaBytes = est?.quota ?? null;
  } catch {
    // Storage Manager is unavailable in some embedded browsers; not an error worth surfacing.
  }

  const hadData = safeLocalGet(TRIPWIRE_KEY) === '1';
  return {
    persisted,
    usageBytes,
    quotaBytes,
    evictionDetected: hadData && !hasDocuments,
  };
}

/** Called after the first successful write. The mirror is what makes eviction detectable. */
export function armEvictionTripwire(): void {
  safeLocalSet(TRIPWIRE_KEY, '1');
}

export function disarmEvictionTripwire(): void {
  try {
    localStorage.removeItem(TRIPWIRE_KEY);
  } catch {
    /* private mode */
  }
}

function safeLocalGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: the tripwire is best-effort */
  }
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (navigator as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}
