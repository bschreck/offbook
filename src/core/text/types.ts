/**
 * The document model. PLAN.md §7.4 (tokenize) and §7.7 (chunk).
 *
 * FROZEN CONTRACT. Every core module codes against these shapes. Changing a field here
 * is a change to eight files and, if it is persisted, a schema migration.
 *
 * Pure types only — no React, no DOM, no idb (enforced by the layering test).
 */

// ---------------------------------------------------------------- tokens

export type TokenKind = 'word' | 'number' | 'punct' | 'direction' | 'label';

export interface Token {
  /** Global index. THE stable identifier for masking — every MaskPlan is indexed by this. */
  i: number;
  /** Word core: "don't", "mother-in-law", "1,200", "café", "—". */
  text: string;
  /** Leading punctuation peeled off the core: '"', '(', '¿'. Never masked. */
  lead: string;
  /** Trailing punctuation: '.', '?!', '..."'. Never masked. */
  trail: string;
  /** The exact whitespace immediately BEFORE `lead`. Never lost. */
  ws: string;
  kind: TokenKind;
  /** Graphemes bearing \p{L}. Never `.length` — Vietnamese, Devanagari, emoji ZWJ. */
  letterCount: number;
  /** Per-segment counts for hyphenates: [6,2,3] for mother-in-law. */
  letterGroups: number[];
  /** Grapheme-safe first letter, used by the `initial` mask style. */
  firstLetter: string;
  /** NFD, marks stripped, lowercased, apostrophes unified. The key for counting/lookup. */
  normalized: string;

  lineIdx: number;
  blockIdx: number;
  chunkIdx: number;
  sentIdx: number;
  posInLine: number;
  lineLen: number;
  posInSent: number;
  sentLen: number;

  // Derived flags — computed in ONE pass after tokenizing, never by a second tokenizer.
  isFunction: boolean;
  isProperish: boolean;
  hasDigit: boolean;
  /** Occurrences of `normalized` across the document (hapax scoring). */
  count: number;
  /** kind ∈ {word,number} && block type ∈ {dialogue,paragraph,verse}. */
  isMaskable: boolean;
}

// ---------------------------------------------------------------- lines & blocks

export type BlockType =
  | 'dialogue'
  | 'direction'
  | 'heading'
  | 'paragraph'
  | 'verse'
  | 'label';

export interface Line {
  idx: number;
  blockIdx: number;
  /** Exact source text of the line. The reconstruction invariant is asserted against this. */
  text: string;
  tokens: Token[];
  /** Content hash of the normalized line — anchors cursors and annotations across edits. */
  fingerprint: string;
  /** Leading indent in ems, preserved for verse. */
  indentEm: number;
}

export interface Block {
  idx: number;
  type: BlockType;
  /** Speaker for `dialogue` blocks; null otherwise. */
  speakerId: string | null;
  /** The cue text as written ("HAMLET", "Hamlet:"), kept for faithful rendering. */
  speakerLabel: string | null;
  lineIdxs: number[];
  /** Detector confidence 0..1. Below CUE_CONFIDENCE_FLOOR the structure editor flags it. */
  confidence: number;
}

export interface Role {
  id: string;
  label: string;
  aliases: string[];
  colorIndex: number;
  isEnsemble: boolean;
  lineCount: number;
  wordCount: number;
  firstLineIndex: number;
}

// ---------------------------------------------------------------- chunks

export type ChunkStrategy = 'auto' | 'line' | 'sentence' | 'speech' | 'block';

export interface Chunk {
  idx: number;
  /** Content-hash identity (§7.7). Survives typo fixes and re-imports; ordinal breaks ties. */
  key: string;
  lineIdxs: number[];
  tokenRange: [number, number];
  wordCount: number;
  speakerId: string | null;
}

// ---------------------------------------------------------------- document

export type DocKind = 'script' | 'lyrics' | 'speech' | 'poem' | 'lesson' | 'other';

/**
 * The derived, in-memory document. Rebuilt from `sourceText` + cleanupConfig +
 * structureOverrides whenever `pipelineVersion` changes; never itself the source of truth.
 */
export interface Document {
  id: string;
  kind: DocKind;
  lang: string;
  blocks: Block[];
  lines: Line[];
  /** Flat token array. `tokens[i].i === i` always. */
  tokens: Token[];
  chunks: Chunk[];
  roles: Role[];
  wordCount: number;
  charCount: number;
}

// ---------------------------------------------------------------- cleanup & overrides

export interface CleanupConfig {
  /** NFC + smart-quote/dash normalisation. Always on; the tokenizer asserts NFC. */
  normalise: boolean;
  /** Straighten curly quotes and apostrophes. */
  punctuation: boolean;
  /** Collapse runs of spaces, strip trailing spaces, cap blank runs at one. */
  whitespace: boolean;
  /** Drop page numbers, running headers/footers, line numbers. */
  dropArtifacts: boolean;
  /** Rejoin lines hard-wrapped mid-sentence (prose only; never for verse). */
  unwrap: boolean;
}

export const DEFAULT_CLEANUP: CleanupConfig = {
  normalise: true,
  punctuation: true,
  whitespace: true,
  dropArtifacts: true,
  unwrap: false,
};

export type StructureOverride =
  | { kind: 'lineType'; fingerprint: string; type: BlockType }
  | { kind: 'speaker'; fingerprint: string; speakerId: string | null }
  | { kind: 'chunkBreak'; fingerprint: string };

// ---------------------------------------------------------------- language

export type ScriptFamily = 'latin' | 'cyrillic' | 'greek' | 'cjk' | 'rtl' | 'other';

export interface LanguageProfile {
  lang: string;
  family: ScriptFamily;
  hasFunctionWords: boolean;
  /** Methods this script cannot support — see the §7.4 table. */
  hiddenMethods: string[];
}
