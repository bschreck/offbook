/**
 * Function words and per-script language profiles. PLAN.md §7.4.
 *
 * THE LIST IS NORMALISED AT MODULE LOAD. `Token.normalized` straightens apostrophes, so a list
 * entry written with a curly apostrophe would never match: `don't`, `can't` and `I'm` would all
 * score as CONTENT words, and `I'm` would even score as a proper noun so `keyWords` hid it first.
 * The raw list below is written with straight apostrophes AND normalised anyway, so that pasting
 * a curly-quoted entry in future cannot reintroduce the bug (asserted by functionWords.test.ts).
 *
 * Numerals-as-words (`one`, `seven`, `hundred`) are deliberately absent: in a speech they are
 * high-value content.
 */

import type { LanguageProfile, ScriptFamily } from './types';

// ---------------------------------------------------------------- the English list

/** One string per category, split on load — the categories are the point, so keep them visible. */
const RAW_EN: readonly string[] = [
  // articles & determiners
  'a an the this that these those each every either neither another other others some any no',
  'none both all few fewer many much more most less least several such own same enough whole',
  'what which whose whatever whichever',
  // personal & indefinite pronouns. `one` is absent on purpose: as a numeral it is content.
  'i me my mine myself you your yours yourself yourselves he him his himself she her hers',
  'herself it its itself we us our ours ourselves they them their theirs themselves oneself',
  'who whom whoever whomever someone somebody something anyone anybody anything everyone',
  'everybody everything nobody nothing',
  // archaic pronouns — Shakespeare and hymns are a real use case
  'thou thee thy thine thyself ye',
  // be / have / do, every inflection including the archaic ones
  'be am is are was were been being art wast wert have has had having hast hath',
  'do does did done doing dost doth',
  // modals
  'can could shall should will would may might must ought need dare shalt wilt let',
  // negation
  'not nor never',
  // contractions — the whole reason the list is normalised at load
  "i'm i'll i've i'd you're you'll you've you'd he's he'll he'd she's she'll she'd",
  "it's it'll it'd we're we'll we've we'd they're they'll they've they'd",
  "that's that'll there's there'll there're here's what's who's where's when's how's let's",
  "isn't aren't wasn't weren't ain't don't doesn't didn't haven't hasn't hadn't",
  "won't wouldn't can't cannot couldn't shan't shouldn't mustn't mightn't needn't daren't",
  "'tis 'twas 'twere 'em 'til",
  // prepositions
  'about above across after against along amid among amongst around as at before behind below',
  'beneath beside besides between beyond but by despite down during except for from in inside',
  'into like near of off on onto opposite out outside over past per round since than through',
  'throughout till to toward towards under underneath unlike until unto up upon via with',
  'within without',
  // conjunctions
  'and or so yet if unless although though because while whilst whereas when whenever where',
  'wherever whether once lest',
  // degree adverbs, discourse particles and the rest of the adverbial glue
  'very quite rather too just only even still also again ever always often sometimes seldom',
  'rarely already almost nearly hardly barely scarcely really actually fairly somewhat indeed',
  'perhaps maybe however therefore thus hence moreover otherwise instead anyway',
  'here there then now well back away',
].flatMap((group) => group.split(' '));

/** PLAN.md §7.4: NFKC, lowercase, apostrophes unified — exactly what `Token.normalized` produces. */
export function normalizeFunctionWord(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[’´`]/g, "'");
}

export const FUNCTION_WORDS_EN: ReadonlySet<string> = new Set(RAW_EN.map(normalizeFunctionWord));

/**
 * Languages we ship a function-word list for. Adding `functionWords.<lang>.ts` means adding the
 * language here — otherwise `keyWords`/`glueWords` stay hidden for it, which is the honest default.
 */
const LANGS_WITH_FUNCTION_WORDS: ReadonlySet<string> = new Set(['en']);

/** The list for a language, or null when we ship none — never guess with another language's list. */
export function functionWordsFor(lang: string): ReadonlySet<string> | null {
  return baseLanguage(lang) === 'en' ? FUNCTION_WORDS_EN : null;
}

// ---------------------------------------------------------------- language profiles

/** The primary language subtag, lowercased. `en-GB` -> `en`, junk -> ''. */
export function baseLanguage(lang: string): string {
  const m = /^[A-Za-z]{2,3}/.exec(lang.trim());
  return m ? m[0].toLowerCase() : '';
}

function familyMap(spec: Partial<Record<ScriptFamily, string>>): ReadonlyMap<string, ScriptFamily> {
  const out = new Map<string, ScriptFamily>();
  for (const [family, keys] of Object.entries(spec)) {
    for (const key of (keys ?? '').split(' ')) out.set(key, family as ScriptFamily);
  }
  return out;
}

const FAMILY_BY_LANG = familyMap({
  latin:
    'en es fr de it pt nl sv da nb nn no fi is et lv lt pl cs sk sl hr bs sq hu ro tr vi id' +
    ' ms tl sw af ca gl eu cy ga gd mt la eo',
  cyrillic: 'ru uk bg sr mk be kk ky mn tg',
  greek: 'el grc',
  cjk: 'zh ja ko yue wuu nan',
  rtl: 'ar he fa ur ps sd ug yi dv ku arc',
});

const FAMILY_BY_SCRIPT = familyMap({
  latin: 'Latn',
  cyrillic: 'Cyrl',
  greek: 'Grek',
  cjk: 'Hans Hant Hani Jpan Kore Hang',
  rtl: 'Arab Hebr Thaa Syrc',
});

function scriptFamilyFromIntl(lang: string): ScriptFamily | null {
  let script: string | undefined;
  try {
    // `lang` reaches us from language sniffing and from imported file metadata; Intl.Locale
    // throws a RangeError on a malformed tag rather than returning a sentinel.
    script = new Intl.Locale(lang).maximize().script;
  } catch {
    return null;
  }
  if (script === undefined) return null;
  return FAMILY_BY_SCRIPT.get(script) ?? null;
}

export function scriptFamily(lang: string): ScriptFamily {
  return FAMILY_BY_LANG.get(baseLanguage(lang)) ?? scriptFamilyFromIntl(lang) ?? 'other';
}

/**
 * Latin, Cyrillic and Greek. The `normalized.length <= 2` function-word heuristic is gated on this:
 * without the gate every 1–2 character CJK token is a "function word" and `keyWords` has zero
 * candidates for Japanese (PLAN.md §7.4).
 */
export function isLatinLikeScript(lang: string): boolean {
  const family = scriptFamily(lang);
  return family === 'latin' || family === 'cyrillic' || family === 'greek';
}

/** The §7.4 per-script table, as data. */
export function languageProfile(lang: string): LanguageProfile {
  const family = scriptFamily(lang);
  const hasFunctionWords = LANGS_WITH_FUNCTION_WORDS.has(baseLanguage(lang));
  // No list means no keyWords/glueWords, whatever the script.
  const hiddenMethods: string[] = hasFunctionWords ? [] : ['keyWords', 'glueWords'];
  // CJK has no orthographic rhyme tail. `firstLetters` survives as "first character".
  if (family === 'cjk') hiddenMethods.push('rhymes');
  // Arabic joining forms: hiding a middle letter changes the SHAPES of its neighbours.
  if (family === 'rtl') hiddenMethods.push('firstLetters');
  return { lang, family, hasFunctionWords, hiddenMethods };
}
