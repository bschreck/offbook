import type { Document } from '../../core/text/types';
import { getDb } from '../db';
import type { DerivedRecord } from '../schema';

/**
 * Cache of the derived Document. It is a CACHE, never a source of truth: a stale or missing
 * entry costs a re-derivation, and a `pipelineVersion` bump invalidates every entry on read
 * rather than needing an IDB upgrade transaction on a phone we cannot debug.
 */

export async function readDerived(
  docId: string,
  pipelineVersion: number,
  textHash: string,
): Promise<Document | null> {
  const db = await getDb();
  const rec = await db.get('derived', docId);
  if (!rec) return null;
  if (rec.pipelineVersion !== pipelineVersion || rec.textHash !== textHash) return null;
  return rec.doc as Document;
}

export async function writeDerived(
  docId: string,
  pipelineVersion: number,
  textHash: string,
  doc: Document,
  now: number,
): Promise<void> {
  const db = await getDb();
  await db.put('derived', {
    docId,
    pipelineVersion,
    textHash,
    doc,
    builtAt: now,
    sv: 1,
  } satisfies DerivedRecord);
}

export async function invalidateDerived(docId: string): Promise<void> {
  const db = await getDb();
  await db.delete('derived', docId);
}
