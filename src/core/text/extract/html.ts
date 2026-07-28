import { titleFromFileName } from './txt';
import type { ExtractResult } from './types';

/**
 * HTML -> visible text. PLAN.md §7.1 (".html").
 *
 * §7.1 specifies `new DOMParser()`, but this module lives in `src/core`, which is pure and
 * has no DOM (the layering rule). So this is a small tokenising scan instead: it drops
 * script/style/head content, maps block-level tags and `<br>` to newlines, decodes the
 * common entities, and collapses everything else. It is deliberately not a parser — it
 * never builds a tree and never tries to repair bad nesting, because for the one job we
 * have (recovering line structure from a paste) tag *events* are sufficient.
 *
 * Whole-element italic/bold flags, which §7.1 also wants, need a tree to attribute
 * correctly and are not produced here; the shared ExtractResult carries plain text only.
 */

/**
 * Break markers used inside the raw scan output. A run of markers collapses to the widest
 * break in the run, which is what stops a wall of `</div><div>` becoming a wall of blank
 * lines while `<br><br>` still produces a real one.
 */
const SOFT_BREAK = '\uE000';
const PARA_BREAK = '\uE001';
const BREAK_MARKER_RE = /[\uE000\uE001]/g;

/** Opening or closing one of these ends a visual line. */
const LINE_TAGS = new Set([
  'caption',
  'dd',
  'dialog',
  'div',
  'dt',
  'figcaption',
  'legend',
  'li',
  'summary',
  'tr',
]);

/** Opening or closing one of these ends a paragraph — a blank line, not just a break. */
const PARAGRAPH_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'details',
  'dl',
  'fieldset',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'html',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'tfoot',
  'thead',
  'ul',
]);

/** Cells are separated within a line, not broken onto their own line. */
const CELL_TAGS = new Set(['td', 'th']);

/** Everything between the open and close tag is invisible and is discarded. */
const SKIPPED_CONTENT_TAGS = new Set([
  'head',
  'script',
  'style',
  'template',
  'noscript',
  'iframe',
  'object',
  'svg',
  'math',
  'select',
  'datalist',
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  zwnj: '\u200C',
  zwj: '\u200D',
  shy: '\u00AD',
  ndash: '–',
  mdash: '—',
  horbar: '―',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  dagger: '†',
  Dagger: '‡',
  bull: '•',
  hellip: '…',
  permil: '‰',
  prime: '′',
  Prime: '″',
  lsaquo: '‹',
  rsaquo: '›',
  laquo: '«',
  raquo: '»',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  sup2: '²',
  sup3: '³',
  micro: 'µ',
  para: '¶',
  sect: '§',
  middot: '·',
  iexcl: '¡',
  iquest: '¿',
};

// The Latin-1 letter entities are contiguous in code-point order, so a table beats 64 lines.
const LATIN1_UPPER =
  'Agrave,Aacute,Acirc,Atilde,Auml,Aring,AElig,Ccedil,Egrave,Eacute,Ecirc,Euml,' +
  'Igrave,Iacute,Icirc,Iuml,ETH,Ntilde,Ograve,Oacute,Ocirc,Otilde,Ouml,times,' +
  'Oslash,Ugrave,Uacute,Ucirc,Uuml,Yacute,THORN,szlig';
const LATIN1_LOWER =
  'agrave,aacute,acirc,atilde,auml,aring,aelig,ccedil,egrave,eacute,ecirc,euml,' +
  'igrave,iacute,icirc,iuml,eth,ntilde,ograve,oacute,ocirc,otilde,ouml,divide,' +
  'oslash,ugrave,uacute,ucirc,uuml,yacute,thorn,yuml';

for (const [table, base] of [
  [LATIN1_UPPER, 0xc0],
  [LATIN1_LOWER, 0xe0],
] as const) {
  table.split(',').forEach((name, k) => {
    NAMED_ENTITIES[name] = String.fromCodePoint(base + k);
  });
}

const ENTITY_RE = /&(#[Xx][0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g;

export function decodeEntities(input: string): string {
  if (!input.includes('&')) return input;
  return input.replace(ENTITY_RE, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      // Surrogate halves are not valid characters; leaving the source text is honest.
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

interface TagToken {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  /** Index just past the '>'. */
  end: number;
}

/** `src[start]` must be '<'. Returns null when this is a stray '<' rather than markup. */
function readTag(src: string, start: number): TagToken | null {
  let i = start + 1;
  const closing = src[i] === '/';
  if (closing) i++;
  const nameStart = i;
  while (i < src.length && /[A-Za-z0-9:_-]/.test(src[i] ?? '')) i++;
  if (i === nameStart) return null;
  const name = src.slice(nameStart, i).toLowerCase();

  let quote = '';
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (quote !== '') {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      break;
    }
    j++;
  }
  return {
    name,
    closing,
    selfClosing: src[j - 1] === '/',
    end: j >= src.length ? src.length : j + 1,
  };
}

/**
 * Whitespace inside a text node is insignificant in HTML (we do not honour `<pre>`), so it
 * collapses here — otherwise every newline in the source markup would become a line break.
 */
function pushText(out: string[], slice: string): void {
  // The two break markers are private-use code points; strip any that arrive in the
  // source so a hostile or exotic document cannot forge a line break.
  out.push(decodeEntities(slice).replace(BREAK_MARKER_RE, '').replace(/\s+/g, ' '));
}

/** Runs the tag scan and returns raw text with break markers still in it. */
function scanToRawText(html: string): string {
  const out: string[] = [];
  let skip: { name: string; depth: number } | null = null;
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      if (!skip) pushText(out, html.slice(i));
      break;
    }
    if (lt > i && !skip) pushText(out, html.slice(i, lt));

    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      i = close < 0 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const close = html.indexOf('>', lt);
      i = close < 0 ? html.length : close + 1;
      continue;
    }

    const tag = readTag(html, lt);
    if (!tag) {
      if (!skip) out.push('<');
      i = lt + 1;
      continue;
    }
    i = tag.end;

    if (skip) {
      if (tag.name === skip.name) {
        if (tag.closing) {
          skip.depth--;
          if (skip.depth === 0) skip = null;
        } else if (!tag.selfClosing) {
          skip.depth++;
        }
      }
      continue;
    }

    if (!tag.closing && SKIPPED_CONTENT_TAGS.has(tag.name)) {
      if (!tag.selfClosing) skip = { name: tag.name, depth: 1 };
      continue;
    }
    if (tag.name === 'br' || tag.name === 'hr') {
      out.push('\n');
      continue;
    }
    if (CELL_TAGS.has(tag.name)) {
      out.push('\t');
      continue;
    }
    // Open AND close, so `<p>a</p><p>b</p>` and the unclosed `<div>a<div>b` both break.
    if (PARAGRAPH_TAGS.has(tag.name)) {
      out.push(PARA_BREAK);
    } else if (LINE_TAGS.has(tag.name)) {
      out.push(SOFT_BREAK);
    }
  }

  return out.join('');
}

