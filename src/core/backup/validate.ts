/**
 * Reading a backup file. PLAN.md §11.8: "Validation is hand-written (~80 lines, no Zod),
 * which is what makes partial recovery expressible, and it doubles as the version-
 * migration seam."
 *
 * Two rules shape everything below.
 *
 * STRICT ABOUT SHAPE. The input is a file off a phone's Downloads folder, possibly
 * truncated, possibly hand-edited, possibly hostile. Every level is type-checked, every
 * record is rebuilt field by field from an explicit allowlist (never spread, never
 * assigned by dynamic key), and anything structurally wrong fails the whole file with a
 * message that says which record and which field. This is stricter than §11.8's
 * "per-record tolerance": a backup is the only copy of the data, so silently dropping
 * a document we could not parse is the wrong default. Tolerance belongs in the UI, on
 * top of the specific errors we return.
 *
 * LENIENT ABOUT VOCABULARY. Unknown method ids, document kinds, rep modes and extra
 * record fields are accepted or dropped, never rejected — §11.8's "a backup made by v1
 * imports cleanly into v5" has to work in the other direction too, or a user who
 * upgrades, exports and downgrades loses their library.
 */

import { APP_NAME, BACKUP_FORMAT } from '../../brand';
import type { BlockType, CleanupConfig, StructureOverride } from '../text/types';
import {
  BACKUP_LIMITS,
  type Backup,
  type BackupCounts,
  type BackupCursor,
  type BackupDocText,
  type BackupDocument,
  type BackupFolder,
  type BackupMaskSpec,
  type BackupPractisePrefs,
  type BackupRep,
  type BackupRole,
  type BackupSource,
  CURRENT_FORMAT_VERSION,
  computeIntegrity,
  isForbiddenKey,
  isIsoTimestamp,
  MIN_READABLE_FORMAT_VERSION,
  type SettingsValue,
} from './types';

export interface ValidateOptions {
  /**
   * Accept a checksum mismatch. The UI's "import anyway" path for a file the user
   * edited by hand — which the JSON format deliberately invites.
   */
  ignoreIntegrity?: boolean;
}

export type ValidateResult =
  | { ok: true; backup: Backup; warnings: string[] }
  | { ok: false; errors: string[] };

const MAX_REPORTED_ERRORS = 50;
const MAX_REPORTED_WARNINGS = 20;

export function validateBackup(raw: unknown, options: ValidateOptions = {}): ValidateResult {
  const bag = new Bag();

  const root = readObject(raw, 'backup', bag);
  if (root === undefined) {
    return { ok: false, errors: [notABackup(`expected a JSON object, got ${typeName(raw)}`)] };
  }

  const formatError = checkFormat(root);
  if (formatError !== null) return { ok: false, errors: [formatError] };

  const appVersion = readString(root.appVersion, 'appVersion', bag) ?? '';
  const createdAt = readIso(root.createdAt, 'createdAt', bag) ?? '';
  const installId =
    root.installId === undefined || root.installId === null
      ? null
      : (readString(root.installId, 'installId', bag) ?? null);

  const counts = readCounts(root.counts, bag);

  const folders = readRecordArray(root.folders, 'folders', BACKUP_LIMITS.folders, readFolder, bag);
  const documents = readRecordArray(
    root.documents,
    'documents',
    BACKUP_LIMITS.documents,
    readDocument,
    bag,
  );
  const docTexts = readRecordArray(
    root.docTexts,
    'docTexts',
    BACKUP_LIMITS.docTexts,
    readDocText,
    bag,
  );
  const reps = readRecordArray(root.reps, 'reps', BACKUP_LIMITS.reps, readRep, bag);
  const settings = readSettings(root.settings, 'settings', bag);

  checkUniqueIds(folders, 'folders', (f) => f.id, bag);
  checkUniqueIds(documents, 'documents', (d) => d.id, bag);
  checkUniqueIds(docTexts, 'docTexts', (t) => t.docId, bag);
  checkUniqueIds(reps, 'reps', (r) => r.id, bag);

  if (counts !== undefined) {
    // Compared against the length in the FILE, not the number of records we managed to
    // parse — otherwise a bad record reports twice, once as itself and once as a phantom
    // truncation.
    checkCount('folders', counts.folders, rawLength(root.folders), bag);
    checkCount('documents', counts.documents, rawLength(root.documents), bag);
    checkCount('docTexts', counts.docTexts, rawLength(root.docTexts), bag);
    checkCount('reps', counts.reps, rawLength(root.reps), bag);
  }

  const integrity = readString(root.integrity, 'integrity', bag);
  if (integrity !== undefined) {
    checkIntegrity(root, integrity, options.ignoreIntegrity === true, bag);
  }

  if (bag.errorCount > 0) return { ok: false, errors: bag.errors() };
  if (
    counts === undefined ||
    folders === undefined ||
    documents === undefined ||
    docTexts === undefined ||
    reps === undefined ||
    settings === undefined ||
    integrity === undefined
  ) {
    // Unreachable: every path above records an error before returning undefined.
    return { ok: false, errors: [notABackup('the file is missing required sections')] };
  }

  return {
    ok: true,
    warnings: bag.warnings(),
    backup: {
      format: BACKUP_FORMAT,
      formatVersion: CURRENT_FORMAT_VERSION,
      appVersion,
      createdAt,
      installId,
      counts,
      folders,
      documents,
      docTexts,
      reps,
      settings,
      integrity,
    },
  };
}

