/**
 * The line-level kernel. PLAN.md §8.5 method 5, and §8.4 fix D.
 *
 * `hideLines` is a seeded NESTED PERMUTATION OF LINES, not an alternation. The design doc's
 * `period 4 → 3 → 2` ladder hid line ordinal 4 at L1, showed it at L2 and hid it again at L4 —
 * a mode that shipped by default for songs and that fails the conformance suite's most
 * important test.
 */

import type { Document } from '../../text/types';

const LINE_MASKABLE_BLOCKS: ReadonlySet<string> = new Set(['dialogue', 'paragraph', 'verse']);

/**
 * Lines eligible to be hidden: at least one candidate token, in a block type that carries text
 * the user is memorising. Headings and stage directions are structure and always stay visible.
 */
export function eligibleLineIndices(
  doc: Document,
  candidatesByLine: ReadonlyMap<number, number[]>,
): number[] {
  const out: number[] = [];
  for (const line of doc.lines) {
    const block = doc.blocks[line.blockIdx];
    if (block === undefined || !LINE_MASKABLE_BLOCKS.has(block.type)) continue;
    const candidates = candidatesByLine.get(line.idx);
    if (candidates === undefined || candidates.length === 0) continue;
    out.push(line.idx);
  }
  return out;
}
