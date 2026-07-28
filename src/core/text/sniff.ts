/**
 * Stage 2 — SNIFF. PLAN.md §7.3.
 *
 * One pass over lightly-cleaned lines (rules 1-4) producing a guess at the document kind and
 * language. Deliberately small: below `confidence` 0.65 the review step just asks the user, and the
 * field is editable forever after, so heuristic tuning here has sharply diminishing returns.
 */

import type { DocKind } from './types';

export interface SniffResult {
  kind: DocKind;
  lang: string;
  confidence: number;
  /** Human-readable reasons, shown in the review step so the guess is never a black box. */
  signals: string[];
}

const SLUG = /^(?:INT\.|EXT\.|INT\/EXT|I\/E)\b/i;
const ALLCAPS_SHORT = /^\p{Lu}[\p{Lu}\d .,'\-()]{0,30}$/u;
const COLON_CUE = /^([\p{Lu}][\p{L}'.\- ]{0,24})[:.]\s+\S/u;
const SECTION_LABEL = /^[[(]?(?:verse|chorus|bridge|refrain|pre-?chorus|hook|intro|outro|coda)\b/i;
const TERMINAL = /[.!?][")'\]]*$/;
const HEADING_OR_LIST = /^(?:#{1,6}\s|\s*(?:[-*•]|\d{1,3}[.)])\s+)/;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1)))] ?? 0;
}

const share = (xs: string[], f: (s: string) => boolean): number =>
  xs.length === 0 ? 0 : xs.filter(f).length / xs.length;

function countIdenticalStanzas(lines: string[]): number {
  const stanzas = lines
    .join('\n')
    .split(/\n{2,}/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 20);
  const seen = new Set<string>();
  let repeats = 0;
  for (const s of stanzas) {
    if (seen.has(s)) repeats++;
    else seen.add(s);
  }
  return repeats;
}

function measure(lines: string[]) {
  const body = lines.map((l) => l.trim()).filter((l) => l !== '');
  const lens = body.map((l) => l.length).sort((a, b) => a - b);
  const cueCounts = new Map<string, number>();
  for (const l of body) {
    const name = COLON_CUE.exec(l)?.[1]?.trim().toUpperCase();
    if (name) cueCounts.set(name, (cueCounts.get(name) ?? 0) + 1);
  }
  const recurring = [...cueCounts.values()].filter((v) => v >= 2);
  return {
    n: body.length,
    medLen: percentile(lens, 0.5),
    pBlank: lines.length === 0 ? 0 : (lines.length - body.length) / lines.length,
    pAllCapsShort: share(body, (l) => l.length <= 32 && ALLCAPS_SHORT.test(l)),
    pIntExt: share(body, (l) => SLUG.test(l)),
    pTerminal: share(body, (l) => TERMINAL.test(l)),
    pCapStart: share(body, (l) => /^\p{Lu}/u.test(l)),
    pStructural: share(body, (l) => HEADING_OR_LIST.test(l)),
    nRecurringCues: recurring.length,
    cueCoverage: body.length === 0 ? 0 : recurring.reduce((a, b) => a + b, 0) / body.length,
    nSectionLabels: body.filter((l) => SECTION_LABEL.test(l)).length,
    nIdenticalStanzas: countIdenticalStanzas(lines),
  };
}

function classify(f: ReturnType<typeof measure>, signals: string[]): [DocKind, number] {
  if (f.pIntExt > 0.01) {
    signals.push('screenplay slug lines (INT./EXT.)');
    return ['script', 0.92];
  }
  if (f.nRecurringCues >= 3 && f.cueCoverage > 0.2) {
    signals.push(`${f.nRecurringCues} recurring speaker cues`);
    return ['script', 0.88];
  }
  if (f.pAllCapsShort >= 0.06 && f.pAllCapsShort <= 0.35 && f.pBlank > 0.05) {
    signals.push('all-caps cue lines separated by blanks');
    return ['script', 0.7];
  }
  if (f.nSectionLabels >= 2 || f.nIdenticalStanzas >= 1) {
    signals.push(
      f.nSectionLabels >= 2
        ? `${f.nSectionLabels} verse/chorus markers`
        : `${f.nIdenticalStanzas} repeated stanza(s)`,
    );
    return ['lyrics', 0.85];
  }
  if (f.medLen < 55 && f.pCapStart >= 0.75 && f.pTerminal < 0.6) {
    signals.push('short lines, each starting with a capital');
    return ['poem', 0.72];
  }
  if (f.medLen < 45 && f.pTerminal < 0.35 && f.pBlank > 0.1) {
    signals.push('short unpunctuated lines in stanzas');
    return ['lyrics', 0.58];
  }
  if (f.medLen > 55 && f.pTerminal > 0.5) {
    signals.push('long lines ending in sentence punctuation');
    return ['speech', 0.72];
  }
  if (f.pStructural > 0.15) {
    signals.push('headings and list items over prose');
    return ['lesson', 0.5];
  }
  signals.push('no strong structural signal');
  return ['other', 0.35];
}

// ---------------------------------------------------------------- language

const SCRIPT_PROBES: ReadonlyArray<readonly [string, RegExp]> = [
  ['ja', /[\p{Script=Hiragana}\p{Script=Katakana}]/gu],
  ['ko', /\p{Script=Hangul}/gu],
  ['zh', /\p{Script=Han}/gu],
  ['ru', /\p{Script=Cyrillic}/gu],
  ['el', /\p{Script=Greek}/gu],
  ['ar', /\p{Script=Arabic}/gu],
  ['he', /\p{Script=Hebrew}/gu],
  ['hi', /\p{Script=Devanagari}/gu],
];

/** ~12 of the commonest words per language. Enough to separate the six the plan ships (§7.4). */
const STOPWORDS: Record<string, readonly string[]> = {
  en: ['the', 'and', 'of', 'to', 'that', 'is', 'in', 'it', 'you', 'with', 'for', 'not'],
  es: ['el', 'la', 'de', 'que', 'los', 'las', 'un', 'una', 'por', 'con', 'del', 'no'],
  fr: ['le', 'la', 'les', 'des', 'et', 'que', 'un', 'une', 'pour', 'dans', 'qui', 'pas'],
  de: ['der', 'die', 'das', 'und', 'ich', 'nicht', 'ist', 'den', 'zu', 'ein', 'mit', 'sich'],
  it: ['il', 'di', 'che', 'un', 'per', 'non', 'con', 'del', 'una', 'sono', 'nel', 'gli'],
  pt: ['de', 'que', 'do', 'da', 'em', 'um', 'uma', 'para', 'nao', 'com', 'os', 'as'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'niet', 'te', 'met', 'die', 'voor'],
};

const MIN_STOPWORD_SHARE = 0.06;
const MIN_STOPWORD_MARGIN = 0.015;

function detectLang(text: string, signals: string[]): string {
  for (const [lang, probe] of SCRIPT_PROBES) {
    if ((text.match(probe)?.length ?? 0) > text.length * 0.1) {
      signals.push(`non-Latin script detected, assuming ${lang}`);
      return lang;
    }
  }
  const words = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .match(/\p{L}+/gu);
  if (!words || words.length < 20) {
    signals.push('too little text to detect language; defaulting to en');
    return 'en';
  }
  const scores = Object.entries(STOPWORDS)
    .map(([lang, list]) => {
      const set = new Set(list);
      return { lang, score: words.filter((w) => set.has(w)).length / words.length };
    })
    .sort((a, b) => b.score - a.score);
  const best = scores[0];
  const runnerUp = scores[1];
  if (!best || best.score < MIN_STOPWORD_SHARE) {
    signals.push('no stopword match; defaulting to en');
    return 'en';
  }
  if (runnerUp && best.score - runnerUp.score < MIN_STOPWORD_MARGIN) {
    signals.push(`language ambiguous (${best.lang}/${runnerUp.lang}); defaulting to en`);
    return 'en';
  }
  signals.push(`stopword profile matches ${best.lang}`);
  return best.lang;
}

export function sniffDocument(lines: string[]): SniffResult {
  const signals: string[] = [];
  const f = measure(lines);
  const [kind, rawConfidence] = classify(f, signals);
  const lang = detectLang(lines.join('\n').slice(0, 8000), signals);
  let confidence = rawConfidence;
  if (f.n < 6) {
    confidence = Math.min(confidence, 0.5);
    signals.push('very short input, low confidence');
  }
  return { kind, lang, confidence, signals };
}