/**
 * The envelope check, split out because migrate.ts needs the same answer before it can
 * decide which upgrade steps to run. Returns null when the header is one we can read.
 */
export function checkFormat(root: Record<string, unknown>): string | null {
  const format = root.format;
  if (format === undefined) return notABackup('missing "format" marker');
  if (typeof format !== 'string') {
    return notABackup(`"format" is ${typeName(format)}, expected the string "${BACKUP_FORMAT}"`);
  }
  if (format !== BACKUP_FORMAT) {
    return notABackup(`"format" is "${truncate(format)}", expected "${BACKUP_FORMAT}"`);
  }

  const version = root.formatVersion;
  if (version === undefined) return 'backup is missing "formatVersion"';
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return `formatVersion: expected an integer, got ${typeName(version)}`;
  }
  if (version > CURRENT_FORMAT_VERSION) {
    return (
      `this backup was written by a newer version of ${APP_NAME} ` +
      `(format version ${version}; this build reads up to ${CURRENT_FORMAT_VERSION}). ` +
      'Update the app and try again.'
    );
  }
  if (version < MIN_READABLE_FORMAT_VERSION) {
    return (
      `this backup uses format version ${version}, which this build can no longer read ` +
      `(oldest supported is ${MIN_READABLE_FORMAT_VERSION})`
    );
  }
  if (version < CURRENT_FORMAT_VERSION) {
    return (
      `this backup uses format version ${version} and must be upgraded before it can be ` +
      'read — call migrateBackup() first'
    );
  }
  return null;
}

function notABackup(detail: string): string {
  return `not an ${APP_NAME} backup (${detail})`;
}

// ---------------------------------------------------------------- envelope pieces

function readCounts(value: unknown, bag: Bag): BackupCounts | undefined {
  const o = readObject(value, 'counts', bag);
  if (o === undefined) return undefined;
  const mark = bag.errorCount;
  const counts: BackupCounts = {
    folders: readCount(o.folders, 'counts.folders', BACKUP_LIMITS.folders, bag) ?? 0,
    documents: readCount(o.documents, 'counts.documents', BACKUP_LIMITS.documents, bag) ?? 0,
    docTexts: readCount(o.docTexts, 'counts.docTexts', BACKUP_LIMITS.docTexts, bag) ?? 0,
    reps: readCount(o.reps, 'counts.reps', BACKUP_LIMITS.reps, bag) ?? 0,
  };
  return bag.errorCount === mark ? counts : undefined;
}

/** Bounded before anything is allocated, so an absurd header cannot cost us anything. */
function readCount(value: unknown, path: string, limit: number, bag: Bag): number | undefined {
  const n = readInteger(value, path, bag);
  if (n === undefined) return undefined;
  if (n < 0) {
    bag.error(`${path}: count cannot be negative (${n})`);
    return undefined;
  }
  if (n > limit) {
    bag.error(`${path}: ${n} records is beyond the supported limit of ${limit}`);
    return undefined;
  }
  return n;
}

function rawLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function checkCount(name: string, declared: number, actual: number | undefined, bag: Bag): void {
  if (actual === undefined || declared === actual) return;
  bag.error(
    `counts.${name} says ${declared} but the file contains ${actual} — ` +
      'the file may be truncated or was edited by hand',
  );
}

