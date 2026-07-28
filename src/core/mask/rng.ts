import { cyrb128 } from '../util/hash';

/**
 * Deterministic RNG for masking. PLAN.md §8.4.
 *
 * Masking must be reproducible: the same document at the same rung with the same reshuffle
 * counter always hides the same words, on every device, forever. Math.random() is banned
 * in src/core/mask/** for exactly this reason.
 */

export type Rng = () => number;

/** sfc32 — small, fast, statistically fine for choosing which words to hide. */
export function sfc32(a: number, b: number, c: number, d: number): Rng {
  let s0 = a >>> 0;
  let s1 = b >>> 0;
  let s2 = c >>> 0;
  let s3 = d >>> 0;
  return () => {
    s0 |= 0;
    s1 |= 0;
    s2 |= 0;
    s3 |= 0;
    const t = (((s0 + s1) | 0) + s3) | 0;
    s3 = (s3 + 1) | 0;
    s0 = s1 ^ (s1 >>> 9);
    s1 = (s2 + (s2 << 3)) | 0;
    s2 = (s2 << 21) | (s2 >>> 11);
    s2 = (s2 + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export function rngFromSeed(seedString: string): Rng {
  const [a, b, c, d] = cyrb128(seedString);
  return sfc32(a, b, c, d);
}

/**
 * The mask seed. NOTE what is absent: the ladder index.
 *
 * Leaving the rung out of the seed is what makes the ladder *nest* — one permutation is
 * generated per (doc, method, roles, scope, reshuffle) and each rung takes a longer prefix
 * of it. Stepping from 20% to 45% therefore ADDS blanks rather than swapping them, which is
 * the difference between "progress" and "damage" (§8.4, §2.2).
 */
export function maskSeed(
  docId: string,
  methodId: string,
  roleSetHash: string,
  scopeKey: string,
  reshuffle: number,
): string {
  return `${docId}|${methodId}|${roleSetHash}|${scopeKey}|${reshuffle}`;
}
