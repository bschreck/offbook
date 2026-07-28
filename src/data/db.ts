import { type IDBPDatabase, openDB } from 'idb';
import { DB_NAME, DB_VERSION, type OffbookDB } from './schema';

/**
 * The single IndexedDB connection. Every repository call awaits `getDb()`, so a reopen
 * after a `terminated` event is transparent to callers.
 *
 * Safari has a history of `open()` hanging indefinitely on first page load — a different
 * failure from `terminated()` — so the open is raced against a timeout and retried once.
 * PLAN.md §6.1 rule 5.
 */

let dbPromise: Promise<IDBPDatabase<OffbookDB>> | null = null;

const OPEN_TIMEOUT_MS = 8000;

export type BlockedHandler = (kind: 'blocked' | 'blocking' | 'terminated') => void;

let onTrouble: BlockedHandler = () => {};

export function setDbTroubleHandler(fn: BlockedHandler): void {
  onTrouble = fn;
}

function openOnce(): Promise<IDBPDatabase<OffbookDB>> {
  return openDB<OffbookDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // Deliberate fall-through: a device on v1 must also run the v2 arm. This is the
      // standard IndexedDB upgrade shape (PLAN.md §6.1) — do not add breaks.
      switch (oldVersion) {
        // biome-ignore lint/suspicious/noFallthroughSwitchClause: see above — intentional
        case 0: {
          db.createObjectStore('meta', { keyPath: 'key' });
          db.createObjectStore('settings', { keyPath: 'key' });

          const folders = db.createObjectStore('folders', { keyPath: 'id' });
          folders.createIndex('by-sort', 'sortName');

          const documents = db.createObjectStore('documents', { keyPath: 'id' });
          documents.createIndex('by-folder', 'folderId');
          documents.createIndex('by-practised', 'lastPracticedAt');
          documents.createIndex('by-updated', 'updatedAt');
          documents.createIndex('by-title', 'sortTitle');

          db.createObjectStore('docText', { keyPath: 'docId' });
        }
        // falls through
        case 1: {
          db.createObjectStore('derived', { keyPath: 'docId' });
          const reps = db.createObjectStore('reps', { keyPath: 'id' });
          reps.createIndex('by-at', 'at');
          reps.createIndex('by-doc-at', ['docId', 'at']);
        }
      }
    },
    blocked() {
      onTrouble('blocked');
    },
    blocking() {
      // Another tab wants to upgrade. Close so it can proceed; the next call reopens.
      onTrouble('blocking');
      void closeDb();
    },
    terminated() {
      onTrouble('terminated');
      dbPromise = null;
    },
  });
}

async function openWithTimeout(): Promise<IDBPDatabase<OffbookDB>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('IndexedDB open timed out')), OPEN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([openOnce(), timeout]);
  } catch {
    // One retry: the Safari hang usually clears on a second attempt.
    if (timer) clearTimeout(timer);
    return await openOnce();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function getDb(): Promise<IDBPDatabase<OffbookDB>> {
  if (!dbPromise) dbPromise = openWithTimeout();
  return dbPromise;
}

export async function closeDb(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise;
  db.close();
  dbPromise = null;
}

/** Test-only: drop the memoised connection so a fresh fake-indexeddb can be used. */
export function resetDbForTests(): void {
  dbPromise = null;
}
