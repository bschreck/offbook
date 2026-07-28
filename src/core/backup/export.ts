/**
 * Building a backup file. PLAN.md §11.8.
 *
 * Pure and synchronous: the caller loads the records, we assemble the envelope. Every
 * record is projected through an explicit field list rather than spread wholesale, so a
 * field added to a stored record later (or a materialized view like `progress`) cannot
 * silently leak into the file, and so what we write is exactly what validate.ts reads.
 */

import { BACKUP_FORMAT } from '../../brand';
import { invariant } from '../util/assert';
import {
  type Backup,
  type BackupCursor,
  type BackupDocText,
  type BackupDocument,
  type BackupFolder,
  type BackupPractisePrefs,
  type BackupRep,
  type BackupRole,
  type BackupSource,
  CURRENT_FORMAT_VERSION,
  computeIntegrity,
  isForbiddenKey,
  isIsoTimestamp,
  type SettingsValue,
} from './types';

export interface BackupInput {
  folders: readonly BackupFolder[];
  documents: readonly BackupDocument[];
  docTexts: readonly BackupDocText[];
  /** Compact per §11.6 before calling; we write whatever we are given. */
  reps: readonly BackupRep[];
  settings: Readonly<Record<string, SettingsValue>>;
}

export interface BackupMetaInput {
  appVersion: string;
  /** ISO-8601 UTC, produced by the caller. Core never reads a clock. */
  createdAt: string;
  installId?: string | null;
}

export function buildBackup(input: BackupInput, meta: BackupMetaInput): Backup {
  invariant(
    isIsoTimestamp(meta.createdAt),
    `buildBackup: createdAt must be an ISO-8601 UTC timestamp, got ${JSON.stringify(meta.createdAt)}`,
  );

  const folders = input.folders.map(pickFolder);
  const documents = input.documents.map(pickDocument);
  const docTexts = input.docTexts.map(pickDocText);
  const reps = input.reps.map(pickRep);
  const settings = pickSettings(input.settings);

  const integrity = computeIntegrity({ folders, documents, docTexts, reps, settings });
  invariant(integrity !== null, 'buildBackup: payload is too deeply nested to canonicalise');

  return {
    format: BACKUP_FORMAT,
    formatVersion: CURRENT_FORMAT_VERSION,
    appVersion: meta.appVersion,
    createdAt: meta.createdAt,
    installId: meta.installId ?? null,
    counts: {
      folders: folders.length,
      documents: documents.length,
      docTexts: docTexts.length,
      reps: reps.length,
    },
    folders,
    documents,
    docTexts,
    reps,
    settings,
    integrity,
  };
}

/**
 * The per-document escape hatch (§11.8): a library too large for one file exports one
 * document at a time. It is an ordinary backup with a single document, so there is one
 * format and one parser, not two.
 *
 * Two documented losses: `folders` is empty, so a receiving library that does not know
 * `doc.folderId` must file the document at the root; and reps are only included if the
 * caller passes them (the sharing default in §11.8 is text + roles + prefs, no history).
 */
export function buildDocumentExport(
  doc: BackupDocument,
  docText: BackupDocText,
  meta: BackupMetaInput,
  reps: readonly BackupRep[] = [],
): Backup {
  invariant(
    doc.id === docText.docId,
    `buildDocumentExport: docText.docId ${docText.docId} does not match document ${doc.id}`,
  );
  return buildBackup(
    { folders: [], documents: [doc], docTexts: [docText], reps, settings: {} },
    meta,
  );
}

// ---------------------------------------------------------------- projections

function pickFolder(f: BackupFolder): BackupFolder {
  return {
    id: f.id,
    name: f.name,
    sortName: f.sortName,
    ...(f.color !== undefined ? { color: f.color } : {}),
    order: f.order,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    deletedAt: f.deletedAt,
    sv: f.sv,
  };
}

function pickRole(r: BackupRole): BackupRole {
  return {
    id: r.id,
    label: r.label,
    aliases: [...r.aliases],
    colorIndex: r.colorIndex,
    isEnsemble: r.isEnsemble,
    lineCount: r.lineCount,
    wordCount: r.wordCount,
    firstLineIndex: r.firstLineIndex,
  };
}

function pickPrefs(p: BackupPractisePrefs): BackupPractisePrefs {
  return {
    methodId: p.methodId,
    ladderIndex: p.ladderIndex,
    customPercent: p.customPercent,
    methodParams: pickSettings(p.methodParams),
    reshuffle: p.reshuffle,
    chunkStrategy: p.chunkStrategy,
    chunkTargetWords: p.chunkTargetWords,
    manualChunkBreaks: [...p.manualChunkBreaks],
  };
}

