import type { ExtractResult } from './types';

/**
 * Plain-text extraction. PLAN.md §7.1 (".txt / .md").
 *
 * Byte-level decoding (BOM sniffing, `TextDecoder('utf-8', {fatal:true})` with a
 * windows-1252 fallback, the U+FFFD ratio check that opens the manual encoding picker)
 * belongs to the file-reading layer, which is the only layer that has the ArrayBuffer.
 * By the time text reaches core it is already a JS string; all that is left is the
 * BOM character and line endings.
 */

/**
 * The minimum normalisation every text-bearing extractor applies. Deliberately does NOT
 * collapse blank runs or rewrap — that is Stage 3 CLEAN (§7.3), which needs the sniff's
 * verdict first to know whether line breaks are semantic.
 */
export function normalizePlainText(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '\n')
    .replace(/\n$/, '');
}

/** "hamlet-act-3.txt" -> "hamlet act 3". Only a fallback when the content has no title. */
export function titleFromFileName(fileName: string | undefined): string | null {
  if (!fileName) return null;
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const pretty = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return pretty === '' ? null : pretty;
}

export function extractTxt(raw: string, fileName?: string): ExtractResult {
  return {
    text: normalizePlainText(raw),
    title: titleFromFileName(fileName),
    source: { format: 'txt', name: fileName, hasGeometry: false },
    warnings: [],
  };
}
