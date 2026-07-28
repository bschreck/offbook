# MemoCoach clone — Technical Architecture

**Scope of this document:** the technical spine only. Product/UX/feature-set decisions live elsewhere in the plan.
**Design goals, in priority order:** (1) £0/month forever, (2) works offline on a phone with no account, (3) one developer can finish it and still maintain it in two years, (4) a 10,000-word script never janks.
**Target dir:** `/Users/ben/memocoach` (empty, greenfield). **Toolchain present:** Node 22.18, npm 10.9.

---

## 0. The one architectural idea everything else follows from

> **The memorisation engine is pure TypeScript with zero DOM and zero React. Masking a text is not a re-render — it is a CSS class swap.**

Concretely: at import time we tokenize once and persist the token model. When the user picks a method + difficulty, we compute one `Uint8Array` of **hide ranks** — for each token, the level at which it becomes hidden. We stamp that rank onto each token span as a `data-h` attribute *once*, and we inject a generated stylesheet with rules for every level. Changing difficulty from level 3 to level 4 then costs exactly one `className` mutation on the container.

This single decision cascades:
- The hard logic (tokenizer, 12 masking methods, role parsing, importers, backup migration) is pure functions → trivially unit-testable, trivially Claude-Code-editable, framework-independent.
- The React layer becomes thin and boring: lists, sheets, a settings screen. Almost no state lives in React.
- Performance stops being a framework problem. The 10k-word budget is met by CSS and `content-visibility`, not by a virtualisation library.
- If React ever becomes the wrong bet, `src/core/` moves unchanged.

Everything below is an implementation of that idea.

---

## 1. Framework

### Recommendation: **Vite 7 + React 19 + TypeScript**, `vite-plugin-pwa` for the service worker.

| Candidate | Verdict | The actual trade-off |
|---|---|---|
| **Vite + React + TS** | **CHOSEN** | We pay ~48 kB gz of runtime we don't strictly need, and we accept that React's render model is the wrong tool for the masking hot path (so we bypass it there deliberately — see §9). In exchange: the largest training corpus of any web stack, so Claude Code writes idiomatic code first time; the deepest ecosystem for the two or three libraries we'll actually reach for; and a build that is one static folder with no server concept anywhere in it. |
| Next.js static export | Rejected | Every reason to use Next — SSR, RSC, route handlers, image optimisation, middleware, ISR — is unusable in a zero-server local-first app. Static export then fights you: client-only data access needs `dynamic = 'force-static'` gymnastics, `next/image` needs a custom loader, the SW story is bolted on. You take on a large framework's upgrade treadmill for file-based routing you could have had in 40 lines. What we give up by rejecting it: file-based routing, and the ability to add a real backend later without a rewrite. That second one is a genuine loss, but our sync answer (§5) is "a JSON file", so we don't need it. |
| SvelteKit + `adapter-static` | **Close second, rejected** | Honestly the better *engineering* fit: smaller runtime (~15 kB), compiled reactivity, `<style>` scoping, and `adapter-static` produces exactly what we want. Rejected on one axis only — Claude Code produces noticeably more reliable React than Svelte 5 runes code today, and this project's whole economics rest on AI-assisted velocity. Because `src/core/` imports nothing from the UI, **this decision is cheap to reverse**: a Svelte port would rewrite ~2,500 lines of view code and reuse ~3,000 lines of engine and tests untouched. Note that as a reversal path in `docs/decisions/ADR-0001`. |
| Plain TS, no framework | Rejected | The stage view genuinely doesn't need a framework — but the library, folder tree, import wizard, role picker, settings, backup dialogs, and toasts do. Hand-rolled reactivity for those crosses over from "elegant" to "bespoke framework nobody remembers" at about week three. |
| Preact instead of React | Deferred, not rejected | Drop-in `preact/compat` alias saves ~35 kB gz. Try it **after** v1 works; if the test suite and router are green, keep it. Do not start here — debugging alias-shaped weirdness on day one is a bad trade. |

**Concrete stack:**

- React 19 + `react-dom` — function components only, no class components, no `forwardRef` (19 passes `ref` as a prop).
- `react-router` v7 in **declarative/library mode** (`createBrowserRouter` + `RouterProvider`), *not* framework mode. We want the routing primitives, not its data loaders or Vite plugin.
  - History routing (not hash) — Cloudflare Pages gives us SPA fallback for free (§2). Hash routing would be needed for GitHub Pages project sites; another reason we're not using those.
- **Zustand** for state (§6).
- **`idb`** for storage (§3).
- **No UI kit.** No Tailwind either — recommendation: plain CSS with custom properties in `src/styles/tokens.css`, plus per-feature `.css` files imported by their component. Rationale: this app has maybe 25 distinct UI surfaces and one visually critical screen (the stage). A utility framework's payoff is consistency across hundreds of screens; here it just adds a build step and 400 class names in the markup that Claude Code has to keep coherent. Trade-off named: we hand-write ~800 lines of CSS and have to be disciplined about the token file. Accept it. Use `@layer` (reset, tokens, components, utilities) so cascade order is explicit.
- Icons: hand-picked inline SVGs in `src/components/Icon.tsx`. No icon package.

**Dependency budget (enforced, written into `CLAUDE.md`):** total first-load JS ≤ **150 kB gz**; no new dependency over **15 kB gz** without an ADR. Expected runtime deps: `react`, `react-dom`, `react-router`, `zustand`, `idb` — that's it. `pdfjs-dist` is lazy-loaded and excluded from the first-load budget (§8).

---

## 2. Hosting

### Recommendation: **Cloudflare Pages**, free plan, Git integration on a private GitHub repo.

**Why it wins for this specific app:**

| | Cloudflare Pages | GitHub Pages | Netlify free | Vercel Hobby |
|---|---|---|---|---|
| Bandwidth cap | **none** | 100 GB/mo soft | 100 GB/mo hard | 100 GB/mo, then blocked |
| Private repo on free tier | **yes** | no (Pages from private repos needs Pro) | yes | yes |
| Custom domain + auto TLS | **yes, free** | yes, free | yes | yes |
| Deploy at domain **root** | yes | only with custom domain; otherwise `/repo/` subpath | yes | yes |
| SPA fallback / custom headers | **`_redirects` + `_headers` files** | neither (404.html hack only) | yes | yes |
| Builds/month | 500 | 10/hr soft | 300 build-min | generous |
| Commercial-use ToS | fine | fine | fine | **hobby = non-commercial** |

The two decisive rows are **root deploy** and **`_headers`**. A service worker's scope is capped by the path it's served from; deploying to `https://user.github.io/memocoach/` means `scope: '/memocoach/'`, a `base` config in Vite, and an ugly `start_url`. Cloudflare gives us `https://memocoach.pages.dev/` at the root, plus a `_headers` file for a strict CSP — which matters because we will have **zero external network origins** and should say so in a header.

**Files this requires in `public/`:**

```
public/_redirects
  /*   /index.html   200

public/_headers
  /*
    Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
    X-Content-Type-Options: nosniff
    Referrer-Policy: no-referrer
    Permissions-Policy: geolocation=(), camera=(), payment=()
    Cross-Origin-Opener-Policy: same-origin
  /assets/*
    Cache-Control: public, max-age=31536000, immutable
  /sw.js
    Cache-Control: no-cache
  /manifest.webmanifest
    Cache-Control: no-cache
```

Notes: `style-src 'unsafe-inline'` is required because we *inject a generated stylesheet at runtime* (§9). If that offends, switch to a nonce — Pages can't do nonces on static files, so instead build the level stylesheet into a `<style>` tag emitted by the build (levels are bounded at 10, so it's precomputable) and drop `'unsafe-inline'`. Recommendation: ship with `'unsafe-inline'` in v1, note the hardening path. `connect-src 'self'` deliberately breaks any accidental third-party call.

