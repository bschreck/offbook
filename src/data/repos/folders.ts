import { shortId } from '../../core/util/id';
import { publishWrite } from '../broadcast';
import { getDb } from '../db';
import type { FolderRecord } from '../schema';

/** Flat, one level. There is no parentId, by decision (PLAN.md §3.4 #13). */

export function sortNameFor(name: string): string {
  return name.trim().toLowerCase();
}

export async function listFolders(): Promise<FolderRecord[]> {
  const db = await getDb();
  const all = await db.getAll('folders');
  return all
    .filter((f) => f.deletedAt === null)
    .sort((a, b) => a.order - b.order || a.sortName.localeCompare(b.sortName));
}

export async function createFolder(name: string, now: number): Promise<FolderRecord> {
  const db = await getDb();
  const existing = await db.getAll('folders');
  const rec: FolderRecord = {
    id: shortId('fld'),
    name: name.trim(),
    sortName: sortNameFor(name),
    order: existing.length,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    sv: 1,
  };
  await db.put('folders', rec);
  publishWrite('folders', rec.id);
  return rec;
}

export async function renameFolder(id: string, name: string, now: number): Promise<void> {
  const db = await getDb();
  const rec = await db.get('folders', id);
  if (!rec) return;
  await db.put('folders', {
    ...rec,
    name: name.trim(),
    sortName: sortNameFor(name),
    updatedAt: now,
  });
  publishWrite('folders', id);
}

/**
 * Soft delete. Documents in the folder are moved to "no folder" rather than deleted —
 * deleting a container must never delete its contents.
 */
export async function deleteFolder(id: string, now: number): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['folders', 'documents'], 'readwrite');
  const rec = await tx.objectStore('folders').get(id);
  if (rec) {
    await tx.objectStore('folders').put({ ...rec, deletedAt: now, updatedAt: now });
  }
  const docs = await tx.objectStore('documents').index('by-folder').getAll(id);
  for (const doc of docs) {
    await tx.objectStore('documents').put({ ...doc, folderId: null, updatedAt: now });
  }
  await tx.done;
  publishWrite('folders', id);
}
