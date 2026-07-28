import { describe, expect, it } from 'vitest';
import { buildBackup } from '../../../src/core/backup/export';
import {
  type ExistingLibrary,
  findOrphanedDocuments,
  planRestore,
} from '../../../src/core/backup/import';
import { META, makeDocText, makeDocument, makeFolder, makeInput, makeRep } from './fixtures';

const EMPTY: ExistingLibrary = {
  folders: [],
  documents: [],
  docTexts: [],
  repIds: [],
  settings: {},
};

function keysOf(entries: ReadonlyArray<{ store: string; key: string }>, store: string): string[] {
  return entries.filter((e) => e.store === store).map((e) => e.key);
}

describe('planRestore', () => {
  it('creates everything when the library is empty', () => {
    const backup = buildBackup(makeInput(), META);
    const plan = planRestore(backup, EMPTY);

    expect(plan.conflicts).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.toSkip).toEqual([]);
    expect(keysOf(plan.toCreate, 'folders')).toEqual(['fold-1']);
    expect(keysOf(plan.toCreate, 'documents')).toEqual(['doc-1']);
    expect(keysOf(plan.toCreate, 'docTexts')).toEqual(['doc-1']);
    expect(keysOf(plan.toCreate, 'reps')).toEqual(['rep-1', 'rep-2']);
    expect(keysOf(plan.toCreate, 'settings')).toHaveLength(4);
    expect(plan.summary.create).toBe(9);
  });

  it('restoring the same backup twice is a no-op (§6.1 rule 4)', () => {
    const input = makeInput();
    const backup = buildBackup(input, META);
    const existing: ExistingLibrary = {
      folders: input.folders,
      documents: input.documents,
      docTexts: input.docTexts,
      repIds: input.reps.map((r) => r.id),
      settings: input.settings,
    };
    const plan = planRestore(backup, existing);

    expect(plan.toCreate).toEqual([]);
    expect(plan.toUpdate).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.summary.skip).toBe(9);
  });

  it('updates a folder the backup saw more recently, skips one it saw earlier', () => {
    const backup = buildBackup(
      makeInput({
        folders: [
          makeFolder({ id: 'fresh', updatedAt: 200 }),
          makeFolder({ id: 'stale', updatedAt: 100 }),
        ],
      }),
      META,
    );
    const plan = planRestore(backup, {
      ...EMPTY,
      folders: [
        { id: 'fresh', updatedAt: 150 },
        { id: 'stale', updatedAt: 150 },
      ],
    });

    expect(keysOf(plan.toUpdate, 'folders')).toEqual(['fresh']);
    expect(plan.toSkip).toContainEqual({ store: 'folders', key: 'stale', reason: 'not-newer' });
  });

  it('updates document metadata when the text is unchanged and the record is newer', () => {
    const backup = buildBackup(
      makeInput({ documents: [makeDocument({ title: 'Hamlet (cut)', updatedAt: 9_000 })] }),
      META,
    );
    const plan = planRestore(backup, {
      ...EMPTY,
      documents: [{ id: 'doc-1', updatedAt: 8_000, textHash: 'aabbccdd' }],
      docTexts: [{ docId: 'doc-1', textHash: 'aabbccdd' }],
    });

    expect(keysOf(plan.toUpdate, 'documents')).toEqual(['doc-1']);
    expect(plan.toSkip).toContainEqual({ store: 'docTexts', key: 'doc-1', reason: 'identical' });
    expect(plan.conflicts).toEqual([]);
  });

  it('skips a document with the same id, same hash and no newer timestamp', () => {
    const backup = buildBackup(makeInput(), META);
    const doc = makeDocument();
    const plan = planRestore(backup, {
      ...EMPTY,
      documents: [{ id: doc.id, updatedAt: doc.updatedAt, textHash: doc.textHash }],
    });
    expect(plan.toSkip).toContainEqual({ store: 'documents', key: 'doc-1', reason: 'identical' });
    expect(keysOf(plan.toUpdate, 'documents')).toEqual([]);
  });

  it('conflicts on the same id with a different textHash, however new the incoming record', () => {
    const incoming = makeDocument({ textHash: '99999999', updatedAt: 9_999_999 });
    const backup = buildBackup(
      makeInput({
        documents: [incoming],
        docTexts: [makeDocText({ textHash: '99999999', sourceText: 'A different cut.' })],
      }),
      META,
    );
    const plan = planRestore(backup, {
      ...EMPTY,
      documents: [{ id: 'doc-1', updatedAt: 1, textHash: 'aabbccdd' }],
      docTexts: [{ docId: 'doc-1', textHash: 'aabbccdd' }],
    });

    expect(plan.conflicts).toHaveLength(2);
    expect(plan.conflicts[0]).toEqual({
      store: 'documents',
      key: 'doc-1',
      reason: 'text-differs',
      incoming,
      existing: { textHash: 'aabbccdd', updatedAt: 1 },
    });
    expect(plan.conflicts[1]?.store).toBe('docTexts');
    // A conflicted record never also appears as work to apply.
    expect(keysOf(plan.toCreate, 'documents')).toEqual([]);
    expect(keysOf(plan.toUpdate, 'documents')).toEqual([]);
    expect(keysOf(plan.toCreate, 'docTexts')).toEqual([]);
  });

  it('unions reps by id and never updates one', () => {
    const backup = buildBackup(
      makeInput({ reps: [makeRep({ id: 'old' }), makeRep({ id: 'new' })] }),
      META,
    );
    const plan = planRestore(backup, { ...EMPTY, repIds: ['old'] });

    expect(keysOf(plan.toCreate, 'reps')).toEqual(['new']);
    expect(plan.toSkip).toContainEqual({ store: 'reps', key: 'old', reason: 'already-present' });
    expect(keysOf(plan.toUpdate, 'reps')).toEqual([]);
  });

  it('classifies settings key by key', () => {
    const backup = buildBackup(
      makeInput({ settings: { 'ui.theme': 'dark', 'reader.fontPx': 28 } }),
      META,
    );
    const plan = planRestore(backup, {
      ...EMPTY,
      settings: { 'ui.theme': 'dark', 'reader.fontPx': 22 },
    });

    expect(plan.toSkip).toContainEqual({ store: 'settings', key: 'ui.theme', reason: 'identical' });
    expect(plan.toUpdate).toContainEqual({
      store: 'settings',
      key: 'reader.fontPx',
      value: 28,
    });
  });

  it('docsOnly leaves the sender history and settings behind (§11.8 sharing default)', () => {
    const backup = buildBackup(makeInput(), META);
    const plan = planRestore(backup, EMPTY, { mode: 'docsOnly' });

    expect(keysOf(plan.toCreate, 'reps')).toEqual([]);
    expect(keysOf(plan.toCreate, 'settings')).toEqual([]);
    expect(keysOf(plan.toCreate, 'documents')).toEqual(['doc-1']);
    expect(plan.toSkip.every((s) => s.store === 'reps' || s.store === 'settings')).toBe(true);
    expect(plan.toSkip.every((s) => s.reason === 'excluded-by-mode')).toBe(true);
  });

  it('counts per store for the confirmation dialogue', () => {
    const backup = buildBackup(makeInput(), META);
    const plan = planRestore(backup, { ...EMPTY, repIds: ['rep-1'] });
    expect(plan.summary.byStore.reps).toEqual({ create: 1, update: 0, skip: 1 });
    expect(plan.summary.byStore.documents).toEqual({ create: 1, update: 0, skip: 0 });
  });

  it('reports a document whose text is in neither the file nor the library', () => {
    const backup = buildBackup(
      makeInput({ documents: [makeDocument(), makeDocument({ id: 'doc-2' })] }),
      META,
    );
    expect(findOrphanedDocuments(backup, EMPTY)).toEqual(['doc-2']);
    expect(
      findOrphanedDocuments(backup, { ...EMPTY, docTexts: [{ docId: 'doc-2', textHash: 'x' }] }),
    ).toEqual([]);
  });
});
