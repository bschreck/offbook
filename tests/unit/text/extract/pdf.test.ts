import { describe, expect, it } from 'vitest';
import {
  assemblePageLines,
  assemblePdfText,
  extractPdf,
  MAX_PDF_PAGES,
  type PdfPage,
  type PdfTextItem,
} from '../../../../src/core/text/extract/pdf';

const SIZE = 12;
const LEFT = 72;

function item(str: string, x: number, y: number, size = SIZE): PdfTextItem {
  // Approximate advance width; only the ratio to `size` matters to the joiner.
  return { str, x, y, width: str.length * size * 0.5, size };
}

/** One text item per line, which is what pdf.js emits for a normal embedded font. */
function makePage(pageIndex: number, rows: Array<[number, string]>, x = LEFT): PdfPage {
  return { pageIndex, items: rows.map(([y, str]) => item(str, x, y)) };
}

function bodyRows(startY: number, lines: string[]): Array<[number, string]> {
  return lines.map((line, i) => [startY + i * 18, line] as [number, string]);
}

const LONG_BODY = (page: number): string[] => [
  `On page ${page} the speaker begins with a settled thought.`,
  `The argument on page ${page} widens to take in the whole room.`,
  `A second clause on page ${page} qualifies everything said before it.`,
  `Then page ${page} turns, as such speeches always turn, to the listener.`,
  `The peroration of page ${page} gathers the earlier images together.`,
  `And page ${page} closes on the plainest sentence in the passage.`,
];

describe('assemblePdfText — line assembly', () => {
  it('joins a hyphenated line break into one word', () => {
    const page = makePage(
      0,
      bodyRows(100, [
        'The company will con-',
        'tinue to expand into new markets across',
        'the region for the next several years to come.',
        'That is the plan the board has agreed upon here.',
      ]),
    );
    const { text, warnings } = assemblePdfText([page]);
    expect(text.split('\n')[0]).toBe('The company will continue to expand into new markets across');
    expect(warnings).toEqual([]);
  });

  it('leaves a real hyphenated compound alone when the next line starts a capital', () => {
    const page = makePage(
      0,
      bodyRows(100, [
        'They spoke of the Anglo-',
        'Saxon chronicle at some considerable length that day.',
        'Nobody in that long room disagreed with a single word.',
        'The meeting ended, as all such meetings end, in silence.',
      ]),
    );
    const lines = assemblePdfText([page]).text.split('\n');
    expect(lines[0]).toBe('They spoke of the Anglo-');
    expect(lines[1]).toBe('Saxon chronicle at some considerable length that day.');
  });

  it('reconstructs a blank line from an oversized vertical gap', () => {
    const page = makePage(0, [
      [100, 'First stanza line one'],
      [118, 'First stanza line two'],
      [200, 'Second stanza line one'],
      [218, 'Second stanza line two'],
    ]);
    expect(assemblePageLines(page).map((l) => l.text)).toEqual([
      'First stanza line one',
      'First stanza line two',
      '',
      'Second stanza line one',
      'Second stanza line two',
    ]);
  });

  it('joins items in a y-cluster with a space, a tab or nothing according to the gap', () => {
    const page: PdfPage = {
      pageIndex: 0,
      items: [
        { str: 'HELLO', x: 72, y: 100, width: 30, size: SIZE },
        { str: 'there', x: 108, y: 100.2, width: 25, size: SIZE }, // 6pt gap -> space
        { str: 'FAR', x: 240, y: 99.9, width: 18, size: SIZE }, // 107pt gap -> tab
        { str: 'wo', x: 72, y: 118, width: 12, size: SIZE },
        { str: 'rd', x: 84, y: 118, width: 12, size: SIZE }, // 0pt gap -> no separator
      ],
    };
    expect(assemblePageLines(page).map((l) => l.text)).toEqual(['HELLO there\tFAR', 'word']);
  });

  it('applies the tracking guard so a letter-spaced title is not one-letter tokens', () => {
    const chars = [...'THETEMPEST'];
    const page: PdfPage = {
      pageIndex: 0,
      items: chars.map((c, i) => ({ str: c, x: 100 + i * 12, y: 60, width: 8, size: 20 })),
    };
    const [line] = assemblePageLines(page);
    expect(line?.text).toBe('THETEMPEST');
    expect(line?.letterSpaced).toBe(true);
  });

  it('records geometry, so the cue detector knows it can trust indentation', () => {
    const { source } = assemblePdfText([makePage(0, bodyRows(100, LONG_BODY(1)))]);
    expect(source.hasGeometry).toBe(true);
    expect(source.pageCount).toBe(1);
    expect(source.format).toBe('pdf');
  });
});

