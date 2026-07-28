/**
 * Exact cardinality and the punctuation contract. PLAN.md §8.3, §8.4 fix B.
 *
 * `k === clamp(round(p·n), p > 0 ? 1 : 0, n)` is only achievable because Protect and MyLines are
 * filters rather than post-passes (fix A) — the whole point of fix A is that this test can pass.
 */

import { describe, expect, it } from 'vitest';
import { computeK } from '../../../src/core/mask/kernels/percent';
import { computeMaskPlan } from '../../../src/core/mask/plan';
import { LADDER_LENGTH, METHOD_IDS } from '../../../src/core/mask/types';
import { buildDoc, makeSpec, maskedSet, sceneDoc } from './fixture';

const OPEN_PROTECT = {
  protectFirstWord: false,
  protectInterjections: false,
  protectNumbers: false,
};

function clampRound(p: number, n: number): number {
  const lo = p > 0 ? 1 : 0;
  const raw = Math.round(p * n);
  return Math.min(Math.max(raw, lo), n);
}

describe('computeK', () => {
  it('matches clamp(round(p·n), p > 0 ? 1 : 0, n) over a wide grid', () => {
    const densities = [0, 0.01, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.55, 0.65, 0.75, 0.85, 1];
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 11, 17, 40, 137, 500]) {
      for (const p of densities) expect(computeK(p, n)).toBe(clampRound(p, n));
    }
  });

  it('never returns 0 for a positive density — fix B, the short-lyric-line deadlock', () => {
    // Without the floor, round(0.10 × 5) = 0 and round(0.20 × 5) = 1, so rungs 1 and 2 of a
    // 5-word line render nothing; the step-up gate can never be satisfied and the rung is
    // reachable only from above.
    expect(computeK(0.1, 5)).toBe(1);
    expect(computeK(0.15, 3)).toBe(1);
    expect(computeK(0.01, 500)).toBe(5);
  });

  it('returns 0 for p = 0 and for an empty candidate set', () => {
    expect(computeK(0, 100)).toBe(0);
    expect(computeK(1, 0)).toBe(0);
  });
});

describe('delivered density is exactly k', () => {
  it('a 3-word line hits every rung of the shared ladder exactly', () => {
    const doc = buildDoc('One two three', { id: 'three', kind: 'lyrics' });
    for (let rung = 0; rung < LADDER_LENGTH; rung++) {
      const plan = computeMaskPlan(
        doc,
        makeSpec('hideWords', { ladderIndex: rung, params: OPEN_PROTECT }),
      );
      expect(plan.candidateCount).toBe(3);
      expect(plan.maskedCount).toBe(computeK([0, 0.15, 0.3, 0.5, 0.75, 1, 1][rung] ?? 0, 3));
    }
  });

  it('a 5-word line hits every rung of the shared ladder exactly', () => {
    const doc = buildDoc('Alpha beta gamma delta epsilon', { id: 'five', kind: 'lyrics' });
    const expected = [0, 1, 2, 3, 4, 5, 5];
    for (let rung = 0; rung < LADDER_LENGTH; rung++) {
      const plan = computeMaskPlan(
        doc,
        makeSpec('hideWords', { ladderIndex: rung, params: OPEN_PROTECT }),
      );
      expect(plan.candidateCount).toBe(5);
      expect(plan.maskedCount).toBe(expected[rung]);
    }
  });

  it('holds for every custom percentage on documents of several sizes', () => {
    const docs = [
      buildDoc('One two three', { id: 'n3', kind: 'lyrics' }),
      buildDoc('Alpha beta gamma delta epsilon', { id: 'n5', kind: 'lyrics' }),
      buildDoc(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '), {
        id: 'n40',
        kind: 'lyrics',
      }),
    ];
    for (const doc of docs) {
      for (const percent of [0, 1, 5, 10, 17, 25, 33, 50, 67, 80, 99, 100]) {
        const plan = computeMaskPlan(
          doc,
          makeSpec('hideWords', {
            ladderIndex: null,
            customPercent: percent,
            params: OPEN_PROTECT,
          }),
        );
        expect(plan.maskedCount).toBe(clampRound(percent / 100, plan.candidateCount));
      }
    }
  });

  it('the percent methods deliver exactly k on a real script', () => {
    const doc = sceneDoc();
    const ladderP: Record<string, readonly number[]> = {
      hideWords: [0, 0.15, 0.3, 0.5, 0.75, 1, 1],
      firstLetters: [0, 0.25, 0.45, 0.65, 0.85, 1, 1],
      keyWords: [0, 0.2, 0.4, 0.6, 0.8, 1, 1],
      myLines: [0, 0.15, 0.3, 0.5, 0.75, 1, 1],
    };
    for (const [methodId, densities] of Object.entries(ladderP)) {
      for (let rung = 0; rung < LADDER_LENGTH; rung++) {
        const plan = computeMaskPlan(
          doc,
          // biome-ignore lint/suspicious/noExplicitAny: keys are MethodIds by construction
          makeSpec(methodId as any, { ladderIndex: rung }),
        );
        expect(plan.maskedCount, `${methodId} L${rung}`).toBe(
          computeK(densities[rung] ?? 0, plan.candidateCount),
        );
      }
    }
  });
});

