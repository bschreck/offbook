/**
 * Cleanup rules. PLAN.md §7.3 — five rules, fixed order, each a toggle with a live count.
 *
 * Every rule is `(lines: string[]) => RuleResult`: pure, total, and never throwing. A rule that
 * decides it has nothing to do returns the input array unchanged with `changed: 0` and a note
 * explaining why, because the UI shows the note next to the toggle.
 */

import type { CleanupConfig, DocKind } from '../types';

export interface RuleResult {
  lines: string[];
  /** Lines added, removed or rewritten. Shown live next to the rule's toggle. */
  changed: number;
  notes: string[];
}

export type RuleName = keyof CleanupConfig;

/** What the sniffer (§7.3 stage 2) tells cleanup. Conservative by default: unwrap stays off. */
export interface CleanupHints {
  kind: DocKind;
  /** Line breaks are the memorisation scaffold (verse, lyrics, dialogue) — never rejoin them. */
  lineBreaksAreSemantic: boolean;
}

export const DEFAULT_HINTS: CleanupHints = { kind: 'other', lineBreaksAreSemantic: true };

const NO_CHANGE = (lines: string[], notes: string[] = []): RuleResult => ({
  lines,
  changed: 0,
  notes,
});

function countMatches(s: string, re: RegExp): number {
  return s.match(re)?.length ?? 0;
}

// ---------------------------------------------------------------- 1. normalise

const LIGATURES = /[\uFB00-\uFB06]/g;
const LIGATURE_MAP: Record<string, string> = {
  ﬀ: 'ff',
  ﬁ: 'fi',
  ﬂ: 'fl',
  ﬃ: 'ffi',
  ﬄ: 'ffl',
  ﬅ: 'st',
  ﬆ: 'st',
};
/** ZWSP, ZWNJ, BOM/ZWNBSP, word joiner. U+200D (ZWJ) is kept — it welds emoji and Indic clusters. */
const INVISIBLES = /[\u200B\u200C\uFEFF\u2060]/g;
/** C0/C1 controls except tab and newline. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters out of pasted text is exactly what this rule does
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
/** Every Zs except U+0020 itself, listed literally so the intent is readable. */
const EXOTIC_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
/** Hyphen-like dashes. En and em dashes are meaningful punctuation and stay distinct (§7.3). */
const HYPHEN_VARIANTS = /[\u2010\u2011\u2012\u2212]/g;

/**
 * NFC, not NFKC: NFKC rewrites ½, ² and several spaces (§7.3 rule 1). The tokenizer asserts NFC
 * as a precondition, so this rule is the one place that guarantees it.
 * Soft hyphens (U+00AD) are deliberately NOT removed here — de-hyphenation in `unwrap` needs them.
 */
export function normalise(lines: string[]): RuleResult {
  let changed = 0;
  let ligatures = 0;
  let invisibles = 0;
  let spaces = 0;
  let dashes = 0;
  const out = lines.map((line) => {
    let s = line.normalize('NFC');
    ligatures += countMatches(s, LIGATURES);
    s = s.replace(LIGATURES, (c) => LIGATURE_MAP[c] ?? c);
    invisibles += countMatches(s, INVISIBLES);
    s = s.replace(INVISIBLES, '').replace(CONTROLS, '');
    spaces += countMatches(s, EXOTIC_SPACES);
    s = s.replace(EXOTIC_SPACES, ' ');
    dashes += countMatches(s, HYPHEN_VARIANTS);
    s = s.replace(HYPHEN_VARIANTS, '-');
    if (s !== line) changed++;
    return s;
  });
  const notes: string[] = [];
  if (ligatures) notes.push(`expanded ${ligatures} ligature(s)`);
  if (invisibles) notes.push(`removed ${invisibles} invisible character(s)`);
  if (spaces) notes.push(`converted ${spaces} exotic space(s) to plain spaces`);
  if (dashes) notes.push(`normalised ${dashes} hyphen variant(s)`);
  return { lines: out, changed, notes };
}

// ---------------------------------------------------------------- 2. punctuation

