# MemoCoach clone — Text Ingestion & Structuring Pipeline

**Scope:** everything between "the user has a script somewhere" and "the app holds an immutable token
model it can mask." Masking algorithms, practice scheduling, UI shell and storage sync are *out of
scope* — but this document defines the contract they consume.

**Constraints assumed:** free to run, free to use, no server, no account, local-first (IndexedDB),
installable PWA, offline-capable, mobile-first, buildable by one dev + Claude Code in a few sessions.
Everything below is client-side. There is no ingestion server anywhere in this design.

**Stack assumption:** Vite + TypeScript, framework-agnostic core (the pipeline is pure TS with zero
framework imports), Vitest for tests, Web Workers for anything over ~30 ms.

---

## 0. Architecture at a glance

The whole pipeline is a chain of pure functions over three intermediate representations. This is the
single most important structural decision in the document, because it lets us test every stage in
isolation and swap importers without touching structure detection.

```
                                    ┌──────────────────────────────────────┐
  file / paste / photo  ──────────►  │  1. EXTRACT  (per-format adapters)   │
                                    └──────────────────┬───────────────────┘
                                                       ▼
                                            RawLine[]  ◄── the IR (see §1.0)
                                                       │
                                    ┌──────────────────┴───────────────────┐
                                    │  2. SNIFF  (document type + lang)    │
                                    └──────────────────┬───────────────────┘
                                                       ▼
                                    ┌──────────────────────────────────────┐
                                    │  3. CLEAN  (ordered, toggleable      │
                                    │     rules; preset chosen by sniff)   │
                                    └──────────────────┬───────────────────┘
                                                       ▼
                                            RawLine[]  (cleaned)
                                                       │
                                    ┌──────────────────┴───────────────────┐
                                    │  4. STRUCTURE  (blocks + speakers,   │
                                    │     two-pass, confidence-scored)     │
                                    └──────────────────┬───────────────────┘
                                                       ▼
                                    ┌──────────────────────────────────────┐
                                    │  5. TOKENIZE  (flat immutable array) │
                                    └──────────────────┬───────────────────┘
                                                       ▼
                                    ┌──────────────────────────────────────┐
                                    │  6. CHUNK  (practice units)          │
                                    └──────────────────┬───────────────────┘
                                                       ▼
                                        Document  (immutable, revisioned)
                                                       │
                                    ┌──────────────────┴───────────────────┐
                                    │  MaskState overlay  (mutable, cheap) │
                                    └──────────────────────────────────────┘
```

Two rules that make the whole thing work:

1. **`sourceText` (or the source file bytes) is kept forever and never mutated.** Everything after it
   is derived. Cleanup and structure are stored as a *recipe* (`cleanupConfig` + `structureOverrides`),
   not just a result, so the user can always change a decision and re-derive. The materialized
   `Document` is a cache with a deterministic derivation — this is what makes "undo" free (§2.6).
2. **Geometry and formatting hints survive extraction.** A PDF's x-indent and a DOCX's paragraph
   style name are the *best* signals for detecting screenplay structure. Most naive pipelines throw
   them away at `file → string` and then try to recover structure from plain text. We refuse to. The
   `RawLine` IR carries them.

### Proposed file layout

```
src/ingest/
  types.ts                 RawLine, ExtractResult, ImportWarning
  index.ts                 importFile(), importPaste()  — the only public entry points
  extract/
    text.ts                .txt (+ encoding sniff)
    markdown.ts            .md
    html.ts                .html (DOMParser)
    rtf.ts                 .rtf (hand-rolled)
    docx.ts                .docx (fflate + DOMParser)
    pdf.ts                 .pdf (pdfjs-dist, in a worker)
    ocr.ts                 images / scanned PDF (tesseract.js, lazy)
    fountain.ts            Fountain source → blocks directly (bypasses heuristics)
  clean/
    rules/*.ts             one file per rule, each RawLine[] -> RawLine[]
    pipeline.ts            ordering, presets, per-rule stats
  structure/
    sniff.ts               document-type + language detection
    screenplay.ts          Hollywood / NAME: / stage play
    lyrics.ts              verse/chorus, repeat detection
    prose.ts               paragraphs, speeches
    overrides.ts           stable line fingerprints + user corrections
  tokenize/
    tokenizer.ts
    functionWords.ts
  chunk/
    chunker.ts
  model/
    document.ts            Document, Block, Line, Token, Speaker
    mask.ts                MaskState overlay (consumed by the practice engine)
test/fixtures/             the golden corpus (see §8)
```

---

## 1. IMPORT

### 1.0 The `RawLine` IR

Every extractor produces this and nothing else. Structure detection never sees a `File`, a PDF, or a
DOM node.

```ts
type RawLine = {
  text: string;              // one visual/logical line, no trailing newline
  // ── geometry / formatting hints, all optional ──
  indentPt?: number;         // left edge in points (PDF x, DOCX w:ind, tab count × 36)
  fontSizePt?: number;
  bold?: boolean;
  italic?: boolean;
  styleName?: string;        // DOCX w:pStyle → "Character", "Dialogue", "Parenthetical", ...
  alignment?: 'left' | 'center' | 'right';
  pageIndex?: number;        // PDF/OCR page
  yPt?: number;              // PDF baseline, for header/footer + column work
  columnIndex?: number;      // set by column detection
  // ── provenance ──
  srcIndex: number;          // index in the pre-cleanup line array; stable for diffing
};

type ExtractResult = {
  lines: RawLine[];
  meta: {
    format: 'paste'|'txt'|'md'|'html'|'rtf'|'docx'|'pdf'|'image'|'fountain';
    title?: string;          // PDF /Title, DOCX core.xml, HTML <title>, MD first H1
    pageCount?: number;
    encoding?: string;
    hasGeometry: boolean;    // did we get indentPt? drives structure-detection confidence
    likelyScanned?: boolean;
  };
  warnings: ImportWarning[]; // surfaced in the review step, never thrown away
};
```

`hasGeometry` is load-bearing: the screenplay detector gets a large confidence boost when it can see
indentation, and falls back to purely lexical rules when it can't.

### 1.1 Format matrix

Sizes are order-of-magnitude estimates for planning only — **verify with
`npx vite-bundle-visualizer` once real code exists**, and treat any number here as ±40%.

| Format | Approach | Library | Added JS (min+gz) | Lazy? | Tier |
|---|---|---|---|---|---|
| **paste** | `<textarea>`, split on `/\r\n?|\n/` | none | 0 | — | **MVP** |
| **.txt** | `File.arrayBuffer()` + encoding sniff (§1.2) | none (`TextDecoder`) | ~1 KB | no | **MVP** |
| **.md** | read as text, then hand-rolled markdown *stripper* (§1.3) | none | ~2 KB | no | **MVP** |
| **.html** | `new DOMParser().parseFromString(s,'text/html')` + block walker | none (native) | ~2.5 KB | no | **MVP** |
| **.pdf** | text layer via `getTextContent`, geometry reconstruction (§1.6) | `pdfjs-dist` | ~120 KB main + ~550 KB worker | **yes** | **MVP** |
| **.fountain / .spmd** | direct parse to blocks, no heuristics | none (own subset parser) | ~5 KB | no | **MVP** (cheap, high value) |
| **.rtf** | hand-rolled RTF token stripper (§1.4) | none | ~3 KB | yes | v1.1 |
| **.docx** | unzip → `word/document.xml` → own walker (§1.5) | `fflate` (unzip only) | ~4 KB + ~4 KB fflate | **yes** | v1.1 |
| **photo / scan** | OS text-scanner handoff (MVP), `tesseract.js` (opt-in) | `tesseract.js` | ~60 KB JS + **~2–4 MB wasm + ~4–15 MB model** | **yes, consented** | v1.2 |
| .doc (binary), .pages, .fdx, .celtx | out of scope — tell the user to export | — | — | — | never |

**MVP recommendation: paste, .txt, .md, .html, .pdf, .fountain.** That covers, in practice, ~90% of
real scripts and lyrics: PDF is what casting/production actually emails, paste is what people do with
lyrics sites and Google Docs, and Fountain is a free win because we need its parser anyway as the
manual-correction format (§4.9). DOCX and RTF are each an afternoon; OCR is a whole feature with a
multi-megabyte download attached and should wait until the core practice loop is good.

**Why *not* `mammoth` for DOCX.** `mammoth.browser.js` is ~150 KB gz and its entire job is producing
*semantic HTML* — it deliberately discards direct formatting, including `w:ind` indentation, which is
exactly the signal we need to tell a character cue from an action line in a Final-Draft-exported
DOCX. We'd pay 150 KB to be given *less* information than the raw XML has. Instead: `fflate.unzipSync`
(unzip-only entry point, ~4 KB gz) → `DOMParser` on `word/document.xml` → walk `w:p`/`w:r`/`w:t`. That
is genuinely ~150 lines and it's better for us. `JSZip` (~28 KB gz) is the fallback if fflate's sync
API annoys us on large files.

**Why *not* an npm RTF parser.** `rtf-parser` (iarna) and `rtf-stream-parser` (mazira) are both built
on Node `Buffer` + `stream.Transform` and need polyfilling to run in a browser. RTF-to-*plain-text* is
a genuinely small problem (§1.4). Write it.

**Why *not* `fountain-js`.** Unmaintained (~3 years), CommonJS, and it emits pre-rendered HTML rather
than a structure we can map to our block model. We want ~200 lines that emit `Block[]` directly.

### 1.2 Encoding detection (.txt, .rtf, .html)

1. Strip BOM: `EF BB BF` → UTF-8, `FF FE`/`FE FF` → UTF-16LE/BE, decode accordingly.
2. No BOM: `new TextDecoder('utf-8', { fatal: true }).decode(buf)` inside try/catch. Success → UTF-8.
3. On throw: `TextDecoder('windows-1252')` (superset of Latin-1, covers the smart quotes that Word
   emits as `0x91–0x94`). Record `warnings.push({code:'encoding-guessed', encoding:'windows-1252'})`.
4. Sanity check the result: if `>2%` of characters are U+FFFD or in C1 (`0x80–0x9F`), show a manual
   encoding picker (utf-8, windows-1252, iso-8859-1/2/15, macintosh, windows-1251, shift_jis, gb18030)
   with a live preview of the first 400 chars. This is a 30-line component and it saves the one user
   in fifty whose script is a 2009 Cyrillic .txt from a director.

### 1.3 Markdown

We are flattening to rehearsal text, not rendering. Do **not** pull in `marked`/`markdown-it`. A
stripper that runs line-by-line:

