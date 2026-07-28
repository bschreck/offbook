# MemoCoach-Web — Data Model, Progress Tracking & Learning Schedule

**Scope of this document:** persistence layer, library organisation, the progress/mastery model, the
spaced-repetition + performance-date scheduler, session generation, statistics, and backup/restore.

**Out of scope (other docs):** the masking/method catalogue itself (10+ techniques), the reader/practice
UI, PDF/RTF/HTML import parsing, ASR plumbing, TTS scene partner. Where those touch the data model I
define the *interface* only and mark it `→ methods doc` / `→ import doc` / `→ UI doc`.

Design constraints assumed throughout: local-first, no account, IndexedDB, offline PWA, mobile-first,
zero running cost, no limits, single developer.

---

## 0. Decisions at a glance

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Storage engine | IndexedDB via **Dexie 4** (fallback plan: `idb` + hand-rolled queries) | compound indexes, `liveQuery` for reactive UI, migration framework; ~28 KB gz |
| D2 | Source of truth for progress | **Append-only `reps` event log**; `mastery` is a materialized view | lets us change the scheduling algorithm and *recompute all history*; makes sync trivial (append-only merges) |
| D3 | Chunk identity | **Content-hash `chunkKey`** + duplicate ordinal, with fuzzy re-anchoring on edit | mastery must survive typo fixes, director's cuts, re-imports. Index-based ids would destroy weeks of work on one edit |
| D4 | Tokens / chunk layout | **Derived, recomputed** on load; cached in `derived` store keyed by `textHash` | tokenising 5k words is <10 ms; storing it doubles size and creates a second truth |
| D5 | Document revisions | **Yes**, capped ring buffer of gzipped full-text snapshots (20 / doc, 2 MB / doc) | scripts get cut and re-cut; "restore what the director deleted" is a real need. Diffs rejected: complexity ≫ benefit at 30 KB/snapshot |
| D6 | Big text | Separate `docText` store from `documents` metadata | library list must not deserialise megabytes |
| D7 | Folders | **Nested, hard depth limit 3** (root + 2), `parentId` + materialized `pathKey` | real structures are `Year / Show / Act`; deeper is unnavigable on a phone and tags cover the rest |
| D8 | Search | Persistent **inverted index** (`postings` store, prefix-range queries) → candidate docs → exact re-scan for snippets | no positions stored (size), no external lib, prefix search free via `IDBKeyRange.bound` |
| D9 | Scheduler | **FSRS-lite**: FSRS-5 power-law forgetting curve + stability/difficulty state, *fixed* global params, no optimiser; plus a **deadline objective** that replaces the due-queue with a marginal-gain optimiser | SM-2's 1-day floor is useless when the show is Friday; full FSRS-5 needs an optimiser and 21 params we can't fit |
| D10 | Rep weighting | Every rep carries **stakes `s` ∈ (0,1]** = retrieval demand × verification trust. Stability gains and lapse penalties scale by `s` | re-reading must not be able to move the number. A masked ASR-verified recitation is worth ~12× a full-text read |
| D11 | Confidence 0–100 | `conf = 100 · R(t) · C` where `C` is a **decayed demand ceiling** | caps a never-tested chunk at ~35 no matter how many times you read it. This is the single most important honesty mechanism in the app |
| D12 | Doc headline metric | **"Expected stumbles"** + "% of words ≥80", not a mean and not `Π R_i` | a mean hides one catastrophic hole; the product is mathematically honest but reads as 0.6% and demoralises |
| D13 | Trash | Soft delete (`deletedAt`) + `trashOps` compound-undo log, 30-day TTL | folder deletes touch N docs; undo must be one tap |
| D14 | Backup | Versioned single-file JSON (`.json`) + optional zip (`.mcz`) with audio and plain-text copies | Safari can evict local storage; the backup nudge is a **safety requirement**, not a feature |

---

## 1. Storage substrate

### 1.1 Engine

```
Dexie 4 (IndexedDB wrapper)
  + dexie liveQuery → reactive library/heat-map views
  + Dexie.Observable not needed (no cross-tab sync beyond BroadcastChannel)
```

Rationale: we need compound keys (`[docId+chunkKey]`, `[docId+at]`, `[term+docId]`), multiEntry indexes
(tags), range scans, and versioned migrations. Raw IndexedDB gives all of it but the cursor boilerplate for
~17 stores is a multi-session tax on a one-dev project. If bundle size becomes sacred, `idb` (1.5 KB) plus a
50-line query helper is the fallback; the schema below is written in plain IDB terms so either works.

Hard rules:
- **One `readwrite` transaction per logical action.** A rep write touches `reps` + `mastery` + `sessions`
  + `documents.lastPracticedAt` — all four in one transaction, or mastery drifts from the log.
- **All ids are UUIDv7** (time-ordered, 36 chars). Time-ordering means `reps` primary key is already
  chronological, which we exploit for cheap "last N reps" scans and for append-merge on import.
- **Every record** has `createdAt`, `updatedAt` (epoch ms) and, where deletable, `deletedAt: number | null`.
  This is the minimum needed for last-write-wins sync later; adding it retroactively is painful.
- **Writes are idempotent by id.** Importing the same backup twice is a no-op.

### 1.2 Quota, persistence, and the Safari eviction problem

```ts
await navigator.storage.persist();            // ask on first document save, not on first load
const { usage, quota } = await navigator.storage.estimate();
```

- Chrome/Edge/Android: quota ≈ 60% of free disk. Effectively unlimited for text.
- Safari (macOS + iOS): generous (~GB scale) for installed / frequently-used origins, **but
  script-writable storage for a non-installed website can be purged after ~7 days of no interaction.**

This is the single biggest risk to a local-first rehearsal app: an actor learns a script for a month, doesn't
open the site for a week between jobs, and loses everything.

Mitigations, all of which are data-model requirements:
1. Prompt "Add to Home Screen" after the second document is created (installed PWAs are treated much better).
2. Call `navigator.storage.persist()` and record the grant result in `meta`.
3. **Backup nudge:** store `meta.lastBackupAt`; if `now - lastBackupAt > 7 days` and there is unbacked-up
   practice data, show a non-dismissible-once banner offering a one-tap `.json` download. Track
   `meta.lastBackupCounts` so we can say "23 sessions since your last backup".
4. Optional: opportunistic export to the user's own cloud via `showSaveFilePicker` handle persistence
   (Chromium only) — write the backup to the same file each week without re-prompting.
5. Storage-health screen: usage vs quota, per-doc breakdown, "free space" actions (evict unpinned
   recordings first, then prune folded reps older than 180 days).

Warn at 80% of quota; refuse new recordings at 95% rather than failing mid-write.

### 1.3 Size budget

Reference document: a 5,000-word play script (~30 KB UTF-8, ~250 chunks at 20 words).

| Data | Per reference doc | Notes |
|---|---|---|
| `documents` metadata | ~1.2 KB | title, roles, tags, prefs |
| `docText` | 30 KB | raw text + `sourceMeta` |
| `derived` (chunk layout cache) | ~18 KB | offsets as flat arrays, not objects |
| `docRevisions` (20 snapshots, gzip) | ~80 KB | gzip of prose ≈ 35% |
| `mastery` (250 records × ~190 B) | ~48 KB | |
| `reps` (250 chunks × 25 reps × ~130 B) | ~800 KB | dominant text-side cost |
| `sessions` + `runs` | ~40 KB | |
| `postings` (~1,900 unique terms) | ~55 KB | |
| **Total, no audio** | **≈ 1.07 MB** | |
| One 10-min recording (opus 24 kbps mono) | ~1.8 MB | audio dominates everything |

100 documents ≈ **107 MB** without audio. Default recording cap **200 MB** with LRU eviction of unpinned
takes. Both comfortably inside Chrome quota; inside Safari's if installed. In-memory working set for one
open doc is under 2 MB if token data uses `Uint32Array` offsets rather than `{start,end}` objects.

---

## 2. Full IndexedDB schema

Dexie declaration first (canonical), then record shapes.

```ts
db.version(1).stores({
  meta:            '&key',
  settings:        '&key',
  folders:         '&id, parentId, pathKey, updatedAt, deletedAt, [parentId+sortName]',
  tags:            '&id, &nameKey, updatedAt',
  documents:       '&id, folderId, updatedAt, lastPracticedAt, sortTitle, status, deletedAt, ' +
                   'performanceAt, *tagIds, [folderId+sortTitle], [status+updatedAt]',
  docText:         '&docId, textHash',
  docRevisions:    '&id, [docId+createdAt], docId',
  derived:         '&docId, chunkerVersion',
  mastery:         '&[docId+chunkKey], docId, updatedAt, [docId+conf], [docId+dueAt], ' +
                   '[docId+orphanedAt]',
  reps:            '&id, at, sessionId, [docId+at], [docId+chunkKey+at]',
  sessions:        '&id, startedAt, [docId+startedAt], endedAt',
  runs:            '&id, [docId+startedAt], docId',
  plans:           '&docId, performanceAt',
  recordings:      '&id, [docId+createdAt], docId, pinned, sizeBytes, deletedAt',
  recordingBlobs:  '&recordingId',
  postings:        '&[term+docId], term, docId',
  trashOps:        '&id, at',
});
```

`&` = unique/primary, `*` = multiEntry, `[a+b]` = compound.

### 2.1 `meta` — schema and install metadata

Key: `key: string`. Singleton rows; never more than ~15 rows.

```ts
type MetaRow =
  | { key: 'schemaVersion';   value: number }              // IDB version actually applied
  | { key: 'installId';       value: string }              // uuid, used to tag exports
  | { key: 'createdAt';       value: number }
  | { key: 'algoVersion';     value: number }              // bump ⇒ offer full recompute from reps
  | { key: 'chunkerVersion';  value: number }              // bump ⇒ invalidate `derived`, re-anchor
  | { key: 'persistGranted';  value: boolean }
  | { key: 'lastBackupAt';    value: number }
  | { key: 'lastBackupCounts';value: { docs: number; reps: number; sessions: number } }
  | { key: 'migrationLog';    value: Array<{ from: number; to: number; at: number; ms: number }> };
```

Size: <2 KB. `algoVersion` is what makes D2 pay off: change the scheduler, bump it, and the app offers
"recompute progress from your practice history (12 s)".

### 2.2 `settings` — global preferences

Key: `key: string`. One row per setting so a single toggle write doesn't rewrite the blob (and merges
cleanly on import).

```ts
interface SettingsShape {
  'ui.theme':              'system' | 'light' | 'dark' | 'stage';   // 'stage' = dim red-on-black
  'ui.fontScale':          number;        // 0.8–2.0
  'ui.reduceMotion':       boolean;
  'practice.sessionMinutes': 5 | 12 | 20 | 35;
  'practice.defaultMethodId': string;                  // → methods doc
  'practice.autoScroll':   { enabled: boolean; wpm: number };
  'practice.hapticOnReveal': boolean;
  'asr.enabled':           boolean;
  'asr.lang':              string;        // BCP-47
  'asr.strictness':        'lenient' | 'normal' | 'strict';
  'audio.recordBitrate':   number;        // default 24000
  'audio.capBytes':        number;        // default 200e6
  'schedule.targetRetention': number;     // R*, default 0.92
  'schedule.dailyBudgetMin': Record<0|1|2|3|4|5|6, number>;  // per weekday
  'schedule.notifications': boolean;
  'stats.showStreak':      boolean;       // default true, but see §7.6
  'privacy.analytics':     false;         // hardcoded; there are none
}
```