function checkIntegrity(
  root: Record<string, unknown>,
  declared: string,
  ignore: boolean,
  bag: Bag,
): void {
  // Hashed over the payload AS WRITTEN, not over our re-read of it, so extra fields
  // from a newer writer still verify.
  const computed = computeIntegrity({
    folders: root.folders,
    documents: root.documents,
    docTexts: root.docTexts,
    reps: root.reps,
    settings: root.settings,
  });
  if (computed === null) {
    bag.error('backup: the payload is nested too deeply to check its integrity');
    return;
  }
  if (computed === declared) return;
  if (ignore) {
    bag.warn(`integrity: checksum mismatch ignored (declared ${declared}, computed ${computed})`);
    return;
  }
  bag.error(
    `integrity: checksum mismatch — declared ${declared}, computed ${computed}. ` +
      'The file is corrupt, truncated, or was edited after it was written.',
  );
}

function checkUniqueIds<T>(
  records: T[] | undefined,
  name: string,
  idOf: (record: T) => string,
  bag: Bag,
): void {
  if (records === undefined) return;
  const seen = new Set<string>();
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record === undefined) continue;
    const id = idOf(record);
    if (seen.has(id)) {
      bag.error(`${name}[${i}]: duplicate id "${truncate(id)}"`);
      continue;
    }
    seen.add(id);
  }
}

// ---------------------------------------------------------------- records

function readFolder(value: unknown, path: string, bag: Bag): BackupFolder | undefined {
  const o = readObject(value, path, bag);
  if (o === undefined) return undefined;
  const mark = bag.errorCount;
  const color = readOptionalString(o.color, `${path}.color`, bag);
  const folder: BackupFolder = {
    id: readId(o.id, `${path}.id`, bag) ?? '',
    name: readString(o.name, `${path}.name`, bag) ?? '',
    sortName: readString(o.sortName, `${path}.sortName`, bag) ?? '',
    ...(color !== undefined ? { color } : {}),
    order: readNumber(o.order, `${path}.order`, bag) ?? 0,
    createdAt: readTimestamp(o.createdAt, `${path}.createdAt`, bag) ?? 0,
    updatedAt: readTimestamp(o.updatedAt, `${path}.updatedAt`, bag) ?? 0,
    deletedAt: readNullableTimestamp(o.deletedAt, `${path}.deletedAt`, bag) ?? null,
    sv: readSv(o.sv, `${path}.sv`, bag) ?? 1,
  };
  return bag.errorCount === mark ? folder : undefined;
}

function readRole(value: unknown, path: string, bag: Bag): BackupRole | undefined {
  const o = readObject(value, path, bag);
  if (o === undefined) return undefined;
  const mark = bag.errorCount;
  const role: BackupRole = {
    id: readId(o.id, `${path}.id`, bag) ?? '',
    label: readString(o.label, `${path}.label`, bag) ?? '',
    aliases: readStringArray(o.aliases, `${path}.aliases`, bag) ?? [],
    colorIndex: readNumber(o.colorIndex, `${path}.colorIndex`, bag) ?? 0,
    isEnsemble: readBoolean(o.isEnsemble, `${path}.isEnsemble`, bag) ?? false,
    lineCount: readNumber(o.lineCount, `${path}.lineCount`, bag) ?? 0,
    wordCount: readNumber(o.wordCount, `${path}.wordCount`, bag) ?? 0,
    firstLineIndex: readNumber(o.firstLineIndex, `${path}.firstLineIndex`, bag) ?? 0,
  };
  return bag.errorCount === mark ? role : undefined;
}

function readPrefs(value: unknown, path: string, bag: Bag): BackupPractisePrefs | undefined {
  const o = readObject(value, path, bag);
  if (o === undefined) return undefined;
  const mark = bag.errorCount;
  const prefs: BackupPractisePrefs = {
    methodId: readString(o.methodId, `${path}.methodId`, bag) ?? '',
    ladderIndex: readNullableNumber(o.ladderIndex, `${path}.ladderIndex`, bag) ?? null,
    customPercent: readNullableNumber(o.customPercent, `${path}.customPercent`, bag) ?? null,
    methodParams: readSettings(o.methodParams, `${path}.methodParams`, bag) ?? {},
    reshuffle: readNumber(o.reshuffle, `${path}.reshuffle`, bag) ?? 0,
    chunkStrategy: readString(o.chunkStrategy, `${path}.chunkStrategy`, bag) ?? 'auto',
    chunkTargetWords: readNumber(o.chunkTargetWords, `${path}.chunkTargetWords`, bag) ?? 0,
    manualChunkBreaks: readStringArray(o.manualChunkBreaks, `${path}.manualChunkBreaks`, bag) ?? [],
  };
  return bag.errorCount === mark ? prefs : undefined;
}