- Fenced code blocks (```` ``` ````, `~~~`) → drop entirely (never rehearsal material), warn if >20% of
  the doc was dropped.
- ATX headings `^#{1,6}\s+(.*)` → `RawLine{ text: $1, styleName:'Heading'+level }`.
- Setext headings (`===`/`---` underlines) → heading, drop the underline line.
- Blockquote `^>\s?` → strip marker, set `indentPt: 36 × depth` (a `>` block in a lyric paste is often
  a quoted verse, and the indent hint helps).
- List markers `^\s*([-*+]|\d+[.)])\s+` → strip marker, keep `indentPt` from leading spaces.
- Thematic break `^(\*{3,}|-{3,}|_{3,})$` → emit a `marker` line (becomes a user chunk boundary, §6).
- Inline: `**b**`/`__b__` → text + `bold:true` if the *whole* line is bold; `*i*`/`_i_` → `italic`
  (whole-line italic is a strong stage-direction signal); `` `c` `` → text; `[t](u)` → `t`;
  `![alt](u)` → drop; `~~s~~` → drop the text (struck lines are cut lines — that's the author's intent).
- HTML blocks inside MD → route the fragment through the HTML extractor.
- Escapes: `\*` → `*` last.
- Tables: emit each row's cells joined by " — ". Rare; don't over-invest.

### 1.4 RTF (hand-rolled, ~200 lines)

A single-pass state machine over the string. Not a real RTF renderer — a text extractor.

- Tokens: `{`, `}`, `\word[-]?[0-9]*` (optional trailing space consumed), `\'hh`, `\\`/`\{`/`\}`
  literals, plain text runs.
- Group stack holds `{ ucSkip, codepage, ignoreDest }`.
- **Skip destinations:** on `{\*` → mark the group `ignoreDest` and consume it entirely. Also skip
  known non-content destinations by name: `fonttbl colortbl stylesheet info pict object themedata
  colorschememapping datastore latentstyles listtable listoverridetable rsidtbl generator xmlnstbl
  mmathPr`. This alone removes ~90% of an RTF file.
- **Text-emitting control words:** `\par`/`\pard`→ line break, `\line`→ line break, `\tab`→ `\t`
  (converted to `indentPt` later), `\page`/`\sect`→ break + page increment,
  `\emdash \endash \lquote \rquote \ldblquote \rdblquote \bullet \~ \_ \-` → their characters
  (`\-` is a soft hyphen → emit U+00AD so de-hyphenation can eat it).
- **Unicode:** `\uN` emits `String.fromCodePoint(N < 0 ? N + 65536 : N)`, then skip the next `ucSkip`
  (default 1, set by `\ucN`) *characters or `\'hh` escapes* — the classic bug is skipping bytes
  instead of escape-units. Test this explicitly.
- **`\'hh`** → byte, decoded with the current `\ansicpgNNNN` codepage via `TextDecoder`
  (`windows-1252` default; map 1250/1251/1253/1254/1257/932/936/949/950).
- **Formatting hints we keep:** `\b`/`\b0`, `\i`/`\i0`, `\fsN` (half-points → `fontSizePt = N/2`),
  `\liN`/`\fiN` (twips → `indentPt = N/20`), `\qc` → `alignment:'center'`. These make RTF exports from
  Final Draft and Celtx structure-detectable, which is the whole reason RTF is worth supporting.
- Hard cap: refuse files >20 MB with a clear message rather than hanging.

### 1.5 DOCX (fflate + DOMParser, ~150 lines)

```
unzipSync(bytes) → {
  'word/document.xml'   : the content
  'word/styles.xml'     : styleId → style *name* (Final Draft/Fade In write "Character",
                          "Dialogue", "Parenthetical", "Scene Heading", "Action", "Transition")
  'docProps/core.xml'   : dc:title → meta.title
  'word/numbering.xml'  : (optional) list numbering, mostly ignorable
}
```

Walk `w:body`:

- `w:p` → one `RawLine` (a paragraph is a logical line; Word's soft wrapping is invisible to us,
  which is *ideal*).
- Text = concatenation of `w:t` (respect `xml:space="preserve"`), plus `w:tab` → `\t`,
  `w:br` → **split into another `RawLine` sharing the paragraph's properties** (a `w:br` inside a
  dialogue paragraph is a semantic line break in lyrics; treat it as one).
- `w:pPr/w:pStyle/@w:val` → resolve through `styles.xml` to `styleName`. **If ≥40% of paragraphs carry
  recognizable screenplay style names, skip heuristic detection entirely and trust the styles** — a
  perfect-confidence path that costs 20 lines. Same for `w:pStyle` = "Heading1..6".
- `w:pPr/w:ind/@w:left` and `@w:firstLine` (twips) → `indentPt = (left + firstLine)/20`.
- `w:pPr/w:jc/@w:val` → alignment. Centered short all-caps lines are titles/scene markers.
- Run properties on the *first* run, or on `w:pPr/w:rPr`: `w:b` → bold, `w:i` → italic,
  `w:sz` (half-points) → fontSizePt, `w:caps`/`w:smallCaps` → **treat as ALL-CAPS for cue detection
  even though `w:t` holds mixed case** (small-caps character names are common in stage plays and are
  otherwise undetectable).
- `w:tbl` → flatten rows; **a 2-column table whose cells both contain a cue-like first paragraph is
  dual dialogue** (§4.6).
- Skip `w:del` (tracked deletions), keep `w:ins`; skip `w:footnote`/`w:endnote` refs but collect the
  notes into an appendix block flagged `ignored` (footnotes in academic texts are noise, but a user
  memorizing a lecture may want them — make it a toggle).
- Empty `w:p` → an empty `RawLine`, because blank lines are our paragraph/verse separator.

### 1.6 PDF — the hard one

This is where most of the engineering risk lives. Budget a full session for it.

#### 1.6.1 Setup

```ts
// lazy: import() only when a .pdf is chosen
const pdfjs = await import('pdfjs-dist');
pdfjs.GlobalWorkerOptions.workerPort = new Worker(
  new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), { type: 'module' }
);
const doc = await pdfjs.getDocument({
  data,
  isEvalSupported: false,     // no eval — keeps a strict CSP possible
  disableFontFace: true,      // we never render glyphs, only read text
  useSystemFonts: false,
  standardFontDataUrl: undefined,  // ~1 MB we don't need for text
  cMapUrl: '/cmaps/', cMapPacked: true, // ONLY ship this if we support CJK PDFs (~1.3 MB static)
}).promise;
```

