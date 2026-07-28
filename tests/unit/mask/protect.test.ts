/**
 * Protect and the MyLines lens as CANDIDATE FILTERS. PLAN.md §8.4 fix A, §7.8.
 *
 * The design doc applied both after selection. That produced three bugs at once: exact
 * cardinality became impossible, the percentage in the UI stopped being the density delivered,
 * and — with a 40-of-500-word role — the help-rate denominator became pure noise.
 */

import { describe, expect, it } from 'vitest';
import { computeK } from '../../../src/core/mask/kernels/percent';
import { roleSetHash } from '../../../src/core/mask/lens/myLines';
import { INTERJECTIONS } from '../../../src/core/mask/lens/protect';
import { computeMaskPlan } from '../../../src/core/mask/plan';
import { LADDER_LENGTH, LineFlag } from '../../../src/core/mask/types';
import type { Document } from '../../../src/core/text/types';
import { buildDoc, makeSpec, maskedSet, sceneDoc } from './fixture';

const SHARED_P = [0, 0.15, 0.3, 0.5, 0.75, 1, 1] as const;

function firstWordTokens(doc: Document): Set<number> {
  const firsts = new Set<number>();
  const seen = new Set<number>();
  for (const t of doc.tokens) {
    if (t.kind !== 'word' && t.kind !== 'number') continue;
    if (seen.has(t.lineIdx)) continue;
    seen.add(t.lineIdx);
    firsts.add(t.i);
  }
  return firsts;
}

describe('Protect is a filter, not a post-pass', () => {
  const doc = sceneDoc();

  it('the delivered density still equals the requested percentage at every rung', () => {
    for (let rung = 0; rung < LADDER_LENGTH; rung++) {
      const plan = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: rung }));
      expect(plan.maskedCount, `L${rung}`).toBe(computeK(SHARED_P[rung] ?? 0, plan.candidateCount));
    }
  });

  it('the candidate count GROWS as Protect relaxes up the ladder', () => {
    const counts = [];
    for (let rung = 0; rung < LADDER_LENGTH; rung++) {
      counts.push(
        computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: rung })).candidateCount,
      );
    }
    // buckets: rungs 0-2 | 3 | 4 | 5-6
    expect(counts[0]).toBe(counts[1]);
    expect(counts[1]).toBe(counts[2]);
    expect(counts[3] ?? 0).toBeGreaterThan(counts[2] ?? 0); // first words released
    expect(counts[4] ?? 0).toBeGreaterThan(counts[3] ?? 0); // interjections released
    expect(counts[5] ?? 0).toBeGreaterThan(counts[4] ?? 0); // numbers released
    expect(counts[6]).toBe(counts[5]);
  });
});

describe('Protect: first word of each line, rungs <= 2', () => {
  const doc = sceneDoc();
  const firsts = firstWordTokens(doc);

  it('never masks a line-initial word at rungs 0, 1 or 2', () => {
    for (const rung of [0, 1, 2]) {
      const plan = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: rung }));
      for (const i of firsts) expect(plan.styles[i], `L${rung} token ${i}`).toBe(0);
    }
  });

  it('releases them from rung 3 up', () => {
    const plan = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: 6 }));
    const masked = maskedSet(plan.styles);
    const maskedFirsts = [...firsts].filter((i) => masked.has(i));
    expect(maskedFirsts.length).toBeGreaterThan(0);
  });

  it('is off by default for lineStarts, which exists to hide exactly that word', () => {
    const plan = computeMaskPlan(doc, makeSpec('lineStarts', { ladderIndex: 1 }));
    const masked = maskedSet(plan.styles);
    expect([...firsts].some((i) => masked.has(i))).toBe(true);
  });
});

describe('Protect: interjections, rungs <= 3', () => {
  const source = `HAMLET: Well I humbly thank you and oh how the wind does blow today
OPHELIA: Wow that sounds like a very long sentence to remember properly now`;
  const doc = buildDoc(source, { id: 'interject', kind: 'script' });
  const interjections = doc.tokens.filter((t) => INTERJECTIONS.has(t.normalized));

  it('the corpus actually contains interjections', () => {
    expect(interjections.length).toBeGreaterThanOrEqual(4);
  });

  it('never masks one at rungs 0..3', () => {
    for (const rung of [0, 1, 2, 3]) {
      const plan = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: rung }));
      for (const t of interjections) expect(plan.styles[t.i], `L${rung} "${t.text}"`).toBe(0);
    }
  });

  it('masks them from rung 4 up', () => {
    const plan = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: 6 }));
    for (const t of interjections) expect(plan.styles[t.i]).not.toBe(0);
  });

  it('is off by default for prose', () => {
    const prose = buildDoc(source.replace(/^[A-Z]+: /gm, ''), { id: 'prose', kind: 'speech' });
    const plan = computeMaskPlan(prose, makeSpec('hideWords', { ladderIndex: 3 }));
    const masked = maskedSet(plan.styles);
    const proseInterjections = prose.tokens.filter((t) => INTERJECTIONS.has(t.normalized));
    expect(proseInterjections.some((t) => masked.has(t.i))).toBe(true);
  });

  it('matches the §8.4 list exactly', () => {
    expect([...INTERJECTIONS].sort()).toEqual(
      'oh ah well hey hm hmm huh ugh wow yeah yes no please look listen now why'.split(' ').sort(),
    );
  });
});