const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B]/g;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g;
const ELLIPSIS = /\u2026/g;
/** An acute or grave standing between letters is an apostrophe someone typed wrong (§7.3 rule 2). */
const ACCENT_AS_APOSTROPHE = /(?<=\p{L})[´`](?=\p{L})/gu;

/**
 * Straightens quotes and ellipses in the *displayed* text — this is a real edit to the source the
 * user will read and be masked against, unlike `identityNormalize` in util/hash, which straightens
 * the same characters only to compute a hash and never touches what is shown.
 */
export function punctuation(lines: string[]): RuleResult {
  let changed = 0;
  let quotes = 0;
  let ellipses = 0;
  const out = lines.map((line) => {
    let s = line;
    quotes += countMatches(s, SINGLE_QUOTES) + countMatches(s, DOUBLE_QUOTES);
    s = s.replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"');
    ellipses += countMatches(s, ELLIPSIS);
    s = s.replace(ELLIPSIS, '...').replace(ACCENT_AS_APOSTROPHE, "'");
    if (s !== line) changed++;
    return s;
  });
  const notes: string[] = [];
  if (quotes) notes.push(`straightened ${quotes} curly quote(s)`);
  if (ellipses) notes.push(`expanded ${ellipses} ellipsis character(s)`);
  return { lines: out, changed, notes };
}

// ---------------------------------------------------------------- 3. whitespace

/**
 * Leading whitespace is left byte-for-byte intact: §7.6 quantises it into indent buckets and verse
 * depends on the distinction between a tab and four spaces. Only the body of the line is collapsed.
 */
export function whitespace(lines: string[]): RuleResult {
  const out: string[] = [];
  let changed = 0;
  let blanksDropped = 0;
  let prevBlank = false;
  for (const line of lines) {
    const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
    const body = line
      .slice(indent.length)
      .replace(/\t/g, ' ')
      .replace(/ {2,}/g, ' ')
      .replace(/\s+$/, '');
    const blank = body === '';
    const cleaned = blank ? '' : indent + body;
    if (blank && prevBlank) {
      blanksDropped++;
      changed++;
      continue;
    }
    prevBlank = blank;
    if (cleaned !== line) changed++;
    out.push(cleaned);
  }
  const notes: string[] = [];
  if (blanksDropped) notes.push(`capped blank runs, removing ${blanksDropped} blank line(s)`);
  return { lines: out, changed, notes };
}

// ---------------------------------------------------------------- 4. dropArtifacts

/** §7.1 step 7: only ever matched against the WHOLE line, so `MARY (CONT'D)` survives as a cue. */
const ALWAYS_DROP: readonly RegExp[] = [
  /^\(?(?:page\s*)?\d{1,4}(?:\s*of\s*\d{1,4})?\)?\.?$/i,
  /^\d{1,3}[a-z]?\.$/i,
  /^\(?(?:MORE|CONTINUED|CONT'?D)\)?\.?$/i,
  /^(?:Rev\.?|Revised)\s+\d/i,
  /^\*+$/,
  // Lyrics-site scrape junk (§7.3 rule 4).
  /^\d*\s*Embed$/i,
  /^You might also like$/i,
  /^\d+\s*Contributors?$/i,
];

const MIN_HEADER_REPEATS = 3;
/** A pasted excerpt can carry pages only 6–8 lines apart, so the floor cannot be 10. */
const MIN_HEADER_INTERVAL = 6;
const MAX_HEADER_LENGTH = 60;
/** Relative standard deviation of the gaps. Below this the repeats are "near-regular". */
const MAX_INTERVAL_SPREAD = 0.25;

function nearRegular(indices: number[]): boolean {
  const gaps: number[] = [];
  for (let i = 1; i < indices.length; i++) gaps.push((indices[i] ?? 0) - (indices[i - 1] ?? 0));
  if (gaps.length < 2) return false;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (mean < MIN_HEADER_INTERVAL) return false;
  const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
  return Math.sqrt(variance) / mean <= MAX_INTERVAL_SPREAD;
}

function recurringHeaders(lines: string[]): Map<string, number[]> {
  const seen = new Map<string, number[]>();
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.length > MAX_HEADER_LENGTH) return;
    const at = seen.get(t);
    if (at) at.push(i);
    else seen.set(t, [i]);
  });
  const headers = new Map<string, number[]>();
  for (const [text, at] of seen) {
    if (at.length >= MIN_HEADER_REPEATS && nearRegular(at) && !isRepeatingBlock(lines, at)) {
      headers.set(text, at);
    }
  }
  return headers;
}

/**
 * A running header is a LONE repeated line: different content follows it every time. A
 * chorus is a repeated line inside a repeated block, so its neighbours repeat too.
 *
 * Without this, lowering the interval floor far enough to catch real page headers also
 * deletes the chorus out of every song — which is the one part the user already knows and
 * the last thing they would expect the app to throw away.
 */
function isRepeatingBlock(lines: string[], at: number[]): boolean {
  const after = new Set<string>();
  const before = new Set<string>();
  for (const i of at) {
    after.add((lines[i + 1] ?? '').trim());
    before.add((lines[i - 1] ?? '').trim());
  }
  return after.size < 2 && before.size < 2;
}

/** "12  HAMLET" -> "HAMLET". Two-plus spaces only, and only when the numbers ascend (§7.3). */
const LINE_NUMBER = /^\s*(\d{1,4})(?:[ \t]{2,}|\t)(\S.*)$/;

function monotonicLineNumbers(lines: string[]): boolean {
  let last = -1;
  let n = 0;
  for (const line of lines) {
    const m = LINE_NUMBER.exec(line);
    if (!m?.[1]) continue;
    const value = Number(m[1]);
    if (value <= last) return false;
    last = value;
    n++;
  }
  return n >= 3;
}

/**
 * Conservative by design: everything removed is reported in `notes` so the review step can show it,
 * and a short line only disappears if it repeats at a near-regular interval — a short line of
 * dialogue never does.
 */
export function dropArtifacts(lines: string[]): RuleResult {
  const notes: string[] = [];
  const dropped = new Set<number>();
  const markers: string[] = [];

  lines.forEach((line, i) => {
    const t = line.trim();
    if (t && ALWAYS_DROP.some((re) => re.test(t))) {
      dropped.add(i);
      markers.push(t);
    }
  });
  if (markers.length) {
    notes.push(`dropped ${markers.length} page marker(s): ${markers.slice(0, 5).join(', ')}`);
  }

  for (const [text, at] of recurringHeaders(lines)) {
    for (const i of at) dropped.add(i);
    notes.push(`dropped recurring header/footer "${text}" (${at.length}x)`);
  }

  const stripNumbers = monotonicLineNumbers(lines);
  let stripped = 0;
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (dropped.has(i)) return;
    const m = stripNumbers ? LINE_NUMBER.exec(line) : null;
    if (m?.[2]) {
      stripped++;
      out.push(m[2]);
    } else {
      out.push(line);
    }
  });
  if (stripped) notes.push(`stripped ${stripped} leading line number(s)`);

  return { lines: out, changed: dropped.size + stripped, notes };
}