Notes: use the `legacy/` build only if we discover a target browser lacking modern syntax — on
current iOS/Android Safari and Chrome the modern build is fine, and the legacy build is meaningfully
larger. Run the *whole* PDF extraction inside our own worker too (not just pdf.js's), so the main
thread never stalls on a 120-page script; report progress per page. Handle `PasswordException` by
prompting (owner-password-only PDFs open with an empty user password, which covers most "protected"
scripts). Cap at ~400 pages / 100 MB with a clear message.

#### 1.6.2 Text layer → lines

`page.getTextContent()` yields items shaped roughly
`{ str, dir, width, height, transform: [a,b,c,d,e,f], fontName, hasEOL }`. `transform[4]`/`[5]` are
x/y in *PDF user space* (y increases upward). **Do not use the raw transform** — compose it with the
viewport so page `/Rotate` and flipped coordinate systems are normalized:

```ts
const vp = page.getViewport({ scale: 1 });
const m  = pdfjs.Util.transform(vp.transform, item.transform);
const x = m[4], y = m[5];                    // device space, y increases downward
const size = Math.hypot(m[1], m[3]) || item.height;   // effective font size
const rotatedText = Math.abs(m[1]) > 0.3 * Math.abs(m[0]);  // rotated run → likely a watermark
```

Line reconstruction — **cluster by y, don't trust `hasEOL`**. `hasEOL` reflects the content stream's
`Td`/`TJ` layout, which for two-column and table PDFs fires mid-line:

1. Drop items where `str.trim() === ''` but remember them as gap evidence; drop `rotatedText` items
   into a `warnings` bucket ("possible watermark/stamp ignored: 'DO NOT DISTRIBUTE'").
2. `tol = 0.35 × median(size)`. Sort items by `y`, then greedily group into clusters where
   `|y − clusterMeanY| < tol`. Update the mean incrementally so slightly-sloped baselines still group.
3. Within a cluster, sort by `x` ascending (for RTL pages, `item.dir === 'rtl'` → the *visual* order is
   still x-ascending; keep logical order as pdf.js gives it and let CSS bidi handle display).
4. Join: insert `' '` between consecutive items when
   `nextX − (prevX + prevWidth) > 0.22 × size` and neither side already has a boundary space.
   Insert nothing when the gap is ~0 (kerned glyph runs — pdf.js often emits one item per glyph for
   subsetted fonts). Insert `'\t'` when the gap is `> 2.5 × size` — that's a column/tab, and preserving
   it lets §1.6.4 find columns and §1.5-style indent logic work.
5. Emit `RawLine{ text, indentPt: firstItemX, fontSizePt: median(size), yPt: clusterMeanY,
   pageIndex, bold: /bold|black|semibold/i.test(fontName) }`.
6. Blank-line reconstruction: if `clusterY[i] − clusterY[i−1] > 1.6 × medianLineGap`, emit an empty
   `RawLine` — this recovers the paragraph/verse/speech separations that carry most of the structure.

`indentPt` from step 5 is the payload. In a standard US screenplay, action starts at 1.5", character
cues at 3.7", parentheticals at 3.1", dialogue at 2.5". After extraction, cluster all `indentPt`
values (1-D k-means with k=3..6, or just a histogram with 6 pt bins) and label the clusters by
frequency and by what follows them. This gives near-perfect cue detection on any properly formatted
PDF and is the reason PDF is *easier* than plain paste, not harder.

#### 1.6.3 Headers, footers, page numbers, revision marks

Run after all pages are extracted, before de-hyphenation:

1. **Zone candidates:** lines with `yPt < 0.08 × pageHeight` or `> 0.92 × pageHeight`, plus the first
   and last non-empty line of each page regardless of position.
2. **Normalize** each candidate: lowercase, collapse whitespace, `\d+` → `#`, strip punctuation.
3. **Repeat test:** drop the line if its normalized form appears on `≥ max(3, 0.6 × pageCount)` pages.
   Handles "SCRIPT TITLE — Second Draft", "Confidential", "smith_pilot_v4.fdx", "page # of #".
4. **Always-drop patterns** (any page position):
   `^\(?(page\s*)?\d{1,4}(\s*of\s*\d{1,4})?\)?\.?$`, `^\d{1,3}[a-z]?\.$` (screenplay page numbers),
   `^\(?(MORE|CONTINUED|CONT'?D)\)?\.?$`, `^\(CONTINUED\)$`,
   `^(Rev\.?|Revised)\s+\d`, `^[A-Z]{1,3}-\d+$` (revision marks), `^\*+$`.
5. **Careful exception:** `MARY (CONT'D)` is a *cue*, not a footer. Only drop the marker when it is the
   **entire** line. When it is a suffix on a cue, strip the suffix and set
   `speakerVariant:'continued'` so the cue merges into the same speaker (§4.7).
6. **Scene numbers** in the left/right margins (`indentPt` far below body indent, content matches
   `^\d{1,3}[A-Z]?$`, same y as a scene heading) → attach to the heading, don't emit as a line.
7. Report every drop in `warnings` with a "restore" affordance in the review step. Never delete
   silently — a user memorizing a liturgy might *want* the running header.

#### 1.6.4 Column detection

Screenplays are single-column; lyric sheets, hymnals, programmes and academic PDFs are not. Detect
**per page**, not per document:

1. Build an x-coverage histogram in 4 pt bins from every item's `[x, x+width]` interval, weighted by
   nothing (presence only).
2. Find maximal runs of zero-coverage bins ("gutters") whose width `≥ 5% of pageWidth` and whose
   centre lies within the middle 50% of the *inked* x-range (ignore the page margins, which are also
   zero-coverage).
3. Accept the gutter only if: coverage on each side `≥ 20%` of the total inked width, **and** `≥ 70%`
   of lines lie wholly on one side of it, **and** the page has `≥ 12` lines. Otherwise it's a
   coincidental alignment (a screenplay's dialogue column creates a fake gutter — the "wholly on one
   side" test kills it, because action lines cross the gutter).
4. On acceptance: partition lines by side, emit left column fully then right column, and set
   `columnIndex`. Emit a `warnings` entry `{code:'columns-detected', pageIndex, n:2}` with a "this
   page was actually one column" undo, because getting it wrong scrambles the text badly.
5. Recurse once for 3-column pages (rare). Never more.
6. **Local exception — dual dialogue.** Two cue-like lines in the *same* y-cluster with a big x gap,
   over a run of 2–20 lines, inside an otherwise single-column page, is simultaneous dialogue. Handle
   it in the structurer (§4.6) as a `dual` block, not as page-wide columns.

#### 1.6.5 Hyphenation at line breaks

See §2.4 — the rule is shared with hard-wrapped text, but PDFs are where it actually fires (justified
body text with automatic hyphenation).

#### 1.6.6 Scanned / image-only / broken-encoding PDFs

Three distinct failure modes; detect all three before offering OCR.

| Mode | Detection | Action |
|---|---|---|
| **No text layer** | `alphanumericChars / pageCount < 100`, or `getTextContent` returns 0 items on ≥80% of pages | offer OCR path |
| **Partial text layer** | some pages pass, some fail (mixed scan + digital) | extract good pages, OCR only the failing ones, keep page order |
| **Broken `/ToUnicode`** | text extracts but is gibberish: `>15%` of chars in U+E000–U+F8FF (Private Use), or a "gibberish score" fails — vowel ratio outside 0.15–0.65, or `<10%` of extracted words hit a 200-word stoplist for the detected language | treat as image-only; **do not** show the garbage to the user beyond a sample |

OCR path, in priority order:

1. **MVP (zero bytes shipped): OS handoff.** Show: "This PDF is a scan. The fastest free fix: open it
   in Files/Photos, use Live Text (iOS) or Google Lens (Android) or Preview's text selection (macOS),
   copy, and paste here." Include a "Paste scanned text" button. This is genuinely faster and more
   accurate than tesseract.js on a phone, costs us nothing, and needs no download. Ship this first.
2. **v1.2: in-app OCR.** Render each failing page to a canvas at
   `scale = clamp(2200 / viewport.width, 1.5, 4)` (target ~200–300 DPI equivalent; tesseract is very
   sensitive to input resolution), grayscale + light contrast stretch, then `tesseract.js`.
   - Gate behind an explicit consent dialog naming the download size, because
     `tesseract-core*.wasm` (~2–4 MB) plus a language model (**`tessdata_fast` eng ≈ 4 MB raw /
     ~1.5 MB gz**; the standard `eng.traineddata` is ~15 MB — use *fast*, the accuracy delta on clean
     scans is small) is a lot on cellular. Cache in Cache Storage / IndexedDB so it's once-ever.
   - Self-host the wasm + `.traineddata` from our own origin (`workerPath`, `corePath`, `langPath`) so
     the app stays offline-capable and doesn't depend on a CDN staying free forever.
   - Use `tesseract.js`'s block/paragraph/word output (`{ blocks: [{ paragraphs: [{ lines: [{ words }]}]}]}`)
     rather than the plain `text`, so we get bounding boxes → real `indentPt` → structure detection
     still works on scans. This is worth the extra code.
   - Show mean word confidence; flag lines with `confidence < 60` in the cleanup editor with a
     highlight so the user proofreads exactly the risky words. OCR always needs proofreading; the
     honest UX is to make proofreading fast, not to pretend it's perfect.
3. Same pipeline serves **photo import** (`accept="image/*" capture="environment"`), plus deskew: if
   the mean text-line angle from the boxes exceeds 1.5°, rotate the canvas and re-run once.

### 1.7 Getting files in (PWA affordances, all free)

- `<input type="file" multiple accept=".txt,.md,.rtf,.html,.pdf,.docx,.fountain,image/*">`
- Drag-and-drop on desktop (`dragover`/`drop`, read `DataTransfer.items`).
- **Paste anything:** a paste handler that inspects `ClipboardEvent.clipboardData` — `text/html`
  first (Google Docs and Genius put rich structure there, including bold/italic that reveals stage
  directions), falling back to `text/plain`, and `items` of kind `file` for pasted screenshots.
  Preferring `text/html` on paste is a cheap, large accuracy win most apps miss.
- **Web Share Target** in the manifest, so iOS/Android "Share → MemoCoach" works on a PDF from Mail
  or Files:
  ```json
  "share_target": { "action": "/import", "method": "POST", "enctype": "multipart/form-data",
    "params": { "title": "title", "text": "text",
      "files": [{ "name": "file", "accept": ["application/pdf","text/plain","text/html",
        ".docx",".rtf",".md","image/*"] }] } }
  ```
  Handled entirely in the service worker + client — no server. This is the single highest-value
  ingestion feature for a rehearsal app, because scripts arrive as email attachments.
- **File Handling API** (`"file_handlers"` in the manifest + `launchQueue.setConsumer`) so the app can
  be the default opener for `.fountain`/`.txt` on desktop Chromium. Progressive enhancement.

---

## 2. CLEANUP

### 2.0 Design

An ordered list of named rules, each `(lines: RawLine[], ctx) => { lines, changed: number, notes[] }`,
pure and independently testable. The pipeline is described by a serializable config:

```ts
type CleanupConfig = {
  preset: 'screenplay'|'stagePlay'|'lyrics'|'prose'|'speech'|'raw';
  rules: Record<RuleId, boolean | RuleOptions>;
  manualEdits: LineEdit[];   // applied last, keyed by line fingerprint (§2.6)
};
```

Order matters and is fixed (the config toggles rules on/off, it doesn't reorder them):

| # | Rule | Default on for | Notes |
|---|---|---|---|
| 1 | `decodeNormalize` | all | NFC + ligature/punct maps |
| 2 | `stripInvisibles` | all | zero-width, soft hyphen bookkeeping |
| 3 | `normalizeWhitespace` | all | tabs → `indentPt` first, then collapse |
| 4 | `normalizePunctuation` | all | smart quotes, dashes, ellipses |
| 5 | `dropRunningHeaders` | pdf only | §1.6.3 |
| 6 | `removeLineNumbers` | all (guarded) | needs the monotonic test |
| 7 | `stripScrapeJunk` | lyrics, prose | Genius/AZ/Wikipedia artifacts |
| 8 | `dehyphenate` | all | §2.4 |
| 9 | `unwrapHardBreaks` | prose, speech **only** | destroys lyrics/verse — never default-on there |
| 10 | `collapseBlankRuns` | all | 3+ → 1 |
| 11 | `trimDocument` | all | leading/trailing blanks |
| 12 | `applyManualEdits` | all | last, always |

The preset is chosen by the **type sniff** (§4.1), which therefore has to run *before* cleanup. This
resolves the ordering paradox: `unwrapHardBreaks` needs to know whether line breaks are semantic, and
only the sniff can tell it. The sniff itself runs on lightly-normalized text (rules 1–4 only), so the
real order is `1–4 → sniff → 5–12 → full structure detection`.

### 2.1 Unicode normalization

`text.normalize('NFC')` globally. **Not NFKC** — it's a blunt instrument (it rewrites ½, ², ℮, and
some spaces in ways that surprise users). Instead apply explicit maps:

- **Ligatures** (endemic in PDFs from LaTeX/InDesign): `ﬁﬂﬀﬃﬄﬅﬆĲĳŒœÆæ` → `fi fl ff ffi ffl ft st IJ ij`
  — but *only* the `ﬁ`-family (U+FB00–FB06); leave `Œ`/`Æ` alone, they're real letters in French and
  Danish.
- **Spaces**: U+00A0, U+2000–200A, U+202F, U+205F, U+3000 → U+0020. Keep U+00A0 → space; a
  non-breaking space in a script is a typesetting artifact, not meaning.
- **Invisibles removed**: U+200B (ZWSP), U+200E/200F (LRM/RLM — but *keep* if the doc has RTL
  content), U+FEFF, U+2060, U+00AD (soft hyphen — remove *after* de-hyphenation uses it as a signal).
  Keep U+200D (ZWJ) so emoji families survive.
- **Control chars** other than `\t\n` → drop.

### 2.2 Whitespace

Order inside the rule matters:

1. **Harvest before destroying:** leading tabs/spaces → `indentPt = tabs × 36 + spaces × 4.5` if
   `indentPt` isn't already set from geometry. Do this first or the indentation signal is lost forever.
2. Tabs *inside* a line → single space (except when a column detector wants them; PDF already
   consumed them).
3. Collapse runs of `[ ]{2,}` → one space. **Exception:** if `≥30%` of lines have interior runs of 3+
   spaces at *consistent* columns, it's an ASCII-art two-column layout (old play editions) — warn and
   offer column splitting instead of collapsing.
4. `rtrim` every line. Do **not** `ltrim` before step 1.
5. `\r\n`/`\r` → `\n` (done at extraction).

### 2.3 Punctuation normalization

Decision: **normalize once, keep one canonical text.** Maintaining separate display and match
representations doubles the surface area of every downstream feature (masking offsets, chunk keys,
search, speech scoring) to preserve typographic curly quotes that nobody rehearsing notices. Note the
tradeoff explicitly in the UI ("Straighten quotes and dashes" toggle, default on, off for anyone who
cares).

- `‘’‚‛` → `'` ; `“”„‟` → `"` ; `«»‹›` → `"` / `'` (configurable; French users may want them kept).
- `‐‑‒−` (hyphen/non-breaking hyphen/figure dash/minus) → `-`. **Keep** `–` (en dash) and `—` (em
  dash) as distinct characters — they're semantically separators and the tokenizer treats them as
  such (§5).
- `. . .` / `.  .  .` / `..` / `...` → `…`? **No — go the other way:** normalize `…` → `...`. Reason:
  users type three dots, search and speech matching are simpler with ASCII, and the tokenizer emits
  one `punct` token either way. Just be consistent; the invariant test (§5.5) doesn't care which.
- `´`/`` ` `` used as apostrophes → `'` (only when between letters).
- `''` used as a double quote (old typewriter scripts) → `"`.
- Multiple `!!!`/`???`/`?!` → keep verbatim. That's performance direction.

### 2.4 De-hyphenation

Fires on `line[i]` ending with a hyphen and `line[i+1]` beginning with a letter.

```
Let A = trailing word of line i, minus the hyphen   (must match /\p{L}{2,}$/u)
Let B = leading word of line i+1                    (must match /^\p{L}/u)
```

Decision table, first match wins:

| Condition | Action | Why |
|---|---|---|
| the hyphen was U+00AD (soft) | join, **drop** hyphen | soft hyphen is *only* a break hint |
| `B` starts uppercase | join, **keep** hyphen | `Anglo-\nSaxon`, `Jean-\nPierre` |
| `A` ∈ prefix set (`self non ex pre re co anti multi semi sub super non ultra well ill over under half all cross mid quasi pseudo`) | join, **keep** hyphen | `self-\nesteem` is really `self-esteem` |
| `A` or `B` is a single letter | join, **keep** hyphen | `T-\nshirt`, `x-\nray` |
| `A+B` (joined, no hyphen) appears elsewhere in the document | join, **drop** hyphen | in-document evidence beats any wordlist |
| `A-B` (with hyphen) appears elsewhere in the document | join, **keep** hyphen | same |
| otherwise | join, **drop** hyphen, flag `lowConfidence` | typeset hyphenation is far more common than a real hyphen landing exactly at EOL |

The in-document evidence rules are the trick that avoids shipping a dictionary. Build a `Set` of all
word forms in the doc once, before the rule runs. Flagged joins get a subtle underline in the cleanup
editor so a user can scan them in seconds. Never fire when the next line is blank, a detected cue, a
scene heading, or on a different page *unless* the page break was mid-paragraph (no blank line and
the previous line didn't end in terminal punctuation).

### 2.5 Paragraph reconstruction from hard-wrapped lines

Only for `prose`/`speech` presets. Guard hard, because getting this wrong on lyrics is catastrophic.

**Detection (does this document have hard wraps at all?)**

```
L = lengths of non-empty lines
p90 = 90th percentile; med = median
hardWrapped =  p90 ∈ [55, 100]
            && share(len ∈ [0.80·p90, p90]) ≥ 0.55        // lines pile up at the margin
            && share(line ends with [.!?…"')\]]) ≤ 0.45   // most lines don't end a sentence
            && med / p90 ≥ 0.7                            // not a poem (poems vary wildly)
```

**Joining rule** — join `line[i]` to `line[i+1]` iff all hold:

- `line[i]` doesn't end with `[.!?…:;"'\)\]]` (or ends with a known abbreviation, §6.2);
- `len(line[i]) ≥ 0.78 × p90` (it reached the margin);
- `line[i+1]` is non-empty, starts with a lowercase letter or `,;` or a continuation quote;
- `line[i+1]` is not a detected cue / heading / section label / list item / `indentPt` outlier;
- neither line was flagged as a semantic break by the structurer.

Joiner is `' '` (the de-hyphenator already ran). Everything else stays a hard line.

For **lyrics, poetry, screenplay dialogue** this rule is off and line breaks are sacred — they are
the memorization scaffold. Say so in the UI: "Keep line breaks (recommended for lyrics and verse)."

### 2.6 The "Clean up" editor and undo

Layout, mobile-first: a single scrolling text view with a sticky bottom sheet.

- **Bottom sheet, tab 1 "Fix":** the rule toggles, each with a live count — "Removed 47 page numbers",
  "Joined 12 hyphenated words", "Dropped 9 running headers". Tapping the count scrolls to and
  highlights the first instance. Each rule is one switch. No sliders.
- **Bottom sheet, tab 2 "Review":** the `warnings` list — low-confidence de-hyphenations, dropped
  headers, detected columns, low-confidence OCR words — as a checklist the user can walk. This is the
  honest interface for a heuristic pipeline: show your guesses, ranked by risk.
- **Diff view:** a toggle that shows removed content as struck-through grey inline rather than a
  side-by-side (side-by-side is unusable on a phone). Removed *lines* collapse to a one-line
  "•••  9 lines removed  (show)" affordance.
- **Free text editing:** the whole document is editable. Use a plain `<textarea>`/`contenteditable`
  for MVP; CodeMirror 6 only if we later want per-line decorations badly enough to pay ~120 KB gz —
  probably not, since our decorations are simple and a custom line-list renderer is cheaper.

**Undo, in two layers:**

1. **Rule toggles need no undo.** They're declarative: flipping one re-runs the pipeline from the
   immutable source. Infinitely reversible by construction. This is the main reason for the
   recipe-not-result design.
2. **Manual edits get a command stack.** Each edit is a `LineEdit`:
   ```ts
   type LineEdit =
     | { op:'replace', at: LineFingerprint, text: string }
     | { op:'delete',  at: LineFingerprint }
     | { op:'insert',  after: LineFingerprint, text: string }
     | { op:'merge',   at: LineFingerprint }        // with next
     | { op:'split',   at: LineFingerprint, offset: number };
   ```
   `LineFingerprint = hash(normalizedLineText).slice(0,8) + ':' + ordinalOfThatHashInDoc`. Undo/redo
   = pop/push on the edit list + re-derive. Coalesce consecutive typing into one `replace` per line
   per 800 ms idle. Cap the stack at 200; it's tiny (text-only ops), so persist it with the document
   — undo survives a reload, which feels magic and costs nothing.

**The re-clean/progress hazard (call this out in the plan).** Once the user has practice history, that
history is keyed to chunk fingerprints (§6.3). Re-cleaning can change them. Policy:

- Before first practice: cleanup is fully open, no warnings.
- After first practice: editing bumps `document.revision`; we run a **progress migration** that
  re-matches old chunk keys to new ones by exact-hash first, then by trigram similarity ≥ 0.85.
  Unmatched progress is shown as "3 chunks changed — their progress was reset," with a one-tap
  "revert to revision 4". Never silently drop history, never silently mis-attribute it.

---

## 3. DOCUMENT MODEL

### 3.1 Types

```ts
type Document = {
  id: string;
  title: string;
  folderId: string | null;
  lang: string;                     // BCP-47, detected (§3.4)
  sourceKind: ExtractResult['meta']['format'];
  sourceText: string;               // IMMUTABLE. the post-extraction, pre-cleanup join of RawLines
  sourceBlob?: Blob;                // original file, kept if < 8 MB (lets us re-extract with a better parser later)
  cleanupConfig: CleanupConfig;
  structure: { type: DocType; confidence: number; overrides: StructureOverride[] };
  revision: number;

  // ── derived, cached, immutable per revision ──
  blocks:  Block[];
  lines:   Line[];
  tokens:  Token[];                 // FLAT, global order
  speakers: Speaker[];
  chunks:  Chunk[];
  stats: { wordCount: number; tokenCount: number; estMinutes: number; perSpeaker: Record<SpeakerId, {lines:number; words:number}> };
  createdAt: number; updatedAt: number;
};

