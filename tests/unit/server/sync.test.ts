import { describe, expect, it } from 'vitest';
import type { AuthedUser } from '../../../functions/_lib/env';
import type { ExistingRecord, IncomingRecord } from '../../../functions/_lib/sync';
import {
  applyUsageDelta,
  decideWrite,
  executePull,
  executePush,
  recordBytes,
  validateRecord,
  wouldExceedQuota,
} from '../../../functions/_lib/sync';
import type { SyncedStore, SyncRecord } from '../../../src/shared/sync/protocol';
import { MAX_ACCOUNT_BYTES, MAX_RECORD_BYTES } from '../../../src/shared/sync/protocol';

/* ------------------------------------------------------------------ fake D1 */

interface StoredRow {
  user_id: string;
  store: string;
  id: string;
  rev: number;
  updated_at: number;
  deleted: number;
  payload: string | null;
  bytes: number;
  device_id: string | null;
}

interface UserRow {
  id: string;
  rev: number;
  usage_bytes: number;
}

/** Every statement yields, so two concurrent pushes genuinely interleave. */
function tick(): Promise<void> {
  return Promise.resolve();
}

/**
 * A fake D1 that understands only the five statements the sync module issues, matched by
 * prefix. Brittle on purpose: if the SQL changes shape, these tests should fail loudly rather
 * than keep passing while exercising nothing.
 */
class FakeD1 {
  readonly users = new Map<string, UserRow>();
  readonly rows: StoredRow[] = [];

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const statement of statements) out.push(await statement.run());
    return out;
  }

  /** The production code takes a real `D1Database`; this is the only place that lies about it. */
  get handle(): D1Database {
    return this as unknown as D1Database;
  }

  user(id = 'u1'): UserRow {
    const row = this.users.get(id);
    if (row === undefined) throw new Error(`fake user ${id} does not exist`);
    return row;
  }
}

class FakeStatement {
  private readonly db: FakeD1;
  private readonly sql: string;
  private args: unknown[] = [];

  constructor(db: FakeD1, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...values: unknown[]): FakeStatement {
    this.args = values;
    return this;
  }

  async all<T>(): Promise<{ results: T[] }> {
    await tick();
    return { results: this.exec() as unknown as T[] };
  }

  async first<T>(): Promise<T | null> {
    await tick();
    const rows = this.exec();
    return (rows[0] as T | undefined) ?? null;
  }

  async run(): Promise<{ results: never[] }> {
    await tick();
    this.exec();
    return { results: [] };
  }

  private exec(): Record<string, unknown>[] {
    const sql = this.sql;
    const args = this.args;

    if (sql.startsWith('SELECT store, id, rev, updated_at, deleted, payload FROM records')) {
      const [userId, sinceRev, limit] = args as [string, number, number];
      return this.db.rows
        .filter((r) => r.user_id === userId && r.rev > sinceRev)
        .sort((a, b) => a.rev - b.rev)
        .slice(0, limit)
        .map((r) => ({
          store: r.store,
          id: r.id,
          rev: r.rev,
          updated_at: r.updated_at,
          deleted: r.deleted,
          payload: r.payload,
        }));
    }

    if (sql.startsWith('SELECT store, id, updated_at, deleted, bytes, device_id FROM records')) {
      const [userId, ...ids] = args as [string, ...string[]];
      return this.db.rows
        .filter((r) => r.user_id === userId && ids.includes(r.id))
        .map((r) => ({
          store: r.store,
          id: r.id,
          updated_at: r.updated_at,
          deleted: r.deleted,
          bytes: r.bytes,
          device_id: r.device_id,
        }));
    }

    if (sql.startsWith('UPDATE users SET rev = rev + ')) {
      const [count, userId] = args as [number, string];
      const user = this.db.user(userId);
      // Atomic, exactly as `UPDATE ... RETURNING` is: no read-then-write window.
      user.rev += count;
      return [{ rev: user.rev }];
    }

    if (sql.startsWith('UPDATE users SET usage_bytes = ')) {
      const [delta, userId] = args as [number, string];
      const user = this.db.user(userId);
      user.usage_bytes = Math.max(0, user.usage_bytes + delta);
      return [];
    }

    if (sql.startsWith('INSERT INTO records')) {
      const [userId, store, id, rev, updatedAt, deleted, payload, bytes, deviceId] = args as [
        string,
        string,
        string,
        number,
        number,
        number,
        string | null,
        number,
        string | null,
      ];
      const next: StoredRow = {
        user_id: userId,
        store,
        id,
        rev,
        updated_at: updatedAt,
        deleted,
        payload,
        bytes,
        device_id: deviceId,
      };
      const prior = this.db.rows.find(
        (r) => r.user_id === userId && r.store === store && r.id === id,
      );
      if (prior === undefined) this.db.rows.push(next);
      else Object.assign(prior, next);
      return [];
    }

    throw new Error(`FakeD1 does not know this statement: ${sql}`);
  }
}

