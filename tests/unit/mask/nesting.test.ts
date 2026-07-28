/**
 * The conformance suite's most important test. PLAN.md §8.4.
 *
 * "masked(L_n) ⊆ masked(L_{n+1}) — a violation here is the most damaging possible bug": the
 * user steps up a rung and words they had already learned to recall come BACK, while words they
 * were reading disappear. It reads as the app losing their place, not as progress.
 */

import { describe, expect, it } from 'vitest';
import { LADDERS, rungAt } from '../../../src/core/mask/ladder';
import { computeMaskPlan } from '../../../src/core/mask/plan';
import { METHOD_LIST, METHODS } from '../../../src/core/mask/registry';
import type { MethodId, ModeSpec } from '../../../src/core/mask/types';
import { LADDER_LENGTH, METHOD_IDS } from '../../../src/core/mask/types';
import type { Document } from '../../../src/core/text/types';
import {
  firstMaskableChunkIndex,
  isSubset,
  lyricDoc,
  makeSpec,
  maskedSet,
  mixedDoc,
  sceneDoc,
  variedDoc,
} from './fixture';

/** A spec that actually exercises the method on this document: a real role, a populated window. */
function specFor(doc: Document, methodId: MethodId, ladderIndex: number): ModeSpec {
  const overrides: Partial<ModeSpec> = { ladderIndex };
  if (methodId === 'myLines') {
    const role = doc.roles[0]?.id;
    overrides.lens = {
      myRoleIds: role === undefined ? [] : [role],
      cueStyle: 'full',
      cueTailWords: 5,
    };
  }
  if (methodId === 'chunkWindow') {
    overrides.params = { windowIndex: firstMaskableChunkIndex(doc) };
  }
  return makeSpec(methodId, overrides);
}

const CORPORA: [string, () => Document][] = [
  ['scene', sceneDoc],
  ['lyric', lyricDoc],
  ['mixed', mixedDoc],
];

describe('registry', () => {
  it('holds exactly the ten v1 methods', () => {
    expect(METHOD_LIST).toHaveLength(10);
    expect(METHOD_LIST.map((m) => m.id)).toEqual([...METHOD_IDS]);
    expect(METHOD_LIST.map((m) => m.name)).not.toContain('');
    for (const method of METHOD_LIST) {
      expect(method.blurb.length).toBeGreaterThan(20);
      expect(method.maxRung).toBe(LADDER_LENGTH - 1);
    }
  });

  it('declares every v1 method as nested', () => {
    for (const method of METHOD_LIST) expect(method.nestedLadder).toBe(true);
  });

  it('gives every method all seven rungs', () => {
    for (const id of METHOD_IDS) expect(LADDERS[id]).toHaveLength(LADDER_LENGTH);
  });
});

describe.each(CORPORA)('nesting over the %s corpus', (_name, makeDoc) => {
  const doc = makeDoc();

  it.each(METHOD_IDS.map((id) => [id]))(
    '%s: masked(L_n) is a subset of masked(L_n+1) at every rung pair',
    (methodId) => {
      expect(METHODS[methodId].nestedLadder).toBe(true);
      for (let rung = 0; rung < LADDER_LENGTH - 1; rung++) {
        const lower = maskedSet(computeMaskPlan(doc, specFor(doc, methodId, rung)).styles);
        const upper = maskedSet(computeMaskPlan(doc, specFor(doc, methodId, rung + 1)).styles);
        expect(
          isSubset(lower, upper),
          `${methodId}: rung ${rung} leaked ${[...lower].filter((i) => !upper.has(i)).join(',')}`,
        ).toBe(true);
      }
    },
  );

  it.each(METHOD_IDS.map((id) => [id]))('%s: masked count never decreases', (methodId) => {
    let previous = -1;
    for (let rung = 0; rung < LADDER_LENGTH; rung++) {
      const plan = computeMaskPlan(doc, specFor(doc, methodId, rung));
      expect(plan.maskedCount).toBeGreaterThanOrEqual(previous);
      previous = plan.maskedCount;
    }
  });
});

/**
 * §8.6: "every row must be strictly distinguishable from its neighbour".
 *
 * For the positional methods that is a property of the DOCUMENT as much as of the table: on a
 * corpus where every line is 6 words long, `lineEnds` L3 (n = 3) and L4 (n = half = 3) are the
 * same mask, and fix D's running max makes that unavoidable. The claim is tested on corpora with
 * varied line lengths, which is what §8.6 is actually asserting.
 */
describe.each([
  ['varied', variedDoc],
  ['scene', sceneDoc],
] as [string, () => Document][])('rung distinguishability over the %s corpus', (_name, makeDoc) => {
  const doc = makeDoc();

  it.each(METHOD_IDS.map((id) => [id]))('%s: no two adjacent rungs are the same', (methodId) => {
    for (let rung = 0; rung < LADDER_LENGTH - 1; rung++) {
      const a = computeMaskPlan(doc, specFor(doc, methodId, rung));
      const b = computeMaskPlan(doc, specFor(doc, methodId, rung + 1));
      const sameStyles = a.styles.every((v, i) => v === b.styles[i]);
      const sameParams =
        JSON.stringify(rungAt(methodId, rung).params) ===
        JSON.stringify(rungAt(methodId, rung + 1).params);
      expect(sameStyles && sameParams, `${methodId} L${rung} === L${rung + 1}`).toBe(false);
    }
  });
});

describe('nesting survives the Protect relaxations', () => {
  // Rungs 2 -> 3 release the first word of every line and every interjection; 3 -> 4 releases
  // numbers. Those are exactly the boundaries where a naive "sort the current candidates and
  // take the first k" implementation drops previously-masked words out of the prefix.
  const doc = sceneDoc();

  it('hideWords keeps its prefix across every Protect boundary', () => {
    const sets = [];
    for (let rung = 0; rung < LADDER_LENGTH; rung++) {
      sets.push(maskedSet(computeMaskPlan(doc, specFor(doc, 'hideWords', rung)).styles));
    }
    for (let i = 0; i + 1 < sets.length; i++) {
      expect(isSubset(sets[i] ?? new Set(), sets[i + 1] ?? new Set())).toBe(true);
    }
  });

  it('holds under reshuffle and phase variations too', () => {
    for (const reshuffle of [0, 1, 2, 7]) {
      for (const methodId of METHOD_IDS) {
        for (let rung = 0; rung < LADDER_LENGTH - 1; rung++) {
          const lower = computeMaskPlan(
            doc,
            makeSpec(methodId, { ladderIndex: rung, reshuffle, phase: reshuffle }),
          );
          const upper = computeMaskPlan(
            doc,
            makeSpec(methodId, { ladderIndex: rung + 1, reshuffle, phase: reshuffle }),
          );
          expect(
            isSubset(maskedSet(lower.styles), maskedSet(upper.styles)),
            `${methodId} reshuffle ${reshuffle} rung ${rung}`,
          ).toBe(true);
        }
      }
    }
  });
});
