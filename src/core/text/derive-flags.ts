/**
 * Derived token flags. PLAN.md §7.4.
 *
 * ONE pass over the whole document's flat token array, after tokenizing and after STRUCTURE has
 * assigned block types. It lives here rather than in `tokenizeLine` because `count` is a
 * document-wide occurrence count and `isMaskable` needs the owning block's type — neither is
 * knowable one line at a time. It is emphatically NOT a second tokenizer.
 */

import { functionWordsFor, isLatinLikeScript } from './functionWords';
import type { BlockType, Token } from './types';

export interface DeriveFlagsOptions {
  lang: string;
  /**
   * Block type per `blockIdx`. A token whose block is not listed is treated as `paragraph`, so
   * tokenize + derive is usable on its own before STRUCTURE has run.
   */
  blockTypes?: readonly BlockType[];
}

/** §7.4: `isMaskable = kind ∈ {word,number} && block type ∈ {dialogue,paragraph,verse}`. */
const MASKABLE_BLOCKS: ReadonlySet<BlockType> = new Set<BlockType>([
  'dialogue',
  'paragraph',
  'verse',
]);

const HAS_DIGIT = /\p{N}/u;
const STARTS_UPPER = /^\p{Lu}/u;
const HAS_LOWER = /\p{Ll}/u;
const HAS_LETTER = /\p{L}/u;
const NON_LETTER = /[^\p{L}]/gu;
const APOSTROPHE = /['’ʼ´`]/;

/** At least one letter and no lowercase letter: `VAT`, `D.C.`, `I`, `VOICE-OVER`. */
export function isAllCaps(text: string): boolean {
  return HAS_LETTER.test(text) && !HAS_LOWER.test(text);
}

/**
 * The letters of the token up to its first apostrophe: `I'm` -> `I`, `O'Brien's` -> `O`.
 *
 * §7.4 writes this as `t.text.replace(/[^\p{L}]/gu, '') !== 'I'` to exclude `I'm`/`I'll`/`I've`/
 * `I'd` from `isProperish` — but that expression yields `Im`, `Ill`, `Ive`, `Id`, so it excludes
 * none of them. Splitting at the apostrophe first is what the plan's own comment asks for.
 */
function letterStem(text: string): string {
  return (text.split(APOSTROPHE)[0] ?? '').replace(NON_LETTER, '');
}

/**
 * Fills `isFunction`, `isProperish`, `hasDigit`, `count` and `isMaskable`.
 * MUTATES `tokens` in place and returns the same array, because the caller owns a `Token[]` that
 * `Line.tokens` and `Document.tokens` both alias — copying would silently fork them.
 */
export function deriveTokenFlags(tokens: Token[], opts: DeriveFlagsOptions): Token[] {
  const { lang } = opts;
  const list = functionWordsFor(lang);
  const latinLike = isLatinLikeScript(lang);
  const german = /^de/i.test(lang);

  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t.normalized, (counts.get(t.normalized) ?? 0) + 1);

  // A token is sentence-initial when nothing word-like precedes it in its sentence. This is
  // §7.4's `posInSent > 0` plus the case it does not cover: a sentence opening with a standalone
  // separator, where the first real word would otherwise score as a proper noun.
  let currentSent = Number.NaN;
  let seenWordInSent = false;

  for (const t of tokens) {
    if (t.sentIdx !== currentSent) {
      currentSent = t.sentIdx;
      seenWordInSent = false;
    }

    t.count = counts.get(t.normalized) ?? 0;
    t.hasDigit = HAS_DIGIT.test(t.text);
    t.isFunction = isFunctionWord(t, list, latinLike);
    t.isProperish =
      !german &&
      t.posInSent > 0 &&
      seenWordInSent &&
      STARTS_UPPER.test(t.text) &&
      !isAllCaps(t.text) &&
      letterStem(t.text) !== 'I';
    t.isMaskable =
      (t.kind === 'word' || t.kind === 'number') &&
      MASKABLE_BLOCKS.has(opts.blockTypes?.[t.blockIdx] ?? 'paragraph');

    if (t.kind === 'word' || t.kind === 'number') seenWordInSent = true;
  }

  return tokens;
}

/**
 * The `length <= 2` heuristic is restricted to word tokens: applying it to numbers would make `9`
 * a function word, and §7.4 keeps numerals out of the list on purpose (in a speech they are
 * high-value content). Applying it to punctuation would make every separator a function word.
 */
function isFunctionWord(t: Token, list: ReadonlySet<string> | null, latinLike: boolean): boolean {
  if (t.kind !== 'word') return false;
  if (list?.has(t.normalized)) return true;
  return latinLike && t.normalized.length <= 2;
}

/** §7.4: `isContent = kind !== 'punct' && !isFunction`. */
export function isContentToken(t: Token): boolean {
  return t.kind !== 'punct' && !t.isFunction;
}