/* ---------------------------------------------------------------- fixtures */

function makeDb(usageBytes = 0): FakeD1 {
  const db = new FakeD1();
  db.users.set('u1', { id: 'u1', rev: 0, usage_bytes: usageBytes });
  return db;
}

/** A fresh read of the user, which is what `requireUser` hands the endpoints. */
function authed(db: FakeD1): AuthedUser {
  const row = db.user();
  return {
    id: row.id,
    username: 'ben',
    usernameDisplay: 'Ben',
    usageBytes: row.usage_bytes,
    rev: row.rev,
  };
}

function seedRow(
  db: FakeD1,
  rev: number,
  store: SyncedStore,
  id: string,
  payload: unknown,
  bytes = 10,
): void {
  db.rows.push({
    user_id: 'u1',
    store,
    id,
    rev,
    updated_at: rev * 10,
    deleted: 0,
    payload: JSON.stringify(payload),
    bytes,
    device_id: 'device-a',
  });
  const user = db.user();
  user.rev = Math.max(user.rev, rev);
  user.usage_bytes += bytes;
}

function incoming(over: Partial<IncomingRecord> = {}): IncomingRecord {
  return {
    store: 'documents',
    id: 'doc-1',
    updatedAt: 1_000,
    deleted: false,
    deviceId: 'device-a',
    ...over,
  };
}

function stored(over: Partial<ExistingRecord> = {}): ExistingRecord {
  return { updatedAt: 1_000, deleted: false, bytes: 10, deviceId: 'device-a', ...over };
}

/** The same record seen from the other side, for the tie-break symmetry check. */
function asExisting(record: IncomingRecord): ExistingRecord {
  return {
    updatedAt: record.updatedAt,
    deleted: record.deleted,
    bytes: 10,
    deviceId: record.deviceId,
  };
}

/* -------------------------------------------------------------- decideWrite */

