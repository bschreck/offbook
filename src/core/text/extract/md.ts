import { normalizePlainText, titleFromFileName } from './txt';
import type { ExtractResult } from './types';

/**
 * Markdown -> visible text. PLAN.md §7.1 (".txt / .md").
 *
 * Markdown is *stripped*, not rendered — no `marked`, no `markdown-it`. Line structure is
 * the payload here (a lyric sheet written in Markdown must come out one line per line), so
 * everything is done line-by-line and blank lines are preserved verbatim.
 *
 * Per §7.1: fenced code is dropped with a warning if it took more than 20% of the document,
 * and `~~struck~~` text is dropped outright because struck lines are cut lines.
 */

const CODE_DROP_WARNING_RATIO = 0.2;

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^( {0,3})(#{1,6})\s+(.*?)\s*#*\s*$/;
const SETEXT_OR_RULE_RE = /^ {0,3}(=+|-{2,}|\*{3,}|_{3,})\s*$/;
const LINK_DEFINITION_RE = /^ {0,3}\[[^\]]+\]:\s*\S+/;
const BLOCKQUOTE_RE = /^(\s*)>\s?/;
const LIST_MARKER_RE = /^(\s*)(?:[-*+]|\d{1,9}[.)])\s+/;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[^\S\n]*(?:\r?\n|$)/;

/** Strips inline markup, keeping the visible text. Order matters: strike, then links. */
export function stripInlineMarkdown(line: string): string {
  return (
    line
      // Struck text is cut text (§7.1): remove the content, not just the tildes.
      .replace(/~~([\s\S]*?)~~/g, '')
      // Images contribute no spoken words; alt text is not visible text.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/!\[[^\]]*\]\[[^\]]*\]/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
      .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
      .replace(/`+([^`]+)`+/g, '$1')
      .replace(/(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/\*(?=\S)([^*]*?\S)\*/g, '$1')
      // `_` only counts as emphasis at word boundaries, so snake_case_names survive.
      .replace(/(^|[^\w\\])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1$2')
      .replace(/\\([\\`*_{}[\]()#+\-.!~>|])/g, '$1')
      // Removing struck or inline markup leaves gaps; interior runs are not meaningful in
      // Markdown, but leading indentation is (verse), so only interior runs collapse.
      .replace(/(\S) {2,}/g, '$1 ')
      .replace(/[^\S\n]+$/, '')
  );
}

interface Frontmatter {
  body: string;
  title: string | null;
}

function splitFrontmatter(source: string): Frontmatter {
  const m = FRONTMATTER_RE.exec(source);
  if (!m) return { body: source, title: null };
  const titleMatch = /^title:[^\S\n]*(.+)$/m.exec(m[1] ?? '');
  const raw = (titleMatch?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
  return { body: source.slice(m[0].length), title: raw === '' ? null : raw };
}

export function extractMarkdown(source: string, fileName?: string): ExtractResult {
  const warnings: string[] = [];
  const normalized = normalizePlainText(source).replace(/<!--[\s\S]*?-->/g, '');
  const { body, title: frontmatterTitle } = splitFrontmatter(normalized);

  const out: string[] = [];
  let headingTitle: string | null = null;
  let fence: string | null = null;
  let droppedCodeChars = 0;

  for (const line of body.split('\n')) {
    if (fence !== null) {
      if (new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)) {
        fence = null;
      } else {
        droppedCodeChars += line.length + 1;
      }
      continue;
    }

    const fenceOpen = FENCE_OPEN_RE.exec(line);
    if (fenceOpen) {
      fence = fenceOpen[1] ?? '```';
      continue;
    }

    if (SETEXT_OR_RULE_RE.test(line) || LINK_DEFINITION_RE.test(line)) {
      out.push('');
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const text = stripInlineMarkdown(heading[3] ?? '').trim();
      if (headingTitle === null && text !== '') headingTitle = text;
      out.push((heading[1] ?? '') + text);
      continue;
    }

    let stripped = line;
    while (BLOCKQUOTE_RE.test(stripped)) stripped = stripped.replace(BLOCKQUOTE_RE, '$1');
    stripped = stripped.replace(LIST_MARKER_RE, '$1');
    out.push(stripInlineMarkdown(stripped));
  }

  const text = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (droppedCodeChars > normalized.length * CODE_DROP_WARNING_RATIO) {
    const percent = Math.round((droppedCodeChars / Math.max(1, normalized.length)) * 100);
    warnings.push(`Dropped ${percent}% of this file because it was fenced code blocks.`);
  }
  if (fence !== null) {
    warnings.push('A code fence was never closed; everything after it was dropped.');
  }

  return {
    text,
    title: headingTitle ?? frontmatterTitle ?? titleFromFileName(fileName),
    source: { format: 'md', name: fileName, hasGeometry: false },
    warnings,
  };
}