function readCursor(value: unknown, path: string, bag: Bag): BackupCursor | undefined {
  const o = readObject(value, path, bag);
  if (o === undefined) return undefined;
  const mark = bag.errorCount;
  const step = readOptionalNumber(o.step, `${path}.step`, bag);
  const windowIndex = readOptionalNumber(o.windowIndex, `${path}.windowIndex`, bag);
  const cursor: BackupCursor = {
    chunkKey: readString(o.chunkKey, `${path}.chunkKey`, bag) ?? '',
    lineFingerprint: readString(o.lineFingerprint, `${path}.lineFingerprint`, bag) ?? '',
    scrollFraction: readNumber(o.scrollFraction, `${path}.scrollFraction`, bag) ?? 0,
    ...(step !== undefined ? { step } : {}),
    ...(windowIndex !== undefined ? { windowIndex } : {}),
    updatedAt: readTimestamp(o.updatedAt, `${path}.updatedAt`, bag) ?? 0,
  };
  return bag.errorCount === mark ? cursor : undefined;
}

function readSource(value: unknown, path: string, bag: Bag): BackupSource | undefined {
  const o = readObject(value, path, bag);
  if (o === undefined) return undefined;
  const mark = bag.errorCount;
  const filename = readOptionalString(o.filename, `${path}.filename`, bag);
  const source: BackupSource = {
    type: readString(o.type, `${path}.type`, bag) ?? 'import',
    ...(filename !== undefined ? { filename } : {}),
    importedAt: readTimestamp(o.importedAt, `${path}.importedAt`, bag) ?? 0,
  };
  return bag.errorCount === mark ? source : undefined;
}

function readCleanupConfig(value: unknown, path: string, bag: Bag): CleanupConfig | undefined {
  const o = readObject(value, path, bag);
  if (o === undefined) return undefined;
  const mark = bag.errorCount;
  const config: CleanupConfig = {
    normalise: readBoolean(o.normalise, `${path}.normalise`, bag) ?? true,
    punctuation: readBoolean(o.punctuation, `${path}.punctuation`, bag) ?? true,
    whitespace: readBoolean(o.whitespace, `${path}.whitespace`, bag) ?? true,
    dropArtifacts: readBoolean(o.dropArtifacts, `${path}.dropArtifacts`, bag) ?? true,
    unwrap: readBoolean(o.unwrap, `${path}.unwrap`, bag) ?? false,
  };
  return bag.errorCount === mark ? config : undefined;
}

/** BlockType is a frozen contract (core/text/types.ts); the Record keeps it exhaustive. */
const BLOCK_TYPES: Record<BlockType, true> = {
  dialogue: true,
  direction: true,
  heading: true,
  paragraph: true,
  verse: true,
  label: true,
};

function asBlockType(value: string): BlockType | undefined {
  return Object.hasOwn(BLOCK_TYPES, value) ? (value as BlockType) : undefined;
}

function readOverride(value: unknown, path: string, bag: Bag): StructureOverride | undefined {
  const o = readObject(value, path, bag);
  if (o === undefined) return undefined;
  const mark = bag.errorCount;
  const kind = readString(o.kind, `${path}.kind`, bag);
  const fingerprint = readString(o.fingerprint, `${path}.fingerprint`, bag) ?? '';

  let override: StructureOverride | undefined;
  if (kind === 'lineType') {
    const raw = readString(o.type, `${path}.type`, bag);
    const type = raw === undefined ? undefined : asBlockType(raw);
    if (raw !== undefined && type === undefined) {
      bag.error(`${path}.type: unknown line type "${truncate(raw)}"`);
    }
    override = { kind: 'lineType', fingerprint, type: type ?? 'paragraph' };
  } else if (kind === 'speaker') {
    override = {
      kind: 'speaker',
      fingerprint,
      speakerId: readNullableString(o.speakerId, `${path}.speakerId`, bag) ?? null,
    };
  } else if (kind === 'chunkBreak') {
    override = { kind: 'chunkBreak', fingerprint };
  } else if (kind !== undefined) {
    bag.error(`${path}.kind: unknown structure override "${truncate(kind)}"`);
  }
  return bag.errorCount === mark ? override : undefined;
}