describe('decideWrite', () => {
  it('applies anything the server has never seen', () => {
    expect(decideWrite(incoming(), null)).toBe('apply');
    expect(decideWrite(incoming({ store: 'docText', id: 't1' }), null)).toBe('apply');
    expect(decideWrite(incoming({ store: 'reps', id: 'r1' }), null)).toBe('apply');
  });

  it('treats a docText re-push as a no-op, because sourceText is immutable', () => {
    expect(decideWrite(incoming({ store: 'docText', updatedAt: 9_999 }), stored())).toBe(
      'skip-identical',
    );
    // Even an older timestamp is not "stale": the content cannot have differed.
    expect(decideWrite(incoming({ store: 'docText', updatedAt: 1 }), stored())).toBe(
      'skip-identical',
    );
  });

  it('treats a rep re-push as a no-op and a new rep as an insert, because reps are append-only', () => {
    expect(decideWrite(incoming({ store: 'reps', updatedAt: 9_999 }), stored())).toBe(
      'skip-identical',
    );
    expect(decideWrite(incoming({ store: 'reps' }), null)).toBe('apply');
  });

  it('lets the newer document metadata write win and calls the older one stale', () => {
    expect(decideWrite(incoming({ updatedAt: 2_000 }), stored({ updatedAt: 1_000 }))).toBe('apply');
    expect(decideWrite(incoming({ updatedAt: 500 }), stored({ updatedAt: 1_000 }))).toBe(
      'skip-stale',
    );
    expect(decideWrite(incoming({ store: 'folders', updatedAt: 2_000 }), stored())).toBe('apply');
    expect(decideWrite(incoming({ store: 'settings', updatedAt: 100 }), stored())).toBe(
      'skip-stale',
    );
  });

  it('resolves an exact updatedAt tie the same way whichever side is called incoming', () => {
    const deviceA = incoming({ deviceId: 'device-a' });
    const deviceB = incoming({ deviceId: 'device-b' });

    // Same winner either way round — which is the entire requirement, since the two devices
    // decide independently and must not disagree.
    expect(decideWrite(deviceA, asExisting(deviceB))).toBe('skip-stale');
    expect(decideWrite(deviceB, asExisting(deviceA))).toBe('apply');
  });

  it('treats a tie from the same device as a no-op', () => {
    const same = incoming({ deviceId: 'device-a' });
    expect(decideWrite(same, asExisting(same))).toBe('skip-identical');
  });

  it('lets a tombstone through for an immutable store, but only once', () => {
    // Otherwise a deleted document's text would hold quota for ever with nothing able to
    // reach it — see the report; this is the one place the stated rule was widened.
    expect(decideWrite(incoming({ store: 'docText', deleted: true }), stored())).toBe('apply');
    expect(
      decideWrite(incoming({ store: 'docText', deleted: true }), stored({ deleted: true })),
    ).toBe('skip-identical');
  });

  it('still applies last-write-wins to a tombstone in a mutable store', () => {
    expect(
      decideWrite(incoming({ updatedAt: 500, deleted: true }), stored({ updatedAt: 1_000 })),
    ).toBe('skip-stale');
  });
});

/* ------------------------------------------------------------ validateRecord */

describe('validateRecord', () => {
  it('accepts a well-formed record', () => {
    expect(validateRecord({ store: 'documents', id: 'd1', updatedAt: 1, payload: {} })).toBeNull();
    expect(validateRecord({ store: 'docText', id: 'd1', updatedAt: 1, deleted: true })).toBeNull();
  });

  it('rejects a non-object', () => {
    expect(validateRecord(null)).toBe('malformed');
    expect(validateRecord('documents')).toBe('malformed');
  });

  it('rejects a store it does not replicate', () => {
    expect(validateRecord({ store: 'derived', id: 'd1', updatedAt: 1, payload: {} })).toBe(
      'unknown-store',
    );
    expect(validateRecord({ store: 42, id: 'd1', updatedAt: 1, payload: {} })).toBe(
      'unknown-store',
    );
  });

  it('rejects a malformed id or updatedAt', () => {
    expect(validateRecord({ store: 'documents', id: '', updatedAt: 1, payload: {} })).toBe(
      'malformed',
    );
    expect(
      validateRecord({ store: 'documents', id: 'x'.repeat(500), updatedAt: 1, payload: {} }),
    ).toBe('malformed');
    expect(validateRecord({ store: 'documents', id: 'd1', updatedAt: '1', payload: {} })).toBe(
      'malformed',
    );
    expect(
      validateRecord({ store: 'documents', id: 'd1', updatedAt: Number.NaN, payload: {} }),
    ).toBe('malformed');
    expect(validateRecord({ store: 'documents', id: 'd1', updatedAt: -1, payload: {} })).toBe(
      'malformed',
    );
  });

  it('rejects a live record with no payload, which would replicate as a hole', () => {
    expect(validateRecord({ store: 'documents', id: 'd1', updatedAt: 1 })).toBe('malformed');
  });

  it('rejects a payload over the per-record limit', () => {
    const payload = { sourceText: 'x'.repeat(MAX_RECORD_BYTES + 10) };
    expect(validateRecord({ store: 'docText', id: 'd1', updatedAt: 1, payload })).toBe(
      'record-too-large',
    );
  });
});

/* ------------------------------------------------------------- byte accounting */

