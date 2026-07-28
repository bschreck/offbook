/**
 * The backup file format. PLAN.md §11.8 (backup) over the records of §6.2.
 *
 * This is the app's only escape hatch — there is no cloud sync — so the format is
 * defined here once and both the writer (export.ts) and the reader (validate.ts)
 * code against it.
 *
 * Three rules from §11.8 are structural, not incidental:
 *  1. `derived` is NEVER exported. It is a pure cache and a stale index is a hazard;
 *     omitting it is what lets a v1 backup import cleanly into a v5 with a rewritten
 *     tokenizer.
 *  2. No token model, no audio. Audio is excluded in v1 outright (there is none yet,
 *     and base64 would inflate a 200 MB library into a 270 MB file no phone can parse).
 *  3. The format string is `lines.backup` — brand-neutral, from src/brand.ts (§1).
 *     The product name never appears in persisted data.
 *
 * Also absent, by §0.0 A3: `mastery`, `sessions` and `DocumentMeta.progress`. The
 * progress model is deferred, all three are materialized views over `reps`, and `reps`
 * DO round-trip (§0.0 A4) — so nothing recoverable is lost.
 */

import type { BACKUP_FORMAT } from '../../brand';
import type { CleanupConfig, StructureOverride } from '../text/types';
import { fnv1a } from '../util/hash';

/** The current writer version. Bump only when the on-disk shape changes. */
export const CURRENT_FORMAT_VERSION = 1;

/** The oldest format this build can read (directly or via migrate.ts). */
export const MIN_READABLE_FORMAT_VERSION = 1;

/**
 * Ceilings, checked before any per-record work so a hostile or corrupt header cannot
 * make us allocate or loop absurdly. §11.8: "refuse above a tested ceiling with an
 * explanation plus per-document export as the escape hatch".
 */
export const BACKUP_LIMITS = {
  folders: 5_000,
  documents: 20_000,
  docTexts: 20_000,
  reps: 1_000_000,
  settings: 500,
  rolesPerDocument: 200,
  overridesPerDocument: 20_000,
  /** Longest single string we will accept anywhere, including `sourceText`. */
  stringChars: 5_000_000,
  /** Longest array of ids/fingerprints inside one record. */
  innerArray: 100_000,
  /** Canonicalisation recursion guard (the record shapes are far shallower). */
  depth: 32,
} as const;

/** Settings and method params are flat scalars; §6.2 has no object-valued setting. */
export type SettingsValue = string | number | boolean;

// ---------------------------------------------------------------- records

export interface BackupFolder {
  id: string;
  name: string;
  sortName: string;
  color?: string;
  order: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  /** Record shape version (§6.1). Carried through untouched; the data layer migrates on read. */
  sv: number;
}

export interface BackupRole {
  id: string;
  label: string;
  aliases: string[];
  colorIndex: number;
  isEnsemble: boolean;
  lineCount: number;
  wordCount: number;
  firstLineIndex: number;
}

export interface BackupPractisePrefs {
  /**
   * `methodId` and `chunkStrategy` are typed as plain strings on purpose. v1.1 adds
   * methods (see METHOD_IDS in core/mask/types.ts) without bumping the backup format,
   * and rejecting a document because it names a method we have not shipped yet would
   * destroy user data to enforce a type. The data layer falls back on unknown ids.
   */
  methodId: string;
  ladderIndex: number | null;
  customPercent: number | null;
  methodParams: Record<string, SettingsValue>;
  reshuffle: number;
  chunkStrategy: string;
  chunkTargetWords: number;
  manualChunkBreaks: string[];
}

export interface BackupCursor {
  chunkKey: string;
  lineFingerprint: string;
  scrollFraction: number;
  step?: number;
  windowIndex?: number;
  updatedAt: number;
}

export interface BackupSource {
  type: string;
  filename?: string;
  importedAt: number;
}

export interface BackupDocument {
  id: string;
  folderId: string | null;
  title: string;
  sortTitle: string;
  kind: string;
  lang: string;

  textHash: string;
  pipelineVersion: number;
  wordCount: number;
  charCount: number;
  chunkCount: number;

  roles: BackupRole[];
  myRoleIds: string[];
  roleSetHash: string;
  roleView: string;
  cueTailWords: number;

  cleanupConfig: CleanupConfig;
  manualText: string | null;
  structureOverrides: StructureOverride[];

