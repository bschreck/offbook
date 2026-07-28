/**
 * Deciding what a restore would do. PLAN.md §11.8: "Restore is a merge, never a replace".
 *
 * This module produces a PLAN and mutates nothing. The data layer applies it in one
 * transaction (§6.1 rule 1) and the UI shows the summary dialogue ("3 new, 2 updated,
 * 7 unchanged") from the same object. Keeping the decision pure is what makes the
 * conflict policy testable without a database.
 *
 * THE CONFLICT POLICY, in full:
 *
 *   folders    id unseen                       -> create
 *              id seen, incoming is newer      -> update   (updatedAt wins)
 *              id seen, incoming is not newer  -> skip
 *
 *   documents  id unseen                       -> create
 *              id seen, same textHash, newer   -> update   (title/prefs/cursor changed)
 *              id seen, same textHash, older   -> skip     (re-importing a file is a no-op)
 *              id seen, DIFFERENT textHash     -> CONFLICT
 *
 *   docTexts   docId unseen                    -> create
 *              docId seen, same textHash       -> skip
 *              docId seen, different textHash  -> CONFLICT
 *
 *   reps       id unseen                       -> create
 *              id seen                         -> skip     (append-only ⇒ union by id)
 *
 *   settings   key unseen                      -> create
 *              key seen, same value            -> skip
 *              key seen, different value       -> update
 *
 * `sourceText` is immutable after import (§6.2) and every chunkKey, cursor and rep is
 * anchored to it, so two different texts under one id is exactly the case a human has to
 * resolve — "keep mine", "take theirs", or "import as a copy" (the data layer assigns a
 * new id for the copy; core does not mint ids because it must stay deterministic).
 * `updatedAt`-wins never applies to it: a newer timestamp on a different text still means
 * the incoming file would silently orphan practice history.
 *
 * Conflicts appear ONLY in `conflicts` — never also in toCreate/toUpdate — so a caller
 * that applies the plan without resolving them cannot corrupt anything.
 */

import type {
  Backup,
  BackupDocText,
  BackupDocument,
  BackupFolder,
  BackupRep,
  SettingsValue,
} from './types';

/** What the caller already has. Full records satisfy these; summaries are enough. */
export interface ExistingFolder {
  id: string;
  updatedAt: number;
}

export interface ExistingDocument {
  id: string;
  updatedAt: number;
  textHash: string;
}

export interface ExistingDocText {
  docId: string;
  textHash: string;
}

export interface ExistingLibrary {
  folders: readonly ExistingFolder[];
  documents: readonly ExistingDocument[];
  docTexts: readonly ExistingDocText[];
  /** Ids only: the log is append-only, so identity is the whole comparison. */
  repIds: Iterable<string>;
  settings: Readonly<Record<string, SettingsValue>>;
}

export type RestoreEntry =
  | { store: 'folders'; key: string; record: BackupFolder }
  | { store: 'documents'; key: string; record: BackupDocument }
  | { store: 'docTexts'; key: string; record: BackupDocText }
  | { store: 'reps'; key: string; record: BackupRep }
  | { store: 'settings'; key: string; value: SettingsValue };

export type RestoreStore = RestoreEntry['store'];

export type SkipReason = 'identical' | 'not-newer' | 'already-present' | 'excluded-by-mode';

export interface RestoreSkip {
  store: RestoreStore;
  key: string;
  reason: SkipReason;
}

export interface RestoreConflict {
  store: 'documents' | 'docTexts';
  key: string;
  reason: 'text-differs';
  /** The record the file wants to write, so the UI can offer "take theirs". */
  incoming: BackupDocument | BackupDocText;
  existing: { textHash: string; updatedAt?: number };
}

export interface RestorePlan {
  toCreate: RestoreEntry[];
  toUpdate: RestoreEntry[];
  toSkip: RestoreSkip[];
  conflicts: RestoreConflict[];
  /** The numbers the confirmation dialogue reads. */
  summary: {
    create: number;
    update: number;
    skip: number;
    conflict: number;
    byStore: Record<RestoreStore, { create: number; update: number; skip: number }>;
  };
}

export interface RestoreOptions {
  /**
   * `docsOnly` is §11.8's sharing default: text, roles and prefs, but none of the
   * sender's practice history or settings. `merge` is the restore-my-own-backup case.
   */
  mode?: 'merge' | 'docsOnly';
}

