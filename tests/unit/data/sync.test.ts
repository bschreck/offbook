import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_NAME } from '../../../src/brand';
import type {
  PullRequest,
  PullResponse,
  PushRequest,
  PushResponse,
  SyncRecord,
} from '../../../src/shared/sync/protocol';

/**
 * The api module is stubbed, never the database: the point of these tests is what lands in
 * IndexedDB and what the cursor does when the network misbehaves (ADR-0008).
 */
vi.mock('../../../src/data/sync/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/data/sync/api')>();
  return {
    ...actual,
    api: {
      register: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      me: vi.fn(),
      pull: vi.fn(),
      push: vi.fn(),
    },
  };
});

import { getDb, resetDbForTests } from '../../../src/data/db';
import type { DocTextRecord, DocumentRecord, MetaKey, RepRecord } from '../../../src/data/schema';
import { ApiFailure, api } from '../../../src/data/sync/api';
import {
  markDirty,
  readSyncState,
  resetSyncEngineForTests,
  syncNow,
} from '../../../src/data/sync/engine';
import { applyPulled } from '../../../src/data/sync/records';

const pull = vi.mocked(api.pull);
const push = vi.mocked(api.push);

function sentIn(call: number): SyncRecord[] {
  const req = push.mock.calls[call]?.[0] as PushRequest | undefined;
  if (!req) throw new Error(`expected a push call at index ${call}`);
  return req.records;
}

function pullPage(records: SyncRecord[], rev: number, more = false): PullResponse {
  return { rev, records, more };
}

function pushOk(rev = 1): PushResponse {
  return { rev, applied: 0, rejected: [], usageBytes: 0, quotaBytes: 50 * 1024 * 1024 };
}

function doc(id: string, over: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id,
    folderId: null,
    title: `Doc ${id}`,
    sortTitle: `doc ${id}`,
    kind: 'speech',
    lang: 'en',
    textHash: `hash-${id}`,
    pipelineVersion: 1,
    wordCount: 3,
    charCount: 11,
    chunkCount: 1,
    roles: [],
    myRoleIds: [],
    roleSetHash: 'all',
    roleView: 'full',
    cueStyle: 'tail',
    cueTailWords: 3,
    cleanupConfig: {
      normalise: true,
      punctuation: true,
      whitespace: true,
      dropArtifacts: true,
      unwrap: false,
    },
    manualText: null,
    structureOverrides: [],
    prefs: {
      methodId: 'hideWords',
      ladderIndex: 0,
      customPercent: null,
      methodParams: {},
      reshuffle: 0,
      chunkStrategy: 'auto',
      chunkTargetWords: 60,
      manualChunkBreaks: [],
    },
    cursor: null,
    lastRunPeeks100: null,
    source: { type: 'paste', importedAt: 1000 },
    lastPracticedAt: null,
    createdAt: 1000,
    updatedAt: 1000,
    deletedAt: null,
    sv: 1,
    ...over,
  };
}

function docText(docId: string, sourceText: string): DocTextRecord {
  return { docId, sourceText, textHash: `hash-${docId}`, sv: 1 };
}

function rep(id: string, docId: string, at: number): RepRecord {
  return {
    id,
    docId,
    roleSetHash: 'all',
    chunkKey: 'c1',
    at,
    methodId: 'hideWords',
    ladderIndex: 0,
    customPercent: null,
    maskedCount: 2,
    candidateCount: 10,
    peeks: 0,
    reveals: 0,
    durationMs: 5000,
    sv: 1,
  };
}

function docRecord(row: DocumentRecord): SyncRecord {
  return { store: 'documents', id: row.id, rev: 1, updatedAt: row.updatedAt, payload: row };
}

function textRecord(row: DocTextRecord, rev = 2): SyncRecord {
  return { store: 'docText', id: row.docId, rev, updatedAt: 1000, payload: row };
}

beforeEach(() => {
  // A brand new fake IndexedDB per test; the memoised connection has to go with it.
  globalThis.indexedDB = new IDBFactory() as unknown as typeof globalThis.indexedDB;
  resetDbForTests();
  resetSyncEngineForTests();
  pull.mockReset();
  push.mockReset();
  push.mockResolvedValue(pushOk());
});

afterEach(() => {
  resetSyncEngineForTests();
});