**Domain & HTTPS:** `*.pages.dev` includes automatic, renewing TLS — good enough to ship. If Ben wants `memocoach.app`-style branding, register at **Cloudflare Registrar** (at-cost, no markup, typically £8–12/yr for `.com`), DNS free, certificate issued and renewed automatically, no config beyond adding the custom domain in the Pages project. This is the **only line item that can ever cost money.**

**What would ever cost money (exhaustive):**
1. Domain registration (~£10/yr, optional).
2. Exceeding 500 builds/month — only if Ben pushes ~17×/day. Mitigation if it happens: build in CI and `wrangler pages deploy dist` (direct upload doesn't consume build minutes).
3. Cloudflare Workers/D1/KV beyond free tiers — only relevant if sync is ever built, and we're deferring it (§5).
4. Nothing else. There is no server, no database, no egress, no auth provider, no analytics vendor.

**Deploy flow:** connect the GitHub repo, build command `npm run build`, output `dist`, production branch `main`. Every PR gets a preview URL for free. Add `wrangler` as a devDependency so `npm run deploy` works as a manual escape hatch.

**Analytics: none in v1.** Cloudflare Web Analytics is free but injects a third-party beacon script, which breaks the "zero external origins" CSP and the privacy story. If Ben ever wants numbers, the honest cheap answer is a single counter in a Worker, not a vendor.

---

## 3. Local-first storage

### Recommendation: **IndexedDB via `idb`** (Jake Archibald, ~1.1 kB gz).

| Option | Verdict | Trade-off |
|---|---|---|
| **`idb`** | **CHOSEN** | We hand-write migrations and index lookups (~120 lines of repository code total). We give up a query engine and live queries. We get a typed, promise-based wrapper that is a thin veneer over the platform API, so there is no library abstraction to debug when IndexedDB misbehaves — and IndexedDB *does* misbehave, particularly in Safari. |
| Dexie | Rejected | ~25 kB gz for a query engine we'd use for exactly one predicate (`folderId === x`) over a few hundred rows. `liveQuery` + `dexie-react-hooks` is genuinely nice reactivity, but our dataset is small enough to hold entirely in a Zustand store and invalidate explicitly. Dexie also owns your schema-versioning ceremony, which is the one place we want full control. |
| Raw IndexedDB | Rejected | The callback/`IDBRequest` ergonomics guarantee at least one subtle bug per developer, and `idb` costs 1 kB to eliminate the whole class. |
| localStorage / OPFS / SQLite-wasm | Rejected | localStorage is synchronous, 5 MB, and string-only — usable only for a boot flag, and we don't need one. OPFS/`wa-sqlite` is ~800 kB of wasm to query 300 rows. |

### Schema

Two independent versioning axes, and keeping them separate is the important part:

- **DB version** (integer, `DB_VERSION` in `src/data/schema.ts`) governs *object stores and indexes*. Bumped only when a store or index changes. Migrated in the `upgrade` callback.
- **Record `sv` (schema version)** on each document governs the *shape of the JSON payload*. Bumped whenever e.g. `MaskConfig` gains a field. Migrated **lazily on read** by `migrateRecord()`, and written back on next save. This means adding a masking-method option never requires an IDB upgrade transaction, which is exactly what you want when the app is installed on a phone you can't debug.

```ts
// src/data/schema.ts
export const DB_NAME = 'memocoach';
export const DB_VERSION = 1;

export interface Folder { id: string; name: string; parentId: string | null;
  sort: number; createdAt: number; updatedAt: number; sv: 1 }

export interface TextDoc {
  id: string; folderId: string | null; title: string;
  source: string;                    // canonical plain text, the single source of truth
  origin: { kind: 'paste'|'txt'|'rtf'|'html'|'pdf'|'docx'; filename?: string };
  model: SerializedTextModel;        // tokens + blocks as flat offset arrays, see §9
  roles: RoleIndex | null;           // detected speakers -> block ids
  activeRoleId: string | null;
  practice: { methodId: string; level: number; config: MaskConfig; seed: number };
  stats: { openCount: number; lastLevelReached: number; lastOpenedAt: number };
  createdAt: number; updatedAt: number; sv: 1;
}

export interface SessionDoc { id: string; textId: string; startedAt: number;
  endedAt: number; methodId: string; maxLevel: number;
  revealCount: number; resetCount: number; sv: 1 }

export interface SettingsDoc { id: 'app'; theme: 'system'|'light'|'dark';
  fontScale: number; lineHeight: number; maskStyle: 'shape'|'blank'|'underscore';
  autoScrollWpm: number; keepAwake: boolean; lastBackupAt: number | null; sv: 1 }
```

Stores and indexes:

| Store | keyPath | Indexes |
|---|---|---|
| `folders` | `id` | `by-parent` (`parentId`) |
| `texts` | `id` | `by-folder` (`folderId`), `by-updated` (`updatedAt`), `by-opened` (`stats.lastOpenedAt`) |
| `sessions` | `id` | `by-text` (`textId`), `by-started` (`startedAt`) |
| `settings` | `id` | — |

Migration skeleton — the fall-through switch is deliberate, it is the only pattern that survives a user who skipped four versions:

```ts
// src/data/db.ts
export const dbPromise = openDB<MemoDB>(DB_NAME, DB_VERSION, {
  upgrade(db, oldVersion, _newVersion, tx) {
    switch (oldVersion) {
      case 0: {
        const t = db.createObjectStore('texts', { keyPath: 'id' });
        t.createIndex('by-folder', 'folderId');
        t.createIndex('by-updated', 'updatedAt');
        t.createIndex('by-opened', 'stats.lastOpenedAt');
        const f = db.createObjectStore('folders', { keyPath: 'id' });
        f.createIndex('by-parent', 'parentId');
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('by-text', 'textId');
        s.createIndex('by-started', 'startedAt');
        db.createObjectStore('settings', { keyPath: 'id' });
      }
      // falls through
      // case 1: … next migration goes here, no break
    }
  },
  blocked() { /* another tab holds an old version */ },
  blocking() { /* we are the old version: close and prompt reload */ },
  terminated() { /* Safari killed the connection: reopen lazily */ },
});
```

`blocking`/`terminated` are not optional garnish — Safari terminates IDB connections aggressively when a PWA is backgrounded, and the app must reopen the DB rather than throw mid-rehearsal. Every repository call goes through `await dbPromise` so a reopen is transparent.

**Never store the imported binary.** Store the extracted plain text plus `origin.filename`. A 3 MB PDF becomes 40 kB of text. This keeps the whole library within a few MB even with hundreds of scripts, which is the single best defence against every quota problem below.

### Quota reality, and eviction

Numbers to design against (verify with `navigator.storage.estimate()` at runtime rather than trusting any doc, including this one):

- **Chromium (Android/desktop):** ~60% of free disk as a per-origin-group budget. Effectively unlimited for us.
- **Firefox:** ~10% of disk, 10 GB cap per group. Fine.
- **iOS/macOS Safari:** roughly ~1 GB per origin, with a browser-managed pool. Also fine on size — **size is not our problem on Safari; eviction is.**

**The Safari 7-day rule is the real risk.** For a site the user has *not* installed to the Home Screen, all script-writable storage (IndexedDB, Cache API, service worker, localStorage) is deleted after ~7 days without user interaction with that site. An actor who rehearses a play, books out for a fortnight, and comes back to an empty library will (correctly) conclude the app is broken. Additionally, on any browser: "Clear website data", private browsing, low-disk pressure, and iOS offloading can wipe it.

`navigator.storage.persist()` is honoured on Chromium (auto-granted for installed/high-engagement sites) and Firefox (prompts), but **must not be relied on for Safari** — treat a `false` result as the expected case. Call it anyway, log the result, and show it in Settings.

**Mitigations, in order of how much they actually help:**

1. **Push installation hard.** An installed (Home Screen) PWA is exempt from the 7-day rule. This turns the install prompt from a nice-to-have into a *data-integrity feature*, and justifies a prominent, dismissible "Install to keep your scripts" banner on iOS Safari (§4).
2. **Backup nudge with teeth.** Track `settings.lastBackupAt`. If it's null, or >14 days old and the library has changed, show a non-modal amber bar: "Back up your 12 scripts (one file)". One tap → download JSON (§5). This is the actual safety net; everything else is best-effort.
3. **`navigator.storage.persist()`** on first successful write, and surface `estimate()` in Settings as "Using 1.8 MB of ~1 GB".
4. **Detect the wipe and say so.** On boot, if IDB opens at version 0 (fresh) but `localStorage.memocoach.hadData === '1'`, we know storage was evicted. Show a clear one-time message: "Your browser cleared this site's data. Restore from a backup file." Using localStorage as the tripwire is deliberate — it's usually evicted *together with* IDB, so a surviving flag with a missing DB is a strong signal, and a false negative just means no message.
5. **Ship first-party sample texts** so a wiped app isn't an empty void.

Explicit non-goal: we do not attempt to defeat eviction with tricks (silent audio, background sync pings). It's user-hostile and it doesn't work.

---

## 4. PWA specifics

### Plugin & service worker strategy

`vite-plugin-pwa` in **`generateSW`** mode (Workbox under the hood). Not `injectManifest` — we have no custom SW logic worth owning.

```ts
// vite.config.ts (excerpt)
VitePWA({
  registerType: 'prompt',
  includeAssets: ['favicon.svg', 'icons/apple-touch-icon-180.png', 'fonts/*.woff2'],
  workbox: {
    globPatterns: ['**/*.{js,css,html,woff2,svg,png,webmanifest}'],
    globIgnores: ['**/pdf.worker*.js', '**/pdfjs-*.js'],   // ~400 kB, not on the install path
    navigateFallback: '/index.html',
    navigateFallbackDenylist: [/^\/_/],
    cleanupOutdatedCaches: true,
    clientsClaim: false,
    skipWaiting: false,
    maximumFileSizeToCacheInBytes: 3_000_000,
    runtimeCaching: [{
      // exactly one rule: lazily-loaded chunks (pdf.js) cached on first use,
      // so PDF import works offline from the second time onwards.
      urlPattern: ({ url, request }) =>
        url.origin === self.location.origin &&
        url.pathname.startsWith('/assets/') && request.destination === 'script',
      handler: 'CacheFirst',
      options: { cacheName: 'lazy-chunks', expiration: { maxEntries: 30 } },
    }],
  },
  manifest: { /* see below */ },
})
```

Rationale for each unusual choice:

- **Precache the shell, one runtime rule, no API caching.** There is no API. The single runtime rule exists only so that the 400 kB pdf.js chunk isn't forced onto every user's first install but still becomes available offline after one use. Trade-off named: a user's *first ever* PDF import must be online.
- **`registerType: 'prompt'`, `skipWaiting: false`.** Auto-updating would swap the JS bundle under an actor mid-scene; with hashed assets that's usually survivable, but "usually" is not a rehearsal guarantee. Instead: `useUpdatePrompt()` surfaces a "New version ready — Reload" toast, and we also call `updateSW()` automatically if `document.visibilityState === 'hidden'` and no practice session is active. Cost: some users run a stale version for days. Acceptable — there's no server contract to break.
- **`cleanupOutdatedCaches: true`** so we don't accumulate dead precaches against Safari's quota.

### Manifest

```json
{
  "id": "/",
  "name": "MemoCoach — memorise lines & lyrics",
  "short_name": "MemoCoach",
  "start_url": "/?src=pwa",
  "scope": "/",
  "display": "standalone",
  "display_override": ["standalone", "minimal-ui"],
  "orientation": "any",
  "background_color": "#0b0b0c",
  "theme_color": "#0b0b0c",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "screenshots": [
    { "src": "/screens/stage.png", "sizes": "1170x2532", "type": "image/png", "form_factor": "narrow" },
    { "src": "/screens/library-wide.png", "sizes": "1440x900", "type": "image/png", "form_factor": "wide" }
  ],
  "categories": ["education", "productivity"],
  "share_target": {
    "action": "/import",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": { "title": "title", "text": "text",
      "files": [{ "name": "file", "accept": ["text/plain", "text/rtf", "text/html", "application/pdf"] }] }
  },
  "file_handlers": [
    { "action": "/import", "accept": { "text/plain": [".txt"], "application/pdf": [".pdf"], "text/rtf": [".rtf"] } }
  ]
}
```

`share_target` and `file_handlers` are Chromium-only and cost ~30 lines to support (a POST handler in the SW that stashes the payload in IDB then redirects to `/import`). They deliver the single nicest import flow on Android — "Share → MemoCoach" from an email attachment. Build them **after** v1 works; keep them in the manifest from the start so the plumbing is anticipated. Note: `share_target` with `method: POST` **requires** custom SW logic, so adding it means switching to `injectManifest` — plan that as the trigger for the mode change, not a surprise.

`screenshots` are what make Android's install UI look like an app store card rather than a bookmark prompt. Worth the 20 minutes.

**`theme_color` for both schemes** must be done in HTML, not the manifest (the manifest supports only one):
```html
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0b0c" media="(prefers-color-scheme: dark)">
```

### Install prompts

- **Android/desktop Chromium:** capture `beforeinstallprompt`, stash the event, show our own "Install" button in Settings and in the storage banner, call `prompt()` on click. Listen for `appinstalled` to hide it.
- **iOS Safari: there is no install API.** Detect `isIOS && isSafari && !isStandalone` and show a bespoke sheet with the actual gesture illustrated: Share → *Add to Home Screen*. Standalone detection: `window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true`. Because installation protects their data (§3), this sheet is worth designing properly rather than hiding in an about page.
- **Never auto-open the sheet on first load.** Show it after the user has created their first text — i.e. once they have something to lose.

### iOS standalone quirks — the checklist that will actually bite

1. **Safe areas.** `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` plus `padding: env(safe-area-inset-top) env(safe-area-inset-right) …`. Without this the stage text sits under the notch and the bottom control bar under the home indicator.
2. **`100vh` is a lie.** Use `100dvh` (with a `100vh` fallback) for the stage container, or the auto-scroll viewport maths is wrong by the height of the URL bar.
3. **Rubber-band scroll.** `overscroll-behavior: contain` on the stage scroller and `overscroll-behavior-y: none` on `body`, so pull-down doesn't bounce the whole app while reciting.
4. **Long-press = text selection + magnifier + context menu.** Our headline gesture (long-press a hidden word to peek) collides with iOS's native long-press. Required: `-webkit-touch-callout: none` and `user-select: none` on the stage, `touch-action: manipulation`, a `pointerdown` timer (~350 ms) with a movement-cancel threshold (~8 px so a scroll isn't a peek), and `preventDefault()` on `contextmenu` within the stage. Implement once in `useLongPressReveal.ts` with Pointer Events (not Touch Events) so desktop mouse and stylus work identically. Test on a real iPhone — the simulator lies about this.
5. **No `beforeinstallprompt`, no `getInstalledRelatedApps`.** Covered above.
6. **`apple-mobile-web-app-status-bar-style` = `black-translucent`** to get edge-to-edge; combine with (1) or you lose the top of the text.
7. **Screen Wake Lock is unsupported on iOS Safari.** This is a real UX wound for a rehearsal app — you recite for four minutes without touching the screen, and it locks. Options: (a) accept it, and show a one-time tip "Settings → Display → Auto-Lock → Never while rehearsing"; (b) the silent-looping-`<video>` hack, which works but burns battery, is fragile across iOS versions, and can interfere with other audio. **Recommendation: (a).** Use the real `navigator.wakeLock` where it exists (Chromium, Safari 16.4+ on macOS) behind a `keepAwake` setting, and show the tip on iOS. Do not ship the video hack.
8. **Sudden termination.** iOS kills backgrounded web apps without warning. Persist practice progress on `visibilitychange → hidden` and on `pagehide`, never only on unmount, and never with a debounce longer than ~500 ms.
9. **In-app browsers** (Instagram, LinkedIn) can't install PWAs at all. Detect obvious UA markers and show "Open in Safari to install".