/**
 * A run of adjacent breaks is worth the widest break in it: consecutive `<br>`s stack into
 * a blank line, but a nested `</div></div><div><div>` does not.
 */
function breakRun(run: string): string {
  let hard = 0;
  for (const ch of run) if (ch === '\n') hard++;
  const soft = run.includes(PARA_BREAK) ? 2 : run.includes(SOFT_BREAK) ? 1 : 0;
  return '\n'.repeat(Math.min(Math.max(hard, soft), 2));
}

/**
 * Markup whitespace is insignificant, so spaces around any break are dropped, break runs
 * are reduced, and cell tabs are kept as the one intra-line separator. Inline tags emit
 * nothing at all, which is why `<b>a</b> <i>b</i>` keeps its space.
 */
function collapse(raw: string): string {
  return raw
    .replace(/[^\S\n\t\uE000\uE001]+/g, ' ')
    .replace(/ *([\n\t\uE000\uE001]) */g, '$1')
    .replace(/\t+/g, '\t')
    .replace(/[\n\uE000\uE001]+/g, breakRun)
    .replace(/^\t+|\t+$/gm, '')
    .trim();
}

function firstMatchingElementText(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'i');
  const m = re.exec(html);
  if (!m) return null;
  const inner = collapse(scanToRawText(m[1] ?? ''))
    .replace(/\n+/g, ' ')
    .trim();
  return inner === '' ? null : inner;
}

/** The reusable core: paste.ts calls this so a clipboard paste and a .html file agree. */
export function extractHtmlText(html: string): { text: string; title: string | null } {
  const title = firstMatchingElementText(html, 'title') ?? firstMatchingElementText(html, 'h1');
  return { text: collapse(scanToRawText(html)), title };
}

export function extractHtml(html: string, fileName?: string): ExtractResult {
  const { text, title } = extractHtmlText(html);
  return {
    text,
    title: title ?? titleFromFileName(fileName),
    source: { format: 'html', name: fileName, hasGeometry: false },
    warnings: [],
  };
}
