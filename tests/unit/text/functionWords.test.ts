import { describe, expect, it } from 'vitest';
import { deriveTokenFlags, isAllCaps } from '../../../src/core/text/derive-flags';
import {
  baseLanguage,
  FUNCTION_WORDS_EN,
  functionWordsFor,
  isLatinLikeScript,
  languageProfile,
  normalizeFunctionWord,
} from '../../../src/core/text/functionWords';
import { tokenizeLine } from '../../../src/core/text/tokenize';
import type { BlockType, Token } from '../../../src/core/text/types';

function flagged(line: string, lang = 'en', blockTypes?: readonly BlockType[]): Token[] {
  const tokens = tokenizeLine(line, lang);
  return deriveTokenFlags(tokens, blockTypes ? { lang, blockTypes } : { lang });
}

function byText(tokens: readonly Token[], text: string): Token {
  const hit = tokens.find((t) => t.text === text);
  if (!hit) throw new Error(`no token ${JSON.stringify(text)} in ${tokens.map((t) => t.text)}`);
  return hit;
}

// ------------------------------------------------------------------ the list itself

describe('FUNCTION_WORDS_EN', () => {
  it('covers every category §7.4 names', () => {
    // §7.4 budgets "~210 entries" for the categories it lists; the ~75 contraction forms it
    // demands separately are on top of that, hence the wider bound here.
    expect(FUNCTION_WORDS_EN.size).toBeGreaterThanOrEqual(210);
    expect(FUNCTION_WORDS_EN.size).toBeLessThan(400);
    // biome-ignore format: a dense table of forms.
    const spread = ['the', 'those', 'themselves', 'hath', "mustn't", 'beneath', 'whereas',
      'scarcely', 'away'];
    for (const w of spread) {
      expect(FUNCTION_WORDS_EN.has(w)).toBe(true);
    }
  });

  it('is fully normalised at module load — no entry can ever fail to match a Token', () => {
    for (const w of FUNCTION_WORDS_EN) {
      expect(w).toBe(normalizeFunctionWord(w));
      expect(w).not.toMatch(/[’´`ʼ]/);
      expect(w).toBe(w.toLowerCase());
    }
  });

  it('omits numerals-as-words: they are high-value content in a speech', () => {
    for (const w of ['one', 'two', 'three', 'seven', 'ten', 'hundred', 'thousand', 'first']) {
      expect(FUNCTION_WORDS_EN.has(w)).toBe(false);
    }
  });

  it('includes the archaic pronouns Shakespeare and hymns need', () => {
    for (const w of ['thou', 'thee', 'thy', 'thine', 'ye', 'hath', 'art']) {
      expect(FUNCTION_WORDS_EN.has(w)).toBe(true);
    }
  });

  it('ships a list for English only, so keyWords stays honest elsewhere', () => {
    expect(functionWordsFor('en-GB')).toBe(FUNCTION_WORDS_EN);
    expect(functionWordsFor('fr')).toBeNull();
    expect(functionWordsFor('ja')).toBeNull();
  });
});

// ------------------------------------------------------------------ the apostrophe bug

/**
 * The regression test for the worst silent bug in the design docs: the list was written with
 * curly apostrophes while `Token.normalized` straightens them, so every contraction scored as a
 * CONTENT word. Both spellings of the SOURCE TEXT must reach the same verdict.
 */
describe('isFunction for contractions, straight and curly', () => {
  const CONTRACTIONS = (
    "don't can't won't isn't aren't wasn't weren't hasn't haven't hadn't didn't doesn't" +
    " couldn't wouldn't shouldn't mustn't ain't I'm I'll I've I'd you're you'll you've you'd" +
    " he's she's it's we're we'll we've we'd they're they'll they've they'd let's that's" +
    " there's what's who's here's"
  ).split(' ');

  for (const straight of CONTRACTIONS) {
    const curly = straight.replace(/'/g, '’');
    it(`${straight} / ${curly}`, () => {
      for (const form of [straight, curly]) {
        const tokens = flagged(`Well ${form} fine.`);
        const t = tokens[1];
        expect(t?.text).toBe(form);
        expect(t?.isFunction).toBe(true);
      }
    });
  }

  it('a curly apostrophe never turns a contraction into a proper noun', () => {
    const t = byText(flagged('Well I’m fine.'), 'I’m');
    expect(t.isFunction).toBe(true);
    expect(t.isProperish).toBe(false);
  });
});

// ------------------------------------------------------------------ script conditioning

describe('isFunction is script-conditional', () => {
  it('treats short Latin-script tokens as glue', () => {
    const t = flagged('Xy zzz');
    expect(byText(t, 'Xy').isFunction).toBe(true);
    expect(byText(t, 'zzz').isFunction).toBe(false);
  });

  it('does NOT treat 1–2 character CJK tokens as glue (keyWords would have no candidates)', () => {
    const t = flagged('私は学生です。', 'ja');
    expect(t.map((x) => x.isFunction)).toEqual([false, false, false, false]);
  });

  it('never marks numbers or punctuation as function words', () => {
    const t = flagged('I had 9 — 12 apples.');
    expect(byText(t, '9').isFunction).toBe(false);
    expect(byText(t, '—').isFunction).toBe(false);
    expect(byText(t, 'had').isFunction).toBe(true);
  });
});

// ------------------------------------------------------------------ isProperish

describe('isProperish', () => {
  it('is true for a capitalised word inside a sentence', () => {
    expect(byText(flagged('The quick brown Fox jumped.'), 'Fox').isProperish).toBe(true);
  });

  it('excludes sentence-initial words', () => {
    expect(byText(flagged('The quick brown Fox jumped.'), 'The').isProperish).toBe(false);
  });

  it('excludes a word that only follows a standalone separator', () => {
    // §7.4's `posInSent > 0` alone would call this one properish.
    expect(byText(flagged('— Hello, said Bob.'), 'Hello').isProperish).toBe(false);
    expect(byText(flagged('— Hello, said Bob.'), 'Bob').isProperish).toBe(true);
  });

  it('excludes every I-form', () => {
    const t = flagged("Yesterday I said I'm tired, I'll go, I've tried and I'd rather not.");
    for (const form of ['I', "I'm", "I'll", "I've", "I'd"]) {
      expect(byText(t, form).isProperish).toBe(false);
    }
  });

  it('excludes ALLCAPS', () => {
    expect(byText(flagged('the plus 20% VAT rate'), 'VAT').isProperish).toBe(false);
    expect(isAllCaps('D.C.')).toBe(true);
    expect(isAllCaps("O'Brien")).toBe(false);
  });

  it('is always false for German, which capitalises every noun', () => {
    const line = 'Der schnelle braune Fuchs sprang.';
    expect(byText(flagged(line, 'de'), 'Fuchs').isProperish).toBe(false);
    expect(byText(flagged(line, 'de-AT'), 'Fuchs').isProperish).toBe(false);
    // …and the same sentence in a language that does not: the flag survives.
    expect(byText(flagged(line, 'en'), 'Fuchs').isProperish).toBe(true);
  });
});

// ------------------------------------------------------------------ the rest of the pass

describe('deriveTokenFlags', () => {
  it('counts occurrences of `normalized` across everything it is given', () => {
    const t = flagged('The cat saw the CAT and a café. Café!');
    expect(byText(t, 'The').count).toBe(2);
    expect(byText(t, 'CAT').count).toBe(2);
    expect(byText(t, 'café').count).toBe(2);
  });

  it('sets hasDigit from the token text', () => {
    const t = flagged('I paid £5.99 for 1,200-page books');
    expect(byText(t, '5.99').hasDigit).toBe(true);
    expect(byText(t, '1,200-page').hasDigit).toBe(true);
    expect(byText(t, 'books').hasDigit).toBe(false);
  });

  it('masks words and numbers in dialogue/paragraph/verse blocks only', () => {
    const t = flagged('Enter the ghost — 9:30.', 'en', ['dialogue']);
    expect(byText(t, 'ghost').isMaskable).toBe(true);
    expect(byText(t, '9:30').isMaskable).toBe(true);
    expect(byText(t, '—').isMaskable).toBe(false);

    const heading = flagged('Enter the ghost.', 'en', ['heading']);
    expect(heading.every((x) => !x.isMaskable)).toBe(true);
  });

  it('mutates in place and returns the same array', () => {
    const tokens = tokenizeLine('the cat', 'en');
    expect(deriveTokenFlags(tokens, { lang: 'en' })).toBe(tokens);
    expect(tokens[0]?.isFunction).toBe(true);
  });
});

// ------------------------------------------------------------------ language profiles

describe('language profiles (§7.4 script table)', () => {
  it('classifies scripts', () => {
    expect(languageProfile('en-US').family).toBe('latin');
    expect(languageProfile('ru').family).toBe('cyrillic');
    expect(languageProfile('el').family).toBe('greek');
    expect(languageProfile('ja').family).toBe('cjk');
    expect(languageProfile('zh-Hant').family).toBe('cjk');
    expect(languageProfile('he').family).toBe('rtl');
    expect(languageProfile('ar-EG').family).toBe('rtl');
    expect(languageProfile('!!junk!!').family).toBe('other');
  });

  it('gates the short-token heuristic on Latin-like scripts', () => {
    expect(isLatinLikeScript('en')).toBe(true);
    expect(isLatinLikeScript('ru')).toBe(true);
    expect(isLatinLikeScript('el')).toBe(true);
    expect(isLatinLikeScript('ja')).toBe(false);
    expect(isLatinLikeScript('he')).toBe(false);
  });

  it('hides the methods each script cannot support', () => {
    expect(languageProfile('en').hiddenMethods).toEqual([]);
    expect(languageProfile('fr').hiddenMethods).toEqual(['keyWords', 'glueWords']);
    expect(languageProfile('ja').hiddenMethods).toEqual(['keyWords', 'glueWords', 'rhymes']);
    // Arabic joining forms: hiding a middle letter reshapes its neighbours.
    expect(languageProfile('ar').hiddenMethods).toContain('firstLetters');
  });

  it('reads the primary subtag', () => {
    expect(baseLanguage('EN-gb')).toBe('en');
    expect(baseLanguage(' pt-BR ')).toBe('pt');
    expect(baseLanguage('123')).toBe('');
  });
});