Size: <3 KB. Per-*document* practice preferences live on the document (§2.5) because "how I rehearse
Hamlet" ≠ "how I rehearse my wedding speech".

### 2.3 `folders`

```ts
interface Folder {
  id: string;              // uuidv7
  parentId: string | null; // null = root
  name: string;
  sortName: string;        // name.toLocaleLowerCase(), for [parentId+sortName] index
  pathKey: string;         // '/<rootId>/<childId>/'  materialized ancestor path INCLUDING self
  depth: 0 | 1 | 2;        // enforced
  color?: string;          // one of ~10 preset hues; free-form colours are a support burden
  icon?: string;           // emoji
  order: number;           // manual ordering within parent (sparse: 1000, 2000, …)
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}
```

`pathKey` gives subtree queries for free:
`folders.where('pathKey').startsWith('/A/B/')` → all descendants of B, one index range scan. That is what
makes "delete folder and everything in it", "move subtree", and breadcrumb rendering O(matches) instead of
recursive walks.

**Move invariants** (enforce in one transaction):
1. `target.pathKey` must not start with `moved.pathKey` (cycle).
2. `target.depth + heightOf(movedSubtree) <= 2` (depth limit).
3. Rewrite `pathKey`/`depth` for the whole subtree by string replacement of the prefix.

**Depth limit justification.** Depth 3 total (root + 2 nested) covers every real structure I can find:
`Theatre / Hamlet / Act III`, `Work / Q3 keynote`, `Uni / PHIL201 / Seminar 4`. Beyond that: breadcrumbs stop
fitting on a 375 px screen, the "which folder am I in" problem needs a tree view nobody wants on a phone,
`pathKey` rewrites get expensive, and the *actual* need — cross-cutting grouping ("audition pieces",
"memorised", "Spanish") — is a tagging problem, not a hierarchy problem. Enforce it at the API layer with a
clear message ("folders can nest 3 deep — use a tag instead?") rather than silently allowing it.

Size: ~250 B/folder; 50 folders = 12 KB.

### 2.4 `tags`

```ts
interface Tag {
  id: string;
  name: string;        // display, as typed
  nameKey: string;     // normalised (lowercase, NFKD, trim) — unique index prevents dupes
  color?: string;
  useCount: number;    // denormalised, maintained on doc save; drives suggestion order
  createdAt: number; updatedAt: number; deletedAt: number | null;
}
```

Documents hold `tagIds: string[]` with a multiEntry index, so `documents.where('tagIds').anyOf([...])` is a
single index scan. Tags are flat, unlimited, and the primary cross-cutting axis.

Size: negligible.

### 2.5 `documents` — metadata only (no body text)

```ts
type DocKind = 'script' | 'lyrics' | 'speech' | 'poem' | 'lesson' | 'other';
type DocStatus = 'active' | 'archived';     // trash is deletedAt, not a status

interface DocumentMeta {
  id: string;
  folderId: string | null;
  title: string;
  sortTitle: string;                 // lowercased, leading article stripped ("The Tempest" → "tempest")
  kind: DocKind;
  tagIds: string[];
  status: DocStatus;

  // ---- text pointer / integrity ----
  textHash: string;                  // 64-bit FNV-1a hex of the body in docText; ties derived+revisions
  wordCount: number;                 // denormalised for lists, sorting, time estimates
  charCount: number;
  chunkCount: number;                // denormalised from derived
  lang: string | null;               // BCP-47, detected or set; drives ASR + tokenizer rules

  // ---- roles / speakers (inline: few, small, always needed with the doc) ----
  roles: Role[];
  myRoleIds: string[];               // usually 1; actors doubling need N
  roleOverrides: Record<string, string>;  // blockKey → roleId, sparse manual corrections

  // ---- practice configuration ----
  prefs: DocPractisePrefs;

  // ---- performance target ----
  performanceAt: number | null;      // epoch ms of the show/exam/pitch
  targetDurationSec: number | null;  // speakers: "must be under 10 minutes"

  // ---- denormalised progress (materialized; recomputable from mastery) ----
  progress: DocProgress;

  // ---- provenance ----
  source: { type: 'paste' | 'pdf' | 'txt' | 'rtf' | 'html' | 'import' | 'duplicate';
            filename?: string; importedAt: number; ofDocId?: string };

  lastPracticedAt: number | null;
  createdAt: number; updatedAt: number; deletedAt: number | null;
}

interface Role {
  id: string;             // stable within doc, e.g. 'r_juliet'
  label: string;          // as it appears in the script ("JULIET")
  aliases: string[];      // ["JUL.", "Juliet"] — merged variants from parsing
  color: string;
  isMine: boolean;
  lineCount: number;      // denormalised
  wordCount: number;
}

interface DocPractisePrefs {
  methodId: string;                  // → methods doc
  maskLevel: number;                 // 0..1 current default masking
  chunkTargetWords: number;          // default 20; user can set 8 (lyrics) … 60 (prose)
  chunkStrategy: 'auto' | 'line' | 'sentence' | 'speech' | 'paragraph' | 'manual';
  manualChunkBreaks?: string[];      // blockKeys where the user forced a break
  cueLinesVisible: boolean;          // actor tool: other roles' lines stay readable
  autoScrollWpm: number;
  asrEnabled: boolean;
  ttsPartner: { enabled: boolean; voiceByRoleId: Record<string, string> };
}

interface DocProgress {
  conf: number;              // 0..100 document confidence (§6.4)
  confAt: number;            // when computed (it decays; recompute lazily on read)
  pctAt80: number;           // % of WORDS in chunks with conf ≥ 80
  pctAt95: number;
  expectedStumbles: number;  // Σ(1 - p_pass_i) over chunks
  weakestChunkKeys: string[];// top 5, for the "next session" preview
  masteredWords: number;
  totalReps: number;
  totalPractiseSec: number;
  history: Array<{ d: number; conf: number; pctAt80: number }>;  // daily samples, epoch-days
}
```

`progress.history` is a small append-once-per-day array (2 numbers/day, ~30 B/day → 11 KB/year). Keeping it
inline avoids a store and a join for the one chart people actually look at. Cap at 400 entries, then
downsample to weekly.

**Why roles are inline, not a store:** a document has 1–40 roles; they are needed on every read of the
document and never queried across documents. A store would add a join to the hot path for zero benefit.

**Why `roleOverrides` is keyed by `blockKey` (content hash) not block index:** so that fixing a typo in
line 12 doesn't shift every override below it. Same principle as chunk keys (§3.2).

Size: ~1.2 KB typical, up to 4 KB for a 40-role script.

### 2.6 `docText` — the body

```ts
interface DocText {
  docId: string;             // primary key
  text: string;             // normalised plain text (NFC, \n line endings, no trailing spaces)
  textHash: string;
  format: 'plain' | 'fountain-ish';   // we keep plain text + a parse profile; no rich text
  sourceMeta?: {                       // → import doc
    pdfPages?: number;
    droppedArtifacts?: number;         // page numbers, headers stripped
    confidence?: number;               // import parser's self-assessment
  };
  updatedAt: number;
}
```

Split from `documents` (D6) because the library screen lists 200 docs and must not deserialise 6 MB of
prose. Plain text only, deliberately: rich text triples the parsing, masking and diffing complexity for
"bold stage directions". Formatting that matters (role labels, stage directions, verse breaks) is recovered
by the parser and represented as *block roles*, not as markup.

### 2.7 `docRevisions` — bounded history (D5, justified)

```ts
interface DocRevision {
  id: string;
  docId: string;
  createdAt: number;
  reason: 'manual-save' | 'import-replace' | 'bulk-edit' | 'pre-reanchor' | 'user-snapshot';
  label?: string;                    // "before director's cuts"
  gz: Blob;                          // gzip of the full text via CompressionStream
  bytes: number;
  textHash: string;
  wordCount: number;
  tokenDelta: { added: number; removed: number };   // vs previous revision, for the UI list
}
```

**Justification for keeping revisions at all.** Script text is edited *a lot* and destructively: OCR/PDF
imports need cleanup, directors cut lines mid-rehearsal, singers change a verse. Two failure modes are
otherwise unrecoverable: (a) a bad "replace text" that wipes clean text, (b) losing the *original* after
cuts you're later asked to restore. At 30 KB → ~10 KB gzipped per snapshot this costs almost nothing.

**Justification for full snapshots over diffs.** A diff chain is O(n) to reconstruct, corrupts irrecoverably
if one link is lost, needs a diff library, and saves ~90% of an already-negligible cost. Snapshots are one
line of code and always readable.

**Retention policy** (run on save, in the same transaction):
- Write a revision only if `changedTokens ≥ max(20, 1% of tokens)` **or** reason ≠ `manual-save`.
- Debounce: never more than one revision per 10 minutes for the same doc/reason.
- Keep: all revisions <24 h old; then thin to one per day for 7 days; then one per week; hard cap 20
  revisions or 2 MB per doc, evicting oldest non-labelled first. Labelled/user snapshots are never
  auto-evicted.

`CompressionStream('gzip')` is available in Chrome 80+, Safari 16.4+, Firefox 113+. Feature-detect; store
raw text with `gz: null, raw: string` on old browsers.

### 2.8 `derived` — chunk layout cache (recomputed, not authoritative)

```ts
interface Derived {
  docId: string;
  textHash: string;          // invalidation key #1
  chunkerVersion: number;    // invalidation key #2
  builtAt: number;
  buildMs: number;

  // flat arrays, index-aligned; ~10× smaller than object arrays
  blockStart: Uint32Array; blockEnd: Uint32Array;
  blockType: Uint8Array;        // 0 dialogue,1 roleLabel,2 stageDir,3 heading,4 blank,5 verse,6 prose
  blockRole: Uint16Array;       // index into roles[]; 0xFFFF = none
  blockKeys: string[];          // content hashes, for overrides

  chunkStart: Uint32Array;      // char offsets into docText.text
  chunkEnd: Uint32Array;
  chunkKeys: string[];          // content hashes (§3.2) — the join key to `mastery`
  chunkWords: Uint16Array;
  chunkBlockFrom: Uint32Array; chunkBlockTo: Uint32Array;

  tokenStart: Uint32Array;      // per maskable token (word)
  tokenEnd: Uint32Array;
  tokenChunk: Uint32Array;
  tokenFlags: Uint8Array;       // bit0 maskable, bit1 stopword, bit2 numeral, bit3 propernoun
}
```

Rule (D4): **recompute is always legal; the cache is only a speed-up.** On open, if
`derived.textHash === doc.textHash && derived.chunkerVersion === meta.chunkerVersion` use it, else rebuild
and overwrite. Rebuild cost measured target: <15 ms for 5,000 words, <120 ms for 40,000 words. Store the
cache for all docs anyway (18 KB) because it makes cold-open of a 40k-word one-person show instant, and
`Uint32Array` structured-clones fast.

