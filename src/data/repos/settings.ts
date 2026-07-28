import { getDb } from '../db';
import { DEFAULT_SETTINGS, type SettingsShape } from '../schema';

export async function loadSettings(): Promise<SettingsShape> {
  const db = await getDb();
  const rows = await db.getAll('settings');
  const out = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (row.key in out) {
      // Settings are written one key at a time and validated on write, so a stored row is
      // trusted here; an unknown key is simply ignored rather than crashing boot.
      (out as Record<string, unknown>)[row.key] = row.value;
    }
  }
  return out;
}

export async function saveSetting<K extends keyof SettingsShape>(
  key: K,
  value: SettingsShape[K],
): Promise<void> {
  const db = await getDb();
  await db.put('settings', { key, value });
}

export async function resetSettings(): Promise<void> {
  const db = await getDb();
  await db.clear('settings');
}
