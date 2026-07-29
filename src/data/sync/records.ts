import { SYNCED_STORES, type SyncedStore, type SyncRecord } from '../../shared/sync/protocol';
import { publishWrite } from '../broadcast';
import { getDb } from '../db';
import {
  DEFAULT_SETTINGS,
  type DocTextRecord,
  type DocumentRecord,
  type FolderRecord,
  type RepRecord,
  type SettingRow,
  type SettingsShape,
} from '../schema';

/**
 * Translation between IndexedDB rows and the wire `SyncRecord`. ADR-0008.
 *
 * The merge rules here MIRROR the server's, deliberately, because either side may be the one
 * that sees a pair of writes first:
 *   - `docText` is immutable and content-addressed, so an arriving copy of a text we already
 *     have is a no-op rather than an overwrite.
 *   - `reps` are append-only with UUID keys, so the merge is set union and cannot conflict.
 *   - `folders`, `documents`, `settings` are last-write-wins on `updatedAt`; a tie keeps the
 *     local row, which is deterministic and costs nothing (the server breaks its own ties by
 *     device id, and its answer arrives on the next pull).
 */

export interface SyncRowMap {
  folders: FolderRecord;
  documents: DocumentRecord;
  docText: DocTextRecord;
  reps: RepRecord;
  settings: SettingRow;
}

/** `store:id` — the key shape used for the pending set and for echo suppression. */
export function syncKey(store: SyncedStore, id: string): string {
  return `${store}:${id}`;
}

export function isSyncedStore(store: string): store is SyncedStore {
  return (SYNCED_STORES as readonly string[]).includes(store);
}

function mutableRecord(
  store: 'folders' | 'documents',
  row: FolderRecord | DocumentRecord,
): SyncRecord {
  // The existing soft delete already IS a tombstone (ADR-0008), so a deleted row travels
  // without its payload: there is nothing on the far side that wants a dead document's title.
  if (row.deletedAt !== null) {
    return { store, id: row.id, updatedAt: row.updatedAt, deleted: true };
  }
  return { store, id: row.id, updatedAt: row.updatedAt, payload: row };
}

/**
 * `now` is the wire clock for the two stores whose IndexedDB rows carry no timestamp of
 * their own — `docText` (immutable, so its clock is meaningless: identical id implies
 * identical bytes) and `settings` (tiny, per-key, and only ever pushed because something
 * just changed it).
 */
export function toSyncRecords(
  store: 'folders',
  rows: readonly FolderRecord[],
  now: number,
): SyncRecord[];
export function toSyncRecords(
  store: 'documents',
  rows: readonly DocumentRecord[],
  now: number,
): SyncRecord[];
export function toSyncRecords(
  store: 'docText',
  rows: readonly DocTextRecord[],
  now: number,
): SyncRecord[];
export function toSyncRecords(store: 'reps', rows: readonly RepRecord[], now: number): SyncRecord[];
export function toSyncRecords(
  store: 'settings',
  rows: readonly SettingRow[],
  now: number,
): SyncRecord[];
export function toSyncRecords(
  store: SyncedStore,
  rows: readonly unknown[],
  now: number,
): SyncRecord[] {
  switch (store) {
    case 'folders':
      return (rows as readonly FolderRecord[]).map((row) => mutableRecord('folders', row));
    case 'documents':
      return (rows as readonly DocumentRecord[]).map((row) => mutableRecord('documents', row));
    case 'docText':
      return (rows as readonly DocTextRecord[]).map((row) => ({
        store: 'docText' as const,
        id: row.docId,
        updatedAt: now,
        payload: row,
      }));
    case 'reps':
      return (rows as readonly RepRecord[]).map((row) => ({
        store: 'reps' as const,
        id: row.id,
        updatedAt: row.at,
        payload: row,
      }));
    case 'settings':
      return (rows as readonly SettingRow[]).map((row) => ({
        store: 'settings' as const,
        id: row.key,
        updatedAt: now,
        payload: row,
      }));
  }
}

