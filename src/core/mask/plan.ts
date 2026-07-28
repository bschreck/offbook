/**
 * computeMaskPlan — the single entry point. PLAN.md §8.2, §8.4, §8.5.
 *
 * PURE: no DOM, no I/O, no Math.random, no Date.now. Everything — rendering, gestures, the
 * ladder, progress — reads the plan, and nothing else in the app computes masking.
 *
 * The order of operations is the whole design (§8.4 fix A):
 *
 *   1. scope        -> which tokens are in play at all
 *   2. FILTERS      -> Protect, MyLines, and the method's own eligibility rule
 *   3. seeded order -> one permutation per (doc, method, roles, scope, reshuffle).
 *                      The ladder index is deliberately NOT in the seed.
 *   4. spacing pass -> reorders that permutation into a single total order
 *   5. k = f(p, n)  -> computed over the FILTERED candidate count, so density is exact
 *   6. POST-PASSES  -> Window and Reveals, and only those two
 */

import type { Document, Token } from '../text/types';
import { clamp, invariant } from '../util/assert';
import { eligibleLineIndices } from './kernels/lineLevel';
import {
  computeK,
  deriveMinGap,
  isContentToken,
  orderByRank,
  orderByValue,
  randomRanks,
  spacingPass,
} from './kernels/percent';
import type { PositionalRung } from './kernels/positional';
import {
  detectRhymeWords,
  headSelection,
  isWordLike,
  lineFinalWords,
  monotoneDepth,
  tailSelection,
} from './kernels/positional';
import { computeWindow, inRange } from './kernels/window';
import type { Rung, RungStyle } from './ladder';
import { LADDERS, ladderFor, rungAt } from './ladder';
import { cueLineSet, isMine, roleSetHash } from './lens/myLines';
import type { ProtectConfig } from './lens/protect';
import { isProtected, isStructuralToken, protectBucket } from './lens/protect';
import { applyReveals } from './lens/reveals';
import { getMethod } from './registry';
import { maskSeed, rngFromSeed } from './rng';
import type { BlankStyle, MaskPlan, MaskStyleCode, MethodId, ModeSpec } from './types';
import { LADDER_LENGTH, LineFlag, MaskStyle } from './types';

type Params = Record<string, number | string | boolean>;

/**
 * `MaskStyle` has no `box` code (§0.0 A3 trimmed the enum to six), so the box blank renders as
 * the underline rule. The two differ only in CSS fill, and nothing in the plan depends on it.
 */
const BLANK_STYLE_CODE: Readonly<Record<BlankStyle, MaskStyleCode>> = {
  underline: MaskStyle.rule,
  box: MaskStyle.rule,
  dots: MaskStyle.dots,
};

/** §8.5 method 6: below this content ratio, `keyWords` degenerates and falls back to random. */
const COLLOQUIAL_CONTENT_RATIO = 0.25;

// ---------------------------------------------------------------- param helpers

