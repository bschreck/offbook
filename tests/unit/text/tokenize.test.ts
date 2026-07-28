import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { tokenizeLine, tokenizeLines } from '../../../src/core/text/tokenize';
import type { Token } from '../../../src/core/text/types';

function rebuild(tokens: readonly Token[]): string {
  return tokens.map((t) => t.ws + t.lead + t.text + t.trail).join('');
}

/** `[ws, lead, text, trail]` — the four fields the reconstruction invariant is made of. */
function shape(tokens: readonly Token[]): string[][] {
  return tokens.map((t) => [t.ws, t.lead, t.text, t.trail]);
}

function texts(tokens: readonly Token[]): string[] {
  return tokens.map((t) => t.text);
}

// ------------------------------------------------------------------ the master invariant

/**
 * Pools chosen to cover what PLAN.md §7.4 names: Latin words, accents, CJK, Hebrew, digits,
 * EVERY Unicode punctuation and symbol category, emoji (including ZWJ and modifier sequences)
 * and random whitespace.
 */
// biome-ignore format: grouped by script/category on purpose.
const PIECES: readonly string[] = [
  // Latin, accented, contracted, hyphenated
  'the', 'quick', 'Fox', 'café', 'naïve', 'Straße', 'Ægis', "don't", "O'Brien's", 'mother-in-law',
  'e-book', 'ALLCAPS', 'q̇uick',
  // Cyrillic / Greek
  'привет', 'Ελλάδα',
  // CJK
  '私', 'は', '学生', 'です', '漢字', '한국어', 'ひらがな',
  // Hebrew (RTL)
  'שלום', 'עולם', 'מה', 'קורה',
  // Devanagari
  'नमस्ते',
  // numbers
  '1,200', '3.14', '9:30', '1/2', '42', '007', "'90s", '20',
  // Pc Pd Ps Pe Pi Pf Po
  '_', '-', '(', ')', '«', '»', '!', '?', ';', ':', '.', ',', '…', '"', "'", '¿', '¡', '。', '、',
  '—', '–', '‽', '·', '§', '¶', '&', '/', '\\', '*', '@', '#', '%',
  // Sm Sc Sk So
  '+', '=', '<', '£', '$', '€', '^', '`', '©', '☺', '♪',
  // emoji: single, ZWJ sequence, flag, skin-tone modifier
  '👍', '👨‍👩‍👧‍👦', '🇬🇧', '👩🏽‍🚀',
  // whitespace
  ' ', '  ', '\t', ' ', ' ', '　',
];

const lineArb = fc
  .array(fc.constantFrom(...PIECES), { minLength: 0, maxLength: 14 })
  // Cleanup rule 1 guarantees NFC before the tokenizer ever sees a line (§7.4 precondition).
  .map((parts) => parts.join('').normalize('NFC'));

