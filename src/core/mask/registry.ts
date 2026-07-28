/**
 * The frozen catalogue. PLAN.md §8.1.
 *
 * Ten methods in v1 — `snowball`, `spotlight` and `typeItBack` are deferred with the whole
 * progress model (§0.0 A3). The ids are persisted in `DocPractisePrefs.methodId` and in every
 * `Rep`, so they never change once shipped. Names and blurbs are user-facing copy.
 */

import type { MethodId, MethodSpec } from './types';
import { LADDER_LENGTH, METHOD_IDS } from './types';

const TOP_RUNG = LADDER_LENGTH - 1;

export const METHODS: Readonly<Record<MethodId, MethodSpec>> = {
  hideWords: {
    id: 'hideWords',
    name: 'Hide words',
    blurb: 'Hide a growing share of the words, spread evenly.',
    kernel: 'percent',
    nestedLadder: true,
    maxRung: TOP_RUNG,
    defaultParams: { weighting: 'uniform', finalStyle: 'rule' },
  },
  firstLetters: {
    id: 'firstLetters',
    name: 'First letters',
    blurb: 'Every hidden word keeps its first letter as a nudge.',
    kernel: 'percent',
    nestedLadder: true,
    maxRung: TOP_RUNG,
    defaultParams: { keepLetters: 3, keepFinalLetter: false, showLetterCount: true },
  },
  lineEnds: {
    id: 'lineEnds',
    name: 'Line endings',
    blurb: 'Hide the end of every line — the part people always fumble.',
    kernel: 'positional',
    nestedLadder: true,
    maxRung: TOP_RUNG,
    defaultParams: { keepMin: 1, unit: 'line' },
  },
  lineStarts: {
    id: 'lineStarts',
    name: 'Line starts',
    blurb: 'Hide the first few words of each line.',
    kernel: 'positional',
    nestedLadder: true,
    maxRung: TOP_RUNG,
    // The first-word Protect rule would gut this method at rungs 1–2 — it would mask words 2..k
    // and leave the word the method exists to hide in plain sight. Off by default here only.
    defaultParams: { keepMin: 1, unit: 'line', protectFirstWord: false },
  },
  hideLines: {
    id: 'hideLines',
    name: 'Hide lines',
    blurb: 'Whole lines vanish, and the space they took stays exactly where it was.',
    kernel: 'lineLevel',
    nestedLadder: true,
    maxRung: TOP_RUNG,
    defaultParams: { keepFirstWord: false },
  },
  keyWords: {
    id: 'keyWords',
    name: 'Keywords out',
    blurb: 'Only the words that carry meaning disappear. Grammar stays as scaffolding.',
    kernel: 'percent',
    nestedLadder: true,
    maxRung: TOP_RUNG,
    defaultParams: { weighting: 'content' },
  },
  glueWords: {
    id: 'glueWords',
    name: 'Glue words out',
    blurb: 'The opposite: hide the little connectives that hold the sentence together.',
    kernel: 'percent',
    nestedLadder: true,
    maxRung: TOP_RUNG,
    defaultParams: { weighting: 'function' },
  },
  rhymes: {
    id: 'rhymes',
    name: 'Keep the rhymes',
    blurb: 'Hide everything except the words that rhyme. Experimental.',
    kernel: 'positional',
    nestedLadder: true,
    maxRung: TOP_RUNG,
    defaultParams: { experimental: true },
  },
  chunkWindow: {
    id: 'chunkWindow',
    name: 'Chunk window',
    blurb: 'Work one chunk at a time, with the neighbours faded.',
    kernel: 'window',
    nestedLadder: true,
    maxRung: TOP_RUNG,
    defaultParams: {
      unit: 'chunk',
      windowSize: 1,
      lookback: 1,
      lookahead: 0,
      innerMethod: 'hideWords',
      windowIndex: 0,
    },
  },
  myLines: {
    id: 'myLines',
    name: 'Cue lines',
    blurb: 'Only your lines are hidden. Everyone else stays readable, because that is the cue.',
    kernel: 'percent',
    nestedLadder: true,
    maxRung: TOP_RUNG,
    defaultParams: { innerMethod: 'hideWords' },
    needsRoles: true,
  },
};

export const METHOD_LIST: readonly MethodSpec[] = METHOD_IDS.map((id) => METHODS[id]);

export function getMethod(id: MethodId): MethodSpec {
  return METHODS[id];
}
