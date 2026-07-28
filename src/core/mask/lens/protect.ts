/**
 * Protect. PLAN.md §8.4 fix A.
 *
 * Protect is a CANDIDATE FILTER applied BEFORE k is computed — never a post-pass. Ordering it
 * after selection produced three bugs at once: exact cardinality became impossible, the
 * percentage in the UI stopped being the density delivered, and the help-rate denominator
 * turned into noise.
 */

import type { Document, Token } from '../../text/types';

/**
 * §8.4. Actors lose the *rhythm* of a line, not its content, when these vanish, so they are
 * held back until the rung is high enough that the rhythm is already internalised.
 */
export const INTERJECTIONS: ReadonlySet<string> = new Set([
  'oh',
  'ah',
  'well',
  'hey',
  'hm',
  'hmm',
  'huh',
  'ugh',
  'wow',
  'yeah',
  'yes',
  'no',
  'please',
  'look',
  'listen',
  'now',
  'why',
]);

const STRUCTURAL_BLOCKS: ReadonlySet<string> = new Set(['direction', 'heading', 'label']);

export interface ProtectConfig {
  /** First word of each line, at rungs ≤ 2. */
  firstWord: boolean;
  /** Interjections, at rungs ≤ 3. Default on for scripts, off for prose. */
  interjections: boolean;
  /** Numbers, at rungs ≤ 4. */
  numbers: boolean;
}

/**
 * The Protect set only changes at three rung boundaries, so there are only four distinct
 * candidate sets per document. Bucketing them lets plan.ts build the cumulative pick order in
 * four passes instead of seven, and makes "did the candidate set change?" a cheap equality test.
 *
 * bucket 0 = rungs 0–2 | 1 = rung 3 | 2 = rung 4 | 3 = rungs 5–6.
 */
export function protectBucket(rung: number): number {
  if (rung <= 2) return 0;
  if (rung === 3) return 1;
  if (rung === 4) return 2;
  return 3;
}

/** Speaker labels, stage directions and headings are protected at every rung, always. */
export function isStructuralToken(doc: Document, t: Token): boolean {
  if (t.kind === 'direction' || t.kind === 'label') return true;
  const block = doc.blocks[t.blockIdx];
  return block !== undefined && STRUCTURAL_BLOCKS.has(block.type);
}

export function isProtected(
  doc: Document,
  t: Token,
  bucket: number,
  cfg: ProtectConfig,
  firstWordOfLine: Int32Array,
): boolean {
  if (isStructuralToken(doc, t)) return true;
  if (cfg.firstWord && bucket === 0 && firstWordOfLine[t.lineIdx] === t.i) return true;
  if (cfg.interjections && bucket <= 1 && INTERJECTIONS.has(t.normalized)) return true;
  if (cfg.numbers && bucket <= 2 && (t.kind === 'number' || t.hasDigit)) return true;
  return false;
}