describe('the master invariant', () => {
  it('ws + lead + text + trail reconstructs the source line exactly', () => {
    fc.assert(
      fc.property(lineArb, fc.constantFrom('en', 'ja', 'he', 'de'), (line, lang) => {
        expect(rebuild(tokenizeLine(line, lang))).toBe(line);
      }),
      { numRuns: 600 },
    );
  });

  it('never puts a letter or a digit outside `text`, and never loses whitespace', () => {
    fc.assert(
      fc.property(lineArb, (line) => {
        for (const t of tokenizeLine(line, 'en')) {
          expect(t.ws).toMatch(/^\p{White_Space}*$/u);
          expect(t.lead).not.toMatch(/[\p{L}\p{N}]/u);
          expect(t.trail).not.toMatch(/[\p{L}\p{N}]/u);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('assigns `i` consecutively from the caller-supplied offset, matching posInLine', () => {
    fc.assert(
      fc.property(lineArb, fc.nat({ max: 5000 }), (line, start) => {
        const tokens = tokenizeLine(line, 'en', { startIndex: start });
        tokens.forEach((t, k) => {
          expect(t.i).toBe(start + k);
          expect(t.posInLine).toBe(k);
          expect(t.lineLen).toBe(tokens.length);
        });
      }),
      { numRuns: 500 },
    );
  });
});

// ------------------------------------------------------------------ golden cases

describe('golden cases (§7.4, §14.2)', () => {
  it("Don't — it's O'Brien's.", () => {
    const t = tokenizeLine("Don't — it's O'Brien's.", 'en');
    expect(shape(t)).toEqual([
      ['', '', "Don't", ''],
      [' ', '', '—', ''],
      [' ', '', "it's", ''],
      [' ', '', "O'Brien's", '.'],
    ]);
    expect(t[1]?.kind).toBe('punct');
  });

  it('1,200-page is one token, not four', () => {
    const t = tokenizeLine('1,200-page', 'en');
    // biome-ignore format: one line per word is unreadable here.
    expect(texts(t)).toEqual(['1,200-page']);
    expect(t[0]?.kind).toBe('word');
  });

  it("'Tis keeps its elision apostrophe in text", () => {
    const t = tokenizeLine("'Tis the season", 'en');
    expect(shape(t)[0]).toEqual(['', '', "'Tis", '']);
    expect(t[0]?.normalized).toBe("'tis");
  });

  it('£5.99 (plus 20% VAT).', () => {
    const t = tokenizeLine('£5.99 (plus 20% VAT).', 'en');
    expect(shape(t)).toEqual([
      ['', '£', '5.99', ''],
      [' ', '(', 'plus', ''],
      [' ', '', '20', '%'],
      [' ', '', 'VAT', ').'],
    ]);
    expect(t[0]?.kind).toBe('number');
  });

  it('私は学生です。', () => {
    const t = tokenizeLine('私は学生です。', 'ja');
    expect(shape(t)).toEqual([
      ['', '', '私', ''],
      ['', '', 'は', ''],
      ['', '', '学生', ''],
      ['', '', 'です', '。'],
    ]);
  });

  it("Rock'n'roll is one token", () => {
    expect(texts(tokenizeLine("Rock'n'roll", 'en'))).toEqual(["Rock'n'roll"]);
  });

  it('Mr. Smith Jr. went to Washington, D.C. Then he left.', () => {
    const t = tokenizeLine('Mr. Smith Jr. went to Washington, D.C. Then he left.', 'en');
    // Abbreviation dots stay in `text`; the final period IS terminal.
    expect(texts(t)).toEqual([
      'Mr.',
      'Smith',
      'Jr.',
      'went',
      'to',
      'Washington',
      'D.C.',
      'Then',
      'he',
      'left',
    ]);
    expect(t[5]?.trail).toBe(',');
    expect(t[6]?.trail).toBe('');
    expect(t[9]?.trail).toBe('.');
  });

  it('well—no emits a standalone separator', () => {
    const t = tokenizeLine('well—no', 'en');
    expect(shape(t)).toEqual([
      ['', '', 'well', ''],
      ['', '', '—', ''],
      ['', '', 'no', ''],
    ]);
    expect(t[1]?.kind).toBe('punct');
  });

  it('3.14 and 9:30 and 1/2 and R&B and AT&T survive whole', () => {
    expect(texts(tokenizeLine('3.14', 'en'))).toEqual(['3.14']);
    expect(texts(tokenizeLine('9:30', 'en'))).toEqual(['9:30']);
    expect(texts(tokenizeLine('1/2', 'en'))).toEqual(['1/2']);
    expect(texts(tokenizeLine('R&B', 'en'))).toEqual(['R&B']);
    expect(texts(tokenizeLine('AT&T', 'en'))).toEqual(['AT&T']);
    expect(tokenizeLine('3.14', 'en')[0]?.kind).toBe('number');
    expect(tokenizeLine('9:30', 'en')[0]?.kind).toBe('number');
  });

  it('a comma that is not a digit grouper is not joined', () => {
    const t = tokenizeLine('3, and', 'en');
    expect(shape(t)).toEqual([
      ['', '', '3', ','],
      [' ', '', 'and', ''],
    ]);
  });

  it("'90s keeps its apostrophe; dogs' keeps its", () => {
    expect(texts(tokenizeLine("the '90s", 'en'))).toEqual(['the', "'90s"]);
    expect(shape(tokenizeLine("dogs'", 'en'))).toEqual([['', '', "dogs'", '']]);
    expect(shape(tokenizeLine("the dogs' bowls.", 'en'))).toEqual([
      ['', '', 'the', ''],
      [' ', '', "dogs'", ''],
      [' ', '', 'bowls', '.'],
    ]);
  });

  it('mother-in-law has letterGroups [6,2,3]', () => {
    expect(tokenizeLine('mother-in-law', 'en')[0]?.letterGroups).toEqual([6, 2, 3]);
    expect(tokenizeLine("mother-in-law's", 'en')[0]?.letterGroups).toEqual([6, 2, 3, 1]);
    expect(tokenizeLine('mother-in-law', 'en')[0]?.letterCount).toBe(11);
  });

  it('wait… peels the ellipsis', () => {
    expect(shape(tokenizeLine('wait…', 'en'))).toEqual([['', '', 'wait', '…']]);
  });

  it('Wait... what? . . . Hello?', () => {
    const t = tokenizeLine('Wait... what? . . . Hello?', 'en');
    expect(shape(t)).toEqual([
      ['', '', 'Wait', '...'],
      [' ', '', 'what', '?'],
      [' ', '', '.', ''],
      [' ', '', '.', ''],
      [' ', '', '.', ''],
      [' ', '', 'Hello', '?'],
    ]);
  });

  it('שלום עולם, מה קורה?', () => {
    const t = tokenizeLine('שלום עולם, מה קורה?', 'he');
    expect(texts(t)).toEqual(['שלום', 'עולם', 'מה', 'קורה']);
    expect(t[1]?.trail).toBe(',');
    expect(t[3]?.trail).toBe('?');
  });

  it('"Hello," she said.', () => {
    expect(shape(tokenizeLine('"Hello," she said.', 'en'))).toEqual([
      ['', '"', 'Hello', ',"'],
      [' ', '', 'she', ''],
      [' ', '', 'said', '.'],
    ]);
  });
});

// ------------------------------------------------------------------ graphemes

describe('grapheme-safe counting', () => {
  it('an emoji ZWJ sequence stays one token and is never split into code units', () => {
    const family = '👨‍👩‍👧‍👦';
    expect(family.length).toBe(11); // code units
    const t = tokenizeLine(`${family} ok`, 'en');
    expect(t).toHaveLength(2);
    expect(t[0]?.text).toBe(family);
    expect(t[0]?.kind).toBe('punct');
    // No grapheme of the sequence bears \p{L}, so it contributes no letters.
    expect(t[0]?.letterCount).toBe(0);
    expect(rebuild(t)).toBe(`${family} ok`);
  });

  it('letterCount counts graphemes, not code units', () => {
    // q + COMBINING DOT ABOVE: 6 code units, 5 graphemes. NFC-stable, so it is legal input.
    const marked = 'q̇uick';
    expect(marked.length).toBe(6);
    expect(tokenizeLine(marked, 'en')[0]?.letterCount).toBe(5);

    // Devanagari: 6 code units, 3 grapheme clusters.
    expect('नमस्ते'.length).toBe(6);
    expect(tokenizeLine('नमस्ते', 'hi')[0]?.letterCount).toBe(3);
  });

  it('firstLetter is a whole grapheme', () => {
    expect(tokenizeLine('q̇uick', 'en')[0]?.firstLetter).toBe('q̇');
    expect(tokenizeLine('£5.99', 'en')[0]?.firstLetter).toBe('');
  });
});

// ------------------------------------------------------------------ mechanics

describe('tokenizeLine mechanics', () => {
  it('normalizes to NFD-without-marks, lowercase, straight apostrophes', () => {
    expect(tokenizeLine('Café', 'en')[0]?.normalized).toBe('cafe');
    expect(tokenizeLine('Don’t', 'en')[0]?.normalized).toBe("don't");
  });

  it('keeps leading and trailing whitespace', () => {
    const line = '  hi there  ';
    const t = tokenizeLine(line, 'en');
    expect(t[0]?.ws).toBe('  ');
    expect(rebuild(t)).toBe(line);
  });

  it('an empty line yields no tokens; a blank line yields one whitespace carrier', () => {
    expect(tokenizeLine('', 'en')).toEqual([]);
    const blank = tokenizeLine('   ', 'en');
    expect(blank).toHaveLength(1);
    expect(rebuild(blank)).toBe('   ');
  });

  it('rejects a newline and non-NFC input', () => {
    expect(() => tokenizeLine('a\nb', 'en')).toThrow(/newline/);
    expect(() => tokenizeLine('café', 'en')).toThrow(/NFC/);
  });

  it('falls back to the English segmenter for a malformed language tag', () => {
    expect(texts(tokenizeLine('hello there', '!!not-a-tag!!'))).toEqual(['hello', 'there']);
  });

  it('tokenizeLines keeps `i` globally unique and ascending', () => {
    const lines = ['One two.', '', 'Three—four', '  '];
    const perLine = tokenizeLines(lines, 'en');
    const flat = perLine.flat();
    flat.forEach((t, k) => {
      expect(t.i).toBe(k);
    });
    perLine.forEach((tokens, lineIdx) => {
      expect(rebuild(tokens)).toBe(lines[lineIdx]);
      for (const t of tokens) expect(t.lineIdx).toBe(lineIdx);
    });
  });
});
