/**
 * Stage 6 — CHUNK, and chunk identity. PLAN.md §7.7.
 *
 * Two things live here and they are not the same thing:
 *
 *  1. *Where* the chunk boundaries fall (`chunkDocument`), which is a formatting decision
 *     and may change between pipeline versions.
 *  2. *What a chunk is called* (`chunkKey`), which is PERSISTED. A chunk key is the join
 *     key for every rep the user has ever logged against that piece of text, so it is
 *     deliberately insensitive to case, accents, punctuation and whitespace: fixing a comma
 *     must not orphan weeks of practice. It IS sensitive to the words themselves, and — via
 *     `rankWithinIdenticalGroup` — to which of several identical repeats this one is.
 *
 * Pure: no DOM, no clock, no randomness.
 */

import { fnv1a, identityNormalize } from '../util/hash';
import type { Block, BlockType, Chunk, ChunkStrategy, DocKind, Line, Token } from './types';

// ---------------------------------------------------------------- constants (§7.7)

export const CHUNK_TARGET_WORDS = 28;
export const CHUNK_MIN_WORDS = 6;
export const CHUNK_MAX_WORDS = 60;
export const CHUNK_HARD_MAX_WORDS = 90;

export type ResolvedChunkStrategy = Exclude<ChunkStrategy, 'auto'>;

export interface ChunkOptions {
  /** Only consulted when `strategy` is `'auto'`. */
  kind?: DocKind;
  /** BCP-47 tag for `Intl.Segmenter`. */
  lang?: string;
}

/** §3.4 #23: speech for scripts, line for lyrics and verse, sentence-merged for prose. */
export function resolveStrategy(strategy: ChunkStrategy, kind: DocKind): ResolvedChunkStrategy {
  if (strategy !== 'auto') return strategy;
  switch (kind) {
    case 'script':
      return 'speech';
    case 'lyrics':
    case 'poem':
      return 'line';
    default:
      return 'sentence';
  }
}

// ---------------------------------------------------------------- sentence segmentation

/**
 * §7.7's abbreviation guard. Keys are the abbreviation with its dots removed and
 * lowercased, so `e.g.` and `eg.` both land on `eg`.
 *
 * `D.C.` is deliberately absent: a dotted acronym followed by a capitalised word really
 * does usually end a sentence ("…Washington, D.C. He stayed."), and the lowercase-follower
 * rule below already catches the other direction ("…D.C. and then…").
 */
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'rev',
  'fr',
  'st',
  'sr',
  'jr',
  'capt',
  'sgt',
  'lt',
  'col',
  'gen',
  'vs',
  'etc',
  'eg',
  'ie',
  'cf',
  'al',
  'no',
  'vol',
  'ch',
  'fig',
  'op',
  'inc',
  'ltd',
  'co',
  'dept',
  'univ',
  'approx',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
  'mon',
  'tue',
  'tues',
  'wed',
  'thu',
  'thur',
  'thurs',
  'fri',
  'sat',
  'sun',
]);

const OPENERS = '([{“‘«';
const CLOSERS = ')]}”’»';
const LOCALE_RE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})*$/;

/** A document's `lang` is sniffed, so it can be junk; a junk tag would throw in Intl. */
function safeLocale(lang: string): string {
  return LOCALE_RE.test(lang) ? lang : 'en';
}

interface Span {
  start: number;
  end: number;
}

/**
 * Sentence boundaries within a single block of text, `Intl.Segmenter` plus §7.7's three
 * corrections (abbreviation guard, quote/bracket balance, no lowercase sentence starts).
 * Callers must not pass text that spans a block boundary.
 */
export function sentenceSplit(text: string, lang = 'en'): string[] {
  const out: string[] = [];
  for (const span of sentenceSpans(text, lang)) {
    const s = text.slice(span.start, span.end).trim();
    if (s !== '') out.push(s);
  }
  return out;
}

function sentenceSpans(text: string, lang: string): Span[] {
  if (text.trim() === '') return [];
  const segmenter = new Intl.Segmenter(safeLocale(lang), { granularity: 'sentence' });
  const spans: Span[] = [];
  for (const seg of segmenter.segment(text)) {
    const start = seg.index;
    const end = start + seg.segment.length;
    const prev = spans[spans.length - 1];
    if (prev !== undefined && shouldJoin(text.slice(prev.start, prev.end), seg.segment)) {
      prev.end = end;
    } else {
      spans.push({ start, end });
    }
  }
  return spans;
}

