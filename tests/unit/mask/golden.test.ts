/**
 * The golden file. PLAN.md §8.6.
 *
 * One document, all seven rungs of `hideWords`, frozen as literal style strings so that any
 * accidental change to the permutation, the spacing pass, Protect, or the ladder shows up as a
 * readable diff instead of as a subtly different practice session.
 *
 * Each string is one character per token: the MaskStyle code. Reading down the columns is also
 * the clearest possible demonstration of nesting — a 1 never turns back into a 0.
 *
 * If this test fails, DO NOT regenerate the constants without deciding, deliberately, that the
 * algorithm was meant to change. Every user's masking moves with it.
 */

import { describe, expect, it } from 'vitest';
import { computeMaskPlan } from '../../../src/core/mask/plan';
import { LADDER_LENGTH } from '../../../src/core/mask/types';
import { makeSpec, SCENE_SOURCE, sceneDoc } from './fixture';

const GOLDEN_HIDE_WORDS: readonly string[] = [
  // L0 Read through — 0 of 57 candidates
  '00000000000000000000000000000000000000000000000000000000000000000000000000000000',
  // L1 Stage 2 — 9 of 57
  '00000000000000000010001001000100000100000000000000001000000000000000001001000001',
  // L2 Stage 3 — 17 of 57
  '00000000001000100010001001000100000101001000000000101000101000000100001001000001',
  // L3 Stage 4 — 33 of 65 (line-initial words released)
  '00000000001010101010101101010100101101001011001010101010101000010100101101010001',
  // L4 Stage 5 — 52 of 69 (interjections released)
  '00000000001011111010101111011101101111011111101110101111111010010100101111111111',
  // L5 First letters — 71 of 71 (numbers released), every mask keeps its initial
  '00000000033333333333333333333333333333333333333333333333333333333333333333333333',
  // L6 From memory — 71 of 71, nothing kept
  '00000000011111111111111111111111111111111111111111111111111111111111111111111111',
];

const GOLDEN_COUNTS: readonly [number, number, number][] = [
  // [maskedCount, candidateCount, contentMaskedCount]
  [0, 57, 0],
  [9, 57, 5],
  [17, 57, 9],
  [33, 65, 17],
  [52, 69, 23],
  [71, 71, 33],
  [71, 71, 33],
];

describe('golden: hideWords over the scene, all seven rungs', () => {
  const doc = sceneDoc();

  it('the fixture document itself has not drifted', () => {
    expect(doc.tokens).toHaveLength(80);
    expect(doc.lines).toHaveLength(10);
    expect(SCENE_SOURCE.length).toBe(457);
  });

  it.each(Array.from({ length: LADDER_LENGTH }, (_, rung) => [rung]))(
    'rung %i matches the golden styles',
    (rung) => {
      const plan = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: rung }));
      expect([...plan.styles].join('')).toBe(GOLDEN_HIDE_WORDS[rung]);
      expect([plan.maskedCount, plan.candidateCount, plan.contentMaskedCount]).toEqual(
        GOLDEN_COUNTS[rung],
      );
    },
  );

  it('reading the golden file down the columns shows nesting directly', () => {
    for (let rung = 0; rung + 1 < LADDER_LENGTH; rung++) {
      const lower = GOLDEN_HIDE_WORDS[rung] ?? '';
      const upper = GOLDEN_HIDE_WORDS[rung + 1] ?? '';
      for (let i = 0; i < lower.length; i++) {
        if (lower[i] !== '0') expect(upper[i], `token ${i} unmasked at L${rung + 1}`).not.toBe('0');
      }
    }
  });
});
