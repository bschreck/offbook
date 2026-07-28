import type { PdfSource, PdfTextItem } from '../../core/text/extract/pdf';

/**
 * The pdf.js half of PDF import. Lives here, not in `src/core`, so that `src/core` stays
 * pure and pdf.js stays out of the first-load bundle — it is imported only when someone
 * actually picks a PDF (§4, dependency budget).
 */
export async function loadPdfSource(bytes: ArrayBuffer): Promise<PdfSource> {
  const pdfjs = await import('pdfjs-dist');
  const workerSrc = (await import('pdfjs-dist/build/pdf.worker.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const meta = await doc.getMetadata().catch(() => null);
  const info = meta?.info as { Title?: string } | undefined;

  return {
    pageCount: doc.numPages,
    title: info?.Title?.trim() || null,
    async getPageItems(pageIndex: number): Promise<PdfTextItem[]> {
      const page = await doc.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const tx = item.transform as number[];
        items.push({
          str: item.str,
          x: tx[4] ?? 0,
          // pdf.js origin is bottom-left; flip so y increases DOWNWARD, which is the order
          // the line assembler expects.
          y: viewport.height - (tx[5] ?? 0),
          width: item.width ?? 0,
          // Effective font size from the text matrix, falling back to the reported height.
          size: Math.hypot(tx[1] ?? 0, tx[3] ?? 0) || item.height || 0,
        });
      }
      page.cleanup();
      return items;
    },
  };
}