function numParam(params: Params, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function boolParam(params: Params, key: string, fallback: boolean): boolean {
  const v = params[key];
  return typeof v === 'boolean' ? v : fallback;
}

function strParam(params: Params, key: string, fallback: string): string {
  const v = params[key];
  return typeof v === 'string' ? v : fallback;
}

// ---------------------------------------------------------------- document index

interface DocIndex {
  lineIdxOf: Int32Array;
  /** Position among the word-like tokens of the line. -1 for punctuation. */
  wordPosOf: Int32Array;
  firstWordOfLine: Int32Array;
  lineWordCounts: number[];
}

function buildIndex(doc: Document): DocIndex {
  const lineIdxOf = new Int32Array(doc.tokens.length);
  const wordPosOf = new Int32Array(doc.tokens.length).fill(-1);
  const firstWordOfLine = new Int32Array(doc.lines.length).fill(-1);
  const lineWordCounts = new Array<number>(doc.lines.length).fill(0);

  for (const t of doc.tokens) {
    lineIdxOf[t.i] = t.lineIdx;
    if (!isWordLike(t)) continue;
    if (t.lineIdx < 0 || t.lineIdx >= lineWordCounts.length) continue;
    const pos = lineWordCounts[t.lineIdx] ?? 0;
    wordPosOf[t.i] = pos;
    lineWordCounts[t.lineIdx] = pos + 1;
    if (firstWordOfLine[t.lineIdx] === -1) firstWordOfLine[t.lineIdx] = t.i;
  }
  return { lineIdxOf, wordPosOf, firstWordOfLine, lineWordCounts };
}

function scopeMask(doc: Document, scope: ModeSpec['scope']): Uint8Array {
  const mask = new Uint8Array(doc.tokens.length);
  if (scope.kind === 'chunk') {
    const key = scope.chunkKey;
    const chunk = key === undefined ? undefined : doc.chunks.find((c) => c.key === key);
    invariant(chunk !== undefined, `mask scope names an unknown chunk: ${String(key)}`);
    mask.fill(
      1,
      clamp(chunk.tokenRange[0], 0, mask.length),
      clamp(chunk.tokenRange[1], 0, mask.length),
    );
    return mask;
  }
  if (scope.kind === 'selection') {
    const range = scope.range;
    invariant(range !== undefined, 'mask scope "selection" needs a range');
    mask.fill(1, clamp(range[0], 0, mask.length), clamp(range[1], 0, mask.length));
    return mask;
  }
  mask.fill(1);
  return mask;
}

function scopeKeyOf(scope: ModeSpec['scope']): string {
  if (scope.kind === 'chunk') return `chunk:${scope.chunkKey ?? ''}`;
  if (scope.kind === 'selection') return `sel:${scope.range?.[0] ?? 0}-${scope.range?.[1] ?? 0}`;
  return 'text';
}

// ---------------------------------------------------------------- context

interface Ctx {
  doc: Document;
  spec: ModeSpec;
  methodId: MethodId;
  params: Params;
  rung: number;
  bucket: number;
  index: DocIndex;
  inScope: Uint8Array;
  minGap: number;
  ranks: Float64Array;
  lineRanks: Float64Array;
  protectCfg: ProtectConfig;
  rhymeWords: Set<number>;
  /** §8.5 method 6's colloquial-dialogue guard has fired. */
  keyWordsFellBack: boolean;
  windowUnitOf: ((t: Token) => number) | null;
  windowFocus: { start: number; end: number } | null;
}

function resolveRungIndex(spec: ModeSpec): number {
  if (spec.ladderIndex !== null) return clamp(Math.round(spec.ladderIndex), 0, LADDER_LENGTH - 1);
  const p = clamp(spec.customPercent ?? 0, 0, 100) / 100;
  const rungs = LADDERS[spec.methodId];
  let best = 0;
  for (let i = 0; i < rungs.length; i++) {
    const rung = rungs[i];
    if (rung !== undefined && rung.p <= p) best = i;
  }
  return best;
}

function defaultInterjectionProtection(doc: Document): boolean {
  // §8.4: default on for scripts, off for prose. Lyrics behave like scripts here — the
  // interjection IS the hook line often enough that hiding it early is the wrong lesson.
  return doc.kind === 'script' || doc.kind === 'lyrics';
}

function buildContext(doc: Document, spec: ModeSpec): Ctx {
  const method = getMethod(spec.methodId);
  const params: Params = { ...method.defaultParams, ...spec.params };
  const rung = resolveRungIndex(spec);
  Object.assign(params, rungAt(spec.methodId, rung).params, spec.params);

  const index = buildIndex(doc);
  const inScope = scopeMask(doc, spec.scope);
  const scopeKey = scopeKeyOf(spec.scope);
  const seed = maskSeed(
    doc.id,
    spec.methodId,
    roleSetHash(spec.lens.myRoleIds),
    scopeKey,
    spec.reshuffle,
  );
  const ranks = randomRanks(doc.tokens.length, rngFromSeed(seed));
  // Structural methods reshuffle via `phase` rather than `reshuffle` (§8.4), so the line
  // permutation gets its own stream keyed on both.
  const lineRanks = randomRanks(doc.lines.length, rngFromSeed(`${seed}|lines|${spec.phase}`));

  const scopedLineWordCounts: number[] = [];
  for (const line of doc.lines) {
    const first = index.firstWordOfLine[line.idx] ?? -1;
    if (first >= 0 && inScope[first] === 1) {
      scopedLineWordCounts.push(index.lineWordCounts[line.idx] ?? 0);
    }
  }

  const protectCfg: ProtectConfig = {
    firstWord: boolParam(params, 'protectFirstWord', true),
    interjections: boolParam(params, 'protectInterjections', defaultInterjectionProtection(doc)),
    numbers: boolParam(params, 'protectNumbers', true),
  };

  const rhymeWords =
    spec.methodId === 'rhymes' ? detectRhymeWords(doc, lineFinalWords(doc)) : new Set<number>();

  const ctx: Ctx = {
    doc,
    spec,
    methodId: spec.methodId,
    params,
    rung,
    bucket: protectBucket(rung),
    index,
    inScope,
    minGap: numParam(params, 'minGap', deriveMinGap(scopedLineWordCounts)),
    ranks,
    lineRanks,
    protectCfg,
    rhymeWords,
    keyWordsFellBack: false,
    windowUnitOf: null,
    windowFocus: null,
  };

  if (spec.methodId === 'keyWords') ctx.keyWordsFellBack = keyWordsFallsBack(doc, spec);
  if (spec.methodId === 'chunkWindow') attachWindow(ctx);
  return ctx;
}

/**
 * §8.5 method 6. "Well, I have to go now, don't you think?" has exactly one content word, so
 * four of seven rungs would render an unmasked screen while the UI claims 15–45% hidden.
 */
export function keyWordsFallsBack(doc: Document, spec: ModeSpec): boolean {
  const inScope = scopeMask(doc, spec.scope);
  let maskable = 0;
  let content = 0;
  for (const t of doc.tokens) {
    if (inScope[t.i] !== 1 || !t.isMaskable) continue;
    if (!isMine(doc, t, spec.lens.myRoleIds)) continue;
    maskable++;
    if (isContentToken(t)) content++;
  }
  return maskable > 0 && content / maskable < COLLOQUIAL_CONTENT_RATIO;
}

function attachWindow(ctx: Ctx): void {
  const unit = strParam(ctx.params, 'unit', 'chunk');
  const byLine = unit === 'line';
  const unitCount = byLine ? ctx.doc.lines.length : ctx.doc.chunks.length;
  const layout = computeWindow(
    unitCount,
    numParam(ctx.params, 'windowIndex', 0),
    numParam(ctx.params, 'windowSize', 1),
    numParam(ctx.params, 'lookback', 1),
    numParam(ctx.params, 'lookahead', 0),
  );
  ctx.windowUnitOf = byLine ? (t) => t.lineIdx : (t) => t.chunkIdx;
  ctx.windowFocus = { start: layout.focusStart, end: layout.focusEnd };
}

// ---------------------------------------------------------------- candidates

function methodEligible(ctx: Ctx, t: Token): boolean {
  switch (ctx.methodId) {
    case 'keyWords':
      return ctx.keyWordsFellBack || isContentToken(t);
    case 'glueWords':
      return t.isFunction;
    case 'rhymes':
      return !ctx.rhymeWords.has(t.i);
    case 'chunkWindow': {
      const unitOf = ctx.windowUnitOf;
      const focus = ctx.windowFocus;
      if (unitOf === null || focus === null) return true;
      return inRange(unitOf(t), focus.start, focus.end);
    }
    default:
      return true;
  }
}

function baseEligible(ctx: Ctx, t: Token, applyMethodRule: boolean): boolean {
  return (
    t.isMaskable &&
    ctx.inScope[t.i] === 1 &&
    isMine(ctx.doc, t, ctx.spec.lens.myRoleIds) &&
    (!applyMethodRule || methodEligible(ctx, t))
  );
}

type Eligible = (t: Token) => boolean;

/**
 * `extra` replaces the method's own eligibility rule rather than narrowing it — `glueWords`'
 * secondary content track needs exactly the tokens the primary rule excludes.
 */
function rawCandidates(ctx: Ctx, bucket: number, extra?: Eligible): number[] {
  const out: number[] = [];
  for (const t of ctx.doc.tokens) {
    if (!baseEligible(ctx, t, extra === undefined)) continue;
    if (extra !== undefined && !extra(t)) continue;
    if (isProtected(ctx.doc, t, bucket, ctx.protectCfg, ctx.index.firstWordOfLine)) continue;
    out.push(t.i);
  }
  return out;
}

// ---------------------------------------------------------------- the total order

interface Track {
  /** Candidates at a Protect bucket, already in pick order. */
  ordered: (bucket: number) => number[];
  /** Density at a ladder rung. */
  pAt: (rung: number) => number;
}

/**
 * The single total order of §8.4 step 4, built cumulatively across the ladder.
 *
 * Why cumulatively: `Protect` releases interjections at rung 3 and numbers at rung 4, so the
 * candidate set GROWS as you climb. A plain "sort the current candidates, take the first k"
 * would then let a word picked at rung 2 fall outside rung 3's prefix — the nesting violation
 * §8.4 calls the most damaging possible bug. Filling rung by rung and never removing anything
 * makes `masked(L_n) ⊆ masked(L_{n+1})` true by construction while keeping |masked| exactly k.
 *
 * When the candidate set does not change between rungs (the common case) this reduces exactly
 * to the plain prefix of one permutation.
 */
function buildTotalOrder(track: Track, maxBucket: number): number[] {
  const order: number[] = [];
  const seen = new Set<number>();
  for (let rung = 0; rung < LADDER_LENGTH; rung++) {
    if (protectBucket(rung) > maxBucket) break;
    const candidates = track.ordered(protectBucket(rung));
    const k = computeK(track.pAt(rung), candidates.length);
    if (k <= order.length) continue;
    for (const tok of candidates) {
      if (order.length >= k) break;
      if (seen.has(tok)) continue;
      seen.add(tok);
      order.push(tok);
    }
  }
  // Tail, so a custom percent above the top rung's density still has somewhere to draw from.
  for (const tok of track.ordered(maxBucket)) {
    if (seen.has(tok)) continue;
    seen.add(tok);
    order.push(tok);
  }
  return order;
}

function orderCandidates(ctx: Ctx, candidates: number[], byValue: boolean): number[] {
  const permuted = byValue
    ? orderByValue(candidates, ctx.doc.tokens, ctx.ranks)
    : orderByRank(candidates, ctx.ranks);
  return spacingPass(permuted, ctx.index.lineIdxOf, ctx.index.wordPosOf, ctx.minGap);
}

function makeTokenTrack(
  ctx: Ctx,
  densities: readonly number[],
  extra?: Eligible,
  byValue = false,
): Track {
  const cache = new Map<number, number[]>();
  return {
    ordered: (bucket) => {
      const hit = cache.get(bucket);
      if (hit !== undefined) return hit;
      const built = orderCandidates(ctx, rawCandidates(ctx, bucket, extra), byValue);
      cache.set(bucket, built);
      return built;
    },
    pAt: (rung) => densities[rung] ?? 0,
  };
}

function densityAt(ctx: Ctx, rung: Rung): number {
  if (ctx.spec.customPercent !== null) return clamp(ctx.spec.customPercent, 0, 100) / 100;
  return rung.p;
}

interface Selection {
  picked: number[];
  candidateCount: number;
}

function selectFromTrack(ctx: Ctx, track: Track, p: number): Selection {
  const candidates = track.ordered(ctx.bucket);
  const k = computeK(p, candidates.length);
  const order = buildTotalOrder(track, ctx.bucket);
  return { picked: order.slice(0, k), candidateCount: candidates.length };
}

// ---------------------------------------------------------------- styles

function styleCodeFor(ctx: Ctx, style: RungStyle): MaskStyleCode {
  if (style === 'initial') return MaskStyle.initial;
  if (style === 'rule') {
    return strParam(ctx.params, 'finalStyle', 'rule') === 'blank'
      ? MaskStyle.blank
      : MaskStyle.rule;
  }
  return BLANK_STYLE_CODE[ctx.spec.blankStyle];
}

/** `chunkWindow` and `myLines` wrap an inner method; only `firstLetters` changes the style. */
function innerAdjustedStyle(ctx: Ctx, style: RungStyle): RungStyle {
  if (style !== 'blank') return style;
  if (ctx.methodId !== 'chunkWindow' && ctx.methodId !== 'myLines') return style;
  return strParam(ctx.params, 'innerMethod', 'hideWords') === 'firstLetters' ? 'initial' : style;
}

// ---------------------------------------------------------------- per-kernel selection

function selectPercent(ctx: Ctx, rung: Rung): Selection {
  const densities = ladderFor(ctx.methodId).map((r) => r.p);
  const track = makeTokenTrack(
    ctx,
    densities,
    undefined,
    ctx.methodId === 'keyWords' && !ctx.keyWordsFellBack,
  );
  return selectFromTrack(ctx, track, densityAt(ctx, rung));
}

/** §8.6: `glueWords` L5/L6 add a nested prefix of content words on top of every glue word. */
function selectGlueContent(ctx: Ctx): Selection {
  const contentP = numParam(ctx.params, 'contentP', 0);
  if (contentP <= 0) return { picked: [], candidateCount: 0 };
  const densities = ladderFor('glueWords').map((r) => numParam({ ...r.params }, 'contentP', 0));
  const track: Track = {
    ...makeTokenTrack(ctx, densities, isContentToken),
    pAt: (rung) => densities[rung] ?? 0,
  };
  return selectFromTrack(ctx, track, contentP);
}

function candidatesByLine(ctx: Ctx, bucket: number): Map<number, number[]> {
  const byLine = new Map<number, number[]>();
  for (const tok of rawCandidates(ctx, bucket)) {
    const line = ctx.index.lineIdxOf[tok] ?? -1;
    const group = byLine.get(line);
    if (group === undefined) byLine.set(line, [tok]);
    else group.push(tok);
  }
  return byLine;
}

/**
 * §8.5 methods 3 and 4. Cumulative union across rungs 0..L, because `monotoneDepth` alone is
 * not enough: `Protect` releasing an interjection that happens to sit at the end of a line
 * would otherwise push an already-masked word out of the tail at the rung above.
 */
function selectPositional(ctx: Ctx): Selection {
  const table: readonly PositionalRung[] = ladderFor(ctx.methodId).map((r) => r.positional);
  const fromEnd = ctx.methodId === 'lineEnds';
  const baseKeepMin = numParam(ctx.params, 'keepMin', 1);
  const bySentence = strParam(ctx.params, 'unit', 'line') === 'sentence';
  const picked = new Set<number>();

  for (let rung = 0; rung <= ctx.rung; rung++) {
    const bucket = protectBucket(rung);
    const groups = bySentence ? candidatesBySentence(ctx, bucket) : candidatesByLine(ctx, bucket);
    const isAll = table[rung] === 'all';
    const keepMin = isAll ? 0 : baseKeepMin;
    // §8.5 method 3 gates on wordCount >= 2; at `all` a one-word line must still go.
    const minWords = isAll ? 1 : 2;
    for (const group of groups.values()) {
      if (group.length < minWords) continue;
      const depth = monotoneDepth(table, rung, group.length);
      const chosen = fromEnd
        ? tailSelection(group, depth, keepMin)
        : headSelection(group, depth, keepMin);
      for (const tok of chosen) picked.add(tok);
    }
  }
  return { picked: [...picked], candidateCount: rawCandidates(ctx, ctx.bucket).length };
}

function candidatesBySentence(ctx: Ctx, bucket: number): Map<string, number[]> {
  const bySent = new Map<string, number[]>();
  for (const tok of rawCandidates(ctx, bucket)) {
    const t = ctx.doc.tokens[tok];
    if (t === undefined) continue;
    const key = `${t.blockIdx}:${t.sentIdx}`;
    const group = bySent.get(key);
    if (group === undefined) bySent.set(key, [tok]);
    else group.push(tok);
  }
  return bySent;
}

/** §8.5 method 5: a seeded nested permutation of LINES, prefix at p. */
function selectLineLevel(ctx: Ctx, rung: Rung, lineFlags: Uint8Array): Selection {
  const densities = ladderFor('hideLines').map((r) => r.p);
  const lineCache = new Map<number, number[]>();
  const orderedLines = (bucket: number): number[] => {
    const hit = lineCache.get(bucket);
    if (hit !== undefined) return hit;
    const eligible = eligibleLineIndices(ctx.doc, candidatesByLine(ctx, bucket));
    const built = orderByRank(eligible, ctx.lineRanks);
    lineCache.set(bucket, built);
    return built;
  };
  const track: Track = { ordered: orderedLines, pAt: (r) => densities[r] ?? 0 };

  const lines = orderedLines(ctx.bucket);
  const k = computeK(densityAt(ctx, rung), lines.length);
  const hidden = buildTotalOrder(track, ctx.bucket).slice(0, k);

  const keepFirstWord = boolParam(ctx.params, 'keepFirstWord', false);
  const byLine = candidatesByLine(ctx, ctx.bucket);
  const picked: number[] = [];
  for (const lineIdx of hidden) {
    if (lineIdx >= 0 && lineIdx < lineFlags.length) {
      lineFlags[lineIdx] = (lineFlags[lineIdx] ?? 0) | LineFlag.hiddenLine;
    }
    const first = ctx.index.firstWordOfLine[lineIdx] ?? -1;
    for (const tok of byLine.get(lineIdx) ?? []) {
      if (keepFirstWord && tok === first) continue;
      picked.push(tok);
    }
  }
  return { picked, candidateCount: lines.length };
}

// ---------------------------------------------------------------- post-passes

/**
 * §8.5 method 9, and one of the two sanctioned post-passes. Inside the window the inner method
 * has already run; the lookback/lookahead shoulders are dimmed and everything else goes blank.
 * dim and blank are both non-zero, so the L4 `lookback 1 -> 0` step still nests.
 */
function applyWindowPass(ctx: Ctx, styles: Uint8Array, lineFlags: Uint8Array): void {
  const unitOf = ctx.windowUnitOf;
  if (unitOf === null) return;
  const byLine = strParam(ctx.params, 'unit', 'chunk') === 'line';
  const unitCount = byLine ? ctx.doc.lines.length : ctx.doc.chunks.length;
  const layout = computeWindow(
    unitCount,
    numParam(ctx.params, 'windowIndex', 0),
    numParam(ctx.params, 'windowSize', 1),
    numParam(ctx.params, 'lookback', 1),
    numParam(ctx.params, 'lookahead', 0),
  );

  for (const t of ctx.doc.tokens) {
    if (ctx.inScope[t.i] !== 1 || !isWordLike(t)) continue;
    if (isStructuralToken(ctx.doc, t)) continue;
    const unit = unitOf(t);
    if (inRange(unit, layout.focusStart, layout.focusEnd)) continue;
    if (styles[t.i] !== 0) continue;
    styles[t.i] = inRange(unit, layout.dimStart, layout.dimEnd) ? MaskStyle.dim : MaskStyle.blank;
  }

  for (const line of ctx.doc.lines) {
    const first = ctx.index.firstWordOfLine[line.idx] ?? -1;
    if (first < 0 || ctx.inScope[first] !== 1) continue;
    const t = ctx.doc.tokens[first];
    if (t === undefined) continue;
    const unit = unitOf(t);
    if (inRange(unit, layout.focusStart, layout.focusEnd)) {
      lineFlags[line.idx] = (lineFlags[line.idx] ?? 0) | LineFlag.focusLine;
    } else if (inRange(unit, layout.dimStart, layout.dimEnd)) {
      lineFlags[line.idx] = (lineFlags[line.idx] ?? 0) | LineFlag.dimLine;
    }
  }
}

function focusRange(lineFlags: Uint8Array): MaskPlan['focus'] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lineFlags.length; i++) {
    if (((lineFlags[i] ?? 0) & LineFlag.focusLine) === 0) continue;
    if (first === -1) first = i;
    last = i;
  }
  return first === -1 ? null : { firstLine: first, lastLine: last };
}