function readDocument(value: unknown, path: string, bag: Bag): BackupDocument | undefined {
  const o = readObject(value, path, bag);
  if (o === undefined) return undefined;
  const mark = bag.errorCount;

  const document: BackupDocument = {
    id: readId(o.id, `${path}.id`, bag) ?? '',
    folderId: readNullableString(o.folderId, `${path}.folderId`, bag) ?? null,
    title: readString(o.title, `${path}.title`, bag) ?? '',
    sortTitle: readString(o.sortTitle, `${path}.sortTitle`, bag) ?? '',
    kind: readString(o.kind, `${path}.kind`, bag) ?? 'other',
    lang: readString(o.lang, `${path}.lang`, bag) ?? 'en',

    textHash: readString(o.textHash, `${path}.textHash`, bag) ?? '',
    pipelineVersion: readInteger(o.pipelineVersion, `${path}.pipelineVersion`, bag) ?? 1,
    wordCount: readNumber(o.wordCount, `${path}.wordCount`, bag) ?? 0,
    charCount: readNumber(o.charCount, `${path}.charCount`, bag) ?? 0,
    chunkCount: readNumber(o.chunkCount, `${path}.chunkCount`, bag) ?? 0,

    roles:
      readRecordArray(o.roles, `${path}.roles`, BACKUP_LIMITS.rolesPerDocument, readRole, bag) ??
      [],
    myRoleIds: readStringArray(o.myRoleIds, `${path}.myRoleIds`, bag) ?? [],
    roleSetHash: readString(o.roleSetHash, `${path}.roleSetHash`, bag) ?? '',
    roleView: readString(o.roleView, `${path}.roleView`, bag) ?? 'full',
    cueTailWords: readNumber(o.cueTailWords, `${path}.cueTailWords`, bag) ?? 0,

    cleanupConfig: readCleanupConfig(o.cleanupConfig, `${path}.cleanupConfig`, bag) ?? {
      normalise: true,
      punctuation: true,
      whitespace: true,
      dropArtifacts: true,
      unwrap: false,
    },
    manualText: readNullableString(o.manualText, `${path}.manualText`, bag) ?? null,
    structureOverrides:
      readRecordArray(
        o.structureOverrides,
        `${path}.structureOverrides`,
        BACKUP_LIMITS.overridesPerDocument,
        readOverride,
        bag,
      ) ?? [],

    prefs: readPrefs(o.prefs, `${path}.prefs`, bag) ?? {
      methodId: '',
      ladderIndex: null,
      customPercent: null,
      methodParams: {},
      reshuffle: 0,
      chunkStrategy: 'auto',
      chunkTargetWords: 0,
      manualChunkBreaks: [],
    },
    cursor:
      o.cursor === null || o.cursor === undefined
        ? null
        : (readCursor(o.cursor, `${path}.cursor`, bag) ?? null),
    performanceAt: readNullableTimestamp(o.performanceAt, `${path}.performanceAt`, bag) ?? null,
    performanceTz: readNullableString(o.performanceTz, `${path}.performanceTz`, bag) ?? null,
    targetDurationSec:
      readNullableNumber(o.targetDurationSec, `${path}.targetDurationSec`, bag) ?? null,

    source: readSource(o.source, `${path}.source`, bag) ?? { type: 'import', importedAt: 0 },
    lastPracticedAt:
      readNullableTimestamp(o.lastPracticedAt, `${path}.lastPracticedAt`, bag) ?? null,
    createdAt: readTimestamp(o.createdAt, `${path}.createdAt`, bag) ?? 0,
    updatedAt: readTimestamp(o.updatedAt, `${path}.updatedAt`, bag) ?? 0,
    deletedAt: readNullableTimestamp(o.deletedAt, `${path}.deletedAt`, bag) ?? null,
    sv: readSv(o.sv, `${path}.sv`, bag) ?? 1,
  };

  // §11.9 rule 1: a performance time without its zone plans the wrong local evening.
  if (document.performanceAt !== null && document.performanceTz === null) {
    bag.error(`${path}.performanceTz: required whenever performanceAt is set (§11.9)`);
  }
  return bag.errorCount === mark ? document : undefined;
}

function readDocText(value: unknown, path: string, bag: Bag): BackupDocText | undefined {
  const o = readObject(value, path, bag);
  if (o === undefined) return undefined;
  const mark = bag.errorCount;

  let sourceMeta: BackupDocText['sourceMeta'];
  if (o.sourceMeta !== undefined && o.sourceMeta !== null) {
    const m = readObject(o.sourceMeta, `${path}.sourceMeta`, bag);
    if (m !== undefined) {
      const pdfPages = readOptionalNumber(m.pdfPages, `${path}.sourceMeta.pdfPages`, bag);
      const dropped = readOptionalNumber(
        m.droppedArtifacts,
        `${path}.sourceMeta.droppedArtifacts`,
        bag,
      );
      const confidence = readOptionalNumber(
        m.parserConfidence,
        `${path}.sourceMeta.parserConfidence`,
        bag,
      );
      sourceMeta = {
        ...(pdfPages !== undefined ? { pdfPages } : {}),
        ...(dropped !== undefined ? { droppedArtifacts: dropped } : {}),
        ...(confidence !== undefined ? { parserConfidence: confidence } : {}),
      };
    }
  }

  const docText: BackupDocText = {
    docId: readId(o.docId, `${path}.docId`, bag) ?? '',
    sourceText: readString(o.sourceText, `${path}.sourceText`, bag) ?? '',
    textHash: readString(o.textHash, `${path}.textHash`, bag) ?? '',
    ...(sourceMeta !== undefined ? { sourceMeta } : {}),
    updatedAt: readTimestamp(o.updatedAt, `${path}.updatedAt`, bag) ?? 0,
  };
  return bag.errorCount === mark ? docText : undefined;
}

