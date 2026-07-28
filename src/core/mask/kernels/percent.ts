/**
 * The percent kernel. PLAN.md §8.4, §8.5 methods 1, 2, 6, 7, 9, 10.
 *
 * Everything here is rung-independent by construction: the random rank of a token does not
 * depend on the ladder index, on how many candidates there are, or on which candidates were
 * filtered out. That is what makes `masked(L_n) ⊆ masked(L_{n+1})` hold (§8.4).
 */

import type { Token } from '../../text/types';
import { clamp } from '../../util/assert';
import type { Rng } from '../rng';

/**
 * k for a density p over n candidates. §8.4 fix B.
 *
 * The `Math.max(1, …)` floor is load-bearing: without it a 5-word lyric line rounds to 0
 * masked words at 10% and 20%, the step-up gate can never be satisfied, and the rung is
 * unreachable except by stepping up from it. Deadlock, on the default chunking for lyrics.
 */
export function computeK(p: number, n: number): number {
  if (n <= 0 || p <= 0) return 0;
  return clamp(Math.max(1, Math.round(p * n)), 0, n);
}

/** §7.4: `isContent = t.kind !== 'punct' && !t.isFunction`. */
export function isContentToken(t: Token): boolean {
  return t.kind !== 'punct' && !t.isFunction;
}

/**
 * One random value per TOKEN INDEX — deliberately not "per k-th candidate" as §8.4's sketch
 * has it. Ranking by candidate ordinal makes the whole permutation shift whenever a filter
 * changes the candidate set, and `Protect` changes it between rungs 2/3, 3/4 and 4/5. Ranking
 * by token index means a filtered set is always an order-preserving subsequence of a larger one.
 */
export function randomRanks(count: number, rng: Rng): Float64Array {
  const ranks = new Float64Array(count);
  for (let i = 0; i < count; i++) ranks[i] = rng();
  return ranks;
}

export function orderByRank(candidates: readonly number[], ranks: Float64Array): number[] {
  return [...candidates].sort((a, b) => {
    const d = (ranks[a] ?? 0) - (ranks[b] ?? 0);
    return d !== 0 ? d : a - b;
  });
}

/** §8.5 method 6. Higher value = higher information = masked earlier. */
export function keywordValue(t: Token): number {
  return (
    3.0 * (t.isProperish ? 1 : 0) +
    2.5 * (t.hasDigit ? 1 : 0) +
    (t.count === 1 ? 1 : 0) +
    Math.min(t.letterCount, 12) / 6 -
    0.6 * (t.count >= 4 ? 1 : 0)
  );
}

/** Descending `value`, ties broken by the seeded rank so `keyWords` is still reshuffleable. */
export function orderByValue(
  candidates: readonly number[],
  tokens: readonly Token[],
  ranks: Float64Array,
): number[] {
  const value = new Map<number, number>();
  for (const i of candidates) {
    const t = tokens[i];
    if (t) value.set(i, keywordValue(t));
  }
  return [...candidates].sort((a, b) => {
    const dv = (value.get(b) ?? 0) - (value.get(a) ?? 0);
    if (dv !== 0) return dv;
    const dr = (ranks[a] ?? 0) - (ranks[b] ?? 0);
    return dr !== 0 ? dr : a - b;
  });
}

/**
 * §8.4 fix C. Derived once per (method, document) from the median line length and NEVER from
 * the rung — a rung-dependent gap changes the total order between rungs and destroys nesting.
 */
export function deriveMinGap(lineWordCounts: readonly number[]): number {
  if (lineWordCounts.length === 0) return 1;
  const sorted = [...lineWordCounts].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return median >= 8 ? 2 : 1;
}

/**
 * The spacing pass (§8.4). Adjacent blanks at low density are disproportionately hard and read
 * as damage, so accept a candidate only when no already-accepted candidate sits within `minGap`
 * word positions on the same line; rejects go to a deferred queue replayed at `minGap - 1`,
 * then 0.
 *
 * The output is a single TOTAL ORDER over the candidates, not a per-rung selection. That is the
 * whole point: every rung takes a prefix of the same order, so prefix-consistency survives.
 */
export function spacingPass(
  order: readonly number[],
  lineIdxOf: Int32Array,
  wordPosOf: Int32Array,
  minGap: number,
): number[] {
  if (minGap <= 1) return [...order];

  const accepted: number[] = [];
  const takenByLine = new Map<number, number[]>();

  const fits = (tok: number, gap: number): boolean => {
    if (gap <= 0) return true;
    const taken = takenByLine.get(lineIdxOf[tok] ?? -1);
    if (taken === undefined) return true;
    const pos = wordPosOf[tok] ?? 0;
    for (const other of taken) if (Math.abs(other - pos) < gap) return false;
    return true;
  };

  const accept = (tok: number): void => {
    accepted.push(tok);
    const line = lineIdxOf[tok] ?? -1;
    const taken = takenByLine.get(line);
    if (taken === undefined) takenByLine.set(line, [wordPosOf[tok] ?? 0]);
    else taken.push(wordPosOf[tok] ?? 0);
  };

  let deferred: number[] = [];
  for (const tok of order) {
    if (fits(tok, minGap)) accept(tok);
    else deferred.push(tok);
  }
  for (let gap = minGap - 1; gap >= 0 && deferred.length > 0; gap--) {
    const still: number[] = [];
    for (const tok of deferred) {
      if (fits(tok, gap)) accept(tok);
      else still.push(tok);
    }
    deferred = still;
  }
  // gap 0 accepts everything, so this is empty in practice; concat keeps the function total.
  return accepted.concat(deferred);
}