describe('the top rung', () => {
  const doc = sceneDoc();

  it('100% masks every candidate and nothing that is not a candidate', () => {
    const plan = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: 6 }));
    const masked = maskedSet(plan.styles);
    expect(masked.size).toBe(plan.candidateCount);
    for (const t of doc.tokens) {
      const isCandidate = t.isMaskable;
      if (masked.has(t.i)) expect(isCandidate, `token ${t.i} "${t.text}"`).toBe(true);
    }
    // every maskable token in a dialogue/paragraph/verse block is hidden at From memory
    const maskable = doc.tokens.filter((t) => t.isMaskable);
    expect(masked.size).toBe(maskable.length);
  });

  it('never masks a heading, a stage direction or a speaker label', () => {
    for (let rung = 0; rung < LADDER_LENGTH; rung++) {
      const plan = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: rung }));
      for (const t of doc.tokens) {
        const blockType = doc.blocks[t.blockIdx]?.type;
        if (blockType === 'heading' || blockType === 'direction' || blockType === 'label') {
          expect(plan.styles[t.i], `${blockType} token ${t.i}`).toBe(0);
        }
      }
    }
  });
});

describe('punctuation is never masked', () => {
  const doc = sceneDoc();

  it('no punct token gets a non-zero style, in any method at any rung', () => {
    for (const methodId of METHOD_IDS) {
      for (let rung = 0; rung < LADDER_LENGTH; rung++) {
        const plan = computeMaskPlan(doc, makeSpec(methodId, { ladderIndex: rung }));
        for (const t of doc.tokens) {
          if (t.kind !== 'punct') continue;
          expect(plan.styles[t.i], `${methodId} L${rung} punct ${t.i}`).toBe(0);
        }
      }
    }
  });

  it('lead and trail are not in the styles array at all — it is one entry per token', () => {
    const plan = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: 6 }));
    expect(plan.styles.length).toBe(doc.tokens.length);
    expect(plan.lineFlags.length).toBe(doc.lines.length);
    // The masked token still carries its punctuation: the plan cannot express hiding it.
    const withTrail = doc.tokens.find((t) => t.isMaskable && t.trail.length > 0);
    expect(withTrail).toBeDefined();
    expect(plan.styles[withTrail?.i ?? 0]).not.toBe(0);
    expect(withTrail?.trail).not.toBe('');
  });

  it('computing a plan does not mutate the document', () => {
    const before = JSON.stringify(doc.tokens.map((t) => [t.lead, t.text, t.trail, t.ws]));
    for (const methodId of METHOD_IDS) {
      computeMaskPlan(doc, makeSpec(methodId, { ladderIndex: 5 }));
    }
    expect(JSON.stringify(doc.tokens.map((t) => [t.lead, t.text, t.trail, t.ws]))).toBe(before);
  });
});