function readMaskSpec(value: unknown, path: string, bag: Bag): BackupMaskSpec | undefined {
  const o = readObject(value, path, bag);
  if (o === undefined) return undefined;
  const mark = bag.errorCount;
  const spec: BackupMaskSpec = {
    methodId: readString(o.methodId, `${path}.methodId`, bag) ?? '',
    m: readFraction(o.m, `${path}.m`, bag) ?? 0,
    mContent: readFraction(o.mContent, `${path}.mContent`, bag) ?? 0,
    kind: readString(o.kind, `${path}.kind`, bag) ?? 'blank',
    promptVisible: readBoolean(o.promptVisible, `${path}.promptVisible`, bag) ?? false,
  };
  return bag.errorCount === mark ? spec : undefined;
}

function readRep(value: unknown, path: string, bag: Bag): BackupRep | undefined {
  const o = readObject(value, path, bag);
  if (o === undefined) return undefined;
  const mark = bag.errorCount;

  const grade = readInteger(o.grade, `${path}.grade`, bag);
  if (grade !== undefined && (grade < 1 || grade > 4)) {
    bag.error(`${path}.grade: expected 1, 2, 3 or 4, got ${grade}`);
  }

  const clockSuspect = o.clockSuspect;
  if (clockSuspect !== undefined && clockSuspect !== true) {
    bag.error(`${path}.clockSuspect: expected true or absent, got ${typeName(clockSuspect)}`);
  }

  const spokenAloud = readOptionalBoolean(o.spokenAloud, `${path}.spokenAloud`, bag);
  const score = o.score === undefined ? undefined : readFraction(o.score, `${path}.score`, bag);
  const missedTokenIdx =
    o.missedTokenIdx === undefined
      ? undefined
      : readNumberArray(o.missedTokenIdx, `${path}.missedTokenIdx`, bag);

  let post: { S: number; D: number; C: number } | undefined;
  if (o.post !== undefined && o.post !== null) {
    const p = readObject(o.post, `${path}.post`, bag);
    if (p !== undefined) {
      post = {
        S: readNumber(p.S, `${path}.post.S`, bag) ?? 0,
        D: readNumber(p.D, `${path}.post.D`, bag) ?? 0,
        C: readNumber(p.C, `${path}.post.C`, bag) ?? 0,
      };
    }
  }

  const rep: BackupRep = {
    id: readId(o.id, `${path}.id`, bag) ?? '',
    docId: readId(o.docId, `${path}.docId`, bag) ?? '',
    roleSetHash: readString(o.roleSetHash, `${path}.roleSetHash`, bag) ?? '',
    chunkKey: readString(o.chunkKey, `${path}.chunkKey`, bag) ?? '',
    sessionId: readNullableString(o.sessionId, `${path}.sessionId`, bag) ?? null,
    at: readTimestamp(o.at, `${path}.at`, bag) ?? 0,
    ms: readNumber(o.ms, `${path}.ms`, bag) ?? 0,
    tzOffsetMin: readNumber(o.tzOffsetMin, `${path}.tzOffsetMin`, bag) ?? 0,
    ...(clockSuspect === true ? { clockSuspect: true as const } : {}),
    mode: readString(o.mode, `${path}.mode`, bag) ?? '',
    mask: readMaskSpec(o.mask, `${path}.mask`, bag) ?? {
      methodId: '',
      m: 0,
      mContent: 0,
      kind: 'blank',
      promptVisible: false,
    },
    grade: toGrade(grade),
    stakes: readNumber(o.stakes, `${path}.stakes`, bag) ?? 0,
    peeks: readNumber(o.peeks, `${path}.peeks`, bag) ?? 0,
    lineReveals: readNumber(o.lineReveals, `${path}.lineReveals`, bag) ?? 0,
    revealAllUsed: readBoolean(o.revealAllUsed, `${path}.revealAllUsed`, bag) ?? false,
    ...(spokenAloud !== undefined ? { spokenAloud } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(missedTokenIdx !== undefined ? { missedTokenIdx } : {}),
    ...(post !== undefined ? { post } : {}),
  };
  return bag.errorCount === mark ? rep : undefined;
}

function toGrade(value: number | undefined): 1 | 2 | 3 | 4 {
  return value === 2 || value === 3 || value === 4 ? value : 1;
}

/**
 * Settings and methodParams are the only open-keyed maps in the format. Rebuilt with
 * defineProperty so a `__proto__` key from the file can never reach the prototype chain.
 */
function readSettings(
  value: unknown,
  path: string,
  bag: Bag,
): Record<string, SettingsValue> | undefined {
  const o = readObject(value, path, bag);
  if (o === undefined) return undefined;
  const mark = bag.errorCount;
  const keys = Object.keys(o);
  if (keys.length > BACKUP_LIMITS.settings) {
    bag.error(
      `${path}: ${keys.length} keys is beyond the supported limit of ${BACKUP_LIMITS.settings}`,
    );
    return undefined;
  }
  const out: Record<string, SettingsValue> = {};
  for (const key of keys) {
    if (isForbiddenKey(key)) {
      bag.warn(`${path}: ignored the unsafe key "${key}"`);
      continue;
    }
    const v = o[key];
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      bag.error(
        `${path}["${truncate(key)}"]: expected a string, number or boolean, got ${typeName(v)}`,
      );
      continue;
    }
    if (typeof v === 'number' && !Number.isFinite(v)) {
      bag.error(`${path}["${truncate(key)}"]: expected a finite number`);
      continue;
    }
    if (typeof v === 'string' && v.length > BACKUP_LIMITS.stringChars) {
      bag.error(`${path}["${truncate(key)}"]: string is implausibly long (${v.length} chars)`);
      continue;
    }
    Object.defineProperty(out, key, {
      value: v,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return bag.errorCount === mark ? out : undefined;
}

// ---------------------------------------------------------------- primitives

function readRecordArray<T>(
  value: unknown,
  path: string,
  limit: number,
  read: (item: unknown, itemPath: string, bag: Bag) => T | undefined,
  bag: Bag,
): T[] | undefined {
  if (value === undefined) {
    bag.error(`${path}: missing (expected an array)`);
    return undefined;
  }
  if (!Array.isArray(value)) {
    bag.error(`${path}: expected an array, got ${typeName(value)}`);
    return undefined;
  }
  if (value.length > limit) {
    bag.error(`${path}: ${value.length} records is beyond the supported limit of ${limit}`);
    return undefined;
  }
  const out: T[] = [];
  for (let i = 0; i < value.length; i++) {
    const parsed = read(value[i], `${path}[${i}]`, bag);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

function readObject(value: unknown, path: string, bag: Bag): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    bag.error(`${path}: expected an object, got ${typeName(value)}`);
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (isForbiddenKey(key)) bag.warn(`${path}: ignored the unsafe key "${key}"`);
  }
  return record;
}

function readString(value: unknown, path: string, bag: Bag): string | undefined {
  if (typeof value !== 'string') {
    bag.error(`${path}: expected a string, got ${typeName(value)}`);
    return undefined;
  }
  if (value.length > BACKUP_LIMITS.stringChars) {
    bag.error(`${path}: string is implausibly long (${value.length} chars)`);
    return undefined;
  }
  return value;
}

function readId(value: unknown, path: string, bag: Bag): string | undefined {
  const s = readString(value, path, bag);
  if (s === undefined) return undefined;
  if (s.length === 0) {
    bag.error(`${path}: id cannot be empty`);
    return undefined;
  }
  return s;
}

function readOptionalString(value: unknown, path: string, bag: Bag): string | undefined {
  return value === undefined ? undefined : readString(value, path, bag);
}

function readNullableString(value: unknown, path: string, bag: Bag): string | null | undefined {
  if (value === null || value === undefined) return null;
  return readString(value, path, bag);
}

function readNumber(value: unknown, path: string, bag: Bag): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    bag.error(
      `${path}: expected a finite number, got ${typeof value === 'number' ? value : typeName(value)}`,
    );
    return undefined;
  }
  return value;
}

function readOptionalNumber(value: unknown, path: string, bag: Bag): number | undefined {
  return value === undefined ? undefined : readNumber(value, path, bag);
}

function readNullableNumber(value: unknown, path: string, bag: Bag): number | null | undefined {
  if (value === null || value === undefined) return null;
  return readNumber(value, path, bag);
}

function readInteger(value: unknown, path: string, bag: Bag): number | undefined {
  const n = readNumber(value, path, bag);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n)) {
    bag.error(`${path}: expected an integer, got ${n}`);
    return undefined;
  }
  return n;
}

