/**
 * The role-isolation lens. PLAN.md §7.8 and §8.4 fix A.
 *
 * Like Protect, this is a candidate FILTER, not a post-pass. With a 40-of-500-word role,
 * filtering after selection makes `k = round(0.10 × 500) = 50` land ~4 picks on your lines with
 * a variance of 0 to 9 — so the delivered density is not the requested one and the help-rate
 * denominator, the number the whole ladder is driven by, is pure noise.
 */

import type { Document, Token } from '../../text/types';
import { fnv1a } from '../../util/hash';

export function roleOfToken(doc: Document, t: Token): string | null {
  return doc.blocks[t.blockIdx]?.speakerId ?? null;
}

/** §7.8: an empty role set means "everything maskable", not "nothing". */
export function isMine(doc: Document, t: Token, myRoleIds: readonly string[]): boolean {
  if (myRoleIds.length === 0) return true;
  const role = roleOfToken(doc, t);
  return role !== null && myRoleIds.includes(role);
}

/**
 * Lines belonging to someone else. These are cues: they must stay readable or they cannot cue
 * you, so the plan only FLAGS them. How a cue is presented — full, last-n-words tail, or
 * collapsed — is `cueStyle` in the ModeSpec and is the renderer's job (§7.8's three view modes
 * are view modes, not maskings). Keeping cue tokens out of `styles` is also what keeps
 * `maskedCount` honest for an actor with 40 of 500 words.
 */
export function cueLineSet(doc: Document, myRoleIds: readonly string[]): Set<number> {
  const cues = new Set<number>();
  if (myRoleIds.length === 0) return cues;
  for (const line of doc.lines) {
    const block = doc.blocks[line.blockIdx];
    if (block === undefined || block.type !== 'dialogue') continue;
    if (block.speakerId === null || !myRoleIds.includes(block.speakerId)) cues.add(line.idx);
  }
  return cues;
}

/** §7.8: `roleSetHash = hash(sorted(myRoleIds)) || 'all'`. Part of the mask seed. */
export function roleSetHash(myRoleIds: readonly string[]): string {
  if (myRoleIds.length === 0) return 'all';
  return fnv1a([...myRoleIds].sort().join('|'));
}
