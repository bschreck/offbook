import { newId } from '../../core/util/id';
import {
  MAX_PULL_LIMIT,
  MAX_PUSH_BYTES,
  MAX_PUSH_RECORDS,
  type PushRejection,
  type SyncedStore,
  type SyncRecord,
} from '../../shared/sync/protocol';
import { getDb } from '../db';
import { getMeta, setMeta } from '../repos/meta';
import type { MetaKey } from '../schema';
import { ApiFailure, api } from './api';
import { applyPulled, syncKey, toSyncRecords } from './records';

/**
 * The client sync engine. ADR-0008.
 *
 * The one rule that outranks the rest: THE READER NEVER AWAITS THE NETWORK. Everything here
 * runs in the background, every failure is survivable, and `syncNow` never throws — an
 * unreachable server has to be indistinguishable from the app as it shipped without accounts.
 */

/** `meta` keys owned by sync. */
const META_DEVICE_ID = 'sync.deviceId';
const META_LAST_REV = 'sync.lastSyncedRev';
const META_PENDING_SINCE = 'sync.pendingSince';
const META_DIRTY = 'sync.dirty';

/**
 * `MetaKey` in data/schema.ts is a closed union that predates ADR-0008, and schema.ts belongs
 * to another module. Rather than widen a shared type from here, the four sync keys are cast at
 * this single boundary. Worth folding into `MetaKey` when schema.ts is next touched.
 */
function metaKey(key: string): MetaKey {
  return key as MetaKey;
}

export type SyncReason = 'manual' | 'startup' | 'sign-in' | 'visible' | 'online' | 'write';

export type SyncStatus = 'ok' | 'offline' | 'signed-out' | 'error';

export interface SyncOutcome {
  reason: SyncReason;
  status: SyncStatus;
  ok: boolean;
  /** True when the failure is expected and must not be surfaced as something to act on. */
  quiet: boolean;
  pulled: number;
  pushed: number;
  /** Records the server refused — quota and size limits say so out loud (ADR-0008). */
  rejected: PushRejection[];
  /** Whether IndexedDB actually changed, i.e. whether open views need to re-read. */
  changedLocally: boolean;
  /** The cursor after this round. */
  rev: number;
  message?: string;
  usageBytes?: number;
  quotaBytes?: number;
}

/** A hidden tab must not sync on a timer, so the debounce only ever runs while visible. */
export const WRITE_DEBOUNCE_MS = 2500;

/** Bounds one round: a server that keeps answering `more` cannot spin us forever. */
const MAX_PULL_PAGES = 200;

// ---------------------------------------------------------------------------
// meta-backed state
// ---------------------------------------------------------------------------

export async function getDeviceId(): Promise<string> {
  const existing = await getMeta<string>(metaKey(META_DEVICE_ID));
  if (typeof existing === 'string' && existing !== '') return existing;
  const id = newId();
  await setMeta(metaKey(META_DEVICE_ID), id);
  return id;
}

