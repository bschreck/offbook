/**
 * Manual structure corrections. PLAN.md §7.5 ("manual correction is built before heuristic
 * polish").
 *
 * Overrides are anchored by `Line.fingerprint`, never by index, so a fix the user made on
 * page 40 survives an edit on page 2 and survives a re-clean of the whole document.
 */

import { isAllCapsText, type LineSignal, lineSignalOf } from './structure';
import type { Block, BlockType, Line, StructureOverride } from './types';

export interface OverrideResult {
  blocks: Block[];
  lines: Line[];
}

/** Confidence stamped on anything the user touched, so the review UI stops flagging it. */
const USER_CONFIRMED_CONFIDENCE = 1;

interface LineAttrs {
  type: BlockType;
  speakerId: string | null;
  speakerLabel: string | null;
  confidence: number;
  /** Original block, so an override never welds two separate speeches together. */
  originBlockIdx: number;
}

function attrsFromBlocks(blocks: readonly Block[], lineCount: number): (LineAttrs | null)[] {
  const attrs: (LineAttrs | null)[] = new Array(lineCount).fill(null);
  for (const block of blocks) {
    for (const lineIdx of block.lineIdxs) {
      if (lineIdx < 0 || lineIdx >= lineCount) continue;
      attrs[lineIdx] = {
        type: block.type,
        speakerId: block.speakerId,
        speakerLabel: block.speakerLabel,
        confidence: block.confidence,
        originBlockIdx: block.idx,
      };
    }
  }
  return attrs;
}

/**
 * Apply fingerprint-anchored overrides and regroup. Regrouping happens strictly *within*
 * each original block: a per-line correction may split a block, but two blocks are never
 * merged, because the block boundary is the speech boundary the chunker depends on (§7.7).
 */
export function applyStructureOverrides(
  blocks: readonly Block[],
  lines: readonly Line[],
  overrides: readonly StructureOverride[],
): OverrideResult {
  const byFingerprint = new Map<string, number>();
  for (const line of lines) {
    if (!byFingerprint.has(line.fingerprint)) byFingerprint.set(line.fingerprint, line.idx);
  }

  const attrs = attrsFromBlocks(blocks, lines.length);

  for (const override of overrides) {
    // `chunkBreak` is not a structure change; the chunker reads it directly (§7.7).
    if (override.kind === 'chunkBreak') continue;
    const idx = byFingerprint.get(override.fingerprint);
    if (idx === undefined) continue;
    const a = attrs[idx];
    if (!a) continue;

    if (override.kind === 'lineType') {
      a.type = override.type;
      // A heading belongs to no one; every other type can legitimately carry a speaker
      // (a parenthetical inside MARY's speech is still MARY's).
      if (override.type === 'heading') {
        a.speakerId = null;
        a.speakerLabel = null;
      }
    } else {
      if (a.speakerId !== override.speakerId) a.speakerLabel = null;
      a.speakerId = override.speakerId;
    }
    a.confidence = USER_CONFIRMED_CONFIDENCE;
  }

  const outBlocks: Block[] = [];
  const outLines: Line[] = [];
  let openOrigin = -1;

  for (const line of lines) {
    const a = attrs[line.idx];
    if (!a) continue;
    const open = outBlocks.at(-1);
    const startNew =
      open === undefined ||
      openOrigin !== a.originBlockIdx ||
      open.type !== a.type ||
      open.speakerId !== a.speakerId ||
      open.speakerLabel !== a.speakerLabel;

    const idx = outLines.length;
    if (startNew) {
      outBlocks.push({
        idx: outBlocks.length,
        type: a.type,
        speakerId: a.speakerId,
        speakerLabel: a.speakerLabel,
        lineIdxs: [idx],
        confidence: a.confidence,
      });
    } else {
      open.lineIdxs.push(idx);
      open.confidence = Math.min(open.confidence, a.confidence);
    }
    openOrigin = a.originBlockIdx;
    outLines.push({ ...line, idx, blockIdx: outBlocks.at(-1)?.idx ?? 0 });
  }

  return { blocks: outBlocks, lines: outLines };
}

// ---------------------------------------------------------------- apply to all

export type CasingClass = 'allcaps' | 'titlecase' | 'lower' | 'other';

/**
 * §7.5: "apply to all like this" generalises on the signal that actually misfired —
 * same detector signal, same casing, same indent bucket.
 */
export interface LineShape {
  signal: LineSignal;
  casing: CasingClass;
  indentEm: number;
}

function casingOf(text: string): CasingClass {
  if (isAllCapsText(text)) return 'allcaps';
  if (!/\p{Lu}/u.test(text) && /\p{Ll}/u.test(text)) return 'lower';
  const alphaWords = text.split(/\s+/u).filter((w) => /\p{L}/u.test(w));
  if (alphaWords.length > 0 && alphaWords.every((w) => /^[^\p{L}]*\p{Lu}/u.test(w))) {
    return 'titlecase';
  }
  return 'other';
}

export function lineShape(line: Pick<Line, 'text' | 'indentEm'>): LineShape {
  return {
    signal: lineSignalOf(line.text),
    casing: casingOf(line.text),
    indentEm: line.indentEm,
  };
}

export function sameShape(a: LineShape, b: LineShape): boolean {
  return a.signal === b.signal && a.casing === b.casing && a.indentEm === b.indentEm;
}

/**
 * Given one line the user reclassified, produce the overrides for every line of the same
 * shape — including the exemplar. The caller shows `result.length` before applying, and the
 * whole array is one undo step.
 */
export function overridesForApplyToAll(
  lines: readonly Line[],
  exemplarFingerprint: string,
  type: BlockType,
): StructureOverride[] {
  const exemplar = lines.find((l) => l.fingerprint === exemplarFingerprint);
  if (!exemplar) return [];
  const target = lineShape(exemplar);
  return lines
    .filter((line) => sameShape(lineShape(line), target))
    .map((line) => ({ kind: 'lineType', fingerprint: line.fingerprint, type }));
}
