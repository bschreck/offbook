/**
 * Per-method behaviour. PLAN.md §8.5, plus the spacing pass and fix D from §8.4.
 */

import { describe, expect, it } from 'vitest';
import { deriveMinGap, spacingPass } from '../../../src/core/mask/kernels/percent';
import {
  monotoneDepth,
  resolvePositional,
  rhymeNucleus,
  wordsRhyme,
} from '../../../src/core/mask/kernels/positional';
import { computeWindow } from '../../../src/core/mask/kernels/window';
import { ladderFor } from '../../../src/core/mask/ladder';
import { computeMaskPlan, keyWordsFallsBack } from '../../../src/core/mask/plan';
import { LADDER_LENGTH, LineFlag, MaskStyle } from '../../../src/core/mask/types';
import type { Document } from '../../../src/core/text/types';
import { buildDoc, lyricDoc, makeSpec, maskedSet, sceneDoc } from './fixture';

const LINE_ENDS_TABLE = ladderFor('lineEnds').map((r) => r.positional);
const LINE_STARTS_TABLE = ladderFor('lineStarts').map((r) => r.positional);

function wordTokensOfLine(doc: Document, lineIdx: number): number[] {
  return doc.lines[lineIdx]?.tokens.filter((t) => t.isMaskable).map((t) => t.i) ?? [];
}

describe('§8.4 fix D — structural ladders are monotone per line', () => {
  it('a 4-word line never gets easier going up a rung', () => {
    const depths = [];
    for (let rung = 0; rung < LADDER_LENGTH; rung++) {
      depths.push(monotoneDepth(LINE_ENDS_TABLE, rung, 4));
    }
    expect(depths).toEqual([0, 1, 2, 3, 3, 4, 4]);
    for (let i = 0; i + 1 < depths.length; i++) {
      expect(depths[i + 1] ?? 0).toBeGreaterThanOrEqual(depths[i] ?? 0);
    }
  });

  it('holds for every word count from 1 to 30, for both positional tables', () => {
    for (const table of [LINE_ENDS_TABLE, LINE_STARTS_TABLE]) {
      for (let wc = 1; wc <= 30; wc++) {
        let previous = -1;
        for (let rung = 0; rung < LADDER_LENGTH; rung++) {
          const depth = monotoneDepth(table, rung, wc);
          expect(depth).toBeGreaterThanOrEqual(previous);
          expect(depth).toBeLessThanOrEqual(wc);
          previous = depth;
        }
      }
    }
  });

  it('resolves half and all against the line length', () => {
    expect(resolvePositional('half', 7)).toBe(3);
    expect(resolvePositional('all', 7)).toBe(7);
    expect(resolvePositional(2, 7)).toBe(2);
  });
});

describe('lineEnds', () => {
  const doc = lyricDoc();

  // Rung 5 so that Protect is out of the way: at lower rungs the masked run is a prefix of the
  // line's CANDIDATES, which is the same claim but harder to state without reimplementing Protect.
  it('masks a contiguous run at the END of each line', () => {
    const plan = computeMaskPlan(doc, makeSpec('lineEnds', { ladderIndex: 5 }));
    for (const line of doc.lines) {
      const words = wordTokensOfLine(doc, line.idx);
      const masked = words.filter((i) => plan.styles[i] !== 0);
      if (masked.length === 0) continue;
      expect(masked).toEqual(words.slice(words.length - masked.length));
    }
  });

  it('keeps at least one word visible until the top rung', () => {
    for (const rung of [1, 2, 3, 4, 5]) {
      const plan = computeMaskPlan(doc, makeSpec('lineEnds', { ladderIndex: rung }));
      for (const line of doc.lines) {
        const words = wordTokensOfLine(doc, line.idx);
        if (words.length < 2) continue;
        expect(
          words.some((i) => plan.styles[i] === 0),
          `L${rung} line ${line.idx}`,
        ).toBe(true);
      }
    }
  });

  it('hides everything at From memory', () => {
    const plan = computeMaskPlan(doc, makeSpec('lineEnds', { ladderIndex: 6 }));
    for (const t of doc.tokens) {
      if (t.isMaskable) expect(plan.styles[t.i], `"${t.text}"`).not.toBe(0);
    }
  });
});

