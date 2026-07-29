import type {
  PullRequest,
  PullResponse,
  PushRejection,
  PushRequest,
  PushResponse,
  RejectReason,
  SyncedStore,
  SyncRecord,
} from '../../src/shared/sync/protocol';
import {
  APPEND_ONLY_STORES,
  IMMUTABLE_STORES,
  MAX_ACCOUNT_BYTES,
  MAX_PULL_LIMIT,
  MAX_RECORD_BYTES,
  SYNCED_STORES,
} from '../../src/shared/sync/protocol';
import type { AuthedUser } from './env';

/**
 * The sync engine: merge decisions, byte accounting, and the two D1 conversations that pull
 * and push are. ADR-0008.
 *
 * The decision functions are pure and take plain projections rather than rows, so the whole
 * merge policy is testable without a database — which matters, because the policy is the part
 * that can silently lose a user's work.
 *
 * The endpoint files under `functions/api/sync/` are HTTP shells: authenticate, parse,
 * delegate here.
 */

/** The columns pull reads. Snake case because these are rows, not domain objects. */
interface PullRow {
  store: string;
  id: string;
  rev: number;
  updated_at: number;
  deleted: number;
  payload: string | null;
}

interface ExistingRow {
  store: string;
  id: string;
  updated_at: number;
  deleted: number;
  bytes: number;
  device_id: string | null;
}

/**
 * Just enough of a stored row to decide a merge. `payload` is deliberately absent: the server
 * never inspects it, and reading 50 MB of text to decide a timestamp comparison would be
 * absurd.
 */
export interface ExistingRecord {
  updatedAt: number;
  deleted: boolean;
  bytes: number;
  deviceId: string | null;
}

/** A record as offered by a device. `deleted` is required so a caller cannot forget the case. */
export interface IncomingRecord {
  store: SyncedStore;
  id: string;
  updatedAt: number;
  deleted: boolean;
  deviceId: string;
}

export type WriteDecision = 'apply' | 'skip-stale' | 'skip-identical';

/**
 * A push is bounded because Workers Free allows 10 ms of CPU per request (ADR-0008) and the
 * JSON work here is the only CPU this endpoint spends. Matches `MAX_PULL_LIMIT` so a client
 * that pages one direction can use the same page size for the other.
 */

/** Long enough for a UUID with room to spare; short enough that it cannot be a payload. */
const MAX_ID_LENGTH = 200;

const encoder = new TextEncoder();

export function isSyncedStore(store: unknown): store is SyncedStore {
  return typeof store === 'string' && (SYNCED_STORES as readonly string[]).includes(store);
}

/** The JSON a row stores, or null for a tombstone. */
export function payloadJson(record: SyncRecord): string | null {
  if (record.deleted === true || record.payload === undefined) return null;
  return JSON.stringify(record.payload) ?? null;
}

/**
 * Bytes charged against `usage_bytes`: the stored JSON, measured in UTF-8 rather than UTF-16
 * code units, because that is what the row actually costs. A tombstone costs nothing, which
 * is how a deletion frees space even though the row itself survives to replicate.
 */
export function recordBytes(record: SyncRecord): number {
  const json = payloadJson(record);
  return json === null ? 0 : encoder.encode(json).length;
}

/**
 * Everything arriving from a device is untrusted JSON, whatever the static type says, so this
 * checks shape at runtime and names the refusal in the protocol's own vocabulary.
 */
export function validateRecord(record: unknown): RejectReason | null {
  if (typeof record !== 'object' || record === null) return 'malformed';
  const r = record as Record<string, unknown>;

  if (!isSyncedStore(r.store)) return 'unknown-store';
  if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > MAX_ID_LENGTH) {
    return 'malformed';
  }
  if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt) || r.updatedAt < 0) {
    return 'malformed';
  }
  if (r.deleted !== undefined && typeof r.deleted !== 'boolean') return 'malformed';

  // A live record with no payload would replicate as a hole in the other device's database.
  // Only a tombstone is allowed to carry nothing.
  if (r.deleted !== true && r.payload === undefined) return 'malformed';

  if (recordBytes(record as SyncRecord) > MAX_RECORD_BYTES) return 'record-too-large';
  return null;
}

