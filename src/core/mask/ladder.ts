/**
 * The ladder. PLAN.md §8.6.
 *
 * Seven rungs on one shared scale. Seven rather than six because 100% is a cliff and users who
 * jump 70 → 100 fail and blame the app; seven rather than eight because eight forces
 * indistinguishable rungs in several methods.
 *
 * Every row here must be strictly distinguishable from its neighbour — either the mask plan
 * differs or the resolved rung params do. The design doc's identical L6/L7 rows are gone.
 */

import { clamp } from '../util/assert';
import type { PositionalRung } from './kernels/positional';
import type { CueStyle, MethodId } from './types';
import { LADDER_LENGTH } from './types';

/** How a masked token is drawn at this rung. `blank` defers to `ModeSpec.blankStyle`. */
export type RungStyle = 'blank' | 'initial' | 'rule';

export interface Rung {
  /** Density for the percent and line-level kernels. */
  p: number;
  /** Depth for the positional kernel. Ignored by the others. */
  positional: PositionalRung;
  style: RungStyle;
  /** Extra knobs this rung sets; merged over the method's defaults and the user's overrides. */
  params: Readonly<Record<string, number | string | boolean>>;
}

export const RUNG_LABELS: readonly string[] = [
  'Read through',
  'Stage 2',
  'Stage 3',
  'Stage 4',
  'Stage 5',
  'First letters',
  'From memory',
];

/** The shared scale the UI shows. Individual methods deviate where their kernel demands it. */
export const SHARED_LADDER_P: readonly number[] = [0, 0.15, 0.3, 0.5, 0.75, 1.0, 1.0];

const NO_PARAMS: Readonly<Record<string, number | string | boolean>> = {};

function percentRungs(
  densities: readonly number[],
  extras: readonly Readonly<Record<string, number | string | boolean>>[] = [],
  styles: readonly RungStyle[] = [],
): readonly Rung[] {
  return densities.map((p, i) => ({
    p,
    positional: 0,
    style: styles[i] ?? 'blank',
    params: extras[i] ?? NO_PARAMS,
  }));
}

function positionalRungs(table: readonly PositionalRung[]): readonly Rung[] {
  return table.map((positional) => ({
    p: 0,
    positional,
    style: 'blank' as RungStyle,
    params: NO_PARAMS,
  }));
}

/** L5 keeps first letters, L6 keeps nothing — the two top rungs of every percent method. */
const TOP_STYLES: readonly RungStyle[] = [
  'blank',
  'blank',
  'blank',
  'blank',
  'blank',
  'initial',
  'rule',
];

/**
 * `lineEnds` L5 reads `max(4, half)` in §8.6; the table only needs the literal 4 because
 * `monotoneDepth` takes the running max with L4's `half` (§8.4 fix D).
 */
const LINE_ENDS_TABLE: readonly PositionalRung[] = [0, 1, 2, 3, 'half', 4, 'all'];
const LINE_STARTS_TABLE: readonly PositionalRung[] = [0, 1, 2, 3, 4, 'half', 'all'];

const FIRST_LETTER_PARAMS: readonly Readonly<Record<string, number | string | boolean>>[] = [
  { keepLetters: 3 },
  { keepLetters: 3 },
  { keepLetters: 2 },
  { keepLetters: 2 },
  { keepLetters: 1 },
  { keepLetters: 1 },
  { keepLetters: 1, keepFinalLetter: false, showLetterCount: false },
];

const HIDE_LINES_PARAMS: readonly Readonly<Record<string, number | string | boolean>>[] = [
  { keepFirstWord: false },
  { keepFirstWord: true },
  { keepFirstWord: true },
  { keepFirstWord: false },
  { keepFirstWord: false },
  { keepFirstWord: false },
  { keepFirstWord: false },
];

/** `glueWords` L5/L6 add a nested prefix of CONTENT words on top of every function word. */
const GLUE_PARAMS: readonly Readonly<Record<string, number | string | boolean>>[] = [
  { contentP: 0 },
  { contentP: 0 },
  { contentP: 0 },
  { contentP: 0 },
  { contentP: 0 },
  { contentP: 0.25 },
  { contentP: 0.5 },
];