describe('a first sync', () => {
  it('pulls from rev 0 and writes documents and docText into IndexedDB', async () => {
    const d = doc('d1');
    const t = docText('d1', 'To be, or not to be.');
    pull.mockResolvedValueOnce(pullPage([docRecord(d), textRecord(t)], 7));

    const outcome = await syncNow('manual');

    expect(pull).toHaveBeenCalledTimes(1);
    expect(pull.mock.calls[0]?.[0]).toMatchObject({ sinceRev: 0 } satisfies Partial<PullRequest>);
    expect(outcome.status).toBe('ok');
    expect(outcome.pulled).toBe(2);
    expect(outcome.changedLocally).toBe(true);

    const db = await getDb();
    expect((await db.get('documents', 'd1'))?.title).toBe('Doc d1');
    expect((await db.get('docText', 'd1'))?.sourceText).toBe('To be, or not to be.');
    expect((await readSyncState()).lastSyncedRev).toBe(7);
  });

  it('uses the same database name the app uses, so nothing is written to a second db', async () => {
    pull.mockResolvedValueOnce(pullPage([], 0));
    await syncNow('manual');
    const db = await getDb();
    expect(db.name).toBe(DB_NAME);
  });
});

describe('applyPulled', () => {
  it('invalidates the derived cache for a document whose row changed', async () => {
    const db = await getDb();
    await db.put('documents', doc('d1'));
    await db.put('derived', {
      docId: 'd1',
      pipelineVersion: 1,
      textHash: 'hash-d1',
      doc: { stale: true },
      builtAt: 500,
      sv: 1,
    });

    const result = await applyPulled([docRecord(doc('d1', { title: 'Renamed', updatedAt: 2000 }))]);

    expect(result.written).toBe(1);
    expect(result.invalidatedDocIds).toEqual(['d1']);
    expect(await db.get('derived', 'd1')).toBeUndefined();
    expect((await db.get('documents', 'd1'))?.title).toBe('Renamed');
  });

  it('invalidates the derived cache when new docText arrives', async () => {
    const db = await getDb();
    await db.put('derived', {
      docId: 'd2',
      pipelineVersion: 1,
      textHash: 'hash-d2',
      doc: { stale: true },
      builtAt: 500,
      sv: 1,
    });

    await applyPulled([textRecord(docText('d2', 'Friends, Romans, countrymen'))]);

    expect(await db.get('derived', 'd2')).toBeUndefined();
    expect((await db.get('docText', 'd2'))?.sourceText).toBe('Friends, Romans, countrymen');
  });

  it('keeps local docText: it is immutable, so an arriving copy is a no-op', async () => {
    const db = await getDb();
    await db.put('docText', docText('d3', 'the original bytes'));

    const result = await applyPulled([textRecord(docText('d3', 'something else'))]);

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect((await db.get('docText', 'd3'))?.sourceText).toBe('the original bytes');
  });

  it('keeps the newer local document and applies the newer remote one', async () => {
    const db = await getDb();
    await db.put('documents', doc('d4', { title: 'Local', updatedAt: 5000 }));

    await applyPulled([docRecord(doc('d4', { title: 'Older remote', updatedAt: 4000 }))]);
    expect((await db.get('documents', 'd4'))?.title).toBe('Local');

    await applyPulled([docRecord(doc('d4', { title: 'Newer remote', updatedAt: 6000 }))]);
    expect((await db.get('documents', 'd4'))?.title).toBe('Newer remote');
  });

  it('applies a tombstone as a soft delete, keeping the row for undo', async () => {
    const db = await getDb();
    await db.put('documents', doc('d5'));

    await applyPulled([{ store: 'documents', id: 'd5', updatedAt: 9000, deleted: true }]);

    const row = await db.get('documents', 'd5');
    expect(row?.deletedAt).toBe(9000);
    expect(row?.title).toBe('Doc d5');
  });

  it('drops a malformed payload rather than writing it', async () => {
    const db = await getDb();
    const result = await applyPulled([
      { store: 'documents', id: 'bad', updatedAt: 1, payload: { nope: true } },
      { store: 'nonsense' as 'documents', id: 'x', updatedAt: 1, payload: {} },
    ]);
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(2);
    expect(await db.get('documents', 'bad')).toBeUndefined();
  });

  it('does not clobber a locally changed setting that has not been pushed yet', async () => {
    const db = await getDb();
    await db.put('settings', { key: 'reader.fontPx', value: 30 });

    await applyPulled(
      [{ store: 'settings', id: 'reader.fontPx', updatedAt: 9999, payload: { value: 18 } }],
      new Set(['settings:reader.fontPx']),
    );
    expect((await db.get('settings', 'reader.fontPx'))?.value).toBe(30);

    await applyPulled([
      { store: 'settings', id: 'reader.fontPx', updatedAt: 9999, payload: { value: 18 } },
    ]);
    expect((await db.get('settings', 'reader.fontPx'))?.value).toBe(18);
  });
});

