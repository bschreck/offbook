/**
 * Stage 5 — TOKENIZE. PLAN.md §7.4.
 *
 * `Intl.Segmenter` (Baseline, zero bytes) plus GROUP / PEEL / EMIT SEPARATORS / WHITESPACE /
 * CLASSIFY. A regex tokenizer splits `1,234`, `3.14`, `9:30` and `D.C.` into pieces, which makes
 * `hideWords` render `▁,234` and doubles the candidate count every percent method divides by.
 *
 * THE INVARIANT, asserted here and property-tested in tests/unit/text/tokenize.test.ts:
 *
 *     tokens.map(t => t.ws + t.lead + t.text + t.trail).join('') === lineText
 *
 * It is what lets the reader render from tokens instead of from text with no visual difference
 * from the source.
 *
 * Document-wide flags (`isFunction`, `isProperish`, `hasDigit`, `count`, `isMaskable`) are NOT set
 * here — they need the whole document. See derive-flags.ts.
 */

import { invariant } from '../util/assert';
import type { Token, TokenKind } from './types';

// ---------------------------------------------------------------- segmenter caches

const wordSegmenters = new Map<string, Intl.Segmenter>();
const graphemeSegmenters = new Map<string, Intl.Segmenter>();

function segmenterFor(
  cache: Map<string, Intl.Segmenter>,
  lang: string,
  granularity: 'word' | 'grapheme',
): Intl.Segmenter {
  const hit = cache.get(lang);
  if (hit) return hit;
  let made: Intl.Segmenter;
  try {
    made = new Intl.Segmenter(lang, { granularity });
  } catch {
    // `lang` comes from sniffing and from imported file metadata; a malformed tag throws.
    made = new Intl.Segmenter('en', { granularity });
  }
  cache.set(lang, made);
  return made;
}

// ---------------------------------------------------------------- character classes

/**
 * Punctuation that attaches to the word on its LEFT. `\p{Pe}`/`\p{Pf}` plus the terminal and
 * separating marks of the scripts we support.
 */