describe('lineStarts', () => {
  const doc = lyricDoc();

  it('masks a contiguous run at the START of each line', () => {
    const plan = computeMaskPlan(doc, makeSpec('lineStarts', { ladderIndex: 5 }));
    for (const line of doc.lines) {
      const words = wordTokensOfLine(doc, line.idx);
      const masked = words.filter((i) => plan.styles[i] !== 0);
      if (masked.length === 0) continue;
      expect(masked).toEqual(words.slice(0, masked.length));
    }
  });
});

describe('hideLines', () => {
  const doc = lyricDoc();

  it('hides whole lines and flags them', () => {
    const plan = computeMaskPlan(doc, makeSpec('hideLines', { ladderIndex: 4 }));
    let hidden = 0;
    for (const line of doc.lines) {
      const flagged = ((plan.lineFlags[line.idx] ?? 0) & LineFlag.hiddenLine) !== 0;
      const words = wordTokensOfLine(doc, line.idx);
      if (!flagged) {
        for (const i of words) expect(plan.styles[i]).toBe(0);
        continue;
      }
      hidden++;
      for (const i of words) expect(plan.styles[i]).not.toBe(0);
    }
    expect(hidden).toBe(Math.round(0.7 * doc.lines.length));
  });

  it('keeps the first word of a hidden line visible at rungs 1 and 2', () => {
    for (const rung of [1, 2]) {
      const plan = computeMaskPlan(doc, makeSpec('hideLines', { ladderIndex: rung }));
      for (const line of doc.lines) {
        if (((plan.lineFlags[line.idx] ?? 0) & LineFlag.hiddenLine) === 0) continue;
        const words = wordTokensOfLine(doc, line.idx);
        expect(plan.styles[words[0] ?? 0], `L${rung} line ${line.idx}`).toBe(0);
        expect(words.slice(1).every((i) => plan.styles[i] !== 0)).toBe(true);
      }
    }
  });

  it('leaves punctuation in a hidden line untouched', () => {
    const scene = sceneDoc();
    const plan = computeMaskPlan(scene, makeSpec('hideLines', { ladderIndex: 6 }));
    for (const t of scene.tokens) {
      if (t.kind === 'punct') expect(plan.styles[t.i]).toBe(0);
    }
  });
});

describe('keyWords and glueWords', () => {
  const doc = sceneDoc();

  it('keyWords only ever masks content words', () => {
    for (let rung = 1; rung < LADDER_LENGTH; rung++) {
      const plan = computeMaskPlan(doc, makeSpec('keyWords', { ladderIndex: rung }));
      for (const i of maskedSet(plan.styles)) {
        const t = doc.tokens[i];
        expect(t?.isFunction, `L${rung} "${t?.text}"`).toBe(false);
      }
    }
  });

  it('glueWords masks only function words until the top two rungs', () => {
    for (const rung of [1, 2, 3, 4]) {
      const plan = computeMaskPlan(doc, makeSpec('glueWords', { ladderIndex: rung }));
      for (const i of maskedSet(plan.styles)) {
        expect(doc.tokens[i]?.isFunction, `L${rung} "${doc.tokens[i]?.text}"`).toBe(true);
      }
    }
    const top = computeMaskPlan(doc, makeSpec('glueWords', { ladderIndex: 6 }));
    const contentMasked = [...maskedSet(top.styles)].filter(
      (i) => doc.tokens[i]?.isFunction === false,
    );
    expect(contentMasked.length).toBeGreaterThan(0);
  });

  it('the colloquial-dialogue guard fires on a passage of almost all common words', () => {
    const colloquial = buildDoc(
      'JIM: Well I have to go now do you not think that we are all in it\n' +
        'JIM: And so it is that we do what we do when they are not here',
      { id: 'colloquial', kind: 'script' },
    );
    expect(keyWordsFallsBack(colloquial, makeSpec('keyWords', { ladderIndex: 2 }))).toBe(true);
    // With the guard, rung 2 still hides ~30% of the passage rather than one word.
    const plan = computeMaskPlan(colloquial, makeSpec('keyWords', { ladderIndex: 2 }));
    expect(plan.maskedCount).toBeGreaterThan(3);
    expect(keyWordsFallsBack(sceneDoc(), makeSpec('keyWords', { ladderIndex: 2 }))).toBe(false);
  });
});

