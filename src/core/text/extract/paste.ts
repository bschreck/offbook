import { extractHtmlText } from './html';
import { normalizePlainText } from './txt';
import type { ExtractResult } from './types';

/**
 * Clipboard paste. PLAN.md §7.1 ("paste").
 *
 * The plan's rule: prefer `text/html` over `text/plain`. Google Docs and lyrics sites put
 * real structure in the HTML flavour — one element per line — while their plain-text
 * flavour is often a single reflowed paragraph. Cheap, and a large accuracy win.
 *
 * This function takes the already-read flavours, not a `ClipboardEvent`: `src/core` may not
 * touch the DOM. The wrapper that calls `clipboardData.getData('text/html')` lives in the
 * UI layer.
 */

export interface PasteFlavors {
  /** `clipboardData.getData('text/html')`, or undefined when the flavour is absent. */
  html?: string | undefined;
  /** `clipboardData.getData('text/plain')`. */
  text?: string | undefined;
}

export function extractPaste(flavors: PasteFlavors): ExtractResult {
  const warnings: string[] = [];
  const html = flavors.html ?? '';
  const plain = flavors.text ?? '';

  if (html.trim() !== '') {
    const fromHtml = extractHtmlText(html);
    if (fromHtml.text.trim() !== '') {
      return {
        text: fromHtml.text,
        title: fromHtml.title,
        source: { format: 'paste', hasGeometry: false },
        warnings,
      };
    }
    // A markup-only clipboard flavour (images, an empty editor shell). Fall through.
    if (plain.trim() !== '') {
      warnings.push('The pasted formatting had no readable text, so the plain text was used.');
    }
  }

  return {
    text: normalizePlainText(plain),
    title: null,
    source: { format: 'paste', hasGeometry: false },
    warnings,
  };
}
