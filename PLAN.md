# Offbook — Implementation Plan

**Status:** authoritative. This document supersedes the six design docs
(`design-modes.md`, `design-architecture.md`, `design-speech.md`, `design-text.md`,
`design-data.md`, `design-ux.md`). Where any of them contradicts this plan, this plan wins and the
design doc is to be treated as background research, not as a specification.

**Target dir:** `/Users/ben/memocoach` (empty, greenfield, not a git repo yet).
**Toolchain:** macOS, Node 22.18, npm 10.9.
**Written:** July 2026. Every browser-support claim is either marked verified-by-doc or **UNVERIFIED**
with the exact check that settles it (§15).

---

## 0.0 Amendments — Ben's decisions (2026-07-28)

**These override the body of the document wherever they conflict.** The body is left intact so the
reasoning behind each deferred feature survives for v1.1.

| # | Decision | What it changes |
|---|---|---|
| **A1** | **Name is Offbook.** Confirmed. | §1's trademark/domain check is Ben's to run when he likes; it no longer blocks M0-02. The rebrand-insurance rule (neutral persisted identifiers, `src/brand.ts`) still stands and costs nothing. §15.2 q1 closed. |
| **A2** | **v1 is parity only.** Everything in §2.2 marked as a differentiator is deferred to v1.1. | Cue-tail mode, peek-telemetry weak-line drill, self-recording, TTS partner, honest-progress numbers, deadline mode, print/cue-cards: all **LATER**. |
| **A3** | **No gamification, no progress model in this pass.** | All of **M3** and **M4** are out. That removes: confidence/readiness numbers, FSRS-lite, stakes, the demand ceiling, the deadline planner, the session generator, the debrief, all five stat screens, Type It Back, Snowball, Spotlight, annotations, `.ics` export. §15.2 q3 is moot. |
| **A4** | **`reps` append-only logging still ships in M1.** | ~20 lines, no UI, nothing surfaced to the user. It is the one deferred-feature hook worth keeping, because it makes v1.1's progress model a `recomputeAll()` rather than a rewrite (ADR-0006). Zero numbers appear anywhere in the v1 UI. |
| **A5** | **Smooth autoscroll is the default.** | Confirms `reader.autoScrollMode: 'smooth'` (§6.2, §9.5). Stepped stays available in Settings, and `prefers-reduced-motion: reduce` still forces it. §15.2 q2 closed. |
| **A6** | **Confidential mode off by default — and therefore cut from v1 entirely.** | With no TTS and no ASR in this pass there is **no network path for text to leave the device**, so the flag would guard nothing. `privacy.confidential` is dropped from `settings` and from the document record; it returns with the voice features. **Consequence: §10.5's honest-privacy copy gets simpler, not harder** — "no network requests after the app loads" becomes literally true in v1, and the About screen says exactly that. §15.2 q4 closed. |
| **A7** | ~~**Deploy target is GitHub Pages, not Cloudflare Pages**~~ — **superseded 2026-07-29: now Cloudflare Pages at the root, as originally planned. See ADR-0002.** | Cloudflare requires an interactive `wrangler login` / dashboard connect that cannot be automated; GitHub is already authenticated as `bschreck`. Live at `https://bschreck.github.io/offbook/`. Three consequences, all handled: Vite `base` comes from `VITE_BASE` (default `/`) so a later root deploy is an env change, not a refactor; SW scope is the sub-path, which is correct and self-consistent; `_headers` cannot be honoured by Pages, so the CSP ships as a `<meta http-equiv>` (losing only `frame-ancestors`, which `X-Frame-Options` would have covered — noted as an accepted v1 gap). `public/_headers` and `_redirects` are still committed, so connecting Cloudflare later is a dashboard click with no code change. SPA deep links use the `404.html` copy trick. |
| **A8** | **M-1's device checks remain Ben's to run.** | The spike page and the automated no-reflow rect test ship, and the rect test runs in CI. The four questions that need a real iPhone — magnifier vs long-press, wake lock in an installed PWA, VoiceOver over a masked line, and "do I like reading this at 22px" — cannot be answered from here and stay open in §15.1 (U-1, U-2, U-10). |
| **A9** | **Optional accounts and local-first sync are IN scope** (2026-07-29). Supersedes §3.2's permanent cut of "cloud sync, accounts". See **ADR-0008** for the whole design. | The £0/no-server objection is paid rather than waived: the API is Cloudflare Pages Functions inside the existing `offbook` project with a **D1** binding, so it is the same deploy, the same origin, no CORS and no CSP change, on free tiers throughout. **Accounts are optional and nothing is gated behind one** — IndexedDB stays the source of truth, the server is a replica, the reader never awaits a network call, and a server outage or a revoked token cannot stop a rehearsal, so for anyone who never signs in the app is exactly what §3.1 describes. Sync is cheap because of decisions already made: immutable `sourceText` is content-addressed and cannot conflict, append-only `reps` (A4) merges by union, and only document metadata needs last-write-wins. The password KDF runs in the **browser** — Workers Free allows 10 ms CPU per request and OWASP's 600,000 PBKDF2 iterations cost 300–600 ms — so `src/shared/**` is a new layer for code that must be byte-identical on client and server. **Two consequences elsewhere in this document, both intended:** A6's "no network requests after the app loads" is now true only while signed out, so §10.5's privacy copy must state the truth — nothing leaves the device unless you sign in, and then only your own texts, to our own server, never to a third party; and §2.1's "no accounts" parity cell now means no *required* account, with no tiers and no paywall, which was always the point of that row. **Nothing else in §3.2 is relaxed** — analytics and the telemetry endpoint share the superseded row and stay cut (§17's rejection stands: having a server is not a reason to send it anything about how the app is used), and Web Push still needs a push service. |

**What v1 therefore is:** the §2.1 parity table, end to end, with nothing else. Three of §2.2's entries
survive **not as features but as implementation technique**, because they are how the parity feature is
built rather than extra surface: nested masking (one seeded permutation, prefix-sliced — simpler than
reshuffling), the zero-reflow render contract (§8.3), and role isolation implemented as a filter in the
mask pipeline rather than a bespoke mode (fewer code paths than the alternative).

**Revised effort:** M-1 + M0 + M1 + M2 ≈ 17.5 dev-days as estimated; M3 and M4 are not in this pass.

---

## 0. How to read this document

- Decisions are stated as decisions. There are no forks. If you find yourself choosing between two
  options while implementing, you have found a defect in this plan — fix the plan, then the code.
- §3 (scope) and §13 (milestones) are the contract. Anything not named IN in §3 does not get built,
  regardless of how good the argument in a design doc is.
- §17 lists every critic finding that was rejected, with the reason. Do not re-litigate those either.
- The contradiction register is §3.4. It names, for each conflict between the six docs, which side won.

---

## 1. What we're building

A free, local-first, installable web app that teaches you a text by heart by progressively hiding it.
You paste or import a script, song, speech or poem; you read it aloud; the app hides a few words; you
read it again; the hiding ramps up step by step until nothing is on screen and you can still say it.
It runs entirely in the browser with no account and no server: texts live in IndexedDB, the app works
offline as a PWA, there is no paywall and no limit on the number of texts. It adds three things the app
we are copying does not have: **role isolation composes with every masking method** (not a separate
mode), **cue-tail practice** (other characters' lines collapse to their last few words, which is how
actors actually rehearse), and **honest progress numbers** that refuse to count re-reading as learning.

**Product concept.** "A teleprompter that gradually stops helping you." The reader is the product;
every other screen exists to get you into it in under fifteen seconds.

**Name.** Three candidates, from the UX doc's shortlist:

| Candidate | Why | Risk |
|---|---|---|
| **Offbook** (recommended) | The theatre term for "no longer holding the script" — it *is* the goal state, and it uses the target user's own vocabulary. Works as a verb ("get offbook"). | Common industry term; check trademark class 9/42 and `offbook.app` |
| **Byheart** (fallback) | Plain English, warm, covers actors/singers/speakers/students equally. | Generic, weak mark — fine for a free app |
| **Cueline** (second fallback) | Cue + line; signals the actor feature. | Slightly jargon-y for students |

**Decision: Offbook**, pending a trademark/domain/npm check before the wordmark is baked into the
manifest and icons. That check is task M0-01 and it is a *blocker* for M0-02.

**Rebrand insurance (do this even though we have picked a name).** Persisted identifiers are
name-independent so that a rename is never a data migration:

```
IndexedDB database name : "lines"          // never "offbook"
backup format string    : "lines.backup"   // never "offbook.backup"
backup filename prefix  : `${APP_NAME}-backup-…`   // display only, from one constant
manifest name/short_name/id, page titles, About copy : from src/brand.ts
```

`src/brand.ts` exports `APP_NAME`, `APP_TAGLINE`, `APP_URL` and nothing else touches them. A Vitest
test greps `src/` and `public/` for the competitor's name and fails the build if it appears (§14).

---

## 2. Feature parity, then differentiators

### 2.1 Parity table

| MemoCoach feature (verified from listings) | Our equivalent | Milestone |
|---|---|---|
| Paste text | Paste screen, `≤3 taps` to reading | **M1** |
| Import PDF / TXT / RTF / HTML | TXT + MD + HTML + PDF (text layer). RTF/DOCX moved to LATER | **M2** |
| "10+ memorization methods" | 10 methods at M2, 13 at M4, one frozen catalogue (§8) | **M1–M2** |
| Hide words | `hideWords` (seeded, nested, gap-spaced) | **M1** |
| Hide lines | `hideLines` (seeded nested line permutation) | **M2** |
| Hide first letters | `firstLetters` (keepLetters 3→1; at 100% this is the classic skeleton) | **M2** |
| Customisable difficulty per technique | 7-rung ladder + per-method params + a demoted Custom % slider | **M1** |
| Increase difficulty step by step | `Harder`/`Easier` as the two primary control-bar buttons; auto-advance on a clean run | **M1** |
| Actor tool: practise only my character's lines | `myLines` **lens**, composes with all 9 other methods; cue lines stay visible | **M2** |
| Auto-scroll while practising | WPM-based autoscroll, smooth + stepped, wake lock | **M2** |
| Long-press a hidden word to peek | Press-and-hold peek, 140 ms reveal, tap = sticky reveal | **M1** |
| Long-press "Reveal" to reset the text | Tap Reveal = reveal all (blocks auto-advance); 600 ms hold = hard rep reset | **M1** |
| Library with folders | Flat folders, one level, search, sort | **M2** |
| Free tier limited to 10 texts, premium subscription | No limits, no tiers, no paywall, no accounts | — |
| Audiences: actors, comedians, singers, speakers, students | Same four, and the method defaults are chosen per detected text type | **M2** |

### 2.2 Our differentiators (all in scope, milestone stated)

| Differentiator | Why it matters | Milestone |
|---|---|---|
| **Role isolation is a lens, not a mode** | "My lines only" works with first-letters, line endings, chunk window — all of them. Their actor tool is one flat method | **M2** |
| **Cue-tail mode** | Other characters' lines collapse to their last 5 words. This is the historically correct rehearsal artifact and it turns a 120-page script into ~30 phone screens | **M2** |
| **Nested masking (a curtain, not dice)** | 20% → 45% *adds* blanks, never swaps them, because one seeded permutation is prefix-sliced. Makes the ladder feel like progress | **M1** |
| **Zero reflow, structurally guaranteed** | The word never moves when it hides. Spatial memory of the page is part of how people learn lines. Enforced by a CI bounding-rect test | **M1** |
| **Peek telemetry → weak-line drill** | Every peek is recorded per line. The debrief says which five lines cost you, and drills exactly those | **M2** |
| **Self-recording + "mute my lines"** | Record the scene once, rehearse against your own voice with your lines silent — with the screen off, lock-screen controls, in an installed iOS app | **M3** |
| **TTS scene partner** | The app reads everyone else and shuts up for you. No permissions needed | **M3** |
| **Honest progress** | A re-read is worth 0.08 of a cold blind recitation; a chunk you have only ever read is capped, permanently, at "35". No XP, no streak-shaming, no "100% mastered" badge | **M4** |
| **Deadline mode** | "The show is on the 14th, I have 20 min/day" → a daily plan, a feasibility verdict, and four honest levers when it is not feasible | **M4** |
| **Printable cue script / skeleton sheet** | The classic paper drill, generated from your own text | **M4** |

---

## 3. Scope

### 3.1 IN (v1 = M0 + M1 + M2; v1.1 = M3 + M4)

**Core loop:** paste import; tokenizer with the exact-reconstruction invariant; the reader (system font,
user size, current-line rule, 40% reading zone); 10 masking methods; the 7-rung ladder with
Harder/Easier and auto-advance; press-and-hold peek, tap-to-reveal, reveal-all, hard reset; per-line
peek recording; content-anchored resume cursor; autoscroll in WPM; screen wake lock; flat folders;
brute-force search; JSON backup/restore; PWA install + eviction tripwire + backup nudge; three
public-domain samples; first-run.

**Import:** paste, `.txt`, `.md`, `.html`, `.pdf` (text layer only, always-editable preview).

**Structure:** single-pass cue detection (ALLCAPS-line + `NAME:` + `NAME.` with the recurrence guard
and the hardening rules of §7.5); per-line manual type/speaker fix; "apply to all lines like this";
speaker merge; role picker; three role views (full script / cue script / my lines only).

**Cleanup:** five rules as toggles with live counts, over an immutable `sourceText`, plus one
free-text `manualText` override and "reset to the original import".

**Progress:** append-only `reps` log from M1; `fold()` and the FSRS-lite materialized view activated in
M4 (§11); `recomputeAll()` written on day one.

**Voice (M3):** self-recording read-through with per-line marks; "mute my lines" playback; MediaSession
lock-screen listen-back; TTS scene partner with the half-duplex state machine; VAD timing-only mode.

**Polish (M4):** confidence + readiness numbers; deadline planner; session generator; debrief and five
stat screens; Type It Back; Snowball; Spotlight; print/PDF presets; annotations (always-show, weak,
note, bookmark); `.ics` reminder export; diagnostics report; real-AT pass; high contrast; ~24 keyboard
shortcuts.

### 3.2 OUT — permanently, with the reason

| Cut | Reason |
|---|---|
| Speech-recognition **scoring** (pass/fail verdicts) | Silently dead in installed iOS PWAs (the configuration we push users into), absent in Firefox, `continuous` unusable on Safari, and unfalsifiable without a hand-labelled 40-attempt corpus. Post-v1 spike only (§10.4) |
| Local Whisper | 40–150 MB third-party CDN download, batch-only, hallucinates on silence, breaks the privacy pitch and the CSP |
| `tesseract.js` OCR | 6–8 MB download to do worse than Live Text / Google Lens on the phone the user is holding. OS handoff instead |
| AI formatting assist + Fountain parser/serialiser | The assist exists to fix structure that "apply to all lines like this" already fixes; remove it and the Fountain parser has no justification |
| Persistent inverted search index (`postings`) | Brute-force scan of `docText` answers every query under 50 ms at Ben's library size. Revisit at 50+ docs |
| `docRevisions` gzip ring buffer + 200-op edit stack | Three undo systems for one screen. `sourceText` is immutable forever, which covers the only unrecoverable case |
| Nested folders (depth 3), `pathKey`, tags, archive-as-third-state, duplicate-with-progress, split-document, extract-my-lines | Flat one-level folders + soft delete cover tens of texts. Each of these is a store, an index and a UI |
| Blur, Word Shapes, Facts & Figures, Shuffle check, Sentence Tail (as a separate method), From Memory (as a method) | GPU cost, measurement caches, bespoke drag interactions, or duplicates of a ladder rung. See §8.1 |
| Multiple user profiles | Progress is per browser. Documented workaround: separate browser profiles. A later `profileId` is a migration, and `recomputeAll()` makes migrations cheap |
| ~~Cloud sync, accounts~~, analytics, telemetry endpoint | Every one of them breaks £0/no-server or the privacy promise. JSON backup answers 95% of the underlying need — **cloud sync and accounts superseded 2026-07-29: optional accounts and local-first sync are IN. £0 holds (Pages Functions + D1 in the existing project, free tier), and the privacy promise is kept by making it opt-in rather than by having no server. The missing 5% was the whole point: a second device. See ADR-0008 and §0.0 A9. Analytics and the telemetry endpoint are NOT superseded and stay cut.** |
| Web Push practice reminders | Requires a push service and a server. `.ics` calendar export instead (M4) |
| Teleprompter mode, mirror flips, brightness dim overlay, command palette, five font options, reading ruler, line numbers, handedness mirror | ~4 dev-days of reader surface the goal statement never asks for. System font only, one size slider, one blank style in v1 |
| Two-finger peek-all and two-finger swipe as *default* gestures | Collide with VoiceOver two-finger gestures and Safari pinch, and cannot reliably be preempted. Available, default off |
| URL-fragment script sharing | Invites over-sharing of NDA'd and embargoed material. File share only |
| Recognition-tier methods (multiple choice, word bank, reorder) | Whole new interaction models; the ladder's low rungs already provide an easy on-ramp. `wordBank` is the one to revisit post-v1 |
| Rich text, stanza numbering, rhyme-scheme display, metronome, watch app, second-screen/AirPlay | Not why anyone opens the app |
| Streaming JSON parser for backups | There is no platform streaming JSON parser. We bound the problem instead (§11.8) |

### 3.3 LATER — real backlog, each with its spec source

| Later | Spec source | Trigger |
|---|---|---|
| `.docx` (fflate + own XML walker), `.rtf` (own extractor) | design-text §1.4, §1.5 | A real import Ben needs fails |
| PDF column detection, evidence-based de-hyphenation, watermark detection, dual dialogue, scene-number margins, broken-`/ToUnicode` classifier | design-text §1.6.3–1.6.6 | A real PDF import fails |
| Two-pass structure detection: global speaker vocabulary, indent buckets, 6×6 Viterbi | design-text §4.2 | M2's single-pass detector produces false cues on a real script |
| Fuzzy chunk re-anchoring (stages 2–3) + orphan retention | design-data §3.2 + §7.4 fixes here | First time an edit orphans progress |
| `postings` inverted index | design-data §5.3 | Library exceeds 50 docs and search feels slow |
| `.mcz` zip archive with audio and readable `text/` | design-data §10.2 | Users accumulate recordings worth exporting |
| Repeated-chorus linkage (`repeatOf` at reduced stakes) | design-text §4.8 + design-data §3.2 | Lyrics users complain about duplicated work |
| Web Share Target (Android) + `file_handlers`; requires the `generateSW` → `injectManifest` switch | design-architecture §4 | After the service worker has been stable for a release |
| Word Bank method | completeness critic | Type It Back proves too slow on a phone |
| Shared/split verse lines (`continuesLine`) | completeness critic | A Shakespeare user reports broken metre |
| UI translations + RTL layout mirroring | completeness critic | A non-English user asks |
| ASR scoring | design-speech §1 | Only if the §10.4 spike is convincing |

### 3.4 Contradiction register — who won

| # | Conflict | Winner | Loser (delete from the doc) |
|---|---|---|---|
| 1 | How a masked word renders | **design-modes §3 / design-text §3.3**: real text in an inner span at `visibility:hidden`, blank drawn on the outer inline-block box | arch `color:transparent` (leaks to SR/find/select); UX "never in the DOM" (reintroduces canvas measurement, which cannot reproduce advance width) |
| 2 | Mask representation | **design-modes `MaskPlan`**: `Uint8Array` of per-token style codes + `lineFlags`, applied by diffing `data-mask` | arch's single monotone `HideRanks` + 55 generated selectors + one className swap (cannot express 9 styles, stepped state, or the window lens) |
| 3 | Storage library | **`idb`** + hand-written repositories | Dexie 4 (~28 kB gz breaks the written dependency budget; compound and multiEntry indexes are plain IndexedDB features, not Dexie features) |
| 4 | Store layout | **design-data's stores, trimmed to 9 and phased by DB version** (§6.1) | arch's 4 stores with the token model inline; modes' 6 stores |
| 5 | Progress engine | **design-data**: `reps` append-only = truth, `mastery` = materialized view, FSRS-lite, stakes, demand ceiling | modes §8.4's parallel SRS-lite (1/3/7/16/35/75 d), its chunk state machine, and its 200-rep ring buffer (which would make `recomputeAll()` a lie) |
| 6 | Auto-demote | **design-ux §4.4**: no auto-demote, ever. A suggestion with a button instead | modes §8.3 step-down / deep-step-down |
| 7 | Token model | **design-text §5** (`Intl.Segmenter`, `ws+lead+text+trail` reconstruction invariant), with modes' flags derived on top | modes §1.1's regex tokenizer (splits `1,234`, `D.C.`, `3.14`); speech's third shape |
| 8 | Chunk identity | **design-data §3.2** content-hash `chunkKey` + ordinal (with §7.4's fixes) | modes §11's integer `chunkIdx`; design-text §2.6's competing 0.85-trigram re-anchoring |
| 9 | Structure detection | **design-text §4.3–4.4**, single pass in v1, hardened per §7.5 | modes §1.2's unguarded role parser (makes `ACT ONE` a speaker) |
| 10 | Gesture + keyboard constants | **design-ux §5** is normative | modes §10.1–10.6 (different long-press, opposite tap semantics, colliding keys) |
| 11 | Accessibility of a masked token | **design-ux §7.2**: line-level `aria-label` with "blank" + focusable `<button>` tokens + one coalesced announcer | modes' non-standard `role="text"`; arch's block-level SrOnly marker; UX §3.4's own `aria-hidden` variant |
| 12 | Styling system | **plain CSS with custom properties + `@layer`** | Tailwind config in UX §9.9 (token values and contrast ratios carry over unchanged; only the wiring changes) |
| 13 | Folders | **design-ux §0.4**: flat, one level | design-data §2.3's depth-3 `pathKey` + move invariants |
| 14 | Wake lock on iOS | **design-ux §3.8**: Safari 16.4+ *does* support it; the real caveat is installed PWAs on iOS 16.4–18.3 | design-architecture §4 note 7 ("unsupported on iOS Safari") |
| 15 | `navigator.storage.persist()` on Safari | **design-data §1.2 / design-ux Screen 17**: call it everywhere, it is honoured on Safari 17+ and granted heuristically for home-screen apps | design-architecture §3 ("treat `false` as the expected case") |
| 16 | Imported source binary | **design-architecture §3**: never stored | design-text §3.1's `sourceBlob` up to 8 MB |
| 17 | Search | **brute force in v1** | design-data §5.3's persistent postings index (LATER) |
| 18 | Autoscroll velocity | **measured from the current block** (§9.5) | UX §3.9's `scrollHeight / wordCount` (unstable under `content-visibility: auto`) |
| 19 | Mode catalogue | **§8.1 of this plan**: one frozen list of 13 ids | modes' 16, UX's 13-with-different-names, arch's 12-with-a-third-set |
| 20 | Ladder length | **7 rungs** (`ladderIndex 0..6`) | modes' 8; UX's 6; arch's `MAX_LEVEL = 10` |
| 21 | Reading zone | **40%** portrait, 45% landscape | modes/speech's 38% |
| 22 | Default autoscroll WPM | **120** | modes/data's 130 |
| 23 | Chunk default target | **`speech` for scripts, `line` for lyrics/verse, `sentence` merged to 28 words for prose** | data's flat 20; modes' 45/90 |
| 24 | Repeated stanzas | **per-ordinal `chunkKey` is the storage truth** (data §3.2); linkage is a LATER feature | design-text §4.8's "practise once, mark the repeats learned" as a v1 behaviour |
| 25 | Product name in persisted data | **neutral identifiers** (§1) | arch's `DB_NAME='memocoach'`, data's `"memocoach.backup"`, speech's "Cue" |

---

## 4. Tech stack & hosting

| Choice | One-line justification | Cost |
|---|---|---|
| **Vite 7 + React 19 + TypeScript (strict)** | Largest training corpus of any web stack, so Claude Code writes idiomatic code first time; the build is one static folder with no server concept. Reversible because `src/core/**` is framework-free by lint rule | £0 |
| **`react-router` v7, declarative mode** (`createBrowserRouter`) | We want routing primitives, not data loaders; history routing works because we deploy at the domain root | £0 |
| **Zustand** for state, in three separate stores | Library / session-runtime / UI split is a performance decision: an autoscroll tick must not notify library subscribers | £0 |
| **`idb`** (~1.1 kB gz) over IndexedDB | Typed promise wrapper with no query engine to debug when IndexedDB misbehaves — and it does, on Safari. Compound and multiEntry indexes are platform features we use directly | £0 |
| **Plain CSS**, custom properties, `@layer reset, tokens, components, utilities` | ~25 UI surfaces and one visually critical screen. A utility framework's payoff is consistency across hundreds of screens; here it is a build step and 400 class names to keep coherent | £0 |
| **`vite-plugin-pwa`** in `generateSW` mode, `registerType: 'prompt'`, `skipWaiting: false` | We have no custom SW logic worth owning in v1, and we must never swap the JS bundle under an actor mid-scene | £0 |
| **`pdfjs-dist`**, lazy, in our own worker | The only import path with real engineering risk; excluded from the first-load budget and from precache | £0 |
| **Biome 2** (replaces ESLint + Prettier) | One dependency. Named loss: type-aware `no-floating-promises`; mitigated by `typecheck` in CI, with a written tripwire to add ESLint for that single rule if a floating-promise bug ships | £0 |
| **Vitest** + `fake-indexeddb` + `fast-check`; **Playwright** capped at three specs | The bugs that ship are in the tokenizer, the masking maths, the PDF parser and the migrations — all pure functions | £0 |
| **Cloudflare Pages**, free plan, Git integration | Two decisive rows: deploy at the domain **root** (service-worker scope, clean `start_url`) and a `_headers` file for a strict CSP. No published bandwidth cap; 500 builds/month | £0 |
| **MIT licence, public GitHub repo** | Makes the "someone else could host this" escape-hatch promise real. Note this reverses the architecture doc's private-repo rationale — Pages builds public repos on free just as happily | £0 |
| Optional custom domain at Cloudflare Registrar | The **only** line item that can ever cost money | ~£10/yr, optional |

**Dependency budget, enforced in `CLAUDE.md`:** first-load JS ≤ 150 kB gz; no new dependency over
15 kB gz without an ADR. Expected runtime deps: `react`, `react-dom`, `react-router`, `zustand`, `idb`.
That is the whole list. `pdfjs-dist` is lazy and excluded.

**What would ever cost money, exhaustively:** (1) the optional domain; (2) exceeding 500 builds/month,
which needs ~17 pushes a day and is fixed by `wrangler pages deploy dist` from CI; (3) nothing else —
there is no server, database, egress, auth provider or analytics vendor.

### 4.1 `public/_headers` (corrected CSP)

```
/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self' blob:; worker-src 'self' blob:; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
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

`media-src 'self' blob:` and `connect-src 'self' blob:` are **not optional** — without them the M3
recording playback, the mute-my-lines loop and MediaSession all fail with a CSP violation and no obvious
cause. `style-src 'unsafe-inline'` is needed only for React's inline `style` attributes (we set
`--w`-style custom properties per token); there is no runtime-generated stylesheet in this plan, so if
we later drop inline styles we can drop `'unsafe-inline'` too. A comment in the header file states that
any third-party asset download requires a CSP edit and a redeploy — so "opt-in model download" would be
a release decision, not a runtime toggle. One Playwright assertion checks that no CSP violation is
reported on the reader route.

`public/_redirects` is one line: `/*   /index.html   200`.

### 4.2 Manifest (v1)

```json
{
  "id": "/",
  "name": "Offbook — learn lines, lyrics and speeches by heart",
  "short_name": "Offbook",
  "start_url": "/?src=pwa",
  "scope": "/",
  "display": "standalone",
  "display_override": ["standalone", "minimal-ui"],
  "orientation": "any",
  "background_color": "#121417",
  "theme_color": "#121417",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "screenshots": [
    { "src": "/screens/reader.png", "sizes": "1170x2532", "type": "image/png", "form_factor": "narrow" },
    { "src": "/screens/library-wide.png", "sizes": "1440x900", "type": "image/png", "form_factor": "wide" }
  ],
  "categories": ["education", "productivity"]
}
```

**No `share_target`, no `file_handlers` in v1.** A POST share target requires custom service-worker
logic, i.e. a switch from `generateSW` to `injectManifest` — the riskiest kind of PWA change to make
while everything else is still moving. Advertising an endpoint the SW cannot handle is a broken feature
on Android from day one. It is a single M4/LATER task whose first step is that documented switch.

`theme_color` for both schemes goes in HTML, not the manifest (which supports only one):

```html
<meta name="theme-color" content="#FAF9F7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121417" media="(prefers-color-scheme: dark)">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
```

`interactive-widget=resizes-content` is a Chromium/Firefox enhancement only — **not implemented in
WebKit**. All bottom-bar and focused-input positioning is driven by `window.visualViewport`
(`resize` + `scroll`, offset by `height + offsetTop`), plus `100dvh` and
`env(safe-area-inset-bottom)`. `user-scalable=no` is never used (WCAG 1.4.4).

### 4.3 Service worker config

```ts
VitePWA({
  registerType: 'prompt',
  includeAssets: ['favicon.svg', 'icons/apple-touch-icon-180.png'],   // no fonts: system stack only
  workbox: {
    globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
    globIgnores: ['**/pdf.worker*.js', '**/pdfjs-*.js'],
    navigateFallback: '/index.html',
    navigateFallbackDenylist: [/^\/_/],
    cleanupOutdatedCaches: true,
    clientsClaim: false,
    skipWaiting: false,
    maximumFileSizeToCacheInBytes: 3_000_000,
    runtimeCaching: [{
      urlPattern: ({ url, request }) =>
        url.origin === self.location.origin &&
        url.pathname.startsWith('/assets/') && request.destination === 'script',
      handler: 'CacheFirst',
      options: { cacheName: 'lazy-chunks', expiration: { maxEntries: 30 } },
    }],
  },
})
```

Exactly one runtime rule: it exists so the pdf.js chunk is not forced onto every first install but does
become available offline after one use. Named trade-off: a user's *first ever* PDF import must be online.

### 4.4 iOS checklist that will actually bite

1. `viewport-fit=cover` + `env(safe-area-inset-*)` padding, or reader text sits under the notch and the
   control bar under the home indicator.
2. `100dvh`, not `100vh`.
3. `overscroll-behavior: contain` on the reader scroller, `overscroll-behavior-y: none` on `body`.
4. Long-press = selection + magnifier + callout. Required on the canvas: `-webkit-touch-callout: none`,
   `user-select: none`, `touch-action: manipulation`, `contextmenu → preventDefault()`, and a
   Pointer-Events press timer with a movement cancel. One hook: `useLongPress.ts`. **Test on a real
   iPhone; the simulator lies about this.**
5. `apple-mobile-web-app-status-bar-style: black-translucent`, combined with (1).
6. Screen Wake Lock **is** available on iOS Safari 16.4+; it was broken in installed home-screen apps
   until iOS 18.4 (§9.6, UNVERIFIED-1).
7. iOS kills backgrounded web apps without warning: persist on `visibilitychange → hidden` and
   `pagehide`, never only on unmount, never with a debounce over 500 ms.
8. In-app browsers (Instagram, LinkedIn) cannot install PWAs; detect and show "Open in Safari".
9. File pickers filter by UTI, not by extension — see §7.2.

---

## 5. Repo layout

```
/Users/ben/memocoach
├── .github/workflows/ci.yml
├── .gitignore
├── .nvmrc                              # 22
├── LICENSE                             # MIT
├── biome.json
├── index.html
├── package.json
├── playwright.config.ts
├── tsconfig.json  tsconfig.node.json
├── vite.config.ts  vitest.config.ts
├── CLAUDE.md                           # invariants, dep budget, layering rules, kill list
├── README.md
├── docs/
│   ├── plan.md                         # this document, trimmed
│   ├── methods.md                      # generated from the method registry
│   └── decisions/
│       ├── ADR-0001-vite-react.md
│       ├── ADR-0002-cloudflare-pages.md
│       ├── ADR-0003-storage-idb.md
│       ├── ADR-0004-defer-sync.md
│       ├── ADR-0005-mask-render-contract.md      # §8.3 — the one a refactor would innocently destroy
│       ├── ADR-0006-reps-are-the-truth.md
│       └── ADR-0007-licence-mit-public.md
├── public/
│   ├── _headers  _redirects  favicon.svg  licences.txt
│   ├── icons/{icon-192,icon-512,maskable-512,apple-touch-icon-180}.png
│   ├── screens/{reader,library-wide}.png
│   └── samples/{sonnet-18,hamlet-soliloquy,earnest-two-hander,gettysburg}.txt
├── src/
│   ├── main.tsx  App.tsx  router.tsx  brand.ts  vite-env.d.ts
│   │
│   ├── core/                           # PURE TS. no react, no DOM, no idb. lint-enforced.
│   │   ├── text/
│   │   │   ├── types.ts                # RawLine, Document, Block, Line, Token, Speaker
│   │   │   ├── extract/{paste,txt,md,html,pdf}.ts
│   │   │   ├── clean/{rules,pipeline}.ts
│   │   │   ├── sniff.ts                # doc type + language
│   │   │   ├── structure.ts            # cue/heading/direction detection, single pass
│   │   │   ├── tokenize.ts             # Intl.Segmenter + join/peel/classify
│   │   │   ├── functionWords.ts        # per-language Set, apostrophe-normalised at load
│   │   │   ├── chunk.ts                # chunking + chunkKey + re-anchor (exact pass)
│   │   │   └── derive.ts               # sourceText + cleanupConfig + overrides -> Document
│   │   ├── mask/
│   │   │   ├── types.ts                # MaskStyle, MaskPlan, ModeSpec, Ladder
│   │   │   ├── rng.ts                  # cyrb128 -> sfc32
│   │   │   ├── plan.ts                 # computeMaskPlan(): base -> window -> reveals
│   │   │   ├── kernels/{percent,positional,lineLevel,window}.ts
│   │   │   ├── lens/{myLines,protect,reveals}.ts
│   │   │   ├── registry.ts             # id -> Method; the frozen catalogue
│   │   │   └── ladder.ts              # 7 rungs, per-method mapping tables
│   │   ├── progress/
│   │   │   ├── types.ts                # Rep, Mastery, MaskSpec footprint
│   │   │   ├── stakes.ts               # R_d, V, stakes
│   │   │   ├── fsrs.ts                 # R(t,S), successStability, lapseStability, difficulty
│   │   │   ├── fold.ts                 # fold(), recomputeAll()
│   │   │   ├── confidence.ts           # conf(now), p_pass, readiness, expectedStumbles
│   │   │   ├── plan.ts                 # deadline back-plan + daily ranker (M4)
│   │   │   ├── session.ts              # session generator (M4)
│   │   │   └── time.ts                 # epochDay in a named tz, clock-skew guard
│   │   ├── backup/{types,export,import,validate,migrate}.ts
│   │   └── util/{id,hash,result,assert,collate}.ts
│   │
│   ├── data/                           # only layer that touches IndexedDB
│   │   ├── db.ts  schema.ts  migrateRecord.ts  storageInfo.ts  broadcast.ts
│   │   └── repos/{documents,docText,derived,folders,settings,meta,reps,mastery,sessions}.ts
│   │
│   ├── stores/{libraryStore,readerStore,settingsStore,uiStore}.ts
│   ├── routes/{Library,Text,Reader,Import,Progress,Settings,About,NotFound}Route.tsx
│   ├── features/
│   │   ├── library/{LibraryList,FolderChips,TextCard,SearchBar,AddSheet}.tsx
│   │   ├── import/{PastePanel,FilePicker,ImportPreview,CleanupSheet}.tsx
│   │   ├── structure/{StructureEditor,LineFixSheet,SpeakerManager}.tsx
│   │   ├── roles/{RolePicker,RoleViewSegmented}.tsx
│   │   ├── reader/
│   │   │   ├── Reader.tsx  LineView.tsx  MaskedToken.tsx
│   │   │   ├── StatusRail.tsx  ControlBar.tsx  StageChip.tsx
│   │   │   ├── MethodSheet.tsx  TypeSheet.tsx  MoreSheet.tsx
│   │   │   ├── useMaskPlan.ts  useLongPress.ts  useAutoScroll.ts
│   │   │   ├── useCurrentLine.ts  useScrollAnchor.ts  useAnnouncer.ts
│   │   │   └── reader.css
│   │   ├── debrief/{Debrief,ConfidenceStrip}.tsx
│   │   ├── voice/{Recorder,MuteMyLines,Partner,Vad}.tsx        # M3
│   │   ├── backup/{BackupPanel,RestoreDialog,BackupNudge}.tsx
│   │   └── settings/{Appearance,ReaderPrefs,Storage,A11y,About}.tsx
│   ├── components/{Button,IconButton,Sheet,ListRow,Chip,Segmented,Slider,Toggle,Toast,EmptyState,ErrorBoundary,SrOnly,Icon}.tsx
│   ├── hooks/{useMediaQuery,useStandalone,useWakeLock,useUpdatePrompt,usePersistOnHide,useVisualViewport,useKeyboardShortcuts}.ts
│   ├── pwa/{registerSW,InstallHint,UpdateToast}.tsx
│   └── styles/{reset,layers,tokens,app,print}.css
│
├── tests/
│   ├── setup.ts
│   ├── fixtures/                       # FIVE, not fifteen (§14.4)
│   │   ├── shakespeare-hamlet.txt
│   │   ├── stageplay-name-colon.txt
│   │   ├── lyrics-genius-paste.txt
│   │   ├── real-script.pdf
│   │   ├── pathological-paste.txt
│   │   └── backup-v1.json
│   └── unit/                           # mirrors src/core/**
├── bench/{tokenize,maskPlan}.bench.ts
├── e2e/{boot-offline,import-practice-reload,longpress-reveal}.spec.ts
└── spike/
    └── mask-render.html                # M-1, throwaway, no build step
