/**
 * The sync wire protocol. Shared by the client and the Worker. ADR-0008.
 *
 * The server never looks inside `payload` — it routes by `(store, id)` and orders by `rev`.
 * That is what lets one generic table replace five typed ones, and it means adding a field
 * to a document is not a server change.
 */

/** Stores that replicate. `derived` is absent on purpose: it is a cache, recomputed locally. */
export const SYNCED_STORES = ['folders', 'documents', 'docText', 'reps', 'settings'] as const;
export type SyncedStore = (typeof SYNCED_STORES)[number];

/** Append-only stores union on merge and can never conflict (ADR-0006). */
export const APPEND_ONLY_STORES: readonly SyncedStore[] = ['reps'];

/** Immutable payloads: identical id implies identical content, so a re-push is a no-op. */
export const IMMUTABLE_STORES: readonly SyncedStore[] = ['docText'];

export interface SyncRecord {
  store: SyncedStore;
  /** Primary key within the store. `docId` for docText, `key` for settings, else `id`. */
  id: string;
  /** Server-assigned. Absent on push, always present on pull. */
  rev?: number;
  /** Client clock, milliseconds. The last-write-wins comparand for mutable stores. */
  updatedAt: number;
  /** A tombstone. The payload is dropped when true. */
  deleted?: boolean;
  /** Opaque to the server. Absent when `deleted`. */
  payload?: unknown;
}

export interface PullRequest {
  /** 0 for a first sync, which returns everything. */
  sinceRev: number;
  limit?: number;
}

export interface PullResponse {
  /** The client's new cursor — but only once it has committed every record in this page. */
  rev: number;
  records: SyncRecord[];
  /** True when more records remain above `rev`; call again with the new cursor. */
  more: boolean;
}

export interface PushRequest {
  deviceId: string;
  records: SyncRecord[];
}

export type RejectReason =
  | 'stale'
  | 'record-too-large'
  | 'quota-exceeded'
  | 'unknown-store'
  | 'malformed';

export interface PushRejection {
  store: SyncedStore | string;
  id: string;
  reason: RejectReason;
  /** Written for a human: it ends up in a toast, not a log file. */
  message: string;
}

export interface PushResponse {
  rev: number;
  applied: number;
  rejected: PushRejection[];
  usageBytes: number;
  quotaBytes: number;
}

export interface AccountInfo {
  username: string;
  createdAt: number;
  usageBytes: number;
  quotaBytes: number;
}

export const MAX_RECORD_BYTES = 1024 * 1024;
export const MAX_ACCOUNT_BYTES = 50 * 1024 * 1024;
export const MAX_PULL_LIMIT = 200;

/**
 * Push batching, shared so the two sides cannot drift. The client used to cap at 100 while
 * the server capped at 200: harmless by luck, but raising either alone would have made
 * pushes start failing with no obvious cause. JSON encoding is the only CPU this endpoint
 * spends, and Workers Free allows 10 ms of it.
 */
export const MAX_PUSH_RECORDS = 100;
export const MAX_PUSH_BYTES = 2 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;
export const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/;

export interface ApiError {
  error: string;
  /** Shown to the user verbatim, so it has to read like a sentence. */
  message: string;
}