  prefs: BackupPractisePrefs;
  cursor: BackupCursor | null;
  performanceAt: number | null;
  /** IANA zone; mandatory whenever performanceAt is set (§11.9). */
  performanceTz: string | null;
  targetDurationSec: number | null;

  source: BackupSource;
  lastPracticedAt: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  sv: number;
}

export interface BackupDocText {
  docId: string;
  sourceText: string;
  textHash: string;
  sourceMeta?: {
    pdfPages?: number;
    droppedArtifacts?: number;
    parserConfidence?: number;
  };
  updatedAt: number;
}

export interface BackupMaskSpec {
  methodId: string;
  m: number;
  mContent: number;
  kind: string;
  promptVisible: boolean;
}

export interface BackupRep {
  id: string;
  docId: string;
  roleSetHash: string;
  chunkKey: string;
  sessionId: string | null;
  at: number;
  ms: number;
  tzOffsetMin: number;
  clockSuspect?: true;

  mode: string;
  mask: BackupMaskSpec;
  grade: 1 | 2 | 3 | 4;
  stakes: number;

  peeks: number;
  lineReveals: number;
  revealAllUsed: boolean;
  spokenAloud?: boolean;
  score?: number;
  missedTokenIdx?: number[];
  post?: { S: number; D: number; C: number };
}

// ---------------------------------------------------------------- envelope

export interface BackupCounts {
  folders: number;
  documents: number;
  docTexts: number;
  reps: number;
}

/** The five payload arrays/maps. Everything the integrity hash covers. */
export interface BackupPayload {
  folders: BackupFolder[];
  documents: BackupDocument[];
  docTexts: BackupDocText[];
  reps: BackupRep[];
  settings: Record<string, SettingsValue>;
}

export interface Backup extends BackupPayload {
  /** Always `lines.backup`. The discriminator, deliberately not the product name. */
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  /** Semver of the app that wrote the file; diagnostics only, never branched on. */
  appVersion: string;
  /** ISO-8601 UTC. Passed in by the caller — core never reads a clock. */
  createdAt: string;
  /** `meta.installId` of the writing device, or null when the caller withholds it. */
  installId: string | null;
  counts: BackupCounts;
  /** FNV-1a over the canonicalised payload. See `computeIntegrity`. */
  integrity: string;
}

// ---------------------------------------------------------------- integrity

/**
 * Deterministic serialisation: object keys sorted, arrays in order, no whitespace.
 * Returns null past `BACKUP_LIMITS.depth` so a hostile deeply-nested file cannot
 * overflow the stack here (JSON.parse will happily produce one).
 */
export function canonicalize(value: unknown, depth = 0): string | null {
  if (depth > BACKUP_LIMITS.depth) return null;
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const s = canonicalize(item, depth + 1);
      if (s === null) return null;
      parts.push(s);
    }
    return `[${parts.join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const v = record[key];
    if (v === undefined) continue;
    const s = canonicalize(v, depth + 1);
    if (s === null) return null;
    parts.push(`${JSON.stringify(key)}:${s}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Checksum over the payload only, so the envelope (which carries the checksum itself)
 * is not part of what is hashed. This detects the failure §11.8 names — a truncated or
 * corrupted mobile download — and nothing else: FNV-1a is not a security property, and
 * a file whose contents were deliberately rewritten can simply be rehashed.
 *
 * Computed over the payload AS WRITTEN, not over our interpretation of it, so a file
 * from a future version carrying extra record fields still verifies here.
 */
export function computeIntegrity(payload: {
  folders: unknown;
  documents: unknown;
  docTexts: unknown;
  reps: unknown;
  settings: unknown;
}): string | null {
  const canonical = canonicalize({
    folders: payload.folders,
    documents: payload.documents,
    docTexts: payload.docTexts,
    reps: payload.reps,
    settings: payload.settings,
  });
  return canonical === null ? null : fnv1a(canonical);
}

/**
 * Keys that must never be copied out of parsed JSON by assignment. `JSON.parse` happily
 * produces an object with an own `__proto__` key; `out[key] = value` would then hit the
 * prototype setter and pollute `Object.prototype` for the whole app.
 */
export function isForbiddenKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype';
}

/** Matches the output of `new Date().toISOString()`. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isIsoTimestamp(value: string): boolean {
  return ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}