/**
 * The whole merge policy, from ADR-0008 "Why sync is unusually cheap here".
 *
 * `existing` is the row the server already holds, or null when this id is new.
 */
export function decideWrite(
  incoming: IncomingRecord,
  existing: ExistingRecord | null,
): WriteDecision {
  // New id — including a tombstone for something we never held, which still has to replicate
  // to the other devices and costs nothing but a row.
  if (existing === null) return 'apply';

  const contentIsFixed =
    IMMUTABLE_STORES.includes(incoming.store) || APPEND_ONLY_STORES.includes(incoming.store);

  if (contentIsFixed) {
    // `docText` is content-addressed by an immutable `sourceText` and `reps` is append-only
    // (ADR-0006), so the same id means the same bytes: a re-push is a no-op, not a conflict.
    if (!incoming.deleted) return 'skip-identical';
    // A tombstone is the one update these stores can meaningfully receive. Refusing it would
    // leave a deleted document's text in the account for ever, holding quota that nothing can
    // reach — see the tombstone rule in ADR-0008 "Quotas".
    return existing.deleted ? 'skip-identical' : 'apply';
  }

  // Mutable metadata: last-write-wins on the client clock. A tombstone is just another write
  // with a timestamp, so a later edit on another device still beats an earlier delete.
  if (incoming.updatedAt > existing.updatedAt) return 'apply';
  if (incoming.updatedAt < existing.updatedAt) return 'skip-stale';

  // Exact tie. Comparing device ids lexically is arbitrary, but it is symmetric, and symmetry
  // is the entire requirement: both devices must reach the same answer without talking.
  const mine = incoming.deviceId;
  const theirs = existing.deviceId ?? '';
  if (mine === theirs) return 'skip-identical';
  return mine > theirs ? 'apply' : 'skip-stale';
}

/** Clamped at zero: a negative total would be a bookkeeping bug, not free quota. */
export function applyUsageDelta(usageBytes: number, delta: number): number {
  return Math.max(0, usageBytes + delta);
}

/**
 * Checked against the DELTA, so re-pushing an unchanged record — or shrinking one — can never
 * trip the limit on an account that is already at it.
 */
export function wouldExceedQuota(
  usageBytes: number,
  delta: number,
  quotaBytes: number = MAX_ACCOUNT_BYTES,
): boolean {
  return delta > 0 && usageBytes + delta > quotaBytes;
}