describe('assemblePdfText — artifact removal', () => {
  const pages = [0, 1, 2].map((p) =>
    makePage(p, [
      [40, 'HAMLET — Prince of Denmark'],
      ...bodyRows(100, LONG_BODY(p + 1)),
      [700, `${12 + p}`],
    ]),
  );

  it('drops a running header repeated on every page', () => {
    const { text } = assemblePdfText(pages);
    expect(text).not.toContain('Prince of Denmark');
  });

  it('drops page-number lines', () => {
    const { text } = assemblePdfText(pages);
    for (const line of text.split('\n')) {
      expect(line).not.toMatch(/^\d+$/);
    }
  });

  it('keeps the body of every page', () => {
    const { text } = assemblePdfText(pages);
    for (const page of [1, 2, 3]) {
      expect(text).toContain(`On page ${page} the speaker begins`);
    }
  });

  it('drops a standalone (CONT’D) but keeps it as a cue suffix', () => {
    const page = makePage(0, [
      ...bodyRows(100, LONG_BODY(1)),
      [220, "(CONT'D)"],
      [238, "MARY (CONT'D)"],
      [256, 'Every word of that was true.'],
    ]);
    const lines = assemblePdfText([page]).text.split('\n');
    expect(lines).not.toContain("(CONT'D)");
    expect(lines).toContain("MARY (CONT'D)");
  });

  it('does not drop a repeated line when the document is only two pages', () => {
    const short = [0, 1].map((p) =>
      makePage(p, [[40, 'A REPEATED TITLE'], ...bodyRows(100, LONG_BODY(p + 1))]),
    );
    expect(assemblePdfText(short).text).toContain('A REPEATED TITLE');
  });
});

describe('assemblePdfText — scanned detection', () => {
  it('warns about a near-empty page among readable ones', () => {
    const pages = [
      makePage(0, bodyRows(100, LONG_BODY(1))),
      makePage(1, bodyRows(100, LONG_BODY(2))),
      makePage(2, [[100, 'iii']]),
    ];
    const { warnings, source } = assemblePdfText(pages);
    expect(source.likelyScanned).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/scan/i);
    expect(warnings[0]).toContain('3');
  });

  it('flags a whole document with near-zero text yield as a scan', () => {
    const pages = [0, 1, 2].map((p) => makePage(p, [[100, 'ii']]));
    const { warnings, source, text } = assemblePdfText(pages);
    expect(source.likelyScanned).toBe(true);
    expect(warnings.join(' ')).toMatch(/scan/i);
    expect(text).toBe('ii\nii\nii');
  });

  it('does not divide by zero on a zero-page document', () => {
    expect(assemblePdfText([])).toEqual({
      text: '',
      title: null,
      source: {
        format: 'pdf',
        name: undefined,
        pageCount: 0,
        hasGeometry: true,
        likelyScanned: false,
      },
      warnings: [],
    });
  });
});

describe('extractPdf', () => {
  it('drives an injected loader page by page and reports progress', async () => {
    const seen: number[] = [];
    const progress: Array<[number, number]> = [];
    const result = await extractPdf(
      async () => ({
        pageCount: 2,
        title: 'A Midsummer Night’s Dream',
        getPageItems: async (i) => {
          seen.push(i);
          return makePage(i, bodyRows(100, LONG_BODY(i + 1))).items;
        },
      }),
      { name: 'dream.pdf', onProgress: (done, total) => progress.push([done, total]) },
    );

    expect(seen).toEqual([0, 1]);
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(result.title).toBe('A Midsummer Night’s Dream');
    expect(result.source.name).toBe('dream.pdf');
    expect(result.text).toContain('On page 2 the speaker begins');
  });

  it('caps at MAX_PDF_PAGES and says so', async () => {
    let pagesRead = 0;
    const result = await extractPdf(async () => ({
      pageCount: MAX_PDF_PAGES + 5,
      getPageItems: async (i) => {
        pagesRead++;
        return makePage(i, [[100, `Body text for page ${i + 1} here.`]]).items;
      },
    }));
    expect(pagesRead).toBe(MAX_PDF_PAGES);
    expect(result.source.pageCount).toBe(MAX_PDF_PAGES + 5);
    expect(result.warnings[0]).toContain(String(MAX_PDF_PAGES));
  });

  it('falls back to the file name when the PDF carries no metadata title', async () => {
    const result = await extractPdf(
      async () => ({
        pageCount: 1,
        getPageItems: async () => makePage(0, bodyRows(100, LONG_BODY(1))).items,
      }),
      { name: 'julius-caesar_act-3.pdf' },
    );
    expect(result.title).toBe('julius caesar act 3');
  });
});