export interface ApplyResult {
  written: number;
  /** Records deliberately not applied: older, immutable-and-present, protected, or malformed. */
  skipped: number;
  /** `store:id` of what actually landed. */
  writtenKeys: string[];
  /**
   * `store:id` where local and remote now agree — applied, or already identical. The pushing
   * side skips these: the server demonstrably has them, so echoing them back is pure waste.
   * A key skipped because the LOCAL row is newer is deliberately NOT here, since that row is
   * exactly the one that still needs to go up.
   */
  settledKeys: string[];
  /** Documents whose derivation is now stale and must be rebuilt on next read. */
  invalidatedDocIds: string[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): boolean {
  return typeof v === 'string';
}

/**
 * A payload arrives from the network, and the server never inspected it (that is the whole
 * point of one generic table). A row of the wrong shape must be dropped rather than written: a
 * corrupt `documents` row would break the library list for a text that is otherwise fine.
 */
function isFolder(p: unknown): p is FolderRecord {
  return isObject(p) && str(p.name) && typeof p.updatedAt === 'number';
}

function isDocument(p: unknown): p is DocumentRecord {
  return isObject(p) && str(p.title) && str(p.textHash) && typeof p.updatedAt === 'number';
}

function isDocText(p: unknown): p is DocTextRecord {
  return isObject(p) && str(p.sourceText) && str(p.textHash);
}

function isRep(p: unknown): p is RepRecord {
  return isObject(p) && str(p.docId) && typeof p.at === 'number';
}

function isSettingRow(p: unknown): p is SettingRow {
  return isObject(p) && 'value' in p;
}

/**
 * Write pulled records into IndexedDB.
 *
 * `protect` holds `store:id` keys with unpushed local changes. It is honoured for `settings`
 * only: settings rows have no stored clock, so last-write-wins cannot see that the local value
 * is the newer one. For `folders` and `documents` the clock decides, as ADR-0008 says it must.
 *
 * One transaction, so a mid-page failure applies nothing and the caller's cursor stays put.
 */
export async function applyPulled(
  records: readonly SyncRecord[],
  protect: ReadonlySet<string> = new Set(),
): Promise<ApplyResult> {
  const result: ApplyResult = {
    written: 0,
    skipped: 0,
    writtenKeys: [],
    settledKeys: [],
    invalidatedDocIds: [],
  };
  if (records.length === 0) return result;

  const touched = new Set<SyncedStore>();
  for (const r of records) {
    if (isSyncedStore(r.store)) touched.add(r.store);
    else result.skipped += 1;
  }
  if (touched.size === 0) return result;

  const db = await getDb();
  const tx = db.transaction([...touched, 'derived'], 'readwrite');
  const invalidate = new Set<string>();

  const wrote = (store: SyncedStore, id: string): void => {
    result.written += 1;
    result.writtenKeys.push(syncKey(store, id));
    result.settledKeys.push(syncKey(store, id));
  };

  /** Skipped because the two sides already agree — not because ours is newer. */
  const agreed = (store: SyncedStore, id: string): void => {
    result.skipped += 1;
    result.settledKeys.push(syncKey(store, id));
  };

  for (const rec of records) {
    if (!isSyncedStore(rec.store)) continue;
    const { id } = rec;
    if (typeof id !== 'string' || id === '') {
      result.skipped += 1;
      continue;
    }

    switch (rec.store) {
      case 'folders': {
        const s = tx.objectStore('folders');
        const existing = await s.get(id);
        if (existing && existing.updatedAt > rec.updatedAt) {
          result.skipped += 1;
          break;
        }
        if (existing && existing.updatedAt === rec.updatedAt) {
          agreed('folders', id);
          break;
        }
        if (rec.deleted) {
          if (!existing) {
            result.skipped += 1;
            break;
          }
          await s.put({ ...existing, deletedAt: rec.updatedAt, updatedAt: rec.updatedAt });
          wrote('folders', id);
          break;
        }
        if (!isFolder(rec.payload)) {
          result.skipped += 1;
          break;
        }
        await s.put({ ...rec.payload, id });
        wrote('folders', id);
        break;
      }

      case 'documents': {
        const s = tx.objectStore('documents');
        const existing = await s.get(id);
        if (existing && existing.updatedAt > rec.updatedAt) {
          result.skipped += 1;
          break;
        }
        if (existing && existing.updatedAt === rec.updatedAt) {
          agreed('documents', id);
          break;
        }
        if (rec.deleted) {
          if (!existing) {
            result.skipped += 1;
            break;
          }
          await s.put({ ...existing, deletedAt: rec.updatedAt, updatedAt: rec.updatedAt });
          invalidate.add(id);
          wrote('documents', id);
          break;
        }
        if (!isDocument(rec.payload)) {
          result.skipped += 1;
          break;
        }
        await s.put({ ...rec.payload, id });
        // Any change to the document row can move `textHash`, `roles`, `cleanupConfig` or
        // `structureOverrides`, all of which feed the derivation. Invalidating on every change
        // costs one recomputation; not invalidating renders the wrong text.
        invalidate.add(id);
        wrote('documents', id);
        break;
      }

      case 'docText': {
        const s = tx.objectStore('docText');
        const existing = await s.get(id);
        if (rec.deleted) {
          if (!existing) {
            result.skipped += 1;
            break;
          }
          await s.delete(id);
          invalidate.add(id);
          wrote('docText', id);
          break;
        }
        // Immutable (PLAN.md §3.1): if we already hold this docId we already hold the bytes,
        // and overwriting could only ever replace good text with the same text.
        if (existing) {
          agreed('docText', id);
          break;
        }
        if (!isDocText(rec.payload)) {
          result.skipped += 1;
          break;
        }
        await s.put({ ...rec.payload, docId: id });
        invalidate.add(id);
        wrote('docText', id);
        break;
      }

      case 'reps': {
        const s = tx.objectStore('reps');
        if (rec.deleted) {
          await s.delete(id);
          wrote('reps', id);
          break;
        }
        // Append-only union (ADR-0006): a rep we already have is the same rep.
        if (await s.get(id)) {
          agreed('reps', id);
          break;
        }
        if (!isRep(rec.payload)) {
          result.skipped += 1;
          break;
        }
        await s.put({ ...rec.payload, id });
        wrote('reps', id);
        break;
      }

      case 'settings': {
        const s = tx.objectStore('settings');
        if (protect.has(syncKey('settings', id)) || !(id in DEFAULT_SETTINGS)) {
          result.skipped += 1;
          break;
        }
        const key = id as keyof SettingsShape;
        if (rec.deleted) {
          await s.delete(key);
          wrote('settings', id);
          break;
        }
        if (!isSettingRow(rec.payload)) {
          result.skipped += 1;
          break;
        }
        await s.put({ key, value: rec.payload.value } satisfies SettingRow);
        wrote('settings', id);
        break;
      }
    }
  }

  const derived = tx.objectStore('derived');
  for (const docId of invalidate) await derived.delete(docId);
  await tx.done;

  result.invalidatedDocIds = [...invalidate];

  // Other tabs are holding in-memory copies of these rows. Without this they keep rendering
  // pre-sync state until reload (PLAN.md §6.1 rule 6).
  for (const key of result.writtenKeys) {
    const cut = key.indexOf(':');
    publishWrite(key.slice(0, cut), key.slice(cut + 1));
  }

  return result;
}
