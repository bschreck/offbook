/**
 * Stage 3 — CLEAN. PLAN.md §7.3.
 *
 * `runCleanup` is a pure function of (sourceText, config, hints): identical inputs always give an
 * identical result, which is what makes undo free — toggling a rule re-derives from the immutable
 * `sourceText` instead of unwinding a command stack.
 */

import type { CleanupConfig } from '../types';
import type { CleanupHints, RuleName, RuleResult } from './rules';
import { DEFAULT_HINTS, dropArtifacts, normalise, punctuation, unwrap, whitespace } from './rules';

export interface RuleReport {
  changed: number;
  notes: string[];
}

export interface CleanupResult {
  lines: string[];
  perRule: Record<RuleName, RuleReport>;
}

/**
 * Fixed order, independent of the order of keys in `config`. §7.3: unwrap runs last because it is
 * the only rule that needs the sniff, and the sniff needs rules 1-4 to have run.
 */
export const RULE_ORDER: readonly RuleName[] = [
  'normalise',
  'punctuation',
  'whitespace',
  'dropArtifacts',
  'unwrap',
];

/** Rules 1-4 — everything the sniffer is allowed to see (§7.3, "the ordering paradox"). */
export const PRE_SNIFF_RULES: readonly RuleName[] = RULE_ORDER.slice(0, 4);

const BOM = /^\uFEFF/;

export function splitLines(sourceText: string): string[] {
  return sourceText.replace(BOM, '').split(/\r\n?|\n/);
}

function applyRule(name: RuleName, lines: string[], hints: CleanupHints): RuleResult {
  switch (name) {
    case 'normalise':
      return normalise(lines);
    case 'punctuation':
      return punctuation(lines);
    case 'whitespace':
      return whitespace(lines);
    case 'dropArtifacts':
      return dropArtifacts(lines);
    case 'unwrap':
      return unwrap(lines, hints);
  }
}

export function runCleanup(
  sourceText: string,
  config: CleanupConfig,
  hints: CleanupHints = DEFAULT_HINTS,
): CleanupResult {
  const perRule = {} as Record<RuleName, RuleReport>;
  let lines = splitLines(sourceText);
  for (const name of RULE_ORDER) {
    if (!config[name]) {
      perRule[name] = { changed: 0, notes: [] };
      continue;
    }
    const result = applyRule(name, lines, hints);
    lines = result.lines;
    perRule[name] = { changed: result.changed, notes: result.notes };
  }
  return { lines, perRule };
}

/**
 * The lightly-normalised text the sniffer runs on: rules 1-4, defaults on, unwrap never.
 * Feeding the sniffer raw text makes it misread smart quotes and page numbers as signal.
 */
export function cleanForSniff(sourceText: string): string[] {
  return runCleanup(sourceText, {
    normalise: true,
    punctuation: true,
    whitespace: true,
    dropArtifacts: true,
    unwrap: false,
  }).lines;
}