function shouldJoin(left: string, right: string): boolean {
  const l = left.trimEnd();
  if (l === '') return true;
  if (hasUnclosedDelimiter(l)) return true;
  const first = right.trimStart().charAt(0);
  // ICU breaks after any period; a lowercase continuation is proof it was not a full stop.
  if (first !== '' && /\p{Ll}/u.test(first)) return true;
  return endsWithAbbreviation(l);
}

function hasUnclosedDelimiter(s: string): boolean {
  let depth = 0;
  let straightQuotes = 0;
  for (const ch of s) {
    if (OPENERS.includes(ch)) depth++;
    else if (CLOSERS.includes(ch)) depth = depth > 0 ? depth - 1 : 0;
    else if (ch === '"') straightQuotes++;
  }
  return depth > 0 || straightQuotes % 2 === 1;
}

function endsWithAbbreviation(s: string): boolean {
  const m = /(\S+)$/.exec(s);
  const raw = m?.[1];
  if (raw === undefined) return false;
  const word = raw.replace(/["'”’)\]]+$/u, '');
  if (!word.endsWith('.')) return false;
  if (/^\p{Lu}\.$/u.test(word)) return true; // a lone initial: "J. R. R. Tolkien"
  return ABBREVIATIONS.has(word.replace(/\./g, '').toLowerCase());
}

// ---------------------------------------------------------------- chunk identity

function tokensOf(chunk: Chunk, lines: readonly Line[]): Token[] {
  const [start, end] = chunk.tokenRange;
  const out: Token[] = [];
  for (const lineIdx of chunk.lineIdxs) {
    const line = lineAt(lines, lineIdx);
    if (line === undefined) continue;
    for (const t of line.tokens) {
      if (t.i >= start && t.i < end) out.push(t);
    }
  }
  out.sort((a, b) => a.i - b.i);
  return out;
}

function lineAt(lines: readonly Line[], idx: number): Line | undefined {
  const direct = lines[idx];
  if (direct !== undefined && direct.idx === idx) return direct;
  return lines.find((l) => l.idx === idx);
}

/** The chunk's word cores, joined. Punctuation and whitespace are dropped by the caller. */
export function chunkText(chunk: Chunk, lines: readonly Line[]): string {
  return tokensOf(chunk, lines)
    .map((t) => t.text)
    .join(' ');
}

/**
 * `contentHash.wordCount` — everything about a chunk's identity except which repeat it is.
 * The count comes from the *normalised* string rather than the token array so that hash and
 * count stay punctuation-insensitive together; otherwise adding a comma as its own token
 * would change the key even though the hash did not.
 */
function contentSignature(chunk: Chunk, lines: readonly Line[]): string {
  const normalized = identityNormalize(chunkText(chunk, lines));
  const words = normalized === '' ? 0 : normalized.split(' ').length;
  return `${fnv1a(normalized)}.${words}`;
}

/**
 * The persisted chunk key (§7.7): `contentHash.wordCount#rankWithinIdenticalGroup`.
 *
 * The rank is not an ordinal over the whole document. Chunks are grouped by content first
 * and only then numbered within their group, so inserting a fourth chorus at the top of a
 * song still re-anchors the three that were already there — an appearance-order ordinal
 * would shift all of them by one and orphan every single one.
 *
 * `chunkDocument` fills this in; call it directly only when re-deriving a key by hand.
 */
export function chunkKey(chunk: Chunk, lines: readonly Line[], rank = 0): string {
  return `${contentSignature(chunk, lines)}#${rank}`;
}

function assignKeys(chunks: readonly Chunk[], lines: readonly Line[]): Chunk[] {
  const rankOf = new Map<string, number>();
  return chunks.map((c) => {
    const base = contentSignature(c, lines);
    const rank = rankOf.get(base) ?? 0;
    rankOf.set(base, rank + 1);
    return { ...c, key: `${base}#${rank}` };
  });
}

// ---------------------------------------------------------------- re-anchoring

export interface ReanchorResult {
  /** old chunk key -> surviving new chunk key. */
  matched: Map<string, string>;
  /** Old keys with no counterpart. The UI may honestly say "N chunks changed". */
  orphaned: string[];
}

/**
 * Stage 1 only (§7.7): exact key match. Handles insertions, deletions, reordering and edits
 * elsewhere in the document. Fuzzy re-anchoring (stages 2–3) is LATER, §3.3 — until it
 * lands, an edited chunk is reported as orphaned rather than silently mapped to a guess.
 */
export function reanchorChunks(
  oldKeys: readonly string[],
  newChunks: readonly Chunk[],
  newLines: readonly Line[],
): ReanchorResult {
  // Re-derive rather than trust `chunk.key`, so a caller holding chunks from an older
  // pipeline version cannot produce a mapping that disagrees with what will be persisted.
  const available = new Set(assignKeys(newChunks, newLines).map((c) => c.key));
  const matched = new Map<string, string>();
  const orphaned: string[] = [];
  const seen = new Set<string>();
  for (const key of oldKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (available.has(key)) matched.set(key, key);
    else orphaned.push(key);
  }
  return { matched, orphaned };
}

// ---------------------------------------------------------------- rows

interface Row {
  line: Line;
  blockIdx: number;
  blockType: BlockType;
  speakerId: string | null;
  /** A user chunk break (`---` marker line or a stored chunkBreak override) starts here. */
  breakBefore: boolean;
  blankBefore: boolean;
}

const MARKER_RE = /^\s*([-*_=])\1{2,}\s*$/;

function buildRows(
  lines: readonly Line[],
  blocks: readonly Block[],
  manualBreaks: ReadonlySet<string>,
): Row[] {
  const blockByIdx = new Map(blocks.map((b) => [b.idx, b]));
  const ordered = [...lines].sort((a, b) => a.idx - b.idx);
  const rows: Row[] = [];
  let pendingBreak = false;
  let pendingBlank = false;
  for (const line of ordered) {
    if (MARKER_RE.test(line.text)) {
      // A separator line is a boundary, not content; it belongs to no chunk.
      pendingBreak = true;
      continue;
    }
    if (line.tokens.length === 0) {
      pendingBlank = true;
      continue;
    }
    const block = blockByIdx.get(line.blockIdx);
    rows.push({
      line,
      blockIdx: line.blockIdx,
      blockType: block?.type ?? 'paragraph',
      speakerId: block?.speakerId ?? null,
      breakBefore: pendingBreak || manualBreaks.has(line.fingerprint),
      blankBefore: pendingBlank,
    });
    pendingBreak = false;
    pendingBlank = false;
  }
  return rows;
}

function groupByBlock(rows: readonly Row[]): Row[][] {
  const groups: Row[][] = [];
  let current: Row[] = [];
  for (const row of rows) {
    const prev = current[current.length - 1];
    if (prev !== undefined && prev.blockIdx !== row.blockIdx) {
      groups.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// ---------------------------------------------------------------- units

interface Unit {
  tokens: Token[];
  blockIdxs: number[];
  /** null when the unit spans blocks of differing types. */
  blockType: BlockType | null;
  /** null when the unit spans speakers — which the `speech` strategy never allows. */
  speakerId: string | null;
  startBreak: boolean;
  blankBefore: boolean;
}

function countWords(tokens: readonly Token[]): number {
  let n = 0;
  for (const t of tokens) if (t.kind === 'word' || t.kind === 'number') n++;
  return n;
}

function makeUnit(tokens: Token[], rowByLine: ReadonlyMap<number, Row>, startBreak: boolean): Unit {
  const blockIdxs: number[] = [];
  const types = new Set<BlockType>();
  const speakers = new Set<string | null>();
  let blankBefore = false;
  let first = true;
  for (const t of tokens) {
    const row = rowByLine.get(t.lineIdx);
    if (row === undefined) continue;
    if (!blockIdxs.includes(row.blockIdx)) blockIdxs.push(row.blockIdx);
    types.add(row.blockType);
    speakers.add(row.speakerId);
    if (first) {
      blankBefore = row.blankBefore;
      first = false;
    }
  }
  const onlyType = types.size === 1 ? [...types][0] : undefined;
  const onlySpeaker = speakers.size === 1 ? [...speakers][0] : undefined;
  return {
    tokens,
    blockIdxs,
    blockType: onlyType ?? null,
    speakerId: onlySpeaker ?? null,
    startBreak,
    blankBefore,
  };
}

function buildLineUnits(rows: readonly Row[], rowByLine: ReadonlyMap<number, Row>): Unit[] {
  return rows.map((row) => makeUnit([...row.line.tokens], rowByLine, row.breakBefore));
}

function buildBlockUnits(rows: readonly Row[], rowByLine: ReadonlyMap<number, Row>): Unit[] {
  return runsToUnits(
    rows,
    rowByLine,
    (prev, row) => !row.breakBefore && prev.blockIdx === row.blockIdx,
  );
}

/**
 * One speaker's continuous run. Two dialogue blocks merge only when they name the same
 * speaker; everything else — a stage direction, a scene heading, another character — ends
 * the run, which is what makes "a chunk never spans a speaker change" true by construction.
 */
function buildSpeechUnits(rows: readonly Row[], rowByLine: ReadonlyMap<number, Row>): Unit[] {
  return runsToUnits(rows, rowByLine, (prev, row) => {
    if (row.breakBefore) return false;
    if (prev.blockIdx === row.blockIdx) return true;
    return (
      prev.blockType === 'dialogue' &&
      row.blockType === 'dialogue' &&
      row.speakerId !== null &&
      prev.speakerId === row.speakerId
    );
  });
}

function runsToUnits(
  rows: readonly Row[],
  rowByLine: ReadonlyMap<number, Row>,
  continues: (prev: Row, row: Row) => boolean,
): Unit[] {
  const units: Unit[] = [];
  let tokens: Token[] = [];
  let startBreak = false;
  let prev: Row | undefined;
  for (const row of rows) {
    if (prev !== undefined && !continues(prev, row)) {
      units.push(makeUnit(tokens, rowByLine, startBreak));
      tokens = [];
    }
    if (tokens.length === 0) startBreak = row.breakBefore;
    tokens.push(...row.line.tokens);
    prev = row;
  }
  if (tokens.length > 0) units.push(makeUnit(tokens, rowByLine, startBreak));
  return units;
}

/** Tokens of one block group, partitioned into sentences (§7.7: segment *within* a block). */
function segmentGroup(rows: readonly Row[], lang: string): Token[][] {
  // Verse keeps its line breaks so ICU treats each line as a sentence; prose and dialogue
  // are rejoined with a space so a hard-wrapped paragraph is not split at every wrap point.
  const joiner = rows[0]?.blockType === 'verse' ? '\n' : ' ';
  let text = '';
  const marks: Array<{ token: Token; at: number }> = [];
  rows.forEach((row, ri) => {
    if (ri > 0) text += joiner;
    for (const t of row.line.tokens) {
      text += t.ws;
      marks.push({ token: t, at: text.length + t.lead.length });
      text += t.lead + t.text + t.trail;
    }
  });

  const spans = sentenceSpans(text, lang);
  const out: Token[][] = [];
  let si = 0;
  let current: Token[] = [];
  for (const { token, at } of marks) {
    let next = si;
    while (next + 1 < spans.length) {
      const candidate = spans[next + 1];
      if (candidate !== undefined && at >= candidate.start) next++;
      else break;
    }
    if (next !== si && current.length > 0) {
      out.push(current);
      current = [];
    }
    si = next;
    current.push(token);
  }
  if (current.length > 0) out.push(current);
  return out;
}

function startsLine(token: Token, rowByLine: ReadonlyMap<number, Row>): boolean {
  return rowByLine.get(token.lineIdx)?.line.tokens[0]?.i === token.i;
}

function isBreakStart(token: Token, rowByLine: ReadonlyMap<number, Row>): boolean {
  const row = rowByLine.get(token.lineIdx);
  if (row === undefined || !row.breakBefore) return false;
  return startsLine(token, rowByLine);
}

function buildSentenceUnits(
  rows: readonly Row[],
  rowByLine: ReadonlyMap<number, Row>,
  targetWords: number,
  lang: string,
): Unit[] {
  const units: Unit[] = [];
  for (const group of groupByBlock(rows)) {
    const pieces: Token[][] = [];
    for (const sentence of segmentGroup(group, lang)) {
      let current: Token[] = [];
      for (const token of sentence) {
        if (current.length > 0 && isBreakStart(token, rowByLine)) {
          pieces.push(current);
          current = [];
        }
        current.push(token);
      }
      if (current.length > 0) pieces.push(current);
    }

    // Merge sentences up to the target. A runt always joins its neighbour; a full-size
    // sentence starts a new chunk rather than overshooting.
    let acc: Token[] = [];
    let accStartBreak = false;
    for (const piece of pieces) {
      const head = piece[0];
      const pieceBreak = head !== undefined && isBreakStart(head, rowByLine);
      const fits = countWords(acc) + countWords(piece) <= targetWords;
      const accIsRunt = countWords(acc) < CHUNK_MIN_WORDS;
      if (acc.length > 0 && (pieceBreak || !(fits || accIsRunt))) {
        units.push(makeUnit(acc, rowByLine, accStartBreak));
        acc = [];
      }
      if (acc.length === 0) accStartBreak = pieceBreak;
      acc.push(...piece);
    }
    if (acc.length > 0) units.push(makeUnit(acc, rowByLine, accStartBreak));
  }
  return units;
}

// ---------------------------------------------------------------- splitting oversized units

const CLAUSE_CONNECTORS = new Set(['and', 'but', 'or', 'so', 'because', 'which', 'who', 'then']);

function isClauseBoundary(prev: Token, cur: Token): boolean {
  if (/[;:—]/.test(prev.trail)) return true;
  if (prev.kind === 'punct' && /[;:—]/.test(prev.text)) return true;
  return prev.trail.includes(',') && CLAUSE_CONNECTORS.has(cur.normalized);
}

/** Never cut inside an inline-direction span (§7.7). */
function cuttable(tokens: readonly Token[], j: number): boolean {
  const before = tokens[j - 1];
  const at = tokens[j];
  if (before === undefined || at === undefined) return false;
  return !(before.kind === 'direction' && at.kind === 'direction');
}

type BoundaryKind = 'sentence' | 'clause' | 'line' | 'word';

function cutPoints(
  tokens: readonly Token[],
  kind: BoundaryKind,
  sentenceStarts: ReadonlySet<number>,
): number[] {
  const points: number[] = [];
  for (let j = 1; j < tokens.length; j++) {
    const prev = tokens[j - 1];
    const cur = tokens[j];
    if (prev === undefined || cur === undefined) continue;
    if (!cuttable(tokens, j)) continue;
    const ok =
      kind === 'sentence'
        ? sentenceStarts.has(cur.i)
        : kind === 'clause'
          ? isClauseBoundary(prev, cur)
          : kind === 'line'
            ? prev.lineIdx !== cur.lineIdx
            : true;
    if (ok) points.push(j);
  }
  return points;
}

function greedyCut(
  tokens: readonly Token[],
  points: readonly number[],
  targetWords: number,
): Token[][] {
  const pieces: Token[][] = [];
  let last = 0;
  for (const j of points) {
    if (countWords(tokens.slice(last, j)) >= targetWords) {
      pieces.push(tokens.slice(last, j));
      last = j;
    }
  }
  pieces.push(tokens.slice(last));
  return pieces.filter((p) => p.length > 0);
}

const BOUNDARY_ORDER: readonly BoundaryKind[] = ['sentence', 'clause', 'line', 'word'];

function splitTokens(
  tokens: readonly Token[],
  targetWords: number,
  sentenceStarts: ReadonlySet<number>,
): Token[][] {
  if (countWords(tokens) <= CHUNK_MAX_WORDS) return [[...tokens]];
  for (const kind of BOUNDARY_ORDER) {
    const points = cutPoints(tokens, kind, sentenceStarts);
    if (points.length === 0) continue;
    const pieces = greedyCut(tokens, points, targetWords);
    // No progress at this granularity — fall through to a finer boundary type.
    if (pieces.length < 2) continue;
    return pieces.flatMap((p) => splitTokens(p, targetWords, sentenceStarts));
  }
  return [[...tokens]];
}

function splitUnits(
  units: readonly Unit[],
  rowByLine: ReadonlyMap<number, Row>,
  targetWords: number,
  sentenceStarts: ReadonlySet<number>,
): Unit[] {
  const out: Unit[] = [];
  for (const unit of units) {
    const pieces = splitTokens(unit.tokens, targetWords, sentenceStarts);
    pieces.forEach((piece, i) => {
      out.push(makeUnit(piece, rowByLine, i === 0 ? unit.startBreak : false));
    });
  }
  return out;
}

// ---------------------------------------------------------------- runt merging

function sameSingleBlock(a: Unit, b: Unit): boolean {
  return a.blockIdxs.length === 1 && b.blockIdxs.length === 1 && a.blockIdxs[0] === b.blockIdxs[0];
}

function canMerge(a: Unit, b: Unit): boolean {
  if (b.startBreak) return false;
  if (a.blockType === 'heading' || b.blockType === 'heading') return false;
  if (sameSingleBlock(a, b)) return true;
  // Cross-block: same role, same block type, nothing structural in between (§7.7).
  if (b.blankBefore) return false;
  if (a.speakerId === null || a.speakerId !== b.speakerId) return false;
  if (a.blockType === null || a.blockType !== b.blockType) return false;
  const lastA = a.blockIdxs[a.blockIdxs.length - 1];
  const firstB = b.blockIdxs[0];
  return lastA !== undefined && firstB !== undefined && firstB === lastA + 1;
}

function mergeUnits(a: Unit, b: Unit, rowByLine: ReadonlyMap<number, Row>): Unit {
  return makeUnit([...a.tokens, ...b.tokens], rowByLine, a.startBreak);
}

/** §7.7: "merge runt units (< MIN) forward when mergeable", falling back to backward. */
function mergeRunts(units: readonly Unit[], rowByLine: ReadonlyMap<number, Row>): Unit[] {
  const out: Unit[] = [];
  let pending: Unit | undefined;
  for (const unit of units) {
    let next = unit;
    if (pending !== undefined) {
      if (
        canMerge(pending, next) &&
        countWords(pending.tokens) + countWords(next.tokens) <= CHUNK_HARD_MAX_WORDS
      ) {
        next = mergeUnits(pending, next, rowByLine);
      } else {
        out.push(pending);
      }
      pending = undefined;
    }
    if (countWords(next.tokens) < CHUNK_MIN_WORDS) {
      pending = next;
      continue;
    }
    out.push(next);
  }
  if (pending !== undefined) {
    const last = out[out.length - 1];
    if (
      last !== undefined &&
      canMerge(last, pending) &&
      countWords(last.tokens) + countWords(pending.tokens) <= CHUNK_HARD_MAX_WORDS
    ) {
      out[out.length - 1] = mergeUnits(last, pending, rowByLine);
    } else {
      out.push(pending);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the chunker

const NO_BREAKS: ReadonlySet<string> = new Set<string>();

/**
 * `tokenRange` is half-open: `[firstTokenIndex, lastTokenIndex + 1)`.
 *
 * @param manualBreaks line fingerprints (StructureOverride `chunkBreak`) before which a
 *                     chunk boundary is forced.
 */
export function chunkDocument(
  lines: readonly Line[],
  blocks: readonly Block[],
  strategy: ChunkStrategy = 'auto',
  targetWords: number = CHUNK_TARGET_WORDS,
  manualBreaks: ReadonlySet<string> = NO_BREAKS,
  options: ChunkOptions = {},
): Chunk[] {
  const lang = options.lang ?? 'en';
  const resolved = resolveStrategy(strategy, options.kind ?? 'other');
  const target = targetWords > 0 ? targetWords : CHUNK_TARGET_WORDS;

  const rows = buildRows(lines, blocks, manualBreaks);
  if (rows.length === 0) return [];
  const rowByLine = new Map(rows.map((r) => [r.line.idx, r]));

  const sentenceStarts = new Set<number>();
  for (const group of groupByBlock(rows)) {
    for (const sentence of segmentGroup(group, lang)) {
      const head = sentence[0];
      if (head !== undefined) sentenceStarts.add(head.i);
    }
  }

  let units: Unit[];
  switch (resolved) {
    case 'line':
      units = buildLineUnits(rows, rowByLine);
      break;
    case 'block':
      units = buildBlockUnits(rows, rowByLine);
      break;
    case 'speech':
      units = buildSpeechUnits(rows, rowByLine);
      break;
    default:
      units = buildSentenceUnits(rows, rowByLine, target, lang);
      break;
  }

  units = splitUnits(units, rowByLine, target, sentenceStarts);
  // The `line` strategy is chosen precisely because the line IS the memory unit (§3.4 #23),
  // so short lyric and verse lines are not runts to be swept up — they are the point.
  if (resolved !== 'line') units = mergeRunts(units, rowByLine);

  const draft: Chunk[] = [];
  for (const unit of units) {
    const first = unit.tokens[0];
    const last = unit.tokens[unit.tokens.length - 1];
    if (first === undefined || last === undefined) continue;
    const lineIdxs: number[] = [];
    for (const t of unit.tokens) {
      if (lineIdxs[lineIdxs.length - 1] !== t.lineIdx) lineIdxs.push(t.lineIdx);
    }
    draft.push({
      idx: draft.length,
      key: '',
      lineIdxs,
      tokenRange: [first.i, last.i + 1],
      wordCount: countWords(unit.tokens),
      speakerId: unit.speakerId,
    });
  }

  return assignKeys(draft, lines);
}
