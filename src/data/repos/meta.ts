import { newId } from '../../core/util/id';
import { getDb } from '../db';
import type { MetaKey } from '../schema';

export async function getMeta<T>(key: MetaKey): Promise<T | undefined> {
  const db = await getDb();
  const row = await db.get('meta', key);
  return row?.value as T | undefined;
}

export async function setMeta(key: MetaKey, value: unknown): Promise<void> {
  const db = await getDb();
  await db.put('meta', { key, value });
}

/** Stable per-install id. Not sent anywhere; it exists to label a backup file's origin. */
export async function getInstallId(): Promise<string> {
  const existing = await getMeta<string>('installId');
  if (existing) return existing;
  const id = newId();
  await setMeta('installId', id);
  return id;
}