// ---------------------------------------------------------------- 5. unwrap

/** Kinds whose line breaks are the memorisation scaffold (§7.3 rule 5). */
const VERSE_KINDS: ReadonlySet<DocKind> = new Set<DocKind>(['lyrics', 'poem', 'script']);

const TERMINAL_PUNCT = /[.!?"')\]]$/;
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'mr.',
  'mrs.',
  'ms.',
  'dr.',
  'st.',
  'jr.',
  'sr.',
  'prof.',
  'vs.',
  'etc.',
  'e.g.',
  'i.e.',
  'cf.',
  'no.',
  'vol.',
  'ch.',
  'fig.',
  'al.',
]);
/** Fragments after which the hyphen is kept when the two halves are rejoined (§7.3). */
const KEEP_HYPHEN_PREFIXES: ReadonlySet<string> = new Set(
  `self non ex pre re co anti multi semi sub super ultra well ill over under half all cross mid
   quasi pseudo`.split(/\s+/),
);

const LIST_ITEM = /^\s*(?:[-*•‣]|\d{1,3}[.)])\s+/;

function isCueOrHeading(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith('#')) return true;
  if (/^(?:INT\.|EXT\.|INT\/EXT|I\/E)\b/i.test(t)) return true;
  if (/^\p{Lu}[\p{Lu}\d .,'\-()]{1,30}[.:]?$/u.test(t)) return true; // ALLCAPS cue on its own line
  return /^\p{Lu}[\p{L}'\- ]{0,24}:\s/u.test(t); // "Hamlet: to be"
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i] ?? 0;
}

/** §7.3's hard-wrap detector: lines piling up at the right margin, few of them ending sentences. */
function isHardWrapped(lines: string[]): boolean {
  const lens = lines
    .map((l) => l.trim().length)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  if (lens.length < 4) return false;
  const p90 = percentile(lens, 0.9);
  const med = percentile(lens, 0.5);
  if (p90 < 55 || p90 > 100 || med / p90 < 0.7) return false;
  const atMargin = lens.filter((n) => n >= 0.8 * p90 && n <= p90).length / lens.length;
  const terminal =
    lines.filter((l) => l.trim() !== '' && TERMINAL_PUNCT.test(l.trim())).length / lens.length;
  return atMargin >= 0.55 && terminal <= 0.45;
}

function endsWithAbbreviation(text: string): boolean {
  const last = /(\S+)$/.exec(text)?.[1]?.toLowerCase() ?? '';
  return ABBREVIATIONS.has(last);
}

type JoinKind = 'none' | 'hyphen' | 'wrap';

function joinKind(cur: string, next: string, p90: number, hardWrapped: boolean): JoinKind {
  const a = cur.replace(/\s+$/, '');
  const b = next.trim();
  if (b === '' || a === '') return 'none';
  if (isCueOrHeading(next) || LIST_ITEM.test(next)) return 'none';
  if (/[-\u00AD]$/.test(a) && /^\p{L}/u.test(b)) return 'hyphen';
  if (!hardWrapped) return 'none';
  if (TERMINAL_PUNCT.test(a) || endsWithAbbreviation(a)) return 'none';
  if (a.trim().length < 0.78 * p90) return 'none';
  return /^[\p{Ll},;]/u.test(b) ? 'wrap' : 'none';
}

/** Returns the joined line and whether the dropped hyphen was a guess worth reviewing. */
function joinHyphenated(cur: string, next: string): { text: string; lowConfidence: boolean } {
  const a = cur.replace(/\s+$/, '');
  const soft = a.endsWith('\u00AD');
  const stem = a.slice(0, -1);
  const rest = next.trim();
  const left = (/(\S+)$/.exec(stem)?.[1] ?? '').toLowerCase();
  const right = /^(\S+)/.exec(rest)?.[1] ?? '';
  const keep =
    !soft &&
    (/^\p{Lu}/u.test(right) ||
      left.length <= 1 ||
      right.replace(/\W+$/u, '').length <= 1 ||
      KEEP_HYPHEN_PREFIXES.has(left));
  return { text: keep ? `${stem}-${rest}` : `${stem}${rest}`, lowConfidence: !keep && !soft };
}

/**
 * De-hyphenate (5a), strip the remaining soft hyphens (5b), then rejoin hard wraps (5c).
 * Off unless the sniffer says the line breaks are cosmetic — the default hints say they are not.
 */
export function unwrap(lines: string[], hints: CleanupHints = DEFAULT_HINTS): RuleResult {
  if (hints.lineBreaksAreSemantic || VERSE_KINDS.has(hints.kind)) {
    return NO_CHANGE(lines, [`skipped: line breaks are meaningful in "${hints.kind}"`]);
  }
  const lens = lines
    .map((l) => l.trim().length)
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const p90 = percentile(lens, 0.9);
  const hardWrapped = isHardWrapped(lines);

  const out: string[] = [];
  let wraps = 0;
  let hyphens = 0;
  let lowConfidence = 0;
  let i = 0;
  while (i < lines.length) {
    let cur = lines[i] ?? '';
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j] ?? '';
      const kind = joinKind(cur, next, p90, hardWrapped);
      if (kind === 'none') break;
      if (kind === 'hyphen') {
        const joined = joinHyphenated(cur, next);
        cur = joined.text;
        hyphens++;
        if (joined.lowConfidence) lowConfidence++;
      } else {
        cur = `${cur.replace(/\s+$/, '')} ${next.trim()}`;
        wraps++;
      }
      j++;
    }
    // 5b: any soft hyphen that did not sit at a line end is just noise.
    out.push(cur.replace(/\u00AD/g, ''));
    i = j;
  }

  const notes: string[] = [];
  if (!hardWrapped) notes.push('no hard-wrap pattern found; only de-hyphenation applied');
  if (wraps) notes.push(`rejoined ${wraps} hard-wrapped line(s)`);
  if (hyphens) notes.push(`de-hyphenated ${hyphens} split word(s)`);
  if (lowConfidence) notes.push(`${lowConfidence} hyphen removal(s) are low confidence`);
  return { lines: out, changed: wraps + hyphens, notes };
}