const TRAILING_CHAR = /^[\p{Pe}\p{Pf}.,;:!?…%‰*'"’”。、，；：！？،؛؟۔]$/u;

/**
 * Punctuation that attaches to the word on its RIGHT. Dashes are in NEITHER set, which is what
 * makes `wait—no` emit a standalone separator (§7.4 step 3) instead of gluing the dash to a word.
 */
const LEADING_CHAR = /^[\p{Ps}\p{Pi}\p{Sc}¿¡'"‘“#@+~§]$/u;

const APOSTROPHE = /^['’ʼ´`]$/;
const ALL_DIGITS = /^\p{Nd}+$/u;
const SINGLE_LETTER = /^\p{L}$/u;
const CAPS_RUN = /^\p{Lu}{1,3}$/u;
const HAS_LETTER = /\p{L}/u;
const HAS_DIGIT = /\p{N}/u;
const WHITESPACE_RUN = /\p{White_Space}+|[^\p{White_Space}]+/gu;
/** `D.C`, `e.g`, `U.S.S` — an initialism whose dots survived GROUP. */
const INITIALISM = /^\p{L}(?:\.\p{L})+$/u;
/** The characters GROUP may have joined; `letterGroups` splits on them. */
const JOINERS = /['’ʼ´`\-‑.&:/,]/;

/** §7.4 step 2: a leading apostrophe in the ELISION set stays in `text`. */
const ELISION = new Set(
  "'tis 'twas 'twere 'twill 'em 'til 'round 'cause 'bout 'n 'gainst 'neath".split(' '),
);

/**
 * Abbreviations whose full stop stays in `text` (§7.4 step 2). Kept deliberately short and
 * capitalisation-gated: putting `no` or `sun` in here would swallow the terminal period of every
 * sentence ending in those words.
 */
const TITLE_ABBREV = new Set(
  (
    'mr mrs ms mx dr prof rev hon gen col capt lt sgt sr jr st ave blvd rd inc ltd co corp' +
    ' dept univ jan feb mar apr jun jul aug sept oct nov dec'
  ).split(' '),
);
const LOWER_ABBREV = new Set('etc vs al cf ibid viz approx fig vol'.split(' '));

// ---------------------------------------------------------------- options

export interface TokenizeLineOptions {
  /** The `i` of the first token; every later token increments. Default 0. */
  startIndex?: number;
  lineIdx?: number;
  blockIdx?: number;
  /** Default -1: chunking (§7.7) runs after tokenizing and overwrites it. */
  chunkIdx?: number;
}

export interface TokenizeLinesOptions {
  startIndex?: number;
  startLineIdx?: number;
  /** `blockIdx` per line, indexed by position in `lines`. Default: the line's own index. */
  blockIdxs?: readonly number[];
}

// ---------------------------------------------------------------- GROUP

interface Core {
  /** The exact source substring of the word core, possibly re-joined across a separator. */
  text: string;
  /** The exact source substring between the previous core and this one. Never lost. */
  gapBefore: string;
}

/** Split into word-like cores and the exact gaps between them. Concatenation is lossless. */
function splitCores(text: string, lang: string): { cores: Core[]; tailGap: string } {
  const cores: Core[] = [];
  let gap = '';
  for (const seg of segmenterFor(wordSegmenters, lang, 'word').segment(text)) {
    if (seg.isWordLike) {
      cores.push({ text: seg.segment, gapBefore: gap });
      gap = '';
    } else {
      gap += seg.segment;
    }
  }
  return { cores, tailGap: gap };
}

/**
 * §7.4 step 1. `Intl.Segmenter` already joins `don't`, `1,200`, `3.14`, `D.C` and `Rock'n'roll`;
 * this adds the joins UAX#29 breaks: hyphenates, `9:30`, `1/2`, `R&B`.
 */
function canJoin(left: string, gap: string, right: string): boolean {
  if (gap.length !== 1) return false;
  if (APOSTROPHE.test(gap)) return true;
  if (gap === '-' || gap === '‑') return true;
  if (gap === '.') {
    return (SINGLE_LETTER.test(left) && SINGLE_LETTER.test(right)) || isAbbreviation(left);
  }
  const digits = ALL_DIGITS.test(left) && ALL_DIGITS.test(right);
  if (gap === ',' || gap === ':' || gap === '/') return digits;
  // The plan says "both neighbours are single caps"; §14.2 also demands AT&T, so: short caps runs.
  if (gap === '&') return CAPS_RUN.test(left) && CAPS_RUN.test(right);
  return false;
}

function group(cores: Core[]): Core[] {
  const out: Core[] = [];
  for (const core of cores) {
    const prev = out[out.length - 1];
    if (prev && canJoin(prev.text, core.gapBefore, core.text)) {
      prev.text += core.gapBefore + core.text;
    } else {
      out.push(core);
    }
  }
  return out;
}

function isAbbreviation(core: string): boolean {
  if (INITIALISM.test(core)) return true;
  const lower = core.toLowerCase();
  if (LOWER_ABBREV.has(lower)) return true;
  return /^\p{Lu}/u.test(core) && TITLE_ABBREV.has(lower);
}

// ---------------------------------------------------------------- CLASSIFY helpers

function graphemes(text: string, lang: string): string[] {
  return [...segmenterFor(graphemeSegmenters, lang, 'grapheme').segment(text)].map(
    (s) => s.segment,
  );
}

/** Graphemes bearing `\p{L}` — never `.length` (Vietnamese, Devanagari, emoji ZWJ). */
function countLetters(text: string, lang: string): number {
  let n = 0;
  for (const g of graphemes(text, lang)) if (HAS_LETTER.test(g)) n++;
  return n;
}

/**
 * Per-segment letter counts across the characters GROUP may have joined:
 * `mother-in-law` -> [6,2,3], `mother-in-law's` -> [6,2,3,1]. Segments with no letters
 * (the `1,200` of `1,200-page`) are dropped, so a pure number yields [].
 */
function letterGroupsOf(text: string, lang: string): number[] {
  const out: number[] = [];
  for (const part of text.split(JOINERS)) {
    if (part === '') continue;
    const n = countLetters(part, lang);
    if (n > 0) out.push(n);
  }
  return out;
}

function firstLetterOf(text: string, lang: string): string {
  for (const g of graphemes(text, lang)) if (HAS_LETTER.test(g)) return g;
  return '';
}

/** NFD, marks stripped, lowercased, apostrophes unified. The key for counting and lookup. */
export function normalizeToken(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[‘’ʼ´`]/g, "'");
}

function kindOf(text: string): TokenKind {
  if (HAS_LETTER.test(text)) return 'word';
  if (HAS_DIGIT.test(text)) return 'number';
  // 'direction' and 'label' are assigned by STRUCTURE (§7.5), never by the tokenizer.
  return 'punct';
}

// ---------------------------------------------------------------- the tokenizer

export function tokenizeLine(text: string, lang: string, opts: TokenizeLineOptions = {}): Token[] {
  invariant(text === text.normalize('NFC'), 'tokenizeLine: line text must be NFC (cleanup rule 1)');
  invariant(!text.includes('\n'), 'tokenizeLine: line text must not contain a newline');

  const startIndex = opts.startIndex ?? 0;
  const lineIdx = opts.lineIdx ?? 0;
  const blockIdx = opts.blockIdx ?? 0;
  const chunkIdx = opts.chunkIdx ?? -1;

  const { cores, tailGap } = splitCores(text, lang);
  const grouped = group(cores);

  const out: Token[] = [];

  const emit = (raw: string, ws: string, lead: string): Token => {
    const kind = kindOf(raw);
    const token: Token = {
      i: startIndex + out.length,
      text: raw,
      lead,
      trail: '',
      ws,
      kind,
      letterCount: countLetters(raw, lang),
      letterGroups: letterGroupsOf(raw, lang),
      firstLetter: firstLetterOf(raw, lang),
      normalized: normalizeToken(raw),
      lineIdx,
      blockIdx,
      chunkIdx,
      // Until the sentence pass of §7.7 runs, each line is treated as one sentence.
      sentIdx: lineIdx,
      posInLine: out.length,
      lineLen: 0,
      posInSent: out.length,
      sentLen: 0,
      isFunction: false,
      isProperish: false,
      hasDigit: false,
      count: 0,
      isMaskable: false,
    };
    out.push(token);
    return token;
  };

  for (const core of grouped) {
    const { ws, lead } = consumeGap(core.gapBefore, out, true, lang, emit);
    const token = emit(core.text, ws, lead);
    applyLeadExceptions(token, lang);
  }

  const tail = consumeGap(tailGap, out, false, lang, emit);
  if (tail.ws !== '') {
    // Trailing whitespace has nowhere else to live and the invariant forbids losing it.
    const last = out[out.length - 1];
    if (last) last.trail += tail.ws;
    else emit('', tail.ws, '');
  }

  for (const t of out) {
    t.lineLen = out.length;
    t.sentLen = out.length;
  }

  const rebuilt = out.map((t) => t.ws + t.lead + t.text + t.trail).join('');
  invariant(rebuilt === text, 'tokenizeLine: token reconstruction must equal the source line');
  return out;
}

type Emit = (raw: string, ws: string, lead: string) => Token;

/**
 * §7.4 steps 2–4 for one gap. Peels a trailing run onto the previous token, emits standalone
 * separators for anything that attaches to neither side, and returns the `ws` and `lead` that
 * belong to the core about to be emitted.
 */
function consumeGap(
  gap: string,
  out: readonly Token[],
  hasNext: boolean,
  lang: string,
  emit: Emit,
): { ws: string; lead: string } {
  if (gap === '') return { ws: '', lead: '' };

  const runs = gap.match(WHITESPACE_RUN) ?? [];
  let pendingWs = '';
  let lead = '';

  for (let j = 0; j < runs.length; j++) {
    const run = runs[j];
    if (run === undefined) continue;
    if (/^\p{White_Space}/u.test(run)) {
      pendingWs += run;
      continue;
    }

    const prev = out[out.length - 1];
    const attachedLeft = j === 0 && pendingWs === '' && prev !== undefined;
    const attachedRight = hasNext && j === runs.length - 1;

    let rest = run;
    if (attachedLeft && prev) {
      const cut = trailingRunLength(rest);
      if (cut > 0) {
        applyTrailExceptions(prev, rest.slice(0, cut), lang);
        rest = rest.slice(cut);
      }
    }
    if (rest !== '' && attachedRight) {
      const keep = leadingRunStart(rest);
      lead = rest.slice(keep);
      rest = rest.slice(0, keep);
    }
    if (rest !== '') {
      // EMIT SEPARATORS: a run that attaches to neither word. This is what makes `wait—no` behave.
      emit(rest, pendingWs, '');
      pendingWs = '';
    }
  }

  return { ws: pendingWs, lead };
}

/** How many characters at the start of `run` peel onto the previous token as `trail`. */
function trailingRunLength(run: string): number {
  let n = 0;
  for (const ch of run) {
    if (!TRAILING_CHAR.test(ch)) break;
    n += ch.length;
  }
  return n;
}

/** The offset in `run` where the `lead` of the next token starts. */
function leadingRunStart(run: string): number {
  const chars = [...run];
  let start = chars.length;
  for (let k = chars.length - 1; k >= 0; k--) {
    const ch = chars[k];
    if (ch === undefined || !LEADING_CHAR.test(ch)) break;
    start = k;
  }
  return chars.slice(0, start).join('').length;
}

/** §7.4 step 2 exceptions on the trailing side: `dogs'`, `D.C.`, `Mr.`. */
function applyTrailExceptions(prev: Token, peeled: string, lang: string): void {
  let rest = peeled;
  const first = rest[0];
  if (first !== undefined && APOSTROPHE.test(first) && /s$/i.test(prev.text)) {
    prev.text += first;
    rest = rest.slice(1);
  } else if (first === '.' && isAbbreviation(prev.text)) {
    prev.text += first;
    rest = rest.slice(1);
  } else {
    prev.trail += rest;
    return;
  }
  refreshDerivedText(prev, lang);
  prev.trail += rest;
}

/** §7.4 step 2 exceptions on the leading side: `'Tis`, `'90s`. */
function applyLeadExceptions(token: Token, lang: string): void {
  const last = token.lead.slice(-1);
  if (last === '' || !APOSTROPHE.test(last)) return;
  const candidate = normalizeToken(last + token.text);
  if (!ELISION.has(candidate) && !/^\d\d/.test(token.text)) return;
  token.text = last + token.text;
  token.lead = token.lead.slice(0, -1);
  refreshDerivedText(token, lang);
}

/** `text` changed after CLASSIFY; recompute everything derived from it. Cheap, and rare. */
function refreshDerivedText(token: Token, lang: string): void {
  token.normalized = normalizeToken(token.text);
  token.kind = kindOf(token.text);
  token.letterCount = countLetters(token.text, lang);
  token.letterGroups = letterGroupsOf(token.text, lang);
  token.firstLetter = firstLetterOf(token.text, lang);
}

// ---------------------------------------------------------------- whole documents

/**
 * Tokenize a whole document's lines, keeping `i` globally unique and ascending.
 * Returns one array per input line; `result.flat()` is the document's flat token array.
 */
export function tokenizeLines(
  lines: readonly string[],
  lang: string,
  opts: TokenizeLinesOptions = {},
): Token[][] {
  const startLineIdx = opts.startLineIdx ?? 0;
  let next = opts.startIndex ?? 0;
  const out: Token[][] = [];
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k] ?? '';
    const lineIdx = startLineIdx + k;
    const tokens = tokenizeLine(line, lang, {
      startIndex: next,
      lineIdx,
      blockIdx: opts.blockIdxs?.[k] ?? lineIdx,
    });
    next += tokens.length;
    out.push(tokens);
  }
  return out;
}