### Offline TTS / voices caveat (matters if we build the scene-partner differentiator)

- `speechSynthesis.getVoices()` returns `[]` on first call in Safari and Chrome; you must wait for `voiceschanged`. Write `getVoicesAsync()` once, with a timeout fallback.
- **Voice availability offline is device-dependent and cannot be assumed.** iOS ships on-device voices, so basic TTS usually survives offline; Chrome's best-sounding voices are network-backed (`voice.localService === false`) and will fail or silently substitute when offline.
- Therefore: filter to `localService === true` when `navigator.onLine === false`, and if the filtered list is empty, disable the feature with an honest message rather than producing silence. **Never let a missing voice block the core hide-and-recall loop** — TTS is strictly additive.
- iOS requires a user gesture before the first `speak()`. Prime it inside the "Start" tap.
- **`SpeechRecognition` (the recognition-scoring differentiator) is network-dependent on both Safari and Chrome** and is `webkit`-prefixed and absent on Firefox. If built, it must be labelled "needs internet", must degrade to manual self-scoring, and must never be on the offline critical path.

---

## 5. Sync — **explicit recommendation: DEFER. Do not build sync in v1 or v2.**

Reasoning stated plainly: sync means identity, identity means accounts, accounts mean password resets, abuse, a privacy policy, GDPR obligations, and a service that must stay up for years or people lose their scripts. That is the entire maintenance cost of the project, incurred for a feature whose real user need is "I don't want to lose my texts" — which a **file** solves completely, offline, for free, forever.