type BlockType =
  | 'title' | 'sceneHeading' | 'action' | 'dialogue' | 'parenthetical' | 'transition'
  | 'sectionHeading' | 'verse' | 'paragraph' | 'heading' | 'stageDirection' | 'ignored';

type Block = {
  id: BlockId;
  type: BlockType;
  speakerId?: SpeakerId;            // dialogue & parenthetical only
  lineRange: [number, number];      // indices into Document.lines, half-open
  tokenRange: [number, number];     // indices into Document.tokens, half-open
  indexInDoc: number;
  meta: {
    pageIndex?: number; indentPt?: number; sceneNumber?: string;
    dualGroupId?: string; dualSide?: 'left'|'right';
    sectionLabel?: string;          // "Chorus", "Verse 2"
    repeatOfBlockId?: BlockId;      // identical stanza → practise once (§4.8)
    cueSuffix?: string;             // "(CONT'D)", "(V.O.)"
  };
  confidence: number;               // 0..1 — drives the review UI
  userConfirmed: boolean;           // true once a human has approved/corrected it
};

type Line = {
  id: LineId; blockId: BlockId; speakerId?: SpeakerId;
  text: string;                     // exact display text, reconstructible from tokens
  tokenRange: [number, number];
  indexInBlock: number; indexInDoc: number;
  isSemanticBreak: boolean;         // true for verse/lyric/dialogue lines: never re-wrap or merge
  syllableEst?: number;             // for lyrics timing later
};

type Token = {
  i: number;                        // global index — THE stable identifier for masking & progress
  text: string;                     // the word core: "don't", "mother-in-law", "1,200", "café", "—"
  lead: string;                     // leading punctuation: '"', '(', '¿'
  trail: string;                    // trailing punctuation: '.', '?!', '..."'
  ws: string;                       // whitespace immediately BEFORE lead (usually ' ' or '')
  kind: 'word' | 'number' | 'punct' | 'direction' | 'label';
  letterCount: number;              // \p{L} only (graphemes for CJK) — drives length-based masking
  letterGroups?: number[];          // per-segment letter counts for hyphenates: [6,2,3] for mother-in-law
  firstLetter: string;              // for "show first letters" mode; grapheme-safe
  normalized: string;               // lowercase, accents folded, ' unified — for matching/search
  isFunctionWord: boolean;
  isMaskable: boolean;              // precomputed from block type + kind (role filter applied later)
  lineId: LineId; blockId: BlockId; speakerId?: SpeakerId;
};

type Speaker = {
  id: SpeakerId;
  displayName: string;              // "MARY"
  aliases: string[];                // ["MARY (CONT'D)", "MARY (V.O.)", "Mary"]
  isEnsemble: boolean;              // ALL, BOTH, CHORUS, OMNES
  lineCount: number; wordCount: number; firstLineIndex: number;
  colorIndex: number;               // stable per-doc, for the reader UI
};
```

### 3.2 Why the token array is flat, precomputed, and immutable

- **Flat** because every masking strategy is an operation over integer indices: "hide every 3rd word"
  is a stride, "hide 30% weighted by length" is a weighted sample, "hide all words over 4 letters" is
  a filter, "hide the second half of each line" needs `line.tokenRange`. All O(n) over a contiguous
  array with no tree walking. Nested arrays would force a traversal for every one of these and make
  the mask representation awkward.
- **Precomputed** because tokenization + structure detection is the only expensive step (tens of ms
  for a full play) and it must not happen during practice. Practice runs at interaction speed: a
  re-mask is a pass over a `Uint8Array`, ~20 µs for a 20 k-word play.
- **Immutable per revision** because *everything else keys into it*: masks, progress, bookmarks,
  recording timestamps, and (later) sync. Integer token indices are the cheapest possible stable
  identifiers — a mask state is a bitset, a sync delta is a run-length-encoded bitset, and a progress
  record is `{chunkKey, ...}`. If tokens could mutate in place, every one of those becomes a
  consistency problem. Making a new revision instead forces the migration question to be answered
  explicitly and visibly (§2.6) rather than corrupting data quietly.
- **Deterministic derivation** means `tokens` is a *cache*, not a source of truth: `sourceText +
  cleanupConfig + structureOverrides + pipelineVersion → tokens` is a pure function. So we can bump
  `pipelineVersion`, ship a tokenizer bugfix, and re-derive everyone's documents on next open. Store
  `pipelineVersion` on the document and re-derive on mismatch.
- **Storage:** IndexedDB, one record per document. A 20 k-word play is ~20 k tokens ≈ 3–5 MB as plain
  objects via structured clone, which clones in a few ms — acceptable. If profiling says otherwise,
  switch `tokens` to a columnar form (one `Uint32Array` for indices/counts, one packed string + offsets
  array for text) which drops it to well under 1 MB and clones instantly. Design the accessor as
  `doc.token(i)` from day one so this swap is invisible.

### 3.3 Masking is a separate overlay

```ts
type MaskState = {
  docId: string; revision: number; pipelineVersion: number;
  hidden: Uint8Array;               // length = tokens.length; 0 = visible, 1 = hidden, 2 = peeked
  level: number;                    // current difficulty step
  strategy: MaskStrategyId;
  seed: number;                     // deterministic randomness → same mask on reload
  roleSetHash: string;
};
```

Rendering contract that guarantees **zero reflow** when the mask changes:

```html
<span class="tk" style="min-width: 4.1ch" data-i="1207">
  <span class="tk-txt">promise</span><!-- visibility:hidden when masked -->
