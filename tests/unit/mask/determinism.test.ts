/**
 * Determinism and the seed. PLAN.md §8.4.
 *
 * The same (doc, spec) must produce a byte-identical plan on every device, forever — masking is
 * persisted only as a seed plus a rung, so a drifting permutation would silently invalidate
 * every `Rep` ever logged.
 */

import { describe, expect, it } from 'vitest';
import { computeMaskPlan } from '../../../src/core/mask/plan';
import { maskSeed, rngFromSeed, sfc32 } from '../../../src/core/mask/rng';
import { LADDER_LENGTH, METHOD_IDS } from '../../../src/core/mask/types';
import { isSubset, lyricDoc, makeSpec, maskedSet, sceneDoc } from './fixture';

describe('determinism', () => {
  const doc = sceneDoc();

  it('produces a byte-identical styles array across 100 repeats', () => {
    const spec = makeSpec('hideWords', { ladderIndex: 3 });
    const reference = computeMaskPlan(doc, spec).styles;
    for (let repeat = 0; repeat < 100; repeat++) {
      const again = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: 3 })).styles;
      expect(again).toEqual(reference);
    }
  });

  it('is identical for every method at every rung across repeats', () => {
    for (const methodId of METHOD_IDS) {
      for (let rung = 0; rung < LADDER_LENGTH; rung++) {
        const first = computeMaskPlan(doc, makeSpec(methodId, { ladderIndex: rung }));
        const second = computeMaskPlan(doc, makeSpec(methodId, { ladderIndex: rung }));
        expect(second.styles).toEqual(first.styles);
        expect(second.lineFlags).toEqual(first.lineFlags);
        expect(second.maskedCount).toBe(first.maskedCount);
        expect(second.candidateCount).toBe(first.candidateCount);
        expect(second.contentMaskedCount).toBe(first.contentMaskedCount);
      }
    }
  });

  it('depends on the document id, so two documents never share a permutation', () => {
    const other = sceneDoc();
    // same content, different id: the seed changes, so the selection must change
    const twin = { ...other, id: 'scene-copy' };
    const a = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: 2 }));
    const b = computeMaskPlan(twin, makeSpec('hideWords', { ladderIndex: 2 }));
    expect(a.maskedCount).toBe(b.maskedCount);
    expect([...maskedSet(a.styles)]).not.toEqual([...maskedSet(b.styles)]);
  });
});

describe('reshuffle', () => {
  const doc = sceneDoc();

  it('changes the selection at the same rung without changing k', () => {
    const before = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: 3, reshuffle: 0 }));
    const after = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: 3, reshuffle: 1 }));
    expect(after.maskedCount).toBe(before.maskedCount);
    expect([...maskedSet(after.styles)]).not.toEqual([...maskedSet(before.styles)]);
  });

  it('is never a no-op for the line-level methods either — phase drives those', () => {
    const before = computeMaskPlan(doc, makeSpec('hideLines', { ladderIndex: 3, phase: 0 }));
    const after = computeMaskPlan(doc, makeSpec('hideLines', { ladderIndex: 3, phase: 1 }));
    expect(after.maskedCount).toBeGreaterThan(0);
    expect([...maskedSet(after.styles)]).not.toEqual([...maskedSet(before.styles)]);
  });
});

describe('the ladder index is NOT in the seed', () => {
  const doc = lyricDoc();

  it('two rungs share the prefix of one permutation', () => {
    // If the rung were seeded, rung 2 and rung 4 would be independent permutations and the
    // smaller set would only be a subset of the larger by coincidence.
    const low = maskedSet(computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: 2 })).styles);
    const high = maskedSet(computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: 4 })).styles);
    expect(low.size).toBeGreaterThan(0);
    expect(high.size).toBeGreaterThan(low.size);
    expect(isSubset(low, high)).toBe(true);
  });

  it('the seed string itself contains no rung', () => {
    const seed = maskSeed('doc1', 'hideWords', 'all', 'text', 3);
    expect(seed).toBe('doc1|hideWords|all|text|3');
    expect(seed).not.toMatch(/ladder|rung/i);
  });

  it('sfc32 is stable for a fixed seed', () => {
    const a = rngFromSeed('offbook');
    const b = rngFromSeed('offbook');
    for (let i = 0; i < 32; i++) expect(a()).toBe(b());
    const manual = sfc32(1, 2, 3, 4);
    expect(manual()).toBeGreaterThanOrEqual(0);
    expect(manual()).toBeLessThan(1);
  });
});

describe('reveals', () => {
  const doc = sceneDoc();

  it('clears a revealed token without changing the counts', () => {
    const base = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: 4 }));
    const first = [...maskedSet(base.styles)][0] ?? 0;
    const revealed = computeMaskPlan(
      doc,
      makeSpec('hideWords', {
        ladderIndex: 4,
        reveals: { peeked: null, revealed: new Set([first]), revealAll: false },
      }),
    );
    expect(revealed.styles[first]).toBe(0);
    // maskedCount is helpRate's denominator (§8.7); revealing must not shrink it.
    expect(revealed.maskedCount).toBe(base.maskedCount);
  });

  it('revealAll clears everything', () => {
    const plan = computeMaskPlan(
      doc,
      makeSpec('hideWords', {
        ladderIndex: 6,
        reveals: { peeked: null, revealed: new Set<number>(), revealAll: true },
      }),
    );
    expect(maskedSet(plan.styles).size).toBe(0);
    expect(plan.maskedCount).toBeGreaterThan(0);
  });

  it('a peek clears exactly one token', () => {
    const base = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: 4 }));
    const target = [...maskedSet(base.styles)][2] ?? 0;
    const peeked = computeMaskPlan(
      doc,
      makeSpec('hideWords', {
        ladderIndex: 4,
        reveals: { peeked: target, revealed: new Set<number>(), revealAll: false },
      }),
    );
    expect(peeked.styles[target]).toBe(0);
    expect(maskedSet(peeked.styles).size).toBe(maskedSet(base.styles).size - 1);
  });
});