/** `rhymes` masks everything BUT the rhyme; the rhyme itself only goes at the top two rungs. */
const RHYME_PARAMS: readonly Readonly<Record<string, number | string | boolean>>[] = [
  { rhymeStyle: 'none' },
  { rhymeStyle: 'none' },
  { rhymeStyle: 'none' },
  { rhymeStyle: 'none' },
  { rhymeStyle: 'none' },
  { rhymeStyle: 'initial' },
  { rhymeStyle: 'blank' },
];

const WINDOW_PARAMS: readonly Readonly<Record<string, number | string | boolean>>[] = [
  { lookback: 1 },
  { lookback: 1 },
  { lookback: 1 },
  { lookback: 1 },
  { lookback: 0 },
  { lookback: 0 },
  { lookback: 0 },
];

const MY_LINES_PARAMS: readonly Readonly<Record<string, number | string | boolean>>[] = [
  { cueStyle: 'full' satisfies CueStyle },
  { cueStyle: 'full' satisfies CueStyle },
  { cueStyle: 'full' satisfies CueStyle },
  { cueStyle: 'full' satisfies CueStyle },
  { cueStyle: 'full' satisfies CueStyle },
  { cueStyle: 'tail' satisfies CueStyle },
  { cueStyle: 'tail' satisfies CueStyle },
];

export const LADDERS: Readonly<Record<MethodId, readonly Rung[]>> = {
  hideWords: percentRungs(SHARED_LADDER_P, [], TOP_STYLES),
  firstLetters: percentRungs([0, 0.25, 0.45, 0.65, 0.85, 1.0, 1.0], FIRST_LETTER_PARAMS, [
    'initial',
    'initial',
    'initial',
    'initial',
    'initial',
    'initial',
    'initial',
  ]),
  lineEnds: positionalRungs(LINE_ENDS_TABLE),
  lineStarts: positionalRungs(LINE_STARTS_TABLE),
  hideLines: percentRungs([0, 0.25, 0.4, 0.55, 0.7, 0.85, 1.0], HIDE_LINES_PARAMS),
  keyWords: percentRungs([0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.0], [], TOP_STYLES),
  glueWords: percentRungs([0, 0.3, 0.55, 0.8, 1.0, 1.0, 1.0], GLUE_PARAMS),
  rhymes: percentRungs([0, 0.3, 0.55, 0.8, 1.0, 1.0, 1.0], RHYME_PARAMS),
  chunkWindow: percentRungs([0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.0], WINDOW_PARAMS, TOP_STYLES),
  myLines: percentRungs(SHARED_LADDER_P, MY_LINES_PARAMS, TOP_STYLES),
};

export function ladderFor(methodId: MethodId): readonly Rung[] {
  return LADDERS[methodId];
}

export function rungAt(methodId: MethodId, index: number): Rung {
  const rungs = LADDERS[methodId];
  const i = clamp(Math.round(index), 0, rungs.length - 1);
  // rungs is a frozen 7-entry table, so this is always defined; the fallback exists for tsc.
  return rungs[i] ?? { p: 0, positional: 0, style: 'blank', params: NO_PARAMS };
}

/**
 * Custom percent is off-ladder, but Protect still has to know how far up the user is. Map the
 * custom density onto the highest rung whose own density it has reached.
 */
export function effectiveRungForPercent(methodId: MethodId, percent: number): number {
  const p = clamp(percent, 0, 100) / 100;
  const rungs = LADDERS[methodId];
  let best = 0;
  for (let i = 0; i < rungs.length; i++) {
    const rung = rungs[i];
    if (rung !== undefined && rung.p <= p) best = i;
  }
  return best;
}

/**
 * What the renderer needs but `MaskPlan` has nowhere to carry: `keepLetters`, `showLetterCount`,
 * `cueStyle`, `keepFirstWord`. Precedence is method defaults < rung < user overrides.
 */
export function resolveRungParams(
  methodId: MethodId,
  ladderIndex: number,
  defaults: Readonly<Record<string, number | string | boolean>>,
  overrides: Readonly<Record<string, number | string | boolean>>,
): Record<string, number | string | boolean> {
  return { ...defaults, ...rungAt(methodId, ladderIndex).params, ...overrides };
}

export { LADDER_LENGTH };