### v1: file-based backup / restore (build this, it's ~250 lines)

**Envelope** — versioned, self-describing, human-diffable:

```json
{
  "format": "memocoach.backup",
  "formatVersion": 1,
  "exportedAt": "2026-07-28T12:04:11.000Z",
  "app": { "version": "1.2.0" },
  "counts": { "folders": 3, "texts": 12, "sessions": 88 },
  "data": { "folders": [...], "texts": [...], "sessions": [...], "settings": {...} }
}
```

Design decisions:

- **Plain JSON, not zipped.** 12 scripts ≈ 400 kB, ≈ 90 kB after HTTP compression on download. Zipping costs a dep and makes the file opaque. If libraries ever get huge, add gzip via `CompressionStream` (baseline in all target browsers) behind a size threshold.
- **Omit `model`** (the token model) from export and recompute it on import from `source`. It's derived data, it's ~40% of the payload, and omitting it means a backup made by v1 imports cleanly into v5 with a completely rewritten tokenizer. This is the single most valuable line in the format.
- **Save path:** `Blob` + `URL.createObjectURL` + `<a download>` on desktop and Android. On iOS standalone, `<a download>` is unreliable — feature-detect and prefer `navigator.share({ files: [new File(...)] })` so it lands in Files/iCloud Drive/AirDrop, with "copy JSON to clipboard" as the last-resort fallback. Implement all three in `core/backup/export.ts` with one `saveBackup()` entry point.
- **Restore is a merge, never a replace.** `<input type="file" accept=".json,application/json">` → validate → per-record `updatedAt`-wins → **never delete anything** → show a summary dialog *before* committing ("3 new, 2 updated, 7 unchanged, 0 skipped") in a single IDB transaction. Restoring the same file twice must be a no-op. A destructive "Replace everything" exists but behind a typed confirmation.
- **Validation is hand-written**, not Zod. `core/backup/validate.ts` returns `{ ok: true, data } | { ok: false, errors: string[] }` with per-record tolerance (one corrupt text does not fail the file). ~80 lines, no dependency, and it doubles as the version-migration seam (`migrateBackup(v1 → current)`). Trade-off named: we write the narrowing by hand instead of deriving it from a schema; the payoff is that partial recovery from a damaged file is expressible, which a schema validator makes awkward.
- **Also ship per-text export** (`.txt` for the raw lines, `.json` for the full text with masking config) so a scene partner can be handed one scene without the whole library. This is the real-world "sharing" need, and it's free once `export.ts` exists.
- **Auto-backup on desktop Chromium (nice-to-have, v2):** File System Access API — user picks a folder once, we persist the `FileSystemDirectoryHandle` in IDB, and write `memocoach-backup.json` on a debounced change. Real sync-grade safety, zero infrastructure, ~60 lines. Chromium-only; no iOS.

### If sync is ever genuinely wanted, in cost order

1. **Manual file over iCloud Drive / Dropbox (£0, 0 lines).** The auto-backup handle above pointed at a synced folder *is* sync on desktop. Document it as a tip.
2. **Google Drive `appDataFolder` (£0 infra, ~200 lines).** OAuth in the browser, one JSON blob in a hidden per-app folder, `ETag`-based conflict detection. We store nothing, we're not a data controller, the user owns and can delete the file. **This is the recommended path if sync becomes a real requirement** — it has no running cost and no ops.
3. **Cloudflare Workers + D1 (£0 within free tier: 5 GB storage, 5 M row-reads/day).** Device-pairing code instead of accounts, per-record last-write-wins with a Lamport counter. Credible and cheap, but it makes Ben a data controller with an uptime obligation. Only if (2) is somehow unacceptable.
4. Supabase free tier — rejected: free Postgres projects get paused after ~1 week of inactivity, which is the precise failure mode a rehearsal app hits.

Write this ordering into `docs/decisions/ADR-0004` so the deferral is a decision with a documented exit, not an omission.

---

## 6. State management & routing

### Three tiers, kept strictly separate — this separation is a performance decision, not tidiness

| Tier | Where it lives | Why |
|---|---|---|
| **Persistent domain data** (folders, texts, sessions, settings) | IndexedDB, behind repositories, mirrored into **Zustand** stores loaded on boot | Small dataset (hundreds of rows), so a full in-memory mirror is simplest and fastest. Writes go `action → repo (IDB) → store update`, never the reverse. |
| **Practice-session runtime** (current level, elapsed, autoscroll state) | A **separate** `sessionStore` | If this shared a store with the library, every autoscroll tick would notify library subscribers. Separate store = separate subscriber set. |
| **Hot per-token state** (which words are currently peeked) | **Not in React or Zustand at all** — a `Set<number>` in a ref, applied by direct `data-revealed` attribute writes | A peek must land in <8 ms and must not re-render 400 spans. See §9. |
| **Ephemeral UI** (open sheet, toast) | `useState` / `uiStore` for cross-tree cases | Nothing gained by centralising. |

**Zustand chosen** over: Redux Toolkit (a reducer/action ceremony tax for an app with no async server state), plain Context (any change re-renders every consumer — fatal for the stage), Jotai/Valtio (fine, but proxy-based reactivity makes the "why did this render" question harder to answer, and Zustand's `subscribeWithSelector` covers our one advanced need), TanStack Query (it's a server-cache; we have no server).

Store shape convention — state and actions in one slice, selectors exported as named functions so components never destructure whole stores:

```ts
// src/stores/libraryStore.ts
interface LibraryState {
  texts: Record<string, TextDoc>;
  folders: Record<string, Folder>;
  status: 'idle' | 'loading' | 'ready' | 'error';
  load(): Promise<void>;
  createText(input: NewTextInput): Promise<string>;
  updateText(id: string, patch: Partial<TextDoc>): Promise<void>;
  deleteText(id: string): Promise<void>;
  moveToFolder(id: string, folderId: string | null): Promise<void>;
}
export const selectTextsInFolder = (id: string | null) => (s: LibraryState) => …
```

