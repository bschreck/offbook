/**
 * Stage 1 EXTRACT — the shared result shape. PLAN.md §7.1.
 *
 * Every extractor (paste, txt, md, html, pdf) returns exactly this. Downstream stages
 * (SNIFF §7.3, CLEAN §7.3, tokenize §7.4) only ever see `text`; `source` and `warnings`
 * are carried through to the import review screen and thrown away after saving.
 *
 * Pure — no DOM, no pdf.js, no file handles. Bytes and clipboard events are the UI layer's
 * problem; these functions take strings (and, for PDF, an injected loader).
 */

export type ExtractFormat = 'paste' | 'txt' | 'md' | 'html' | 'pdf';

export interface ExtractSource {
  format: ExtractFormat;
  /** Original file name, when the text came from a file rather than the clipboard. */
  name?: string | undefined;
  pageCount?: number | undefined;
  /**
   * True when the extractor could see layout geometry (indentation, font size, y).
   * Load-bearing: the §7.5 cue detector gets a confidence boost when it is true and
   * falls back to purely lexical rules when it is false. Only PDF sets it today.
   */
  hasGeometry: boolean;
  /** PDF only: near-zero text yield, so this is pictures of text (§7.1 step 9). */
  likelyScanned?: boolean | undefined;
}

export interface ExtractResult {
  /** Visible text, line structure preserved. Never null — an empty import is `''`. */
  text: string;
  title: string | null;
  source: ExtractSource;
  /** Surfaced in the import review step, never thrown away and never thrown as an error. */
  warnings: string[];
}