```

`CLAUDE.md` layering rules, backed by a Biome `noRestrictedImports` rule *and* one Vitest test that
walks imports (so it holds even if the lint config drifts):

- `src/core/**` imports nothing outside `src/core/**` — no React, no `window`, no `idb`.
- No component imports from `src/data/**`; only stores talk to repositories.
- No store imports from `src/features/**`.

---

## 6. Data model

### 6.1 IndexedDB schema, phased by DB version

Nine stores at the end of M4. Two independent version axes, and keeping them separate is the important
part: **DB version** governs stores and indexes (fall-through `switch` in the `upgrade` callback);
**record `sv`** governs payload shape and is migrated lazily on read by `migrateRecord()`, so adding a
masking option never needs an IDB upgrade transaction on a phone you cannot debug.

```ts
// src/data/schema.ts
export const DB_NAME = 'lines';        // deliberately brand-neutral (§1)
export const DB_VERSION = 4;           // reached at M4; see the table below
```

| Store | keyPath | Indexes | Introduced |
|---|---|---|---|
| `meta` | `key` | — | DB v1 (M0) |
| `settings` | `key` | — | DB v1 (M0) |
| `folders` | `id` | `by-sort` (`sortName`) | DB v1 (M0) |
| `documents` | `id` | `by-folder` (`folderId`), `by-practised` (`lastPracticedAt`), `by-updated` (`updatedAt`), `by-title` (`sortTitle`) | DB v1 (M0) |
| `docText` | `docId` | — | DB v1 (M0) |
| `derived` | `docId` | — | DB v2 (M1) |
| `reps` | `id` | `by-at` (`at`), `by-doc-at` (`[docId, at]`), `by-chunk` (`[docId, roleSetHash, chunkKey, at]`) | DB v2 (M1) |
| `mastery` | `[docId, roleSetHash, chunkKey]` | `by-doc` (`docId`), `by-due` (`[docId, dueAt]`) | DB v3 (M4) |
| `sessions` | `id` | `by-doc-started` (`[docId, startedAt]`) | DB v3 (M4) |
| `recordings` | `id` | `by-doc` (`[docId, createdAt]`) | DB v4 (M3) |
| `recordingBlobs` | `recordingId` | — | DB v4 (M3) |
| `annotations` | `id` | `by-doc` (`docId`) | DB v4 (M4) |

Deliberately absent, with §3.2 reasons: `tags`, `docRevisions`, `runs`, `plans`, `postings`, `trashOps`.
`runs` and `plans` are folded into `sessions` and `documents.plan` respectively; `trashOps` is replaced
by soft delete + an in-memory single-op inverse behind a snackbar.

Hard rules, all four inherited from the data doc because they are correct:

1. **One `readwrite` transaction per logical action.** A rep write touches `reps` + `mastery` +
   `documents.progress` — all three in one transaction, or the view drifts from the log.
2. **All ids are UUIDv7** (time-ordered), so `reps` primary key is already chronological.
3. **Every record** carries `createdAt`, `updatedAt`, and `deletedAt: number | null` where deletable.
4. **Writes are idempotent by id.** Importing the same backup twice is a no-op.

Two additions of our own:

5. **`blocked`/`blocking`/`terminated` handlers are mandatory**, plus an `open()` **timeout** with a
   connection-probe retry: Safari has a history of `open()` hanging indefinitely on first page load,
   which is a different failure from the `terminated()` callback. Every repository call goes through
   `await dbPromise` so a reopen is transparent.
6. **Cross-tab invalidation via `BroadcastChannel('lines')`.** After every write transaction we publish
   `{store, key, updatedAt}`; each tab invalidates the affected slice of its Zustand mirror. ~30 lines,
   and without it two tabs open on one document both fold reps from stale in-memory state and the
   materialized `mastery` stops matching `reps`. From M2, a Web Locks single-writer lock
   (`navigator.locks.request('practice:'+docId, {ifAvailable:true})`) makes a second tab opening the
   same reader offer "already rehearsing in another tab — take over?" instead of silently competing.
   Boot-time consistency check: compare `Σ mastery.reps` against `count(reps)`; on disagreement offer
   `recomputeAll()`.

### 6.2 Records

```ts
// ---------- meta / settings ----------
type MetaRow =
  | { key: 'schemaVersion';  value: number }
  | { key: 'installId';      value: string }
  | { key: 'algoVersion';    value: number }   // bump -> offer recomputeAll()
  | { key: 'pipelineVersion';value: number }   // bump -> re-derive Documents, re-anchor chunks
  | { key: 'persistGranted'; value: boolean }
  | { key: 'lastBackupAt';   value: number }
  | { key: 'lastBackupCounts'; value: { docs: number; reps: number } }
  | { key: 'lastSeenClock';  value: number }   // monotonic guard (§11.9)
  | { key: 'hadData';        value: true };    // mirrored in localStorage as the eviction tripwire

interface SettingsShape {
  'ui.theme': 'system' | 'light' | 'dark' | 'contrast';
  'ui.reduceMotion': 'auto' | 'on' | 'off';
  'reader.fontPx': number;            // 18..44 mobile, 18..72 desktop, default 22
  'reader.lineHeight': 1.45 | 1.65 | 1.95;
  'reader.measureCh': number;         // 24..60, default 32
  'reader.blankStyle': 'underline' | 'box' | 'dots';
  'reader.sameWidthAsWord': boolean;  // default true
  'reader.lineFocus': boolean;
  'reader.autoScrollWpm': number;     // default 120
  'reader.autoScrollMode': 'smooth' | 'stepped';
  'reader.keepAwake': 'sessions' | 'always' | 'never';
  'input.peekBehaviour': 'hold' | 'tap' | 'timed';
  'input.longPressMs': number;        // default 450, 'reduce accidental taps' -> 600
  'input.twoFingerGestures': boolean; // DEFAULT FALSE (§9.4)
  'input.haptics': boolean;
  'practice.autoAdvanceOnCleanRun': boolean;   // default true; there is no auto-demote
  'practice.sessionMinutes': 5 | 12 | 20 | 35;
  'a11y.verbosity': 'terse' | 'verbose';
  'a11y.largerTargets': boolean;
  'privacy.confidential': boolean;    // hard-disables cloud voices + any network voice path
}
```

```ts
// ---------- library ----------
interface Folder {
  id: string; name: string; sortName: string; color?: string; order: number;
  createdAt: number; updatedAt: number; deletedAt: number | null; sv: 1;
}
// FLAT. There is no parentId. One level, by decision (§3.4 #13).

type DocKind = 'script' | 'lyrics' | 'speech' | 'poem' | 'lesson' | 'other';

interface DocumentMeta {
  id: string;
  folderId: string | null;
  title: string;
  sortTitle: string;                  // lowercased, leading article stripped
  kind: DocKind;
  lang: string;                       // BCP-47, detected, user-overridable

  textHash: string;                   // FNV-1a hex of docText.text
  pipelineVersion: number;            // re-derive on mismatch
  wordCount: number; charCount: number; chunkCount: number;

  roles: Role[];                      // inline: 1..40, always needed with the doc, never cross-queried
  myRoleIds: string[];
  roleSetHash: string;                // hash(sorted(myRoleIds)) || 'all' — scopes ALL progress
  roleView: 'full' | 'cue' | 'mine';
  cueTailWords: 3 | 5 | 8 | 0;        // 0 = whole line

  cleanupConfig: CleanupConfig;
  manualText: string | null;          // the one free-text override; null = derived from sourceText
  structureOverrides: StructureOverride[];

  prefs: DocPractisePrefs;
  cursor: PracticeCursor | null;       // the bookmark MemoCoach reviewers ask for
  performanceAt: number | null;
  performanceTz: string | null;        // IANA; REQUIRED whenever performanceAt is set (§11.9)
  targetDurationSec: number | null;

  progress: DocProgress;              // materialized; recomputable from mastery
  source: { type: 'paste'|'txt'|'md'|'html'|'pdf'|'sample'|'import'; filename?: string; importedAt: number };
  lastPracticedAt: number | null;
  createdAt: number; updatedAt: number; deletedAt: number | null; sv: 1;
}

interface Role {
  id: string; label: string; aliases: string[]; colorIndex: number;
  isEnsemble: boolean; lineCount: number; wordCount: number; firstLineIndex: number;
}

interface DocPractisePrefs {
  methodId: MethodId;                 // §8.1
  ladderIndex: number | null;         // 0..6; null when custom is active
  customPercent: number | null;       // 0..100; exactly one of these two is non-null
  methodParams: Record<string, number | string | boolean>;
  reshuffle: number;                  // seed counter
  chunkStrategy: 'auto' | 'line' | 'sentence' | 'speech' | 'block';
  chunkTargetWords: number;           // default from kind: script 28, lyrics 8, prose 28
  manualChunkBreaks: string[];        // LineFingerprints
}

/** Content-anchored so it survives edits and re-chunking. */
interface PracticeCursor {
  chunkKey: string; lineFingerprint: string; scrollFraction: number;
  step?: number; windowIndex?: number; updatedAt: number;
}

interface DocProgress {              // all fields written by M4; zeros before then
  readiness: number;                 // 0..100 (§11.5)
  readinessAt: number;
  pctAt80: number; pctAt95: number;
  expectedStumbles: number;
  weakestChunkKeys: string[];        // top 5
  peeksPer100Words: number;          // THE M1..M3 headline; survives into M4 as a secondary
  totalReps: number; totalPractiseSec: number;
  history: Array<{ d: number; readiness: number; pctAt80: number; peeks100: number }>; // 1/day, cap 400
}

interface DocText {
  docId: string;
  sourceText: string;                // IMMUTABLE after import. The single source of truth.
  textHash: string;
  sourceMeta?: { pdfPages?: number; droppedArtifacts?: number; parserConfidence?: number };
  updatedAt: number;
}
```

**We never store the imported binary.** A 3 MB PDF becomes ~40 kB of text; this keeps a
hundred-script library inside a few MB, which is the single best defence against every quota problem.
Named loss: after a pdf.js parser fix we cannot re-extract; the user re-imports the file. Accepted.

```ts
// ---------- derived (cache; recompute is always legal) ----------
interface Derived {
  docId: string;
  textHash: string; pipelineVersion: number; builtAt: number; buildMs: number;

  // flat, index-aligned, ~10x smaller than object arrays and structured-clones instantly
  blockStart: Uint32Array; blockEnd: Uint32Array;      // token index ranges
  blockType: Uint8Array;                               // BlockType enum
  blockRole: Uint16Array;                              // 0xFFFF = none
  blockKeys: string[];                                 // content hashes, for overrides

  lineStart: Uint32Array; lineEnd: Uint32Array;
  lineBlock: Uint32Array; lineIndentEm: Uint8Array;     // quantised verse indent (§7.6)
  lineFingerprints: string[];

  chunkStart: Uint32Array; chunkEnd: Uint32Array;       // token index ranges
  chunkKeys: string[]; chunkWords: Uint16Array; chunkMaskable: Uint16Array;

  // tokens: parallel arrays over ALL tokens, including punct
  tokStart: Uint32Array; tokEnd: Uint32Array;           // char offsets into the effective text
  tokLine: Uint32Array; tokChunk: Uint32Array;
  tokFlags: Uint16Array;                                // §7.3 bitfield
  tokLetters: Uint8Array;                               // letterCount, clamped 255
}
```

`Document` (the in-memory object the reader consumes) is `DocumentMeta` + `DocText` + `Derived` +
lazily materialised `Token` accessors (`doc.token(i)`), so the columnar/object representation can be
swapped invisibly. **Hard ceiling: 30,000 tokens.** Above it, import splits the document at the nearest
heading with an explanatory dialogue ("This is a 40,000-word text — split it into 3 parts by act?").
Documented escape hatch, not built: block-level windowing with a virtualisation library.

```ts
// ---------- progress ----------
type RepMode = 'read' | 'recall' | 'type' | 'asr' | 'runReview' | 'recordReview';

interface MaskSpec {                 // the persisted footprint of a mode; the registry owns the rest
  methodId: MethodId;
  m: number;                         // 0..1 fraction of maskable tokens hidden
  mContent: number;                  // 0..1 fraction of CONTENT tokens hidden (§11.2 fix)
  kind: 'blank' | 'firstLetter' | 'firstTwo' | 'shape' | 'lineHidden';
  promptVisible: boolean;            // cue line / previous chunk on screen
}

interface Rep {
  id: string;                        // uuidv7
  docId: string; roleSetHash: string; chunkKey: string;
  sessionId: string | null;
  at: number; ms: number;
  tzOffsetMin: number;               // so history stays interpretable across travel
  clockSuspect?: true;               // set by the monotonic guard (§11.9)

  mode: RepMode;
  mask: MaskSpec;
  grade: 1 | 2 | 3 | 4;
  stakes: number;                    // computed AND STORED at write time (§11.2)

  peeks: number;                     // deduped help events, not raw gesture count (§11.1)
  lineReveals: number;
  revealAllUsed: boolean;
  spokenAloud?: boolean;             // from VAD, M3. Never raises verification trust.
  score?: number;                    // 0..1 objective (type/asr)
  missedTokenIdx?: number[];         // WITHIN the chunk, so edits elsewhere don't invalidate it
  post?: { S: number; D: number; C: number };   // state after folding; makes recompute verifiable
}

interface Mastery {                  // materialized view over reps. Never authoritative.
  docId: string; roleSetHash: string; chunkKey: string;
  S: number;                         // stability, days
  D: number;                         // difficulty 1..10
  lastRepAt: number; lastGrade: 1|2|3|4;
  maxDemandPassed: number;           // RAW, undecayed, as-of lastRepAt (§11.4 fix)
  bestVerified: 'none' | 'self' | 'recording' | 'asr' | 'type';
  reps: number; effReps: number; lapses: number; streak: number; totalSec: number;
  peekTotal: number;                 // drives the M1..M3 heat strip with no scheduler at all
  confCeiling: number;               // 100*C at lastRepAt. NOT confidence. Not indexed. (§11.5 fix)
  dueAt: number;                     // indexed; the only stored ordering that encodes S
  reanchoredFrom?: string; reanchorSim?: number; orphanedAt?: number | null;
  createdAt: number; updatedAt: number;
}
```

Note what is **not** here: no `conf` field and no `[docId+conf]` index. `retrievability(0, S) === 1` for
every `S`, so a stored `conf` is just `100·C` relabelled, and ordering by it ranks a chunk last
practised 60 days ago as *stronger* than one practised an hour ago. Confidence is computed in memory for
the open document's rows — 250 rows and one `Math.pow` each is microseconds.

```ts
interface Session {
  id: string; docId: string; roleSetHash: string;
  startedAt: number; endedAt: number | null;   // null => crashed; treat as lastRep + 30 s
  plannedSec: number; activeSec: number;
  phase: 'acquisition' | 'consolidation' | 'polish' | 'maintenance' | 'freeform';
  blocks: SessionBlock[];                       // the generated plan, kept for post-hoc analysis
  runDurationSec: number | null;                // a full run inside this session, if any
  runSplits: Array<{ chunkKey: string; sec: number; stumble: boolean }> | null;
  summary: { repCount: number; effReps: number; passRate: number; chunksTouched: number;
             newChunks: number; peeks: number; readinessBefore: number; readinessAfter: number } | null;
  device: 'phone' | 'tablet' | 'desktop';
  createdAt: number; updatedAt: number;
}

interface Annotation {               // M4. Folds UX's "Always show" and "Mark as weak" into one model.
  id: string; docId: string;
  anchor: { lineFingerprint: string; tokenStart?: number; tokenEnd?: number };
  kind: 'alwaysShow' | 'weak' | 'note' | 'bookmark';
  text?: string;
  createdAt: number; updatedAt: number; deletedAt: number | null;
}
```

`alwaysShow` annotations feed the `Protect` lens as a **candidate filter** (§8.4), so an always-show word
is never counted in `k` and never masked at any rung.

### 6.3 Size budget

Reference document: a 5,000-word script, ~180 chunks at 28 words.

| Data | Per reference doc |
|---|---|
| `documents` metadata | ~1.4 kB |
| `docText` | ~30 kB |
| `derived` (flat arrays) | ~16 kB |
| `mastery` (180 × ~180 B) | ~32 kB |
| `reps` (180 × 25 × ~150 B) | ~675 kB |
| `sessions` | ~25 kB |
| **Total, no audio** | **≈ 0.78 MB** |
| One 10-minute recording, Opus 32 kbps mono | ~2.4 MB |

100 documents ≈ 78 MB without audio. Recording cap default 200 MB with LRU eviction of unpinned takes;
warn at 80% of `navigator.storage.estimate().quota`, refuse new recordings at 95% rather than failing
mid-write. Audio dominates everything, which is why it is capped and why it never enters the JSON backup.

---

## 7. The text pipeline

Six pure stages over three intermediate representations. Every stage is a pure function, testable in
isolation, with no DOM and no I/O.

```
file / paste ──▶ 1 EXTRACT ──▶ RawLine[] ──▶ 2 SNIFF ──▶ 3 CLEAN ──▶ RawLine[]
                                                                        │
                             6 CHUNK ◀── 5 TOKENIZE ◀── 4 STRUCTURE ◀───┘
                                  │
                                  ▼
                              Document  (immutable per pipelineVersion)
                                  │
                                  ▼
                       MaskPlan overlay (mutable, cheap, §8)
```

Two rules that make the whole thing work:

1. **`sourceText` is kept forever and never mutated.** Cleanup and structure are stored as a *recipe*
   (`cleanupConfig` + `structureOverrides` + one optional `manualText`), so rule-toggle undo is free by
   construction and "reset to the original import" always works.
2. **Geometry survives extraction.** A PDF's x-indent is the single best signal for screenplay
   structure. Naive pipelines throw it away at `file → string`; `RawLine` carries it.

### 7.1 Stage 1 — EXTRACT

```ts
type RawLine = {
  text: string;
  indentPt?: number; fontSizePt?: number; bold?: boolean; italic?: boolean;
  alignment?: 'left' | 'center' | 'right';
  pageIndex?: number; yPt?: number;
  letterSpaced?: boolean;        // set by the tracking guard, §7.2
  srcIndex: number;              // stable for diffing
};

type ExtractResult = {
  lines: RawLine[];
  meta: { format: 'paste'|'txt'|'md'|'html'|'pdf'; title?: string; pageCount?: number;
          encoding?: string; hasGeometry: boolean; likelyScanned?: boolean };
  warnings: ImportWarning[];     // surfaced in the review step, never thrown away
};
```

`hasGeometry` is load-bearing: the cue detector gets a confidence boost when it can see indentation and
falls back to purely lexical rules when it cannot.

**paste.** Split on `/\r\n?|\n/`. The paste handler inspects `ClipboardEvent.clipboardData` and prefers
`text/html` over `text/plain` — Google Docs and lyrics sites put real structure there, including
whole-line italics, which is a strong stage-direction signal. Cheap, and a large accuracy win most apps
miss.

**.txt / .md.** Encoding: strip BOM (`EF BB BF` → UTF-8; `FF FE`/`FE FF` → UTF-16); otherwise
`TextDecoder('utf-8', { fatal: true })` in a try/catch, falling back to `windows-1252` with a recorded
warning. If >2% of the result is U+FFFD or in C1, show a manual encoding picker with a live preview of
the first 400 characters. Markdown is *stripped*, not rendered (no `marked`, no `markdown-it`): headings
→ `styleName`, blockquote/list markers stripped with the indent kept, fenced code dropped with a warning
if >20% of the document went, `~~struck~~` text dropped (struck lines are cut lines), whole-line
bold/italic recorded as flags.

**.html.** `new DOMParser().parseFromString(s, 'text/html')` on a detached document, then a block walker
that emits one `RawLine` per block element, `<br>` as a line break, and whole-element italic/bold as
flags. Native, zero bytes.

**.pdf — the only genuinely hard part, and deliberately reduced.** M2 ships exactly this and nothing
more:

```ts
const pdfjs = await import('pdfjs-dist');                  // lazy, import route only
pdfjs.GlobalWorkerOptions.workerPort = new Worker(
  new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), { type: 'module' });
