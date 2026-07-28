import { titleFromFileName } from './txt';
import type { ExtractResult } from './types';

/**
 * PDF -> text. PLAN.md §7.1 (".pdf").
 *
 * pdf.js is NOT imported here. `src/core` is pure and pdf.js is a >1 MB lazy chunk that
 * only the import route pulls in, so the split is:
 *
 *   assemblePdfText(pages)  — pure, all of the real work, unit-testable with synthetic data
 *   extractPdf(loader)      — thin async shell over an injected loader
 *
 * The UI layer does the `await import('pdfjs-dist')`, the worker wiring, the viewport
 * transform normalisation of §7.1 step 2, and hands us plain {str,x,y,width,size} items in
 * VIEWPORT space (x right, y DOWN from the top of the page).
 *
 * Explicitly LATER (§3.3), and deliberately absent below — the editable import preview is
 * what makes their absence acceptable:
 *   - column detection (a two-column script currently interleaves)
 *   - evidence-based de-hyphenation (we use the conservative lowercase-continuation rule)
 *   - watermark detection, dual dialogue, scene-number margins
 */

/** §7.1: "Cap at 400 pages / 25 MB with a clear message." The UI enforces the byte cap. */
export const MAX_PDF_PAGES = 400;
export const MAX_PDF_BYTES = 25 * 1024 * 1024;

/** §7.1 step 9: alphanumeric chars per page below this means pictures of text. */
export const MIN_ALNUM_PER_PAGE = 100;

const Y_TOLERANCE_RATIO = 0.35;
const SPACE_GAP_RATIO = 0.22;
const TAB_GAP_RATIO = 2.5;
const BLANK_LINE_GAP_RATIO = 1.6;
const TRACKING_MIN_GAP_RATIO = 0.12;
const TRACKING_MAX_GAP_RATIO = 0.45;
const TRACKING_SINGLE_CHAR_SHARE = 0.8;
const TRACKING_MAX_GAP_STDDEV_RATIO = 0.1;
const DEFAULT_FONT_SIZE_PT = 12;

/**
 * How many content lines at each end of a page count as header/footer territory.
 * One, deliberately: the cost of dropping a real first line of dialogue is far higher
 * than the cost of leaving a two-line running header in the editable preview.
 */
const PAGE_EDGE_LINES = 1;
const MAX_RUNNING_LINE_CHARS = 80;
const RUNNING_LINE_MIN_PAGES = 3;
const RUNNING_LINE_PAGE_SHARE = 0.6;

export interface PdfTextItem {
  str: string;
  /** Left edge, viewport points. */
  x: number;
  /** Baseline, viewport points, increasing DOWNWARD. */
  y: number;
  width: number;
  /** Effective font size in points: `Math.hypot(m[1], m[3]) || item.height`. */
  size: number;
}

export interface PdfPage {
  /** 0-based. */
  pageIndex: number;
  items: PdfTextItem[];
}

/** One assembled visual line. `text === ''` is a reconstructed blank line. */
export interface PdfLine {
  text: string;
  pageIndex: number;
  yPt: number;
  indentPt: number;
  fontSizePt: number;
  /** Set by the §7.1 step 4 tracking guard: "T H E  T E M P E S T" was rejoined. */
  letterSpaced: boolean;
}

export interface AssembleOptions {
  /** Title from the PDF's metadata, when the loader could read one. */
  title?: string | null | undefined;
  name?: string | undefined;
}

/**
 * §7.1 step 7 — the always-drop list, applied only when the pattern is the ENTIRE line,
 * so `MARY (CONT'D)` survives as a cue.
 */