Not stored, always computed on demand: masked render output, most-missed word aggregates, WPM,
document confidence at time *t*, session plans, search snippets.

### 2.9 `mastery` — per-chunk memory state (materialized view over `reps`)

Primary key `[docId, chunkKey]`.

```ts
interface Mastery {
  docId: string;
  chunkKey: string;

  // --- FSRS-lite state ---
  S: number;              // stability, days (mean time to R=0.9 — see §6.2 identity)
  D: number;              // difficulty 1..10
  lastRepAt: number;      // epoch ms
  lastGrade: 1|2|3|4;

  // --- honesty state ---
  C: number;              // demand ceiling 0.35..1.0 (§6.3)
  maxDemandPassed: number;// raw 0..1, decayed; C is derived from it
  bestVerified: 'none' | 'self' | 'recording' | 'asr' | 'type';

  // --- counters ---
  reps: number;           // total reps folded
  effReps: number;        // Σ stakes  — "how much real retrieval practice"
  lapses: number;         // failures at stakes ≥ 0.4
  streak: number;         // consecutive passes
  totalSec: number;

  // --- denormalised for indexed queries (recomputed on every fold) ---
  conf: number;           // 0..100 at lastRepAt (NOT at now; decay applied on read)
  dueAt: number;          // epoch ms when R crosses R* (maintenance mode only)
  priority: number;       // 0..1 scheduler priority snapshot, refreshed daily

  // --- re-anchoring provenance ---
  reanchoredFrom?: string;   // previous chunkKey
  reanchorSim?: number;      // 0..1 similarity at carry-over
  orphanedAt?: number | null;// set when its text vanished from the doc; purge after 30 d

  createdAt: number; updatedAt: number;
}
```

~190 B JSON. Indexes `[docId+conf]` (heat map, weakest-first) and `[docId+dueAt]` (maintenance queue) are the
two hot query paths and both are pure index range scans.

### 2.10 `reps` — the append-only evidence log (the truth)

```ts
type RepMode =
  | 'read'          // fully revealed, read aloud — exposure, not retrieval
  | 'recall'        // masked, user self-reports (tap "got it" / "missed")
  | 'type'          // masked, user types the hidden words → objectively scored
  | 'asr'           // masked, spoken, matched by speech recognition
  | 'runReview'     // graded during/after a continuous run (from a run record)
  | 'recordReview'; // self-graded against own recording playback

interface MaskSpec {              // → methods doc owns the catalogue; this is the persisted footprint
  methodId: string;               // 'hideWords' | 'hideLines' | 'firstLetters' | …
  m: number;                      // 0..1 fraction of maskable tokens hidden
  kind: 'blank' | 'firstLetter' | 'firstTwo' | 'shape' | 'lineHidden' | 'gistOnly';
  promptVisible: boolean;         // previous chunk / cue line on screen
}

interface Rep {
  id: string;              // uuidv7 → chronological primary key
  docId: string;
  chunkKey: string;
  sessionId: string | null;
  runId?: string;
  at: number;              // epoch ms
  ms: number;              // time on this chunk

  mode: RepMode;
  mask: MaskSpec;

  grade: 1 | 2 | 3 | 4;    // again / hard / good / easy
  stakes: number;          // 0..1, computed at write time and STORED (§6.1) so old reps
                           // stay interpretable if the formula changes

  // mode-specific evidence, kept for "most-missed words" and for re-grading
  score?: number;          // 0..1 objective match (type/asr)
  missedTokenIdx?: number[];   // indices WITHIN the chunk, not global — survives edits elsewhere
  revealsUsed?: number;    // long-press peeks
  asr?: { transcriptHash: string; wer: number; conf: number };  // no raw transcript by default

  // state snapshot AFTER folding this rep — makes recompute verifiable and charts cheap
  post?: { S: number; D: number; C: number; conf: number };
}
```

~130 B typical. **We never store raw ASR transcripts by default** (privacy + size); a hash plus WER plus the
missed-token indices is enough for every feature. Opt-in setting can keep transcripts for debugging.

Retention: keep all reps for 180 days. Older reps are already folded into `mastery` and into the daily
`progress.history`; offer (don't force) "compact history" which deletes reps older than 180 days and writes a
`repsCompactedBefore` marker into `meta`. Warn that compaction forfeits full recompute after an
`algoVersion` bump.

### 2.11 `sessions` — the practice-session envelope

```ts
interface Session {
  id: string;
  docId: string;
  startedAt: number;
  endedAt: number | null;      // null ⇒ crashed/abandoned; treat as ended at lastRep+30 s
  plannedSec: number;
  activeSec: number;           // excludes >30 s idle gaps
  phase: 'acquisition' | 'consolidation' | 'polish' | 'maintenance' | 'freeform';
  planId?: string;             // the plans record it was generated from
  blocks: SessionBlock[];      // the generated plan, kept for post-hoc analysis
  summary: {
    repCount: number; effReps: number;
    passRate: number;          // at stakes ≥ 0.4 only
    chunksTouched: number; newChunks: number;
    confBefore: number; confAfter: number;
    stumbleWords: number;
  } | null;
  device: 'phone' | 'tablet' | 'desktop';
  createdAt: number; updatedAt: number;
}

interface SessionBlock {
  kind: 'warmup' | 'recall' | 'verified' | 'new' | 'cooldown' | 'timing';
  targetSec: number;
  items: Array<{ chunkKey: string; mode: RepMode; mask: MaskSpec }>;
}
```

### 2.12 `runs` — continuous full/partial runs with timing

Separate from `sessions` because a run is the unit speakers and directors care about, has its own timing
splits, may happen outside a session ("just do a run"), and is what `targetDurationSec` is measured against.

```ts
interface Run {
  id: string;
  docId: string;
  sessionId: string | null;
  startedAt: number;
  durationSec: number;
  scope: { kind: 'whole' | 'range'; fromChunk?: string; toChunk?: string; roleIds?: string[] };
  maskLevel: number;
  wordsSpoken: number;         // words in scope for my role(s)
  wpm: number;                 // wordsSpoken / (durationSec/60)
  splits: Array<{ chunkKey: string; sec: number; stumble: boolean; prompted: boolean }>;
  stumbles: number; prompts: number;
  recordingId?: string;
  targetDeltaSec: number | null;  // durationSec - targetDurationSec
  createdAt: number;
}
```

`splits` is the data behind the two best speaker features: "which section drags" and "am I under 10 minutes".
~40 B/split; a 250-chunk run = 10 KB. Cap stored runs at 100/doc (LRU), keep aggregates forever in
`progress.history`.

### 2.13 `plans` — performance-date plan inputs (one active per doc)

```ts
interface Plan {
  docId: string;                 // primary key: one active plan per document
  performanceAt: number;         // epoch ms, includes time of day (curtain up)
  createdAt: number; updatedAt: number;

  // inputs (authoritative — the plan itself is derived and recomputed daily)
  targetRetention: number;       // R*, default 0.92
  dailyBudgetMin: Record<0|1|2|3|4|5|6, number>;   // weekday → minutes
  blackoutDates: number[];       // epoch-days with 0 budget
  scopePriority: Array<{ fromChunk: string; toChunk: string; weight: number }>;  // "Act 1 first"
  mustNailChunkKeys: string[];   // weight ×2
  materialCutoffDay?: number;    // epoch-day after which no new chunks (default: 55% of the way)

  // cache (regenerated; safe to delete)
  cache?: {
    generatedAt: number;
    feasibility: { verdict: 'comfortable' | 'tight' | 'not-feasible';
                   requiredMinPerDay: number; availableMinPerDay: number;
                   projectedConfAtShow: number; projectedStumbles: number };
    today: SessionBlock[];
    forecast: Array<{ d: number; plannedMin: number; projConf: number; projPctAt80: number }>;
  };
}
```

### 2.14 `recordings` + `recordingBlobs`

Metadata and payload are split so listing 200 takes doesn't pull 400 MB through structured clone.

```ts
interface Recording {
  id: string;
  docId: string;
  runId?: string; sessionId?: string;
  createdAt: number;
  durationSec: number;
  mimeType: string;         // 'audio/webm;codecs=opus' | 'audio/mp4' (iOS Safari) — MUST be stored
  sizeBytes: number;
  bitrate: number;
  label?: string;
  pinned: boolean;          // exempt from LRU eviction
  scope: Run['scope'];
  markers: Array<{ sec: number; chunkKey?: string; kind: 'stumble' | 'note'; text?: string }>;
  deletedAt: number | null;
}

interface RecordingBlob { recordingId: string; blob: Blob; }
```

Eviction: when `Σ sizeBytes > audio.capBytes`, delete unpinned oldest until under 80% of cap; show what was
removed. Deleting a `Recording` (soft) does not free space — the blob is purged when the trash TTL expires or
on explicit "empty trash", and that's the one place we hard-delete (with a clear confirm; per policy,
irreversible deletes are user-initiated).

### 2.15 `postings` — the search index

```ts
interface Posting {
  term: string;      // normalised token, ≥2 chars
  docId: string;
  tf: number;        // term frequency in the doc body
  inTitle: 0 | 1;    // boosts ranking
}
```

Primary key `[term, docId]`, plus indexes on `term` (prefix + equality) and `docId` (for rebuild/delete).
No positions stored — see §5.3.

### 2.16 `trashOps` — compound undo

```ts
interface TrashOp {
  id: string;
  at: number;
  kind: 'delete' | 'archive' | 'move' | 'bulkTag' | 'replaceText' | 'reanchor';
  label: string;                  // "Deleted “Act 3” and 12 texts"
  // inverse operation, replayable
  inverse: Array<
    | { store: 'documents'|'folders'|'recordings'; id: string; patch: Record<string, unknown> }
    | { store: 'docText'; docId: string; restoreRevisionId: string }
    | { store: 'mastery'; key: [string,string]; patch: Record<string, unknown> }>;
  expiresAt: number;              // at + 30 days
}
```

Snackbar undo reads the newest `trashOp`; the Trash screen lists them as human-readable events, which is far
better UX than a flat list of orphaned items ("Deleted Act 3 and 12 texts — Undo" vs 13 rows).

---

## 3. Text → blocks → chunks → tokens

### 3.1 The pipeline

```
docText.text
  → normalise (NFC, \r\n→\n, collapse 3+ blank lines, strip page-number artefacts)
  → BLOCKS      (line/paragraph/speech; typed: roleLabel, dialogue, stageDir, heading, verse, prose)
  → ROLE ATTRIBUTION (JULIET: … ; JULIET\n… ; indented-name conventions; + roleOverrides)
  → CHUNKS      (mastery units, target ~20 words, never crossing a role change)
  → TOKENS      (maskable words with flags)
```

Chunking rules (`chunkStrategy: 'auto'`):
- Never merge blocks from different roles → in a script, a chunk is always one speaker.
- A speech ≤ `chunkTargetWords × 1.6` is one chunk.
- Longer speeches split at sentence boundaries, greedily filling to `chunkTargetWords`, with a minimum of 6
  words (no orphan fragments — merge a short tail backwards).