</span>
```

- The outer span is `display:inline-block` and always contains the real text, so its width is the
  *natural* width — no measuring needed, no `ch` estimation. Masking sets `visibility:hidden` on the
  inner span only. The box never changes size, so the page never reflows and the user's eye stays put.
  Nothing about the layout depends on the mask.
- The blank is drawn on the *outer* span with `background-image: linear-gradient(...)` or
  `border-bottom`, so the underline sizes itself to the word — which is also the pedagogically right
  cue (word length is a legitimate hint, and the difficulty ladder can remove it by switching to a
  fixed-width blank at high levels).
- `visibility:hidden` (not `opacity:0`, not `color:transparent`) so hidden text is not selectable and
  not read by screen readers or Live Text — otherwise users trivially cheat by selecting the page.
  Add `aria-label="hidden word"` on the outer span, `aria-hidden` on the inner.
- Each token span carries `unicode-bidi: isolate` so RTL text doesn't reorder across mask boundaries.
- **Re-masking touches only class names on changed tokens.** Diff old vs new `Uint8Array`, then
  `classList.toggle` on just the deltas — typically a few dozen nodes out of thousands. In a framework
  this is a keyed list with `data-i` as the key and a memo on `hidden[i]`.
- **Long-press to peek** = set `hidden[i] = 2` (peeked) and start a timer; on release, back to 1.
  Peeks are recorded per token as a difficulty signal (`peekCount`) — that's the most valuable
  learning signal in the whole app and it's free once the token model is stable.
  **Long-press "Reveal"** = `hidden.fill(0)`, `level = 0`.
- Because masking is an overlay, several can coexist: the *current* mask, the *next-level preview*,
  and a *peek* layer, without ever touching the document.

### 3.4 Language detection

Needed for function words, sentence segmentation, and CJK/RTL token rules. Don't ship a language
detector. Order: (1) explicit user choice, sticky per folder; (2) `document.documentElement.lang` for
HTML imports / PDF `/Lang`; (3) Unicode script counting — if `>15%` of letters are Han/Hiragana/
Katakana/Hangul/Arabic/Hebrew/Cyrillic/Devanagari/Thai, pick that script's most likely language and
set the token rules accordingly; (4) for Latin scripts, a 40-line stopword scorer over the 30 most
common words of en/es/fr/de/it/pt/nl (~1.5 KB of data) is accurate enough at document length. Store
`lang` on the document; always let the user override in one tap.

---

## 4. SCRIPT STRUCTURE DETECTION

### 4.1 Stage 0 — document type sniff

Runs on lightly-cleaned lines. Computes features once, then scores five types. Output
`{ type, confidence, runnerUp }`; confidence = `top / (top + runnerUp)` clamped, times a coverage factor.

Features (all cheap, one pass):
`n` non-empty lines; `pAllCapsShort` (share of lines that are ALL-CAPS and ≤40 chars);
`pColonPrefix` (share matching `^NAME:`); `nRecurringColonNames`; `pIntExt`;
`pParenOnly` (whole line in parens/brackets); `pBlank`; `medLen`; `p90Len`; `lenVariance`;
`pTerminalPunct`; `nSectionLabels` (verse/chorus/bridge…); `nIdenticalStanzas`;
`indentClusterCount`; `pTransition`.

| Type | Strong signals | Threshold sketch |
|---|---|---|
| `screenplay` | `pIntExt > 0.01` **or** (`pAllCapsShort ∈ [0.06, 0.30]` **and** `indentClusterCount ≥ 3`), `pTransition > 0` | +0.5 for INT./EXT.; +0.3 for indent clusters; +0.2 for cue-followed-by-nonCaps |
| `stagePlay` | `nRecurringColonNames ≥ 3` and those lines cover `> 0.4` of text; or `NAME.` pattern; low `pIntExt` | +0.6 |
| `lyrics` | `nSectionLabels ≥ 2` or `nIdenticalStanzas ≥ 1`; `medLen < 45`; `pTerminalPunct < 0.35`; `pBlank > 0.12` | +0.5 |
| `poem` | `medLen < 50`, high `lenVariance`, `pBlank > 0.1`, no cues, no section labels | +0.3 |
| `prose` / `speech` | `medLen > 55`, `pTerminalPunct > 0.5`, few blanks (`prose`) or many short paragraphs + 2nd-person address (`speech`) | fallback |

If `confidence < 0.65`, don't guess silently: the review step opens on "What kind of text is this?"
with five big buttons and a two-line preview of how each would be treated. One tap, correct forever.
This is a *better* experience than a wrong auto-guess and takes an hour to build.

**Shortcut paths that skip heuristics entirely** (check first, they're free):
Fountain markers present → §4.9 parser; DOCX/RTF screenplay style names present → trust styles;
`.fdx`-exported HTML with `<Paragraph Type="Character">` → trust it.

### 4.2 The two-pass principle

Single-pass line classification is unreliable and this is where naive implementations fail. Always:

**Pass A — candidate generation.** Score every line independently against every block-type rule.
Keep *all* candidate labels with scores; don't commit.

**Pass B — global consistency, then commit.** Use document-wide evidence to re-score:

1. **Speaker vocabulary.** Collect all cue candidates with score `> 0.35`. Normalize (strip `(CONT'D)`,
   `(V.O.)`, `(O.S.)`, `(O.C.)`, `(FILTERED)`, `(PRE-LAP)`, trailing `:`; collapse whitespace). Count
   occurrences. Keep names with `count ≥ 2` **or** `count == 1 && score > 0.8`. This vocabulary is the
   single biggest accuracy lever: after it exists, `+0.25` to any line whose normalized text is in it,
   and `−0.4` to an all-caps line that *isn't* (that one is a sound cue or an emphasized action word).
2. **Indent buckets.** Histogram `indentPt` in 6 pt bins. Label the buckets: the bucket containing the
   most confirmed cues is the *cue indent*; the bucket just left of it and slightly wider is *dialogue*;
   the leftmost heavily-populated bucket is *action*; a bucket between cue and dialogue is
   *parenthetical*. `+0.3` for matching the expected bucket, `−0.3` for contradicting it. Only when
   `hasGeometry`.
3. **Grammar of the format.** A cue must be followed by dialogue or a parenthetical. A parenthetical
   must be preceded by a cue or dialogue. Dialogue must be preceded by a cue, parenthetical, or
   dialogue. Run a tiny Viterbi/greedy pass over the candidate scores with these transition
   constraints (a 6×6 transition matrix of log-probabilities — 40 lines of code) and take the best
   path. This fixes the single most common error class — an isolated misclassification in the middle
   of a correct run — essentially for free, and it is far more robust than any amount of per-line rule
   tweaking.
4. **Self-consistency of names.** Merge speakers by fuzzy name (`MARY`/`Mary`/`MARY (CONT'D)`;
   Levenshtein ≤ 2 on names ≥ 5 chars, or one is a prefix of the other). Offer, don't force, merges
   between short similar names (`JIM`/`TIM` must not auto-merge).

### 4.3 Character cue rules

**Hollywood / all-caps cue.** Base score 0, accumulate:

| Condition | Δ |
|---|---|
| line is ALL-CAPS: `letters.length ≥ 2` and uppercase-letter ratio ≥ 0.9 (ignoring digits/punct/spaces) | +0.30 |
| length ≤ 40 chars and ≤ 5 words | +0.15 |
| no terminal `.`/`,`/`!`/`?` (a trailing `:` is allowed and stripped) | +0.10 |
| next non-blank line exists and is **not** ALL-CAPS | +0.15 |
| next non-blank line is directly below (no blank between) or one blank | +0.05 |
| preceded by a blank line | +0.10 |
| `indentPt` in the cue bucket (pass B) | +0.30 |
| normalized name in the speaker vocabulary (pass B) | +0.25 |
| ends with a known cue suffix `(CONT'D) (V.O.) (O.S.) (O.C.)` | +0.20 |
| **matches a scene-heading or transition pattern** | −0.90 |
| contains ≥ 6 words, or any lowercase word | −0.50 |
| line is a lone number, `\|`, `*`, or a dropped-header pattern | −0.90 |
| the same all-caps token also appears inside longer mixed-case lines (i.e. it's a character *mentioned* in action) and this line has ≥ 3 words | −0.30 |

Accept as cue at `≥ 0.70`; `0.45–0.70` → accept but `confidence` low → surfaced in review;
`< 0.45` → not a cue.

**`NAME:` prefix** (stage plays, musicals, interviews, TV transcripts, Rap Genius annotations).
Regex `^\s*([^\s:][^:]{0,39}):\s+(\S.*)$` plus:

- Name part: ≤ 5 words, no terminal punctuation, not ending in a digit, doesn't contain `//`.
- Blocklist for the name part: `note warning caution nb ps re fwd subject from to date time act scene
  chorus verse bridge intro outro tempo key capo tuning source translation http https www`.
- Reject if the char before `:` is a digit (times: `9:30`) or if the name part matches `^\d`.
- **Require recurrence:** the same normalized name must appear as a prefix `≥ 2` times, **or** at
  least 3 distinct such names must exist covering `≥ 35%` of non-blank lines. Without this guard the
  rule fires on prose containing a single colon.
- Score 0.85 when the recurrence test passes, 0.45 for a singleton in an otherwise-matching document.
- The remainder after the colon becomes the first dialogue line; subsequent lines until a blank or the
  next cue continue the same speaker's block.

**`NAME.` prefix** (Shakespeare, Penguin/Arden editions, many public-domain play texts):
`^([A-Z][\p{L}'’.\- ]{1,28})\.\s+(\p{Lu}|\p{Lu}?['"“])` with the same recurrence requirement and an
extra guard: the name must not be a common sentence-starting abbreviation (`Mr Mrs Dr St Jr Sr Prof
Rev Capt Sgt Lt No Vol Ch Fig Op`). Also handle small-caps names from DOCX (`w:smallCaps`) and the
Folio style `Ham.` / `Oph.` abbreviations by fuzzy-mapping abbreviations to full names found in a
dramatis personae block, if present (a leading block of short name-only lines).

**Ensemble names:** `ALL BOTH ALL THREE EVERYONE OMNES CHORUS COMPANY ENSEMBLE CROWD TOGETHER
(ALL) (BOTH)` → speaker with `isEnsemble: true`. Selectable as a role, and *additively* included:
picking `MARY` should offer "also practise lines marked ALL/BOTH?" — this matters a lot in musicals
and is a detail MemoCoach users complain about in other apps.

### 4.4 Scene headings, transitions, action

- **Scene heading:** `^\s*(\d{1,3}[A-Z]?\s+)?(INT\.?|EXT\.?|EST\.?|INT\.?\/EXT\.?|I\/E\.?)[\s.]` →
  0.95. Also `^(INTERIOR|EXTERIOR)\b` → 0.85. Also a bare ALL-CAPS line ending in
  `[-–—]\s*(DAY|NIGHT|MORNING|AFTERNOON|EVENING|DUSK|DAWN|LATER|CONTINUOUS|MOMENTS LATER|SAME|NEXT DAY)\.?$`
  → 0.75. Also Fountain `^\.[^.]` → 1.0. Capture the leading number into `meta.sceneNumber`.
  Stage plays: `^(ACT|SCENE|PROLOGUE|EPILOGUE|INTERMISSION)\s+([IVXLC]+|\d+|ONE|TWO|...)\b` → 0.9,
  type `heading`.
- **Transition:** ALL-CAPS line ending in `TO:` , or ∈ `{FADE IN:, FADE OUT., FADE TO BLACK.,
  CUT TO:, SMASH CUT TO:, MATCH CUT TO:, DISSOLVE TO:, WIPE TO:, INTERCUT WITH:, THE END, BLACKOUT.,
  CURTAIN.}`, or (with geometry) an ALL-CAPS line right-aligned / `indentPt` in the rightmost bucket.
  → 0.9. Fountain `>TEXT<` → 1.0.
- **Action / stage direction (block-level):** default for anything unclassified in a screenplay. In a
  stage play, a whole line that is italic (from DOCX/RTF/HTML) or fully parenthesized is
  `stageDirection` at 0.85; italics alone is 0.7 (Penguin editions italicize directions consistently,
  so this is a strong signal when available).

### 4.5 Parentheticals and inline directions

Two different things; both must be non-maskable by default and excluded from word counts:

- **Block parenthetical:** the whole line is `(...)` or `[...]`, and it sits between a cue and
  dialogue (or between two dialogue lines). `type:'parenthetical'`, inherits `speakerId`. Classic
  contents: `(beat) (pause) (sotto) (to MARY) (CONT'D) (laughing) (V.O.)`.
- **Inline direction:** `(...)`/`[...]` *within* a dialogue line — `"I told him — (beat) — no."`
  Represent as tokens with `kind:'direction'` inside the dialogue line, **not** as a separate block.
  Why: the line must render as one line (splitting it would break the reading rhythm and the chunk
  boundaries), but the words inside must never be masked, must not count toward "words memorized",
  and should render dimmed/italic. Making it a token kind rather than a block gets all three for free.
  Guard: don't do this when the parens contain a normal parenthetical remark that's genuinely spoken —
  distinguish by (a) an inline-direction lexicon (`beat pause aside sotto laughs cont'd to X`), (b)
  bracket type (`[...]` is nearly always editorial), (c) italic formatting when available. When
  unsure, keep it spoken and let the user tap to change it. Getting this wrong in the safe direction
  (treating a direction as spoken) is much less annoying than the reverse.
- Lyric annotations `(x2)`, `(repeat)`, `(2x)`, `(instrumental)` → `kind:'direction'` too.

### 4.6 Dual / simultaneous dialogue

Detection:
- Fountain: `^` on the second cue → definitive.
- PDF: two cue-candidates in the same y-cluster separated by `> 1.5 × medianCharWidth × 12`, followed
  by 2–20 lines that each split cleanly across the same x midpoint. Group into
  `dualGroupId`, `dualSide`.
- DOCX: a two-column `w:tbl` whose cells each begin with a cue.

Model: two sibling runs of blocks sharing `meta.dualGroupId`. **Mobile rendering:** do *not* try
side-by-side on a 390 px screen. Render stacked, with a bracket/brace glyph in the gutter and a
"SIMULTANEOUS" chip. On ≥ 700 px, render as two columns. For role mode, only my side is maskable —
which is exactly right, since the other side is my cue.

### 4.7 Speaker post-processing

- Normalize + merge aliases (§4.2.4); keep the *most frequent* surface form as `displayName`.
- `(V.O.)`, `(O.S.)`, `(CONT'D)` are **variants of the same speaker**, stored in `meta.cueSuffix` and
  rendered, not separate speakers. (Offer "treat MARY (V.O.) as a separate role" for the rare case.)
- Compute `lineCount`/`wordCount`/`firstLineIndex` per speaker. Display them in the role picker —
  "HAMLET · 358 lines · 11,240 words · 74 min" is genuinely the information an actor wants.
- Assign `colorIndex` stably by first appearance.
- Lines with no detectable speaker in a dialogue-heavy document → `speakerId: 'unknown'`, surfaced in
  review as "12 lines have no speaker."

### 4.8 Lyrics and verse structure

- **Section labels:** `^\s*[\[\(]?\s*(intro|verse|pre[-\s]?chorus|chorus|hook|refrain|bridge|middle\s*8|
  break(down)?|drop|instrumental|solo|interlude|outro|coda|tag|vamp|reprise|ad[-\s]?lib)s?\s*(\d+|[IVX]+)?\s*
  [\]\):]?\s*$/i` → `sectionHeading`, `meta.sectionLabel` title-cased. Also `[Verse 1: Artist Name]`
  (Genius style) — keep the label, drop the artist, but record it as `speakerId` (a duet's parts are
  exactly a role-isolation problem — this makes role mode work for songs at zero extra cost).
- **Verse block:** a run of non-empty lines bounded by a blank line or a section heading.
  Every line has `isSemanticBreak: true`; never unwrap, never merge.
- **Repeat detection:** hash each verse block by its normalized concatenated text. Identical hashes →
  set `meta.repeatOfBlockId` on all but the first. Then offer: *"The chorus repeats 3×. Practise it
  once and mark the repeats as learned?"* — this cuts the perceived work on a pop song by ~40% and is
  the kind of thing that makes people prefer our app. Also detect *near*-duplicates (trigram
  similarity ≥ 0.85) and highlight only the differing words — the classic hard part of learning
  lyrics is chorus variations, and highlighting exactly the deltas is a real pedagogical feature.
- **Syllable estimate** per line (vowel-group counting, ~15 lines, ±10% on English): shown as a
  faint number for singers matching lines to a melody. Cheap, and only lyrics people will notice it.

### 4.9 Manual correction UI, overrides, and Fountain as the escape hatch

**Per-line correction.** Tap any line in the reader (in an explicit "Structure" mode, so taps don't
fight with practice gestures) → bottom sheet:

```
   ┌─────────────────────────────────────────┐
   │  "I never said that."                   │
   │                                         │
   │  Type   [Dialogue▾] Direction  Heading  │
   │         Paragraph   Verse   Ignore      │
   │  Speaker  (MARY) (JOHN) (ALL) (+ New…)  │
   │                                         │
   │  ⚡ Apply to all 14 lines like this      │
   │  ↑ Merge with line above                │
   │  ✂ Split here                           │
   └─────────────────────────────────────────┘
```

- **"Apply to all lines like this"** is the highest-leverage control: it generalizes on the actual
  signal that misfired — same `indentPt` bucket, same leading token, same all-caps-ness, same
  `styleName`. Show the count before applying, and make it one undo step. One tap fixes a
  systematically wrong document, which is the difference between a usable and an infuriating
  heuristic pipeline.
- **Bulk toggles** in the Structure toolbar: "ALL-CAPS short lines are character names" (on/off),
  "Lines in (parentheses) are stage directions" (on/off), "Keep line breaks", "Italics are stage
  directions". Each is a one-tap re-derive.
- **Speaker manager:** rename, merge (drag one chip onto another), split, mark ensemble, set "my
  role". Show a fuzzy-similar-name suggestion strip: "Merge MARY and Mary? (17 + 3 lines)".

**Override storage.** Every correction is a `StructureOverride` keyed to a line *fingerprint*, not an
index, so it survives re-cleaning and re-detection:

```ts
type StructureOverride =
  | { at: LineFingerprint, blockType: BlockType }
  | { at: LineFingerprint, speakerId: SpeakerId }
  | { rule: 'allCapsAreCues'|'parensAreDirections'|'italicsAreDirections', value: boolean }
  | { pattern: LinePredicate, blockType: BlockType, speakerId?: SpeakerId }   // from "apply to all"
  | { speakerMerge: [SpeakerId, SpeakerId] }
  | { speakerRename: { id: SpeakerId, name: string } };
```

Applied after automatic detection, and any block touched by an override gets
`confidence = 1, userConfirmed = true` so the review UI stops nagging.

**Fountain as the universal escape hatch (strong recommendation).** Ship a "Edit as screenplay text"
mode that serializes the current structure to Fountain and parses it back. This gives us, for one
~350-line parser + serializer:

- A power-user correction path that fixes *anything* the UI can't express, using a real standard.
- A round-trippable canonical text form → trivially exportable, diffable, and pasteable.
- The target format for the AI assist (§7), so the AI output path reuses the parser.
- Import support for the format screenwriters already use (Highland, Slugline, Fade In, Beat all
  export it).
- A dead-simple regression corpus: fixture in → Fountain out → compare to a golden file.

Fountain subset to support: title-page key/value block, `.SCENE` and INT./EXT. auto-detection,
`@CHARACTER` (forced) and auto ALL-CAPS cues, `(parentheticals)`, `!action` (forced), `>TRANSITION:<`,
`>CENTERED<`, `^` dual dialogue, `[[notes]]` → ignored blocks, `/* boneyard */` → dropped, `=` synopsis
→ ignored, `#` sections → headings, `**bold**`/`*italic*`/`_underline_` emphasis. Skip: `~lyrics` line
prefix (or map it to `verse`, actually useful for musicals).

---

## 5. TOKENIZER

### 5.1 Algorithm

Per `Line`, produce tokens. Do **not** hand-roll word boundaries — start from
`Intl.Segmenter` (Baseline since April 2024, all engines, zero bytes) with `granularity:'word'`, which
handles CJK, Thai, Khmer, and Latin correctly, then apply a *re-join* and *classify* pass because
`Intl.Segmenter` is more granular than a rehearsal token in a few places we care about.

```
tokenize(lineText, lang):
  segs = [...new Intl.Segmenter(lang, {granularity:'word'}).segment(lineText)]
  # segs: { segment, index, isWordLike }
  1. GROUP: walk segs, accumulating a token whenever we see a word-like segment.
     Re-join across a non-word-like segment S when S is a JOINER in context:
       - S is "'" or "’" and both neighbours are word-like        → don't / O'Brien / y'all / rock'n'roll
       - S is "-" and both neighbours are word-like and neither side
         is empty                                                     → mother-in-law, e-book, T-shirt
       - S is "." and both neighbours are word-like AND (both sides
         are single letters OR the left side is a known abbreviation)  → D.C., e.g., Mr.
       - S is "," or "." and both neighbours are ALL-DIGITS            → 1,200  3.14
       - S is ":" or "/" and both neighbours are ALL-DIGITS            → 9:30  1/2
       - S is "&" and both neighbours are single uppercase letters     → R&B, AT&T
     Never join across a SEPARATOR: whitespace, – — ― … " ' ( ) [ ] { } « » ! ? ; : (non-numeric)
       , (non-numeric) . (sentence-final) / \ | * + = @ # ~ ¿ ¡ and all \p{Ps}\p{Pe}\p{Pi}\p{Pf}.
  2. PEEL: for each token, move leading \p{P}\p{S} chars into `lead`, trailing into `trail`.
     EXCEPTIONS (stay in `text`):
       - a leading apostrophe followed by letters/digits when the word is in the ELISION set
         ('tis 'twas 'em 'til 'round 'cause 'bout 'n) or by 2 digits ('90s, '76)
       - a trailing apostrophe after 's' (dogs', James')  — possessive plural
       - a trailing '.' that is part of an abbreviation kept in step 1
  3. EMIT SEPARATOR TOKENS: every run of non-word-like, non-peeled characters that stands alone
     between two tokens becomes kind:'punct' with text = the run, isMaskable = false.
     (— … -- etc. render but are never hidden. This is what makes "wait—no" behave.)
  4. WHITESPACE: `ws` = the exact whitespace string preceding this token's `lead`. Never lost.
  5. CLASSIFY:
       kind      = /^\p{N}[\p{N}.,:/]*$/u ? 'number'
                 : insideInlineDirectionSpan ? 'direction'
                 : hasLetters ? 'word' : 'punct'
       letterCount   = [...text].filter(c => /\p{L}/u.test(c)).length
                       (for CJK/Hangul: grapheme count via Intl.Segmenter granularity:'grapheme')
       letterGroups  = text.split(/[-'’.]/).map(letterCountOf)      // for hyphenates
       firstLetter   = first grapheme of the first letter-bearing group
       normalized    = text.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[’´`]/g,"'")
       isFunctionWord= FUNCTION_WORDS[lang].has(normalized)
       isMaskable    = kind ∈ {word, number} && block.type ∈ {dialogue, paragraph, verse, heading?}