const ALWAYS_DROP: readonly RegExp[] = [
  /^\(?(page\s*)?\d{1,4}(\s*of\s*\d{1,4})?\)?\.?$/i,
  /^\d{1,3}[a-z]?\.$/,
  /^\(?(MORE|CONTINUED|CONT['’]?D)\)?\.?$/i,
  /^(Rev\.?|Revised)\s+\d/i,
  /^\*+$/,
];

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function separatorFor(gap: number, size: number): string {
  if (gap > TAB_GAP_RATIO * size) return '\t';
  if (gap > SPACE_GAP_RATIO * size) return ' ';
  // pdf.js emits one item per glyph for subsetted fonts; a ~zero gap is mid-word.
  return '';
}

/**
 * §7.1 step 4 tracking guard. Without it a centred tracked title extracts as
 * `T H E   T E M P E S T`, which then reads as an ALLCAPS cue and tokenizes into ten
 * one-letter tokens.
 */
function isLetterSpaced(items: PdfTextItem[], gaps: number[], size: number): boolean {
  if (items.length < 4 || gaps.length === 0) return false;
  const singles = items.filter((it) => [...it.str].length === 1).length;
  if (singles / items.length < TRACKING_SINGLE_CHAR_SHARE) return false;
  const inRange = gaps.every(
    (g) => g >= TRACKING_MIN_GAP_RATIO * size && g <= TRACKING_MAX_GAP_RATIO * size,
  );
  return inRange && stddev(gaps) <= TRACKING_MAX_GAP_STDDEV_RATIO * size;
}

interface YCluster {
  meanY: number;
  items: PdfTextItem[];
}

/** §7.1 step 3: cluster by y, never by `hasEOL`, with an incrementally updated mean. */
function clusterByY(items: PdfTextItem[], tolerance: number): YCluster[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const clusters: YCluster[] = [];
  let current: YCluster | null = null;
  for (const item of sorted) {
    if (current !== null && Math.abs(item.y - current.meanY) < tolerance) {
      current.items.push(item);
      current.meanY += (item.y - current.meanY) / current.items.length;
    } else {
      current = { meanY: item.y, items: [item] };
      clusters.push(current);
    }
  }
  return clusters;
}

function joinCluster(cluster: YCluster, pageIndex: number): PdfLine {
  const items = [...cluster.items].sort((a, b) => a.x - b.x);
  const size = median(items.map((it) => it.size)) || DEFAULT_FONT_SIZE_PT;

  const gaps: number[] = [];
  for (let k = 1; k < items.length; k++) {
    const prev = items[k - 1];
    const cur = items[k];
    if (!prev || !cur) continue;
    gaps.push(cur.x - (prev.x + prev.width));
  }

  const letterSpaced = isLetterSpaced(items, gaps, size);
  const parts: string[] = [items[0]?.str ?? ''];
  for (let k = 1; k < items.length; k++) {
    if (!letterSpaced) parts.push(separatorFor(gaps[k - 1] ?? 0, size));
    parts.push(items[k]?.str ?? '');
  }

  return {
    text: parts.join(''),
    pageIndex,
    yPt: cluster.meanY,
    indentPt: items[0]?.x ?? 0,
    fontSizePt: size,
    letterSpaced,
  };
}

/**
 * §7.1 steps 3-6: one page's items become visual lines, with the blank lines that carry
 * most of a script's structure reconstructed from the vertical gaps.
 */
export function assemblePageLines(page: PdfPage): PdfLine[] {
  const items = page.items.filter((it) => it.str !== '');
  if (items.length === 0) return [];

  const medianSize = median(items.map((it) => it.size)) || DEFAULT_FONT_SIZE_PT;
  const clusters = clusterByY(items, Y_TOLERANCE_RATIO * medianSize);

  const deltas: number[] = [];
  for (let k = 1; k < clusters.length; k++) {
    const prev = clusters[k - 1];
    const cur = clusters[k];
    if (!prev || !cur) continue;
    deltas.push(cur.meanY - prev.meanY);
  }
  const medianLineGap = median(deltas);

  const lines: PdfLine[] = [];
  clusters.forEach((cluster, k) => {
    const prev = clusters[k - 1];
    if (
      prev &&
      medianLineGap > 0 &&
      cluster.meanY - prev.meanY > BLANK_LINE_GAP_RATIO * medianLineGap
    ) {
      lines.push({
        text: '',
        pageIndex: page.pageIndex,
        yPt: (prev.meanY + cluster.meanY) / 2,
        indentPt: 0,
        fontSizePt: medianSize,
        letterSpaced: false,
      });
    }
    lines.push(joinCluster(cluster, page.pageIndex));
  });

  return lines;
}

function isArtifactLine(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  return ALWAYS_DROP.some((re) => re.test(trimmed));
}

/** Digits are masked so `Hamlet — 12` and `Hamlet — 13` count as the same running header. */
function runningKey(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/**
 * Repeat detection for running headers/footers. §7.1 step 7 scopes M2 to the always-drop
 * list alone, but a title repeated on every page of a 40-page script is the single most
 * common PDF artifact, so this narrow version ships: a line only qualifies if it sits in
 * the top or bottom PAGE_EDGE_LINES of its page on most pages of a document with at least
 * RUNNING_LINE_MIN_PAGES pages. Body text can never satisfy that.
 */
function findRunningKeys(pages: PdfLine[][]): Set<string> {
  const running = new Set<string>();
  if (pages.length < RUNNING_LINE_MIN_PAGES) return running;

  const pagesByKey = new Map<string, Set<number>>();
  for (const lines of pages) {
    const content = lines.filter((l) => l.text.trim() !== '');
    const edge = [...content.slice(0, PAGE_EDGE_LINES), ...content.slice(-PAGE_EDGE_LINES)];
    const seenOnThisPage = new Set<string>();
    for (const line of edge) {
      const key = runningKey(line.text);
      if (key.length < 3 || key.length > MAX_RUNNING_LINE_CHARS) continue;
      if (seenOnThisPage.has(key)) continue;
      seenOnThisPage.add(key);
      let pageSet = pagesByKey.get(key);
      if (!pageSet) {
        pageSet = new Set<number>();
        pagesByKey.set(key, pageSet);
      }
      pageSet.add(line.pageIndex);
    }
  }

  const threshold = Math.max(
    RUNNING_LINE_MIN_PAGES,
    Math.ceil(pages.length * RUNNING_LINE_PAGE_SHARE),
  );
  for (const [key, pageSet] of pagesByKey) {
    if (pageSet.size >= threshold) running.add(key);
  }
  return running;
}

function dropArtifacts(pages: PdfLine[][]): PdfLine[] {
  const running = findRunningKeys(pages);
  const kept: PdfLine[] = [];
  for (const lines of pages) {
    const contentIdx = new Map<PdfLine, number>();
    const content = lines.filter((l) => l.text.trim() !== '');
    content.forEach((l, k) => {
      contentIdx.set(l, k);
    });
    for (const line of lines) {
      if (isArtifactLine(line.text)) continue;
      const k = contentIdx.get(line);
      const atEdge =
        k !== undefined && (k < PAGE_EDGE_LINES || k >= content.length - PAGE_EDGE_LINES);
      if (atEdge && running.has(runningKey(line.text))) continue;
      kept.push(line);
    }
  }
  return kept;
}

/**
 * Conservative de-hyphenation: join only when the break looks like a wrapped word —
 * a letter, a hyphen, end of line, and a lowercase letter starting the next line.
 * Evidence-based de-hyphenation (checking whether the joined form occurs unhyphenated
 * elsewhere in the document) is LATER, §3.3.
 */
function joinHyphenatedBreaks(lines: PdfLine[]): PdfLine[] {
  const out: PdfLine[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.text !== '' &&
      line.text !== '' &&
      /\p{Ll}[-‐­]$/u.test(prev.text) &&
      /^\p{Ll}/u.test(line.text)
    ) {
      out[out.length - 1] = { ...prev, text: prev.text.slice(0, -1) + line.text };
      continue;
    }
    out.push(line);
  }
  return out;
}

function alnumCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

function formatPageList(pageIndexes: number[]): string {
  const shown = pageIndexes.slice(0, 5).map((i) => i + 1);
  const rest = pageIndexes.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

/**
 * The pure half of PDF import: per-page text items in, ExtractResult out.
 * Everything in §7.1 steps 3-9 happens here.
 */
export function assemblePdfText(pages: PdfPage[], options: AssembleOptions = {}): ExtractResult {
  const warnings: string[] = [];
  const perPage = pages.map((page) => assemblePageLines(page));
  const lines = joinHyphenatedBreaks(dropArtifacts(perPage));

  const text = lines
    .map((l) => l.text)
    .join('\n')
    .replace(/[^\S\n]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // §7.1 step 9 — the one scanned-PDF rule. No OCR, ever (§3.2).
  const totalAlnum = alnumCount(text);
  const thinPages = perPage
    .map((pageLines, k) => ({ k, alnum: alnumCount(pageLines.map((l) => l.text).join(' ')) }))
    .filter((p) => p.alnum < MIN_ALNUM_PER_PAGE)
    .map((p) => p.k);

  const likelyScanned = pages.length > 0 && totalAlnum / pages.length < MIN_ALNUM_PER_PAGE;
  if (likelyScanned) {
    warnings.push(
      "This PDF is a scan — it's pictures of text, so we can't read the words. " +
        'Paste the text instead.',
    );
  } else if (thinPages.length > 0) {
    const plural = thinPages.length === 1 ? 'Page' : 'Pages';
    warnings.push(
      `${plural} ${formatPageList(thinPages)} had almost no readable text — ` +
        'probably scanned images rather than text.',
    );
  }

  return {
    text,
    title: options.title ?? titleFromFileName(options.name),
    source: {
      format: 'pdf',
      name: options.name,
      pageCount: pages.length,
      hasGeometry: true,
      likelyScanned,
    },
    warnings,
  };
}

// ------------------------------------------------------------------ async shell

/** What the UI layer's pdf.js wrapper must provide. Keeps pdf.js out of `src/core`. */
export interface PdfSource {
  pageCount: number;
  title?: string | null | undefined;
  /** Items already normalised against the page viewport (§7.1 step 2). */
  getPageItems(pageIndex: number): Promise<PdfTextItem[]>;
}

export type PdfLoader = () => Promise<PdfSource>;

export interface ExtractPdfOptions {
  name?: string | undefined;
  /** Progress for the import worker's UI; called once per page. */
  onProgress?: ((pagesDone: number, pagesTotal: number) => void) | undefined;
}

export async function extractPdf(
  load: PdfLoader,
  options: ExtractPdfOptions = {},
): Promise<ExtractResult> {
  const source = await load();
  const warnings: string[] = [];
  const pageCount = Math.max(0, Math.floor(source.pageCount));
  const limit = Math.min(pageCount, MAX_PDF_PAGES);
  if (pageCount > MAX_PDF_PAGES) {
    warnings.push(
      `This PDF has ${pageCount} pages. Only the first ${MAX_PDF_PAGES} were imported.`,
    );
  }

  const pages: PdfPage[] = [];
  for (let i = 0; i < limit; i++) {
    // Sequential on purpose: a 400-page script parsed in parallel peaks memory on a phone.
    const items = await source.getPageItems(i);
    pages.push({ pageIndex: i, items });
    options.onProgress?.(i + 1, limit);
  }

  const result = assemblePdfText(pages, { title: source.title ?? null, name: options.name });
  return {
    ...result,
    warnings: [...warnings, ...result.warnings],
    source: { ...result.source, pageCount },
  };
}