describe('byte accounting', () => {
  it('charges the stored JSON in UTF-8 and nothing for a tombstone', () => {
    expect(recordBytes({ store: 'settings', id: 'k', updatedAt: 1, payload: 1 })).toBe(1);
    // 'é' is two bytes in UTF-8, one UTF-16 code unit — measuring the string length would
    // under-charge every non-English text in the corpus.
    expect(recordBytes({ store: 'settings', id: 'k', updatedAt: 1, payload: 'é' })).toBe(4);
    expect(recordBytes({ store: 'docText', id: 'd', updatedAt: 1, deleted: true })).toBe(0);
  });

  it('never lets the accounted total go negative', () => {
    expect(applyUsageDelta(10, -100)).toBe(0);
    expect(applyUsageDelta(10, 5)).toBe(15);
  });

  it('checks the quota against the delta, so an unchanged re-push cannot trip it', () => {
    expect(wouldExceedQuota(MAX_ACCOUNT_BYTES, 0)).toBe(false);
    expect(wouldExceedQuota(MAX_ACCOUNT_BYTES, -10)).toBe(false);
    expect(wouldExceedQuota(MAX_ACCOUNT_BYTES, 1)).toBe(true);
  });
});

/* ------------------------------------------------------------------ executePull */

describe('executePull', () => {
  it('returns everything from a zero cursor', async () => {
    const db = makeDb();
    seedRow(db, 1, 'folders', 'f1', { name: 'Plays' });
    seedRow(db, 2, 'documents', 'd1', { title: 'Hamlet' });
    seedRow(db, 3, 'docText', 'd1', { sourceText: 'To be' });

    const page = await executePull(db.handle, authed(db), { sinceRev: 0 });

    expect(page.records.map((r) => r.id)).toEqual(['f1', 'd1', 'd1']);
    expect(page.rev).toBe(3);
    expect(page.more).toBe(false);
    expect(page.records[1]?.payload).toEqual({ title: 'Hamlet' });
  });

  it('never returns a cursor above the highest rev it actually included', async () => {
    const db = makeDb();
    for (let rev = 1; rev <= 5; rev++) seedRow(db, rev, 'documents', `d${rev}`, { n: rev });
    // The account is at rev 5, but a two-record page must not advance the cursor past rev 2.
    expect(db.user().rev).toBe(5);

    const page = await executePull(db.handle, authed(db), { sinceRev: 0, limit: 2 });

    expect(page.rev).toBe(2);
    expect(Math.max(...page.records.map((r) => r.rev ?? 0))).toBe(page.rev);
  });

  it('pages a filled page with more: true and continues without gaps or repeats', async () => {
    const db = makeDb();
    for (let rev = 1; rev <= 5; rev++) seedRow(db, rev, 'documents', `d${rev}`, { n: rev });

    const seen: string[] = [];
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = await executePull(db.handle, authed(db), { sinceRev: cursor, limit: 2 });
      pages++;
      seen.push(...page.records.map((r) => r.id));
      cursor = page.rev;
      if (!page.more) break;
      if (pages > 10) throw new Error('pull did not terminate');
    }

    expect(seen).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
    expect(new Set(seen).size).toBe(seen.length);
    // 2 + 2 + 1: the third page is short, so it ends the loop.
    expect(pages).toBe(3);
  });

  it('leaves the cursor where it was when there is nothing new', async () => {
    const db = makeDb();
    seedRow(db, 1, 'documents', 'd1', { title: 'Hamlet' });

    const page = await executePull(db.handle, authed(db), { sinceRev: 1 });

    expect(page.records).toEqual([]);
    expect(page.rev).toBe(1);
    expect(page.more).toBe(false);
  });

  it('caps the page at the protocol maximum however large a limit is asked for', async () => {
    const db = makeDb();
    for (let rev = 1; rev <= 5; rev++) seedRow(db, rev, 'documents', `d${rev}`, { n: rev });

    const page = await executePull(db.handle, authed(db), { sinceRev: 0, limit: 10_000 });
    expect(page.records).toHaveLength(5);
    expect(page.more).toBe(false);
  });

  it('returns a tombstone with no payload at all', async () => {
    const db = makeDb();
    seedRow(db, 1, 'documents', 'd1', { title: 'Hamlet' });
    const row = db.rows[0];
    if (row === undefined) throw new Error('seed failed');
    row.deleted = 1;
    row.payload = null;

    const page = await executePull(db.handle, authed(db), { sinceRev: 0 });
    const record = page.records[0];

    expect(record?.deleted).toBe(true);
    expect(record !== undefined && 'payload' in record).toBe(false);
  });
});

