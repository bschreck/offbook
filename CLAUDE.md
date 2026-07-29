# Offbook — working agreements

Read `PLAN.md` §0.0 (amendments) before anything else. It overrides the rest of the plan.

## What this is

A free, local-first PWA for learning a text by heart by progressively hiding it. No account, no
server, no paywall, no limit on texts. Everything lives in IndexedDB on the user's device.

## The invariants that must never break

1. **Zero reflow on mask/reveal.** A word never moves when it hides. Spatial memory of the page
   is part of how people learn lines. The mechanism is `visibility: hidden` on an inner span
   (`ADR-0005`), which keeps the exact advance width for free. Do not "optimise" this into
   `color: transparent`, a canvas `measureText` width, or `display: none`.
2. **Masking is deterministic and nested.** One seeded permutation per
   `(doc, method, roles, scope, reshuffle)`; each rung takes a longer prefix. The ladder index is
   deliberately NOT in the seed. Going 20% → 45% must ADD blanks, never swap them.
3. **`sourceText` is immutable.** Everything else re-derives from it. This is the only undo that
   can never fail.
4. **One function computes masking:** `computeMaskPlan(doc, spec)`. Rendering, gestures and
   progress all read the plan. Nothing else computes masking.
5. **Punctuation is never masked.** Visible commas and question marks are what keep heavily
   masked text readable as structure.
6. **`src/core/**` is pure.** No React, no DOM, no `idb`, no `Math.random()`, no `Date.now()`
   inside pure functions. Enforced by lint and by a test that walks imports.
7. **Chunk identity is a content hash**, not an index. Fixing a typo must not orphan progress.
8. **`reps` is append-only.** Nothing displays it in v1; it exists so the deferred progress model
   is a `recomputeAll()` and not a rewrite (`ADR-0006`).

## Layering

- `src/core/**` imports nothing outside `src/core/**`.
- No component imports from `src/data/**` — only stores talk to repositories.
- No store imports from `src/features/**`.

## Dependency budget

First-load JS ≤ 150 kB gz. No new dependency over 15 kB gz without an ADR.
Runtime deps, exhaustively: `react`, `react-dom`, `react-router`, `zustand`, `idb`.
`pdfjs-dist` is lazy-imported and excluded from the budget and from precache.

## Scope — the kill list

Not in v1, and not to be helpfully added: speech recognition, local Whisper, OCR, TTS,
self-recording, cloud sync, accounts, analytics, telemetry, web push, nested folders, tags,
teleprompter mode, mirror flips, command palette, multiple user profiles, URL-fragment sharing,
AI formatting assist, blur/word-shape masking, recognition-tier methods (multiple choice, word
bank, reorder), confidence/readiness numbers, spaced repetition, deadline planning, streaks, XP.

Each of these has a written reason in `PLAN.md` §3.2. If one seems obviously worth adding, the
reason is there — read it before re-litigating.

## The frozen method catalogue

Ten ids, persisted in every document and every rep, never renamed:
`hideWords`, `firstLetters`, `lineEnds`, `lineStarts`, `hideLines`, `keyWords`, `glueWords`,
`rhymes`, `chunkWindow`, `myLines`.

## Conventions

- TypeScript strict, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Biome for format and lint: 2 spaces, single quotes, semicolons, 100 columns.
- Tests in `tests/unit/**` mirroring `src/core/**`. Vitest, no globals — import from `vitest`.
- Comments explain *why*, and cite the plan section. No JSDoc on self-evident functions.

## Commands

```
npm run dev        # vite dev server
npm run check      # typecheck + lint + test — run before every commit
npm test           # vitest run
npm run build      # tsc -b && vite build
```

## Deploy

**Cloudflare Pages at the root**, `https://offbook-4ev.pages.dev`, from
`.github/workflows/deploy-cloudflare.yml` on push to `main` (ADR-0002). Because it is served at
`/`, `public/_headers` is honoured: the CSP is a real response header including
`frame-ancestors`, `/assets/*` is immutable for a year, `/sw.js` is `no-cache`, and
`_redirects` handles SPA deep links.

`deploy.yml` still builds for GitHub Pages under `VITE_BASE=/offbook/` but is
**workflow_dispatch only** — a manual escape hatch. Do not put it back on `push`: two live
origins means two separate IndexedDB libraries, and a user cannot tell which one holds their
texts.

Secrets: `CLOUDFLARE_API_TOKEN` (Account -> Cloudflare Pages -> Edit, nothing else) and
`CLOUDFLARE_ACCOUNT_ID` (32 hex chars; the workflow asserts the length, because a stray
newline surfaces as an unhelpful `code: 7003 could not route`).
