import type { BackupDocText, BackupDocument, BackupRep } from '../../core/backup/types';
import type { DocTextRecord, DocumentRecord, RepRecord } from '../../data/schema';

/**
 * Between the stored records and the backup format.
 *
 * The backup format carries fields v1 does not store — a performance date, a session id, a
 * grade, FSRS state. They are written as nulls and honest defaults rather than dropped, so
 * a backup taken today already has the right shape when the deferred progress model lands
 * (§0.0 A3/A4) and reading it back is not a format migration.
 */

export function toBackupDocument(d: DocumentRecord): BackupDocument {
  return {
    id: d.id,
    folderId: d.folderId,
    title: d.title,
    sortTitle: d.sortTitle,
    kind: d.kind,
    lang: d.lang,
    textHash: d.textHash,
    pipelineVersion: d.pipelineVersion,
    wordCount: d.wordCount,
    charCount: d.charCount,
    chunkCount: d.chunkCount,
    roles: d.roles,
    myRoleIds: d.myRoleIds,
    roleSetHash: d.roleSetHash,
    roleView: d.roleView,
    cueTailWords: d.cueTailWords,
    cleanupConfig: d.cleanupConfig,
    manualText: d.manualText,
    structureOverrides: d.structureOverrides,
    prefs: d.prefs,
    cursor: d.cursor,
    performanceAt: null,
    performanceTz: null,
    targetDurationSec: null,
    source: d.source,
    lastPracticedAt: d.lastPracticedAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    deletedAt: d.deletedAt,
    sv: d.sv,
  };
}

export function toBackupDocText(t: DocTextRecord, updatedAt: number): BackupDocText {
  return { docId: t.docId, sourceText: t.sourceText, textHash: t.textHash, updatedAt };
}

export function toBackupRep(r: RepRecord): BackupRep {
  return {
    id: r.id,
    docId: r.docId,
    roleSetHash: r.roleSetHash,
    chunkKey: r.chunkKey,
    sessionId: null,
    at: r.at,
    ms: r.durationMs,
    tzOffsetMin: new Date(r.at).getTimezoneOffset(),
    mode: 'silent',
    mask: {
      methodId: r.methodId,
      m: r.maskedCount,
      mContent: r.maskedCount,
      kind: r.customPercent === null ? `rung:${r.ladderIndex ?? 0}` : `pct:${r.customPercent}`,
      promptVisible: false,
    },
    // v1 does not grade a run — nothing asks the user how it went. A completed run with no
    // peeks is a 3; with peeks it is a 2. The real grading arrives with the progress model.
    grade: r.peeks === 0 ? 3 : 2,
    stakes: r.candidateCount > 0 ? r.maskedCount / r.candidateCount : 0,
    peeks: r.peeks,
    lineReveals: r.reveals,
    revealAllUsed: false,
  };
}
