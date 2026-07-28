import { buildBackup } from '../../core/backup/export';
import { type ExistingLibrary, planRestore, type RestorePlan } from '../../core/backup/import';
import { migrateBackup } from '../../core/backup/migrate';
import type { Backup, SettingsValue } from '../../core/backup/types';
import { publishWrite } from '../../data/broadcast';
import { getDb } from '../../data/db';
import { getInstallId } from '../../data/repos/meta';
import { loadSettings } from '../../data/repos/settings';
import { toBackupDocText, toBackupDocument, toBackupRep } from './adapters';

const APP_VERSION = '0.1.0';

/**
 * The only escape hatch — there is no cloud sync — so this has to be boring and correct.
 * Core decides the shape and the plan; this module does the I/O.
 */

export async function exportBackupJson(): Promise<{ json: string; filename: string }> {
  const db = await getDb();
  const [folders, documents, docTexts, reps, settings, installId] = await Promise.all([
    db.getAll('folders'),
    db.getAll('documents'),
    db.getAll('docText'),
    db.getAll('reps'),
    loadSettings(),
    getInstallId(),
  ]);

  const docUpdatedAt = new Map(documents.map((d) => [d.id, d.updatedAt]));
  const backup = buildBackup(
    {
      folders,
      documents: documents.map(toBackupDocument),
      docTexts: docTexts.map((t) => toBackupDocText(t, docUpdatedAt.get(t.docId) ?? Date.now())),
      reps: reps.map(toBackupRep),
      settings: settings as unknown as Record<string, SettingsValue>,
    },
    { appVersion: APP_VERSION, createdAt: new Date().toISOString(), installId },
  );

  const stamp = new Date().toISOString().slice(0, 10);
  return { json: JSON.stringify(backup), filename: `offbook-backup-${stamp}.json` };
}

export function downloadJson(json: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoke on the next tick: revoking synchronously can cancel the download in WebKit.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readBackupFile(
  file: File,
): Promise<{ ok: true; backup: Backup } | { ok: false; errors: string[] }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    return { ok: false, errors: ['That file isn’t valid JSON.'] };
  }
  const migrated = migrateBackup(raw);
  if (!migrated.ok) return { ok: false, errors: migrated.errors };
  return { ok: true, backup: migrated.backup };
}

export async function buildRestorePlan(backup: Backup): Promise<RestorePlan> {
  const db = await getDb();
  const [folders, documents, docTexts, reps, settings] = await Promise.all([
    db.getAll('folders'),
    db.getAll('documents'),
    db.getAll('docText'),
    db.getAllKeys('reps'),
    loadSettings(),
  ]);

  const existing: ExistingLibrary = {
    folders,
    documents,
    docTexts,
    repIds: reps as string[],
    settings: settings as unknown as Record<string, SettingsValue>,
  };
  return planRestore(backup, existing);
}

/**
 * Applies a plan in ONE transaction per store group. Conflicts are NOT applied — the caller
 * decides what to do with them, because silently overwriting a text the user has since
 * edited is the one unrecoverable mistake this feature could make.
 */
export async function applyRestorePlan(plan: RestorePlan): Promise<number> {
  const db = await getDb();
  const entries = [...plan.toCreate, ...plan.toUpdate];
  if (entries.length === 0) return 0;

  const tx = db.transaction(['folders', 'documents', 'docText', 'reps', 'settings'], 'readwrite');
  let applied = 0;
  for (const entry of entries) {
    switch (entry.store) {
      case 'folders':
        await tx.objectStore('folders').put(entry.record as never);
        break;
      case 'documents':
        await tx.objectStore('documents').put(entry.record as never);
        break;
      case 'docTexts':
        await tx.objectStore('docText').put(entry.record as never);
        break;
      case 'reps':
        await tx.objectStore('reps').put(entry.record as never);
        break;
      case 'settings':
        await tx.objectStore('settings').put({ key: entry.key, value: entry.value } as never);
        break;
    }
    applied++;
  }
  await tx.done;
  publishWrite('documents', 'restore');
  return applied;
}