function pickCursor(c: BackupCursor): BackupCursor {
  return {
    chunkKey: c.chunkKey,
    lineFingerprint: c.lineFingerprint,
    scrollFraction: c.scrollFraction,
    ...(c.step !== undefined ? { step: c.step } : {}),
    ...(c.windowIndex !== undefined ? { windowIndex: c.windowIndex } : {}),
    updatedAt: c.updatedAt,
  };
}

function pickSource(s: BackupSource): BackupSource {
  return {
    type: s.type,
    ...(s.filename !== undefined ? { filename: s.filename } : {}),
    importedAt: s.importedAt,
  };
}

function pickDocument(d: BackupDocument): BackupDocument {
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
    roles: d.roles.map(pickRole),
    myRoleIds: [...d.myRoleIds],
    roleSetHash: d.roleSetHash,
    roleView: d.roleView,
    cueTailWords: d.cueTailWords,
    cleanupConfig: {
      normalise: d.cleanupConfig.normalise,
      punctuation: d.cleanupConfig.punctuation,
      whitespace: d.cleanupConfig.whitespace,
      dropArtifacts: d.cleanupConfig.dropArtifacts,
      unwrap: d.cleanupConfig.unwrap,
    },
    manualText: d.manualText,
    structureOverrides: d.structureOverrides.map((o) =>
      o.kind === 'lineType'
        ? { kind: 'lineType' as const, fingerprint: o.fingerprint, type: o.type }
        : o.kind === 'speaker'
          ? { kind: 'speaker' as const, fingerprint: o.fingerprint, speakerId: o.speakerId }
          : { kind: 'chunkBreak' as const, fingerprint: o.fingerprint },
    ),
    prefs: pickPrefs(d.prefs),
    cursor: d.cursor === null ? null : pickCursor(d.cursor),
    performanceAt: d.performanceAt,
    performanceTz: d.performanceTz,
    targetDurationSec: d.targetDurationSec,
    source: pickSource(d.source),
    lastPracticedAt: d.lastPracticedAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    deletedAt: d.deletedAt,
    sv: d.sv,
  };
}

function pickDocText(t: BackupDocText): BackupDocText {
  const meta = t.sourceMeta;
  return {
    docId: t.docId,
    sourceText: t.sourceText,
    textHash: t.textHash,
    ...(meta !== undefined
      ? {
          sourceMeta: {
            ...(meta.pdfPages !== undefined ? { pdfPages: meta.pdfPages } : {}),
            ...(meta.droppedArtifacts !== undefined
              ? { droppedArtifacts: meta.droppedArtifacts }
              : {}),
            ...(meta.parserConfidence !== undefined
              ? { parserConfidence: meta.parserConfidence }
              : {}),
          },
        }
      : {}),
    updatedAt: t.updatedAt,
  };
}

function pickRep(r: BackupRep): BackupRep {
  return {
    id: r.id,
    docId: r.docId,
    roleSetHash: r.roleSetHash,
    chunkKey: r.chunkKey,
    sessionId: r.sessionId,
    at: r.at,
    ms: r.ms,
    tzOffsetMin: r.tzOffsetMin,
    ...(r.clockSuspect !== undefined ? { clockSuspect: r.clockSuspect } : {}),
    mode: r.mode,
    mask: {
      methodId: r.mask.methodId,
      m: r.mask.m,
      mContent: r.mask.mContent,
      kind: r.mask.kind,
      promptVisible: r.mask.promptVisible,
    },
    grade: r.grade,
    stakes: r.stakes,
    peeks: r.peeks,
    lineReveals: r.lineReveals,
    revealAllUsed: r.revealAllUsed,
    ...(r.spokenAloud !== undefined ? { spokenAloud: r.spokenAloud } : {}),
    ...(r.score !== undefined ? { score: r.score } : {}),
    ...(r.missedTokenIdx !== undefined ? { missedTokenIdx: [...r.missedTokenIdx] } : {}),
    ...(r.post !== undefined ? { post: { S: r.post.S, D: r.post.D, C: r.post.C } } : {}),
  };
}

/**
 * Rebuilt key by key with defineProperty: a settings map reaching us from parsed JSON
 * can own a `__proto__` key, and plain assignment would hit the prototype setter.
 */
function pickSettings(
  source: Readonly<Record<string, SettingsValue>>,
): Record<string, SettingsValue> {
  const out: Record<string, SettingsValue> = {};
  for (const key of Object.keys(source)) {
    if (isForbiddenKey(key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
