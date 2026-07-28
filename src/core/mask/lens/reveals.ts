/**
 * Reveals. PLAN.md §8.4 — one of only two post-passes.
 *
 * Reveals mutate `styles` but deliberately NOT the counts. `maskedCount` is the help-rate
 * denominator (§8.7); if it shrank every time the user revealed a word, `helpRate` would climb
 * towards 1 by construction and two peeks on a short scope would read as a total failure.
 */

import type { ModeSpec } from '../types';

export function applyReveals(styles: Uint8Array, reveals: ModeSpec['reveals']): void {
  if (reveals.revealAll) {
    styles.fill(0);
    return;
  }
  for (const i of reveals.revealed) {
    if (Number.isInteger(i) && i >= 0 && i < styles.length) styles[i] = 0;
  }
  const peeked = reveals.peeked;
  if (peeked !== null && peeked >= 0 && peeked < styles.length) styles[peeked] = 0;
}