async function getLastSyncedRev(): Promise<number> {
  const v = await getMeta<number>(metaKey(META_LAST_REV));
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

/**
 * The pending model, stated plainly because the alternative is a mystery later.
 *
 * `pendingSince` is a watermark: every row whose own clock is at or after it still needs
 * pushing. It starts at 0, so a first sync after signing in offers the whole library. It
 * advances only to the moment a push STARTED, never to the moment it finished, so a write that
 * lands mid-push is picked up next round rather than silently skipped.
 *
 * `dirty` is an explicit `store:id` set on top of that, for the two stores whose rows carry no
 * clock (`settings`, and `docText` for a text whose document row was written long ago). It is
 * persisted, so a change made offline still pushes after a restart, and entries are removed
 * one by one as they are accepted — never cleared wholesale, which would drop a write made
 * while the push was in flight.
 */
async function getPendingSince(): Promise<number> {
  const v = await getMeta<number>(metaKey(META_PENDING_SINCE));
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

let dirtyCache: Set<string> | null = null;
let dirtyChain: Promise<void> = Promise.resolve();

async function loadDirty(): Promise<Set<string>> {
  if (dirtyCache) return dirtyCache;
  const stored = await getMeta<unknown>(metaKey(META_DIRTY));
  const set = new Set<string>();
  if (Array.isArray(stored)) {
    for (const k of stored) if (typeof k === 'string') set.add(k);
  }
  dirtyCache = set;
  return set;
}

/** Serialised so two concurrent `markDirty` calls cannot write over each other's set. */
function mutateDirty(fn: (set: Set<string>) => void): Promise<void> {
  const next = dirtyChain.then(async () => {
    const set = await loadDirty();
    fn(set);
    await setMeta(metaKey(META_DIRTY), [...set]);
  });
  // A failed meta write must not poison the chain or reject into a caller that did not await.
  dirtyChain = next.catch(() => {});
  return dirtyChain;
}

export function markDirty(store: SyncedStore, id: string): Promise<void> {
  const p = mutateDirty((set) => set.add(syncKey(store, id)));
  scheduleDebouncedSync();
  return p;
}

export interface SyncState {
  deviceId: string;
  lastSyncedRev: number;
  pendingSince: number;
  pendingKeys: string[];
}

export async function readSyncState(): Promise<SyncState> {
  const [deviceId, lastSyncedRev, pendingSince, dirty] = await Promise.all([
    getDeviceId(),
    getLastSyncedRev(),
    getPendingSince(),
    loadDirty(),
  ]);
  return { deviceId, lastSyncedRev, pendingSince, pendingKeys: [...dirty] };
}

/**
 * Sign-out, or signing in as somebody else. The cursor MUST go: a rev from one account means
 * nothing in another, and reusing it would silently skip that account's whole library. The
 * device id survives, since it only labels which device last wrote a row.
 */
export async function resetSyncCursor(): Promise<void> {
  await setMeta(metaKey(META_LAST_REV), 0);
  await setMeta(metaKey(META_PENDING_SINCE), 0);
  await mutateDirty((set) => set.clear());
}

// ---------------------------------------------------------------------------
// collecting what to push
// ---------------------------------------------------------------------------

/**
 * Everything that still needs to go up. `exclude` holds keys this round already reconciled on
 * the pull side, so a record the server just sent us is not sent straight back.
 */
async function collectPending(
  pendingSince: number,
  dirty: ReadonlySet<string>,
  exclude: ReadonlySet<string>,
  now: number,
): Promise<SyncRecord[]> {
  const db = await getDb();
  const records: SyncRecord[] = [];

  const isPending = (store: SyncedStore, id: string, clock: number | null): boolean => {
    const key = syncKey(store, id);
    if (exclude.has(key)) return false;
    if (dirty.has(key)) return true;
    return clock !== null && clock >= pendingSince;
  };

  const folders = (await db.getAll('folders')).filter((f) =>
    isPending('folders', f.id, f.updatedAt),
  );
  records.push(...toSyncRecords('folders', folders, now));

  const allDocs = await db.getAll('documents');
  const docs = allDocs.filter((d) => isPending('documents', d.id, d.updatedAt));
  records.push(...toSyncRecords('documents', docs, now));

  // `docText` is written once, with its document, and never again — so the document's
  // `createdAt` is the honest clock for it. Keying off the document's `updatedAt` instead would
  // re-upload a megabyte of text every time somebody renamed the thing.
  const createdAt = new Map(allDocs.map((d) => [d.id, d.createdAt] as const));
  const texts = (await db.getAll('docText')).filter((t) =>
    isPending('docText', t.docId, createdAt.get(t.docId) ?? null),
  );
  records.push(...toSyncRecords('docText', texts, now));

  // Bounded read: only reps at or after the watermark, rather than the whole practice log,
  // plus any explicitly marked. Reps union on merge, so a duplicate here would cost bandwidth
  // and nothing else — but the log grows forever and this read must not grow with it.
  const recent = await db.getAllFromIndex('reps', 'by-at', IDBKeyRange.lowerBound(pendingSince));
  const pendingReps = recent.filter((r) => isPending('reps', r.id, r.at));
  const haveRep = new Set(pendingReps.map((r) => r.id));
  for (const key of dirty) {
    if (!key.startsWith('reps:')) continue;
    const id = key.slice('reps:'.length);
    if (haveRep.has(id) || exclude.has(key)) continue;
    const row = await db.get('reps', id);
    if (row) {
      haveRep.add(id);
      pendingReps.push(row);
    }
  }
  records.push(...toSyncRecords('reps', pendingReps, now));

  // Settings have no stored clock, so after the first full push they travel only when marked.
  // `pendingSince === 0` means "nothing has ever been pushed", which is exactly when the whole
  // set should go up.
  const settings = (await db.getAll('settings')).filter((row) =>
    isPending('settings', row.key, pendingSince === 0 ? 0 : null),
  );
  records.push(...toSyncRecords('settings', settings, now));

  return records;
}

function batchForPush(records: readonly SyncRecord[]): SyncRecord[][] {
  const batches: SyncRecord[][] = [];
  let batch: SyncRecord[] = [];
  let bytes = 0;
  for (const rec of records) {
    const size = JSON.stringify(rec).length;
    if (batch.length > 0 && (batch.length >= MAX_PUSH_RECORDS || bytes + size > MAX_PUSH_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(rec);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

// ---------------------------------------------------------------------------
// one round
// ---------------------------------------------------------------------------

let inFlight: Promise<SyncOutcome> | null = null;

/**
 * Single-flight. Overlapping callers — a visibility change landing on top of a debounced write
 * — share the round already running rather than starting a second one and racing it.
 */
export function syncNow(reason: SyncReason): Promise<SyncOutcome> {
  if (inFlight) return inFlight;
  const round = runRound(reason).finally(() => {
    inFlight = null;
  });
  inFlight = round;
  return round;
}

export function isSyncing(): boolean {
  return inFlight !== null;
}

async function runRound(reason: SyncReason): Promise<SyncOutcome> {
  const out: SyncOutcome = {
    reason,
    status: 'ok',
    ok: true,
    quiet: false,
    pulled: 0,
    pushed: 0,
    rejected: [],
    changedLocally: false,
    rev: 0,
  };

  try {
    const deviceId = await getDeviceId();
    const dirty = new Set(await loadDirty());
    out.rev = await getLastSyncedRev();

    // ---- pull ----------------------------------------------------------
    // Keys the server has proved it already holds, so this round's push skips them.
    const settled = new Set<string>();
    for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
      const before = out.rev;
      const res = await api.pull({ sinceRev: before, limit: MAX_PULL_LIMIT });
      const applied = await applyPulled(res.records, dirty);
      out.pulled += res.records.length;
      if (applied.written > 0) out.changedLocally = true;
      for (const key of applied.settledKeys) settled.add(key);

      // The cursor moves ONLY here, after the page is committed. An interrupted sync then
      // resumes from the last committed page instead of skipping past what it never wrote.
      if (res.rev !== before) {
        await setMeta(metaKey(META_LAST_REV), res.rev);
        out.rev = res.rev;
      }
      if (!res.more) break;
      // A server that says `more` without advancing the cursor would loop forever.
      if (res.rev === before) break;
    }

    // ---- push ----------------------------------------------------------
    const startedAt = Date.now();
    const pendingSince = await getPendingSince();
    const records = await collectPending(pendingSince, dirty, settled, startedAt);

    // The rev the push response reports is deliberately NOT adopted as the cursor: another
    // device's write may sit between our old cursor and that rev, and skipping it would lose
    // that record for good. Our own rows come back on the next pull, where they are a no-op.
    for (const batch of batchForPush(records)) {
      const res = await api.push({ deviceId, records: batch });
      out.pushed += res.applied;
      out.rejected.push(...res.rejected);
      out.usageBytes = res.usageBytes;
      out.quotaBytes = res.quotaBytes;
      // Accepted or refused, these keys are settled: a rejection is reported to the user, not
      // retried in a loop that would repeat it forever.
      const sentKeys = batch.map((rec) => syncKey(rec.store, rec.id));
      await mutateDirty((set) => {
        for (const key of sentKeys) set.delete(key);
      });
      for (const key of sentKeys) dirty.delete(key);
    }

    // Reached only when every batch went out (a failure throws), so the watermark can move to
    // where collection started. Writes that landed during the push are at or after it and go
    // next round.
    await setMeta(metaKey(META_PENDING_SINCE), startedAt);

    return out;
  } catch (err) {
    return failed(out, err);
  }
}

function failed(out: SyncOutcome, err: unknown): SyncOutcome {
  out.ok = false;
  if (err instanceof ApiFailure) {
    if (err.status === 0) {
      out.status = 'offline';
      out.quiet = true;
    } else if (err.status === 401 || err.status === 403) {
      // Signed out, or the session was revoked. Normal, and nothing the user must act on:
      // every text is still on the device (ADR-0008).
      out.status = 'signed-out';
      out.quiet = true;
    } else {
      out.status = 'error';
    }
    out.message = err.message;
    return out;
  }
  out.status = 'error';
  // An IndexedDB failure mid-sync is still not the reader's problem. Whatever pages committed
  // stay committed; the rest is retried next round.
  out.message = err instanceof Error ? err.message : 'Sync did not finish.';
  return out;
}

// ---------------------------------------------------------------------------
// auto sync
// ---------------------------------------------------------------------------

let autoActive = false;
let shouldSync: () => boolean = () => false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let stopAutoSync: () => void = () => {};

function clearDebounce(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function scheduleDebouncedSync(): void {
  if (!autoActive || !shouldSync()) return;
  // No timer while hidden: a background tab waking up to sync is exactly the battery drain
  // this app has no business causing. The pending set is persisted, so nothing is lost.
  if (!isVisible()) return;
  clearDebounce();
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void syncNow('write');
  }, WRITE_DEBOUNCE_MS);
}

/**
 * Sync on becoming visible, on regaining connectivity, and a beat after local writes.
 * `enabled` is asked every time, so signing out stops sync without tearing listeners down.
 */
export function startAutoSync(enabled: () => boolean = () => true): () => void {
  if (autoActive) stopAutoSync();
  autoActive = true;
  shouldSync = enabled;

  const onVisibility = (): void => {
    if (!isVisible()) {
      clearDebounce();
      return;
    }
    if (shouldSync()) void syncNow('visible');
  };
  const onOnline = (): void => {
    if (shouldSync()) void syncNow('online');
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline);
  }

  if (shouldSync()) void syncNow('startup');

  const stop = (): void => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onOnline);
    }
    clearDebounce();
    autoActive = false;
    shouldSync = () => false;
  };
  stopAutoSync = stop;
  return stop;
}

/** Test-only: drop module state so a fresh fake-indexeddb starts from nothing. */
export function resetSyncEngineForTests(): void {
  clearDebounce();
  autoActive = false;
  shouldSync = () => false;
  stopAutoSync = () => {};
  inFlight = null;
  dirtyCache = null;
  dirtyChain = Promise.resolve();
}