describe('a multi-page pull', () => {
  it('resumes from the committed cursor after an interruption and loses nothing', async () => {
    const page1 = [docRecord(doc('p1')), textRecord(docText('p1', 'page one text'))];
    const page2 = [docRecord(doc('p2')), textRecord(docText('p2', 'page two text'))];

    pull
      .mockResolvedValueOnce(pullPage(page1, 10, true))
      .mockRejectedValueOnce(new ApiFailure(0, 'offline', 'No connection.'));

    const first = await syncNow('manual');
    expect(first.status).toBe('offline');
    expect(first.quiet).toBe(true);
    // Page one committed, so its cursor stands.
    expect((await readSyncState()).lastSyncedRev).toBe(10);

    const db = await getDb();
    expect(await db.get('documents', 'p1')).toBeDefined();
    expect(await db.get('documents', 'p2')).toBeUndefined();

    pull.mockReset();
    pull.mockResolvedValueOnce(pullPage(page2, 20, false));
    resetSyncEngineForTests();

    const second = await syncNow('manual');
    expect(second.status).toBe('ok');
    expect(pull.mock.calls[0]?.[0].sinceRev).toBe(10);
    expect((await readSyncState()).lastSyncedRev).toBe(20);
    expect((await db.get('docText', 'p1'))?.sourceText).toBe('page one text');
    expect((await db.get('docText', 'p2'))?.sourceText).toBe('page two text');
  });

  it('loops while the server says more', async () => {
    pull
      .mockResolvedValueOnce(pullPage([docRecord(doc('m1'))], 1, true))
      .mockResolvedValueOnce(pullPage([docRecord(doc('m2'))], 2, true))
      .mockResolvedValueOnce(pullPage([docRecord(doc('m3'))], 3, false));

    const out = await syncNow('manual');

    expect(pull).toHaveBeenCalledTimes(3);
    expect(out.pulled).toBe(3);
    expect((await readSyncState()).lastSyncedRev).toBe(3);
  });

  it('stops rather than spinning when the server says more without advancing', async () => {
    pull.mockResolvedValue(pullPage([], 0, true));
    const out = await syncNow('manual');
    expect(pull).toHaveBeenCalledTimes(1);
    expect(out.status).toBe('ok');
  });
});

describe('single flight', () => {
  it('coalesces two concurrent calls into one round of requests', async () => {
    const db = await getDb();
    await db.put('documents', doc('s0'));

    let release: (v: PullResponse) => void = () => {};
    const held = new Promise<PullResponse>((resolve) => {
      release = resolve;
    });
    pull.mockImplementationOnce(() => held);

    const a = syncNow('manual');
    const b = syncNow('visible');
    // Let the round get as far as the pull before answering it.
    await Promise.resolve();
    release(pullPage([docRecord(doc('s1'))], 4));

    const [ra, rb] = await Promise.all([a, b]);

    expect(pull).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(ra).toBe(rb);
    expect(ra.reason).toBe('manual');
  });

  it('starts a fresh round once the previous one has settled', async () => {
    pull.mockResolvedValue(pullPage([], 0));
    await syncNow('manual');
    await syncNow('manual');
    expect(pull).toHaveBeenCalledTimes(2);
  });
});

describe('failures are survivable', () => {
  it('leaves the cursor untouched when offline and reports quietly', async () => {
    const db = await getDb();
    await db.put('meta', { key: 'sync.lastSyncedRev' as MetaKey, value: 42 });
    pull.mockRejectedValue(new ApiFailure(0, 'offline', 'No connection, so nothing was synced.'));

    const out = await syncNow('online');

    expect(out.ok).toBe(false);
    expect(out.status).toBe('offline');
    expect(out.quiet).toBe(true);
    expect(out.message).toContain('No connection');
    expect((await readSyncState()).lastSyncedRev).toBe(42);
    expect(push).not.toHaveBeenCalled();
  });

  it('treats a 401 as signed out, quietly', async () => {
    pull.mockRejectedValue(new ApiFailure(401, 'unauthorized', 'Sign in again to keep syncing.'));
    const out = await syncNow('startup');
    expect(out.status).toBe('signed-out');
    expect(out.quiet).toBe(true);
  });

  it('reports a real server error without throwing', async () => {
    pull.mockRejectedValue(new ApiFailure(500, 'server', 'Something went wrong on the server.'));
    const out = await syncNow('manual');
    expect(out.status).toBe('error');
    expect(out.quiet).toBe(false);
  });

  it('surfaces push rejections so a quota can be explained', async () => {
    const db = await getDb();
    await db.put('documents', doc('q1'));
    pull.mockResolvedValue(pullPage([], 0));
    push.mockResolvedValue({
      rev: 3,
      applied: 0,
      rejected: [
        {
          store: 'documents',
          id: 'q1',
          reason: 'quota-exceeded',
          message: 'Your account is full.',
        },
      ],
      usageBytes: 51 * 1024 * 1024,
      quotaBytes: 50 * 1024 * 1024,
    });

    const out = await syncNow('manual');

    expect(out.status).toBe('ok');
    expect(out.rejected[0]?.reason).toBe('quota-exceeded');
    expect(out.usageBytes).toBe(51 * 1024 * 1024);
  });
});