- `kind === 'lyrics' | 'poem'` → one chunk per line by default (`chunkTargetWords` 8), because the line *is*
  the memory unit and rhyme/meter make lines self-cueing.
- Blank lines and stage directions are never chunks (not memorised), but are rendered.
- `manualChunkBreaks` always win.

Why ~20 words: it's ≈8 seconds of speech, near the limit of what fits in one rehearsal attempt without
sub-chunking, and gives 250 units for a 5,000-word script — enough resolution for a useful heat map without
5,000 mastery records. Expose the slider; don't hide it.

### 3.2 Chunk identity (D3) — the most important design decision here

```ts
function normalizeForKey(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '')      // strip diacritics
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s']/gu, ' ')             // drop punctuation, keep apostrophes
          .replace(/\s+/g, ' ').trim();
}
// 64-bit FNV-1a over the normalised text, plus token count as a cheap discriminator
chunkKey = `${fnv1a64hex(normalizeForKey(text))}.${tokenCount}#${duplicateOrdinal}`
```

- Punctuation- and case-insensitive, so "correcting the comma" doesn't reset a chunk.
- `#duplicateOrdinal` disambiguates repeated text (choruses, "Yes." repeated 40 times) by order of
  appearance. Repeated lines genuinely *are* different memory items (each has a different cue).
- Collision risk at 250–5,000 chunks with 64 bits: <1e-13. Synchronous hashing (no `crypto.subtle`
  promise) keeps the chunker a pure function, which matters for testability.

**Re-anchoring on edit** (`reanchorMastery(docId, oldLayout, newLayout)`), one transaction:

1. **Exact pass.** Same `chunkKey` → carry `mastery` unchanged. (Handles insertions, deletions, reordering,
   and edits *elsewhere* in the document — typically 95%+ of chunks.)
2. **Fuzzy pass.** For unmatched new chunks, compare against unmatched old chunks within a ±5 positional
   window using 3-gram token shingles: `sim = |A∩B| / |A∪B|`. Greedy highest-similarity-first, threshold
   **0.55**.
