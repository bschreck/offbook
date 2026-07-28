import type { DBSchema } from 'idb';
import { DB_NAME } from '../brand';
import type { BlankStyle, CueStyle, MethodId } from '../core/mask/types';
import type { CleanupConfig, DocKind, Role, StructureOverride } from '../core/text/types';

export { DB_NAME };

/**
 * DB version governs STORES AND INDEXES only, via a fall-through switch in `upgrade`.
 * Record shape is versioned separately by each record's `sv` field and migrated lazily on
 * read — so adding a masking option never needs an upgrade transaction on a phone you
 * cannot debug. PLAN.md §6.1.
 *
 * v1 (M0): meta, settings, folders, documents, docText
 * v2 (M1): derived, reps
 * v3/v4 are reserved for the deferred progress and voice features (§0.0 A3).
 */
export const DB_VERSION = 2;

export interface SettingsShape {
  'ui.theme': 'system' | 'light' | 'dark' | 'contrast';
  'reader.fontPx': number;
  'reader.lineHeight': number;
  'reader.measureCh': number;
  'reader.blankStyle': BlankStyle;
  'reader.lineFocus': boolean;
  'reader.autoScrollWpm': number;
  'reader.autoScrollMode': 'smooth' | 'stepped';
  'reader.keepAwake': 'sessions' | 'always' | 'never';
  'input.peekBehaviour': 'hold' | 'tap';
  'input.longPressMs': number;
  'input.haptics': boolean;
  'practice.autoAdvanceOnCleanRun': boolean;
  'a11y.verbosity': 'terse' | 'verbose';
  'a11y.largerTargets': boolean;
}

export const DEFAULT_SETTINGS: SettingsShape = {
  'ui.theme': 'system',
  'reader.fontPx': 22,
  'reader.lineHeight': 1.65,
  'reader.measureCh': 32,
  'reader.blankStyle': 'underline',
  'reader.lineFocus': false,
  'reader.autoScrollWpm': 120,
  // Smooth by default — Ben's decision, PLAN.md §0.0 A5.
  'reader.autoScrollMode': 'smooth',
  'reader.keepAwake': 'sessions',
  'input.peekBehaviour': 'hold',
  'input.longPressMs': 450,
  'input.haptics': true,
  'practice.autoAdvanceOnCleanRun': true,
  'a11y.verbosity': 'terse',
  'a11y.largerTargets': false,
};

export type MetaKey =
  | 'schemaVersion'
  | 'installId'
  | 'pipelineVersion'
  | 'persistGranted'
  | 'lastBackupAt'
  | 'hadData'
  | 'firstRunDoneAt';

export interface MetaRow {
  key: MetaKey;
  value: unknown;
}

export interface SettingRow {
  key: keyof SettingsShape;
  value: SettingsShape[keyof SettingsShape];
}

export interface FolderRecord {
  id: string;
  name: string;
  sortName: string;
  order: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  sv: 1;
}

export interface DocPractisePrefs {
  methodId: MethodId;
  ladderIndex: number | null;
  customPercent: number | null;
  methodParams: Record<string, number | string | boolean>;
  reshuffle: number;
  chunkStrategy: 'auto' | 'line' | 'sentence' | 'speech' | 'block';
  chunkTargetWords: number;
  manualChunkBreaks: string[];
}

/** Content-anchored, so the bookmark survives edits and re-chunking. */
export interface PracticeCursor {
  chunkKey: string;
  lineFingerprint: string;
  scrollFraction: number;
  updatedAt: number;
}

export interface DocumentRecord {
  id: string;
  folderId: string | null;
  title: string;
  sortTitle: string;
  kind: DocKind;
  lang: string;
  textHash: string;
  pipelineVersion: number;
  wordCount: number;
  charCount: number;
  chunkCount: number;
  roles: Role[];
  myRoleIds: string[];
  roleSetHash: string;
  roleView: 'full' | 'cue' | 'mine';
  cueStyle: CueStyle;
  cueTailWords: number;
  cleanupConfig: CleanupConfig;
  manualText: string | null;
  structureOverrides: StructureOverride[];
  prefs: DocPractisePrefs;
  cursor: PracticeCursor | null;
  /** Peeks per 100 words on the most recent run — the one honest number v1 shows. */
  lastRunPeeks100: number | null;
  source: {
    type: 'paste' | 'txt' | 'md' | 'html' | 'pdf' | 'sample' | 'import';
    filename?: string;
    importedAt: number;
  };
  lastPracticedAt: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  sv: 1;
}

export interface DocTextRecord {
  docId: string;
  /** IMMUTABLE after import. The single source of truth; everything else re-derives. */
  sourceText: string;
  textHash: string;
  sv: 1;
}

/** Cached derivation of a Document. Recomputed whenever pipelineVersion moves. */
export interface DerivedRecord {
  docId: string;
  pipelineVersion: number;
  textHash: string;
  /** The serialised core Document. Rebuilt, never authored. */
  doc: unknown;
  builtAt: number;
  sv: 1;
}

/**
 * Append-only practice log. Nothing in v1 reads these for display (§0.0 A4) — they exist so
 * that v1.1's progress model is a recomputeAll() rather than a rewrite. ADR-0006.
 */
export interface RepRecord {
  id: string;
  docId: string;
  roleSetHash: string;
  chunkKey: string;
  at: number;
  methodId: MethodId;
  ladderIndex: number | null;
  customPercent: number | null;
  maskedCount: number;
  candidateCount: number;
  peeks: number;
  reveals: number;
  durationMs: number;
  sv: 1;
}

export interface OffbookDB extends DBSchema {
  meta: { key: string; value: MetaRow };
  settings: { key: string; value: SettingRow };
  folders: { key: string; value: FolderRecord; indexes: { 'by-sort': string } };
  documents: {
    key: string;
    value: DocumentRecord;
    indexes: {
      'by-folder': string;
      'by-practised': number;
      'by-updated': number;
      'by-title': string;
    };
  };
  docText: { key: string; value: DocTextRecord };
  derived: { key: string; value: DerivedRecord };
  reps: {
    key: string;
    value: RepRecord;
    indexes: { 'by-at': number; 'by-doc-at': [string, number] };
  };
}
