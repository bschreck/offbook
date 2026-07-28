/**
 * The pipeline: sourceText -> clean -> sniff -> structure -> tokenize -> flags -> chunk.
 *
 * This is the only place the six text modules are composed, and it is pure: the same
 * (sourceText, config, overrides) always produces the same Document. That is what lets the
 * derived form be a throwaway cache (`derived` store) while `sourceText` stays the single
 * immutable source of truth.
 */

import { chunkDocument } from './chunk';
import { cleanForSniff, runCleanup } from './clean/pipeline';
import { deriveTokenFlags } from './derive-flags';
import { applyStructureOverrides } from './overrides';
import { buildRoles } from './roles';
import { sniffDocument } from './sniff';
import { detectStructure, type StructureInputLine } from './structure';
import { tokenizeLines } from './tokenize';
import type {
  BlockType,
  ChunkStrategy,
  CleanupConfig,
  DocKind,
  Document,
  StructureOverride,
} from './types';

export interface DeriveInput {
  id: string;
  /** Immutable import text. */
  sourceText: string;
  /** The one free-text override. When set it replaces `sourceText` as the pipeline input. */
  manualText?: string | null;
  cleanupConfig: CleanupConfig;
  structureOverrides?: readonly StructureOverride[];
  /** User overrides for the sniffed values. */
  kind?: DocKind;
  lang?: string;
  chunkStrategy?: ChunkStrategy;
  chunkTargetWords?: number;
  manualChunkBreaks?: readonly string[];
  /** Set when the extractor harvested real geometry (PDF); boosts the cue detector. */
  hasGeometry?: boolean;
}

export interface DeriveResult {
  doc: Document;
  /** Per-rule change counts, for the cleanup sheet's live counters. */
  cleanupReport: ReturnType<typeof runCleanup>['perRule'];
  sniffed: { kind: DocKind; lang: string; confidence: number; signals: string[] };
}

/**
 * Bump when any stage's output changes shape or content for the same input. Documents whose
 * stored `pipelineVersion` differs are re-derived on read, and their chunks re-anchored.
 */
export const PIPELINE_VERSION = 2;

export function deriveDocument(input: DeriveInput): DeriveResult {
  const text = input.manualText ?? input.sourceText;

  // The sniffer sees rules 1-4 only: raw text makes it misread smart quotes and page
  // numbers as signal, but `unwrap` needs the sniff's answer, so it cannot have run yet.
  const sniffed = sniffDocument(cleanForSniff(text));
  const kind = input.kind ?? sniffed.kind;
  const lang = input.lang ?? sniffed.lang;

  // In verse, lyrics and dialogue the line break IS the memorisation scaffold — the
  // position of a line is part of what you remember — so it is never rejoined. Only in
  // continuous prose is a hard wrap merely an artefact of how the text was pasted.
  const lineBreaksAreSemantic = kind === 'script' || kind === 'lyrics' || kind === 'poem';
  const { lines: cleanLines, perRule } = runCleanup(text, input.cleanupConfig, {
    kind,
    lineBreaksAreSemantic,
  });

  const structureInput: StructureInputLine[] = cleanLines.map((t) => ({ text: t }));
  const detected = detectStructure(structureInput, {
    hasGeometry: input.hasGeometry ?? false,
    kind,
  });

  const { blocks, lines } = applyStructureOverrides(
    detected.blocks,
    detected.lines,
    input.structureOverrides ?? [],
  );

  const blockTypes: BlockType[] = [];
  for (const b of blocks) blockTypes[b.idx] = b.type;

  const perLine = tokenizeLines(
    lines.map((l) => l.text),
    lang,
    { blockIdxs: lines.map((l) => l.blockIdx) },
  );

  const tokens = perLine.flat();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line) line.tokens = perLine[i] ?? [];
  }

  deriveTokenFlags(tokens, { lang, blockTypes });

  const chunks = chunkDocument(
    lines,
    blocks,
    input.chunkStrategy ?? 'auto',
    input.chunkTargetWords ?? 0,
    new Set(input.manualChunkBreaks ?? []),
    { kind, lang },
  );

  // Tokens carry their chunk so masking can scope to one chunk without a lookup per token.
  for (const chunk of chunks) {
    const [from, to] = chunk.tokenRange;
    for (let i = from; i < to; i++) {
      const t = tokens[i];
      if (t) t.chunkIdx = chunk.idx;
    }
  }

  const roles = buildRoles(blocks, lines);

  let wordCount = 0;
  for (const t of tokens) if (t.kind === 'word' || t.kind === 'number') wordCount++;

  const doc: Document = {
    id: input.id,
    kind,
    lang,
    blocks,
    lines,
    tokens,
    chunks,
    roles,
    wordCount,
    charCount: text.length,
  };

  return { doc, cleanupReport: perRule, sniffed };
}