function readFraction(value: unknown, path: string, bag: Bag): number | undefined {
  const n = readNumber(value, path, bag);
  if (n === undefined) return undefined;
  if (n < 0 || n > 1) {
    bag.error(`${path}: expected a fraction between 0 and 1, got ${n}`);
    return undefined;
  }
  return n;
}

/** Epoch milliseconds. Rejects negatives and anything past year 9999. */
const MAX_TIMESTAMP = 253_402_300_799_999;

function readTimestamp(value: unknown, path: string, bag: Bag): number | undefined {
  const n = readNumber(value, path, bag);
  if (n === undefined) return undefined;
  if (n < 0 || n > MAX_TIMESTAMP) {
    bag.error(`${path}: ${n} is not a plausible epoch-millisecond timestamp`);
    return undefined;
  }
  return n;
}

function readNullableTimestamp(value: unknown, path: string, bag: Bag): number | null | undefined {
  if (value === null || value === undefined) return null;
  return readTimestamp(value, path, bag);
}

function readBoolean(value: unknown, path: string, bag: Bag): boolean | undefined {
  if (typeof value !== 'boolean') {
    bag.error(`${path}: expected true or false, got ${typeName(value)}`);
    return undefined;
  }
  return value;
}

function readOptionalBoolean(value: unknown, path: string, bag: Bag): boolean | undefined {
  return value === undefined ? undefined : readBoolean(value, path, bag);
}

