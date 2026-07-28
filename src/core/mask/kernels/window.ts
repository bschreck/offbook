/**
 * The window kernel. PLAN.md §8.5 method 9.
 *
 * Pure index arithmetic over "units" — chunks or lines. The window post-pass in plan.ts is one
 * of only two passes that run AFTER selection (§8.4 fix A); everything else is a candidate filter.
 */

import { clamp } from '../../util/assert';

export interface WindowLayout {
  /** [focusStart, focusEnd) — the units the inner method masks. */
  focusStart: number;
  focusEnd: number;
  /** [dimStart, dimEnd) — the focus plus its lookback/lookahead shoulders. */
  dimStart: number;
  dimEnd: number;
}

export function computeWindow(
  unitCount: number,
  index: number,
  windowSize: number,
  lookback: number,
  lookahead: number,
): WindowLayout {
  if (unitCount <= 0) return { focusStart: 0, focusEnd: 0, dimStart: 0, dimEnd: 0 };
  const size = clamp(Math.round(windowSize), 1, unitCount);
  const start = clamp(Math.round(index), 0, unitCount - size);
  const end = start + size;
  return {
    focusStart: start,
    focusEnd: end,
    dimStart: clamp(start - Math.max(0, Math.round(lookback)), 0, unitCount),
    dimEnd: clamp(end + Math.max(0, Math.round(lookahead)), 0, unitCount),
  };
}

export function inRange(value: number, start: number, end: number): boolean {
  return value >= start && value < end;
}