describe('rhymes', () => {
  const doc = lyricDoc();

  it('detects nuclei rather than orthographic tails', () => {
    expect(rhymeNucleus('free')).toBe('e');
    expect(rhymeNucleus('me')).toBe('e');
    expect(wordsRhyme('me', 'free')).toBe(true);
    expect(wordsRhyme('day', 'away')).toBe(true);
    expect(wordsRhyme('sea', 'free')).toBe(true);
    // the stoplist kills the gerund false positive the "last 3 characters" rule fires on
    expect(wordsRhyme('walking', 'nothing')).toBe(false);
    expect(wordsRhyme('walking', 'talking')).toBe(false);
  });

  it('keeps the rhyming line ends visible until rung 5', () => {
    for (const rung of [1, 2, 3, 4]) {
      const plan = computeMaskPlan(doc, makeSpec('rhymes', { ladderIndex: rung }));
      // "free / sea" and "away / say" are the stanza's rhymes
      const rhymeWords = doc.tokens.filter((t) =>
        // `time` is deliberately absent: /aɪm/ against /aɪn/ is a slant rhyme, and the
        // nucleus rule correctly declines to call it one.
        ['free', 'sea', 'away', 'say', 'line', 'fine'].includes(t.normalized),
      );
      expect(rhymeWords.length).toBeGreaterThan(3);
      for (const t of rhymeWords) expect(plan.styles[t.i], `L${rung} "${t.text}"`).toBe(0);
    }
  });

  it('masks the rhyme itself at the top two rungs', () => {
    const five = computeMaskPlan(doc, makeSpec('rhymes', { ladderIndex: 5 }));
    const rhyme = doc.tokens.find((t) => t.normalized === 'sea');
    expect(rhyme).toBeDefined();
    expect(five.styles[rhyme?.i ?? 0]).toBe(MaskStyle.initial);
  });
});

describe('chunkWindow', () => {
  const doc = lyricDoc();
  const spec = (rung: number) =>
    makeSpec('chunkWindow', { ladderIndex: rung, params: { windowIndex: 3 } });

  it('computes the window layout', () => {
    expect(computeWindow(10, 3, 1, 1, 0)).toEqual({
      focusStart: 3,
      focusEnd: 4,
      dimStart: 2,
      dimEnd: 4,
    });
    expect(computeWindow(10, 99, 2, 1, 1)).toEqual({
      focusStart: 8,
      focusEnd: 10,
      dimStart: 7,
      dimEnd: 10,
    });
    expect(computeWindow(0, 0, 1, 1, 1).focusEnd).toBe(0);
  });

  it('dims the lookback chunk and blanks everything further away', () => {
    const plan = computeMaskPlan(doc, spec(2));
    const styleOfChunk = (idx: number): number[] =>
      doc.tokens
        .filter((t) => t.chunkIdx === idx && t.isMaskable)
        .map((t) => plan.styles[t.i] ?? 0);
    expect(styleOfChunk(2).every((s) => s === MaskStyle.dim)).toBe(true);
    expect(styleOfChunk(0).every((s) => s === MaskStyle.blank)).toBe(true);
    expect(styleOfChunk(3).some((s) => s !== MaskStyle.dim && s !== MaskStyle.blank)).toBe(true);
  });

  it('drops the lookback at rung 4, which still nests because dim and blank are both masked', () => {
    const before = computeMaskPlan(doc, spec(3));
    const after = computeMaskPlan(doc, spec(4));
    const lookback = doc.tokens.filter((t) => t.chunkIdx === 2 && t.isMaskable);
    expect(lookback.every((t) => before.styles[t.i] === MaskStyle.dim)).toBe(true);
    expect(lookback.every((t) => after.styles[t.i] === MaskStyle.blank)).toBe(true);
  });

  it('reports the focus line range', () => {
    const plan = computeMaskPlan(doc, spec(2));
    expect(plan.focus).toEqual({ firstLine: 3, lastLine: 3 });
    expect(plan.step).toBeNull();
  });
});