Rules written into `CLAUDE.md`:
- No component imports from `src/data/**`. Only stores talk to repositories.
- No store imports from `src/features/**`.
- `src/core/**` imports nothing outside `src/core/**` — no React, no `window`, no `idb`. Enforce with a Biome/`no-restricted-imports` rule and one Vitest test that greps the imports.

### Routing

`react-router` v7, `createBrowserRouter`, six routes:

| Path | Screen |
|---|---|
| `/` | Library (folders + texts, search) |
| `/t/:id` | Text detail: preview, role picker, method + difficulty setup |
| `/t/:id/practice` | Stage (fullscreen, the performance-critical screen) |
| `/import` | Paste / file / share-target landing |
| `/settings` | Appearance, storage, backup, install, TTS |
| `/about` | Help, method explanations, credits |

- **Lazy-load `/import` and `/settings`** via `React.lazy` (import pulls in the RTF/HTML/PDF path). `/` and the stage are in the main chunk — the stage must never wait on a network fetch.
- `/t/:id/practice` sets `display: standalone`-friendly fullscreen chrome and locks body scroll.
- Route-level `ErrorBoundary` per route plus a root one; a thrown error inside the stage must not blank the library.
- Deep links matter: a URL like `/t/abc/practice` should be shareable to yourself across your own devices *conceptually*, but IDs are local — so the route must handle "unknown id" gracefully with "This script isn't on this device. Restore a backup?"

---

## 7. Repository layout

```
/Users/ben/memocoach
├── .github/workflows/ci.yml
├── .gitignore
├── .nvmrc                                  # 22
├── biome.json
├── index.html
├── package.json
├── playwright.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── vitest.config.ts
├── CLAUDE.md                               # invariants + dep budget + conventions
├── README.md
├── docs/
│   ├── architecture.md                     # this document, trimmed
│   ├── methods.md                          # spec of every masking method
│   └── decisions/
│       ├── ADR-0001-framework-vite-react.md
│       ├── ADR-0002-hosting-cloudflare-pages.md
│       ├── ADR-0003-storage-idb-vs-dexie.md
│       ├── ADR-0004-defer-sync.md
│       └── ADR-0005-css-masking-not-rerender.md
├── public/
│   ├── _headers
│   ├── _redirects
│   ├── favicon.svg
│   ├── fonts/
│   │   ├── inter-var-latin.woff2
│   │   └── literata-var-latin.woff2        # serif option for scripts
│   ├── icons/
│   │   ├── icon-192.png
│   │   ├── icon-512.png
│   │   ├── maskable-512.png
│   │   └── apple-touch-icon-180.png
│   ├── screens/
│   │   ├── stage.png
│   │   └── library-wide.png
│   └── samples/
│       ├── hamlet-soliloquy.txt
│       └── wedding-speech.txt
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── router.tsx
│   ├── vite-env.d.ts
│   │
│   ├── core/                               # PURE TS. no react, no DOM, no idb.
│   │   ├── text/
│   │   │   ├── model.ts                    # Token, Block, TextModel, Serialized*
│   │   │   ├── tokenize.ts                 # source -> tokens (offset pairs)
│   │   │   ├── blocks.ts                   # tokens -> lines / paragraphs / cue units
│   │   │   ├── normalise.ts                # smart quotes, dashes, whitespace, BOM
│   │   │   └── serialize.ts                # TextModel <-> flat arrays for IDB
│   │   ├── script/
│   │   │   ├── parseScript.ts              # "NAME:", ALLCAPS line, Fountain-ish
│   │   │   ├── detectRoles.ts              # speaker frequency + heuristics
│   │   │   └── roleFilter.ts               # my lines vs cue lines
│   │   ├── mask/
│   │   │   ├── types.ts                    # MaskMethod, MaskConfig, MAX_LEVEL
│   │   │   ├── rank.ts                     # computeHideRanks() -> Uint8Array
│   │   │   ├── rng.ts                      # mulberry32 seeded PRNG
│   │   │   ├── stylesheet.ts               # generateLevelCss(maxLevel)
│   │   │   └── methods/
│   │   │       ├── index.ts                # registry: id -> MaskMethod
│   │   │       ├── randomWords.ts
│   │   │       ├── everyNthWord.ts
│   │   │       ├── longWordsFirst.ts
│   │   │       ├── contentWordsFirst.ts    # nouns/verbs before function words
│   │   │       ├── firstLetters.ts
│   │   │       ├── initialsOnly.ts
│   │   │       ├── hideLines.ts
│   │   │       ├── lineEndings.ts
│   │   │       ├── creepFromEnd.ts
│   │   │       ├── creepFromStart.ts
│   │   │       ├── keywordsOnly.ts
│   │   │       └── everythingAtOnce.ts
│   │   ├── importers/
│   │   │   ├── index.ts                    # dispatch by mime/extension
│   │   │   ├── txt.ts
│   │   │   ├── rtf.ts                      # hand-rolled control-word stripper
│   │   │   ├── html.ts                     # DOMParser text walk (detached doc)
│   │   │   ├── pdf.ts                      # lazy pdfjs-dist + line reconstruction
│   │   │   └── docx.ts                     # optional: zip + document.xml
│   │   ├── backup/
│   │   │   ├── types.ts
│   │   │   ├── export.ts
│   │   │   ├── import.ts
│   │   │   ├── validate.ts
│   │   │   └── migrate.ts
│   │   └── util/
│   │       ├── id.ts                       # crypto.randomUUID w/ fallback
│   │       ├── hash.ts                     # cheap config hash for memo keys
│   │       ├── result.ts                   # Result<T,E>
│   │       └── assert.ts
│   │
│   ├── data/                               # only layer that touches IndexedDB
│   │   ├── db.ts
│   │   ├── schema.ts
│   │   ├── migrateRecord.ts                # record-level `sv` migrations
│   │   ├── storageInfo.ts                  # estimate() + persist() + eviction tripwire
│   │   └── repos/
│   │       ├── texts.ts
│   │       ├── folders.ts
│   │       ├── sessions.ts
│   │       └── settings.ts
│   │
│   ├── stores/
│   │   ├── libraryStore.ts
│   │   ├── sessionStore.ts
│   │   ├── settingsStore.ts
│   │   └── uiStore.ts
│   │
│   ├── routes/
│   │   ├── LibraryRoute.tsx
│   │   ├── TextRoute.tsx
│   │   ├── PracticeRoute.tsx
│   │   ├── ImportRoute.tsx
│   │   ├── SettingsRoute.tsx
│   │   ├── AboutRoute.tsx
│   │   └── NotFoundRoute.tsx
│   │
│   ├── features/
│   │   ├── library/
│   │   │   ├── LibraryList.tsx
│   │   │   ├── FolderTree.tsx
│   │   │   ├── TextCard.tsx
│   │   │   ├── SearchBar.tsx
│   │   │   └── NewTextSheet.tsx
│   │   ├── practice/
│   │   │   ├── Stage.tsx                   # scroller + level class owner
│   │   │   ├── StageBlock.tsx              # memoised; content-visibility: auto
│   │   │   ├── TokenSpan.tsx               # renders once, data-h stamped
│   │   │   ├── LevelControl.tsx            # +/- difficulty, progress dots
│   │   │   ├── RevealControls.tsx          # tap-hold peek, long-press reset
│   │   │   ├── useLongPressReveal.ts       # pointer events, imperative DOM writes
│   │   │   ├── useAutoScroll.ts            # rAF fractional scrollTop
│   │   │   ├── useLevelStylesheet.ts       # injects generated CSS once
│   │   │   └── stage.css
│   │   ├── roles/
│   │   │   ├── RolePicker.tsx
│   │   │   └── RoleBadge.tsx
│   │   ├── import/
│   │   │   ├── DropZone.tsx
│   │   │   ├── PastePanel.tsx
│   │   │   ├── FilePicker.tsx
│   │   │   └── ImportPreview.tsx           # shows parsed lines before saving
│   │   ├── backup/
│   │   │   ├── BackupPanel.tsx
│   │   │   ├── RestoreDialog.tsx
│   │   │   └── BackupNudge.tsx
│   │   └── settings/
│   │       ├── AppearanceSection.tsx
│   │       ├── StorageSection.tsx
│   │       └── VoiceSection.tsx
│   │
│   ├── components/
│   │   ├── Button.tsx
│   │   ├── IconButton.tsx
│   │   ├── Sheet.tsx                       # <dialog>-based bottom sheet
│   │   ├── Toast.tsx
│   │   ├── Icon.tsx
│   │   ├── Spinner.tsx
│   │   ├── SrOnly.tsx
│   │   └── ErrorBoundary.tsx
│   │
│   ├── hooks/
│   │   ├── useMediaQuery.ts
│   │   ├── useStandalone.ts
│   │   ├── useWakeLock.ts
│   │   ├── useUpdatePrompt.ts
│   │   └── usePersistOnHide.ts
│   │
│   ├── pwa/
│   │   ├── registerSW.ts
│   │   ├── InstallHint.tsx
│   │   └── UpdateToast.tsx
│   │
│   └── styles/
│       ├── reset.css
│       ├── tokens.css                      # colours, spacing, type scale, dark mode
│       ├── layers.css                      # @layer order declaration
│       └── app.css
│
├── tests/
│   ├── setup.ts                            # fake-indexeddb, matchMedia stub
│   ├── fixtures/
│   │   ├── hamlet-scene.txt
│   │   ├── two-hander.txt                  # role parsing
│   │   ├── lyrics-with-repeats.txt
│   │   ├── words-10k.txt                   # perf fixture
│   │   ├── sample.rtf
│   │   ├── sample.html
│   │   └── backup-v1.json
│   └── unit/                               # mirrors src/core/**
│       ├── text/…  script/…  mask/…  importers/…  backup/…
│       └── data/migrations.test.ts
│
├── bench/
│   ├── tokenize.bench.ts
│   └── rank.bench.ts
│
└── e2e/
    ├── boot-offline.spec.ts
    ├── import-practice-reload.spec.ts
    └── longpress-reveal.spec.ts
```