```

### 5.2 Per-script rules

- **Latin + accents:** NFC in storage; `normalized` is NFD-folded for matching. `letterCount` counts
  `é` as 1 (it's one `\p{L}` after NFC — but count graphemes to be safe against NFD input).
- **CJK (Han/Kana/Hangul):** `Intl.Segmenter` splits sensibly (`私は学生です` → `私`/`は`/`学生`/`です`).
  Each becomes a token. `letterCount` = grapheme count. **`letterCount`-based and `firstLetter`-based
  masking are meaningless here** → the language config sets
  `supportedMaskModes: ['wholeWord','line','firstChar']` and the UI hides the others. Getting this
  right is a small amount of code and the difference between "works" and "garbage" for a Japanese user.
- **RTL (Arabic/Hebrew):** logical order preserved; `Line` carries `dir`; token spans get
  `unicode-bidi: isolate` so masked/unmasked transitions don't reorder text. Arabic presentation
  forms: don't try to be clever; whole-word masking only (letter-level masking breaks joining forms —
  hiding a middle letter changes the shapes of its neighbours, which is a real bug and a real reason
  to restrict modes per script).
- **Emoji / ZWJ:** grapheme-segment for counting so 👨‍👩‍👧 is one "letter", and never split a ZWJ sequence.
- **Combining diacritics (Vietnamese, Hindi):** always count graphemes, never `.length`.

### 5.3 Function words

Static per-language `Set` of ~120 English forms (articles, prepositions, pronouns, auxiliaries,
conjunctions, particles), same for es/fr/de/it/pt/nl at ~120 each — about 6 KB of data total,
tree-shaken per language via dynamic import. Note for the masking module: hiding **content** words is
the harder, more useful drill (function words are recoverable from grammar), so a good difficulty
ladder hides function words at low levels and content words at high levels. The tokenizer just
provides the flag.

### 5.4 The master invariant

```
For every Line:  line.tokens.map(t => t.ws + t.lead + t.text + t.trail).join('') === line.text
```

Exact string equality. This single property makes the tokenizer *provably* lossless, which is what
lets us render from tokens instead of from text (required for masking) without ever risking a
visual difference from the source. It is the first test written and the one that must never be
skipped.

### 5.5 How to test it

1. **Property test (`fast-check`)** for the §5.4 invariant over generated strings: random mixes of
   Latin words, accents, CJK, Hebrew, digits, all Unicode punctuation categories, emoji, and random
   whitespace. Thousands of cases, zero maintenance. This is the highest-value test in the project.
2. **Golden-file table tests** for the cases in §5.6 — exact expected token arrays, checked in as
   JSON so a diff is readable.
3. **Idempotence:** `tokenize(detokenize(tokenize(x))) === tokenize(x)`.
4. **Counting invariants:** `sum(letterCount)` equals the count of `\p{L}` in the line; `wordCount`
   equals the number of `kind ∈ {word, number}` tokens.
5. **Cross-locale:** run the same fixture with `lang` = en, de, fr, ja, he, th, and snapshot. Catches
   `Intl.Segmenter` locale differences, which do exist and *will* surprise us — snapshotting them is
   better than assuming.
6. **Fuzz against the real corpus** (§8): tokenize every fixture, assert the invariant, and assert no
   token has `text === ''`.

### 5.6 Fourteen tricky inputs

Notation per token: `ws|lead|text|trail` (`∅` = empty), `¶`=punct token, `#`=number, `→`=direction.

| # | Input | Expected tokens |
|---|---|---|
| 1 | `Don't — it's O'Brien's.` | `∅\|∅\|Don't\|∅` · `␠\|∅\|—\|∅`¶ · `␠\|∅\|it's\|∅` · `␠\|∅\|O'Brien's\|.` |
| 2 | `"Well," he said, "no."` | `∅\|"\|Well\|,"` · `␠\|∅\|he\|∅` · `␠\|∅\|said\|,` · `␠\|"\|no\|."` |
| 3 | `My mother-in-law's 1,200-page e-book...` | `∅\|∅\|My\|∅` · `␠\|∅\|mother-in-law's\|∅` (letterCount 13, groups [6,2,3,1]) · `␠\|∅\|1,200-page\|∅` (kind word, letterCount 4) · `␠\|∅\|e-book\|...` |
| 4 | `INT. COFFEE SHOP - DAY` | `∅\|∅\|INT.\|∅` (abbrev join) · `␠\|∅\|COFFEE\|∅` · `␠\|∅\|SHOP\|∅` · `␠\|∅\|-\|∅`¶ · `␠\|∅\|DAY\|∅` |
| 5 | `'Tis the season—really?!` | `∅\|∅\|'Tis\|∅` (elision, apostrophe in core) · `␠\|∅\|the\|∅` · `␠\|∅\|season\|∅` · `∅\|∅\|—\|∅`¶ · `∅\|∅\|really\|?!` |
| 6 | `He paid £5.99 (plus 20% VAT).` | `∅\|∅\|He\|∅` · `␠\|∅\|paid\|∅` · `␠\|£\|5.99\|∅`# · `␠\|(\|plus\|∅` · `␠\|∅\|20\|%`# · `␠\|∅\|VAT\|).` |
| 7 | `Wait... what? . . . Hello?` | `∅\|∅\|Wait\|...` · `␠\|∅\|what\|?` · `␠\|∅\|...\|∅`¶ (after `. . .` → `...` normalization) · `␠\|∅\|Hello\|?` |
| 8 | `Señor Ñuñez naïvely re-entered the café.` | 6 tokens; `Señor` letterCount 5, `Ñuñez` 5, `naïvely` 7, `re-entered` letterCount 9 groups [2,7], `café` 4 with `trail '.'`; `normalized` = `senor nunez naively re-entered the cafe` |
| 9 | `¿Dónde está? ¡Aquí!` | `∅\|¿\|Dónde\|∅` · `␠\|∅\|está\|?` · `␠\|¡\|Aquí\|!` |
| 10 | `Act 3, Scene 2: "To be, or not to be..."` | `Act`,`3,`#… — note `3,` peels to `text:'3' trail:','` because the char after `,` is a space, not a digit; `2` gets `trail:':'`; `To` gets `lead:'"'`; `be` gets `trail:'..."'` |
| 11 | `私は学生です。` | `私` · `は` · `学生` (letterCount 2) · `です` · `。`¶ — all `ws:''`; maskModes restricted to whole-token |
| 12 | `שלום עולם, מה קורה?` | 4 tokens in logical order, `dir:'rtl'`, `letterCount` 4/4/2/4, whole-word masking only |
| 13 | `Rock'n'roll all nite (x2)` | `Rock'n'roll` ONE token (double apostrophe join) letterCount 10 · `all` · `nite` · `(x2)` as `kind:'direction'` (lyric-annotation lexicon), `isMaskable:false` |
| 14 | `Mr. Smith Jr. went to Washington, D.C. Then he left.` | `Mr.` `Smith` `Jr.` `went` `to` `Washington,` `D.C.` `Then` `he` `left.` — abbreviation dots stay in `text` (so sentence splitting in §6.2 sees them as non-terminal); `D.C.` is one token |

Two known-hard cases to decide explicitly and encode as tests: `3,` in #10 (comma-as-digit-grouping vs
punctuation — resolved by "next char must be a digit"), and #14's `left.` where the final period *is*
terminal (resolved by "abbreviation set membership", not by position).

---

## 6. CHUNKING

### 6.1 Modes

```ts
type ChunkMode =
  | { kind:'line' }                       // one Line per chunk
  | { kind:'sentence' }
  | { kind:'block' }                      // paragraph / verse / one speech
  | { kind:'speech' }                     // one cue's full dialogue (actor default)
  | { kind:'window', words: number }      // sliding N-word window, snapped to boundaries
  | { kind:'marker' };                    // user-placed splits + auto at headings
```

Defaults by document type — the chunk unit should match how the material is *performed*:

| Doc type | Default | Why |
|---|---|---|
| screenplay / stage play | `speech` | the rehearsal unit is cue-to-cue; an actor learns speeches, not sentences |
| lyrics | `line` grouped into `verse` for review | you learn a lyric line-by-line, review by section |
| poem | `line` | line breaks are the structure |
| speech / presentation | `sentence`, merged to ~30 words | speakers deliver in sentences |
| prose / lesson | `sentence` | same |

### 6.2 Sentence segmentation

`Intl.Segmenter(lang, {granularity:'sentence'})` as the base, then three corrections it gets wrong:

1. **Abbreviation guard:** never break after a token whose `text` ends in `.` and is in the
   abbreviation set (`Mr Mrs Ms Dr Prof Rev Fr St Sr Jr Capt Sgt Lt Col Gen Hon Rep Sen vs etc e.g
   i.e cf al No Vol Ch Fig Op Ave Blvd Rd Inc Ltd Co Dept Univ approx Jan Feb ... Dec Mon Tue ...`)
   or is a single capital letter followed by `.` (initials: `J. R. R. Tolkien`).
2. **Quote/bracket balance:** a sentence may not end while an opening `"`/`(`/`[`/`«` is unclosed
   within the same block.
3. **Never cross a block boundary.** A sentence never spans two speakers, verses, or scene headings.
   Enforce by segmenting *within* each block.

### 6.3 Sizing algorithm

Targets, derived from speech rate (~130–160 wpm) and working-memory limits — a chunk should be
speakable in one breath-group and holdable in one recall attempt:

```
TARGET = 28 words     MIN = 6 words     MAX = 60 words     HARD_MAX = 90
```

```
buildChunks(blocks, mode):
  units = rawUnitsFor(mode)                     # lines | sentences | blocks | speeches
  out = []
  for u in units:
    if wordCount(u) <= MAX: out.push(u); continue
    # too long: split at the best available boundary, recursively
    out.push(...splitBy(u, [
       sentenceBoundaries,                      # 1st choice
       clauseBoundaries(/[;:—]|,\s+(and|but|or|so|because|which|who|then)\b/),
       lineBoundaries,                          # lyrics: a long verse splits at line breaks
       nearestWordBoundaryAt(TARGET)            # last resort
    ], MAX))
  # merge runt units forward
  for i in out:
    if wordCount(out[i]) < MIN and mergeableWith(out[i], out[i+1]): merge
  return out

mergeableWith(a,b) = a.blockId==b.blockId || (
     a.speakerId === b.speakerId
  && sameBlockType(a,b)
  && no sceneHeading/sectionHeading/blank-run between them
  && !a.lastLine.isSemanticBreak            # never merge across a lyric/verse line break
)
```

Never split: inside a token, inside an inline direction span, inside a quoted phrase if avoidable,
or across a speaker change. Always split at: scene headings, section headings, act/scene boundaries,
user markers.

**User markers.** A "split here" gesture (long-press the line gutter) inserts a marker; markers are
stored as `LineFingerprint`s in `cleanupConfig` so they survive edits. Also honour a literal `---` /
`***` line in pasted text, and `#` Fountain sections. Show markers as a thin dotted rule.

### 6.4 Chunks → progress

```ts
type Chunk = {
  id: ChunkId;
  key: string;             // STABLE across re-chunking: hash(normalizedText).slice(0,10)+':'+ordinal
  docId: string; revision: number;
  tokenRange: [number, number];
  blockIds: BlockId[]; speakerId?: SpeakerId;
  orderIndex: number; wordCount: number; maskableCount: number;
  sceneId?: BlockId;       // nearest preceding sceneHeading/sectionHeading — the natural review group
};

type ChunkProgress = {
  progressKey: string;     // `${docId}:${roleSetHash}:${chunk.key}`
  attempts: number; cleanRuns: number; consecutiveClean: number;
  maskLevel: number;       // PER-CHUNK difficulty — this is the key design win
  peekCount: number;       // long-press reveals: the strongest difficulty signal we have
  msPerWord?: number;      // hesitation proxy
  lastSeenAt: number; easeBucket: 1|2|3|4|5;
};
```

Three consequences worth stating, because they fall out of chunking for free and are the main reason
to do it properly:

1. **Difficulty is per chunk, not per document.** MemoCoach ramps one global difficulty. Ramping each
   chunk independently means the two hard lines in a monologue get drilled while the easy ten don't
   waste your time. This is a genuine improvement over the app we're copying and requires no extra UI.
2. **`progressKey` includes `roleSetHash`,** so practising as MARY doesn't pollute your JOHN stats.
3. **Document progress** = `Σ(chunk.maskLevel/maxLevel × chunk.wordCount) / Σ chunk.wordCount`, plus
   a per-scene rollup for the "which scene am I weakest on" view. Weight by words, not chunks, or a
   3-word chunk counts as much as a 60-word one.

