/**
 * The masking contract. PLAN.md §8.2.
 *
 * ONE function computes masking: computeMaskPlan(doc, spec) -> MaskPlan.
 * Rendering, gestures and the ladder all READ the plan. Nothing else computes masking.
 */

/** Method ids are persisted in DocPractisePrefs and in every Rep. They NEVER change. */
export type MethodId =
  | 'hideWords'
  | 'firstLetters'
  | 'lineEnds'
  | 'lineStarts'
  | 'hideLines'
  | 'keyWords'
  | 'glueWords'
  | 'rhymes'
  | 'chunkWindow'
  | 'myLines';

/** v1 ships all ten. snowball/spotlight/typeItBack are v1.1 (§0.0 A3). */
export const METHOD_IDS: readonly MethodId[] = [
  'hideWords',
  'firstLetters',
  'lineEnds',
  'lineStarts',
  'hideLines',
  'keyWords',
  'glueWords',
  'rhymes',
  'chunkWindow',
  'myLines',
] as const;

export type Kernel = 'percent' | 'positional' | 'lineLevel' | 'window';

/** 0 none | 1 rule | 2 dots | 3 initial | 4 dim | 5 blank. `input` (6) arrives with typeItBack. */
export const MaskStyle = {
  none: 0,
  rule: 1,
  dots: 2,
  initial: 3,
  dim: 4,
  blank: 5,
} as const;
export type MaskStyleCode = (typeof MaskStyle)[keyof typeof MaskStyle];

export const LineFlag = {
  hiddenLine: 1 << 0,
  dimLine: 1 << 1,
  cueLine: 1 << 2,
  focusLine: 1 << 3,
} as const;

export interface MaskPlan {
  /** Per token, a MaskStyleCode. Indexed by Token.i. */
  styles: Uint8Array;
  /** Per line, a bitfield of LineFlag. */
  lineFlags: Uint8Array;
  focus: { firstLine: number; lastLine: number } | null;
  step: { index: number; total: number } | null;
  maskedCount: number;
  candidateCount: number;
  contentMaskedCount: number;
}

export type BlankStyle = 'underline' | 'box' | 'dots';
export type CueStyle = 'full' | 'tail' | 'hidden';

export interface ModeSpec {
  methodId: MethodId;
  /** 0..6. Exactly one of ladderIndex / customPercent is non-null. */
  ladderIndex: number | null;
  customPercent: number | null;
  params: Record<string, number | string | boolean>;
  lens: {
    myRoleIds: string[];
    cueStyle: CueStyle;
    cueTailWords: number;
  };
  scope: { kind: 'text' | 'chunk' | 'selection'; chunkKey?: string; range?: [number, number] };
  blankStyle: BlankStyle;
  /** Seed counter. Bumping it reshuffles which words are hidden at the same density. */
  reshuffle: number;
  /** Structural-mode phase shift (which alternate line is hidden). */
  phase: number;
  reveals: {
    /** The token currently being peeked at, if any. */
    peeked: number | null;
    /** Tokens the user tapped to reveal permanently for this rep. */
    revealed: Set<number>;
    revealAll: boolean;
  };
}

export interface MethodSpec {
  id: MethodId;
  name: string;
  /** One line, shown in the method sheet. Written for a user, not a developer. */
  blurb: string;
  kernel: Kernel;
  /** Whether hidden(rung n) ⊆ hidden(rung n+1). False for stepped methods (none in v1). */
  nestedLadder: boolean;
  maxRung: number;
  defaultParams: Record<string, number | string | boolean>;
  /** Requires detected speakers to be useful. */
  needsRoles?: boolean;
}

export const LADDER_LENGTH = 7;