---

## 8. Testing

### Recommendation: **Vitest** for unit + bench, **`fake-indexeddb`** for the data layer, **`fast-check`** for masking invariants only, **Playwright** for exactly three specs.

No `@testing-library/react`, no jsdom component tests. Stated as a decision, not laziness: component tests here would assert that a button renders a label. The bugs that will actually ship are in the tokenizer, the masking maths, the RTF/PDF parsers, and record migrations — all pure functions. Testing effort goes there.

### Worth testing (target: high coverage on `src/core/**`, ~0% elsewhere)

1. **`tokenize.ts`** — table-driven. Contractions (`don't`, `y'all`), hyphens (`self-aware`), em-dashes with no spaces, ellipses, `Mr.`/`Dr.` vs sentence end, numerals (`1,200`, `3.14`), stage directions in `(parens)` and `[brackets]`, quotes and smart quotes, non-Latin (accents, `ß`), emoji, CRLF, tabs, double blank lines, trailing whitespace, empty string, one 40k-char word. Assert token offsets reconstruct the source **exactly** — that's the invariant that keeps everything else honest.
2. **`blocks.ts`** — line vs paragraph vs cue-unit segmentation; blank-line separators; a script with no blank lines.
3. **Every masking method** — one spec file each, mirroring `methods/`. Plus a shared **conformance suite** every method must pass:
   - **Monotonicity:** `hidden(level n) ⊆ hidden(level n+1)`. If this breaks, difficulty "increases" while words reappear — the most damaging possible bug and completely invisible in casual use.
   - Level 0 hides nothing; `MAX_LEVEL` hides everything maskable.
   - Determinism: same `(model, config, seed)` → identical `Uint8Array`, byte for byte. This is what makes progress resumable across reloads.
   - `ranks.length === tokens.length`; every rank in `0..MAX_LEVEL`.
   - Punctuation/whitespace tokens are never independently hidden (they're structure, not content).
   - No level hides so much that a step is unusable (each level's delta ≥ 1 token on a text of ≥ 20 tokens).
   Run this suite over the registry with `describe.each(Object.values(methods))` — new methods are then automatically covered, which is exactly the leverage you want when Claude Code adds method #13.
4. **`fast-check` property tests, scoped to `mask/`** — generate random token counts, configs, and seeds; assert monotonicity + determinism + bounds. Two dozen lines that will find edge cases hand-written tests won't (empty text, 1 token, all-punctuation, difficulty 100%). This is the one place property testing earns a dependency; don't spread it elsewhere.
5. **`parseScript.ts` / `detectRoles.ts`** — golden-file tests against real-shaped fixtures. `NAME:` form, ALLCAPS-line form, mixed, a name that's also a word (`WILL`), parenthetical stage directions, and a monologue (zero roles → must not invent one).
6. **Importers** — `rtf.ts` and `html.ts` against fixtures, asserting exact extracted text (these are the parsers most likely to be quietly wrong). `pdf.ts`: one fixture through the real pdf.js in a Node environment; the y-clustering line-reconstruction heuristic is the risky part and deserves its own unit test with synthetic text-item arrays, independent of pdf.js.
7. **`backup/validate.ts` + `migrate.ts`** — a checked-in `backup-v1.json` must import cleanly forever. Add a fixture per format version; this file set *is* your compatibility promise. Also: malformed JSON, missing fields, one corrupt record among good ones (partial recovery), and idempotence of double-import.
8. **`data/migrations.test.ts`** — with `fake-indexeddb`: open at v1, write records, reopen at v2, assert data survives and shape is upgraded. **One test per DB version bump, forever.** This is the only IDB test worth writing, and it's the one that prevents wiping a user's library on update.

### Not worth testing

React markup, CSS, store plumbing, the `idb` wrapper itself, Zustand actions that are one-line repo passthroughs, and route configuration. If a store action contains logic worth testing, that logic belongs in `core/` instead — the difficulty of testing it is the signal.

### Playwright — justified, but capped at three specs

Add it. Two failure modes are catastrophic, invisible to unit tests, and have burnt every PWA author at least once:

1. **`boot-offline.spec.ts`** — load the app, wait for SW `activated`, `context.setOffline(true)`, reload, assert the library renders. If this breaks, the app is not a PWA and nobody finds out until a user is on the Tube.
2. **`import-practice-reload.spec.ts`** — paste a script → set method + level 3 → reload → assert the same words are still hidden. Exercises the real IDB round-trip, record serialisation, and progress restore in a real browser engine. `fake-indexeddb` cannot catch a structured-clone failure on a `Uint8Array`.
3. **`longpress-reveal.spec.ts`** — with `hasTouch: true` on the WebKit project: long-press a masked word, assert it reveals; press-and-drag, assert it does *not* (scroll vs peek). This gesture is the app's signature interaction and the most iOS-fragile code we own.

Config: **Chromium + WebKit projects only** (WebKit is the proxy for the iPhone majority — imperfect, but it catches the gross failures). No Firefox. Run in CI on push to `main` and on PRs. Explicitly do **not** grow this into a feature-coverage suite; every added spec is a maintenance liability paid in flakes.

### Performance testing

`bench/` with `vitest bench` for `tokenize` and `computeHideRanks` on the 10k-word fixture, run manually and after any change to `core/mask` or `core/text` — **not a CI gate** (CI runner variance makes perf assertions flaky and everyone learns to ignore them). The budget in §9 is verified by a documented manual Chrome DevTools profile checklist in `docs/architecture.md`, repeated before each release.

---

## 9. Performance: the 10,000-word budget

### Budget (measured on a mid-range Android, e.g. Pixel 6a / Moto G, and an iPhone 12)

| Operation | Budget | Mechanism |
|---|---|---|
| First install (JS+CSS+fonts, gz) | ≤ 250 kB | small dep list, no UI kit, self-hosted subset fonts |
| Cold TTI on 4G | ≤ 2.0 s | single small bundle, no server round-trip after SW install |
| Warm start from SW cache | ≤ 400 ms | precached shell |
| Tokenize 10k words | ≤ 150 ms, **once, at import** | offsets only, single pass |
| Open a 10k-word text | ≤ 200 ms to first paint | model deserialised from flat arrays; `content-visibility` skips off-screen work |
| **Change difficulty level** | **≤ 16 ms** | **one `className` swap** |
| Long-press peek | ≤ 8 ms | one attribute write on one span |
| Reset all (long-press Reveal) | ≤ 16 ms | one attribute write on the container |
| Auto-scroll | sustained 60 fps | rAF `scrollTop`, no layout writes in the loop |
| Interaction latency (INP) | ≤ 100 ms p75 | nothing above is on a React render path |

### Mechanism 1 — tokenize once, at import; store flat offsets

`TextModel` never duplicates the text. Tokens are `{start, end, kind}` triples stored as parallel flat arrays (`Int32Array`-shaped, serialised to plain arrays for IDB), and rendering slices `source`. For 10k words: ~120 kB of numbers instead of ~2× the string data plus 10k object allocations. Deserialise = one `Int32Array.from()`. Never re-tokenize on open, on font change, or on level change.

### Mechanism 2 — precomputed hide ranks (the core trick)

```ts
// core/mask/types.ts
export const MAX_LEVEL = 10;
/** ranks[i] = the lowest level at which token i is hidden; 0 = never hidden. */
export type HideRanks = Uint8Array;
export interface MaskMethod {
  id: string; label: string;
  defaults: MaskConfig;
  rank(model: TextModel, config: MaskConfig, rng: Rng): HideRanks;
}
```

One `Uint8Array` of length `tokenCount` (10 kB for 10k words). Computed once per `(textId, methodId, configHash, seed, roleId)`, memoised in an in-memory LRU of ~4 entries, and persisted alongside the text so reopening is free. **Not** in a Web Worker: measured cost for 10k tokens is well under 20 ms, and a worker adds a serialisation boundary and a whole class of lifecycle bugs. Document the worker as the escape hatch if profiling ever shows >50 ms; do not build it speculatively.

### Mechanism 3 — CSS-only masking (a class swap, not a re-render)

Each token renders **once** as `<span data-h="4">word</span>`. A generated stylesheet holds rules for every level; `MAX_LEVEL = 10` gives 55 selectors, which is nothing:

```ts
// core/mask/stylesheet.ts
export function generateLevelCss(maxLevel = MAX_LEVEL): string {
  let css = '';
  for (let lvl = 1; lvl <= maxLevel; lvl++) {
    const sel = Array.from({ length: lvl }, (_, i) => `.stage.lvl-${lvl} [data-h="${i + 1}"]`).join(',');
    css += `${sel}{color:transparent;background:var(--mask-fill);border-radius:.15em}`;
    css += `${sel.replace(/\]/g, '][data-revealed]')}{color:inherit;background:var(--mask-peek)}`;
  }
  return css;
}
```

Injected once into a `<style>` element on mount (or emitted at build time if we want to drop `'unsafe-inline'` from the CSP). Changing level 3 → 4 is then:

```ts
stageRef.current.className = `stage lvl-${level}`;
```

No React render. No DOM mutation beyond one string. The browser does a style recalc + paint over *visible* spans only. This is the difference between 16 ms and 300 ms, and it is why `MAX_LEVEL` is a small constant rather than a percentage — bounded levels are what make the stylesheet precomputable. Record it as `ADR-0005` because it's the non-obvious decision a future refactor would innocently destroy.

### Mechanism 4 — **zero-reflow masking is the default**

Masked words keep their glyphs, set to `color: transparent`, with a background fill. Consequences, both wanted:

- **No reflow.** Line breaks never move when difficulty changes, so the actor's spatial memory of the page holds and the eye doesn't lose its place. Only paint changes.
- **Word length remains a cue**, which is pedagogically correct for early levels — and by making it a *setting* (`maskStyle: 'shape' | 'blank' | 'underscore'`) we get a legitimate extra difficulty axis. `'blank'` (fixed-width) *does* reflow; it's still fine (a few hundred visible spans, ~5 ms) but must not be the default.

Two caveats to handle explicitly:
- **Copy/select leaks the text.** Transparent text is still real text. Mitigation: `user-select: none` on the stage (also needed for long-press anyway). We are not building DRM — a determined user can View Source. Fine: state it and move on.
- **Screen readers read hidden words.** Wrap masked token text so AT gets `aria-hidden` plus an `SrOnly` "blank" marker at the block level; the practising user can still hear their cue lines. Not perfect, but honest and cheap.

### Mechanism 5 — `content-visibility: auto` instead of a virtualisation library

Every block (`StageBlock`) gets:

```css
.stage-block { content-visibility: auto; contain-intrinsic-size: auto var(--est-h); }
```

The browser skips style, layout, and paint for off-screen blocks — so a class swap on the container recalculates only what's on screen, even with 10k spans in the DOM. Supported in Chromium and Safari 18+; on older Safari it degrades to rendering everything, which is slower but correct.

Chosen over `@tanstack/react-virtual` / manual windowing, and this is a deliberate trade:

- **Kept:** native find-in-page, full text selection, correct scrollbar and `scrollHeight` (so auto-scroll maths is exact and `scrollIntoView` works), zero measurement code, no virtualisation/auto-scroll interaction bugs, no dependency, one code path for a 40-word lyric and a 10k-word script.
- **Given up:** the initial DOM build for 10k spans still costs real time (~100–200 ms on a mid Android) and memory (~10–20 MB). That's inside the 200 ms open budget, but only just.
- **Escape hatch, documented not built:** if profiling on real devices shows the DOM build is too slow, add windowing *by block* with `@tanstack/react-virtual`. `contain-intrinsic-size` from a token-count estimate keeps the scrollbar honest in the meantime; the `auto` keyword makes the browser remember real measured sizes after first render.

### Mechanism 6 — React kept off the hot path

- `StageBlock` is `React.memo`'d on `(blockId, ranksVersion, roleFilterVersion)`. Token spans are created once per block and never re-created for level or peek changes.
- The peeked-token set lives in a `ref`, and peeking writes `el.toggleAttribute('data-revealed')` directly. Zustand isn't involved; React isn't involved.
- Auto-scroll runs a single rAF loop accumulating fractional pixels into `scroller.scrollTop`, reads no layout inside the loop (cache `scrollHeight`/`clientHeight`, invalidate on `resize`/`ResizeObserver`), and writes nothing to React state. Elapsed-time UI updates via a 1 Hz interval, not per frame.
- Font-size and line-height are CSS custom properties on the stage root — changing them never touches the model or triggers a re-render.
- Practice progress persists on a 500 ms debounce **and** on `visibilitychange`/`pagehide` (iOS kills backgrounded apps without warning).

### Mechanism 7 — bundle discipline

- `pdfjs-dist` behind `await import()` on the import route only, excluded from precache, cached on first use (§4). It's ~400 kB and must never touch the stage's critical path.
- Self-hosted variable fonts, latin subset only, `font-display: swap`, `<link rel="preload">` for the one face used on the stage.
- `rollup-plugin-visualizer` wired to `npm run analyze`; check it before every release against the 150 kB budget.
- Manual chunks: default Vite splitting is fine; do not hand-tune until the visualiser says otherwise.

---

## 10. Build, TypeScript, linting, scripts

### Vite config shape

```ts
// vite.config.ts
export default defineConfig({
  plugins: [react(), VitePWA({ /* §4 */ }), visualizer({ open: false, filename: 'stats.html' })],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { target: 'es2022', sourcemap: true, cssCodeSplit: true,
           reportCompressedSize: true, chunkSizeWarningLimit: 200 },
  server: { host: true },   // so a real iPhone on the LAN can hit the dev server
});
```

`sourcemap: true` in production: it costs nothing (maps aren't downloaded unless DevTools is open) and it's the only way to debug a real iPhone.
`server: { host: true }` matters more than it looks — the long-press and safe-area work **must** be tested on a physical phone, and for a service worker on LAN you'll need a trusted local HTTPS cert (`vite-plugin-mkcert`, devDependency only) since SW requires a secure context on non-localhost origins.

### TypeScript posture — strict, plus the two flags people skip

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": false,   // the DB upgrade switch falls through on purpose
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["vite/client", "vite-plugin-pwa/client"],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "tests", "bench", "e2e"]
}
```

- **`noUncheckedIndexedAccess: true`** is the load-bearing one. This codebase indexes token arrays constantly (`tokens[i - 1]`, `blocks[b].tokenEnd`), which is precisely where off-by-one bugs hide. The friction (explicit guards or `!` at genuinely-safe sites) is worth it here in a way it wouldn't be in a CRUD app. Where perf-critical loops make guards noisy, use a local `const t = tokens[i]; if (t === undefined) continue;` — or drop to typed arrays, where indexing returns `number` and the flag doesn't fire. That's a small extra argument for the flat-array model in §9.
- **`exactOptionalPropertyTypes: true`** because we spread `Partial<TextDoc>` patches into IDB records; without it, `{ folderId: undefined }` silently overwrites a real value.
- `noFallthroughCasesInSwitch` is explicitly **off** with a comment — the migration pattern requires fall-through, and fighting the linter over it produces worse migrations.
- One alias only (`@/*`). More aliases = more ways for Claude Code to write an import that resolves in the editor but not in Vitest.

### Linting & formatting: **Biome 2** (one dep, replaces ESLint + Prettier)

Chosen over ESLint 9 flat config + typescript-eslint + Prettier + 4 plugins. Trade-off named honestly: **we lose the type-aware rules**, of which `no-floating-promises` is the one that would genuinely have caught bugs. Mitigations: `npm run typecheck` runs in CI and pre-push (catching most of what type-aware lint catches); the async surface is small and confined to `data/` and store actions; Biome's type-informed rules are improving and can be enabled as they stabilise. If a floating-promise bug ever ships, that's the trigger to add ESLint for that single rule — written down in `CLAUDE.md` so the decision has a tripwire rather than being permanent by inertia.

`biome.json` essentials: formatter on (2 spaces, single quotes, 100 cols, trailing commas), recommended lint rules, plus custom `noRestrictedImports` enforcing the layering from §6 — `src/core/**` may not import `react`, `zustand`, `idb`, or anything from `@/data`, `@/stores`, `@/features`. That rule is what keeps the architecture from eroding in month three, and it's cheap to add now. Back it with one Vitest test that walks `src/core/**` imports, so it holds even if the lint config drifts.

### `package.json` scripts

```json
{
  "scripts": {
    "dev": "vite",
    "dev:https": "vite --https",
    "build": "npm run typecheck && vite build",
    "preview": "vite preview --host",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:cov": "vitest run --coverage",
    "bench": "vitest bench --run",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "format": "biome format --write .",
    "check": "npm run typecheck && npm run lint && npm run test",
    "e2e": "playwright test",
    "e2e:ui": "playwright test --ui",
    "e2e:install": "playwright install --with-deps chromium webkit",
    "analyze": "vite build && open stats.html",
    "icons": "node scripts/gen-icons.mjs",
    "deploy": "npm run build && wrangler pages deploy dist --project-name=memocoach",
    "prepare": "husky || true"
  }
}
```

`npm run check` is the single command CI and Claude Code both use; keep it fast (<20 s) or it gets skipped. Git hooks: one pre-commit `biome check --write --staged` and nothing else — a pre-commit test run that takes 20 s trains you to use `--no-verify`.

### CI (`.github/workflows/ci.yml`)

One workflow, `push` + `pull_request`: setup Node 22 with npm cache → `npm ci` → `npm run check` → `npx playwright install --with-deps chromium webkit` → `npm run e2e` (only on `main` and PRs touching `src/`, to keep it quick). **No deploy step** — Cloudflare Pages builds from the repo itself; duplicating it in CI just burns minutes and creates two ways to ship. Free tier: public repos unlimited, private repos 2,000 min/month, and this workflow costs ~3 min/run.

---

## 11. Risk register & reversal costs

| Risk | Likelihood | Impact | Response |
|---|---|---|---|
| Safari evicts a user's library | **High** for non-installed users | Severe (data loss) | Install push + backup nudge + eviction detection (§3). Accept that this is mitigation, not prevention, and say so in the UI. |
| Long-press peek fights iOS native gestures | High | Medium | Isolate in `useLongPressReveal.ts`, Playwright/WebKit spec, and mandatory manual test on a real iPhone before each release. |
| `content-visibility` insufficient on old iPhones | Medium | Medium | Documented escape hatch: block-level windowing with `@tanstack/react-virtual`. Design already segments into blocks, so the change is local to `Stage.tsx`. |
| PDF text extraction is garbage for scanned/columned PDFs | High (inherent) | Low | `ImportPreview.tsx` always shows extracted text as **editable** before saving. Never import silently. No OCR — out of scope, and it isn't free. |
| React was the wrong framework | Low | Medium | `src/core/**` is framework-free by lint rule; a Svelte port reuses the engine and all unit tests. ADR-0001 records this. |
| Scope creep into sync/accounts | **Medium** | Severe (kills the £0 and low-maintenance goals) | ADR-0004 defers it with a documented exit path. Backup file is the answer to 95% of the underlying need. |
| Cloudflare changes its free tier | Low | Low | Output is a static `dist/` folder. Migrating to Netlify/GitHub Pages is one afternoon; only `_headers`/`_redirects` are provider-specific. |

---

## 12. Build order (architecture-first, so nothing gets rewritten)

1. Scaffold: Vite + TS + Biome + Vitest + the directory skeleton + `CLAUDE.md` with the layering rules and dep budget. Deploy an empty shell to Cloudflare Pages **on day one** so the deploy path is never a late surprise.
2. `core/text` (tokenize, blocks, serialize) + its unit tests. Nothing renders yet. This is the foundation; get it right before any UI exists.
3. `core/mask` — types, `rank.ts`, `rng.ts`, `stylesheet.ts`, three methods, and the conformance suite. Still no UI.
4. `data/` (db, schema, repos, migrations test) + `stores/`.
5. The stage: `Stage.tsx`, `StageBlock.tsx`, level control, long-press peek, auto-scroll. Profile against `words-10k.txt` **here**, before adding features, while the code is small enough to change.
6. Library + paste import + folders.
7. Remaining masking methods (they're now additive and auto-covered by the conformance suite).
8. Role/actor tool (`core/script`).
9. Importers: txt → rtf → html → pdf (lazy).
10. PWA polish: manifest, install hints, update toast, offline E2E spec.
11. Backup/restore + the backup nudge.
12. Optional: TTS scene partner, `share_target`, File System Access auto-backup, Preact swap.

Steps 1–5 are the architecture. Everything after is content, and each item is independently shippable.