function trimZeros(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, '');
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${trimZeros(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${trimZeros(bytes / 1024)} kB`;
  return `${bytes} bytes`;
}

/** These end up in a toast, not a log file, so they are sentences with an outcome in them. */
export function rejectionMessage(
  reason: RejectReason,
  bytes = 0,
  quotaBytes: number = MAX_ACCOUNT_BYTES,
): string {
  switch (reason) {
    case 'stale':
      return 'The server already has a newer version of this, so your change was not applied. Offbook will fetch the newer one and try again.';
    case 'record-too-large':
      return `This item is ${formatBytes(bytes)}, over the ${formatBytes(MAX_RECORD_BYTES)} limit for a single item, so it stays on this device only.`;
    case 'quota-exceeded':
      return `Your account has reached its ${formatBytes(quotaBytes)} limit, so this item was not saved to the server. It is still safe on this device. Delete something you no longer need, then sync again.`;
    case 'unknown-store':
      return 'The server does not recognise this kind of item, so it was not synced. This usually means one of your devices is running a newer version of Offbook.';
    case 'malformed':
      return 'The server could not read this item, so it was not synced. Nothing on this device was changed.';
  }
}

export function clampPullLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) return MAX_PULL_LIMIT;
  return Math.min(Math.floor(limit), MAX_PULL_LIMIT);
}

const PULL_SQL =
  'SELECT store, id, rev, updated_at, deleted, payload FROM records' +
  ' WHERE user_id = ?1 AND rev > ?2 ORDER BY rev LIMIT ?3';

const EXISTING_SQL_PREFIX =
  'SELECT store, id, updated_at, deleted, bytes, device_id FROM records' +
  ' WHERE user_id = ?1 AND id IN (';

/**
 * Read-modify-write in one statement. This is the load-bearing line of the whole module: a
 * SELECT followed by an UPDATE would hand two devices pushing at the same moment the same
 * revision, and one of them would then be invisible to every other device for ever.
 */
const ALLOCATE_REV_SQL = 'UPDATE users SET rev = rev + ?1 WHERE id = ?2 RETURNING rev';

const UPSERT_SQL =
  'INSERT INTO records (user_id, store, id, rev, updated_at, deleted, payload, bytes, device_id)' +
  ' VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)' +
  ' ON CONFLICT(user_id, store, id) DO UPDATE SET' +
  ' rev = excluded.rev, updated_at = excluded.updated_at, deleted = excluded.deleted,' +
  ' payload = excluded.payload, bytes = excluded.bytes, device_id = excluded.device_id';

/** Relative, not absolute, so two concurrent pushes cannot clobber each other's accounting. */
const USAGE_SQL = 'UPDATE users SET usage_bytes = MAX(0, usage_bytes + ?1) WHERE id = ?2';

/** D1 caps bound parameters per statement, so the id lookup goes in chunks. */
const ID_LOOKUP_CHUNK = 90;

function keyOf(store: string, id: string): string {
  // NUL cannot appear in either part, so this composite key cannot be ambiguous.
  return `${store}\u0000${id}`;
}

function parsePayload(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    // Only reachable if a row was written by something other than push. Losing one payload
    // beats failing a whole page of otherwise good records.
    return null;
  }
}

export async function executePull(
  db: D1Database,
  user: AuthedUser,
  req: PullRequest,
): Promise<PullResponse> {
  const sinceRev = Math.max(0, Math.floor(req.sinceRev));
  const limit = clampPullLimit(req.limit);

  const { results } = await db.prepare(PULL_SQL).bind(user.id, sinceRev, limit).all<PullRow>();

  const records: SyncRecord[] = [];
  // The cursor may only advance as far as this page actually reaches. Returning the user's
  // current maximum instead would make the client skip every record above the page it just
  // received — the classic way to lose data in this pattern.
  let highest = sinceRev;

  for (const row of results) {
    highest = Math.max(highest, row.rev);
    // Rows were validated on the way in, so this can only fire after a downgrade. The cursor
    // still moves past it, or the client would ask for it again for ever.
    if (!isSyncedStore(row.store)) continue;

    records.push(
      row.deleted !== 0
        ? { store: row.store, id: row.id, rev: row.rev, updatedAt: row.updated_at, deleted: true }
        : {
            store: row.store,
            id: row.id,
            rev: row.rev,
            updatedAt: row.updated_at,
            payload: parsePayload(row.payload),
          },
    );
  }

  // A filled page might happen to be the last one; the client then makes one empty call. That
  // is cheaper than the alternative, which is a COUNT on every pull.
  return { rev: highest, records, more: results.length >= limit };
}

async function fetchExisting(
  db: D1Database,
  userId: string,
  ids: readonly string[],
): Promise<Map<string, ExistingRecord>> {
  const found = new Map<string, ExistingRecord>();

  for (let i = 0; i < ids.length; i += ID_LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + ID_LOOKUP_CHUNK);
    const placeholders = chunk.map((_, n) => `?${n + 2}`).join(', ');
    const { results } = await db
      .prepare(`${EXISTING_SQL_PREFIX}${placeholders})`)
      .bind(userId, ...chunk)
      .all<ExistingRow>();

    for (const row of results) {
      found.set(keyOf(row.store, row.id), {
        updatedAt: row.updated_at,
        deleted: row.deleted !== 0,
        bytes: row.bytes,
        deviceId: row.device_id,
      });
    }
  }
  return found;
}

interface PlannedWrite {
  record: SyncRecord;
  bytes: number;
}

export async function executePush(
  db: D1Database,
  user: AuthedUser,
  req: PushRequest,
): Promise<PushResponse> {
  const rejected: PushRejection[] = [];
  const valid: PlannedWrite[] = [];

  for (const record of req.records) {
    const reason = validateRecord(record);
    if (reason !== null) {
      rejected.push({
        store: isSyncedStore(record?.store) ? record.store : 'unknown',
        id: typeof record?.id === 'string' ? record.id : '',
        reason,
        // Safe to measure only here: `record-too-large` is reached after the shape checks.
        message: rejectionMessage(reason, reason === 'record-too-large' ? recordBytes(record) : 0),
      });
      continue;
    }
    valid.push({ record, bytes: recordBytes(record) });
  }

  const existing = await fetchExisting(db, user.id, [...new Set(valid.map((v) => v.record.id))]);

  const toWrite: PlannedWrite[] = [];
  let usage = user.usageBytes;

  for (const candidate of valid) {
    const { record, bytes } = candidate;
    const key = keyOf(record.store, record.id);
    const prior = existing.get(key) ?? null;

    const decision = decideWrite(
      {
        store: record.store,
        id: record.id,
        updatedAt: record.updatedAt,
        deleted: record.deleted === true,
        deviceId: req.deviceId,
      },
      prior,
    );

    if (decision === 'skip-identical') continue;

    if (decision === 'skip-stale') {
      // Reported rather than dropped, so the client knows to pull before retrying instead of
      // quietly believing its version won.
      rejected.push({
        store: record.store,
        id: record.id,
        reason: 'stale',
        message: rejectionMessage('stale'),
      });
      continue;
    }

    const delta = bytes - (prior?.bytes ?? 0);
    if (wouldExceedQuota(usage, delta)) {
      rejected.push({
        store: record.store,
        id: record.id,
        reason: 'quota-exceeded',
        message: rejectionMessage('quota-exceeded'),
      });
      continue;
    }

    usage = applyUsageDelta(usage, delta);
    toWrite.push(candidate);
    // A push may legitimately contain the same id twice; from here on this write is what the
    // server holds, so a later duplicate in the same batch is compared against it.
    existing.set(key, {
      updatedAt: record.updatedAt,
      deleted: record.deleted === true,
      bytes,
      deviceId: req.deviceId,
    });
  }

  const totalDelta = usage - user.usageBytes;
  let newRev = user.rev;

  if (toWrite.length > 0) {
    const allocated = await db
      .prepare(ALLOCATE_REV_SQL)
      .bind(toWrite.length, user.id)
      .first<{ rev: number }>();
    if (allocated === null) throw new Error('rev allocation returned no row');

    // The block ends at the returned value, so the first record of this push gets the first
    // revision above whatever the previous allocation reached.
    const base = allocated.rev - toWrite.length;
    newRev = allocated.rev;

    const statements = toWrite.map((w, i) =>
      db
        .prepare(UPSERT_SQL)
        .bind(
          user.id,
          w.record.store,
          w.record.id,
          base + i + 1,
          w.record.updatedAt,
          w.record.deleted === true ? 1 : 0,
          payloadJson(w.record),
          w.bytes,
          req.deviceId,
        ),
    );
    if (totalDelta !== 0) {
      statements.push(db.prepare(USAGE_SQL).bind(totalDelta, user.id));
    }
    // One batch, so a failure cannot leave rows written with `usage_bytes` unaccounted for.
    // Revisions allocated by a batch that then fails are simply skipped, which is harmless:
    // pull orders by `rev` and never assumes it is dense.
    await db.batch(statements);
  }

  return {
    // The server's new high-water mark. NOT a pull cursor: this client has not seen whatever
    // other devices wrote below it.
    rev: newRev,
    // Records actually written. An identical re-push is neither applied nor rejected, so
    // `applied + rejected.length` can be less than `records.length`.
    applied: toWrite.length,
    rejected,
    usageBytes: usage,
    quotaBytes: MAX_ACCOUNT_BYTES,
  };
}