describe('the spacing pass', () => {
  it('derives minGap from the median line length and never from the rung', () => {
    expect(deriveMinGap([3, 4, 5])).toBe(1);
    expect(deriveMinGap([8, 9, 10])).toBe(2);
    expect(deriveMinGap([2, 20])).toBe(2);
    expect(deriveMinGap([])).toBe(1);
  });

  it('produces one total order, so every prefix nests', () => {
    const lineIdx = new Int32Array([0, 0, 0, 0, 0, 0]);
    const wordPos = new Int32Array([0, 1, 2, 3, 4, 5]);
    const ordered = spacingPass([1, 2, 3, 0, 4, 5], lineIdx, wordPos, 2);
    expect([...ordered].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    // the first three accepted are mutually non-adjacent
    const head = ordered.slice(0, 3);
    for (const a of head) {
      for (const b of head) {
        if (a !== b) expect(Math.abs((wordPos[a] ?? 0) - (wordPos[b] ?? 0))).toBeGreaterThan(1);
      }
    }
  });

  it('avoids adjacent blanks at low density on long lines', () => {
    const doc = buildDoc(
      Array.from(
        { length: 6 },
        (_, l) => `Alpha${l} bravo charlie delta echo foxtrot golf hotel india juliet kilo lima`,
      ).join('\n'),
      { id: 'long', kind: 'speech' },
    );
    const plan = computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: 2 }));
    for (const line of doc.lines) {
      const words = wordTokensOfLine(doc, line.idx);
      for (let i = 0; i + 1 < words.length; i++) {
        const a = words[i] ?? 0;
        const b = words[i + 1] ?? 0;
        expect(plan.styles[a] !== 0 && plan.styles[b] !== 0, `line ${line.idx} at ${i}`).toBe(
          false,
        );
      }
    }
  });
});

describe('scope', () => {
  const doc = sceneDoc();

  it('a chunk scope masks inside that chunk and nowhere else', () => {
    const chunk = doc.chunks.find((c) => c.wordCount > 4);
    expect(chunk).toBeDefined();
    const plan = computeMaskPlan(
      doc,
      makeSpec('hideWords', {
        ladderIndex: 6,
        scope: { kind: 'chunk', chunkKey: chunk?.key ?? '' },
      }),
    );
    for (const i of maskedSet(plan.styles)) {
      expect(i).toBeGreaterThanOrEqual(chunk?.tokenRange[0] ?? 0);
      expect(i).toBeLessThan(chunk?.tokenRange[1] ?? 0);
    }
    expect(plan.maskedCount).toBeGreaterThan(0);
  });

  it('a selection scope masks inside the token range and nowhere else', () => {
    const plan = computeMaskPlan(
      doc,
      makeSpec('hideWords', { ladderIndex: 6, scope: { kind: 'selection', range: [20, 30] } }),
    );
    for (const i of maskedSet(plan.styles)) {
      expect(i).toBeGreaterThanOrEqual(20);
      expect(i).toBeLessThan(30);
    }
  });

  it('throws rather than silently masking the whole document for an unknown chunk', () => {
    expect(() =>
      computeMaskPlan(
        doc,
        makeSpec('hideWords', { ladderIndex: 3, scope: { kind: 'chunk', chunkKey: 'nope' } }),
      ),
    ).toThrow(/unknown chunk/);
  });

  it('requires exactly one of ladderIndex and customPercent', () => {
    expect(() =>
      computeMaskPlan(doc, makeSpec('hideWords', { ladderIndex: null, customPercent: null })),
    ).toThrow(/exactly one/);
  });
});