function readSv(value: unknown, path: string, bag: Bag): number | undefined {
  const n = readInteger(value, path, bag);
  if (n === undefined) return undefined;
  if (n < 1) {
    bag.error(`${path}: record version must be 1 or greater, got ${n}`);
    return undefined;
  }
  return n;
}

function readStringArray(value: unknown, path: string, bag: Bag): string[] | undefined {
  if (!Array.isArray(value)) {
    bag.error(`${path}: expected an array of strings, got ${typeName(value)}`);
    return undefined;
  }
  if (value.length > BACKUP_LIMITS.innerArray) {
    bag.error(`${path}: ${value.length} entries is beyond the supported limit`);
    return undefined;
  }
  const mark = bag.errorCount;
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const s = readString(value[i], `${path}[${i}]`, bag);
    if (s !== undefined) out.push(s);
  }
  return bag.errorCount === mark ? out : undefined;
}

function readNumberArray(value: unknown, path: string, bag: Bag): number[] | undefined {
  if (!Array.isArray(value)) {
    bag.error(`${path}: expected an array of numbers, got ${typeName(value)}`);
    return undefined;
  }
  if (value.length > BACKUP_LIMITS.innerArray) {
    bag.error(`${path}: ${value.length} entries is beyond the supported limit`);
    return undefined;
  }
  const mark = bag.errorCount;
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const n = readNumber(value[i], `${path}[${i}]`, bag);
    if (n !== undefined) out.push(n);
  }
  return bag.errorCount === mark ? out : undefined;
}

function readIso(value: unknown, path: string, bag: Bag): string | undefined {
  const s = readString(value, path, bag);
  if (s === undefined) return undefined;
  if (!isIsoTimestamp(s)) {
    bag.error(`${path}: expected an ISO-8601 UTC timestamp, got "${truncate(s)}"`);
    return undefined;
  }
  return s;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function truncate(value: string, max = 40): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Collects problems without letting a pathological file produce a million-line list;
 * `errorCount` keeps counting past the reporting cap so the mark-and-discard pattern in
 * every record reader stays correct.
 */
class Bag {
  private readonly reported: string[] = [];
  private readonly warned: string[] = [];
  private total = 0;
  private warnTotal = 0;

  get errorCount(): number {
    return this.total;
  }

  error(message: string): void {
    this.total++;
    if (this.reported.length < MAX_REPORTED_ERRORS) this.reported.push(message);
  }

  warn(message: string): void {
    this.warnTotal++;
    if (this.warned.length < MAX_REPORTED_WARNINGS && !this.warned.includes(message)) {
      this.warned.push(message);
    }
  }

  errors(): string[] {
    const hidden = this.total - this.reported.length;
    return hidden > 0 ? [...this.reported, `…and ${hidden} more problems`] : [...this.reported];
  }

  warnings(): string[] {
    const hidden = this.warnTotal - this.warned.length;
    return hidden > 0 ? [...this.warned, `…and ${hidden} more notices`] : [...this.warned];
  }
}
