# Offbook — working agreements

Read `PLAN.md` §0.0 (amendments) before anything else. It overrides the rest of the plan.

## What this is

A free, local-first PWA for learning a text by heart by progressively hiding it. No paywall, no
limit on texts. Everything lives in IndexedDB on the user's device, and the app is fully usable
with no account at all. An **optional** account replicates that library to our own server so it
reaches a second device (`ADR-0008`); it adds a replica, it does not move the source of truth.

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
9. **The reader never awaits the network.** Sync is background-only. Every network failure is
   survivable: a server outage, an expired session or a revoked token must never stop someone
   rehearsing a text that is already on the device. No `await` on a request may sit between a
   gesture and a repaint.
10. **IndexedDB is the source of truth; the server is a replica.** Local writes land locally first
    and are pushed afterwards. Nothing is read from the server that the device needs in order to
    work, and nothing is gated behind being signed in.
11. **The password never leaves the device.** Only `authKey`, derived from it in the browser, goes
    over the wire (`ADR-0008`). The KDF constants in `src/shared/auth/kdf.ts` are a *shared
    contract*: the client and the server both compute over them, so changing one side — iteration
    count, salt derivation, normalisation — invalidates every existing login. That is a versioned,
    coordinated migration, never a tidy-up.

## Layering

- `src/core/**` imports nothing outside `src/core/**`.
- No component imports from `src/data/**` — only stores talk to repositories.
- No store imports from `src/features/**`.
- `src/shared/**` is code that must be **byte-identical on client and server** — the password KDF
  and the sync wire protocol. It may use WebCrypto (both runtimes have it); it may not touch the
  DOM, IndexedDB, `import.meta.env` or any Cloudflare binding. Both `src/**` and `functions/**`
  may import it.
- No client file imports from `functions/**`. Server code is not shipped to the browser; anything
  genuinely common belongs in `src/shared/**`.

## Dependency budget

First-load JS ≤ 150 kB gz. No new dependency over 15 kB gz without an ADR.
Runtime deps, exhaustively: `react`, `react-dom`, `react-router`, `zustand`, `idb`.
`pdfjs-dist` is lazy-imported and excluded from the budget and from precache.
The backend added no runtime dependency: `wrangler` and `@cloudflare/workers-types` are
`devDependencies` and never enter the client bundle. Sync itself is `fetch` and WebCrypto, both
already in the platform.

## Scope — the kill list

Not in v1, and not to be helpfully added: speech recognition, local Whisper, OCR, TTS,
self-recording, analytics, telemetry, web push, nested folders, tags, teleprompter mode, mirror
flips, command palette, multiple user profiles, URL-fragment sharing, AI formatting assist,
blur/word-shape masking, recognition-tier methods (multiple choice, word bank, reorder),
confidence/readiness numbers, spaced repetition, deadline planning, streaks, XP.

Each of these has a written reason in `PLAN.md` §3.2. If one seems obviously worth adding, the
reason is there — read it before re-litigating.

**One reversal, 2026-07-29: optional accounts and cloud sync are now IN** (`ADR-0008`,
`PLAN.md` §0.0 A9). They were cut for "breaks £0/no-server or the privacy promise"; the ADR pays
that bill explicitly — one Pages project with a D1 binding, no third party, and nothing leaves the
device unless you sign in. **Nothing else on the list is relaxed by this.** In particular
*analytics* and the *telemetry endpoint* shared that row and stay cut: having a server is not a
reason to send it anything about how the app is used. Web push still needs a push service and is
still out.

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
npm run dev              # vite dev server — no backend, and the app is fully usable without one
npm run check            # typecheck + lint + test — run before every commit
npm test                 # vitest run
npm run build            # tsc -b && vite build

npm run dev:api          # wrangler pages dev dist --d1=DB — the Functions + D1 stack.
                         # Needs a `npm run build` first: it serves dist/, not the vite server.
npm run db:migrate:local # apply migrations/ to the local D1 file
npm run db:migrate       # apply migrations/ to the REAL database. Not idle-curiosity safe.
```

`npm run typecheck` covers both projects: `tsc -b` for the client and
`tsc -p tsconfig.functions.json` for `functions/**`, which are compiled against
`@cloudflare/workers-types` rather than the DOM.

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

The API lives in the same Pages project: `functions/api/**` deploys with the front end, so there
is one origin, no CORS, and the existing `connect-src 'self'` CSP already permits every call
(`ADR-0008`). The D1 binding is `DB`.

Secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (32 hex chars; the workflow asserts
the length, because a stray newline surfaces as an unhelpful `code: 7003 could not route`).
The token now needs **two** permissions: `Account -> Cloudflare Pages -> Edit` **and**
`Account -> D1 -> Edit`, the latter because migrations run against the database. A token with only
the Pages scope deploys fine and then fails on `db:migrate` — check the scopes before debugging
the migration.