describe('pushing local changes', () => {
  it('offers the whole library on a first sync, with the right ids per store', async () => {
    const db = await getDb();
    await db.put('documents', doc('d1'));
    await db.put('docText', docText('d1', 'some text'));
    await db.put('folders', {
      id: 'fld_1',
      name: 'Auditions',
      sortName: 'auditions',
      order: 0,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      sv: 1,
    });
    await db.put('settings', { key: 'reader.fontPx', value: 26 });
    pull.mockResolvedValue(pullPage([], 0));

    await syncNow('sign-in');

    const sent = sentIn(0);
    const byStore = (store: string) => sent.filter((r) => r.store === store);
    expect(byStore('documents').map((r) => r.id)).toEqual(['d1']);
    expect(byStore('docText').map((r) => r.id)).toEqual(['d1']);
    expect(byStore('folders').map((r) => r.id)).toEqual(['fld_1']);
    expect(byStore('settings').map((r) => r.id)).toEqual(['reader.fontPx']);
  });

  it('does not push the same rows again once they are settled', async () => {
    const db = await getDb();
    await db.put('documents', doc('d1'));
    pull.mockResolvedValue(pullPage([], 0));

    await syncNow('manual');
    expect(sentIn(0).length).toBeGreaterThan(0);

    resetSyncEngineForTests();
    await syncNow('manual');
    // Nothing pending, so the round does not touch the network at all.
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('pushes a change marked while offline after a restart', async () => {
    const db = await getDb();
    await db.put('documents', doc('d1'));
    pull.mockResolvedValue(pullPage([], 0));
    await syncNow('manual');

    await db.put('settings', { key: 'ui.theme', value: 'dark' });
    await markDirty('settings', 'ui.theme');

    // A restart: module state gone, the pending set still in `meta`.
    resetSyncEngineForTests();
    resetDbForTests();

    await syncNow('startup');
    expect(sentIn(1).map((r) => `${r.store}:${r.id}`)).toEqual(['settings:ui.theme']);
    expect((await readSyncState()).pendingKeys).toEqual([]);
  });

  it('does not echo a record straight back in the round that pulled it', async () => {
    pull.mockResolvedValueOnce(pullPage([docRecord(doc('e1', { updatedAt: Date.now() }))], 5));
    const out = await syncNow('manual');
    expect(out.changedLocally).toBe(true);
    expect(push).not.toHaveBeenCalled();
  });

  it('sends a device id with every push', async () => {
    const db = await getDb();
    await db.put('documents', doc('d1'));
    pull.mockResolvedValue(pullPage([], 0));
    await syncNow('manual');
    const req = push.mock.calls[0]?.[0] as PushRequest;
    expect(req.deviceId).toMatch(/[0-9a-f-]{8,}/);
    expect(req.deviceId).toBe((await readSyncState()).deviceId);
  });
});

describe('reps merge by union', () => {
  it('does not duplicate a rep held on both sides, and each side gets the other', async () => {
    const db = await getDb();
    const local = rep('rep-local', 'd1', 1000);
    const shared = rep('rep-shared', 'd1', 1100);
    await db.put('reps', local);
    await db.put('reps', shared);

    const remote = rep('rep-remote', 'd1', 1200);
    pull.mockResolvedValueOnce(
      pullPage(
        [
          { store: 'reps', id: shared.id, rev: 1, updatedAt: shared.at, payload: shared },
          { store: 'reps', id: remote.id, rev: 2, updatedAt: remote.at, payload: remote },
        ],
        9,
      ),
    );

    const out = await syncNow('manual');

    const ids = (await db.getAll('reps')).map((r) => r.id).sort();
    expect(ids).toEqual(['rep-local', 'rep-remote', 'rep-shared']);
    expect(await db.count('reps')).toBe(3);
    // The one we already had was recognised, not rewritten.
    expect(out.pulled).toBe(2);

    // The rep only we have goes up; the one that just arrived is not echoed back.
    const sent = sentIn(0).filter((r) => r.store === 'reps');
    expect(sent.map((r) => r.id)).toEqual(['rep-local']);
  });
});