3. **Carry-over penalty** on fuzzy match: `S ← S × (0.4 + 0.6·sim)`, `C ← C × 0.85`, `conf` recomputed,
   `reanchoredFrom`/`reanchorSim` recorded. Rationale: a changed line is genuinely partly unlearned, and the
   *changed* words are exactly the ones that will trip you up on stage. Optionally bias the next session's
   masking toward the changed tokens (`missedTokenIdx` seeded from the diff) — this is a feature ("the
   director cut 4 words; here's what to re-learn").
4. **Orphans.** Old chunks with no match get `orphanedAt = now` and are *kept* for 30 days. This is the
   safety net for the catastrophic case (paste over the wrong document); a "restore progress" banner appears
   if >20% of chunks orphaned in one edit, and a `pre-reanchor` revision is always written first.
5. `reps` are never rewritten. They keep the old `chunkKey`; the fold walks `reanchoredFrom` chains (max
   depth 8) when recomputing. Append-only means history is never a lie.

---

## 4. What is stored vs recomputed

| Data | Stored? | Why |
|---|---|---|
| Blocks, chunks, tokens, offsets | Cached in `derived`, invalidated by `textHash`+`chunkerVersion` | pure function of text; cache is a speed-up only |
| Masked render for a given mask spec | No | pure, ~1 ms, depends on RNG seed which we store on the rep |
| `mastery` state | Yes (materialized) | needed for indexed queries; recomputable from `reps` |
| `conf` at *now* | No (stored at `lastRepAt`; decay applied on read) | it changes every second; storing "current" would need a cron |
| `dueAt` | Yes | must be indexable for the maintenance queue |
| Document confidence / % at 80 / expected stumbles | Cached in `documents.progress`, recomputed on session end + lazily if stale >6 h | list screens need it without loading 250 mastery rows |
| Daily `progress.history` sample | Yes, once/day | the chart must survive rep compaction |
| Most-missed words | No — aggregate from `reps` on demand (scan 5,000 reps ≈ 8 ms), memoised in memory | avoids a whole store and a maintenance path |
| WPM, run splits | Stored per `run` (measurements, not derivations) | can't be recomputed |
| Session plan | Cached in `plans.cache.today`, regenerated on open | depends on `now` |
| Search postings | Yes, incrementally maintained | rebuild-on-boot doesn't scale past ~50 docs |
| Word/char/chunk counts | Yes, denormalised on documents | list sorting and time estimates |

**Golden rule:** anything derivable from `reps` + `docText` must be regenerable by a single
`recomputeAll()` function that the Storage-health screen exposes. Write that function on day one; it is the
migration strategy for every future algorithm change.

---

## 5. Library organisation

### 5.1 Folders

Nested, depth 3, as specified in §2.3. Additional behaviours:

- **Root pseudo-folders** (computed, not stored): *All texts*, *Recent*, *Practising now* (has a plan with
  `performanceAt` in the future), *Needs attention* (`pctAt80 < 60` and `performanceAt` within 14 days),
  *Archived*, *Trash*.
- Documents with `folderId: null` live in *Unfiled* (shown at root, not a real folder).
- Deleting a folder soft-deletes the subtree and its documents in one transaction, writing one `trashOp`.
- Folder counts shown in the list are computed by a single `documents.where('folderId').anyOf(subtreeIds)`
  count using `pathKey` to get `subtreeIds` — no N+1.

### 5.2 Tags

Flat, multi-select, `*tagIds` multiEntry index. Suggested-tag ordering by `useCount`. Reserved suggestions on
first run: `audition`, `memorised`, `performance`, `warm-up`, plus per-kind defaults. Tag filter combines with
folder scope (AND) and search (AND).

### 5.3 Search — title + full text

Two-stage retrieval. Stage 1 finds candidate documents from the inverted index; stage 2 re-scans only those
documents' text to produce ranked snippets. This is the classic postings-then-verify design and it removes the
need to store positions (which would triple index size).

**Indexing (per document save, incremental, in the save transaction):**

```ts
function indexTerms(title: string, body: string): Map<string, {tf:number; inTitle:0|1}> {
  const out = new Map();
  const add = (raw: string, inTitle: 0|1) => {
    const t = normalizeForKey(raw);                    // same normaliser as chunk keys
    if (t.length < 2 || t.length > 32) return;
    const cur = out.get(t) ?? { tf: 0, inTitle: 0 };
    cur.tf++; cur.inTitle = (cur.inTitle | inTitle) as 0|1;
    out.set(t, cur);
  };
  for (const w of title.split(/\s+/)) add(w, 1);
  for (const w of body.split(/[^\p{L}\p{N}']+/u)) add(w, 0);
  return out;
}
```

- No stemming, no stopword removal in v1. Stemming needs a per-language stemmer (this app is used in
  many languages); stopword removal breaks searching for a line like *"to be or not to be"* — which is
  exactly the kind of query an actor types. Cost of keeping stopwords: ~15% index size. Worth it.
- Write: `delete postings where docId = X`, then `bulkPut` the new postings. ~1,900 rows for the reference
  doc, one transaction, ~25 ms. Debounce indexing 800 ms after typing stops.

**Querying:**

```ts
async function search(q: string, scope?: {folderIds?: string[]; tagIds?: string[]}) {
  const terms = tokenize(q);                       // normalised
  const last  = terms.at(-1)!;                     // last term treated as a prefix (as-you-type)
  const sets  = await Promise.all(terms.map((t, i) =>
    i === terms.length - 1
      ? db.postings.where('term').between(t, t + '￿', true, true).toArray()  // prefix range
      : db.postings.where('term').equals(t).toArray()));
  // AND across terms, score = Σ (1 + 2·inTitle) · log(1 + tf) · idf(term)
  // idf from a cached term→docCount map (rebuilt lazily; approximate is fine)
  const candidates = intersectAndScore(sets).slice(0, 40);
  return verifyAndSnippet(candidates, q);          // load docText for ≤40 docs, exact match, ±60 chars
}
```

Prefix search comes free from an IndexedDB index range query — no trigram store, no external search
library. Phrase search (`"to be or not"` in quotes) is handled entirely by stage 2's exact scan, which is
why we don't need positions in the index.

Also searchable without the text index: role names (`documents.roles[].label`, scanned in memory over the
metadata list — 200 docs × 1 KB is trivial), tags, folder names.

Fallback for very small libraries (<25 docs) or a corrupted index: brute-force scan of `docText`. Keep this
path; it's 20 lines and it's the disaster recovery for search.

### 5.4 Sort orders

Offered (persist last choice per folder in `settings` under `ui.sort.<folderId>`):

1. **Recently practised** (default — this is a rehearsal tool, not a file manager) — `lastPracticedAt` desc,
   nulls last.
2. Recently edited (`updatedAt` desc).
3. Performance date (soonest first, nulls last) — the right default when any doc has a `performanceAt`;
   auto-select it if ≥1 doc in scope has an upcoming date.
4. Title A→Z (`sortTitle`, leading article stripped, `Intl.Collator` with numeric).
5. Confidence, lowest first ("what needs work") — uses `progress.conf`.
6. Length (`wordCount`).
7. Manual (`order`, sparse integers, drag to reorder; only within a folder).

Every one of these is a single index scan except 5 (index on `[status+updatedAt]` then in-memory sort on the
already-loaded metadata — fine at 200 docs).

### 5.5 Archive vs Trash vs Delete

- **Archive** (`status: 'archived'`): keeps everything, hides from all default views, excluded from
  schedules, notifications and "needs attention". For finished shows. Reversible, no TTL. Auto-suggest
  archiving 14 days after `performanceAt` passes ("*Hamlet* closed 2 weeks ago — archive it?").
- **Trash** (`deletedAt: number`): hidden everywhere, 30-day TTL, restorable, and *still counted in storage*
  (say so on the storage screen — the #1 confusion in local-first apps).
- **Hard delete**: only on explicit "Delete permanently" / "Empty trash" with a confirm listing what goes
  (n texts, n recordings, MB). Also triggered by TTL expiry, with a note in the trash screen ("items are
  removed 30 days after deletion"). Hard delete cascades: `docText`, `derived`, `docRevisions`, `mastery`,
  `reps`, `sessions`, `runs`, `plans`, `recordings` + blobs, `postings`.

### 5.6 Duplicate

`duplicateDocument(docId, opts)` with an explicit choice, because both are wanted for different reasons:

| Option | Copies | Use case |
|---|---|---|
| `withProgress: false` (default) | metadata, text, roles, prefs; **new ids**; `source.type='duplicate'`, `source.ofDocId` set | "same script, different production", sharing with a scene partner |
| `withProgress: true` | above + `mastery` + last 180 d of `reps` (new rep ids, remapped `docId`) | "try a different chunking without losing my work" |

Title becomes `"<title> (copy)"`, then `(copy 2)`. Recordings are never copied (size); offer "move
recordings" instead.

Related: **Split document** (by act/scene, using headings) and **Extract my lines** (a new doc containing
only `myRoleIds` speeches with cue tails) are both implemented as duplicate + text transform + re-anchor, so
they cost almost nothing once duplicate exists.

### 5.7 Undo

Every destructive or bulk action writes a `trashOp` with a replayable `inverse` **inside the same
transaction** as the mutation. Undo = replay inverse in one transaction, then delete the op. Snackbar for
8 s; the Trash screen keeps ops for 30 days. Text replacement is undone via `restoreRevisionId` (which is why
`import-replace` always writes a revision first). Re-anchoring is undoable for 30 days because orphaned
mastery rows are retained, not deleted.

---

## 6. Progress model

### 6.1 The rep: retrieval demand, verification trust, and stakes

The core problem: **re-reading feels like learning and isn't.** If a full-text read moves the same number as
a blind ASR-verified recitation, the app lies to the user and they get on stage unprepared. So every rep is
scored on two orthogonal axes before it touches memory state.

**Retrieval demand `R_d` ∈ [0,1]** — how much the rep forced recall out of the head:

```
R_d = m · maskFactor(kind) · promptFactor
```

| `mask.kind` | maskFactor | note |
|---|---|---|
| `blank` (full blank / word removed) | 1.00 | nothing to lean on |
| `lineHidden` (whole line gone) | 1.00 | |
| `gistOnly` (line replaced by a beat marker) | 1.00 | |
| `shape` (underscores of correct length) | 0.85 | length is a weak cue |
| `firstLetter` | 0.65 | strong cue, still real retrieval |
| `firstTwo` | 0.50 | | 

`promptFactor` = 1.00 if the chunk is presented cold, 0.90 if the previous chunk/cue line is visible
(script mode with cue lines is genuinely easier — and it's how you'll perform, so don't penalise it hard).

**Verification trust `V` ∈ [0,1]** — how much we believe the "pass":

| `mode` | V | rationale |
|---|---|---|
| `type` | 1.00 | objectively checked, character level |
| `asr` | 0.90 | objective but noisy (accents, homophones, mic) |
| `recordReview` | 0.75 | you heard yourself; honest-ish, retrospective |
| `recall` (self-report) | 0.65 | the standard mode; humans over-claim ~20% |
| `runReview` | 0.60 | graded in flow, coarse |
| `read` | n/a | nothing to verify — handled by the floor |

**Stakes:**

```
stakes s = clamp(0.08 + 0.92 · R_d, 0.08, 1) · V      for retrieval modes
stakes s = 0.08                                        for mode 'read'
```

Worked values (the weighting asked for):

| Rep | R_d | V | s | relative worth |
|---|---|---|---|---|
| Full-text read aloud | 0 | — | **0.08** | 1× |
| 30% first-letters, self-report | 0.195 | 0.65 | **0.17** | 2.1× |
| 50% blanks, self-report | 0.50 | 0.65 | **0.35** | 4.4× |
| 80% blanks, self-report | 0.80 | 0.65 | **0.53** | 6.6× |
| 80% blanks, typed | 0.80 | 1.00 | **0.82** | 10.2× |
| 100% blank, ASR-verified | 1.00 | 0.90 | **0.90** | 11.3× |
| 100% blank, typed, cold | 1.00 | 1.00 | **1.00** | 12.5× |

`stakes` is **stored on the rep** so that changing these tables later doesn't silently reinterpret history
(and so a recompute after an `algoVersion` bump can choose to keep or re-derive them).

**Grading.** `grade ∈ {1 again, 2 hard, 3 good, 4 easy}`:
- `type`/`asr`: from normalised match score on the masked tokens only —
  `score ≥ 0.98 → 4`, `≥ 0.90 → 3`, `≥ 0.75 → 2`, else `1`. ASR comparison must be
  diacritic/case/punctuation-insensitive, number-word normalised ("14"≡"fourteen"), and should forgive
  a configurable set of function-word substitutions at `strictness: 'lenient'`.
- `recall`: two buttons, not four — "Got it" / "Missed it" → 3 / 1, with a long-press on "Got it" for
  "easy" and a "needed a peek" state (`revealsUsed > 0` → downgrade 3→2, and never 4).
- `read`: always grade 3 (it's exposure; `s = 0.08` makes the grade nearly irrelevant).

### 6.2 Memory state: FSRS-lite

Forgetting curve (FSRS-4.5/5 power law — better fit than SM-2's exponential, and cheap):

```
R(t, S) = (1 + F · t / S) ^ (-0.5),      F = 19/81 ≈ 0.234568,   t in days (fractional)
```

Useful identity: **`R = 0.9` exactly when `t = S`.** So *stability in days ≈ "days until you'd recall it 9
times out of 10"* — a genuinely explainable number to show users ("this line will still be there in 6 days").

Required stability for retention `R*` at horizon `t`:

```
S_req(t, R*) = F · t / (R*^-2 − 1)
```

| R* | multiplier | meaning |
|---|---|---|
| 0.90 | `S = 1.00 · t` | |
| 0.92 | `S = 1.34 · t` | app default |
| 0.95 | `S = 2.17 · t` | |
| 0.99 | `S = 11.6 · t` | don't offer this; it's a work explosion |

Decay table (`R` for given `S`, days since last rep):

| S \ t | 0.25 d | 1 d | 3 d | 7 d | 14 d | 30 d |
|---|---|---|---|---|---|---|
| 0.5 | 0.90 | 0.82 | 0.65 | 0.48 | 0.35 | 0.24 |
| 1 | 0.97 | 0.90 | 0.76 | 0.61 | 0.48 | 0.35 |
| 4 | 0.99 | 0.97 | 0.92 | 0.84 | 0.74 | 0.60 |
| 15 | 1.00 | 0.99 | 0.98 | 0.95 | 0.91 | 0.83 |
| 60 | 1.00 | 1.00 | 0.99 | 0.99 | 0.97 | 0.95 |

**Initialisation** (first rep on a chunk, grade `g`, stakes `s`):

```
S0 = W_INIT[g] · (0.40 + 0.60 · s)          W_INIT = [–, 0.20, 0.60, 1.60, 4.00]   // days
D0 = clamp(6.0 − 1.2 · (g − 3), 1, 10)
```

A first-ever *read* (`s=0.08`) therefore yields `S0 ≈ 1.60 · 0.45 ≈ 0.72 d` — you'll be asked for it again
tomorrow, which is right.

**Success update** (`g ≥ 2`, elapsed `t = (now − lastRepAt)/day`, `R = R(t,S)`):

```
S_inc_full = 1 + e^{W8} · (11 − D) · S^{−W9} · (e^{W10·(1−R)} − 1) · hard(g) · easy(g)
S'         = S · (1 + s · (S_inc_full − 1))            // stakes scale the GAIN, not the state
```

Defaults (FSRS-5-ish; **do not tune without data**):
`W8 = 1.54` (`e^{W8} ≈ 4.67`), `W9 = 0.34`, `W10 = 1.26`, `hard(2) = 0.86`, `easy(4) = 1.60`, else 1.

**Failure update** (`g = 1`):

```
S_lapse = min(S,  W11 · D^{−W12} · ((S + 1)^{W13} − 1) · e^{W14·(1−R)})
S'      = S · (1 − s) + S_lapse · s                    // low-stakes fumble ≠ real lapse
lapses += (s ≥ 0.40 ? 1 : 0)
```
Defaults: `W11 = 1.90`, `W12 = 0.11`, `W13 = 0.29`, `W14 = 2.60`.

**Difficulty:** `D' = clamp(D − W6·(g − 3), 1, 10)` then mean-revert
`D'' = D' + W7 · (D_ANCHOR − D')`, with `W6 = 1.0`, `W7 = 0.05`, `D_ANCHOR = 5.0`.

**Same-day / massed reps** (`t < 0.10 d`, i.e. within ~2.4 h): `R ≈ 1` makes `S_inc_full ≈ 1`, so the long-term
formula already (correctly) gives almost nothing. Replace it with an explicit small bonus and let the
*ceiling* do the work:

```
if (t < 0.10) { S' = S · (1 + 0.05 · s); }   // durability barely moves
```

This is the honest and pedagogically correct behaviour: **cramming raises what you can do today, not what
you'll have on Friday.** It gives the app a true and motivating message rather than a fake one:
*"You can recite this now — come back tomorrow to make it stick."*

### 6.3 The demand ceiling `C` — the anti-self-deception mechanism

Retrievability alone can't distinguish "I've read this 40 times today" from "I recited it blind". So:

```
demand of a PASSED rep:  d = R_d · V            // 0 for reads (R_d = 0)
decayed max:             maxDemandPassed ← max( maxDemandPassed · e^{−Δt / τ_D},  d )     τ_D = 21 days
ceiling:                 C = 0.35 + 0.65 · maxDemandPassed          // ∈ [0.35, 1.00]
```

Consequences:
- A chunk you have only ever *read* has `maxDemandPassed = 0` → `C = 0.35` → **confidence can never exceed
  35** no matter how many reads. This is the whole point.
- A chunk passed at 100% masking with ASR (`d = 0.90`) → `C = 0.935`.
- A chunk passed cold, fully blank, typed (`d = 1.0`) → `C = 1.0`.
- If you stop doing hard reps, `C` decays with a 21-day half-life-ish, so "I could do this blind three
  months ago" stops counting. Failures don't reduce `maxDemandPassed` directly (the decay handles it), but a
  failure at `s ≥ 0.4` applies a one-off `maxDemandPassed ×= 0.9`.

### 6.4 Confidence: chunk and document

**Per chunk (0–100), evaluated at read time `now`:**

```
conf(chunk, now) = round( 100 · R(t, S) · C ),   t = (now − lastRepAt)/day
```

Bands for UI (heat map): 0–24 unknown/red, 25–49 shaky/orange, 50–74 getting there/amber,
75–89 solid/light green, 90–100 performance-ready/green. Never label anything "100% mastered" — label the
top band **"performance-ready"** and show the decay ("solid until Aug 4").

Also derive a **pass probability** for planning, which is *not* the same as confidence — it's the probability
of getting through the chunk at the intended performance masking (100%):

```
p_pass(chunk, now) = R(t,S) · (0.55 + 0.45 · maxDemandPassed)
```

(A chunk with high `R` but no hard-rep history has genuinely lower odds under performance conditions.)

**Per document.** Three numbers, each answering a different real question:

1. **Readiness score 0–100** (the headline number, word-weighted, tail-penalised):

```
w_i   = words_i · (mustNail_i ? 2 : 1)
mean  = Σ w_i·conf_i / Σ w_i
p10   = word-weighted 10th percentile of conf_i
score = round( mean − 0.5·(mean − p10) )        // halfway between the average and the weak tail
```
   Rationale: a plain mean lets 240 solid chunks hide 10 catastrophic ones — the exact failure mode of
   performance. Halving the distance to the 10th percentile makes the weak tail visibly expensive without
   making the number hopeless. Show the mean and p10 on tap so it's inspectable, not magic.

2. **Expected stumbles** (the *actionable* number): `E = Σ (1 − p_pass_i)`, displayed as
   "≈ 4 stumbles in a full run" with a "show me which" button. This is honest, it's a small integer, it goes
   down as you work, and it maps directly onto what happens on stage.

3. **% of words performance-ready**: `pctAt80` / `pctAt95` — the progress bar. Word-weighted, not
   chunk-weighted, so a 90-word monologue counts more than a one-word "Yes."

**Explicitly rejected as a headline:** clean-run probability `Π p_i`. It's the mathematically correct answer
to "will I get through it perfectly", and for 250 chunks at p=0.98 it reads **0.6%**, which is both true and
useless. Keep it available in an "honest numbers" expander next to expected stumbles, with the explanation.

### 6.5 Decay over time

Three things decay, at deliberately different rates:

| Quantity | Mechanism | Rate |
|---|---|---|
| Retrievability `R` | FSRS power law | governed by `S`; fast when `S` is small |
| Demand ceiling `C` | exponential on `maxDemandPassed` | τ = 21 d (≈ −4.6%/day) |
| Document `progress.*` | recomputed lazily from chunk state | staleness ≤ 6 h |

No cron, no background job. Confidence is a **pure function of (state, now)** — computed on read. The only
scheduled-ish write is one `progress.history` sample per day, written when the app opens.

A "nothing happened for 30 days" case must therefore not surprise: on open, if the doc's score dropped >15
points since last open, show it as information, not failure — *"3 weeks off. Act 1 is still strong; Act 3
needs a pass."*

### 6.6 The fold (rep → mastery), and full recompute

```ts
function fold(m: Mastery | null, rep: Rep, params: AlgoParams): Mastery {
  const now = rep.at;
  if (!m) m = initMastery(rep);                  // uses W_INIT, D0
  else {
    const t = Math.max((now - m.lastRepAt) / DAY, 0);
    const R = retrievability(t, m.S);
    m.S = rep.grade === 1 ? lapseStability(m, R, rep.stakes)
        : t < 0.10        ? m.S * (1 + 0.05 * rep.stakes)
        :                   successStability(m, R, rep.stakes);
    m.D = updateDifficulty(m.D, rep.grade);
    const decay = Math.exp(-t / 21);
    m.maxDemandPassed = Math.max(m.maxDemandPassed * decay,
      rep.grade >= 2 ? demandOf(rep) : 0) * (rep.grade === 1 && rep.stakes >= 0.4 ? 0.9 : 1);
    m.C = 0.35 + 0.65 * m.maxDemandPassed;
  }
  m.reps++; m.effReps += rep.stakes; m.totalSec += rep.ms / 1000;
  m.streak = rep.grade === 1 ? 0 : m.streak + 1;
  if (rep.grade === 1 && rep.stakes >= 0.4) m.lapses++;
  m.lastRepAt = now; m.lastGrade = rep.grade;
  m.conf = Math.round(100 * retrievability(0, m.S) * m.C);   // conf AT lastRepAt
  m.dueAt = now + daysUntil(m.S, params.targetRetention) * DAY;
  m.bestVerified = strongerOf(m.bestVerified, rep.mode);
  m.updatedAt = now;
  return m;
}

// Migration / algorithm change:
async function recomputeAll() {           // reps → mastery, in id (=chronological) order
  await db.transaction('rw', [db.reps, db.mastery, db.documents], async () => {
    await db.mastery.clear();
    const acc = new Map<string, Mastery>();
    await db.reps.orderBy('id').each(rep => {
      const key = resolveChunkKey(rep.docId, rep.chunkKey);   // follows reanchoredFrom chains
      acc.set(key, fold(acc.get(key) ?? null, rep, PARAMS));
    });
    await db.mastery.bulkPut([...acc.values()]);
    await recomputeAllDocProgress();
  });
}
```
Measured target: 50,000 reps in <3 s. This function is the reason D2 is worth the extra store.

---

## 7. Spaced repetition and the performance date

### 7.1 Which scheduler, and why (D9)

| Candidate | Verdict |
|---|---|
| **SM-2 / Anki-classic** | **Reject.** Interval unit is days with a 1-day floor and ease-factor semantics tuned for years-long retention. Useless for "show is in 5 days, I have 6 sessions", and its ease factor is a poor model of item difficulty. |
| **Leitner ladder (boxes 1/2/4/8 days)** | **Reject as the engine, keep as the metaphor.** No time model, so it can't answer "what's my recall on the 14th?", can't front-load, and can't spend a fixed daily budget optimally. But box-like language ("moved up a level") is good UI, and a Leitner view is a nice fallback debugging lens. |
| **Full FSRS-5 + optimiser** | **Reject the optimiser, keep the model.** 21 parameters fitted by gradient descent over ≥1,000 reviews per user. A single user learning one script produces heterogeneous, non-stationary data (masking level changes daily) — the optimiser would overfit noise. Also ~40 KB of code and an FSRS-shaped dependency. |
| **FSRS-lite: FSRS-5's power-law curve + `S`/`D` state, fixed global params, stakes-scaled updates, deadline objective on top** | **Adopt.** ~120 lines. Gives a real retention forecast (needed for back-planning), handles hour-scale intervals natively, degrades gracefully, and is explainable to the user ("stability 6 days"). |

**The crucial reframing.** Classic SRS minimises reviews subject to maintaining retention *forever*, and its
output is a **due date**. Here the deadline is a fixed date `T` and the user has a fixed daily budget. The
objective becomes:

> maximise `Σ_i w_i · p_pass_i(T)` (equivalently, minimise expected stumbles at `T`)
> subject to `Σ_i cost_i ≤ budget` per day, and `Σ_i w_i·(1 − p_pass_i(t))` bounded along the way.

That is a knapsack, so the scheduler is a **greedy marginal-gain-per-second ranker**, not a due queue. Due
dates still exist and are still stored (`dueAt`) — they're the right model in *maintenance mode*, after the
show or when there's no date at all.

Two modes, one engine:

- **Maintenance mode** (`performanceAt == null`): classic. Queue = `mastery.where('[docId+dueAt]')` below
  `now`, ordered by `dueAt`. Target `R* = 0.90`. Interval to next review:
  `t_next = S · (R*^-2 − 1)/F`.
- **Deadline mode** (`performanceAt != null`): §7.2–7.4.

### 7.2 Performance-date mode: back-planning

**Inputs:** `T` (with curtain time), per-weekday budget minutes, blackout dates, `R*`, priorities,
current `mastery` states, `doc.wordCount`, and the user's measured speaking rate (from `runs`, default
130 wpm).

**Step 1 — Phases.** With `N = ceil(daysBetween(now, T))` available (non-blackout) days:

| Phase | Share of N (min days) | What it does |
|---|---|---|
| **A Acquisition** | first 50% (≥1) | introduce new chunks; escalate masking within chunk; no full runs |
| **B Consolidation** | next 35% (≥1) | **material cutoff** — no new chunks; drive weak chunks up; scene-length runs |
| **C Polish** | last 15% (≥1) | full runs at performance masking, timing/pace, cue pickups, no new masking levels |

Plus a hard rule: **a full run within the last 24 h before `T`** (and one within 72 h). This mirrors how
performers actually work (a line-run before curtain) and it's mathematically load-bearing: it resets `t` to
near zero for every chunk, so `S_req = F·t/(R*^-2−1)` collapses. With a run 12 h before curtain and
`R* = 0.92`, required stability is only **`S ≈ 0.67 d`** — meaning the mid-plan targets aren't about
super-durability, they're about *not losing ground and raising ceilings*. Say this to the user; it's
reassuring and true.

**Step 2 — Required stability per chunk.** Horizon for chunk `i` is the gap from its last planned rep to `T`.
Rather than solving the full schedule, use the conservative two-horizon target:

```
t_far  = days(now → T)                       // if I never touch it again
t_near = 0.5                                 // final-run assumption (12 h)
S_target_i = max( S_req(t_near, R*),  0.55 · S_req(t_far, R*) )
```
The 0.55 factor encodes "you'll see it a few more times before the show" without needing a fixed-point
solve. `mustNail` chunks use `R* + (1−R*)/2` (default 0.96).

**Step 3 — Work estimate and feasibility.** For each chunk estimate the number of reps to reach
`S_target_i` by simulating `successStability` forward at the planned stakes ladder (`s ≈ 0.35 → 0.53 → 0.90`)
with grade 3, capped at 12 iterations:

```ts
function repsNeeded(m: Mastery, sTarget: number, ladder: number[]): number {
  let S = m.S, k = 0;
  while (S < sTarget && k < 12) { S = successStability({...m, S}, 0.9, ladder[Math.min(k, ladder.length-1)]); k++; }
  return k + (m.reps === 0 ? 1 : 0);          // +1 introductory read for brand-new chunks
}
const totalSec = Σ repsNeeded(i) · secPerRep(i);
```
where

```
secPerRep(chunk, mode) = words/(wpm/60) · modeFactor + overhead
modeFactor: read 1.0, recall 1.6, asr 1.3, type 4.0, runReview 1.05
overhead: 3 s (tap, reveal, transition)
```
(`type` at 4× is why typed verification is used sparingly — for chunks that keep lapsing, not as the default.)

Verdict:

```
requiredMinPerDay = totalSec/60 / N
verdict = required ≤ 0.75·available ? 'comfortable'
        : required ≤ 1.15·available ? 'tight'
        : 'not-feasible'
```

If `not-feasible`, **say so immediately and offer real levers** rather than silently generating an
impossible plan:
1. increase daily minutes (show the number needed),
2. lower `R*` (0.92 → 0.85 typically cuts required stability by ~40%),
3. reduce scope ("Act 1 only by the 14th" via `scopePriority`),
4. accept a projection ("at 20 min/day you'll reach ~72% ready, ≈14 stumbles").
Option 4 is the honest one and must always be present.

**Step 4 — Daily budget curve.** Don't spread flat. Allocate the day's minutes with a mild front-load in
Phase A and a bump in Phase C:

```
weight(day) = phase === 'A' ? 1.15 : phase === 'B' ? 1.00 : 1.10
minutes(day) = clamp( availableMin(weekday) · weight(day), 5, availableMin·1.5 )
```
Front-loading *material* matters far more than front-loading minutes: the material cutoff at ~55% of N is
the real mechanism. Nothing new in the last 45% of the run-up.

### 7.3 Daily selection: greedy marginal gain

```ts
function rankChunks(states: Mastery[], plan: Plan, now: number, phase: Phase) {
  const T = plan.performanceAt;
  return states.map(m => {
    const tNow = (now - m.lastRepAt) / DAY;
    const R    = retrievability(tNow, m.S);
    const mask = plannedMask(m, phase);                  // → methods doc
    const s    = stakesOf(mask);
    const Safter = successStability(m, R, s);            // assume grade 3
    const Cafter = 0.35 + 0.65 * Math.max(m.maxDemandPassed, demandOf(mask));

    const tToShow = (T - now) / DAY;
    const before = retrievability(tToShow + tNow, m.S) * (0.55 + 0.45*m.maxDemandPassed);
    const after  = retrievability(tToShow, Safter)      * (0.55 + 0.45*(Cafter-0.35)/0.65);

    const w    = words(m) * (plan.mustNailChunkKeys.includes(m.chunkKey) ? 2 : 1)
                          * scopeWeight(m, plan.scopePriority);
    const gain = Math.max(after - before, 0) * w;
    const cost = secPerRep(m, mask.mode);
    // urgency multiplier: chunks that will rot before T if untouched jump the queue
    const rot  = before < 0.6 ? 1.5 : 1.0;
    return { m, mask, score: (gain / cost) * rot, cost };
  }).sort((a, b) => b.score - a.score);
}
```

Then fill the day under constraints:

1. **Coverage floor.** Every chunk must be touched at least once every `max(2, floor(N/4))` days. Any chunk
   past its floor is force-inserted at the top regardless of score. Prevents "the scheduler ignored Act 3
   for a week" — the classic greedy failure.
2. **New-material rate.** In Phase A, at most `ceil(unlearned / (0.5·N))` new chunks per day (and never more
   than 12 — introducing more than ~12 new 20-word chunks in one sitting doesn't stick). Zero after the
   material cutoff.
3. **Within-session spacing.** Two reps of the same chunk must be separated by ≥2 other items and ≥90 s
   (expanding rehearsal beats massed repetition, and this is free to implement).
4. **Weak-first ordering, not weak-only.** Weak chunks go in the *first third* of the session (freshest
   attention) but the session still ends on strong material (see §8).
5. **Budget.** Stop when `Σ cost ≥ minutes(day)·60·0.92` (leave slack; people run over).

**Front-loading formula for rep allocation** within a day's budget, when you want proportions rather than a
strict greedy fill:

```
share_i ∝ (1 − conf_i/100)^1.3 · sqrt(words_i) · (D_i/5)^0.5 · mustNail_i
```
Exponent 1.3 on the confidence gap is what makes it "front-load weak chunks" rather than "spread evenly";
`sqrt(words)` stops a 90-word monologue eating the whole session.

### 7.4 Missed days, catch-up, and honesty

The plan is **recomputed from inputs every time the app opens** (§2.13: `cache` is disposable). There is no
"you owe 47 reviews" backlog — the single most demoralising pattern in SRS apps and completely wrong here,
because with a fixed deadline the right response to a missed day is *re-plan*, not *punish*.

On open, if the user is behind:
> "You're about 1.5 sessions behind. To stay on 92%: 26 min/day (was 20), or accept ~86% and ≈9 stumbles."

Two numbers, two options, no guilt. Recompute the feasibility banner daily and log it in
`plans.cache.feasibility` so the change over time is visible.

### 7.5 Defaults summary

```ts
const DEFAULTS = {
  F: 19/81, DECAY: -0.5,
  W_INIT: [0, 0.20, 0.60, 1.60, 4.00],
  W6: 1.0, W7: 0.05, D_ANCHOR: 5.0,
  W8: 1.54, W9: 0.34, W10: 1.26, HARD: 0.86, EASY: 1.60,
  W11: 1.90, W12: 0.11, W13: 0.29, W14: 2.60,
  SAME_DAY_WINDOW_D: 0.10, SAME_DAY_GAIN: 0.05,
  TAU_CEILING_D: 21, CEILING_FLOOR: 0.35,
  R_STAR: 0.92, R_STAR_MUST_NAIL: 0.96, R_STAR_MAINTENANCE: 0.90,
  PHASE_SPLIT: [0.50, 0.35, 0.15], MATERIAL_CUTOFF_FRAC: 0.55,
  MAX_NEW_PER_DAY: 12, COVERAGE_DAYS: (N) => Math.max(2, Math.floor(N/4)),
  SESSION_MIN_DEFAULT: 12, WPM_DEFAULT: 130,
  MODE_FACTOR: { read: 1.0, recall: 1.6, asr: 1.3, type: 4.0, runReview: 1.05, recordReview: 1.2 },
  REP_OVERHEAD_SEC: 3,
};
```
Store these under `meta.algoParams` with `algoVersion`, so a future change is a migration + recompute rather
than a silent behaviour shift.

---

## 8. Session design

### 8.1 Target lengths

| Preset | Total | When |
|---|---|---|
| **Top-up** | 5 min | commute, waiting in the wings, "keep it warm" |
| **Standard** (default) | **12 min** | the default everywhere |
| **Deep** | 20 min | Phase A with lots of new material |
| **Rehearsal** | 35 min (hard cap) | full runs, timing work |

Why 12 min as the default: it fits in dead time (the moment people actually rehearse), keeps attention on
retrieval rather than endurance, and — more importantly — **two 12-minute sessions on the same day beat one
25-minute session**, because the gap between them is itself the learning mechanism. Encourage the split
explicitly: after a completed session, offer "another one this evening?" rather than "keep going". Above
35 min, refuse politely and suggest splitting; a 60-minute masked-recall session is mostly fatigue.

### 8.2 Session shape (12-min standard)

| # | Block | Time | Modes | Graded? |
|---|---|---|---|---|
| 1 | **Warm-up read** | 60–90 s | `read`, 0% mask, yesterday's 2 weakest chunks + the chunk before them | Yes but `s = 0.08` |
| 2 | **Recall block** | 4–5 min | `recall`, escalating masking *within* each chunk (e.g. 40% → 65% → 90%), interleaved between chunks | Yes |
| 3 | **Verified run** | 2–3 min | `asr` (or `type` where ASR is unavailable/unreliable) at 90–100% mask, on 2–4 chunks that are *nearly* ready | Yes, high stakes |
| 4 | **New material** | 0–2 min (Phase A only) | `read` → 30% `firstLetter` → 60% `blank` on 1–3 new chunks | Yes |
| 5 | **Cool-down run** | 1.5–2 min | `runReview`: continuous run of the session's material at the doc's default mask, auto-scroll on, tap to mark stumbles | Yes, coarse |

Design rules baked into the generator:
- **Warm-up is not optional.** Cold-start failures are noise, not signal, and they're demoralising. The
  warm-up read at `s = 0.08` costs almost nothing in the model and a lot in adherence.
- **Escalate within a chunk, interleave between chunks.** Escalation inside a chunk is where the ceiling `C`
  gets raised; interleaving between chunks is where durability comes from. Doing only one of the two is the
  most common design error.
- **Drop on failure, immediately.** Two consecutive `grade 1` on a chunk → drop one masking level and
  re-present after ≥2 other items. Three consecutive failures anywhere → the generator inserts a `read` of
  that chunk and moves on. Never let the user fail 4 times in a row.
- **End on a success.** The cool-down uses material that just passed. If the last item fails, append one
  easy re-present. (Session-end mood is the strongest predictor of whether they come back tomorrow.)
- **Escape hatches always visible:** "just let me read it", "just do a run", "practise this scene". A
  scheduler that can't be overridden gets abandoned. Freeform sessions still log reps
  (`phase: 'freeform'`) — never discard evidence because the user went off-plan.

### 8.3 Generator

```ts
function generateSession(input: {
  doc: DocumentMeta; layout: Derived; states: Map<string, Mastery>;
  plan: Plan | null; budgetSec: number; now: number;
}): SessionBlock[] {
  const { doc, states, plan, budgetSec, now } = input;
  const phase   = plan ? phaseOf(plan, now) : 'maintenance';
  const ranked  = rankChunks([...states.values()], plan ?? maintenancePlan(doc), now, phase);
  const overdue = ranked.filter(r => pastCoverageFloor(r.m, plan, now));   // force-include
  const blocks: SessionBlock[] = [];
  let left = budgetSec;

  // 1. warm-up: weakest 2 from yesterday's session + their predecessor chunk (context)
  const warm = withPredecessors(pickWeakest(ranked, 2), input.layout);
  blocks.push(block('warmup', warm.map(c => item(c, 'read', mask(0))), Math.min(90, left*0.12)));
  left -= blocks.at(-1)!.targetSec;

  // 2. recall, escalating ladders, interleaved
  const recallBudget = left * (phase === 'polish' ? 0.30 : 0.45);
  const targets = dedupe([...overdue, ...ranked]).slice(0, 14);
  const ladders = targets.map(t => escalationLadder(t.m, phase));  // → methods doc
  blocks.push(block('recall', interleave(ladders, { minGapItems: 2, minGapSec: 90 }), recallBudget));
  left -= recallBudget;

  // 3. verified: chunks with conf 60..88 and maxDemandPassed < 0.8  → prove it
  const verifyPool = ranked.filter(r => r.m.conf >= 60 && r.m.conf <= 88 && r.m.maxDemandPassed < 0.8);
  const vMode: RepMode = asrUsable(doc) ? 'asr' : 'type';
  blocks.push(block('verified',
    fill(verifyPool, left * 0.35, r => item(r, vMode, mask(vMode === 'type' ? 0.5 : 1.0, 'blank'))),
    left * 0.35));
  left -= blocks.at(-1)!.targetSec;

  // 4. new material (Phase A only, rate-limited)
  if (phase === 'acquisition') {
    const budgetNew = Math.min(left * 0.45, 150);
    const fresh = unlearnedInOrder(input.layout, states).slice(0, newPerDay(plan, now));
    blocks.push(block('new', fresh.flatMap(c =>
      [item(c,'read',mask(0)), item(c,'recall',mask(0.3,'firstLetter')), item(c,'recall',mask(0.6,'blank'))]
    ), budgetNew));
    left -= budgetNew;
  }

  // 5. cool-down continuous run over this session's material
  blocks.push(block('cooldown',
    contiguousSpan(touchedChunks(blocks), input.layout)
      .map(c => item(c, 'runReview', mask(doc.prefs.maskLevel))), left));

  return trimToBudget(blocks, budgetSec);
}
```

Notes: `trimToBudget` shortens block 2 first, then 3, and never removes the warm-up or the cool-down. If
`budgetSec ≤ 360` (top-up), collapse to warm-up + recall + one-line cool-down.

---

## 9. Statistics: what to show, and what not to

### 9.1 The five screens worth building

1. **Script heat map** (the flagship). The whole text, each chunk tinted by `conf`, tappable to practise
   just that chunk. It is simultaneously the progress display, the navigation, and the to-do list. Build this
   before any chart. It also makes the mastery model *inspectable*, which is what earns trust.
2. **Readiness over time** — `progress.history` as a line chart: readiness score and `pctAt80`, with the
   performance date marked and a dashed projection from the scheduler's forecast. Annotate real events
   ("text edited", "3 days off") so dips have explanations instead of feeling like accusations.
3. **Expected stumbles** — one integer, trending down, with "show me which 4" → filtered heat map. The most
   actionable number in the app.
4. **Timing / pace** (speakers, and more useful to actors than they expect):
   - median and last full-run duration vs `targetDurationSec`, as **"9:42 — 18 s under"**;
   - WPM overall and per section (from `runs.splits`) with a "this section drags / rushes" callout —
   sections >1.35× the doc's median seconds-per-word;
   - pause count/length if we have audio.
   Show the *distribution* of the last 5 runs, not just the best one. "Your best is 9:40, your median is
   10:25" is the honest framing that prevents a nasty surprise on the night.
5. **Most-missed lines/words** — top 10 by **lapse rate**, not lapse count:
   `lapseRate = lapses / max(effReps, 1)`, requiring `effReps ≥ 3` before a chunk is eligible (otherwise
   one bad rep tops the chart). Word-level: aggregate `missedTokenIdx` across reps → the actual words that
   trip you up. This is a delightful feature ("you drop 'therefore' every single time") and it falls out of
   data we already store.

### 9.2 Time-to-mastery estimate

Simulate the scheduler forward at the user's *observed* recent pace (median active minutes/day over the last
14 days, not the aspirational budget), grade 3, planned mask ladder, and report a **range**:

```
"At ~15 min/day: 90% ready around Aug 6 (Aug 3 – Aug 12)."
```
Range from ±25% on pace and ±1 grade level on assumed performance. Never give a single date — the model's
uncertainty is real and a missed single-point prediction destroys trust in every other number.

### 9.3 Streaks — include, but defuse

Streak counters exploit loss aversion, and when the streak breaks the modal outcome is *quitting*. Ship the
honest variant:

- **"Practised 5 of the last 7 days"** (rolling window, cannot be "broken").
- A 12-week calendar heat map of active minutes/day — pattern, not pressure.
- No freezes, no fire emoji escalation, no "you lost your 47-day streak" screen. If the user wants a streak
  number, `stats.showStreak` renders the rolling-7 count.

### 9.4 Vanity metrics: explicitly do not build these

| Metric | Why it's harmful |
|---|---|
| **Total reps / words "learned" / XP / points** | Rewards volume, and volume is maximised by re-reading — the exact behaviour the app exists to prevent. |
| **Anything that counts a `read` as progress on the main number** | The central lie. The demand ceiling (§6.3) exists specifically to make it impossible. |
| **"100% mastered" / trophy on completion** | Memory decays; the badge is false 48 h later, and it tells the user to stop practising at the worst moment. Top band is "performance-ready", with a decay date. |
| **Unweighted mean confidence** | Hides the one hole that ruins the performance. |
| **Punishing streaks** | Break → quit. |
| **Raw ASR accuracy % as a score** | Conflates the recogniser's errors with the user's. If ASR confidence is low, say "couldn't hear that clearly" and don't grade. Never show WER as "your accuracy". |
| **Leaderboards / social comparison** | Different texts, different lengths, no meaning. |
| **Time-in-app** | Optimises the wrong thing; a good session is short. |

One further honesty rule: whenever a number is shown, **tapping it must explain how it was computed**, in one
sentence, with the inputs. "Readiness 78 = word-weighted average 84, weak-tail 10th percentile 66 →
halfway = 78." If a metric can't survive being explained, don't ship it.

---

## 10. Export / import

### 10.1 JSON backup (everything except audio)

Filename: `memocoach-backup-YYYY-MM-DD-HHmm.json`. MIME `application/json`.

```jsonc
{
  "format": "memocoach.backup",
  "formatVersion": 1,
  "app":  { "name": "memocoach-web", "version": "0.4.2", "installId": "0190f…" },
  "exportedAt": "2026-07-28T11:04:12.331Z",
  "schemaVersion": 1,
  "algoVersion": 1,
  "options": { "includeAudio": false, "includeReps": true, "includeRevisions": true,
               "scope": "all" },                      // or { "scope":"docs", "docIds":[…] }
  "counts": { "folders": 7, "tags": 5, "documents": 23, "docRevisions": 61,
              "mastery": 3140, "reps": 18422, "sessions": 214, "runs": 63,
              "plans": 2, "recordings": 11, "postings": 0 },
  "data": {
    "meta":       [ { "key": "installId", "value": "0190f…" } ],
    "settings":   [ { "key": "practice.sessionMinutes", "value": 12 } ],
    "folders":    [ /* Folder */ ],
    "tags":       [ /* Tag */ ],
    "documents":  [ /* DocumentMeta */ ],
    "docText":    [ { "docId": "…", "text": "…", "textHash": "…", "format": "plain" } ],
    "docRevisions":[{ "id":"…","docId":"…","createdAt":0,"reason":"manual-save",
                      "textB64Gz":"H4sIA…","bytes":9812,"textHash":"…","wordCount":5012 } ],
    "mastery":    [ /* Mastery */ ],
    "reps":       [ /* Rep */ ],
    "sessions":   [ /* Session */ ],
    "runs":       [ /* Run */ ],
    "plans":      [ /* Plan, cache omitted */ ],
    "recordings": [ { "…Recording": true, "audio": { "included": false,
                      "path": "audio/0190f….webm", "sizeBytes": 1842391,
                      "sha256": "…" } } ]
  },
  "integrity": { "alg": "sha256", "value": "9f2c…",
                 "over": "JSON.stringify(data) with sorted keys" }
}
```

Rules:
- **`derived` and `postings` are never exported.** Both are pure caches; exporting them bloats the file by
  ~30% and risks importing a stale index. Rebuilt on import (progress bar: "rebuilding search index").
- **Ids are preserved** (UUIDv7 ⇒ no collisions across installs), which is what makes `merge` safe.
- **Blobs → base64** only for revision gzip (small). Audio never goes in the JSON: base64 inflates by 33%
  and a 200 MB audio library produces a 270 MB JSON that no phone can `JSON.parse`.
- **Integrity hash** over canonicalised `data` catches truncated downloads (a real failure on mobile).
- Streaming write for large exports: build the file with a `ReadableStream` writing store-by-store rather
  than one giant `JSON.stringify` (which OOMs around 200 MB on iOS). Same on read: use a streaming JSON
  parser for the `reps` array if `file.size > 32 MB`, otherwise plain `JSON.parse`.

**Import modes** (always shown as an explicit choice with a preview of counts and conflicts):

| Mode | Behaviour |
|---|---|
| `merge` (default) | per-record LWW by `updatedAt` for `folders`/`tags`/`documents`/`docText`/`settings`; **`reps` unioned by id** (append-only ⇒ conflict-free); `mastery` recomputed from the merged rep log afterwards rather than merged directly (avoids two half-states) |
| `replace` | wipe the database and restore exactly. Requires typing the word "replace"; writes a pre-import full backup to the downloads folder first if possible |
| `duplicate` | remap every id, prefix titles "Imported – ". For loading a friend's script without touching your library |
| `docsOnly` | text + roles + prefs, **no progress**. The sharing default (see below) |

**Sharing a script** deserves its own affordance: `Export text only` → a JSON with just
`documents`(minus `progress`)+`docText`+roles, or plain `.txt`. Actors share scripts constantly; nobody wants
to ship their practice history, and progress from someone else's brain is meaningless.

`formatVersion` handling: importer accepts `≤ CURRENT` via a chain of `migrateBackup[v→v+1]` pure functions;
refuses `> CURRENT` with "this backup was made by a newer version — update the app". Unknown extra fields are
preserved on records (forward-compatible) rather than stripped.

### 10.2 Zip archive (with audio)

Filename `memocoach-archive-YYYY-MM-DD.mcz` (a plain zip; `.zip` also accepted on import).

```
manifest.json          # {format:"memocoach.archive", formatVersion:1, includesAudio:true,
                       #  backup:"backup.json", counts:{…}, totalBytes:…}
backup.json            # byte-identical to §10.1, with options.includeAudio = true and
                       #   recordings[].audio.included = true
audio/<recordingId>.webm|.m4a     # original blobs, STORED (no deflate — opus/aac won't compress)
text/<docId>-<slug>.txt           # human-readable plain text of every document
text/<docId>-<slug>.md            # optional: role-annotated markdown
README.txt             # what this file is, how to restore, and the note that text/ is readable
                       #   without the app
```

Implementation: `fflate` (~8 KB gz) with `Zip` streaming writer — deflate `backup.json` and `text/*`
(typically 4–6× on JSON), store audio uncompressed. Write via `showSaveFilePicker()` +
`FileSystemWritableFileStream` where available (no memory ceiling), else assemble a Blob and download (cap the
Blob path at ~500 MB and warn beyond).

The `text/` directory is not decoration — it is the **escape hatch guarantee**: even if this app dies, the
user's scripts are plain files they can read. For a free, self-hosted, no-account app, that promise is the
thing that makes local-first storage ethically acceptable.

### 10.3 Auto-backup

- On every app open, if `now − meta.lastBackupAt > 7 d` **and** `reps since last backup > 50`: banner offering
  a one-tap JSON download (audio excluded, so it's ~1 MB per 20 docs).
- If a `FileSystemFileHandle` was granted previously (Chromium), write silently in the background and just
  toast "backed up". Never do this without the user having chosen the file — that's their explicit grant.
- Log the last 10 backups in `meta` (timestamp, bytes, counts) so the storage screen can prove it happened.

---

## 11. Migrations and versioning

Three independent version numbers, deliberately decoupled:

| Version | Owns | Bump effect |
|---|---|---|
| `schemaVersion` (IDB) | store/index structure | Dexie `version(n).stores().upgrade()`; must be pure and idempotent |
| `chunkerVersion` (`meta`) | tokenising/chunking rules | invalidate `derived`, re-chunk, run re-anchoring (§3.2) with `pre-reanchor` revisions |
| `algoVersion` (`meta`) | scheduler params & fold logic | offer `recomputeAll()` from `reps`; keep old `mastery` in a backup store for one release |

Migration discipline:
- Every migration ships with a fixture database (a committed backup JSON) and a test that migrates it.
- Migrations never delete data in the same release that stops reading it — deprecate for one release, remove
  in the next.
- If `db.open()` fails (corruption, downgrade), don't wipe: open in read-only recovery mode, offer "export
  everything I can read" before anything else. Losing a month of rehearsal to a failed migration is the worst
  outcome this app can produce.

### Future sync (designed for, not built)

Every record already has `id` (UUIDv7), `updatedAt`, `deletedAt`. That is enough for last-write-wins sync of
the mutable stores and trivially conflict-free append-merge of `reps` (the only high-volume store). A future
free-tier sync is then ~200 lines against any object store (a Cloudflare Worker + D1 free tier, or the user's
own Drive/Dropbox file). Adding a `syncQueue` store and a `rev` counter later is a schema migration, not a
redesign — which is the point of specifying it now and building none of it.

---

## 12. Open questions / risks

1. **ASR reality check.** Web Speech API is Chrome/Safari-only, cloud-backed on Chrome (privacy note
   required), and unreliable on stage-adjacent accents and verse. Everything above treats `asr` as *one*
   verification mode with `V = 0.90` and a `type` fallback, so the model survives ASR being bad — but the
   "verified run" block needs a graceful degradation to `recall` + a "did you get it?" prompt. Decide before
   building block 3 of the session generator.
2. **Chunk size for lyrics vs prose** needs real testing; `chunkTargetWords` default 20 is an educated guess.
   Instrument it: log `chunkStrategy` and outcomes so the default can be chosen from data later.
3. **`W_INIT` and `S_inc` defaults are borrowed, not fitted**, and our stakes-scaling changes their meaning.
   Expect intervals to be somewhat too optimistic in the first week of use. Mitigation: `R* = 0.92` (higher
   than Anki's typical 0.90) plus the coverage floor, both of which err toward more practice.
4. **The 0.55 factor in `S_target`** (§7.2 step 2) is a heuristic replacing a fixed-point solve. If the plans
   feel wrong, the honest fix is to actually simulate the whole remaining schedule (it's only N×|chunks|
   evaluations, ~250k float ops — cheap). Do that in v2.
5. **Safari eviction** (§1.2) remains the top existential risk; the backup nudge is a requirement, not a
   nicety, and should be treated as P0 alongside the reader.
