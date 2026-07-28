import { deriveDocument, PIPELINE_VERSION } from '../../core/text/derive';
import { extractHtml } from '../../core/text/extract/html';
import { extractMarkdown } from '../../core/text/extract/md';
import { extractPaste } from '../../core/text/extract/paste';
import { extractTxt } from '../../core/text/extract/txt';
import type { ExtractResult } from '../../core/text/extract/types';
import { DEFAULT_CLEANUP } from '../../core/text/types';
import { newId } from '../../core/util/id';
import { writeDerived } from '../../data/repos/derived';
import { createDocument, roleSetHashFor, sortTitleFor } from '../../data/repos/documents';
import type { DocumentRecord } from '../../data/schema';
import { requestPersistence } from '../../data/storageInfo';

/** Dispatch a picked file to the right extractor. PDF pulls pdf.js in lazily. */
export async function extractFile(file: File): Promise<ExtractResult> {
  const name = file.name;
  const lower = name.toLowerCase();

  if (lower.endsWith('.pdf') || file.type === 'application/pdf') {
    const [{ extractPdf }, { loadPdfSource }] = await Promise.all([
      import('../../core/text/extract/pdf'),
      import('./pdfLoader'),
    ]);
    const bytes = await file.arrayBuffer();
    return extractPdf(() => loadPdfSource(bytes), { name });
  }

  const text = await file.text();
  if (lower.endsWith('.html') || lower.endsWith('.htm') || file.type === 'text/html') {
    return extractHtml(text, name);
  }
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    return extractMarkdown(text, name);
  }
  return extractTxt(text, name);
}

/** The clipboard handler. HTML is preferred over plain text: it keeps line structure. */
export function extractClipboard(data: DataTransfer): ExtractResult {
  return extractPaste({
    html: data.getData('text/html') || undefined,
    text: data.getData('text/plain') || undefined,
  });
}

export interface SaveImportInput {
  text: string;
  title: string;
  source: DocumentRecord['source'];
  folderId?: string | null;
  hasGeometry?: boolean;
}

/**
 * Turn reviewed text into a saved document. The pipeline runs once here so the reader
 * opens instantly; `sourceText` is stored verbatim and stays the source of truth, and the
 * derived form is a cache that can be thrown away at any time.
 */
export async function saveImport(input: SaveImportInput): Promise<DocumentRecord> {
  const id = newId();
  const now = Date.now();

  const { doc, sniffed } = deriveDocument({
    id,
    sourceText: input.text,
    cleanupConfig: DEFAULT_CLEANUP,
    hasGeometry: input.hasGeometry ?? false,
  });

  const title = input.title.trim() || firstMeaningfulLine(input.text) || 'Untitled';

  const record = await createDocument(
    {
      folderId: input.folderId ?? null,
      title,
      sortTitle: sortTitleFor(title),
      kind: doc.kind,
      lang: doc.lang,
      textHash: '',
      pipelineVersion: PIPELINE_VERSION,
      wordCount: doc.wordCount,
      charCount: doc.charCount,
      chunkCount: doc.chunks.length,
      roles: doc.roles,
      myRoleIds: [],
      roleSetHash: roleSetHashFor([]),
      roleView: 'full',
      cueStyle: 'full',
      cueTailWords: 5,
      cleanupConfig: DEFAULT_CLEANUP,
      manualText: null,
      structureOverrides: [],
      prefs: {
        methodId: 'hideWords',
        ladderIndex: 0,
        customPercent: null,
        methodParams: {},
        reshuffle: 0,
        chunkStrategy: 'auto',
        chunkTargetWords: 0,
        manualChunkBreaks: [],
      },
      cursor: null,
      lastRunPeeks100: null,
      source: input.source,
      lastPracticedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      id,
    },
    input.text,
  );

  await writeDerived(id, PIPELINE_VERSION, record.textHash, doc, now);

  // Ask on first write rather than on boot: a persistence prompt before the user has
  // anything to lose is noise, and Safari grants it heuristically for installed apps.
  void requestPersistence();

  // `sniffed` is deliberately unused beyond the derived kind — kept so the review screen
  // can show what was detected without re-running the pipeline.
  void sniffed;
  return record;
}

function firstMeaningfulLine(text: string): string | null {
  for (const raw of text.split('\n', 20)) {
    const line = raw.trim();
    if (line.length >= 2) return line.slice(0, 80);
  }
  return null;
}
