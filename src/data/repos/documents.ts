import { fnv1a } from '../../core/util/hash';
import { newId } from '../../core/util/id';
import { publishWrite } from '../broadcast';
import { getDb } from '../db';
import type { DocTextRecord, DocumentRecord, RepRecord } from '../schema';
import { armEvictionTripwire } from '../storageInfo';

const LEADING_ARTICLE = /^(the|a|an)\s+/i;

export function sortTitleFor(title: string): string {
  return title.trim().toLowerCase().replace(LEADING_ARTICLE, '');
}

export function roleSetHashFor(myRoleIds: string[]): string {
  if (myRoleIds.length === 0) return 'all';
  return fnv1a([...myRoleIds].sort().join('|'));
}

export async function listDocuments(): Promise<DocumentRecord[]> {
  const db = await getDb();
  const all = await db.getAll('documents');
  return all.filter((d) => d.deletedAt === null);
}

export async function getDocument(id: string): Promise<DocumentRecord | undefined> {
  const db = await getDb();
  return db.get('documents', id);
}

export async function getDocText(docId: string): Promise<DocTextRecord | undefined> {
  const db = await getDb();
  return db.get('docText', docId);
}

/**
 * Create a document and its immutable source text in ONE transaction. A document row without
 * its text is unrecoverable garbage, so the two must never be written separately.
 */
export async function createDocument(
  doc: Omit<DocumentRecord, 'id' | 'sv'> & { id?: string },
  sourceText: string,
): Promise<DocumentRecord> {
  const db = await getDb();
  const id = doc.id ?? newId();
  const textHash = fnv1a(sourceText);
  const record: DocumentRecord = { ...doc, id, textHash, sv: 1 };

  const tx = db.transaction(['documents', 'docText'], 'readwrite');
  await tx.objectStore('documents').put(record);
  await tx
    .objectStore('docText')
    .put({ docId: id, sourceText, textHash, sv: 1 } satisfies DocTextRecord);
  await tx.done;

  armEvictionTripwire();
  publishWrite('documents', id);
  return record;
}

export async function updateDocument(
  id: string,
  patch: Partial<DocumentRecord>,
  now: number,
): Promise<DocumentRecord | undefined> {
  const db = await getDb();
  const existing = await db.get('documents', id);
  if (!existing) return undefined;
  const next: DocumentRecord = { ...existing, ...patch, id, updatedAt: now };
  await db.put('documents', next);
  publishWrite('documents', id);
  return next;
}

/** Soft delete, so the snackbar's undo is a field flip rather than a restore. */
export async function softDeleteDocument(id: string, now: number): Promise<void> {
  await updateDocument(id, { deletedAt: now }, now);
}

export async function restoreDocument(id: string, now: number): Promise<void> {
  await updateDocument(id, { deletedAt: null }, now);
}

/** Permanent, and it takes the text, the derived cache and the practice log with it. */
export async function purgeDocument(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['documents', 'docText', 'derived', 'reps'], 'readwrite');
  await tx.objectStore('documents').delete(id);
  await tx.objectStore('docText').delete(id);
  await tx.objectStore('derived').delete(id);
  let cursor = await tx.objectStore('reps').index('by-doc-at').openCursor();
  while (cursor) {
    if (cursor.value.docId === id) await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
  publishWrite('documents', id);
}

/**
 * Append-only practice log. Nothing in v1 reads these for display (PLAN.md §0.0 A4).
 * ADR-0006: reps are the truth, everything else is a materialized view.
 */
export async function appendRep(rep: Omit<RepRecord, 'id' | 'sv'>): Promise<void> {
  const db = await getDb();
  await db.put('reps', { ...rep, id: newId(), sv: 1 });
}

export async function countReps(): Promise<number> {
  const db = await getDb();
  return db.count('reps');
}