`chunk.key`'s `hash + ordinal` construction is what makes progress survive re-cleaning, re-chunking,
and mode changes: identical text keeps its history even if it moved, and duplicate text (a repeated
chorus) is disambiguated by ordinal. When the mode changes (`sentence` → `line`), migrate by token
overlap: a new chunk inherits a weighted average of the progress of old chunks whose `tokenRange`
overlaps it. Approximate, honest, and much better than resetting.

---

## 7. ROLE ISOLATION

### 7.1 Picking roles

After structure detection, if `speakers.length ≥ 2`, show the role picker (skippable, remembered per
document):

```
   Who are you?
   ┌───────────────────────────────────────────┐
   │ ◉ HAMLET      358 lines · 11,240 w · 74m  │
   │ ○ OPHELIA      58 lines ·  1,180 w ·  8m  │
   │ ○ CLAUDIUS    112 lines ·  3,050 w · 20m  │
   │ ☐ ALL / OMNES  12 lines (ensemble)        │
   └───────────────────────────────────────────┘
   [ ] I'm doubling another role
   [ Practise everything instead ]
```

Multi-select for doubling; ensemble speakers offered as an additive checkbox. `myRoles: SpeakerId[]`
persists per document, and `roleSetHash = hash(sorted(myRoles))` scopes all progress.

### 7.2 What "practise only my lines" actually renders

**Maskability, exactly:**

```ts
isMaskableNow(t) =
     t.kind in {'word','number'}
  && block(t).type in maskableBlockTypes            // default {dialogue, paragraph, verse}
  && (myRoles.length === 0 || myRoles.includes(t.speakerId))
  && !(t.kind === 'direction')
```

Everything else — other speakers' dialogue, stage directions, parentheticals, scene headings — stays
**fully visible**. That is the definition of a cue: it must be readable or it can't cue you. Optional
toggles: "also memorize stage directions", "also hide scene headings", "hide my parentheticals".

**Three view modes** (a segmented control; all three come free from the same document model):

| Mode | Renders | For |
|---|---|---|
| **Full script** (default; = MemoCoach's actor tool) | the entire script in order; my dialogue maskable; other speakers' lines visible in a dimmer weight; directions dimmed + italic; scene headings sticky at the top of the viewport while scrolling | learning in context, following a rehearsal |
| **Cue script** | other speakers' lines collapsed to their **last 5 words** (`… I told you not to come.`), tappable to expand; my lines full-size and maskable | the historically-correct rehearsal artifact; cuts a 120-page script to ~30 screens on a phone — the biggest quality-of-life win in this section |
| **My lines only** | just my speeches, each with a small grey caption above showing the cue's tail and the cue-giver's name | off-book checking, line-runs, "do I know speech 14?" |

Details that matter in practice:
- **Cue tail length** is user-settable (3/5/8 words / whole line). 5 is the right default: enough to
  recognize, short enough to scan. Always show the *end* of the cue line, never the start — the end is
  what actually triggers you.
- **Sticky context header** shows the current scene heading + the previous speaker, so scrolling
  never loses you.
- **Auto-scroll while practising** (a MemoCoach feature) scrolls to keep the current chunk in the
  upper third; speed slider; pauses on any touch; resumes after 2 s. Because chunks are token ranges
  and every token span carries `data-i`, "scroll to chunk" is one `scrollIntoView` on the first token.
- **My-lines word/time count** in the header: "your part: 11,240 words ≈ 74 min at 150 wpm."

### 7.3 Edge cases to handle explicitly

- Lines with `speakerId: 'unknown'` → treated as cues (visible), listed in review.
- Ensemble lines → maskable only if the ensemble speaker is in `myRoles`.
- Dual dialogue → my side maskable, the other side is a cue, rendered stacked on mobile with a
  "simultaneous" chip.
- A monologue / single-speaker document → skip the picker entirely, `myRoles = [the one speaker]`.
- Duet lyrics with `[Verse 1: Artist A]` labels → the exact same machinery works; role isolation for
  songs at zero extra cost.
- Changing `myRoles` later must not destroy the old role's progress (that's what `roleSetHash` is for).

---

## 8. TESTING & THE FIXTURE CORPUS

The pipeline is heuristic, so the test corpus *is* the specification. Build it before the heuristics.

`test/fixtures/` — for each entry, the input file plus a `.expected.json` (block types, speakers,
chunk boundaries) and, where relevant, a `.fountain` golden serialization:

1. Final Draft PDF export, US format, with revision marks and `(CONT'D)`s.
2. A scanned/photocopied play PDF (image-only) — asserts `likelyScanned`.
3. A PDF with a broken `/ToUnicode` map — asserts gibberish detection.
4. A two-column hymnal/lyric-sheet PDF.
5. A justified-prose PDF with automatic hyphenation and running headers.
6. A Shakespeare public-domain text (`HAMLET.` style cues, verse lines, stage directions in italics).
7. A modern stage play with `NAME:` cues and bracketed directions.
8. A Genius lyrics paste, complete with `[Verse 1: X]`, `Embed`, "You might also like".
9. A Word DOCX from Fade In / Final Draft with real style names.
10. A DOCX with `w:smallCaps` character names and a dual-dialogue table.
11. An RTF from Celtx with `\uN` escapes and a Cyrillic or accented passage.
12. A Google-Docs HTML paste (`<span style="font-weight:700">` soup).
13. A hard-wrapped 72-column .txt speech.
14. A Japanese text, a Hebrew text, and an emoji-containing text (tokenizer/locale coverage).
15. A pathological paste: mixed tabs, 40 blank lines, Windows-1252 smart quotes, a BOM.

Test kinds: the §5.4/§5.5 property tests; per-rule unit tests for cleanup (each rule in isolation,
plus "rule is a no-op when off"); structure detection snapshot tests reporting *accuracy numbers*
(cue precision/recall per fixture) so a heuristic change shows its cost — track this in a single
`pnpm test:accuracy` summary table, because otherwise every tweak is a coin flip; and end-to-end
`file → chunks` snapshots.

Performance budgets (assert in tests, on a mid-range phone): 20 k-word tokenization < 150 ms;
structure detection < 200 ms; PDF text extraction < 120 ms/page; first mask paint < 16 ms; re-mask
< 4 ms. Everything above ~30 ms goes in a worker with progress reporting.

---

## 9. OPTIONAL "AI FORMATTING" ASSIST (no API key, no cost)

MemoCoach ships FAQ prompts for this; we can do it better by making the *round trip* verifiable.

**Flow.** In the review step, if structure confidence is low or the user is unhappy:
`Format with AI (free)` → we build the prompt, copy it to the clipboard, show buttons that open
chat.openai.com / claude.ai / gemini.google.com in a new tab, and present a "Paste the result here"
textarea. Parse the pasted result as Fountain (§4.9), **verify it (below)**, then apply.
Long documents are split at ~5,000 words on block boundaries with `PART 1 OF 3` in the prompt.

**Privacy notice, shown once, plainly:** "This copies your text so you can paste it into a chatbot.
Your text leaves this device only if you do that. Nothing is sent automatically, and there's no
account or key involved."

**The prompt** (stored as a template, editable in settings):

> You are formatting a text for a line-memorization app. Convert the text below into **Fountain**
> screenplay markup.
>
> **Absolute rule: do not change a single word.** Do not paraphrase, translate, correct spelling or
> grammar, summarize, add, remove, or reorder any word of the original text. You are only adding
> structural markup around the existing words. If you cannot tell what something is, leave it as
> plain action text rather than guessing.
>
> Use exactly this markup:
> - Character cue: a line starting with `@` then the name in caps — `@MARY`
> - Dialogue: the line(s) immediately after a cue, no marker
> - Parenthetical / delivery note: on its own line in parentheses — `(quietly)`
> - Scene heading: a line starting with a period — `.INT. KITCHEN - DAY`
> - Action / stage direction: a line starting with `!` — `!She crosses to the window.`
> - Transition: `>CUT TO:<`
> - Two characters speaking at once: put `^` before the second character's cue
> - Song sections: a line like `# Chorus`
> - Anything you're unsure about: leave it as `!` action text
>
> Output **only** the Fountain text inside a single fenced code block. After the closing fence, output
> the line `=== END ===` and then, on one line, the total number of words in your output. No
> commentary, no explanation, no preamble.
>
> ```
> {{TEXT}}
> ```

**Verification (essential — this is the part that makes it safe).** LLMs silently paraphrase, drop
lines, and "helpfully" fix typos. Never apply the result blind:

1. Strip all Fountain markup from the pasted output → a bare word sequence.
2. Compare it to the source's word sequence after the same normalization (lowercase, fold accents,
   strip punctuation).
3. **Reject outright** if: word count drifts by more than 1.5%, or any word appears in the output that
   isn't in the source's multiset, or the longest common subsequence covers < 98% of source words.
   Show the offending diff and the message: "The AI changed the words, so I didn't apply it. Try again,
   or fix the structure by hand." Offer a "show me what changed" diff view.
4. On pass: the LCS alignment maps every source token to an output position, so we apply **only the
   structure** — block types and speakers — onto our own, unchanged, already-tokenized text. The AI
   never gets to write the text we practise. This is the key safety property: the AI's output is
   treated as a *labelling* of our tokens, not as a replacement for them.
5. The result lands as `StructureOverride`s with `userConfirmed: false`, so the review UI still lets
   the user check it, and one tap reverts the whole thing.

**Second prompt, "Fix OCR errors."** This one *must* change words, so it can't use the same
verification. Handle it as a word-level review: align source and output with LCS, present each
difference as an accept/reject card (`recieved → received`, `l0ve → love`), default all to rejected,
"accept all" available. 15 cards take 20 seconds and the user stays in control.

**Third prompt, "Label the verses"** for lyrics: same machinery, only allowed to insert `# Chorus` /
`# Verse 2` lines, verified by requiring that removing all `#`-prefixed lines reproduces the input
exactly. A trivially checkable contract.

---

## 10. BUILD ORDER (for the implementation plan)

| Session | Deliverable | Gate |
|---|---|---|
| 1 | `types.ts`, paste + .txt + .md import, cleanup rules 1–4 + 10–11, tokenizer, §5.4 property test | invariant green on all 15 fixtures |
| 2 | Document model, flat token store in IndexedDB, mask overlay + zero-reflow renderer | re-mask < 4 ms on a 20 k-word doc |
| 3 | Sniff + structure detection (screenplay/stage/lyrics/prose), two-pass + Viterbi, review UI | cue F1 ≥ 0.95 on fixtures 1, 6, 7, 9 |
| 4 | PDF: worker, geometry lines, headers/footers, de-hyphenation, columns, scanned detection | fixtures 1–5 pass |
| 5 | Chunking + per-chunk progress keys; role isolation (3 view modes) | fixtures 6, 7 produce sane speeches |
| 6 | Manual correction UI + overrides + Fountain in/out | "apply to all like this" works |
| 7 | .docx + .rtf; AI assist with verification | fixtures 9–11 pass |
| 8 | OCR (opt-in) + photo import + Share Target | fixture 2 round-trips |

**Top risks, ranked.** (1) PDF geometry reconstruction is the only genuinely hard part — timebox it and
keep the "paste instead" fallback prominent forever. (2) Structure-detection accuracy is a long tail;
the review UI and "apply to all" are what make imperfect detection acceptable, so build them *before*
polishing heuristics. (3) The re-clean/progress invalidation problem (§2.6) will bite if deferred —
put `revision` and `chunk.key` in the schema on day one even if migration is stubbed. (4) OCR's
multi-megabyte download is a UX cliff; the OS-handoff path is genuinely better on mobile and costs
nothing, so ship that and treat in-app OCR as optional forever.