export function planRestore(
  backup: Backup,
  existing: ExistingLibrary,
  options: RestoreOptions = {},
): RestorePlan {
  const docsOnly = options.mode === 'docsOnly';
  const plan: RestorePlan = {
    toCreate: [],
    toUpdate: [],
    toSkip: [],
    conflicts: [],
    summary: {
      create: 0,
      update: 0,
      skip: 0,
      conflict: 0,
      byStore: {
        folders: zero(),
        documents: zero(),
        docTexts: zero(),
        reps: zero(),
        settings: zero(),
      },
    },
  };

  const folders = indexBy(existing.folders, (f) => f.id);
  const documents = indexBy(existing.documents, (d) => d.id);
  const docTexts = indexBy(existing.docTexts, (t) => t.docId);
  const repIds = new Set(existing.repIds);

  for (const folder of backup.folders) {
    const current = folders.get(folder.id);
    if (current === undefined) {
      create(plan, { store: 'folders', key: folder.id, record: folder });
    } else if (folder.updatedAt > current.updatedAt) {
      update(plan, { store: 'folders', key: folder.id, record: folder });
    } else {
      skip(
        plan,
        'folders',
        folder.id,
        folder.updatedAt === current.updatedAt ? 'identical' : 'not-newer',
      );
    }
  }

  for (const doc of backup.documents) {
    const current = documents.get(doc.id);
    if (current === undefined) {
      create(plan, { store: 'documents', key: doc.id, record: doc });
    } else if (current.textHash !== doc.textHash) {
      conflict(plan, {
        store: 'documents',
        key: doc.id,
        reason: 'text-differs',
        incoming: doc,
        existing: { textHash: current.textHash, updatedAt: current.updatedAt },
      });
    } else if (doc.updatedAt > current.updatedAt) {
      update(plan, { store: 'documents', key: doc.id, record: doc });
    } else {
      skip(
        plan,
        'documents',
        doc.id,
        doc.updatedAt === current.updatedAt ? 'identical' : 'not-newer',
      );
    }
  }

  for (const text of backup.docTexts) {
    const current = docTexts.get(text.docId);
    if (current === undefined) {
      create(plan, { store: 'docTexts', key: text.docId, record: text });
    } else if (current.textHash !== text.textHash) {
      conflict(plan, {
        store: 'docTexts',
        key: text.docId,
        reason: 'text-differs',
        incoming: text,
        existing: { textHash: current.textHash },
      });
    } else {
      // sourceText is immutable (§6.2), so equal hashes mean there is nothing to write.
      skip(plan, 'docTexts', text.docId, 'identical');
    }
  }

  for (const rep of backup.reps) {
    if (docsOnly) {
      skip(plan, 'reps', rep.id, 'excluded-by-mode');
    } else if (repIds.has(rep.id)) {
      skip(plan, 'reps', rep.id, 'already-present');
    } else {
      create(plan, { store: 'reps', key: rep.id, record: rep });
      repIds.add(rep.id);
    }
  }

  for (const key of Object.keys(backup.settings)) {
    const value = backup.settings[key];
    if (value === undefined) continue;
    if (docsOnly) {
      skip(plan, 'settings', key, 'excluded-by-mode');
      continue;
    }
    const current = Object.hasOwn(existing.settings, key) ? existing.settings[key] : undefined;
    if (current === undefined) {
      create(plan, { store: 'settings', key, value });
    } else if (current === value) {
      skip(plan, 'settings', key, 'identical');
    } else {
      update(plan, { store: 'settings', key, value });
    }
  }

  return plan;
}

/**
 * Documents in the backup whose text is missing from both the file and the library —
 * the one cross-store integrity check worth doing before a restore, because a document
 * without its `docText` renders as an empty script.
 */
export function findOrphanedDocuments(backup: Backup, existing: ExistingLibrary): string[] {
  const haveText = new Set<string>();
  for (const t of backup.docTexts) haveText.add(t.docId);
  for (const t of existing.docTexts) haveText.add(t.docId);
  return backup.documents.filter((d) => !haveText.has(d.id)).map((d) => d.id);
}

// ---------------------------------------------------------------- helpers

function zero(): { create: number; update: number; skip: number } {
  return { create: 0, update: 0, skip: 0 };
}

function indexBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(keyOf(item), item);
  return map;
}

function create(plan: RestorePlan, entry: RestoreEntry): void {
  plan.toCreate.push(entry);
  plan.summary.create++;
  plan.summary.byStore[entry.store].create++;
}

function update(plan: RestorePlan, entry: RestoreEntry): void {
  plan.toUpdate.push(entry);
  plan.summary.update++;
  plan.summary.byStore[entry.store].update++;
}

function skip(plan: RestorePlan, store: RestoreStore, key: string, reason: SkipReason): void {
  plan.toSkip.push({ store, key, reason });
  plan.summary.skip++;
  plan.summary.byStore[store].skip++;
}

function conflict(plan: RestorePlan, item: RestoreConflict): void {
  plan.conflicts.push(item);
  plan.summary.conflict++;
}
