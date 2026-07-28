/**
 * The positional kernel. PLAN.md §8.5 methods 3, 4, 8 and §8.4 fix D.
 *
 * Line ends, line starts, and the rhyme-nucleus detection that `rhymes` filters on.
 */

import type { Document, Token } from '../../text/types';

export type PositionalRung = number | 'half' | 'all';

export function resolvePositional(value: PositionalRung, wordCount: number): number {
  if (value === 'all') return wordCount;
  if (value === 'half') return Math.floor(wordCount / 2);
  return value;
}

/**
 * §8.4 fix D: `n_L = max(n_{L-1}, f(L))`.
 *
 * Without the running max the design doc's `0/1/1/2/3/half/half/all` table masks 3 words at L4
 * and 2 at L5 on a 4-word line — the rung above is *easier* — and 4-to-6-word lines are what
 * lyrics are made of. Taking the cumulative max also lets the tables stay literal: `max(4, half)`
 * at L5 is just `4` in the table, because the max with the earlier rungs supplies the rest.
 */
export function monotoneDepth(
  table: readonly PositionalRung[],
  rung: number,
  wordCount: number,
): number {
  let depth = 0;
  const last = Math.min(rung, table.length - 1);
  for (let i = 0; i <= last; i++) {
    depth = Math.max(depth, resolvePositional(table[i] ?? 0, wordCount));
  }
  return Math.min(depth, wordCount);
}

/** The last `depth` candidates of a line, never eating into `keepMin` leading candidates. */
export function tailSelection(
  lineCandidates: readonly number[],
  depth: number,
  keepMin: number,
): number[] {
  const n = Math.min(depth, Math.max(0, lineCandidates.length - keepMin));
  return n <= 0 ? [] : lineCandidates.slice(lineCandidates.length - n);
}

/** The first `depth` candidates of a line, never eating into `keepMin` trailing candidates. */
export function headSelection(
  lineCandidates: readonly number[],
  depth: number,
  keepMin: number,
): number[] {
  const n = Math.min(depth, Math.max(0, lineCandidates.length - keepMin));
  return n <= 0 ? [] : lineCandidates.slice(0, n);
}

// ---------------------------------------------------------------- rhyme detection

/**
 * §8.5 method 8: match on the NUCLEUS, not the orthographic tail. "last 3 characters" misses
 * day/away and me/free and fires on walking/talking/nothing, so in any lyric with a couple of
 * gerunds it masks non-rhyming line ends and claims they rhyme.
 */
const RHYME_SUFFIXES = ['tion', 'sion', 'ness', 'ment', 'able', 'ing', 'ed', 'ly'] as const;

const VOWELS = new Set([...'aeiouyàáâãäåèéêëìíîïòóôõöùúûüýÿ']);

function isVowel(ch: string | undefined): boolean {
  return ch !== undefined && VOWELS.has(ch);
}

/**
 * English spells one rime several ways, so the raw nucleus alone still misses the pairs §8.5
 * names: me/free/sea are `e`/`ee`/`ea` and high/sky are `igh`/`y`. This is the smallest
 * canonicalisation that closes those two families without inventing a pronunciation dictionary.
 * eyes/lies still miss — noted honestly, and the method card labels the method experimental.
 */
function canonicalNucleus(nucleus: string): string {
  return nucleus.replace(/igh/g, 'i').replace(/y$/, 'i').replace(/ee|ea/g, 'e').replace(/oo/g, 'o');
}

/** The substring from the last vowel group onward, after stripping a final silent `e`. */
export function rhymeNucleus(normalized: string): string | null {
  let w = normalized.replace(/['’]/g, '');
  if (w.length === 0) return null;
  if (w.length > 2 && w.endsWith('e') && !isVowel(w[w.length - 2])) w = w.slice(0, -1);

  let i = w.length - 1;
  while (i >= 0 && !isVowel(w[i])) i--;
  if (i < 0) return null;
  while (i > 0 && isVowel(w[i - 1])) i--;
  return canonicalNucleus(w.slice(i));
}

function sharedInflection(a: string, b: string): boolean {
  for (const suffix of RHYME_SUFFIXES) {
    if (a.endsWith(suffix) && b.endsWith(suffix)) return true;
  }
  return false;
}

export function wordsRhyme(a: string, b: string): boolean {
  if (a === b) return true;
  const na = rhymeNucleus(a);
  const nb = rhymeNucleus(b);
  if (na === null || nb === null || na !== nb) return false;
  return !sharedInflection(a, b);
}

/**
 * Token indices of line-final words that rhyme with another line in the same stanza.
 * The stanza is the block: verses, speeches and paragraphs are already the right grouping.
 */
export function detectRhymeWords(doc: Document, lineFinal: readonly number[]): Set<number> {
  const byBlock = new Map<number, number[]>();
  for (const tokenIdx of lineFinal) {
    if (tokenIdx < 0) continue;
    const t = doc.tokens[tokenIdx];
    if (t === undefined) continue;
    const group = byBlock.get(t.blockIdx);
    if (group === undefined) byBlock.set(t.blockIdx, [tokenIdx]);
    else group.push(tokenIdx);
  }

  const rhymes = new Set<number>();
  for (const group of byBlock.values()) {
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        const ta = doc.tokens[group[a] ?? -1];
        const tb = doc.tokens[group[b] ?? -1];
        if (ta === undefined || tb === undefined) continue;
        if (wordsRhyme(ta.normalized, tb.normalized)) {
          rhymes.add(ta.i);
          rhymes.add(tb.i);
        }
      }
    }
  }
  return rhymes;
}

/** The last word-or-number token of each line, or -1. Indexed by line index. */
export function lineFinalWords(doc: Document): number[] {
  const finals = new Array<number>(doc.lines.length).fill(-1);
  for (const t of doc.tokens) {
    if (!isWordLike(t)) continue;
    if (t.lineIdx >= 0 && t.lineIdx < finals.length) finals[t.lineIdx] = t.i;
  }
  return finals;
}

export function isWordLike(t: Token): boolean {
  return t.kind === 'word' || t.kind === 'number';
}