describe('Protect: numbers, rungs <= 4', () => {
  const doc = sceneDoc();
  const numbers = doc.tokens.filter((t) => t.isMaskable && (t.kind === 'number' || t.hasDigit));

  it('the corpus actually contains numbers', () => {
    expect(numbers.length).toBeGreaterThanOrEqual(2);
  });

  it('never masks one at rungs 0..4', () => {
    for (const rung of [0, 1, 2, 3, 4]) {
      const plan = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: rung }));
      for (const t of numbers) expect(plan.styles[t.i], `L${rung} "${t.text}"`).toBe(0);
    }
  });

  it('masks them at rungs 5 and 6', () => {
    for (const rung of [5, 6]) {
      const plan = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: rung }));
      for (const t of numbers) expect(plan.styles[t.i]).not.toBe(0);
    }
  });
});

// ---------------------------------------------------------------- the MyLines lens

/** Digit-free filler, so the numbers rule does not accidentally protect the whole corpus. */
function filler(prefix: string, n: number): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const a = letters[Math.floor(n / 26) % 26] ?? 'a';
  const b = letters[n % 26] ?? 'a';
  return `${prefix}${a}${b}`;
}

/** A role with 40 of the document's 520 words — the exact case fix A exists for. */
function smallRoleDoc(): Document {
  const lines: string[] = [];
  let n = 0;
  for (let i = 0; i < 8; i++) {
    lines.push(`MINE: ${Array.from({ length: 5 }, () => filler('mine', n++)).join(' ')}`);
    for (let j = 0; j < 6; j++) {
      lines.push(`THEIRS: ${Array.from({ length: 10 }, () => filler('other', n++)).join(' ')}`);
    }
  }
  return buildDoc(lines.join('\n'), { id: 'small-role', kind: 'script' });
}

describe('MyLines lens', () => {
  const doc = smallRoleDoc();
  const mine = doc.tokens.filter((t) => doc.blocks[t.blockIdx]?.speakerId === 'mine');
  const spec = (rung: number) =>
    makeSpec('hideWords', {
      ladderIndex: rung,
      lens: { myRoleIds: ['mine'], cueStyle: 'full', cueTailWords: 5 },
      params: { protectFirstWord: false },
    });

  it('the fixture really is 40 of 500 words', () => {
    expect(mine.filter((t) => t.isMaskable)).toHaveLength(40);
    expect(doc.tokens.filter((t) => t.isMaskable)).toHaveLength(520);
  });

  it('counts candidates over MY lines only', () => {
    expect(computeMaskPlan(doc, spec(2)).candidateCount).toBe(40);
  });

  it('delivers an exact, noise-free count on my lines at every rung', () => {
    // Applied after selection this was ~4 with a variance of 0 to 9. As a filter it is exact.
    const expected = [0, 6, 12, 20, 30, 40, 40];
    for (let rung = 0; rung < LADDER_LENGTH; rung++) {
      const plan = computeMaskPlan(doc, spec(rung));
      expect(plan.maskedCount, `L${rung}`).toBe(expected[rung]);
      expect(plan.maskedCount).toBe(computeK(SHARED_P[rung] ?? 0, 40));
    }
  });

  it('never masks a single token on anybody else’s line', () => {
    const mineIdx = new Set(mine.map((t) => t.i));
    for (let rung = 0; rung < LADDER_LENGTH; rung++) {
      for (const i of maskedSet(computeMaskPlan(doc, spec(rung)).styles)) {
        expect(mineIdx.has(i), `L${rung} masked foreign token ${i}`).toBe(true);
      }
    }
  });

  it('flags everyone else’s dialogue lines as cue lines, and leaves them readable', () => {
    const plan = computeMaskPlan(doc, spec(6));
    let cueLines = 0;
    for (const line of doc.lines) {
      const isMine = doc.blocks[line.blockIdx]?.speakerId === 'mine';
      const flagged = ((plan.lineFlags[line.idx] ?? 0) & LineFlag.cueLine) !== 0;
      expect(flagged).toBe(!isMine);
      if (flagged) cueLines++;
    }
    expect(cueLines).toBeGreaterThan(0);
  });

  it('roleSetHash is order-independent and defaults to "all"', () => {
    expect(roleSetHash([])).toBe('all');
    expect(roleSetHash(['b', 'a'])).toBe(roleSetHash(['a', 'b']));
    expect(roleSetHash(['a'])).not.toBe(roleSetHash(['b']));
  });

  it('practising as another role produces a different permutation', () => {
    const asMine = computeMaskPlan(doc, spec(3));
    const asAll = computeMaskPlan(
      doc,
      makeSpec('hideWords', { ladderIndex: 3, params: { protectFirstWord: false } }),
    );
    expect(asAll.candidateCount).toBe(520);
    expect(asMine.candidateCount).toBe(40);
  });
});