/* ------------------------------------------------------------------ executePush */

function docRecord(id: string, updatedAt: number, payload: unknown = { title: id }): SyncRecord {
  return { store: 'documents', id, updatedAt, payload };
}

describe('executePush', () => {
  it('writes new records with consecutive revisions and accounts for their bytes', async () => {
    const db = makeDb();

    const res = await executePush(db.handle, authed(db), {
      deviceId: 'device-a',
      records: [docRecord('d1', 10), docRecord('d2', 20), docRecord('d3', 30)],
    });

    expect(res.applied).toBe(3);
    expect(res.rejected).toEqual([]);
    expect(res.rev).toBe(3);
    expect(db.rows.map((r) => r.rev).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(db.user().usage_bytes).toBe(db.rows.reduce((n, r) => n + r.bytes, 0));
    expect(res.usageBytes).toBe(db.user().usage_bytes);
    expect(res.quotaBytes).toBe(MAX_ACCOUNT_BYTES);
  });

  it('makes a docText re-push a complete no-op', async () => {
    const db = makeDb();
    seedRow(db, 1, 'docText', 'd1', { sourceText: 'To be' }, 40);
    const before = { rev: db.user().rev, usage: db.user().usage_bytes };

    const res = await executePush(db.handle, authed(db), {
      deviceId: 'device-b',
      records: [{ store: 'docText', id: 'd1', updatedAt: 9_999, payload: { sourceText: 'To be' } }],
    });

    expect(res.applied).toBe(0);
    expect(res.rejected).toEqual([]);
    expect(db.user().rev).toBe(before.rev);
    expect(db.user().usage_bytes).toBe(before.usage);
  });

  it('makes a rep re-push a no-op but applies an unseen rep', async () => {
    const db = makeDb();
    seedRow(db, 1, 'reps', 'rep-1', { peeks: 2 }, 12);

    const res = await executePush(db.handle, authed(db), {
      deviceId: 'device-b',
      records: [
        { store: 'reps', id: 'rep-1', updatedAt: 5_000, payload: { peeks: 99 } },
        { store: 'reps', id: 'rep-2', updatedAt: 5_000, payload: { peeks: 1 } },
      ],
    });

    expect(res.applied).toBe(1);
    expect(db.rows.find((r) => r.id === 'rep-1')?.payload).toBe(JSON.stringify({ peeks: 2 }));
    expect(db.rows.find((r) => r.id === 'rep-2')).toBeDefined();
  });

  it('reports a record the server already has newer as stale rather than dropping it', async () => {
    const db = makeDb();
    seedRow(db, 1, 'documents', 'd1', { title: 'Hamlet' });
    const row = db.rows[0];
    if (row === undefined) throw new Error('seed failed');
    row.updated_at = 5_000;

    const res = await executePush(db.handle, authed(db), {
      deviceId: 'device-b',
      records: [docRecord('d1', 1_000, { title: 'Stale title' })],
    });

    expect(res.applied).toBe(0);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]?.reason).toBe('stale');
    expect(res.rejected[0]?.store).toBe('documents');
    expect(res.rejected[0]?.id).toBe('d1');
    // The client has to be told to pull, so the message has to say so in words.
    expect(res.rejected[0]?.message).toMatch(/newer/i);
    expect(row.payload).toBe(JSON.stringify({ title: 'Hamlet' }));
  });

  it('rejects a record over 1 MB with a message a person can read', async () => {
    const db = makeDb();

    const res = await executePush(db.handle, authed(db), {
      deviceId: 'device-a',
      records: [
        { store: 'docText', id: 'd1', updatedAt: 1, payload: 'x'.repeat(MAX_RECORD_BYTES + 10) },
      ],
    });

    expect(res.applied).toBe(0);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]?.reason).toBe('record-too-large');
    expect(res.rejected[0]?.message).toMatch(/MB/);
    expect(res.rejected[0]?.message).toMatch(/limit/i);
    expect(db.rows).toEqual([]);
    expect(db.user().usage_bytes).toBe(0);
  });

  it('rejects a record that would exceed the account quota without corrupting usage_bytes', async () => {
    const headroom = 100;
    const db = makeDb(MAX_ACCOUNT_BYTES - headroom);
    const before = db.user().usage_bytes;

    const res = await executePush(db.handle, authed(db), {
      deviceId: 'device-a',
      records: [
        // 502 bytes of JSON: more headroom than is left.
        docRecord('big', 10, 'x'.repeat(500)),
        // One byte: still fits, and must not be collateral damage.
        docRecord('small', 20, 1),
      ],
    });

    expect(res.applied).toBe(1);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0]?.reason).toBe('quota-exceeded');
    expect(res.rejected[0]?.id).toBe('big');
    expect(res.rejected[0]?.message).toMatch(/MB/);

    expect(db.rows.map((r) => r.id)).toEqual(['small']);
    expect(db.user().usage_bytes).toBe(before + 1);
    expect(res.usageBytes).toBe(before + 1);
  });

  it('frees the accounted bytes for a tombstone but keeps the row so the delete replicates', async () => {
    const db = makeDb();
    seedRow(db, 1, 'documents', 'd1', { title: 'Hamlet' }, 500);
    expect(db.user().usage_bytes).toBe(500);

    const res = await executePush(db.handle, authed(db), {
      deviceId: 'device-b',
      records: [{ store: 'documents', id: 'd1', updatedAt: 9_999, deleted: true }],
    });

    expect(res.applied).toBe(1);
    const row = db.rows[0];
    expect(db.rows).toHaveLength(1);
    expect(row?.deleted).toBe(1);
    expect(row?.payload).toBeNull();
    expect(row?.bytes).toBe(0);
    expect(db.user().usage_bytes).toBe(0);
    expect(res.usageBytes).toBe(0);
  });

  it('assigns distinct revisions to two devices pushing at once', async () => {
    const db = makeDb();
    // Both devices read the account at the same moment, which is exactly the race: a
    // read-then-write allocation would hand them overlapping revisions.
    const deviceA = authed(db);
    const deviceB = authed(db);

    const [resA, resB] = await Promise.all([
      executePush(db.handle, deviceA, {
        deviceId: 'device-a',
        records: [docRecord('a1', 10), docRecord('a2', 20), docRecord('a3', 30)],
      }),
      executePush(db.handle, deviceB, {
        deviceId: 'device-b',
        records: [docRecord('b1', 10), docRecord('b2', 20), docRecord('b3', 30)],
      }),
    ]);

    expect(resA.applied).toBe(3);
    expect(resB.applied).toBe(3);
    expect(resA.rev).not.toBe(resB.rev);

    const revs = db.rows.map((r) => r.rev);
    expect(revs).toHaveLength(6);
    expect(new Set(revs).size).toBe(6);
    expect([...revs].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(db.user().rev).toBe(6);
    // Both deltas landed, because the usage update is relative rather than absolute.
    expect(db.user().usage_bytes).toBe(db.rows.reduce((n, r) => n + r.bytes, 0));
  });

  it('rejects a malformed record without abandoning the good ones beside it', async () => {
    const db = makeDb();

    const res = await executePush(db.handle, authed(db), {
      deviceId: 'device-a',
      records: [
        { store: 'derived', id: 'd1', updatedAt: 1, payload: {} } as unknown as SyncRecord,
        docRecord('d2', 20),
      ],
    });

    expect(res.applied).toBe(1);
    expect(res.rejected.map((r) => r.reason)).toEqual(['unknown-store']);
    expect(db.rows.map((r) => r.id)).toEqual(['d2']);
  });

  it('treats a duplicate id inside one push as a re-push of what it just wrote', async () => {
    const db = makeDb();

    const res = await executePush(db.handle, authed(db), {
      deviceId: 'device-a',
      records: [docRecord('d1', 20, { title: 'Later' }), docRecord('d1', 10, { title: 'Earlier' })],
    });

    expect(res.applied).toBe(1);
    expect(res.rejected.map((r) => r.reason)).toEqual(['stale']);
    expect(db.rows[0]?.payload).toBe(JSON.stringify({ title: 'Later' }));
  });
});