// ---------------------------------------------------------------- entry point

export function computeMaskPlan(doc: Document, spec: ModeSpec): MaskPlan {
  invariant(
    spec.ladderIndex !== null || spec.customPercent !== null,
    'ModeSpec must set exactly one of ladderIndex / customPercent',
  );

  const ctx = buildContext(doc, spec);
  const rung = rungAt(spec.methodId, ctx.rung);
  const styles = new Uint8Array(doc.tokens.length);
  const lineFlags = new Uint8Array(doc.lines.length);

  let selection: Selection;
  switch (ctx.methodId) {
    case 'lineEnds':
    case 'lineStarts':
      selection = selectPositional(ctx);
      break;
    case 'hideLines':
      selection = selectLineLevel(ctx, rung, lineFlags);
      break;
    default:
      selection = selectPercent(ctx, rung);
      break;
  }

  const primaryStyle = styleCodeFor(ctx, innerAdjustedStyle(ctx, rung.style));
  const masked = new Set<number>();
  for (const tok of selection.picked) {
    styles[tok] = primaryStyle;
    masked.add(tok);
  }

  let candidateCount = selection.candidateCount;

  if (ctx.methodId === 'glueWords') {
    const content = selectGlueContent(ctx);
    for (const tok of content.picked) {
      styles[tok] = primaryStyle;
      masked.add(tok);
    }
    candidateCount += content.candidateCount;
  }

  if (ctx.methodId === 'rhymes') {
    const rhymeStyle = strParam(ctx.params, 'rhymeStyle', 'none');
    if (rhymeStyle !== 'none') {
      const code = styleCodeFor(ctx, rhymeStyle === 'initial' ? 'initial' : 'blank');
      for (const tok of ctx.rhymeWords) {
        const t = doc.tokens[tok];
        if (t === undefined || ctx.inScope[tok] !== 1 || !t.isMaskable) continue;
        if (!isMine(doc, t, spec.lens.myRoleIds) || isStructuralToken(doc, t)) continue;
        styles[tok] = code;
        masked.add(tok);
        candidateCount++;
      }
    }
  }

  if (ctx.methodId === 'chunkWindow') applyWindowPass(ctx, styles, lineFlags);

  for (const lineIdx of cueLineSet(doc, spec.lens.myRoleIds)) {
    lineFlags[lineIdx] = (lineFlags[lineIdx] ?? 0) | LineFlag.cueLine;
  }

  // Counts are taken BEFORE reveals: `maskedCount` is helpRate's denominator (§8.7) and must
  // describe the rep the user was set, not what is left of it after they peeked.
  let contentMaskedCount = 0;
  for (const tok of masked) {
    const t = doc.tokens[tok];
    if (t !== undefined && isContentToken(t)) contentMaskedCount++;
  }

  applyReveals(styles, spec.reveals);

  return {
    styles,
    lineFlags,
    focus: focusRange(lineFlags),
    step: null,
    maskedCount: masked.size,
    candidateCount,
    contentMaskedCount,
  };
}