const doc = await pdfjs.getDocument({
  data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
}).promise;
```

1. Run the whole extraction inside **our own** worker too, reporting progress per page, so the main
   thread never stalls on a 120-page script. Cap at 400 pages / 25 MB with a clear message.
2. Per item, normalise the transform against the viewport — never trust the raw transform, or page
   `/Rotate` and flipped coordinate systems corrupt everything:
   ```ts
   const m = pdfjs.Util.transform(page.getViewport({scale:1}).transform, item.transform);
   const x = m[4], y = m[5], size = Math.hypot(m[1], m[3]) || item.height;
   ```
3. **Cluster by y, do not trust `hasEOL`** (it reflects the content stream's layout and fires mid-line on
   tables and columns). `tol = 0.35 × median(size)`; sort by y; greedily group where
   `|y − clusterMeanY| < tol`, updating the mean incrementally so sloped baselines still group.
4. Within a cluster, sort by x. Join with `' '` when `nextX − (prevX + prevWidth) > 0.22 × size`, with
   `'\t'` when the gap exceeds `2.5 × size`, and with nothing when the gap is ~0 (pdf.js emits one item
   per glyph for subsetted fonts).
   **Tracking guard (algo critic's fix):** within a y-cluster, if ≥80% of items are single characters
   *and* the inter-item gaps have low variance in the 0.12–0.45 × size range, join with **no** spaces and
   set `letterSpaced: true`. Without this, a centred tracked title extracts as `T H E   T E M P E S T`,
   which then reads as an ALLCAPS cue and tokenizes into ten one-letter tokens.
5. Emit `RawLine{ text, indentPt: firstItemX, fontSizePt: median(size), yPt, pageIndex, bold }`.
6. Blank-line reconstruction: if `clusterY[i] − clusterY[i−1] > 1.6 × medianLineGap`, emit an empty
   `RawLine`. This recovers the paragraph/verse/speech separations that carry most of the structure.
7. Header/footer handling in M2 is **only** the always-drop pattern list, not repeat detection:
   `^\(?(page\s*)?\d{1,4}(\s*of\s*\d{1,4})?\)?\.?$`, `^\d{1,3}[a-z]?\.$`,
   `^\(?(MORE|CONTINUED|CONT'?D)\)?\.?$`, `^(Rev\.?|Revised)\s+\d`, `^\*+$` — and only when the pattern
   is the **entire** line, so `MARY (CONT'D)` survives as a cue (with the suffix stripped and the speaker
   merged).
8. **Always show the extracted text in an editable preview before saving.** This is what makes an
   imperfect parser acceptable, and it is why column detection, evidence-based de-hyphenation, watermark
   detection and dual dialogue are all LATER: the editable preview already solves "slightly wrong".
9. Scanned detection is one rule: `alphanumericChars / pageCount < 100` → *"This PDF is a scan — it's
   pictures of text, so we can't read the words"* with a `Paste the text instead` button and the OS
   handoff tip (Live Text on iOS, Lens on Android, Preview on macOS). No OCR, ever (§3.2).
10. **CJK PDFs are an explicit v1 non-goal**, stated in the import error copy — we ship no cMaps and no
    standard font data, so CID-keyed PDFs yield nothing usable.

Wiring the pdf.js worker through Vite is a known friction point (`?worker` / `?url` / explicit
`workerSrc`), so **task M0-11 is a throwaway spike that imports pdf.js and logs one page of text**. The
bundling surprise happens on day one, not in session nine. Re-measure the worker with `npm run analyze`
and write the real number into `CLAUDE.md`; the estimates in the design docs (400 kB / 550 kB / 670 kB)
disagree with each other and with pdfjs 6.x reality (>1 MB minified).

### 7.2 Getting files in

```html
<input type="file" multiple
  accept=".txt,.md,.html,.pdf,.json,text/plain,text/markdown,text/html,application/pdf,application/json">
```

**iOS pickers filter by UTI, not by extension string.** An extension-only `accept` greys out files the
user can see, with no error to explain why — and this hits the *restore* path, which is the recovery
mechanism for the eviction risk the whole plan is built around. Therefore: always pair extensions with
broad MIME types, and **on iOS omit `accept` entirely**, sniffing the real type after selection instead
of trusting the picker. "Restore a `.json` backup on an iPhone" is an acceptance criterion (§14.6), not
an afterthought. Desktop also gets drag-and-drop (`dragover`/`drop`, `DataTransfer.items`).

### 7.3 Stage 2 — SNIFF, then Stage 3 — CLEAN

The sniff runs on lightly-normalised text (cleanup rules 1–4 only) and chooses the cleanup preset. This
resolves the ordering paradox: `unwrapHardBreaks` must know whether line breaks are semantic, and only
the sniff can tell it. Real order: `rules 1–4 → sniff → rules 5–9 → structure`.

Sniff features, one pass: `n` non-empty lines; `pAllCapsShort`; `pColonPrefix`; `nRecurringColonNames`;
`pIntExt`; `pParenOnly`; `pBlank`; `medLen`; `p90Len`; `lenVariance`; `pTerminalPunct`;
`nSectionLabels`; `nIdenticalStanzas`; `indentClusterCount`.

| Type | Strong signals | Cleanup preset | Default method | Default chunking |
|---|---|---|---|---|
| `screenplay` | `pIntExt > 0.01`, or `pAllCapsShort ∈ [0.06,0.30]` with `indentClusterCount ≥ 3` | screenplay | `myLines` | `speech` |
| `stagePlay` | `nRecurringColonNames ≥ 3` covering >40% of text, or `NAME.` pattern | stagePlay | `myLines` | `speech` |
| `lyrics` | `nSectionLabels ≥ 2` or `nIdenticalStanzas ≥ 1`; `medLen < 45`; `pTerminalPunct < 0.35`; `pBlank > 0.12` | lyrics | `lineEnds` | `line`, 8 words |
| `poem` | `medLen < 50`, high `lenVariance`, `pBlank > 0.1`, no cues | lyrics | `firstLetters` | `line` |
| `speech` / `prose` | `medLen > 55`, `pTerminalPunct > 0.5` | prose | `lineEnds` (`unit:'sentence'`) | `sentence`, 28 words |

If `confidence < 0.65`, do not guess silently: the review step opens on **"What kind of text is this?"**
with five big buttons and a two-line preview of how each would be treated. One tap, correct forever.
This is an hour's work and it beats any amount of heuristic tuning.

**Cleanup: five rules, fixed order, each a toggle with a live count.** (The design doc's twelve become
five; the cut seven are LATER or absorbed.)

| # | Rule | Default on for | Notes |
|---|---|---|---|
| 1 | `normalise` | all | NFC (**not** NFKC — it rewrites ½, ², and some spaces), `ﬁ`-family ligatures U+FB00–FB06 only, all Unicode spaces → U+0020, drop ZWSP/U+FEFF/U+2060 and control chars other than `\t\n`, keep ZWJ |
| 2 | `punctuation` | all | `‘’‚‛→'`, `“”„‟«»→"`, `‐‑‒−→-` (keep `–` and `—` as distinct), `…→...`, `´`/`` ` `` between letters → `'` |
| 3 | `whitespace` | all | **Harvest before destroying**: leading tabs/spaces → `indentPt = tabs×36 + spaces×4.5` if geometry didn't set it; then interior tabs → space, `[ ]{2,}` → one space, rtrim. Never ltrim before the harvest |
| 4 | `dropArtifacts` | all | The §7.1 pattern list, plus Genius/AZ scrape junk (`Embed`, `You might also like`, `NNNContributors`), plus line numbers when they are monotonic |
| 5 | `joinBrokenLines` | prose, speech **only** | Combined de-hyphenation + hard-wrap unwrapping (below). **Never** default-on for lyrics/verse/dialogue: line breaks there are the memorisation scaffold |

Rule 5, in order, because the order is where the design docs had a real bug:

```
5a. dehyphenate   — line i ends with a hyphen and line i+1 starts with a letter
5b. stripSoftHyphens — remove remaining U+00AD          <-- MUST come AFTER 5a, not in rule 1
5c. unwrapHardBreaks — prose/speech only
```

The design doc put `stripInvisibles` (which removes U+00AD) at position 2 and `dehyphenate` at position
8, while the de-hyphenation decision table's first row is "the hyphen was U+00AD → join and drop it".
Removing the soft hyphen six rules early makes that row dead and leaves `depart ment` in the token
stream. Fixed by splitting the rule.

De-hyphenation in v1 is deliberately simple (the seven-row evidence table is LATER): join, and **keep**
the hyphen if the second word starts uppercase, or either fragment is a single letter, or the first
fragment is in the small prefix set (`self non ex pre re co anti multi semi sub super ultra well ill
over under half all cross mid quasi pseudo`); otherwise join and **drop** the hyphen, flagging it
`lowConfidence` so the cleanup review can list it. Never fire when the next line is blank, a detected
cue, or a heading.

Hard-wrap detection (unchanged from the design doc, because it is good):

```
L = lengths of non-empty lines; p90 = 90th percentile; med = median
hardWrapped =  p90 ∈ [55,100]
            && share(len ∈ [0.80·p90, p90]) ≥ 0.55       // lines pile up at the margin
            && share(line ends with [.!?…"')\]]) ≤ 0.45  // most lines don't end a sentence
            && med / p90 ≥ 0.7                           // not a poem
```

Join `line[i]` to `line[i+1]` iff: `line[i]` does not end with terminal punctuation or a known
abbreviation; `len(line[i]) ≥ 0.78 × p90`; `line[i+1]` is non-empty and starts lowercase or with `,;`;
and `line[i+1]` is not a detected cue/heading/list item/indent outlier.

**Undo for cleanup is free by construction.** Toggling a rule re-derives from the immutable
`sourceText`. Manual editing is a plain textarea saved as one `manualText` override with a single
`Reset to the original import`. There is no command stack and no revision store (§3.2).

**The re-clean hazard.** After the first practice, editing runs the chunk re-anchor (§7.7) and shows a
non-modal banner: *"3 chunks changed — their progress was reset. Undo."* Never silently drop history,
never silently mis-attribute it.

### 7.4 Stage 5 — TOKENIZE

The tokenizer is `Intl.Segmenter` (Baseline, all engines, zero bytes) plus a join / peel / classify pass.
The modes doc's regex tokenizer is deleted: it splits `1,234` into two tokens, `3.14`, `9:30`, `D.C.` and
`e.g.` likewise, which means `hideWords` can render `▁,234` — masking the `1` of a price while showing
`234` — and every mode's `k = round(p · candidates)` is computed over a doubled count.

```ts
interface Token {
  i: number;              // global index — THE stable identifier for masking
  text: string;           // word core: "don't", "mother-in-law", "1,200", "café", "—"
  lead: string;           // leading punctuation: '"', '(', '¿'
  trail: string;          // trailing punctuation: '.', '?!', '..."'
  ws: string;             // whitespace immediately BEFORE lead
  kind: 'word' | 'number' | 'punct' | 'direction' | 'label';
  letterCount: number;    // graphemes bearing \p{L}
  letterGroups: number[]; // per-segment counts for hyphenates: [6,2,3] for mother-in-law
  firstLetter: string;    // grapheme-safe
  normalized: string;     // NFD, marks stripped, lowercased, apostrophes unified
  lineIdx: number; blockIdx: number; chunkIdx: number; sentIdx: number;
  posInLine: number; lineLen: number; posInSent: number; sentLen: number;
  // derived flags (computed in one pass after tokenizing; NOT a second tokenizer)
  isFunction: boolean; isProperish: boolean; hasDigit: boolean;
  count: number;          // occurrences of `normalized` in the document (hapax scoring)
  isMaskable: boolean;    // kind ∈ {word,number} && block type ∈ {dialogue,paragraph,verse}
}
```

Algorithm:

```
tokenize(lineText, lang):
  PRECONDITION: lineText is NFC (asserted; cleanup rule 1 guarantees it)
  segs = [...new Intl.Segmenter(lang, {granularity:'word'}).segment(lineText)]

  1. GROUP — accumulate a token per word-like segment; re-join across a non-word segment S when:
       S is "'" or "’" and both neighbours are word-like     -> don't, O'Brien, y'all, rock'n'roll
       S is "-"        and both neighbours are word-like     -> mother-in-law, e-book, T-shirt
       S is "."        and both sides are single letters, or the left side is a known abbreviation
       S is "," or "." and both neighbours are ALL DIGITS    -> 1,200   3.14
       S is ":" or "/" and both neighbours are ALL DIGITS    -> 9:30    1/2
       S is "&"        and both neighbours are single caps   -> R&B, AT&T
     Never join across: whitespace, – — ― … " ' ( ) [ ] { } « » ! ? ; : / \ | * + = @ # ~ ¿ ¡
     and all \p{Ps}\p{Pe}\p{Pi}\p{Pf}.
  2. PEEL — move leading \p{P}\p{S} into `lead`, trailing into `trail`. EXCEPTIONS stay in `text`:
       a leading apostrophe in the ELISION set ('tis 'twas 'em 'til 'round 'cause 'bout 'n)
         or before two digits ('90s, '76)
       a trailing apostrophe after 's' (dogs', James')
       a trailing '.' that is part of an abbreviation kept in step 1
  3. EMIT SEPARATORS — any standalone run of non-word, non-peeled characters becomes
     kind:'punct', isMaskable:false. This is what makes "wait—no" behave.
  4. WHITESPACE — `ws` is the exact preceding whitespace. Never lost.
  5. CLASSIFY — see the flag rules below.
```

**The master invariant, and the highest-value test in the project:**

```
for every Line:  line.tokens.map(t => t.ws + t.lead + t.text + t.trail).join('') === line.text
```

Exact string equality, property-tested with `fast-check` over generated mixes of Latin words, accents,
CJK, Hebrew, digits, every Unicode punctuation category, emoji and random whitespace. This is what lets
us render from tokens instead of from text without risking a visual difference from the source. The
modes doc's round-trip test (`join(' ')`, "modulo whitespace normalisation") is vacuous and impossible
for CJK; it is deleted.

**Derived flags, with the algo critic's fixes applied:**

```ts
// functionWords.ts — NORMALISE THE LIST AT MODULE LOAD. This is the fix for the single worst
// silent bug in the design docs: every contraction in the list was written with a curly apostrophe
// while Token.normalized straightens them, so `don't`, `can't`, `I'm` were all scored as CONTENT
// words — and `I'm` even scored as a proper noun, so Key Words hid it first.
export const FUNCTION_WORDS = new Set(
  RAW_EN.map(s => s.normalize('NFKC').toLowerCase().replace(/[’´`]/g, "'"))
);

isFunction = FUNCTION_WORDS.has(t.normalized)
          || (isLatinLikeScript(lang) && t.normalized.length <= 2);   // script-conditional:
             // without the guard, every 1–2 character CJK token is a "function word" and
             // keyWords has zero candidates for Japanese.

isProperish = /^\p{Lu}/u.test(t.text) && t.posInSent > 0 && !isAllCaps(t.text)
           && t.text.replace(/[^\p{L}]/gu, '') !== 'I'      // excludes I'm / I'll / I've / I'd
           && lang !== 'de';                                 // German capitalises all nouns

hasDigit  = /\p{N}/u.test(t.text);
isContent = t.kind !== 'punct' && !t.isFunction;
```

`tokFlags` bitfield in `derived`: bit0 maskable, bit1 word, bit2 number, bit3 punct, bit4 direction,
bit5 function, bit6 properish, bit7 hasDigit, bit8 hapax (`count === 1`), bit9 repeated (`count ≥ 4`),
bit10 lineFirst, bit11 lineLast, bit12 sentFirst, bit13 sentLast, bit14 alwaysShow.

**Per-script rules.** A `LanguageProfile` table, as data not prose, states for each script which methods
are `available` / `hidden`:

| Script | Available methods | Hidden, and why |
|---|---|---|
| Latin / Cyrillic / Greek | all | — |
| CJK (Han/Kana/Hangul) | `hideWords`, `hideLines`, `lineEnds`, `lineStarts`, `chunkWindow`, `myLines`; `firstLetters` becomes "first character" | `keyWords`/`glueWords` (no function-word list), `rhymes` (no orthographic rhyme tail) |
| Arabic / Hebrew (RTL) | whole-word and line-level methods only | `firstLetters` — hiding a middle letter changes the *shapes* of its neighbours in Arabic joining forms. Real bug, real reason to restrict |
| Any language with no function-word list | whole-word and line-level methods only | `keyWords`, `glueWords` |

Line spans get `unicode-bidi: isolate` so masked/unmasked transitions never reorder RTL text. `letterCount`
is always a **grapheme** count (Vietnamese, Devanagari, emoji ZWJ sequences) — never `.length`.

Function-word data: ~210 English entries (articles/determiners, pronouns including `thou thee thy thine`
because Shakespeare and hymns are a real use case, all inflections of be/have/do, modals and negations,
prepositions, conjunctions, degree adverbs and particles), and ~120 each for es/fr/de/it/pt/nl, lazily
imported per language, ~6 kB total. Numerals-as-words are deliberately **not** in the list (they are
high-value content in speeches).

### 7.5 Stage 4 — STRUCTURE (single pass in v1, hardened)

```ts
type BlockType = 'title'|'sceneHeading'|'sectionHeading'|'action'|'dialogue'|'parenthetical'
               | 'transition'|'verse'|'paragraph'|'stageDirection'|'ignored';
```

**Shortcut paths, checked first because they are free:** HTML `<Paragraph Type="Character">` from an FDX
export → trust it. (DOCX/RTF style names arrive with those importers, LATER.)

**Cue detection, three patterns, all requiring a recurrence guard.**

*ALLCAPS cue.* Score from 0:

| Condition | Δ |
|---|---|
| ALL-CAPS: ≥2 letters and uppercase ratio ≥ 0.9 | +0.30 |
| ≤40 chars and ≤5 words | +0.15 |
| no terminal `.`/`,`; a trailing `:` is allowed and stripped | +0.10 |
| next non-blank line exists and is not ALL-CAPS | +0.15 |
| preceded by a blank line | +0.10 |
| `indentPt` in the cue bucket (only when `hasGeometry`) | +0.30 |
| ends with a known suffix `(CONT'D) (V.O.) (O.S.) (O.C.)` | +0.20 |
| **terminal `!` or `?`** | **−0.35** ← fix: real cues never end in them; without this, a son shouting `MOTHER!` becomes a speaker and silently steals his own next speech |
| matches a scene-heading or transition pattern | −0.90 |
| ≥6 words, or contains any lowercase word | −0.50 |
| a lone number, `\|`, `*`, or an artifact pattern | −0.90 |
| the same ALLCAPS token also appears inside longer mixed-case lines and this line has ≥3 words | −0.30 |

Accept at ≥0.70; 0.45–0.70 accepted with low confidence and surfaced in review; below 0.45 rejected.

**Two global guards, both fixes for real failure modes the design docs would have shipped:**

1. **`count ≥ 2` is required** for an ALLCAPS cue name. The design doc's escape hatch
   (`count === 1 && score > 0.8`) admits every ALLCAPS poem title in a collection as a speaker.
2. **Singleton-collection guard:** if more than 8 candidate names are singletons, the document is a
   titled collection, not a cast — reclassify every singleton as `heading`.

*`NAME:` prefix* (stage plays, musicals, interviews, transcripts, lyrics annotations).
`^\s*([^\s:][^:]{0,39}):\s+(\S.*)$`, plus: name part ≤5 words, no terminal punctuation, not ending in a
digit; the character before `:` must not be a digit (kills `9:30`); blocklist for the name part
(`note warning caution nb ps re fwd subject from to date time act scene chorus verse bridge intro outro
tempo key capo tuning source translation http https www`); and **recurrence required** — the same
normalised name appears ≥2 times, or ≥3 distinct such names cover ≥35% of non-blank lines. Score 0.85
when recurrence passes, 0.45 for a singleton in an otherwise-matching document.

*`NAME.` prefix* (Shakespeare, Arden/Penguin editions):
`^([A-Z][\p{L}'’.\- ]{1,28})\.\s+(\p{Lu}|\p{Lu}?['"“])`, same recurrence requirement, plus an
abbreviation guard (`Mr Mrs Dr St Jr Sr Prof Rev Capt Sgt Lt No Vol Ch Fig Op`). Folio abbreviations
(`Ham.`, `Oph.`) are fuzzy-mapped to full names found in a dramatis-personae block if one exists.

*Ensemble names* `ALL BOTH EVERYONE OMNES CHORUS COMPANY ENSEMBLE CROWD TOGETHER` → `isEnsemble: true`,
selectable as a role and offered *additively*: picking MARY asks "also practise lines marked ALL/BOTH?"
— which matters a lot in musicals.

**Headings, transitions, directions.**
`^\s*(\d{1,3}[A-Z]?\s+)?(INT\.?|EXT\.?|EST\.?|I\/E\.?)[\s.]` → `sceneHeading` 0.95;
`^(ACT|SCENE|PROLOGUE|EPILOGUE|INTERMISSION)\s+([IVXLC]+|\d+|ONE|TWO|…)\b` → `sectionHeading` 0.90;
ALLCAPS ending in `TO:` or in the set `{FADE IN:, FADE OUT., CUT TO:, DISSOLVE TO:, THE END, BLACKOUT.,
CURTAIN.}` → `transition` 0.90; a whole line in `(...)`/`[...]`, or a whole-line italic from
HTML/Markdown → `stageDirection` 0.85. Lyric section labels
(`intro|verse|pre-chorus|chorus|hook|refrain|bridge|middle 8|break|instrumental|solo|interlude|outro|
coda|tag|vamp|reprise`) with optional number and brackets → `sectionHeading`, and Genius-style
`[Verse 1: Artist]` keeps the label, drops the artist, and records the artist as a **speaker** — role
isolation for duets at zero extra cost.

**Inline directions**, not blocks: `(...)`/`[...]` *within* a dialogue line becomes tokens with
`kind:'direction'`. That gets three things for free — the line still renders as one line, the words are
never masked, and they never count toward word totals. Guard with an inline-direction lexicon
(`beat pause aside sotto laughs cont'd to X`), bracket type (`[...]` is nearly always editorial), and
italic formatting where available. When unsure, keep it **spoken** — that error is much less annoying
than the reverse. Lyric annotations `(x2) (repeat) (instrumental)` are directions too.

**Manual correction is built before heuristic polish** — this inversion is explicit, because the review
UI is what makes imperfect detection acceptable:

- Tap a line in Structure mode → sheet with Type (Dialogue / Direction / Heading / Paragraph / Verse /
  Ignore), Speaker chips (+ New), **"⚡ Apply to all 14 lines like this"**, Merge up, Split here.
- "Apply to all like this" generalises on the signal that actually misfired: same `indentPt` bucket, same
  leading token, same ALLCAPS-ness. Show the count before applying; one undo step. One tap fixes a
  systematically wrong document — the difference between a usable and an infuriating pipeline.
- Bulk toggles: "ALLCAPS short lines are character names", "Lines in (parentheses) are stage
  directions", "Italics are stage directions", "Keep line breaks". Each is a one-tap re-derive.
- Speaker manager: rename, merge (drag one chip onto another), mark ensemble, set "my role", with a
  fuzzy-similar suggestion strip (`Merge MARY and Mary? (17 + 3 lines)`) — offered, never forced, and
  never auto-merging short names (`JIM`/`TIM`).

Overrides are keyed to a **line fingerprint**, not an index, so they survive re-cleaning:
`LineFingerprint = fnv1a(normalizeForKey(lineText)).slice(0,8) + ':' + ordinalOfThatHashInDoc`. Any block
touched by an override gets `confidence = 1, userConfirmed = true` so the review UI stops nagging.

### 7.6 Verse indentation

`indentEm` (quantised from harvested `indentPt` into 0/1/2/3 buckets so noise does not produce ragged
output) is stored per line in `derived.lineIndentEm` and rendered. Herbert, Hopkins, hymn metre and
indented refrains all depend on it, and it is a memory cue in its own right. It composes with the
wrapped-row hanging indent (§9.2): the indent is the block's `padding-inline-start`, the hanging indent
is a `text-indent: -1.25em` on top of it. Shared/split verse lines across two speakers are LATER.

### 7.7 Stage 6 — CHUNK, and chunk identity

```ts
interface Chunk {
  key: string;              // content hash + ordinal, see below
  tokenRange: [number, number];
  blockIdx: number[]; roleId?: string;
  orderIndex: number; wordCount: number; maskableCount: number;
  sectionId?: number;       // nearest preceding scene/section heading — the natural review group
}
```

Defaults by type: `speech` for scripts (the rehearsal unit is cue-to-cue), `line` for lyrics and poems
(the line *is* the memory unit, and rhyme/metre make lines self-cueing), `sentence` merged to ~28 words
for prose and speeches. `TARGET = 28, MIN = 6, MAX = 60, HARD_MAX = 90`.

```
buildChunks(units, mode):
  for u in units:
    if wordCount(u) <= MAX: emit(u); continue
    split u recursively at the first available boundary:
      sentence boundaries
      clause boundaries  /[;:—]|,\s+(and|but|or|so|because|which|who|then)\b/
      line boundaries                       # a long verse splits at its line breaks
      nearest word boundary at TARGET        # last resort
  merge runt units (< MIN) forward when mergeable:
      same block, or (same role && same block type && no heading or blank run between
                      && the previous line is not a semantic break)
```

Never split inside a token, inside an inline-direction span, or across a speaker change. Always split at
scene/section headings and at user markers (a `---`/`***` line in pasted text, or a long-press on the
line gutter, stored as a `LineFingerprint`).

Sentence segmentation is `Intl.Segmenter(lang, {granularity:'sentence'})` with three corrections:
an abbreviation guard (`Mr Mrs Ms Dr Prof Rev Fr St Sr Jr Capt Sgt Lt Col Gen vs etc e.g i.e cf al No
Vol Ch Fig Op Inc Ltd Co Dept Univ approx Jan…Dec Mon…Sun`, plus single-capital initials); quote/bracket
balance; and never crossing a block boundary (segment *within* each block).

**Chunk identity — the most important decision in this section.**

```ts
function normalizeForKey(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '')
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s']/gu, ' ')
          .replace(/\s+/g, ' ').trim();
}
const contentHash = fnv1a64hex(normalizeForKey(text));
chunkKey = `${contentHash}.${tokenCount}#${rankWithinIdenticalGroup}`;
```

Punctuation- and case-insensitive, so "correcting the comma" never resets a chunk. Collision risk at
5,000 chunks with 64 bits is <1e-13, and synchronous hashing (no `crypto.subtle` promise) keeps the
chunker a pure function, which matters for testability.

`rankWithinIdenticalGroup` is the **fix** for the design doc's `duplicateOrdinal`. Ordinal-by-order-of-
appearance breaks on the commonest lyric edit: add one repeat of the chorus at the top and every later
chorus's ordinal shifts, so the exact pass fails for all of them, and because choruses are 20–40
positions apart the fuzzy pass's ±5 window blocks every rescue too — every chorus is orphaned and the
scary "restore progress" banner fires. Instead: group old and new chunks by content hash first, then
pair them in order **within each identical-text group**. Inserting a chorus then re-anchors 3-of-4
correctly and orphans only the genuinely new one.

**Re-anchoring.** v1 ships stage 1 only; stages 2–3 are LATER (§3.3).

```
STAGE 1 (v1)  exact chunkKey match -> carry mastery unchanged.
              Handles insertions, deletions, reordering, and edits ELSEWHERE in the document,
              which is 95%+ of real cases.
STAGE 2 (LATER) fuzzy: for unmatched new chunks, compare against unmatched old chunks within
              ±max(5, 0.1·chunkCount) positions using
                  sim = 0.5·dice(unigrams) + 0.5·jaccard(3-gram shingles),  threshold 0.5
              Greedy highest-first. This metric is the fix for "the director cut 4 scattered
              words": pure 3-gram Jaccard on a 20-word chunk gives ~0.20 and orphans it, while
              unigram Dice gives ~0.80 and the blend lands at ~0.5.
              Carry-over penalty: S <- S·(0.4+0.6·sim), maxDemandPassed <- ·0.85.
STAGE 3 (LATER) orphan retention 30 days + a "restore progress" banner when >20% orphaned in
              one edit.
```

`reps` are **never** rewritten. They keep their original `chunkKey`; the fold walks `reanchoredFrom`
chains (max depth 8) when recomputing. Append-only means history is never a lie.

### 7.8 Role isolation

```ts
isMaskableNow(t) =
     t.kind === 'word' || t.kind === 'number'
  && blockType(t) ∈ {dialogue, paragraph, verse}
  && (myRoleIds.length === 0 || myRoleIds.includes(roleOf(t)))
  && t.kind !== 'direction'
  && !hasAnnotation(t, 'alwaysShow')
```

Everything else — other speakers' dialogue, stage directions, parentheticals, scene headings — stays
**fully visible**. That is the definition of a cue: it must be readable or it cannot cue you.

Three view modes, all free from the same model:

| Mode | Renders | For |
|---|---|---|
| **Full script** (default) | the whole script in order; my dialogue maskable; other speakers' lines at `opacity: 0.7`; directions dimmed italic; the current scene heading sticky at the top of the viewport | learning in context |
| **Cue script** | other speakers' lines collapsed to their **last 5 words** (`… I told you not to come.`), tappable to expand; my lines full-size and maskable | the historically correct rehearsal artifact; a 120-page script becomes ~30 phone screens |
| **My lines only** | just my speeches, each with a small grey caption above showing the cue tail and the cue-giver's name | off-book checking, "do I know speech 14?" |

Cue tail length is user-settable (3/5/8/whole line); 5 is the default. Always show the **end** of the cue
line — the end is what actually triggers you. The final word of each cue line immediately preceding one
of my lines gets a subtle underline; this is the single most useful affordance for actors and it is
always on.

`roleSetHash = hash(sorted(myRoleIds)) || 'all'` and it is part of the `mastery` primary key and of every
`Rep`. Practising as MARY must not pollute your JOHN stats, and an actor with 40 of 500 words must not
see 92% readiness because everyone else's lines are visible. Changing `myRoleIds` keeps both role sets'
progress; the heat map shows which role set it belongs to and nothing is ever silently migrated.

---

## 8. The memorization modes

### 8.1 The frozen catalogue

Thirteen entries, one set of ids, one set of user-facing names. The ids are persisted in
`DocPractisePrefs.methodId` and in every `Rep`, so **they never change once shipped**. Five kernels
implement all thirteen.

| # | id | User-facing name | Kernel | Milestone |
|---|---|---|---|---|
| 1 | `hideWords` | Hide words | percent | **M1** |
| 2 | `firstLetters` | First letters | percent | **M2** |
| 3 | `lineEnds` | Line endings | positional | **M2** |
| 4 | `lineStarts` | Line starts | positional | **M2** |
| 5 | `hideLines` | Hide lines | lineLevel | **M2** |
| 6 | `keyWords` | Keywords out | percent (`weighting:'content'`) | **M2** |
| 7 | `glueWords` | Glue words out | percent (`weighting:'function'`) | **M2** |
| 8 | `rhymes` | Keep the rhymes | positional (`rhymeOnly`) | **M2** |
| 9 | `chunkWindow` | Chunk window | window | **M2** |
| 10 | `myLines` | Cue lines *(Actor)* | lens + inner method | **M2** |
| 11 | `snowball` | Snowball | window (stepped) | M4 |
| 12 | `spotlight` | Spotlight | window (stepped) | M4 |
| 13 | `typeItBack` | Type it back | percent + `input` style | M4 |

Ten at M2 satisfies the "10+ methods" parity claim honestly. Cut permanently, with reasons:
**Blur** (GPU work at 2,000 tokens for an effect the ladder already provides, and it leaves the real
glyphs in the DOM, defeating the whole masking contract); **Word Shapes** (needs a `scaleX` fit pass and
a measurement cache for a marginal cue); **Facts & Figures** (a 60-word unit list plus a
German-specific fallback for one audience segment); **Shuffle check** (needs a bespoke drag-to-reorder
interaction model plus a tap-to-place a11y equivalent, for a test nobody asked for); **Sentence Tail**
(available as `lineEnds` with `unit: 'sentence'`); **From memory** and **Skeleton** (these are ladder
rungs of `hideWords` and `firstLetters`, not methods); **Openers** (the extreme rung of `lineEnds`).

### 8.2 One function, one plan

```ts
type MaskStyle = 0|1|2|3|4|5|6;   // none | rule | dots | initial | dim | blank | input
                                  // NB: 'blur' and 'shape' are gone with their methods.

interface MaskPlan {
  styles: Uint8Array;             // per token, a MaskStyle code
  lineFlags: Uint8Array;          // bit0 hiddenLine, bit1 dimLine, bit2 cueLine, bit3 focusLine
  focus: { firstLine: number; lastLine: number } | null;
  step: { index: number; total: number } | null;
  inputs: number[];               // token indices rendered as typing fields (typeItBack only)
  maskedCount: number; candidateCount: number; contentMaskedCount: number;
}

interface ModeSpec {
  methodId: MethodId;
  ladderIndex: number | null;     // 0..6
  customPercent: number | null;   // exactly one of these two is non-null
  params: Record<string, number|string|boolean>;
  lens: { myRoleIds: string[]; cueStyle: 'full'|'tail'|'hidden'; cueTailWords: number };
  scope: { kind: 'text'|'chunk'|'selection'; chunkKey?: string; range?: [number, number] };
  blankStyle: 'underline'|'box'|'dots';
  reshuffle: number;              // seed counter
  phase: number;                  // structural-mode phase shift
  reveals: { peeked: number | null; revealed: Set<number>; revealAll: boolean };
}

computeMaskPlan(doc: Document, spec: ModeSpec): MaskPlan     // PURE. No DOM, no I/O, no Math.random.
```

Everything — rendering, gestures, the ladder, progress — reads the plan. Nothing else computes masking.
Budget: **plan build < 8 ms** and **plan apply < 16 ms** on a 5,000-token document; verified in `bench/`
and profiled on a real mid-range Android at task M1-14, which is a *gate that may change this contract
while it is still cheap*.

### 8.3 The rendering contract — ADR-0005

One span per token. `lead` and `trail` are text nodes, not elements. The `.ovl` overlay element is
created **only** for tokens actually masked in the current plan, and only for styles that need it
(`initial`). At 10,000 words this is ~10k elements, not the ~40k that four nested spans per token would
produce.

```html
<span class="tok" data-i="128" data-mask="rule">“<span class="txt">Ophelia</span>,</span>

<!-- masked with a kept initial: one extra absolutely-positioned child, only when needed -->
<span class="tok" data-i="128" data-mask="initial"><span class="txt">Ophelia</span><span class="ovl" aria-hidden="true">O</span></span>

<!-- masked AND focusable (inside the rendered window): the outer element is a real button -->
<button class="tok" data-i="128" data-mask="rule" type="button"
        aria-label="Hidden word 3 of 7. Activate to reveal."><span class="txt">Ophelia</span></button>
```

```css
.tok { position: relative; display: inline-block; }
.tok[data-mask]:not([data-mask="none"]) > .txt { visibility: hidden; }
.tok[data-mask="rule"]    { border-bottom: 2px solid var(--mask-rule); }
.tok[data-mask="dots"]    { border-bottom: 2px dotted var(--mask-rule); }
.tok[data-mask="box"]     { background: var(--mask-fill); border-radius: var(--r-xs); }
.tok[data-mask="dim"]     > .txt { visibility: visible; opacity: var(--dim, .28); }
.tok[data-mask="blank"]   { border-bottom-color: transparent; }
.tok[data-mask="initial"] > .ovl { position: absolute; inset: 0; pointer-events: none; }
.tok.peek > .txt, .tok.revealed > .txt { visibility: visible; }
.tok.peek > .ovl, .tok.revealed > .ovl { display: none; }
.tok.peek                 { color: var(--peek-text); background: var(--peek-bg); }
```

**`visibility: hidden` on the inner span is the load-bearing choice, and it is the whole reason this
contract wins.** It gives us, in one decision and with zero measurement code:

- the box keeps its **exact advance width** in every font, at every size, with any `letter-spacing` or
  `word-spacing` or `font-variant` the accessibility pack sets — so "no layout shift on reveal" is
  structurally true rather than approximately true;
- the glyphs leave the **accessibility tree**, so nothing leaks to a screen reader;
- the glyphs leave **selection** and **find-in-page**, so `⌘F` and select-all cannot cheat;
- filters and opacity do not affect layout either, so `dim` is equally safe.

The three losing contracts are deleted and must not reappear:
`color: transparent` (the architecture doc's own §9 admits it leaks to copy, select and screen readers);
the canvas-`measureText` width (`measureText` ignores `letter-spacing`, `word-spacing`,
`font-feature-settings` and synthetic bold, and rounds differently from layout — so blanks land 1–3 px
off per word and words visibly nudge on reveal, *precisely* for the low-vision users who turned the
spacing pack on); and the four-nested-spans-per-token markup (blows the DOM budget).
`useTokenWidths` is deleted from the hook inventory.

Two consequences to state plainly rather than pretend about: devtools can see the text (so can
IndexedDB — we are not building DRM), and `user-select: none` on the canvas means a quote cannot be
selected, which is why `⋯ → Select text` (which turns peek off while active) and `Copy this line` exist.

**Punctuation is never masked.** `lead` and `trail` always render. Keeping commas, periods and question
marks visible is what makes heavily-masked text still readable as structure.

**Windowing.** Above 2,000 tokens each block gets
`content-visibility: auto; contain-intrinsic-size: auto var(--est-h)`, with `--est-h` derived per block
from `ceil(chars / charsPerLine) × lineHeight` so the initial estimate is within ~10%. One windowing
strategy only — the `IntersectionObserver` virtualisation in modes §3.4 is deleted. Honest accounting of
what `content-visibility` costs us, correcting the architecture doc's claim that it costs nothing:
Safari does **not** make skipped content findable by find-in-page (we do not care: the canvas is
`user-select: none` and we ship in-app search), and `scrollHeight` is **not** stable while estimates are
replaced by real sizes — which is why autoscroll velocity is measured from the current block instead
(§9.5) and why re-anchoring is always by logical line index, never by `scrollTop`.

**Applying a plan** is a diff: compare the new `styles` array against the previous one and write
`data-mask` only on changed tokens. Typically a few hundred nodes out of thousands.

### 8.4 Determinism, nesting, and the four monotonicity fixes

```ts
seed = cyrb128(`${docId}|${methodId}|${roleSetHash}|${scopeKey}|${reshuffle}`);   // -> sfc32
// THE LADDER INDEX IS DELIBERATELY NOT IN THE SEED.
```

```
1. candidates = tokens that are eligible, AFTER all filters (see fix A)
2. r[k] = rand() for the k-th candidate            // one pass, independent of the rung
3. pickOrder = candidates sorted by r, index-ascending as tie-break
4. spacing pass (below) reorders pickOrder without breaking prefix-consistency
5. masked set at fraction p = pickOrder.slice(0, k)
```

**Spacing pass.** At low densities adjacent blanks are disproportionately hard and look like damage.
Greedy: walk `pickOrder`, accept a candidate if no already-accepted candidate lies within `minGap` word
positions **on the same line**; rejected candidates go to a deferred queue, replayed with `minGap-1`,
then `0`. The result is a single total order, so the prefix property still holds exactly.

Four fixes, all of them load-bearing invariants that would be very hard to retrofit:

**A. `Protect` and `MyLines` are candidate *filters*, applied BEFORE `k` is computed — not post-passes.**
The design doc ordered them after selection, which produced three bugs at once: the exact-cardinality
test could never pass; the percentage shown in the UI was not the density delivered; and with a 40-of-500
word role, `k = round(0.10 × 500) = 50` picks landed ~4 on your lines with a variance of 0 to 9, making
`assistRate`'s denominator — the number the whole ladder is driven by — pure noise. As filters they are
monotone in the rung, so nesting survives, cardinality is exact by construction, and the small-role case
is well defined. Only `Window` and `Reveals` remain post-passes.

`Protect` excludes, at the rung stated: first word of each line (rungs ≤2); interjections
(`oh ah well hey hm hmm huh ugh wow yeah yes no please look listen now why`, rungs ≤3, default on for
scripts, off for prose — actors lose the *rhythm* of a line, not its content, when these vanish);
speaker labels, stage directions and headings (always); numbers (rungs ≤4); `alwaysShow` annotations
(always).

**B. `k = p > 0 ? Math.max(1, Math.round(p · n)) : 0`.** Without the floor, a 5-word lyric line is pinned
forever: at 10% and 20% `round` gives 0, so the step-up gate (`peeks == 0 && maskedCount ≥ 3`) can never
be satisfied at a low rung, and the rung with `maskedCount ≥ 3` can only be *reached* by stepping up.
Deadlock — and `line`-chunked lyrics are the default for a whole audience. The cardinality test becomes
`k === clamp(round(p·n), p>0 ? 1 : 0, n)`.

**C. `minGap` is a constant per (method, document), derived once from median line length. It is never a
function of the rung.** The design doc had it "auto-relax when `p > 0.5`", which changes the total order
between rungs and therefore destroys the `masked(L_n) ⊆ masked(L_{n+1})` guarantee outright. At high `p`
adjacency is geometrically unavoidable anyway.

**D. Structural ladders are made monotone per line.** `lineEnds` uses
`n_L = max(n_{L-1}, f(L))` so a 4-word line can never get *easier* going up a rung (the design doc's
`0/1/1/2/3/'half'/'half'/'all'` masks 3 words at L4 and 2 at L5 on a 4-word line — and 4–6-word lines are
what lyrics are made of). `hideLines` is re-implemented as a seeded **nested permutation of lines** with
`p = 0/.25/.40/.55/.70/.85/1.0`; the `alternate period 4 → 3 → 2` ladder is deleted because line ordinal
4 was hidden at L1, visible at L2 and hidden at L4 — a mode that shipped by default for songs and would
have failed the conformance suite's most important test.

**Per-method `nestedLadder: boolean`.** Monotonicity is asserted by the shared conformance suite for
every method where it is `true` (all ten in M1–M2). The stepped M4 methods declare it `false` and are
exempt by name, not by a failing test.

**Reshuffle** advances `reshuffle` (a new permutation, same `k`). For structural methods it advances
`phase` instead, which flips alternation parity and shifts which line gets the extra masked token when
`p × len` is fractional. Reshuffle is never a no-op and never destructive.

### 8.5 The methods

Each entry: algorithm, difficulty knob, render style. `p` comes from the ladder (§8.6).

**1. `hideWords` — Hide words.** *"Hide a growing share of the words, spread evenly."*
Candidates: `isMaskable` after filters. Order: seeded permutation + spacing pass, `minGap` from median
line length (2 for lines ≥8 words, 1 otherwise). `k` per fix B. Style: `blankStyle`.
Params: `weighting: 'uniform'` (fixed for this entry), `minGap`, `finalStyle: 'rule'|'blank'`.
The baseline behaviour and the safest default for any text.

**2. `firstLetters` — First letters.** *"Every hidden word keeps its first letter as a nudge."*
Identical selection to `hideWords` but seeded with its own `methodId`, so the two are independent.
Style: `initial` — the first grapheme (via `Intl.Segmenter`) drawn at the left edge of the box, the rest
of the box drawn as a rule from `letterWidth + 0.08em`.
Params: `keepLetters` 1–3 (ladder drops 3→2→1), `keepFinalLetter` (default false; shows `O……a`).
At `p = 1, keepLetters = 1` this **is** the classic skeleton mnemonic — the whole text as first letters
and punctuation. Note honestly in the method card that word length remains visible because the box is
the real word's width; a `compress` option that renders first letters only (accepting reflow, sanctioned
by name and exempted from the no-reflow CI test) is LATER.
The single most effective crutch level: users who fail at 35% in `hideWords` succeed at 55% here.

**3. `lineEnds` — Line endings.** *"Hide the end of every line — the part people always fumble."*
For each line in scope with `wordCount ≥ 2`, mask the last `n` word tokens, `n` monotone per fix D,
`n = min(n_L, wordCount - keepMin)` with `keepMin = 1` until the ladder says `all`.
Params: `n` 1–6 | `'half'` | `'all'`; `keepMin` 0–3; `unit: 'line'|'sentence'` (`sentence` is the old
Sentence Tail method); `rhymeOnly` (see method 8).
Line ends carry rhyme, punchlines and hand-offs — the highest-yield structural method for lyrics and
stand-up.

**4. `lineStarts` — Line starts.** *"Hide the first few words of each line."*
Inverse of `lineEnds`: mask the first `k` word tokens of each line, `k = 1 → 2 → 3 → 4 → half → all`.
Fixes "I know it once I've started", which is the actual failure mode for verse.

**5. `hideLines` — Hide lines.** *"Whole lines vanish."*
Seeded nested permutation over lines where `wordCount ≥ 1` and the block type is
`{dialogue, paragraph, verse}`; prefix at `p`. Every word token in a hidden line takes `blankStyle`;
punctuation stays; **the line box keeps its full height and wraps identically** — a hidden line never
collapses.
Params: `keepFirstWord` (default false; when true the line's first word stays visible, which turns this
into a very effective prompt-line drill), `p`.

**6. `keyWords` — Keywords out.** *"Only the words that carry meaning disappear. Grammar stays as
scaffolding."*
Candidates: `isContent` tokens. Order by descending `value`, ties broken by the seeded rank so it is
still shuffleable and reproducible:

```
value = 3.0 · isProperish
      + 2.5 · hasDigit
      + 1.0 · (count === 1 ? 1 : 0)              // hapax = high information
      + min(letterCount, 12) / 6                  // 0.17 .. 2.0
      - 0.6 · (count >= 4 ? 1 : 0)                // refrains and repeats are easy; defer them
```

**Colloquial-dialogue guard (algo critic's fix).** If `contentTokens / maskableTokens < 0.25` in scope,
fall back to `hideWords` with a one-line note in the method card: *"this passage is almost all common
words — hiding words at random instead."* Without it, "Well, I have to go now, don't you think?" has
exactly one candidate (`think`), so four of seven rungs render a completely unmasked screen while the UI
claims 15–45% hidden — and `keyWords` is a recommended default for lessons and notes.
The `orderBy: 'hard-first'` frequency-list option and the optional `top1000.en.txt` are cut.

**7. `glueWords` — Glue words out.** *"The opposite: hide the little connectives."*
Same kernel, candidates = `isFunction` tokens. Catches the "roughly right but not the actual words"
failure mode, which is exactly what a director notices and a self-grader does not.

**8. `rhymes` — Keep the rhymes.** *"Hide everything except the words that rhyme."*
`lineEnds` with `n: 1` inverted: mask every word *except* the line-final word of lines that rhyme with
another line in the same stanza.
**Rhyme detection is on the nucleus, not the orthographic tail (algo critic's fix).** Take the substring
from the last vowel group onward after stripping a final silent `e`, and reject the match if both words
end in a shared suffix from a small stoplist (`ing ed ly tion sion ness ment able`). The design doc's
"last 3 characters" rule misses day/away, high/sky, eyes/lies and me/free, and fires on
walking/talking/**nothing** — so in any lyric with a few gerunds it masks non-rhyming line ends and
claims they rhyme. ~20 lines. Until it is measured on real lyrics, the method card labels it
*experimental*.

**9. `chunkWindow` — Chunk window.** *"Work one chunk at a time, with the neighbours faded."*
Window over chunks (or lines). Inside the window, the inner method at the current rung; `lookback`
chunks before it at `dim` (`opacity .3`); everything else `blank`. Advance/retreat by swipe, `→`/`←`, or
the chunk chips in the header; the window position persists in `PracticeCursor.windowIndex`.
Params: `unit: 'chunk'|'line'`, `windowSize` 1–3, `lookback` 0–2 (shrinks 1→0 at rung 5),
`lookahead` 0–2, `innerMethod` (default `hideWords`).
The **seam drill** — `windowSize: 2` scoped to the last two lines of chunk *i* and the first two of
*i+1* — is a generated practice offered automatically once two adjacent chunks are strong, because
chunk boundaries are where memorisation actually breaks. (M4, with the session generator.)

**10. `myLines` — Cue lines (Actor).** Both a **lens** (composable with methods 1–9 and 11–13) and a
registry entry so it is discoverable as "the actor tool". The lens intersects the candidate set with
tokens whose block role is in `myRoleIds`; every other dialogue block becomes a cue line, styled by
`cueStyle` (`full` / `tail` / `hidden`) per §7.8. This composition is why we can honestly advertise
"10 methods × role isolation × 3 scopes" instead of ten flat methods.

**11. `snowball` — Snowball (M4).** Stepped, cumulative. `step` = number of lines currently hidden,
counted from the start (`direction: 'forward'`) or from the end (`'backward'` — the standard stage
technique for last-minute learning). Forward: lines `[0, step)` fully masked, the rest visible; you
recite the hidden prefix then read on. "Got it" → `step++`; "Again" holds; two consecutive misses →
`step--`, never below 1. The rung selects the crutch (`firstLetters keepLetters 2` → `keepLetters 1` →
`rule`), and **`step`, not the rung, is the progress axis** — which is also how mastery is expressed for
this method (`step === totalLines` at `rule`). `nestedLadder: false`.

**12. `spotlight` — Spotlight (M4).** Stepped, one line at a time. Lines before `step - lookback` →
`dim` or visible; the active line → the inner method at the current rung; the next `preview` lines →
`firstWord` or `skeleton`; everything beyond → `blank`. Advance by tap in the lower third, `Space`, or
`↓`; optional auto-advance paced by WPM with a 400 ms grace after the line's last word. The strongest
method for long monologues and the natural "run lines in bed" mode. `nestedLadder: false`.

**13. `typeItBack` — Type it back (M4).** Masked tokens become `input` style: an absolutely positioned
`<input>` filling the token box, so typing a longer answer than the target widens nothing.
`autocapitalize=off autocorrect=off spellcheck=false autocomplete=off`. `min-width: 2.5em` on `.tok` in
this method only — the single sanctioned exception to the no-reflow rule, applied when the plan is built
so the layout is stable *within* the rep, and stated in the method card.
Matching: NFKD → strip marks → lowercase → **strip `'` and `’`** → strip remaining non-`[\p{L}\p{N}]`.
Stripping the apostrophe is a **fix**: the design doc claimed `dont ≡ don't` "falls out automatically"
while its normaliser explicitly *kept* the apostrophe, so a correct `dont` scored amber = 0.5 — and
`don't I'm it's we're O'Brien y'all 'tis` are exactly the words users are least sure how to punctuate.
We accept the harmless `its`/`it's` collapse.
Then: exact → correct; Damerau-Levenshtein ≤1 for `len ≥ 5` → amber, accepted; three wrong attempts →
auto-reveal, marked wrong; wrong items re-queued once at the end of the rep.
Two numbers, deliberately separated (fix): `typedAccuracy = (correct + 0.5·amber)/total` for **display**,
and `recallAccuracy` (an accepted amber counts 1.0; only a reveal or three strikes counts 0) for the
**grade**. Gating anything on `typedAccuracy ≥ 0.95` makes one phone-keyboard typo in ten items a
failure, which is unreachable on the primary target device.
Mobile: on focus, position the active input using `visualViewport` (never `interactive-widget`, which
WebKit ignores), with a compact next / peek / skip bar directly above the keyboard.

### 8.6 The ladder

**Seven rungs, `ladderIndex 0..6`, one shared scale.** Seven rather than six because 100% is a cliff and
users who jump 70 → 100 fail and blame the app; seven rather than eight because eight forces
indistinguishable rungs in several methods.

| Stage (UI) | `ladderIndex` | `p` for percent methods | Chip label |
|---|---|---|---|
| 1 | 0 | 0% | `Read through` |
| 2 | 1 | 15% | `Stage 2` |
| 3 | 2 | 30% | `Stage 3` |
| 4 | 3 | 50% | `Stage 4` |
| 5 | 4 | 75% | `Stage 5` |
| 6 | 5 | 100%, first letters kept | `First letters` |
| 7 | 6 | 100%, nothing kept | `From memory` |

Small early steps (people quit when step one hurts), a wide middle, and a first-letters rung immediately
before nothing.

Per-method mapping tables (the registry owns these; every row must be **strictly distinguishable** from
its neighbour — a conformance test asserts `plan(L_n) !== plan(L_{n+1})`, which is why the design doc's
identical L6/L7 rows in First Letter, Skeleton and Snowball are gone):

| method | L0 | L1 | L2 | L3 | L4 | L5 | L6 |
|---|---|---|---|---|---|---|---|
| `hideWords` | p 0 | .15 | .30 | .50 | .75 | 1.0 initial | 1.0 rule |
| `firstLetters` | p 0 | .25 keep 3 | .45 keep 2 | .65 keep 2 | .85 keep 1 | 1.0 keep 1 | 1.0 keep 1 + `keepFinalLetter:false`, `showLetterCount:false` |
| `lineEnds` | n 0 | 1 | 2 | 3 | half | max(4,half) | all |
| `lineStarts` | k 0 | 1 | 2 | 3 | 4 | half | all |
| `hideLines` | p 0 | .25 +keepFirstWord | .40 +keepFirstWord | .55 | .70 | .85 | 1.0 |
| `keyWords` | p 0 | .20 | .40 | .60 | .80 | 1.0 initial | 1.0 rule |
| `glueWords` | p 0 | .30 | .55 | .80 | 1.0 | 1.0 + content .25 | 1.0 + content .50 |
| `rhymes` | 0 | non-rhyme .30 | .55 | .80 | 1.0 | 1.0 + rhyme initial | all |
| `chunkWindow` | inner 0 | .20 | .40 | .60 | .80, lookback 0 | 1.0 initial | 1.0 rule |
| `myLines` | inner 0, cue full | .15 full | .30 full | .50 full | .75 full | 1.0 initial, cue tail | 1.0 rule, cue tail |

`min(maxRung)` per method: every method above uses all seven. M4's stepped methods declare
`maxRung` explicitly and mastery is defined relative to `maxRung`, not to a hard-coded L6.

### 8.7 Difficulty control — one state variable

```
difficulty = { ladderIndex: 0..6 }  |  { customPercent: 0..100 }
```

Exactly one is active; everything in the UI is a view onto it.

- **`◀ Easier` / `Harder ▶` are the primary control** — two of the five control-bar slots, 56 px, one
  thumb-tap, no aiming, usable mid-recitation, monotonic and predictable, and they never require reading
  a number. Feedback: the chip animates, a 900 ms toast states the outcome in words
  (`Stage 4 — 50% hidden`), a 10 ms haptic tick where supported, and the newly-masked words fade over
  200 ms rather than popping (0 ms under reduced motion). At the ends the button disables and the chip
  reads `Read through` / `From memory` — never a dead tap with no explanation.
- **The percentage slider is demoted** to a collapsed `⚙ Custom…` disclosure inside the Method sheet.
  Touching it switches to `{customPercent}`; the chip reads `Custom · 43%`; Harder/Easier keep working,
  stepping ±10% clamped 0–100, so the user is never trapped in a mode. A `Back to stages` link returns
  to the nearest rung, stated explicitly (*"Return to Stage 3 (30%)"*).
- **Auto-advance is a behaviour, not a control:** one toggle, `Move up a stage after a clean run`,
  default **ON**, driving the same `ladderIndex`. It fires only at a run boundary, never mid-run, and it
  is announced in the Debrief with an `Undo`. It does nothing in Custom mode, with that stated in the
  Session sheet.
- **There is no auto-demote.** Automatically making things easier feels like the app judging you. The
  one genuinely good idea from the design doc's escalation rules survives as a *suggestion with a
  button*: after two runs at the same rung where `helpRate > 0.15`, the Debrief offers *"That stage is
  fighting you. Try Stage 3 again?"* — and, on a third, *"Try Chunk window on the two weakest lines?"*,
  which changes the intervention rather than running the same drill again.

**"Clean run" is defined once, in one place, and shown under the toggle:** *zero peeks and zero reveals
on maskable tokens in scope, `revealAllUsed === false`, and the run reached the end of the scope.*

**Help rate** (the design doc's `assistRate`, with all four of the algo critic's fixes):

```
helpRate = clamp( (0.5·helpEvents + lineRevealCredit) / max(1, maskedCount), 0, 1 )

helpEvents      = peeks DEDUPED PER TOKEN PER REP   // a slide across five words is one help event,
                                                    // not five; the design doc logged five and a
                                                    // two-line drag alone forced a step-down
lineRevealCredit= Σ min(0.25, lineMaskedCount / maskedCount)
                                                    // one "I've lost the line" double-tap on a 12-word
                                                    // line used to score 0.6 and trigger a two-rung
                                                    // demotion from a single tap
step-up gate    = helpEvents <= max(1, ceil(0.05 · maskedCount)) && !revealAllUsed && completed
                                                    // forgives exactly one peek at EVERY rung; the flat
                                                    // 0.05 threshold was strictest at the bottom of the
                                                    // ladder, where users are weakest
cooldown        = elapsed >= 8 s; for scopes with n < 6 maskable tokens, require TWO consecutive
                  clean reps per rung instead of one (instead of the maskedCount >= 3 gate that
                  deadlocked short scopes)
```

### 8.8 Mastery

There is no separate chunk state machine and no parallel SRS. Mastery is a **display over the progress
model** (§11):

- A **line** is shown as solid in the confidence strip when the last two runs recorded zero peeks on it.
  This is all that M1–M3 need, it costs nothing, and it powers the debrief and "drill these 5 lines".
- A **chunk** reaches the top confidence band, labelled **"performance-ready"** (never "100% mastered" —
  memory decays and the badge is false 48 h later), when `conf ≥ 90` with the decay date shown
  (*"solid until Aug 4"*).
- The **objective check** that lifts the demand ceiling is `typeItBack` or an ASR rep. It is **not** a
  gate: with §11's ceiling, a chunk you have only ever self-reported is capped, and the UI says so with
  the remedy attached. This decouples the progress model from the most expensive method in the
  catalogue, which the design doc had made a hard prerequisite for mastery.
- A **document** additionally reports readiness, expected stumbles and `pctAt80` (§11.5), and — for
  performers — whether a full run at `From memory` came in within ±25% of the read-aloud pace baseline,
  because a correct-but-halting recitation is not a ready text.
- **Leech handling (M4):** a chunk that fails 4+ times at rungs ≥3 is flagged; auto-split it at its best
  internal boundary (≤25 words per part), reset both parts to rung 3, switch the recommended method to
  `spotlight`, and show one line explaining why.

---

## 9. The reader UX

The reader is the product. Everything else is plumbing.

### 9.1 Layout

```
 ┌───────────────────────────────────┐
 │ ‹  Hamlet 3.1        Stage 3  ⋮   │  status rail, 44px, auto-hides on scroll-down
 ├───────────────────────────────────┤
 │  HAMLET                           │  speaker label 0.62em, 600, tracked, uppercase
 │  To be, or not to be, that is     │
 │  the ▁▁▁▁▁▁▁▁:                    │
 │  Whether 'tis nobler in the mind  │  ← CURRENT LINE: tint + 3px accent left rule
 │  to ▁▁▁▁▁                         │
 │  The slings and ▁▁▁▁▁▁ of         │
 │  outrageous fortune,              │
 │       (reading zone: 40% of dvh)  │
 ├───────────────────────────────────┤
 │  ▓▓▓▓▓▓▓▓░░░░░░░░  scroll position│  2px rule
 │  Aa   ◀ Easier   Harder ▶   ▶  ⋯  │  control bar, 64px + safe-area
 └───────────────────────────────────┘
```

Three layers only: status rail (disposable), text canvas (everything), control bar (thumb-reachable,
disposable). No sidebars, no floating buttons over text, no toolbar in the middle.

**Reading zone: the current line sits at 40% of viewport height** (45% in landscape), not centred — when
reading forward you want more text below than above, and it keeps the eyeline up, which matters for
actors who should not be looking at their chin.

**Control bar:** five 56×56 targets with 8 px gaps (= 320 px, fits a 375 px viewport with margin):
`Aa` · `◀ Easier` · `Harder ▶` · `▶/⏸ autoscroll` · `⋯`. Everything interactive that matters lives in
the bottom 160 px. A handedness setting mirrors the order (`flex-direction: row-reverse`).

**Routing:** the reader is a **route** (`/t/:id/read`), never a modal, so Android back and iOS
back-swipe behave. Depth budget: paste → reading in **≤3 taps**; library → reading in **1 tap** (tapping
a text card goes straight into the reader at its last stage and its saved cursor; the overview screen is
reached via the card's chevron).

**IA:** `/` library, `/f/:folderId`, `/t/:id` overview, `/t/:id/read`, `/t/:id/edit`, `/import`,
`/progress`, `/settings/*`, `/about`, and `/t/:id/print` (M4). Route-level `ErrorBoundary` per route plus
a root one; a thrown error in the reader must not blank the library. Unknown id → *"This text isn't on
this device. Restore a backup?"*

### 9.2 Typography

| Property | Value | Why |
|---|---|---|
| Font | **System UI stack only** in v1: `-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", Roboto, sans-serif` | Zero bytes, zero FOIT, familiar, well-hinted. A memorisation app must not gate first paint on a webfont. The four optional faces are LATER and are **removed from `includeAssets`/`globPatterns`** until they ship |
| Size | 18–44 px mobile, 18–72 px desktop, **default 22 px**, 2 px steps; pinch maps to the same scale | Read at arm's length, sometimes while moving. 18 px floor because below it blanks are hard to target |
| Line height | 1.45 / **1.65** / 1.95 | Masked blanks add visual noise and generous leading makes line-tracking during recall much easier |
| Measure | **32 ch** default, 24–60 ch, as `max-width: var(--measure)` in `ch` so it tracks font changes | Memorisation is not prose reading: short lines chunk the text and fewer wrapped rows means the line positions you remember stay stable |
| Alignment | Always left, ragged right, `hyphens: none`, `text-wrap: pretty` | Justification creates variable word spacing, and word *position* is part of spatial memory. A hyphenated word breaks recall |
| Wrapping | An authored line that wraps renders as one logical line with `text-indent: -1.25em` hanging indent on continuation rows, added to the verse `indentEm` | Makes it visually obvious a continuation is not a new verse line |
| Numerals | `font-variant-numeric: tabular-nums` on all counters | No jitter in the timer |
| Directions | 0.85 em, italic, `--text-faint`, never masked | Convention, and they are not memorised |

**Font-size and orientation changes must preserve reading position.** Record the *logical line index*
nearest the reading zone plus its intra-line character offset; after the change, scroll that line back to
the zone. Never preserve pixel `scrollTop` — it drifts badly, and under `content-visibility: auto` the
target's offset may not even be known yet. Debounce during a slider drag with rAF, applying the anchor
correction each frame.

**Current line** = the line whose box overlaps the reading zone, or the line the user last explicitly
advanced to, whichever is more recent. Tracked with a single `IntersectionObserver` with a `rootMargin`
that creates a thin band at 40% height — cheap, and no scroll-event thrash. Treatment: a 3 px left rule
in `--accent` at `-16px` offset plus a very low-contrast background tint. **No** bold, **no** size
change, **no** colour change to the text itself — each of those either reflows or reduces legibility.

**Line focus** (all lines except current ±1 drop to `opacity: 0.32`, 120 ms, 0 ms under reduced motion)
is the single most effective concentration aid in the app and lives one tap away in `⋯`, not in Settings.

### 9.3 Gestures — one normative table

This table is the only gesture specification. The modes doc's competing map is deleted, including its
opposite tap semantics (it made a short tap a *permanent reveal*; here a tap is a *peek*), its 250 ms
threshold and its double-tap binding. One constants object, one value each:

```ts
export const INPUT = {
  peekRevealMs: 140,       // visible feedback starts here, so holding feels instant
  longPressMs: 450,        // gates OTHER long-press actions; 600 with "reduce accidental taps"
  moveTolerancePx: 10,
  readingZonePct: 40,      // 45 in landscape
  autoScrollWpmDefault: 120,
  autoScrollResumeMs: 2500,
  resetHoldMs: 600,
  peekReleaseFadeMs: 180,
  edgeDeadZonePx: 32,
  hoverPeekMs: 400,        // desktop fine-pointer only, default OFF
} as const;
```

| Gesture | Action | Notes |
|---|---|---|
| **Tap a blank** | Peek that word (per `input.peekBehaviour`) | ≥24 px effective hit area via `::after { inset: -10px }`; adjacent blanks get 2 px real separation so hit areas never overlap |
| **Press-and-hold a blank** | Peek while held; hide on release | Reveal starts at 140 ms; cancels if the pointer moves >10 px before then, because **scroll must always win** |
| **Tap canvas (middle 70%)** | Stepped mode: advance one line. Smooth mode: pause/resume autoscroll. Autoscroll off: toggle chrome | The most-used target, needs no aim |
| **Tap top / bottom 15%** | Show the status rail / control bar if hidden | Avoids fighting the back chevron |
| **Long-press a line (450 ms)** | Line menu: `Peek whole line` · `Always show this line` · `Start here` · `Mark as weak` · `Copy line` · `Edit this line` | Haptic on threshold |
| **Long-press the Stage chip** | Reveal everything while held | **The documented, always-available panic gesture** |
| **Long-press `Reveal` in `⋯` (600 ms)** | Hard reset of the rep: clear peeks, reveals, reveal-all, timer and step counter; keep the same seed and rung | The progress ring visibly refills during the hold so it is discoverable |
| **Swipe up/down (one finger)** | Scroll. Always. Never overloaded | |
| **Swipe left/right, starting >32 px from an edge** | Previous / next block | Convenience only, also in `⋯`, disabled for texts with no blocks |
| **Pinch (two fingers)** | Resize text live, with a `24px` badge | The only two-finger gesture on by default |
| **Two-finger hold / two-finger swipe** | *Optional, default **OFF*** | On iOS with VoiceOver active, two-finger tap pauses speech and two-finger swipe reads continuously; Safari owns pinch; `touchstart` is passive by default so `preventDefault` needs `{passive:false}` on a narrowly scoped element and the system gesture often wins anyway. Best-effort, and never the panic button |
| **Double-tap canvas** | Nothing — explicitly unbound and suppressed | `touch-action: manipulation` also kills the 300 ms double-tap-zoom delay, making single taps feel instant |
| **Three-finger anything** | Nothing | Reserved by iOS for undo/redo |
| **Edge swipe (<32 px)** | Ceded to the browser (back navigation) | Cannot be reliably disabled, and varies by iOS version in installed PWAs |
| **Overscroll at the top** | Nothing | `overscroll-behavior-y: contain` so a rubber-band never triggers pull-to-refresh or navigation |

Conflict register, resolved: long-press peek vs iOS selection/magnifier/callout →
`user-select: none; -webkit-touch-callout: none` on the canvas, with `⋯ → Select text` (peek off while
active) and `Copy this line` as the escape hatches; long-press vs Android context menu → same, plus
`contextmenu → preventDefault()` (desktop right-click gets our own line menu); `Space`-scrolls-page vs
advance → the reader `preventDefault()`s `Space` only when focus is not in an editable and only while the
reader route is active; single-key shortcuts gated on
`!isEditableTarget(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey`; sheet drag vs content scroll →
the sheet only drags from the handle/header, or from content when `scrollTop === 0` and the drag is
downward.

Haptics: `navigator.vibrate()` (Android/Chromium only; **iOS Safari has no Vibration API**, so this is a
bonus and never load-bearing). 10 ms on stage change and on the long-press threshold, 20 ms on run
complete. No haptic on peek — you would be buzzing constantly.

### 9.4 Keyboard map (~24 bindings in v1)

Gated on focus not being in a text field. Never overrides `⌘/Ctrl` browser defaults. Shown in the `?`
overlay. Every key collision between the design docs is resolved here in favour of the UX doc.

| Key | Action |
|---|---|
| `Space` | Advance one line (stepped) / pause-resume autoscroll (smooth) |
| `⇧Space` | Back one line |
| `↓` `J` / `↑` `K` | Scroll one line down / up |
| `PgDn` `PgUp` / `Home` `End` | One screen / top and bottom |
| `→` `N` / `←` `P` | Next / previous block |
| `Tab` `⇧Tab` | Move focus to the next / previous blank in reading order |
| `Space` (blank focused) | Peek it — keydown reveals, keyup hides |
| `Enter` | Peek the current line until the next keypress |
| `R` (hold) | Reveal everything while held |
| `⇧R` | Toggle keep-everything-revealed |
| `]` / `[` | Harder / Easier |
| `1`–`7` | Jump to that stage |
| `S` | Start/stop autoscroll; `+` / `-` ±5 wpm |
| `⌥+` / `⌥-` | Text size up / down |
| `M` / `A` / `G` | Method sheet / Aa sheet / Session sheet |
| `F` / `L` / `D` / `W` | Focus mode / line focus / cycle theme / keep-awake |
| `.` | Mark the current line as weak |
| `Esc` | Exit focus → exit reader |
| `?` | Shortcut overlay |
| `/` and `⌘Z` | Search; undo (editor and destructive list actions) |

`H`, `T` and the command palette are unbound in v1 (their owners — mirror, teleprompter, palette — are
LATER, so binding them now would create dead keys). Desktop-only extras from the modes doc (a token
cursor, hover-dwell peek, `Alt`-hover peek) are available behind
`input.hoverPeek` (default off, `(pointer: fine)` only). Note that **arrow keys, PgDn/PgUp and `Space`
are exactly what a Bluetooth page-turner pedal or presenter remote sends**, so those accessories work on
a music stand for free; that is worth one line in About and zero lines of code.

### 9.5 Auto-scroll

**Speed in WPM, not "speed 1–10"** — speaking rate is a number performers already understand
(conversational ≈130, stage delivery 100–140). Default **120**, range 60–260 in steps of 5.

**Velocity is measured from the currently rendered region, not from `scrollHeight`:**

```ts
// For the block currently in view — whose height IS measured, unlike unrendered blocks:
pxPerWord     = block.offsetHeight / block.wordCount;
pxPerSecond   = pxPerWord * (wpm / 60);
// recomputed on each block boundary, on resize, and on any typography change
```

The design doc's `(wpm/60) × (scrollHeight / wordCount)` is wrong under `content-visibility: auto`:
unrendered blocks contribute `contain-intrinsic-size` estimates that are replaced by real sizes as the
user scrolls into them, so `scrollHeight` changes continuously on the first pass through a long text and
the scroll rate drifts — the exact failure that makes autoscroll unusable for someone trying to hold a
pace. **Stepped scrolling is the primitive** (one line box at a time, positioned at the reading zone,
180 ms ease); smooth is interpolation between known line boxes.

- Smooth: one rAF loop accumulating fractional pixels into `scrollTop`, reading no layout inside the loop
  (cache `clientHeight`, invalidate on `resize`/`ResizeObserver`). Never `scrollBy({behavior:'smooth'})`
  in a loop — it fights itself. Below 0.4 px/frame, advance whole pixels on a fractional schedule or it
  judders on 60 Hz.
- `prefers-reduced-motion: reduce` **forces stepped**, and stepped becomes tap-driven unless the user
  opts back in.
- **Pause on touch** immediately, visibly (`▶` → `⏸`, a 1 s ghost toast). Resume automatically after
  2.5 s *only* if the pause came from a scroll or a peek; never automatically if the user tapped pause.
  Distinguishing "I grabbed the text to look back" from "stop" is what makes autoscroll feel obedient.
- **Pause on peek, always.** Revealing a word means you have lost the thread.
- End of text: decelerate over 1.5 s, stop, present the Debrief after a 600 ms beat.
- Optional visual `3 · 2 · 1` count-in (tick sound opt-in) so you can start speaking on time.

### 9.6 Keeping the screen awake

`navigator.wakeLock.request('screen')`. Verified support: Chrome/Edge 84+, Firefox 126+,
**Safari 16.4+ on macOS *and* iOS**, ~94% global. The architecture doc's claim that iOS Safari does not
support it is wrong and would have shipped a "set Auto-Lock to Never" tip to every iPhone user instead of
a working API. The real caveat is narrower and it is in the UX doc: the API was broken specifically in
**installed home-screen apps** by a WebKit bug until **iOS 18.4**, so on iOS 16.4–18.3 an installed PWA
resolves the request and still lets the screen sleep (UNVERIFIED-1).

Implementation: request on autoscroll start / session start (default) or always-while-reader-open
(setting); **re-acquire on `visibilitychange → visible`**, because the lock is auto-released when the
document hides; release on reader exit, session end, and 2 minutes idle — never hold it silently forever,
it is the user's battery. A subtle `☀` indicator in the status rail when held, tappable. On rejection
(`NotAllowedError`, e.g. low power mode) the toggle renders unavailable with honest copy, and we treat
"granted but the screen slept anyway" as a possible outcome below iOS 18.4. **The silent-looping-`<video>`
hack is not shipped** — both design docs agree and both are right.

### 9.7 Focus mode; teleprompter is LATER

Focus mode: `⋯ → Focus mode`, `F`, hides the status rail, control bar, progress rule and tab bar, sets
`--reader-pad-top: 12dvh`, and requests the Fullscreen API on the reader root where supported.
**Fullscreen landed on iPhone in Safari 17.2**, so the detection now succeeds on modern iPhones; keep the
feature detection and the relabel-to-`Hide controls` fallback anyway, because it still covers older iOS
and the reported iOS 26.1 regression where installed home-screen apps show a bar at the top
(UNVERIFIED-4). While chrome is hidden, keep a 4 px, 20%-opacity handle at the bottom centre —
discoverability without noise. Outside Focus mode, both bars fade after 4 s of no interaction *while
autoscroll is running*; when autoscroll is off they persist, because people are tapping to advance.

**Teleprompter mode, both mirror flips and the brightness dim overlay are LATER** (§3.2). Masking already
works at 44 px+ with the size slider, which delivers most of the value; the distinct mode with its own
type scale, centre indicator, and the classic controls-inside-the-flipped-container bug is ~1.5 dev-days
of surface nothing in the goal statement asks for.

### 9.8 Accessibility rules

WCAG 2.2 AA target. Semantic HTML first; ARIA only where semantics do not exist.

**The masked-token contract (one pattern, everywhere):**

```html
<div class="line" data-line="12" role="group"
     aria-label="Line 12: To be, or not to be, that is the blank">
  <span>To be, or not to be, that is the </span>
  <button class="tok" data-i="17" data-mask="rule" type="button"
          aria-label="Hidden word 1 of 1. Activate to reveal."><span class="txt">question</span></button>
</div>
```

1. The **line** carries an `aria-label` built from its tokens with the literal word **"blank"**
   substituted for each masked token, so the line reads naturally and the gap is audible. This is what
   blind users of fill-in-the-blank material expect.
2. Each masked token is a **real focusable `<button>`**, reachable by `Tab`, by screen-reader element
   navigation, and by switch control. Verbosity is a setting: Terse = `blank`, Verbose =
   `blank, word 3 of 7`.
3. Activating one reveals the word and announces it through **one** polite live region
   (`<div id="announcer" aria-live="polite" aria-atomic="true">`), coalesced and debounced 120 ms. Never
   put `aria-live` on the text container — a stage change would fire a hundred announcements.
4. `role="text"` is **not used** anywhere: it is a WebKit-only non-standard value, ignored by Chrome and
   NVDA. The `aria-hidden` variant from UX §3.4 is also deleted — it is only correct at Stage 1, where
   nothing is masked and the tokens are removed from the tab order entirely so `Tab` is not a hundred
   no-ops.
5. Masked tokens are focusable **only inside the rendered window**: above 2,000 tokens,
   `content-visibility: auto` means skipped subtrees are not exposed to the accessibility tree, which
   naturally windows the button count (UNVERIFIED-3). Below that threshold there is no windowing and no
   problem.
6. Mask-style × accessibility matrix, so no style silently leaks:

| style | accessible name of the token | line label substitution | real text exposed? |
|---|---|---|---|
| `rule` / `box` / `dots` | `Hidden word n of m. Activate to reveal.` | `blank` | No |
| `initial` | `Hidden word n of m, starts with O.` | `blank starting with O` | No |
| `blank` | as `rule` | `blank` | No |
| `dim` | (not a button; not masked) | the real word | **Yes — by design.** `dim` is a *soft* style used for lookback context and cue tails, never for the words under test, and it therefore contributes no retrieval demand |
| `input` (M4) | `Type the hidden word, 7 letters` | `blank, text field` | No |

7. Reader region: `role="region" aria-roledescription="Rehearsal text" aria-label="<title>, stage 3 of 7"`.
   `Reveal all` announces `All words revealed` / `Words hidden again`.
8. **This pattern is the single highest-risk item in the plan and it must be hand-tested on real
   assistive technology** — VoiceOver iOS, VoiceOver macOS, NVDA+Chrome, TalkBack — as a named gate
   (task M4-19, UNVERIFIED-2). It is the one thing in this app that cannot be fixed by trying again
   later.

**The rest:** focus moves to the new view's `<h1 tabindex="-1">` on route change and returns to the exact
invoking element (stored as an `Element`, not a selector) on sheet close; sheets are `<dialog>` where
possible for the native focus trap and `Esc`; a `Skip to text` link is the first focusable element in the
reader; `:focus-visible` gets a 3 px `--focus` ring at 2 px offset that is visible against every surface
including masked tokens; targets are 56 px (control bar), 48 px (primary), 44 px (everything else), with
masked tokens exempt under the inline exception but still given a ≥24 px effective hit area; colour is
never the only signal (masked = absence of glyphs **+** a rule; peeked = amber **+** it is the only word
that just changed; current line = tint **+** rule); the app works at 200% zoom and 320 px width with no
horizontal scrolling (the `ch`-based measure makes this nearly free); orientation is never locked;
`lang` is set on `<html>` **and** per text; and reduced motion is the structural default (all motion is
inside a `@media (prefers-reduced-motion: no-preference)` guard).

**i18n seam without translations.** All UI strings live in one typed `Record<string,string>` per locale
with `Intl.PluralRules`, English shipped and others lazy — no library, and it means adding a locale later
is not a refactor. All layout uses CSS **logical properties** (`margin-inline`, `padding-block`,
`inset-inline`) from day one for the same reason. Actual translations and RTL *UI* mirroring are LATER;
RTL *text* already works via `unicode-bidi: isolate` and the per-script method table (§7.4).

### 9.9 Screens (20), and what each one owes

| # | Screen | Primary action | Milestone |
|---|---|---|---|
| 1 | First run — three panels, panel 1 is the live mechanic, not a marketing slide | `Try it` → reader with Sonnet 18 | M2 |
| 2/3 | Library / Folder | Tap a text → reader | M2 |
| 4 | Add sheet | `Paste text` | M2 |
| 5 | Paste / Import | `Continue` | M1 (paste) / M2 (files) |
| 6 | Cleanup — five toggles with live counts, and a live reader-typography preview (nobody reads the toggles; everybody reads the preview) | `Looks right` | M2 |
| 7 | Structure editor — per-line fix sheet, apply-to-all, speaker manager | auto-saves | M2 |
| 8 | Speakers / Role picker — line and word counts per role, doubling, ensemble opt-in | `Rehearse as MARY` | M2 |
| 9 | Text Overview — role view segmented control, method, performance date, export, delete | `Rehearse` | M2 |
| 10 | **Reader** | Advance / Harder | M1 |
| 11 | Method sheet — 2-column grid, **live previews from the user's own text**, `⚙ Custom…` collapsed | tap a method | M1 |
| 12 | Aa sheet — size, line height, measure, theme, blank style, line focus | slider drag | M1 |
| 13 | Session sheet — length preset, auto-advance toggle, scope | `Start session` | M4 |
| 14 | Debrief — peeks as the hero number, per-line confidence strip, `Drill these 5 lines`, auto-advance notice with Undo | `Drill weak lines` | M2 |
| 15 | Progress — five stat screens (§11.7) | tap a text | M4 |
| 16 | Settings — Appearance / Reader / Gestures / A11y / Data / About | — | M2 |
| 17 | Backup & Restore — with a merge preview and the "no backups yet" alarm copy | `Export backup` | M2 |
| 18 | About — privacy, licences, samples, the confidentiality note | — | M2 |
| 19 | Search — brute force, debounced 150 ms, grouped Texts / Lines | tap a result | M2 |
| 20 | Shortcuts overlay (`?`) | dismiss | M2 |
| — | Print (`/t/:id/print`) — four presets | `Print` | M4 |
| — | Contents sheet — act/scene/section list with per-section readiness and my-line counts, tap to jump | jump | M4 |

Empty and error states follow the design doc's table verbatim (it is good): inline where the problem is,
never a modal for a recoverable error, state what happened and the single next action, never show a raw
exception, always keep the user's input. Three that matter most: the scanned-PDF copy, the
IndexedDB-unavailable banner (let them use the app in memory rather than white-screening), and
`Storage evicted / data missing on return` → `Restore from backup`.

### 9.10 Print and PDF (M4)

Two mechanisms in this plan actively break naive printing, which is why this is a spec and not "just
`Ctrl+P`": `content-visibility: auto` causes off-screen blocks to be skipped so a naive print produces
one screen of text, and a bordered inline token prints as invisible whitespace in engines that drop
backgrounds and borders by default.

`styles/print.css`: force `content-visibility: visible` on all blocks; `break-inside: avoid` on blocks;
mask style forced to `border-bottom` with `print-color-adjust: exact`; all chrome hidden; a running header
with title / role / stage; page numbers; `@page` margins. Route `/t/:id/print` offers four presets —
**Full text · Cue script · First-letters sheet · Masked at the current stage** — plus a role and range
selector. PDF output is "print to PDF" via the browser: no library, zero bytes. A manual check that a
2,000-word document prints *all* pages is an acceptance criterion, because the `content-visibility`
interaction is exactly the kind of bug that only shows up on paper.

---

## 10. Voice features

Ordered by reach, not glamour, and every claim below is stated with its platform reality and its
degraded fallback. **Tier 0 — silent recall with self-grading — is the floor and must be genuinely good
on its own.** Everything in this section is additive and none of it is ever on the critical path.

A persistent, tappable **mode badge** in the reader header names the active tier
(`◉ Self-grade` / `◉ Timing only` / `◉ Partner` / `◉ Recording`), with a tap-through explaining exactly
what is and is not being checked. **We never silently degrade.**

### 10.1 What is verified, and what is not

| Capability | Reality (July 2026) | Our decision |
|---|---|---|
| `speechSynthesis` | Every modern browser including iOS 7+ **and installed iOS web apps**. No permission prompt. No network for local voices | **M3.** The scene partner |
| `MediaRecorder` | iOS Safari 14.5+ and everywhere else. Safari 14.1–18.3 is MP4/AAC only; WebM/Opus from 18.4 | **M3.** Negotiate the mime type, store it per recording |
| `<audio>` + MediaSession | A recorded blob in an `<audio>` element is the *only* path to background and lock-screen playback | **M3**, gated on a device spike (below) |
| Screen Wake Lock | Chrome 84+, Firefox 126+, Safari 16.4+ incl. iOS; broken in installed iOS PWAs < 18.4 | **M2** (§9.6) |
| VAD via `getUserMedia` | Works anywhere with mic access, reportedly including iOS standalone | **M3**, opt-in, probed at runtime (UNVERIFIED-5) |
| `SpeechRecognition` | **Silently does nothing in installed iOS home-screen apps** — the object exists, detection passes, `start()` resolves, nothing happens. `continuous` and `interimResults` unusable on iOS Safari. Absent in Firefox. Cloud-backed by default. ~70–80% of sessions, lower among phone-rehearsing actors | **CUT from v1** (§10.4) |
| Word-level TTS `boundary` events | Chromium desktop per word; **Safari per *sentence* only**; Android Chrome/Firefox **not at all** | Probe once, highlight at sentence level, never fake word timing |
| Background TTS / exporting TTS to a file | **Structurally impossible.** `speechSynthesis` is neither a media element nor an `AudioNode`, so MediaSession, lock-screen controls and `MediaRecorder` capture do not apply | Say so; route background listening through recordings |
| Local Whisper, `tesseract.js` | Multi-megabyte third-party downloads | **CUT permanently** |

**The demotion the critics were right about.** The voice design doc ranks self-recording as its "most
robust and most cross-platform" feature. In 2026 there are widely reported iOS 26.x bugs where audio in
installed home-screen web apps breaks after first use (and can poison audio for other apps until Safari
data is cleared), improved but not fixed in 26.1/26.2, plus long-standing WebKit issues with `blob:` URLs
on `<audio>` returning 416 and larger blobs stalling. Since our own plan pushes users to install in order
to survive 7-day eviction, the design pushes them into precisely the configuration where iOS audio is
least reliable. Therefore:

- Self-recording and the TTS partner are **opportunistic, verify-on-device-first**, not "most robust".
- **M3 opens with a spike** (task M3-01): on Ben's own iPhone, in an installed PWA, record 30 s, store
  the blob in IndexedDB, read it back, play it via `<audio>` with `<source>` children (**not**
  `src="blob:…"`), seek, and confirm MediaSession appears on the lock screen. If it fails, M3 ships the
  TTS partner only and recording is deferred with the failure written into the risk register.
- Ship an **audio watchdog** analogous to the ASR watchdog: play a short silent buffer, assert
  `currentTime` advances and `ended` fires within a timeout, and degrade with honest copy if not.
- Do **not** build the two-player architecture (an `AudioBuffer` segment engine *and* an `<audio>`
  engine, ~300 lines) until the spike passes.

### 10.2 Self-recording — the LineLearner loop (M3)

```ts
const CANDIDATES = ['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4;codecs=mp4a.40.2','audio/mp4',''];
const mimeType = CANDIDATES.find(t => t === '' || MediaRecorder.isTypeSupported(t))!;
const rec = new MediaRecorder(stream, {
  mimeType, audioBitsPerSecond: mimeType.includes('opus') ? 32_000 : 48_000,
});
```

Stream constraints `{ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true,
autoGainControl: true } }`, with a **raw toggle** that disables NS/AGC for a performance take, because
voice processing flattens dynamic range and an actor evaluating their own delivery will notice.

**One capture mode in v1: read-through.** One continuous recording over the whole text; the user advances
line by line (tap, or VAD); we store cue marks `{lineFingerprint, startMs, endMs}`. One blob plus an
index. Per-line re-record is LATER: `start()`/`stop()` has 100–300 ms of latency and reliably clips the
first syllable.

**Timestamp accuracy.** Never use wall-clock from `rec.start()` — the encoder starts late. Take
`t0 = audioContext.currentTime` at the recorder's first `dataavailable`, record marks as offsets from
that, and **pad every mark by 150 ms on each side**. Padding is cheap and hides all remaining drift;
unpadded marks produce the "cuts off the first word" bug that makes the whole feature feel broken.

**Storage.** Blobs go in `recordingBlobs` (never base64: +33% and a main-thread stall). But the medium is
the untested part on WebKit, so task M3-02 probes it: round-trip a 3 MB blob through IndexedDB and play
it back; if it fails, store an `ArrayBuffer` and construct the `Blob` on read (UNVERIFIED-7). Retention:
takes are ephemeral by default (auto-delete after 30 days with a banner at 7 days remaining), max 3 per
text (newest + pinned), a `📌 Keep` pin, a one-tap "free up space" list by size, and deleting a text
deletes its takes with an undo window rather than a scary modal. **Audio never leaves the device**, not
even in a future sync.

**Mute my lines** — the loop that actually teaches lines:

```
for each line in order:
  if role(line) not in myRoleIds:  PLAY recorded audio [start-150ms, end+150ms]
  else:                            SILENCE of duration = recordedDuration(line) × gapFactor
                                   (default 1.0, slider 0.8–1.6)
                                   + a visual countdown ring so the gap window is unambiguous
```

Refinements that separate "toy" from "rehearsal partner": always play the **last ~1.2 s of the preceding
partner line at full volume**, even in my-lines-only mode, so the pickup cue is unmistakable; a
**duck-don't-mute** training-wheels setting (`volume: 0.08` instead of silence); **loop a section** with
an adjustable gap; and `MediaSession` metadata (title = text, artist = character) with
`previoustrack`/`nexttrack` mapped to **line navigation**, not track skip, so the lock screen is genuinely
usable with the screen off. This is the eyes-free / hands-free mode; it logs reps at
`mode: 'recordReview'` when the user grades afterwards, and logs nothing when they merely listen —
listening is exposure, and §11's stakes model already prices that at 0.08.

### 10.3 TTS scene partner (M3)

The app reads everyone else and shuts up for you. Zero permissions, works in installed iOS web apps.

Quirk mitigations, all of them mandatory, all from the design doc's catalogue:
`getVoices()` returns `[]` on the first call → await a promise resolved by `voiceschanged` **and** poll
every 100 ms with a 3 s timeout (Safari has no `addEventListener('voiceschanged')`, only the
`onvoiceschanged` property — assign both); key everything on `voiceURI`, never `name` (Safari has two
"Daniel"s); the **first `speak()` must be inside a user gesture on iOS**, so `speak(' ')` on the Start tap
unlocks the synth for the session; **iOS honours the hardware mute switch** for TTS with no error and no
clue, so warn in the pre-flight card; Chrome cuts remote-voice utterances at ~15 s, so chunk to sentences
≤180 chars; Android cannot change voice, so differentiate characters by `rate`/`pitch` only **and say so
in the UI**; Android `pause()`/`resume()` are non-functional, so pause is `cancel()` + remembered
position + re-`speak()`; Safari never fires `end` after `cancel()`, so use a generation counter and treat
`cancel()` as immediately terminal — never `await` `end`; clamp `rate` to [0.5, 2.0] and `pitch` to
[0.6, 1.6].

**The half-duplex law is a hard architectural constraint.** We do not control the recogniser's
`getUserMedia` constraints and cannot rely on echo cancellation against our own output, so TTS and any
listening mode must never run at once:

```
IDLE → PARTNER_SPEAKING → (utterance end + 250 ms) → USER_TURN → SCORING → …
Entering PARTNER_SPEAKING must first abort() any listening and await its `end`.
Entering USER_TURN must first speechSynthesis.cancel() and NOT await `end`.
```

USER_TURN ends by: **VAD** (speech detected, then 700 ms silence, capped at 2.5× the estimated duration —
available almost everywhere and it feels remarkably like a human partner); **Timed**
(`words / (targetWPM/60) × paceFactor`, min 800 ms, `targetWPM` learned from the user's own measured
pace); or **Tap** (the reliable floor). Timing polish that makes the difference: a 250 ms lead-in and
150 ms tail so the user is never clipped; **pre-queue the next utterance on the current one's `start`
event, not its `end`**, or there is an audible 100–400 ms hole between every line that destroys the
illusion; an optional three-tick count-in; and an "overlap" toggle that starts the user's turn 300 ms
before the partner finishes, which is how real dialogue works.

Highlighting follows a one-time capability probe (`'word' | 'sentence' | 'none'`, cached): word-level
where it is real, **sentence-level otherwise**, using
`ms(sentence) = (syllables × 190 + tokens × 55) / rate` snapped to the real `end` event. Word-level
estimation drifts visibly within two lines and looks broken; sentence-level drift is invisible because
the snap corrects it. Since we chunk, keep a map from utterance-local `charIndex` to global token index or
long lines highlight the wrong words.

**The hybrid partner — partner lines from TTS plus user gaps from estimated timing — needs no recording
at all, and it is the default first-run voice experience.**

### 10.4 Speech recognition — cut from v1, with the gate for revisiting

Not shipped. The reasons are the design doc's own hard truths plus a cost we cannot pay: the feature is
silently dead in the configuration we push users into; `continuous` and `interimResults` are unusable on
iOS Safari; Firefox has nothing; and the scorer requires banded Needleman–Wunsch with a merge/split
extension, ~60 homophone classes, a hand-rolled double metaphone, bidirectional number-to-words, eleven
fairness rules, a stability window, a Smith–Waterman re-sync pass **and** a validation corpus of ~40
recorded attempts across 6 scripts and 3 accents with human per-word labels. Without that corpus the
target false-blame rate of <2% is unmeasurable, and by the doc's own weighting (a false accusation costs
10× a missed detection) shipping it untuned is worse than not shipping it.

**What we ship instead, and it is most of the value:**

- **Tier 1 VAD, timing only** (M3, ~60 lines): one `AudioWorkletNode` (falling back to `AnalyserNode` +
  `getByteTimeDomainData`) computing RMS at ~50 Hz; adaptive noise floor = the 20th percentile of the
  last 3 s; speech = RMS > floor × 3.5 for >120 ms; end = below for >700 ms. It powers auto-advance in
  the partner and the recorder, and it records `spokenAloud` on the rep. Copy is scrupulously honest:
  **"Timing only — we can hear that you're speaking, but we're not checking the words."** It never
  raises verification trust, because it verifies nothing about the words.
- **"Read it aloud" is instruction, not inference.** Stage 1 (`Read through`) says so explicitly, with
  the reason, and the pace baseline it establishes is what §11's run-timing check compares against. The
  plan states plainly that without VAD enabled, v1 cannot distinguish reading aloud from reading
  silently — which is exactly why the pace check is optional rather than a mastery gate.

**The gate for revisiting (post-v1, one dev-day, not scheduled):** hardcode one 20-line scene, wire the
raw recogniser with **no scorer at all**, and measure on a real phone in Safari-the-browser how often the
raw transcript is even good enough to score. Only if that is convincing do we spend 6–10 days on the
aligner. If we ever do, three corrections from the algo critic are preconditions, written down now so it
cannot ship unsafely: align **spoken forms** (expand `1985` to its token sequence at parse time and
project verdicts back onto display tokens) rather than bolting a 1↔2 merge onto display tokens, or a
correct "nineteen eighty five" fails the line; store **both** metaphone keys and gate the phonetic escape
hatch on an edit-distance or length condition, or love/leave and hit/hate score as correct; and replace
uniform banding with **anchored banding** (a k-mer index plus the longest increasing chain of anchors,
the standard `diff`/minimap2 approach), or a skipped scene aligns post-skip dialogue against pre-skip
text and reports a correct performance as wrong.

### 10.5 Privacy — the About copy must be true

The design docs contain a direct conflict: the About screen promises *"No network requests after the app
loads"*, which is false the moment Chrome's remote TTS voices are used (the text of the script is sent to
Google) or ASR runs (microphone audio streams to a vendor). We ship the honest version:

> **Offbook keeps your texts on your device.** No account, no sign-up, no analytics, no trackers, no ads.
> Your texts, recordings and practice history live in this browser's storage on this device and are never
> uploaded to us — we don't run a server that could receive them.
>
> One optional feature involves someone else's computer. **Some computer voices are cloud voices**: if you
> pick one (usually named "Google …"), the text of your script is sent to that vendor to be spoken.
> Voices marked "on-device" don't do this, and they're what we choose by default.
>
> **Recordings of your voice never leave your device.**
>
> **If your script is under an NDA or embargo, don't use a cloud voice.** Turn on Confidential mode
> (Settings → Privacy) and we'll hard-disable everything that talks to the network for that text.
>
> Delete everything at any time: Settings → Clear all data. That's a real delete, not a flag.

Enforced structurally: `connect-src 'self' blob:` in `_headers` means network egress from *our* code is
impossible and auditable — stated alongside the honest caveat that CSP cannot restrain the browser's own
speech service, because that traffic is not ours to block. TTS voices are filtered to
`localService === true` by default; remote voices are labelled "cloud voice" at the point of selection;
and `privacy.confidential` (per-document flag plus a global setting) hard-disables them.

---

## 11. Progress, sessions and scheduling

**One model, phased.** There is no parallel scheduler anywhere in this plan. `reps` is an append-only
event log and it is the truth; `mastery` is a materialized view produced by one `fold()`; `recomputeAll()`
re-folds the whole log. That architecture is what makes the phasing safe: M1 writes reps; M4 turns on the
FSRS-lite terms and the numbers they produce, as an `algoVersion` bump plus a recompute, not a rewrite.

**What M1–M3 display** is peek-derived and needs no scheduler at all: peeks per 100 words (trending),
a per-line confidence strip (solid = zero peeks in the last two runs), and `Drill these 5 lines`.
**We deliberately do not show a 0–100 confidence number before M4**, because until `typeItBack` exists the
demand ceiling caps a self-reported chunk at 78 with no available remedy, and telling a genuinely
word-perfect user they are at 78 with nothing they can do about it is the exact opposite of honesty.

### 11.1 What a rep is

A rep is one pass over the current scope in the current method and rung. `Rep` is defined in §6.2. Two
things about it are load-bearing: `peeks` is **deduped help events**, not raw gestures (§8.7), and
`stakes` is **computed and stored at write time** so changing the tables later cannot silently
reinterpret history.

### 11.2 Stakes: retrieval demand × verification trust

The core problem: **re-reading feels like learning and is not.** If a full-text read moves the same
number as a blind recitation, the app lies and the user gets on stage unprepared.

```
R_d = m_content · maskFactor(kind) · selectionFactor(methodId) · promptFactor
```

| `mask.kind` | maskFactor | | `methodId` | selectionFactor |
|---|---|---|---|---|
| `blank` / `lineHidden` | 1.00 | | uniform (`hideWords`, `hideLines`, `chunkWindow`) | 1.00 |
| `shape` | 0.85 | | content-first (`keyWords`) | 1.10 |
| `firstLetter` | 0.65 | | function-first (`glueWords`) | 0.85 |
| `firstTwo` | 0.50 | | positional (`lineEnds`, `lineStarts`, `rhymes`) | 0.75 |

`promptFactor` = 1.00 cold, 0.90 when the previous chunk or the cue line is visible (script mode with cue
lines genuinely is easier — and it is how you will perform, so do not penalise it hard).

Two fixes over the design doc, both in `m_content` and `selectionFactor`: `m` alone made a `keyWords` rep
at 30% (content words only, genuinely hard) worth *less* than a `firstLetters` rep at 100% (every first
letter visible, genuinely easier), and made a `hideWords` rep at 50% score the same whether the hidden
half was function words recoverable from grammar or content words. `m_content` (the fraction of **content**
tokens hidden — free, since the masking engine already computes `isFunction`) is stored on the rep
alongside `m`, so old reps stay interpretable.

| `mode` | V (verification trust) | rationale |
|---|---|---|
| `type` | 1.00 | objectively checked at character level |
| `asr` | 0.90 | objective but noisy (accents, homophones, mic) — not in v1 |
| `recordReview` | 0.75 | you heard yourself; honest-ish, retrospective |
| `recall` (self-report) | 0.65 | the standard mode; humans over-claim by ~20% |
| `runReview` | 0.60 | graded in flow, coarse |
| `read` | — | nothing to verify; handled by the floor |

```
stakes s = clamp(0.08 + 0.92 · R_d, 0.08, 1) · V     for retrieval modes
stakes s = 0.08                                       for mode 'read'
```

| Rep | R_d | V | s | worth |
|---|---|---|---|---|
| Full-text read aloud | 0 | — | **0.08** | 1× |
| `firstLetters` 30%, self-report | 0.195 | 0.65 | **0.17** | 2.1× |
| `hideWords` 50%, self-report | 0.50 | 0.65 | **0.35** | 4.4× |
| `hideWords` 80%, self-report | 0.80 | 0.65 | **0.53** | 6.6× |
| `typeItBack` 80% | 0.80 | 1.00 | **0.82** | 10.2× |
| 100% blank, typed, cold | 1.00 | 1.00 | **1.00** | 12.5× |

**Grading.** `grade ∈ {1 again, 2 hard, 3 good, 4 easy}`:
`type`/`asr` from the match score on masked tokens only — `≥0.98 → 4`, `≥0.90 → 3`, `≥0.75 → 2`, else 1;
`recall` from **two** buttons, not four — `Got it` / `Missed it` → 3 / 1, with a long-press on `Got it`
for "easy" and `peeks > 0` downgrading 3→2 and forbidding 4; `read` always 3 (`s = 0.08` makes the grade
nearly irrelevant, which is correct).

### 11.3 Memory state: FSRS-lite, with the published weights

Forgetting curve (FSRS-4.5/5 power law — a better fit than SM-2's exponential and just as cheap):

```
R(t, S) = (1 + F · t / S) ^ (-0.5),    F = 19/81 ≈ 0.2345679,   t in fractional days
```

Useful identity, and the reason this model is explainable: **`R = 0.9` exactly when `t = S`**, so
stability in days *is* "days until you'd recall it nine times out of ten" — showable as *"this line will
still be there in 6 days"*.

```
S_req(t, R*) = F · t / (R*^-2 − 1)
```

| R* | multiplier | note |
|---|---|---|
| 0.90 | `S = 1.00 · t` | maintenance default |
| 0.92 | `S = 1.29 · t` | app default (the design doc's 1.34 is arithmetically wrong: 0.234568/0.181474 = 1.2925) |
| 0.95 | `S = 2.17 · t` | |
| 0.99 | `S = 11.6 · t` | never offered; a work explosion |

Decay reference (`R` for a given `S`, days since the last rep) — every cell recomputed from the formula in
a unit test so no hand-typed number can drift again (the design doc's `S=0.5, t=0.25` cell said 0.90; it
is 0.946):

| S \ t | 0.25 d | 1 d | 3 d | 7 d | 14 d | 30 d |
|---|---|---|---|---|---|---|
| 0.5 | 0.946 | 0.82 | 0.65 | 0.48 | 0.35 | 0.24 |
| 1 | 0.97 | 0.90 | 0.76 | 0.61 | 0.48 | 0.35 |
| 4 | 0.99 | 0.97 | 0.92 | 0.84 | 0.74 | 0.60 |
| 15 | 1.00 | 0.99 | 0.98 | 0.95 | 0.91 | 0.83 |
| 60 | 1.00 | 1.00 | 0.99 | 0.99 | 0.97 | 0.95 |

**Weights: FSRS-5's published defaults, verbatim.** The design doc presented its numbers as "FSRS-5-ish;
do not tune without data" while four of them were not FSRS-5 values at all — `W9 = 0.34` vs `0.1192`
(tripling the exponent that governs how fast stability growth saturates), `W10 = 1.26` vs `1.01925`,
`W14 = 2.60` vs `2.2698`, and initial stabilities 4–10× smaller than FSRS's — which silently changed the
growth dynamics of the very curve whose explainability was the reason to adopt it.

```ts
export const W = [
  0.40255, 1.18385, 3.173, 15.69105,   // W0..W3  initial stability by grade 1..4
  7.1949, 0.5345, 1.4604, 0.0046,      // W4..W7  initial difficulty, D update, mean reversion
  1.54575, 0.1192, 1.01925,            // W8..W10 success stability
  1.9395, 0.11, 0.29605, 2.2698,       // W11..W14 lapse stability
  0.2315, 2.9898,                      // W15 hard penalty, W16 easy bonus
  0.51655, 0.6621,                     // W17..W18 same-day (we override: see below)
] as const;

// Named, deliberate deviations from stock FSRS-5. Each is a decision, not a drift:
export const REHEARSAL = {
  INIT_STAKES_SCALE: (s: number) => 0.40 + 0.60 * s,  // a cold read must not create a 15-day interval
  SAME_DAY_WINDOW_D: 0.10,
  SAME_DAY_GAIN: 0.05,                                 // cramming raises today, not Friday
  TAU_CEILING_D: 21,
  CEILING_FLOOR: 0.35,
  R_STAR: 0.92, R_STAR_MUST_NAIL: 0.96, R_STAR_MAINTENANCE: 0.90,
} as const;
```

```ts
// initialisation, first rep on a chunk
S0 = W[g - 1] * REHEARSAL.INIT_STAKES_SCALE(stakes);
D0 = clamp(W[4] - Math.exp(W[5] * (g - 1)) + 1, 1, 10);

// success (g >= 2), t = days since lastRepAt, R = retrievability(t, S)
S_inc = 1 + Math.exp(W[8]) * (11 - D) * Math.pow(S, -W[9]) * (Math.exp(W[10] * (1 - R)) - 1)
          * (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1);
S_next = S * (1 + stakes * (S_inc - 1));          // stakes scale the GAIN, never the state

// same-day / massed
if (t < REHEARSAL.SAME_DAY_WINDOW_D) S_next = S * (1 + REHEARSAL.SAME_DAY_GAIN * stakes);

// failure (g === 1)
S_lapse = Math.min(S, W[11] * Math.pow(D, -W[12]) * (Math.pow(S + 1, W[13]) - 1) * Math.exp(W[14] * (1 - R)));
S_next  = S * (1 - stakes) + S_lapse * stakes;    // a low-stakes fumble is not a real lapse

// difficulty (FSRS-5 linear damping + mean reversion)
let D1 = D - W[6] * (g - 3);
D1 = D + (D1 - D) * (10 - D) / 9;
D_next = clamp(W[7] * D0_for_grade4 + (1 - W[7]) * D1, 1, 10);
```

The same-day rule is honest and pedagogically correct, and it gives the app a true motivating message
instead of a false one: *"You can recite this now — come back tomorrow to make it stick."*

### 11.4 The demand ceiling — the anti-self-deception mechanism, fixed

Retrievability alone cannot distinguish "I've read this forty times today" from "I recited it blind". So:

```
demand of a PASSED rep:  d = R_d · V
stored on mastery:       maxDemandPassed  ← RAW, as of lastRepAt, NO decay baked in
read-time ceiling:       C(now) = 0.35 + 0.65 · maxDemandPassed · exp(-(now - lastRepAt) / (21·DAY))
                         clamped to [0.35, 1.00]
```

This is the fix for the design doc's central broken promise. It applied `exp(-t/21)` **only inside
`fold()`** — i.e. only when a rep happens — so read-time confidence used an undecayed `C`, and a chunk you
had not touched in ninety days still reported `C = 1.0`. The doc's headline claim ("if you stop doing hard
reps, C decays, so 'I could do this blind three months ago' stops counting") was false in precisely the
case it described. Moving the decay to read time also means removing the `decay` multiplication from
`fold()` so it is not applied twice, and applying the same correction to `p_pass`, which had the identical
bug.

Consequences, all intended: a chunk you have only ever **read** has `maxDemandPassed = 0`, so `C = 0.35`
and confidence can never exceed 35 no matter how many reads — that is the entire point. A chunk passed at
100% masking, typed, cold has `C = 1.0`. A failure at `s ≥ 0.4` applies a one-off
`maxDemandPassed ×= 0.9`.

**When the ceiling is the binding constraint, the UI says so with the remedy attached:** *"Capped at 78 —
you've only ever self-reported this. Type it back once to lift the cap."* A number the user cannot move
and cannot understand is worse than no number.

### 11.5 Confidence, readiness, expected stumbles

```
conf(chunk, now)   = round(100 · R(t, S) · C(now)),    t = (now − lastRepAt)/DAY
p_pass(chunk, now) = R(t, S) · (0.55 + 0.45 · maxDemandPassed · exp(-(now-lastRepAt)/(21·DAY)))
```

Bands: 0–24 unknown, 25–49 shaky, 50–74 getting there, 75–89 solid, 90–100 **performance-ready** (never
"mastered") with the decay date shown.

Document level, three numbers answering three different real questions:

```
w_i        = words_i · (mustNail_i ? 2 : 1)
mean       = Σ w_i·conf_i / Σ w_i
p10        = word-weighted 10th percentile of conf_i
readiness  = round(mean − 0.5·(mean − p10))       // halfway between the average and the weak tail
pctAt80    = % of WORDS in chunks with conf ≥ 80  // the progress bar
E          = Σ (1 − p_pass_i)                     // "expected stumbles" — the actionable number
```

A plain mean lets 240 solid chunks hide 10 catastrophic ones, which is the exact failure mode of
performance; halving the distance to the 10th percentile makes the weak tail visibly expensive without
making the number hopeless. `Π p_i` is explicitly **rejected as a headline**: it is the mathematically
correct answer to "will I get through it perfectly" and for 250 chunks at p = 0.98 it reads 0.6%, which
is both true and useless — keep it in an "honest numbers" expander with the explanation.

**Expected stumbles is uncalibrated, so it is not shown as a point estimate until it can be** (the algo
critic's fix). A 250-chunk script read once gives `maxDemandPassed = 0, R ≈ 1`, so `p_pass = 0.55` and the
headline reads *"≈112 stumbles"* — a number nobody will believe, at the moment they are most likely to
abandon the app. Therefore: before three graded runs exist, show **"not yet measurable — do a run"**;
after that, show a **range** ("3–7 stumbles") derived from ±25% on the observed pace and ±1 grade, and fit
the demand term's floor and slope by isotonic calibration against the user's own
`Session.runSplits[].stumble` observations. Never a single integer from an unfitted model.

**Whenever a number is shown, tapping it explains how it was computed, in one sentence, with the inputs:**
*"Readiness 78 = word-weighted average 84, weak tail (10th percentile) 66 → halfway = 78."* If a metric
cannot survive being explained, we do not ship it.

### 11.6 The fold, and recompute

```ts
function fold(m: Mastery | null, rep: Rep, P: AlgoParams): Mastery {
  if (!m) return initMastery(rep, P);
  const t = Math.max((rep.at - m.lastRepAt) / DAY, 0);
  const R = retrievability(t, m.S);
  m.S = rep.grade === 1 ? lapseStability(m, R, rep.stakes)
      : t < P.SAME_DAY_WINDOW_D ? m.S * (1 + P.SAME_DAY_GAIN * rep.stakes)
      : successStability(m, R, rep.stakes);
  m.D = updateDifficulty(m.D, rep.grade, P);
  // NOTE: no decay term here — the ceiling decays at READ time (§11.4)
  const d = rep.grade >= 2 ? demandOf(rep) : 0;
  m.maxDemandPassed = Math.max(m.maxDemandPassed, d)
                    * (rep.grade === 1 && rep.stakes >= 0.4 ? 0.9 : 1);
  m.reps++; m.effReps += rep.stakes; m.totalSec += rep.ms / 1000;
  m.peekTotal += rep.peeks;
  m.streak = rep.grade === 1 ? 0 : m.streak + 1;
  if (rep.grade === 1 && rep.stakes >= 0.4) m.lapses++;
  m.lastRepAt = rep.at; m.lastGrade = rep.grade;
  m.confCeiling = Math.round(100 * (0.35 + 0.65 * m.maxDemandPassed));   // ceiling, NOT confidence
  m.dueAt = rep.at + daysUntil(m.S, P.R_STAR_MAINTENANCE) * DAY;
  m.bestVerified = strongerOf(m.bestVerified, rep.mode);
  m.updatedAt = rep.at;
  return m;
}

async function recomputeAll() {
  // Sort by `at` with `id` as the tiebreak — NOT by id alone. UUIDv7 order is not `at` order
  // after a clock change, and reordering history silently corrupts every derived number.
  await tx('rw', ['reps','mastery','documents'], async () => {
    await clear('mastery');
    const acc = new Map<string, Mastery>();
    for (const rep of await allRepsSortedByAtThenId()) {
      const key = resolveChunkKey(rep.docId, rep.roleSetHash, rep.chunkKey); // walks reanchoredFrom
      acc.set(key, fold(acc.get(key) ?? null, rep, PARAMS));
    }
    await bulkPut('mastery', [...acc.values()]);
    await recomputeAllDocProgress();
  });
}
```

Target: 50,000 reps in under 3 s. This function is the reason the append-only log is worth an extra store,
and it is the migration strategy for every future algorithm change. **Write it on day one, in M1**, even
though the FSRS terms are not surfaced until M4 — the whole point is that turning them on is a recompute.

**Compaction writes a checkpoint, never a hole** (the algo critic's fix). The design doc's retention rule
(delete reps older than 180 days) would silently void its own central bet: after compaction,
`recomputeAll()` restarts every chunk from `initMastery()`, so a user learning a repertoire for a year
loses all accumulated S/D/C on the next `algoVersion` bump and every confidence number quietly *drops*.
Instead, before deleting, insert one synthetic rep per chunk with `mode: 'checkpoint'` carrying the folded
`{S, D, maxDemandPassed, reps, effReps, lapses, totalSec, peekTotal}` as of the cutoff, and have `fold()`
treat a checkpoint as "replace state wholesale". A test asserts: fold 500 reps → snapshot → compact →
`recomputeAll()` → **byte-identical** mastery.

### 11.7 Sessions, deadline mode and stats (M4)

**Session lengths:** Top-up 5 min, **Standard 12 min (default)**, Deep 20 min, Rehearsal 35 min (hard cap;
above it, refuse politely and suggest splitting — a 60-minute masked-recall session is mostly fatigue).
Why 12: it fits in dead time, which is when people actually rehearse, and **two 12-minute sessions on the
same day beat one 25-minute session** because the gap between them is itself the learning mechanism. So
after a completed session we offer *"another one this evening?"*, never *"keep going"*.

Session shape, and the generator's rules:

| # | Block | Time | Modes | Notes |
|---|---|---|---|---|
| 1 | Warm-up read | 60–90 s | `read`, 0% mask, the last session's 2 weakest chunks plus the chunk before them | **Not optional.** Cold-start failures are noise, not signal, and they are demoralising; at `s = 0.08` it costs almost nothing in the model and a lot in adherence |
| 2 | Recall | 4–5 min | `recall`, masking escalating *within* each chunk (40→65→90%), interleaved *between* chunks | Escalation inside a chunk raises the ceiling; interleaving between chunks creates durability. Doing only one of the two is the most common design error |
| 3 | Verified | 2–3 min | `typeItBack` at 50%, on 2–4 chunks that are *nearly* ready | The design doc branched on `asrUsable(doc) ? 'asr' : 'type'`; with ASR cut, this is `type`, which is exactly why `typeItBack` ships in M4 |
| 4 | New material | 0–2 min, acquisition phase only | `read` → 30% `firstLetters` → 60% `blank` on 1–3 new chunks | Rate-limited (below) |
| 5 | Cool-down run | 1.5–2 min | `runReview` over the session's material at the document's default mask, autoscroll on, tap to mark stumbles | **End on a success.** If the last item fails, append one easy re-present: session-end mood is the strongest predictor of coming back tomorrow |

Plus: **drop on failure immediately** (two consecutive grade-1 on a chunk → drop one masking level and
re-present after ≥2 other items; three consecutive failures anywhere → insert a `read` of that chunk and
move on; never let the user fail four times in a row), **within-session spacing** (two reps of the same
chunk separated by ≥2 other items and ≥90 s), **weak-first but not weak-only** (weak chunks in the first
third, where attention is freshest; the session still ends on strong material), and **escape hatches
always visible** ("just let me read it", "just do a run", "practise this scene") — a scheduler that
cannot be overridden gets abandoned, and freeform sessions still log reps
(`phase: 'freeform'`), because we never discard evidence just because the user went off-plan.

**Deadline mode.** With a `performanceAt` (and its mandatory `performanceTz`), the objective changes from
"maintain retention forever" to "maximise `Σ w_i · p_pass_i(T)` subject to a daily budget" — a knapsack,
so the scheduler is a greedy marginal-gain-per-second ranker, not a due queue. `dueAt` still exists and is
still the right model in maintenance mode.

Phases over the `N` available (non-blackout) days: **A Acquisition** first 50% (introduce new chunks,
escalate masking, no full runs), **B Consolidation** next 35% (**material cutoff** — nothing new — drive
weak chunks up, scene-length runs), **C Polish** last 15% (full runs at performance masking, timing, cue
pickups, no new masking levels). Plus a hard rule: **a full run inside the last 24 h**, and one inside
72 h. This mirrors how performers actually work and it is mathematically load-bearing: a run 12 h before
curtain resets `t` to near zero for every chunk, so at `R* = 0.92` the required stability is only
`S ≈ 0.65 d`. Say that to the user — it is reassuring and true: the mid-plan targets are not about
super-durability, they are about not losing ground and raising ceilings.

Three corrections to the design doc's planner, all from the algo critic:

**(a) Feasibility is a forward simulation, not `repsNeeded` with `R` hard-coded at 0.9.** The doc's
estimator assumed every rep landed at the optimal interval; the daily scheduler does the opposite
(revisits within days, when `R ≈ 0.99` and the stability gain collapses to ~1.19× rather than the ~3–4×
the estimator assumed). It therefore under-counted the work by a large multiple and told users
"comfortable" for plans that were not — the single number they plan their month around. We simulate:
for each of `N` days, run `rankChunks` against simulated state at grade 3 and fold the results; derive
the verdict from the projected `Σ(1 − p_pass)` at `T`. It reuses `rankChunks` and `fold`, costs ~250k
float ops, and turns the verdict from a guess into a chart.

**(b) Coverage is an output, not a constraint.** The doc's floor ("every chunk touched every
`max(2, floor(N/4))` days, force-inserted at the top regardless of score") is unsatisfiable by
construction: a 250-chunk script at ~17.8 s/rep needs ~74 min for one full sweep, i.e. 37 min/day to
satisfy a 2-day floor, against a 12-min default — and the force-insert list was then truncated by
`.slice(0, 14)`, so the constraint silently became a no-op while the code read as if it were enforced,
*and* prepending `overdue` meant the greedy ranker never ran. Instead we compute
`coveragePeriod = ceil(chunkCount / (budgetSec / medianSecPerRep))` and **report** it
(*"at 12 min/day you can revisit each line about once every 9 days"*) as one of the four honest levers,
and neglect enters the ranker as a soft term:

```ts
score *= 1 + 0.8 * Math.min(daysSinceTouch / coveragePeriod, 2);
// plus an assertion that any forced list never exceeds 40% of a block's item budget
```

**(c) The four levers, always present when the verdict is `not-feasible`:** increase daily minutes (show
the number needed); lower `R*` (0.92 → 0.85 typically cuts required stability by ~40%); reduce scope
("Act 1 only by the 14th"); or **accept the projection** ("at 20 min/day you'll reach ~72% ready, ≈14
stumbles"). Option 4 is the honest one and must never be missing.

```ts
gain = max(after − before, 0) · words · mustNail · scopeWeight
cost = words/(wpm/60) · modeFactor + 3 s overhead
       // modeFactor: read 1.0, recall 1.6, runReview 1.05, recordReview 1.2, type 4.0
score = (gain / cost) · rot · coverageTerm,     rot = (before < 0.6 ? 1.5 : 1.0)
```

`type` at 4× is exactly why typed verification is used sparingly — for chunks that keep lapsing, not as a
default. Plans are **recomputed from inputs on every app open**; the cache is disposable. There is no
"you owe 47 reviews" backlog — with a fixed deadline the right response to a missed day is to re-plan,
not to punish: *"You're about 1.5 sessions behind. To stay on 92%: 26 min/day (was 20), or accept ~86% and
≈9 stumbles."* Two numbers, two options, no guilt.

**The five stat screens worth building, and nothing else:** (1) the **script heat map** — the whole text
tinted by `conf`, tappable to practise just that chunk; it is simultaneously the progress display, the
navigation and the to-do list, and it makes the model *inspectable*, which is what earns trust — build it
before any chart; (2) readiness over time from `progress.history`, with the performance date marked, a
dashed projection, and real events annotated ("text edited", "3 days off") so dips have explanations
instead of feeling like accusations; (3) expected stumbles, trending down, with "show me which four";
(4) timing and pace — median **and** last full-run duration vs target as *"9:42 — 18 s under"*, WPM per
section with a "this section drags" callout at >1.35× the median seconds-per-word, and the *distribution*
of the last five runs, because *"your best is 9:40, your median is 10:25"* is the honest framing that
prevents a nasty surprise on the night; (5) most-missed lines by **lapse rate**
(`lapses / max(effReps,1)`, requiring `effReps ≥ 3`), plus word-level aggregation of `missedTokenIdx` —
*"you drop 'therefore' every single time"* is a delightful feature that falls out of data we already
store.

Streaks are **included but defused**: "Practised 5 of the last 7 days" (a rolling window that cannot be
broken) plus a 12-week calendar of active minutes. No freezes, no fire-emoji escalation, no
"you lost your 47-day streak" screen — break means quit.

**Explicitly do not build:** total reps / words "learned" / XP / points (rewards volume, and volume is
maximised by re-reading — the exact behaviour the app exists to prevent); anything that counts a `read`
as progress on the main number (the central lie, which §11.4 makes structurally impossible);
"100% mastered" or a completion trophy (false 48 h later, and it tells the user to stop practising at the
worst moment); unweighted mean confidence; punishing streaks; raw ASR accuracy as a score; leaderboards;
time-in-app.

### 11.8 Reminders and backup

**There is no push notification.** A scheduled reminder needs either Web Push (a push service, a
subscription endpoint and a server to send from — which contradicts zero-cost/zero-backend, and on iOS
additionally requires an installed PWA) or the Notification Triggers API, which never shipped. The
design doc's `settings['schedule.notifications']` toggle is **deleted**, because shipping it would be a
lie. What we ship instead: **`.ics` calendar export** (one event per planned session from the forecast —
a few lines, uses the OS's own reminder system, works offline, needs no server), an install-time nudge
explaining that the home-screen icon *is* the reminder, and `navigator.setAppBadge()` updated on app open
where supported, with its limitations stated.

**Backup.** One versioned JSON file, `format: "lines.backup"`, `formatVersion: 1`, with an integrity hash
over canonicalised data (a truncated mobile download is a real failure), `counts`, and per-record
tolerance so one corrupt text does not fail the file. Validation is hand-written (~80 lines, no Zod),
which is what makes partial recovery expressible, and it doubles as the version-migration seam.

- **`derived` is never exported** (a pure cache, ~30% of the payload, and a stale index is a hazard) and
  neither is any token model — so a backup made by v1 imports cleanly into v5 with a completely rewritten
  tokenizer. This is the single most valuable rule in the format.
- **Audio never goes in the JSON** (base64 inflates 33%; a 200 MB library would produce a 270 MB file no
  phone can parse). The `.mcz` zip with audio and a human-readable `text/` directory is LATER.
- **Bound the problem instead of solving it.** Before export, compact `reps` per §11.6 so the file stays
  in the low single-digit MB, keep plain `JSON.parse`, and refuse above a tested ceiling with an
  explanation plus per-document export as the escape hatch. The design doc's "streaming JSON parser" is
  deleted: there is no such thing in the platform, so it would be either a new dependency against a
  15 kB budget or ~200 lines of incremental parsing that must be perfect or the user's only backup is
  unreadable.
- **Restore is a merge, never a replace**, by default: per-record `updatedAt`-wins for mutable stores,
  `reps` unioned by id (append-only ⇒ conflict-free), `mastery` **recomputed from the merged log**
  afterwards rather than merged directly, so we never end up with two half-states. A summary dialogue
  ("3 new, 2 updated, 7 unchanged") before committing, in one transaction. Restoring the same file twice
  is a no-op. `replace` exists behind a typed confirmation and writes a pre-import backup first.
  `docsOnly` (text + roles + prefs, no progress) is the **sharing** default — actors share scripts
  constantly and nobody wants someone else's practice history.
- **Save path:** `Blob` + `URL.createObjectURL` + `<a download>` on desktop and Android; on iOS standalone
  `<a download>` is unreliable, so feature-detect and prefer `navigator.share({files})` so it lands in
  Files/iCloud/AirDrop, with "copy JSON to clipboard" as the last resort. All three behind one
  `saveBackup()`.
- **The nudge has teeth**, because it is the actual safety net for the eviction risk: if `lastBackupAt` is
  null, or >14 days old with changes since, show a non-modal amber bar — *"Back up your 12 texts (one
  file)"*. And the empty state is deliberately slightly alarming, because it is true: *"No backups yet.
  Your texts only exist on this device."*

### 11.9 Time, timezones and clock skew

The scheduler is entirely clock-driven, which makes clock correctness a data-integrity concern rather
than polish. Four rules:

1. **`performanceTz` (IANA) is stored alongside `performanceAt` and is mandatory.** A plan built in London
   for a show in New York otherwise gets the wrong day boundaries, the wrong weekday budget, and a
   mandatory final run anchored to the wrong local evening.
2. **`epochDay` is the local civil day in the relevant zone**, computed via `Intl.DateTimeFormat`, never
   `Math.floor(ms / 86400000)` — that is UTC, so for negative offsets the day rolls over mid-evening,
   exactly when people rehearse.
3. **Every rep stores `tzOffsetMin`** so history stays interpretable after travel.
4. **A monotonic guard.** Persist `meta.lastSeenClock`; if `now` is earlier than the latest rep, or jumps
   forward by more than 12 h between writes, clamp `t` for that fold, mark the rep `clockSuspect: true`,
   and surface one honest message rather than silently corrupting `S`, `C` and `dueAt` forever. And
   `recomputeAll()` sorts by `at` with `id` as the tiebreak (§11.6), so a clock change can never reorder
   history.

---

## 12. Design system

Plain CSS custom properties in `src/styles/tokens.css`, consumed by per-feature `.css` files, with
`@layer reset, tokens, components, utilities` so cascade order is explicit. **No Tailwind** — the token
values, the contrast ratios and the `data-theme` override strategy from the UX doc carry over unchanged;
only the wiring differs. Three utilities are worth defining up front: `.sr-only` (the clip-rect version,
not `display:none`), `.tap-44` (an `::after` inset expander), and `.reader-measure`
(`max-width: var(--measure); margin-inline: auto`).

### 12.1 Light theme

| Token | Hex | Role | Contrast |
|---|---|---|---|
| `--paper` | `#FAF9F7` | App background, reader canvas | — |
| `--surface` | `#FFFFFF` | Cards, sheets, rows | 1.05:1 vs paper (intentionally near-invisible; rules do the work) |
| `--surface-sunk` | `#F2F0EC` | Inset areas, textarea | — |
| `--text-strong` | `#14161A` | Reader body, headings | **17.21:1** |
| `--text-body` | `#22262B` | UI body | **14.46:1** |
| `--text-muted` | `#585F68` | Meta, labels | **6.14:1** |
| `--text-faint` | `#6B747E` | Line numbers, stage directions | **4.51:1** — corrected from `#6F7883` (4.26:1, below AA). Same value as `--mask-rule`, one fewer token, passes everywhere |
| `--border` | `#E3DFD8` | Hairlines (decorative only) | 1.26:1 |
| `--border-strong` | `#C9C4BA` | Emphasised dividers | 1.65:1 |
| `--border-interactive` | `#868D95` | Outlines of unfilled controls | **3.19:1** ✓ SC 1.4.11 |
| `--accent` | `#10756A` | Primary buttons, current-line rule | **5.29:1** |
| `--accent-ink` | `#0C6157` | Accent *text* and links | **6.97:1** |
| `--accent-on` | `#FFFFFF` | Text on accent fill | **5.56:1** on accent |
| `--accent-wash` | `#E2F1EE` | Chips, selected rows | accent-ink on it = **6.30:1** |
| `--mask-fill` | `#EAE6DE` | Blank background (Box style) | 1.18:1 vs paper — the *rule* carries the signal |
| `--mask-rule` | `#6B747E` | **The load-bearing token** | **4.51:1** vs paper, **3.81:1** vs mask-fill ✓ both >3:1 |
| `--peek-text` | `#7A4A00` | A just-revealed word | **7.11:1** |
| `--peek-bg` | `#FDF0D6` | Behind a revealed word | text-body on it = **13.49:1** |
| `--line-current-bg` | `#FFF3CE` | Current-line tint | text-strong on it = **16.36:1** |
| `--success` | `#1E6B3A` | Clean run | **6.20:1** |
| `--danger` | `#A4262C` | Destructive actions | **6.90:1**; white on it = 7.26:1 |
| `--focus` | `#0C6157` | Focus ring | **6.97:1** |

### 12.2 Dark theme

| Token | Hex | Contrast |
|---|---|---|
| `--paper` | `#121417` | a true dark grey, not black |
| `--surface` / `--surface-sunk` / `--surface-raised` | `#1A1D21` / `#0D0F11` / `#23272C` | 1.09 / — / 1.23:1 |
| `--text-strong` | `#EDEBE6` | **15.49:1** — a warm off-white, because pure white on pure black at 22 px causes halation, which is exactly wrong for someone in a dark wing waiting to go on |
| `--text-body` | `#DCD9D3` | **13.10:1** (10.66:1 on raised) |
| `--text-muted` | `#A3A9B1` | **7.79:1** |
| `--text-faint` | `#7C838C` | **4.82:1** |
| `--border` / `--border-strong` / `--border-interactive` | `#2F343A` / `#414852` / `#767E88` | 1.47 / 2.00 / **4.49:1** ✓ |
| `--accent` / `--accent-dim` / `--accent-on` / `--accent-wash` | `#5FC9BC` / `#3E9E93` / `#121417` / `#17332F` | **9.28** / 5.73 / 9.28 / 8.42:1 |
| `--mask-fill` | `#24282D` | 1.24:1 vs paper |
| `--mask-rule` | `#79818B` | **4.68:1** vs paper, **3.76:1** vs mask-fill ✓ |
| `--peek-text` / `--peek-bg` | `#E2B15E` / `#2A2419` | **9.39:1** |
| `--line-current-bg` | `#1E2429` | text-strong on it = 13.16:1 |
| `--success` / `--danger` / `--focus` | `#6FCB8E` / `#F2857F` / `#7FDCD1` | 9.32 / 7.41 / **11.48:1** |

### 12.3 High contrast and forced colors

Triggered by `prefers-contrast: more` or the manual theme; layered as an override, not a third palette.
Text → `#000`/`#FFF` (21:1); `--mask-rule` → `#000`/`#FFF` at 3 px **and** `--mask-fill` becomes
`#E0E0E0`/`#303030` so the blank is signalled twice; all hairlines become `--border-interactive`;
`--line-current-bg` is removed and the current line gets a 4 px accent rule plus a 1 px box outline
(shape over colour); focus ring 3 px at 3 px offset; decorative tints drop to transparent with a 1 px
outline. Under `forced-colors: active` (Windows High Contrast) use system colours
(`ButtonText`/`Canvas`/`Highlight`) and set `forced-color-adjust: none` on the mask rule with an explicit
`border-bottom-color: ButtonText` — **a blank that disappears in forced-colors mode makes the app
unusable.**

### 12.4 Type scale, spacing, motion

Base 16 px = 1rem; a modest ~1.2 ratio for UI; the reader scale is user-controlled and independent.
`--fs-2xs` 11/16 (chips), `--fs-xs` 12/16, `--fs-sm` 14/20, `--fs-base` 16/24 (**16 px minimum on inputs**
— anything smaller triggers iOS Safari zoom-on-focus), `--fs-md` 17/24, `--fs-lg` 20/28, `--fs-xl` 24/32,
`--fs-2xl` 30/36, `--fs-hero` 48/52 (the one big number on the Debrief), `--fs-reader` 18–44 px
(default 22) with `--lh-reader` 1.45/1.65/1.95. Weights: 400 body, 500 reader body at large sizes only,
600 headings and row titles, 700 the Debrief hero. Never 300 (fails at small sizes on Android), never 800+.

Spacing on a 4 px base (4/8/12/16/20/24/32/40/48/64); gutters 16 px mobile, 24 px ≥768 px; 32 px between
sections; list rows hairline-separated with 14 px vertical padding. Radii: `--r-xs` 4 (masked blank box,
chips), `--r-sm` 8 (buttons, inputs), `--r-md` 12 (cards), `--r-lg` 16 (sheet top corners),
`--r-full`. Nothing more rounded than 16 px — over-rounding reads as "toy".

**Exactly two shadows in the whole app:** `--shadow-sheet`
(`0 -8px 32px rgb(20 22 26 / 0.14)` light, `/ 0.5` in dark) for bottom sheets, and `--shadow-fab`. In dark
mode elevation is expressed by `--surface-raised` being *lighter*, never by shadow. Everything else uses a
hairline.

Motion: `--t-fast` 120 ms (token reveal, tint), `--t-base` 180 ms (sheets, chrome fade, stepped scroll),
`--t-slow` 260 ms (routes); `--ease-out: cubic-bezier(.2,0,.2,1)` for entrances,
`--ease-in-out: cubic-bezier(.4,0,.2,1)` for moves; **all of it inside
`@media (prefers-reduced-motion: no-preference)`** so reduced motion is the structural default.

### 12.5 The four text states — the crux

| State | Signalled by |
|---|---|
| Visible | normal text |
| **Masked** | **absence of glyphs (shape) + a 2 px rule (shape)** — never by colour alone |
| **Peeked** | `--peek-text` on `--peek-bg` decaying to masked over 180 ms — colour **+** the change event **+** it is the only coloured word on screen. The colour is the point: it marks "this one cost you something" and makes your leaning visible in peripheral vision |
| Cue line | `opacity: 0.7` (0.66 dark), never masked, still ≥7:1 |
| Current line | tint **+** 3 px accent left rule (two signals) |
| Weak line | a 3 px `--peek-text` left rule, inset from the current-line rule |
| Line-focus dimmed | `opacity: 0.32` — opacity only, and it is user-initiated |

---

## 13. Milestones

Effort is in **dev-days** (one focused day of Ben + Claude Code). No calendar dates.
**v1 = M-1 + M0 + M1 + M2 = ~17.5 dev-days.** M3 and M4 are v1.1 and are optional in the sense that the
product is genuinely useful without them.

Total to something better than the app we are copying: **~31.5 dev-days.** That is an honest number and it
is four times what "a few focused sessions" implies — which is exactly why §3.2 is as long as it is. Ship
M1 and use it for one real memorisation job before starting M2.

---

### M-1 — The de-risking spike (0.5 dev-days)

**Goal.** Settle the three unknowns that decide the whole product, on Ben's actual iPhone, before any
committed code exists. The entire app is one screen whose feel has never been tested on a phone, and three
risks stack there that are all invisible in a desktop browser.

**Tasks.**
1. `spike/mask-render.html` — one static file, no build step, ~150 lines. Hardcode Sonnet 18 and one
   35-line monologue.
2. Render the same text **twice**: (a) the chosen contract — inner span at `visibility:hidden`, blank drawn
   on the outer inline-block box; (b) the rejected `color: transparent` + background fill, purely to
   confirm on-device that it leaks to selection and VoiceOver.
3. `pointerdown` peek at 140 ms with a 10 px movement cancel, and a `getBoundingClientRect()` logger that
   prints every token's rect to the page at 0% and at 45% masking.
4. Serve over LAN HTTPS (`vite --host` + mkcert, or any static server with a trusted cert) and open on
   Ben's iPhone in **Safari** *and* installed to the home screen.
5. Measure four things and write the answers into `docs/decisions/ADR-0005.md`: are the rects identical;
   does the magnifier or callout ever appear; does scroll reliably win over peek; **and does Ben actually
   like reading it at 22 px**.
6. While the file is open, probe `navigator.wakeLock.request('screen')` in both contexts, and turn
   VoiceOver on for two minutes over the masked text.

**Demo.** Ben reads a masked sonnet on his own phone and says whether it feels good.
**Non-goals.** No framework, no build, no commit, no styling beyond the tokens under test.
**Why first.** Half a day, zero committed code, and it settles the renderer contract, the wake-lock
contradiction and the accessibility risk simultaneously. **Do not start M0 until it is done.**

---

### M0 — Walking skeleton (2 dev-days)

**Goal.** An empty app that installs to Ben's home screen, boots offline, and lives at a URL — with the
architecture (not the features) already in place.

**Tasks.**
1. Trademark / domain / npm check on **Offbook**; if messy, fall back to **Byheart**. Write the outcome
   into `README.md`. *(Blocks task 2.)*
2. `npm create vite` → React + TS; `src/brand.ts`; strict `tsconfig.json` with
   `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, one `@/*` alias, and
   `noFallthroughCasesInSwitch: false` with a comment (the DB upgrade switch falls through on purpose).
3. `biome.json`: formatter on (2 spaces, single quotes, 100 cols), recommended rules, plus
   `noRestrictedImports` enforcing the §5 layering.
4. `vitest.config.ts` + `tests/setup.ts` (`fake-indexeddb`, `matchMedia` stub) + one trivial passing test.
5. `CLAUDE.md`: the layering rules, the dependency budget, the §3.2 kill list, the frozen method ids, and
   the `INPUT` constants table. This file is what keeps the plan alive when the context window rolls.
6. The `src/` directory skeleton from §5, with `core/**` empty but present.
7. `data/db.ts` + `schema.ts` at DB v1 (`meta`, `settings`, `folders`, `documents`, `docText`), with
   `blocked`/`blocking`/`terminated` handlers **and** the `open()` timeout with a connection-probe retry.
8. `data/broadcast.ts` — `BroadcastChannel('lines')` publish-after-write and the mirror invalidator.
9. `storageInfo.ts` — `persist()` on first write (on **all** platforms), `estimate()`, and the
   localStorage `hadData` eviction tripwire.
10. Four routes rendering placeholders; root + per-route `ErrorBoundary`; `styles/tokens.css` with the §12
    light and dark tokens (`--text-faint` already at `#6B747E`).
11. `vite-plugin-pwa` with the §4.3 config; `public/_headers` and `_redirects` with the §4.1 CSP; icons.
12. **The pdf.js wiring spike**: `await import('pdfjs-dist')` in a throwaway route, resolve the worker
    through Vite, log one page of text from a fixture, run `npm run analyze`, and write the **real** worker
    size into `CLAUDE.md`. Then delete the route. This is here so the bundling surprise happens on day one
    rather than in session nine.
13. `.github/workflows/ci.yml`: Node 22 → `npm ci` → `npm run check` (typecheck + lint + test).
14. Connect the repo to Cloudflare Pages, build `npm run build`, output `dist`, **deploy on day one**.
15. `LICENSE` (MIT) and `ADR-0007`; a `licences.txt` generation step in the build.

**Demo.** `https://offbook.pages.dev` installs to the home screen, opens offline, shows an empty library.
**Non-goals.** Any feature at all. No tokenizer, no masking, no import.
**Effort:** 2 days.

---

### M1 — Off-book on one text (5 dev-days)

**Goal.** The whole loop, on a pasted text, with one method. **This is the milestone that decides whether
the project is worth continuing** — Ben should get genuinely off-book on something real before M2 starts.

**Tasks.**
1. `core/text/types.ts` — `RawLine`, `Token`, `Line`, `Block`, `Document`, `Chunk`, exactly as §6.2/§7.
2. `core/text/extract/paste.ts` + the `text/html`-preferring paste handler.
3. `core/text/clean/` — rules 1–4 (`normalise`, `punctuation`, `whitespace`, `dropArtifacts`) as pure
   functions with per-rule `{lines, changed, notes}`.
4. `core/text/tokenize.ts` — the §7.4 `Intl.Segmenter` grouping, peeling, separator emission and
   classification.
5. **`tests/unit/text/tokenize.reconstruction.test.ts`** — the `fast-check` property test for
   `ws+lead+text+trail`, plus the 14 golden table cases from the design doc (`Don't — it's O'Brien's.`,
   `1,200-page`, `'Tis`, `£5.99 (plus 20% VAT)`, `私は学生です。`, `Rock'n'roll`, `Mr. Smith Jr. … D.C.`).
   *This is the highest-value test in the project and it is written before anything renders.*
6. `core/text/functionWords.ts` with the load-time apostrophe normalisation, plus a test asserting
   `isFunction` for all 30 contraction forms and `i'm/i'll/i've/i'd/let's/that's/there's/what's`.
7. Derived flags in one pass (`isProperish` excluding `I`-forms and German; `count`; `hasDigit`;
   `isMaskable`), and the `tokFlags` bitfield packer.
8. `core/text/chunk.ts` — line/sentence/block/speech chunking, `Intl.Segmenter` sentence segmentation with
   the abbreviation guard, `chunkKey` with `rankWithinIdenticalGroup`, and the exact-pass re-anchor.
9. `core/mask/rng.ts` (cyrb128 → sfc32) and `core/mask/plan.ts` — `computeMaskPlan`, the candidate-filter
   ordering of §8.4 fix A, the spacing pass, `k` per fix B.
10. `core/mask/kernels/percent.ts` + `registry.ts` with **`hideWords` only**, and `ladder.ts` with the
    7 rungs.
11. **The masking conformance suite**, auto-applied over the registry with `describe.each`, so method #2
    onwards is covered for free: monotonicity (where `nestedLadder`), determinism (byte-identical
    `Uint8Array` for the same spec), rung 0 hides nothing, top rung hides everything maskable, exact
    cardinality per fix B, punctuation never hidden, every rung strictly distinguishable from its
    neighbour, and a `fast-check` pass over random token counts / rungs / seeds.
12. DB v2: `derived`, `reps`. `repos/derived.ts` with the `textHash` + `pipelineVersion` invalidation.
13. `core/progress/fold.ts` + `recomputeAll()` — written now, FSRS terms present but only `peekTotal` and
    the rep log surfaced. Plus `core/progress/time.ts` (`epochDay`, the monotonic guard).
14. `features/reader/` — `Reader.tsx`, `LineView.tsx`, `MaskedToken.tsx` with the §8.3 markup and CSS;
    `useMaskPlan` (diffed `data-mask` writes); the status rail, control bar and Stage chip; typography from
    settings; `useCurrentLine`; `useScrollAnchor`. **Profile a 5,000-token and a 10,000-token document on a
    real mid-range Android here** — this is a gate that may change the rendering contract while it is
    still cheap.
15. `useLongPress.ts` — Pointer Events, the §9.3 constants, the iOS property set, `contextmenu`
    prevention. Tap = peek, hold = peek-while-held, tap Reveal = reveal-all, 600 ms hold = hard reset.
16. Peek/reveal recording → `Rep` on run end, with deduped help events; `helpRate`; auto-advance on a
    clean run with the Debrief `Undo`.
17. Method sheet with live previews from the user's own text; Aa sheet (size, line height, measure, theme,
    blank style, line focus); `⚙ Custom…` collapsed.
18. `PracticeCursor` persistence (debounced 500 ms **and** on `visibilitychange`/`pagehide`), restore on
    open, and the "anchor no longer resolves → nearest surviving chunk, and say so" path.
19. A flat library list (no folders yet) + paste import + delete with a snackbar undo.
20. JSON export (`saveBackup()` with all three save paths) — export only; import lands in M2.
21. `e2e/import-practice-reload.spec.ts` on Chromium + WebKit.

**Demo.** Ben pastes his own speech, ladders from `Read through` to `From memory`, gets off book, closes
the app, and reopens tomorrow at exactly the same stage, scroll position and mask.
**Non-goals.** Files, PDF, roles, other methods, autoscroll, cleanup screen, folders, stats, confidence
numbers, voice.
**Effort:** 5 days.

---

### M2 — Parity, and then past it (10 dev-days)

**Goal.** Everything the app we are copying does, plus role isolation as a lens and cue-tail practice.
This is the end of v1.

**Tasks.**
1. `extract/txt.ts` + `extract/md.ts` + encoding sniff + the manual encoding picker.
2. `extract/html.ts` — `DOMParser` block walker on a detached document.
3. `extract/pdf.ts` — our own worker, lazy `pdfjs-dist`, per-page progress, `Util.transform`
   normalisation, y-clustering at `0.35 × median size`, the `0.22 ×`/`2.5 × size` join rules, the
   **tracking guard**, blank-line reconstruction, `indentPt` capture, the always-drop pattern list,
   scanned detection, and the CJK non-goal copy.
4. The import preview: **always editable**, with the warnings list as a walkable checklist.
5. `core/text/sniff.ts` — the five-type scorer, the preset mapping, and the five-button
   "What kind of text is this?" fallback below 0.65 confidence.
6. Cleanup screen: five toggles with live counts and a **live reader-typography preview**; rule 5's
   `dehyphenate → stripSoftHyphens → unwrapHardBreaks` ordering; `manualText` override; "reset to the
   original import".
7. `core/text/structure.ts` — the three cue patterns with the recurrence guard, the terminal-`!?` penalty,
   the `count ≥ 2` requirement and the singleton-collection guard; headings, transitions, directions;
   inline directions as `kind:'direction'` tokens; ensemble names; lyric section labels and Genius
   `[Verse 1: Artist]` → speaker.
8. Structure editor: the per-line fix sheet, **"apply to all N lines like this"**, the four bulk toggles,
   the speaker manager with fuzzy merge suggestions, and `StructureOverride` storage keyed to
   `LineFingerprint`.
9. Role picker with per-role line/word/minute counts, doubling, and additive ensembles; `roleSetHash`;
   the three role views (full / cue script with a settable tail / my lines only) and the cue-word underline.
10. `core/mask/lens/myLines.ts` + `protect.ts` + `reveals.ts`, applied in the §8.4 order.
11. The nine remaining methods: `firstLetters`, `lineEnds`, `lineStarts`, `hideLines`, `keyWords` (with the
    colloquial-dialogue guard), `glueWords`, `rhymes` (nucleus-based), `chunkWindow`, `myLines` — each a
    registry entry over one of the five kernels, each auto-covered by the conformance suite.
12. `useAutoScroll.ts` — WPM, block-measured velocity, smooth and stepped, pause-on-touch with 2.5 s
    incidental resume, pause-on-peek, the decelerating end, the count-in.
13. `useWakeLock.ts` per §9.6, with the re-acquire and the honest failure copy.
14. Folders (flat), sort orders, and brute-force search (debounced 150 ms, diacritic-insensitive, grouped
    Texts / Lines).
15. Backup **restore** with the merge preview, the integrity check, per-record tolerance, `docsOnly`
    sharing, and per-text `.txt`/`.json` export.
16. PWA polish: install prompt after the **second** completed run (never on first load), the iOS
    Add-to-Home-Screen sheet with the gesture illustrated, the update toast, the eviction tripwire message,
    the backup nudge.
17. First run (three panels, panel 1 is the live mechanic) + the four public-domain samples with sources
    recorded in a comment.
18. Debrief: peeks as the hero number, the per-line confidence strip, `Drill these 5 lines`, the
    auto-advance notice with `Undo`, and the two-holds intervention suggestion.
19. Settings, About (with the §10.5 privacy copy verbatim and the confidentiality sentence), the shortcuts
    overlay, and the ~24 keyboard bindings.
20. Web Locks practice lock (`practice:<docId>`) + the boot-time `Σ mastery.reps` vs `count(reps)`
    consistency check offering `recomputeAll()`.
21. `e2e/boot-offline.spec.ts`, `e2e/longpress-reveal.spec.ts` (WebKit, `hasTouch`), and the
    no-CSP-violation assertion.

**Demo.** Import a real PDF script, fix two misdetected cues in three taps, rehearse only your own role
with 3-word cue tails at 50% masking, autoscroll at 120 wpm with the screen staying awake, fully offline,
from the home screen.
**Non-goals.** DOCX, RTF, OCR, Fountain, column detection, Viterbi, AI assist, tags, nested folders,
revisions, postings, teleprompter, stepped methods, Type It Back, confidence numbers, voice, print.
**Effort:** 10 days.

---

### M3 — Voice, ordered by reach (6 dev-days)

**Goal.** Rehearse with the screen off, against your own recorded voice or a synthetic partner.

**Tasks.**
1. **The device spike, first (0.5 d).** On Ben's iPhone, in an installed PWA: record 30 s, store the blob
   in IndexedDB, read it back, play it via `<audio>` with `<source>` children, seek, and confirm
   MediaSession on the lock screen. Write the result into the risk register. **If it fails, tasks 3–7 are
   deferred and M3 ships the TTS partner only.**
2. `voice/capabilities.ts` — the caps probe, the audio watchdog (silent buffer, assert `currentTime`
   advances and `ended` fires), and persisted verdicts.
3. DB v4: `recordings` + `recordingBlobs`; the 3 MB round-trip probe with the `ArrayBuffer` fallback.
4. `voice/recorder.ts` — mime negotiation, the raw toggle, `audioContext.currentTime`-based marks with
   150 ms padding on each side, read-through capture with tap or VAD advance.
5. `voice/vad.ts` — `AudioWorkletNode` (falling back to `AnalyserNode`), adaptive noise floor, the
   3.5×/120 ms/700 ms thresholds, and the scrupulously honest "timing only" copy. Wire it to
   `Rep.spokenAloud` and to auto-advance. Probe once on iOS standalone by asserting RMS exceeds the floor
   within 3 s, falling back to tap.
6. `voice/player.ts` — the `<audio>` engine with MediaSession, `previoustrack`/`nexttrack` mapped to line
   navigation, and lock-screen metadata. The `AudioBuffer` segment engine is added **only if** the spike
   passed and precision proves insufficient.
7. Mute-my-lines: the segment playlist, the 1.2 s cue tail at full volume, `gapFactor` 0.8–1.6, duck-don't-
   mute at 0.08, loop-a-section, and the visual countdown ring.
8. Retention: 30-day ephemeral takes with a 7-day banner, max 3 per text, the pin, "free up space" by size,
   and cascade-delete with an undo window.
9. `voice/tts.ts` — the voice registry keyed on `voiceURI`, the gesture unlock, the `getVoices` promise +
   poll, sentence chunking ≤180 chars, the boundary probe with sentence-level fallback and the
   utterance-local → global token index map, `localService` filtering, and the rate/pitch clamps.
10. `voice/partner.ts` — the half-duplex state machine, the four turn-end modes, the 250 ms lead-in /
    150 ms tail, pre-queue on `start` (not `end`), the count-in, the overlap toggle, and the mode badge
    with its tap-through explanation.
11. The hybrid partner (TTS lines + estimated gaps, no recording) as the **default** first voice
    experience.
12. `privacy.confidential` per document and globally, hard-disabling cloud voices, with the NDA sentence
    in the voice pre-flight card.

**Demo.** Record the scene once; then rehearse against your own voice with your lines silent, screen off,
lock-screen skip buttons moving line by line, on an iPhone.
**Non-goals.** Speech recognition, scoring, Whisper, word-level karaoke, per-line re-record, audio export.
**Effort:** 6 days (5.5 if the spike defers recording).

---

### M4 — The honest loop, and the polish that makes it feel finished (8 dev-days)

**Goal.** Turn on the progress model, and close the accessibility and print gaps.

**Tasks.**
1. DB v3: `mastery`, `sessions`. Activate the FSRS-lite terms in `fold()`; bump `algoVersion`; offer
   `recomputeAll()` from the Storage screen with a progress indicator.
2. `core/progress/stakes.ts` (with `m_content` and `selectionFactor`) and `confidence.ts` (read-time `C`
   decay, `conf`, `p_pass`, readiness, `pctAt80`, expected stumbles). Unit-test the entire §11.3 decay
   table and the `S_req` multipliers **recomputed from the formulas**.
3. The compaction checkpoint, with the fold-500 → compact → recompute → byte-identical test.
4. `typeItBack` — the input rendering, the apostrophe-stripping matcher, Damerau-Levenshtein, three
   strikes, re-queue, the separated `typedAccuracy` / `recallAccuracy`, and `visualViewport`-driven
   keyboard avoidance.
5. `snowball` and `spotlight` over one shared stepped engine, with `nestedLadder: false`, `maxRung`, and a
   polite announcer message per step advance.
6. `core/progress/session.ts` — the five-block generator, `trimToBudget` (shortens block 2 then 3, never
   the warm-up or the cool-down), within-session spacing, drop-on-failure, end-on-success, and the escape
   hatches.
7. `core/progress/plan.ts` — the phase split, the mandatory final run inside 24 h, the **forward
   simulation** for feasibility, the greedy ranker with the soft coverage term, the new-material rate cap,
   and the four honest levers.
8. `performanceTz`, `epochDay` in the plan's zone, `tzOffsetMin` on reps, and the clock-skew guard.
9. The five stat screens, starting with the **heat map** — before any chart.
10. Expected stumbles as a **range** until three graded runs exist, plus the isotonic calibration against
    `runSplits[].stumble`, and "not yet measurable — do a run" before that.
11. The tap-to-explain layer on every number.
12. The rolling-7 "practised 5 of the last 7 days" plus the 12-week minutes calendar. No streak shaming.
13. Leech detection, auto-split, and the one-line explanation.
14. The Contents sheet (act/scene/section list with per-section readiness and my-line counts, tap to jump).
15. `annotations` store + the four kinds; `alwaysShow` wired into the `Protect` filter; the hairline margin
    dot for notes; inclusion in backup.
16. `styles/print.css` + `/t/:id/print` with the four presets and the role/range selector, plus the
    all-pages print check.
17. `.ics` session export; `navigator.setAppBadge()` on open.
18. Diagnostics: a local ring buffer (last N errors, the last import's warnings and confidences, timings),
    a `Report a problem` item in Settings and in the error boundary that assembles a **redacted** bundle
    (counts, versions, timings; document text only if the user explicitly attaches it after a preview), and
    one-tap Copy and Share. Zero network from our code, so the CSP stands.
19. **The real-AT pass, scheduled not hoped for**: VoiceOver iOS, VoiceOver macOS, NVDA + Chrome, TalkBack,
    over a line with three blanks, a stage change, a step advance, and Type It Back. This is a **gate**:
    if the §9.8 pattern does not work, it is fixed here, before the app is called finished.
20. High contrast + `forced-colors` + the contrast-ratio snapshot test.
21. The `.mcz`-free backup hardening: the tested size ceiling, per-document export as the escape hatch.

**Demo.** "The show is on the 14th, I have 20 min/day" → a daily plan, an honest feasibility verdict, a
heat map that shows exactly which four lines will stumble, and a printed cue script for the train.
**Non-goals.** ASR, Whisper, teleprompter, mirror flips, command palette, tags, nested folders, sync, the
`.mcz` archive, Web Share Target.
**Effort:** 8 days.

---

## 14. Testing strategy

Target: high coverage on `src/core/**`, close to zero elsewhere. **No `@testing-library/react`, no jsdom
component tests** — stated as a decision, not laziness. Component tests here would assert that a button
renders a label; the bugs that will actually ship are in the tokenizer, the masking maths, the PDF parser,
the fold and the migrations, all of which are pure functions.

### 14.1 The tests that pay for themselves

1. **Tokenizer exact-reconstruction** (`fast-check` + 14 golden cases). The single highest-value test.
   Generators must include NFD-normalised Latin (macOS and many PDF text layers produce it, and `café`
   must not lose its accent to the mask), Devanagari and Thai combining marks, Arabic with harakat, CJK,
   emoji ZWJ sequences, every Unicode punctuation category, CRLF, tabs, an empty string, and one
   40,000-character word.
2. **The masking conformance suite**, `describe.each` over the registry so every new method is covered
   automatically: monotonicity (`masked(L_n) ⊆ masked(L_{n+1})` where `nestedLadder`), determinism (byte
   equality), rung-0-hides-nothing, top-rung-hides-everything-maskable,
   `k === clamp(round(p·n), p>0?1:0, n)`, punctuation never hidden, `plan(L_n) !== plan(L_{n+1})` for every
   rung pair, and `styles.length === tokens.length`.
3. **Reshuffle efficacy**, restated so it is satisfiable: `Jaccard(plan, reshuffled) < 0.9` **for rungs
   where `0.1 ≤ p ≤ 0.7`**. The design doc asserted it "at rungs 1–5" including the top, where masked sets
   necessarily overlap heavily and at `p = 1` are identical.
4. **`fast-check` over masking**: random token counts, rungs and seeds → monotonicity, determinism, bounds.
   Two dozen lines that will find the empty-text, one-token, all-punctuation and 100% cases.
5. **The CI no-reflow test** (Playwright): record `getBoundingClientRect()` for every `.tok` at rung 0,
   then assert identical rects (±0.02 px) at every rung of every method and after peek and reveal. This
   test is the reason the architecture looks the way it does. `typeItBack` is exempt **by name**, with the
   `min-width` reason in a comment.
6. **One `fake-indexeddb` migration test per DB version bump, forever.** Open at vN, write records, reopen
   at vN+1, assert data survives and the shape upgraded. This is the test that prevents wiping a user's
   library on an update.
7. **`fold()` / `recomputeAll()`**: fold 500 reps → snapshot → compact → recompute → byte-identical
   mastery; a clock that jumps backwards and forwards; `recomputeAll()` ordering by `at` not `id`; and the
   §11.3 decay table and `S_req` multipliers recomputed from the formulas so no hand-typed number drifts.
8. **`backup/validate.ts` + `migrate.ts`**: a checked-in `backup-v1.json` must import cleanly forever, one
   fixture per format version. Plus malformed JSON, missing fields, one corrupt record among good ones
   (partial recovery), and idempotence of double import.
9. **Structure detection**, reporting accuracy numbers rather than pass/fail, so a heuristic change shows
   its cost: cue precision and recall per fixture, target **precision ≥ 0.95** (a false role wrecks
   `myLines`, and a missed one is merely annoying).
10. **The contrast snapshot test**: compute every ratio in §12 from the token values and assert the floors.
    Twenty lines, and it prevents the most likely visual regression.
11. **The name-grep test**: fail if the competitor's name appears anywhere in `src/` or `public/`.
12. **The layering test**: walk `src/core/**` imports and fail on `react`, `zustand`, `idb`, `window`, or
    anything from `@/data`, `@/stores`, `@/features`.

### 14.2 Specific tricky cases, listed so they are not forgotten

**Tokenizer:** `Don't — it's O'Brien's.` · `1,200-page` and `3,` where the comma is *not* a digit grouper
(next char is a space) · `3.14`, `9:30`, `1/2`, `R&B`, `AT&T` · `Mr. Smith Jr. went to Washington, D.C.
Then he left.` (abbreviation dots stay in `text`; the final period *is* terminal) · `'Tis`, `'90s`,
`dogs'` · `Wait... what? . . . Hello?` · `£5.99 (plus 20% VAT).` · `Rock'n'roll` as one token ·
`私は学生です。` · `שלום עולם, מה קורה?` · NFD `café` · `mother-in-law's` with `letterGroups [6,2,3,1]`.

**Masking:** a 3-word, a 4-word, a 5-word and a 7-word chunk must all reach the top rung (the deadlock fix)
· a 4-word line must never get easier from L4 to L5 in `lineEnds` · `hideLines` at L1 must be a subset of
L2 · 20 lines of naturalistic dialogue must have `maskedCount > 0` at every rung ≥1 for **every** percent
method (the `keyWords` guard) · a 40-of-500-word role must produce a stable `maskedCount` · a chunk with
zero maskable tokens must not throw · a document where every line is a speaker label.

**Structure:** an ALLCAPS poem-title collection must produce **zero** speakers · `MOTHER!` on its own line
must not become a speaker · `ACT ONE`, `SCENE 2`, `PROLOGUE`, `THE END`, `CHORUS`, `VERSE 2` must never
become speakers · `Note: remember to breathe` must not create a `Note` speaker · a monologue must not
invent a role · `MARY (CONT'D)` must merge into `MARY` · `JIM`/`TIM` must never auto-merge.

**Cleanup:** an RTF-style `\-` soft hyphen at a line end must produce **one** joined word in the token
stream (the rule-ordering fix) · a LaTeX-hyphenated justified PDF · a hard-wrapped 72-column speech must
unwrap · a lyric sheet must **not** unwrap.

**PDF (unit-testable without pdf.js, on synthetic item arrays):** a tracked ALLCAPS title must yield one
token per word, not one per letter · a rotated watermark run must not become a line · a page-number line
must be dropped and `MARY (CONT'D)` must not be · y-clustering with slightly sloped baselines.

**Storage:** a `Uint8Array` round-trip through structured clone (which `fake-indexeddb` alone will not
catch — hence the Playwright reload spec) · a 3 MB blob round-trip and playback · two tabs writing reps
concurrently.

### 14.3 Playwright — three specs, capped, forever

1. `boot-offline.spec.ts` — load, wait for SW `activated`, `setOffline(true)`, reload, assert the library
   renders. If this breaks, the app is not a PWA and nobody finds out until a user is on the Tube.
2. `import-practice-reload.spec.ts` — paste → set stage 3 → reload → assert the *same* words are still
   hidden. Exercises the real IDB round-trip, serialisation and cursor restore in a real engine.
3. `longpress-reveal.spec.ts` — WebKit project with `hasTouch: true`: long-press a masked word and assert
   it reveals; press-and-drag and assert it does **not** (scroll beats peek).

Chromium + WebKit projects only (WebKit is an imperfect proxy for iPhone, but it catches the gross
failures). No Firefox. **Do not grow this into a feature-coverage suite** — every added spec is a
maintenance liability paid in flakes. The no-reflow test and the CSP assertion attach to spec 2.

### 14.4 Fixtures — five, not fifteen

`shakespeare-hamlet.txt` (`HAMLET.`-style cues, verse, italic directions) · `stageplay-name-colon.txt`
(`NAME:` cues, bracketed directions) · `lyrics-genius-paste.txt` (`[Verse 1: X]`, `Embed`, "You might also
like") · `real-script.pdf` (one real PDF from Ben's own inbox) · `pathological-paste.txt` (mixed tabs, 40
blank lines, Windows-1252 smart quotes, a BOM) · plus `backup-v1.json`. **Add a fixture the day a real
import breaks**, not before. The design docs' fifteen-entry corpus requires sourcing a Final Draft export,
a scanned play, a broken-`/ToUnicode` PDF, a two-column hymnal, a Celtx RTF and a `w:smallCaps` DOCX —
days of non-code work for parsers we are not shipping.

### 14.5 Performance

`bench/` with `vitest bench` for `tokenize` and `computeMaskPlan` on a 10,000-word fixture, run manually
and after any change to `core/mask` or `core/text` — **not a CI gate**, because runner variance makes perf
assertions flaky and everyone learns to ignore them. Budgets, verified by a documented Chrome DevTools
checklist before each release: first install ≤250 kB gz; cold TTI on 4G ≤2.0 s; warm start ≤400 ms;
tokenize 10k words ≤150 ms (once, at import); open a 10k-word text ≤200 ms to first paint; **plan build
≤8 ms, plan apply ≤16 ms**; peek ≤8 ms; sustained 60 fps autoscroll; INP ≤100 ms p75.

### 14.6 Named acceptance criteria that are easy to forget

- Restore a `.json` backup **on an iPhone** (the picker-UTI trap, §7.2).
- A focused `<input>` is visible above the iOS keyboard in `typeItBack`.
- Print a 2,000-word document and get **all** pages.
- Feeding a text's own words back as `typeItBack` answers scores 100% with zero flags.
- Two tabs on the same document: the second offers "take over", and `Σ mastery.reps === count(reps)` after.
- Focus/Teleprompter-equivalent (Focus mode) in an installed PWA on current iOS.
- An installed PWA plays back a 3 MB recording with lock-screen controls (M3 gate).

---

## 15. Risks and open questions, ranked

| # | Risk | Impact | Mitigation / the experiment that settles it |
|---|---|---|---|
| 1 | **The reader does not feel good on a real phone.** The whole product is one screen, and long-press-peek vs the iOS magnifier, jitter at 22 px, and "does Ben like reading it" are all invisible on desktop | Fatal — everything else is built on it | **M-1, half a day, before any code.** Two renderers side by side on Ben's iPhone in Safari and installed, with a live rect logger. Also settles risks 2 and 4 |
| 2 | **The screen-reader pattern for masked text is genuinely unverified.** Line-level `aria-label` + focusable token buttons is the right *design*, but no AT honours it identically | Cannot be fixed later; it is the one accessibility story that has no workaround | **UNVERIFIED-2.** Two minutes in M-1, then the full gate in M4-19 across VoiceOver iOS/macOS, NVDA+Chrome, TalkBack |
| 3 | **Safari evicts a non-installed user's library after ~7 days** of no interaction | Severe — total data loss, and the user correctly concludes the app is broken | Push installation *as a data-integrity feature*; `persist()` on all platforms (it **is** honoured on Safari 17+ and granted heuristically for home-screen apps); the backup nudge with teeth; the localStorage tripwire that detects the wipe and explains it; ship samples so a wiped app is not an empty void. This is mitigation, not prevention, and the UI says so |
| 4 | **iOS 26 audio in installed PWAs is reportedly broken** — and our own plan pushes users to install | Kills M3's headline feature | **UNVERIFIED-6.** The M3-01 device spike gates tasks 3–7; the audio watchdog degrades honestly; `<source>` children instead of `src="blob:"`; the two-player architecture is not built until the spike passes |
| 5 | **Scope.** 31.5 dev-days against "a few focused sessions" | Nothing ships | §3.2's kill list lives in `CLAUDE.md`, not just here. M1 is a decision point: use it for one real job before starting M2 |
| 6 | **PDF text extraction is garbage for scanned, columned or CID-keyed PDFs** | Low, because it is inherent and visible | The preview is **always editable**; the "paste instead" escape hatch stays prominent forever; scanned detection hands off to Live Text / Lens; CJK PDFs are a stated non-goal in the error copy |
| 7 | **FSRS-lite parameters are borrowed, not fitted**, and our stakes-scaling changes their meaning; with one user and one script there is no way to fit them | Intervals somewhat wrong; unfalsifiable numbers | Use FSRS-5's **published** weights verbatim and name every deviation; `R* = 0.92` (higher than Anki's 0.90) errs toward more practice; expected stumbles is a **range** until calibrated; every number is tap-to-explain; and `reps` + `recomputeAll()` mean a better model later is a migration, not a rewrite |
| 8 | **Wake lock in an installed iOS PWA below 18.4 resolves and does nothing** | Medium — the screen sleeps mid-recitation | **UNVERIFIED-1.** Probed in M-1 on Ben's device; treat "granted but slept anyway" as a possible outcome and keep the honest degradation copy. The video hack stays unshipped |
| 9 | **`content-visibility: auto` interactions**: find-in-page in Safari, accessibility-tree exposure of skipped subtrees, and `scrollHeight` instability | Medium — a11y and autoscroll | **UNVERIFIED-3.** Only applied above 2,000 tokens; autoscroll velocity is block-measured, never `scrollHeight`; re-anchoring is by line index; verify SR navigation into a skipped block during the M4 AT pass. Documented escape hatch: block windowing |
| 10 | **VAD may return empty audio in iOS standalone** | Low — it degrades to tap | **UNVERIFIED-5.** Runtime probe: assert RMS exceeds the noise floor within 3 s, else fall back to Tier 0 with the mode badge changing |
| 11 | **A 3 MB blob may not round-trip through IndexedDB on WebKit** | Medium for M3 | **UNVERIFIED-7.** Task M3-03 probes it; fall back to storing `ArrayBuffer` and constructing the `Blob` on read |
| 12 | **The chunk key survives ordinary edits but not everything** | Medium — silent loss of weeks of work | Exact-pass re-anchoring plus `rankWithinIdenticalGroup` in v1; the banner is non-modal and always says how many chunks changed; fuzzy re-anchoring is the first LATER item, with its metric and threshold already specified |
| 13 | **`typeItBack` may be too slow on a phone**, leaving the demand ceiling effectively unreachable for phone-only users | Medium — the honesty mechanism has no remedy | The ceiling explains itself with the remedy attached; `recallAccuracy` (not `typedAccuracy`) grades; if it proves unusable, `wordBank` is the specified replacement (tap chips instead of typing, objective verification at recall speed) |
| 14 | **Cloudflare steers new projects to Workers static assets rather than Pages** | Low | The output is a static `dist/`; Workers static assets serves the same folder with the same headers file, so the migration is a `wrangler` config change. Noted in ADR-0002; "no bandwidth cap" is softened to "no published cap" |
| 15 | **React was the wrong framework** | Low | `src/core/**` is framework-free by lint rule *and* by test; a Svelte port rewrites ~2,500 lines of view code and reuses ~3,000 lines of engine and tests. ADR-0001 records the reversal path |

### 15.1 UNVERIFIED register

| id | Claim | The check that settles it |
|---|---|---|
| U-1 | Screen Wake Lock works in an **installed** iOS PWA on iOS ≥18.4 and silently fails below it | M-1: call `request('screen')` in Safari and in the installed app on Ben's device; watch whether the screen sleeps |
| U-2 | VoiceOver / NVDA / TalkBack read a line with three blanks usefully under the §9.8 pattern | M-1 (2 min) then M4-19 (full gate) on four real ATs |
| U-3 | `content-visibility: auto` skipped subtrees are reachable by SR navigation and by focus in Safari and Chromium; and find-in-page in Safari does not reveal them | M4 AT pass + a manual `⌘F` check on a 10k-word document in both engines |
| U-4 | Fullscreen in an installed PWA on current iOS does not show the reported iOS 26.1 top bar | M2: enter Focus mode in the installed app on Ben's device |
| U-5 | `getUserMedia` delivers non-silent audio in an installed iOS PWA | M3-05 runtime probe: RMS > floor within 3 s |
| U-6 | `<audio>` playback of an IndexedDB blob works, and MediaSession appears, in an installed iOS 26 PWA | M3-01 device spike; gates M3 tasks 3–7 |
| U-7 | A 3 MB `Blob` round-trips through IndexedDB and plays on WebKit | M3-03 probe; `ArrayBuffer` fallback |
| U-8 | pdf.js 6.x worker size and its Vite resolution path | M0-12 spike + `npm run analyze`; write the real number into `CLAUDE.md` |
| U-9 | The iOS document picker accepts a `.json` backup with our `accept` list | M2-15 acceptance test on a real iPhone |
| U-10 | `visibility: hidden` inner text is excluded from selection, find-in-page and the a11y tree in **all** target engines | M-1 (Safari/iOS) + the M4 AT pass + a `⌘F` check in Chromium and Firefox |
| U-11 | 10,000 `.tok` spans build within the 200 ms budget on a mid-range Android | M1-14 profile — a gate that may change the rendering contract |
| U-12 | Expected-stumbles calibration converges usefully from one user's `runSplits` | M4-10; until then the number is a range or "not yet measurable" |

### 15.2 Open questions for Ben

1. **Name** — confirm Offbook after the trademark/domain check, or fall back to Byheart. Blocks M0-02.
2. **Stepped vs smooth autoscroll default** — this plan says smooth; if Ben's own rehearsal habit is verse,
   stepped is the better default and it is a one-line change.
3. **Does M3 or M4 come first?** This plan orders voice before the progress model on the grounds that
   mute-my-lines is a bigger felt win than a readiness number. If Ben's own use is deadline-driven, swap
   them — they are independent.
4. **Confidential mode default** — off with a prominent first-run offer (as specified), or on by default
   for documents imported from a PDF (which are disproportionately likely to be under embargo)?

---

## 16. Legal and ethical note

We are copying a product category and a set of functional ideas — progressive masking of text to drive
active recall — which is legitimate: functional concepts, workflows and features are not protected by
copyright. What we do not do is use the name "MemoCoach", "Memorize Lines" or "Memorize Script" or any
confusingly similar mark; copy their icon, palette or logo; reuse their screenshots, App Store text,
feature bullets or taglines; copy their distinctive UI strings or method names; or name them anywhere in
the product, marketing, meta tags or store listing, including "alternative to…" comparison SEO. Every
string in this plan and in the app is written by us, the method names in §8.1 are our own, and any
competitive framing stays in Ben's private notes. A Vitest test greps the tree for the competitor's name
and fails the build if it appears. Sample content is **public domain only** — Sonnet 18, the "To be or not
to be" soliloquy, an excerpt of Wilde's *The Importance of Being Earnest* (1895), and the Gettysburg
Address — with each source recorded in a comment and verified before shipping. The code ships under the
**MIT licence** in a public repository, which is also what makes the escape-hatch promise real: if this app
stops being maintained, someone else can host it. Third-party licences are generated into
`public/licences.txt` at build time from the dependency tree and rendered by the About screen rather than
hand-written. Because the app ingests users' scripts, which are frequently other people's copyrighted work,
About carries one line — *"Your texts stay on your device. Only add material you have the right to use."* —
and the local-first architecture makes that a statement of fact rather than a policy, because we never
receive the content. Finally, and specifically for the professional audience: if a script is under an NDA
or embargo, cloud voices may breach that agreement, so the voice pre-flight card says so plainly and
Confidential mode hard-disables every network path for that text.

---

## 17. Appendix: rejected critic findings, and why

Each of the four critics' findings was either applied above or is listed here with a one-line reason.
"Partially applied" entries state exactly which half was taken.

### Rejected outright

| Finding | Source | Why rejected |
|---|---|---|
| Adopt **Dexie 4** as the storage engine | completeness | ~28 kB gz breaks the written dependency budget for a query engine we would use for a handful of predicates; compound and multiEntry indexes are plain IndexedDB features. We took the *store layout*, not the library |
| Keep the design-data **17-store schema** | completeness | Nine stores, phased by DB version, cover every shipped feature. `tags`, `docRevisions`, `runs`, `plans`, `postings`, `trashOps` each cost a store, an index and a UI for a need that flat folders, an immutable `sourceText` and a snackbar already meet |
| **Nested folders (depth 3) + `pathKey` + tags** | completeness | Ben will have tens of texts. `pathKey` rewrites, three move invariants, breadcrumbs that do not fit 375 px, and a second store with a denormalised `useCount` — for navigation that one flat level solves |
| Add three **recognition-tier methods** (Word Bank, Which Comes Next, Order It) | completeness | Each needs a new interaction model *and* a non-drag accessible equivalent. The ladder's low rungs already provide the easy on-ramp. `wordBank` is recorded as the specified fallback if `typeItBack` proves too slow (risk 13) |
| **Two-way scene sharing** with partner-audio merge, and **URL-fragment sharing** | completeness | Fragment sharing invites over-sharing of embargoed material; audio merge needs the fuzzy re-anchor we deferred. `docsOnly` export plus `navigator.share({files})` covers the real need |
| **Multi-user profiles**, or a `profileId` field added speculatively | completeness | Progress is per browser; the workaround (separate browser profiles) is documented in About. Because `recomputeAll()` exists, adding `profileId` later is a migration plus a recompute, not a redesign |
| **Full i18n**: string translations and RTL *UI* mirroring | completeness | We took the cheap half — a typed string catalogue seam, `Intl.PluralRules`, CSS logical properties everywhere, and the per-script `LanguageProfile` table. Translations and mirrored chrome are LATER, triggered by a real non-English user |
| **Stanza numbering, rhyme-scheme display, metronome** | completeness | Not why anyone opens the app. Verse `indentEm` (the part that is a genuine memory cue) is in M2 |
| Switch the reader to a **virtualisation library** above 30k words | completeness | We state a hard 30,000-token ceiling and split the document at a heading instead. The library remains a documented escape hatch, not built |
| **Opt-in telemetry endpoint** ("help improve the app") | completeness | Needs a server, which breaks the £0 constraint outright. Local diagnostics with a copyable redacted bundle is applied instead |
| **Cut FSRS-lite, the confidence ceiling and the deadline planner entirely** | scope | The demand ceiling is the product's central honesty claim and the main thing that makes it better than the app we are copying. We cut the *timing* instead: reps from M1, the model surfaced in M4, activation is an `algoVersion` recompute. The critic's real complaint — that it is unfalsifiable — is answered by tap-to-explain, ranged estimates and calibration against observed runs |
| **Remove chunking entirely; make the line the unit of progress** | scope | `chunkKey` is ~20 lines and the exact-pass re-anchor is another ~30. Removing it and later reintroducing it would be a data migration on users' phones. We cut the *machinery* (fuzzy matching, orphan retention, carry-over penalties), not the identity |
| **Cut ASR permanently** | scope | Cut from v1 with a named one-day gate for revisiting, and the three preconditions written down so it cannot ship unsafely. Deleting the option costs nothing but forecloses it |
| Adopt the **16-mode catalogue** as canonical | algo | 13 ids over five kernels, frozen. Blur/Word Shapes/Facts & Figures/Shuffle check are cut with reasons; Skeleton, Openers, Sentence Tail and From Memory are rungs or params, not methods |
| **`role="text"`** on masked tokens | modes doc | Non-standard, WebKit-only, ignored by Chrome/TalkBack and useless on NVDA |
| **Two-finger hold as the primary panic gesture** | UX doc | Collides with VoiceOver's two-finger gestures and Safari's pinch, `touchstart` is passive by default, and the system gesture often wins — so the panic button would be unreliable exactly when panic is likely. Long-press the Stage chip is the documented always-available path; two-finger gestures ship default-off |
| Canvas **`measureText`** for blank widths | UX doc | It ignores `letter-spacing`, `word-spacing`, `font-feature-settings` and synthetic bold, and rounds differently from layout — so blanks land 1–3 px off and words nudge on reveal, precisely for the low-vision users who enabled the spacing pack. `visibility: hidden` gives the exact advance width for free |
| **`color: transparent`** masking + the `HideRanks`/55-selector class swap | arch doc | Leaks to selection, find-in-page and screen readers (the doc admits it), and a single monotone rank cannot express per-token styles, stepped state or the window lens |
| **Streaming JSON parser** for large backups | data doc | No such thing exists in the platform. We bound the problem (compact reps, refuse above a tested ceiling, per-document export) |
| **`schedule.notifications`** setting | data doc | Would ship as a lie: there is no free way to notify a user who is not in the app. `.ics` export, the install nudge and `setAppBadge()` replace it |
| **Teleprompter mode, mirror flips, brightness overlay, command palette, five fonts, reading ruler, line numbers** | scope | ~4 dev-days of reader surface nothing in the goal statement asks for; masking at 44 px+ with the size slider already delivers most of the teleprompter value |
| **`docRevisions` + the 200-op edit stack** | scope | Three undo systems for one screen. `sourceText` is immutable forever, which covers the only unrecoverable case |
| **`postings` inverted index** | scope | The 20-line brute-force fallback answers every query under 50 ms at this library size, and the design doc says so itself |
| **Local Whisper and `tesseract.js`** | scope | Multi-megabyte third-party downloads that break the CSP and the privacy pitch, to do a job Live Text and Lens already do better on the user's own phone |
| **AI formatting assist + Fountain parser/serialiser** | scope | The assist fixes structure that "apply to all lines like this" already fixes; remove it and the Fountain parser loses its stated justification. The LCS verification design is kept in the docs as the precondition for ever shipping an AI path |
| PDF **column detection, evidence-based de-hyphenation, watermark detection, dual dialogue, gibberish classifier**; **two-pass structure detection with Viterbi** | scope | 3–5 dev-days whose purpose is avoiding a slightly wrong import — which the always-editable preview already solves. Each is LATER with a concrete trigger |
| Keep **`share_target`/`file_handlers`** in the manifest from the start | arch doc | A manifest entry advertising an endpoint the service worker cannot handle is a broken Android feature from day one, and it pre-commits us to the `injectManifest` switch while everything else is unstable |
| Keep **`sourceBlob`** (up to 8 MB per document) | text doc | Twenty PDFs would be up to 160 MB, changing the quota, backup and eviction stories. `pipelineVersion` re-derivation from `sourceText` is enough; a parser fix means re-importing the file |
| **Fifteen-entry fixture corpus** and per-mode golden files | scope | Sourcing a Final Draft export, a scanned play, a broken-`/ToUnicode` PDF, a hymnal, a Celtx RTF and a `w:smallCaps` DOCX is days of non-code work for parsers we are not shipping. Five fixtures plus the conformance suite covers the dangerous cases |
| The **ladder simulation** test with synthetic users | scope | It tests a ladder this plan replaced (no auto-demote, different thresholds). The conformance suite plus the short-scope reachability cases cover what matters |
| **`.mcz` zip archive** in v1 | scope | LATER, once recordings exist and are worth exporting. Per-document export is the v1 escape hatch |

### Partially applied

| Finding | What we took | What we left |
|---|---|---|
| **Annotation layer** (completeness) | An `annotations` store with four kinds (`alwaysShow`, `weak`, `note`, `bookmark`), anchored by `LineFingerprint`, `alwaysShow` wired into the `Protect` filter, included in backup | Emoji memory cues, colour highlights, and a full anchoring pipeline through fuzzy re-anchoring |
| **Eyes-free / hands-free mode** (completeness) | Mute-my-lines with loop, cue tails, ducking, MediaSession line navigation, and the lock-screen loop | A four-rung "audio ladder" as a distinct mode with its own screen, and a new `RepMode`. Listening logs nothing; grading afterwards logs `recordReview` |
| **Print & PDF** (completeness) | The print stylesheet with the `content-visibility` and border fixes, `/t/:id/print`, four presets, the all-pages check | Generated PDFs (browser print-to-PDF only) |
| **Table of contents / split by scene** (completeness) | The Contents sheet with per-section readiness | Split-document as an operation (LATER) |
| **App-wide undo model** (completeness) | One ordering rule and three classes: cleanup toggles are declarative and need no undo; manual edits are one override plus reset; data ops get a snackbar inverse and a 30-day `deletedAt` trash; reader actions (stage, reshuffle, auto-advance, role change) are undoable via toast and peeks are not, because they are the measurement | A persistent replayable `trashOps` log with compound inverses |
| **Bluetooth page-turners** (completeness) | One line in About: arrows, PgDn/PgUp and Space are already bound, so pedals and presenter remotes work | Watch app, second screen, AirPlay — explicit non-goals |
| **ASR scorer corrections** (algo) | All three written into §10.4 as preconditions: spoken-form alignment, both metaphone keys with a gated escape hatch, anchored banding | The scorer itself |
| **Repeated-stanza handling** (completeness) | Per-ordinal `chunkKey` as the storage truth, and the "chorus repeats 3×" information | The `repeatOf` linkage with a reduced stakes multiplier (LATER) |
| **Diagnostics** (completeness) | A local ring buffer plus a redacted copyable/shareable bundle | Any network transmission |
