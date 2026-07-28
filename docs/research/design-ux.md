# UX & UI Design Specification
## A free, local-first, installable web app for memorising lines, lyrics, speeches and text

**Status:** design spec for implementation. No code here except tokens and a few precise DOM/ARIA snippets where the exact markup is load-bearing.
**Target directory:** `/Users/ben/memocoach` (greenfield)
**Author context:** single developer + Claude Code, a few focused sessions, zero running cost, no accounts, no paywall.
**Date:** July 2026

---

## 0. Ground rules before any pixel

### 0.1 Legal / identity guardrails — read this first

We are copying a **product category and a set of functional ideas** (progressive masking of text to drive active recall). That is legitimate: functional concepts, workflows and features are not protected by copyright. What we must **not** do:

| Never do this | Why | What we do instead |
|---|---|---|
| Use the name "MemoCoach", "Memorize Lines", "Memorize Script", or any confusingly similar mark | Trademark | Pick our own name (§0.3), run a quick USPTO/EUIPO + npm + domain check before committing |
| Copy their app icon, colour scheme, or logo | Trademark + copyright | Own icon, own palette (§9) |
| Reuse their screenshots, App Store text, feature bullets, or taglines | Copyright in the expression | Write every string ourselves. All microcopy in this document is original and safe to ship |
| Copy their exact UI strings ("Reveal", button labels, method names as they word them) where distinctive | Copyright in expression; also just lazy | Our own method names are specified in §6.2 |
| Mention "MemoCoach" anywhere in the product, marketing, meta tags, or store listing (including "alternative to…" / comparison SEO) | Trademark use + invites a complaint | The product never names a competitor. Any competitive framing stays in Ben's private notes |
| Ship copyrighted sample text (song lyrics, modern plays, film scripts) | Copyright | Sample content is **public domain only** (§8.1) |
| Copy the shape/wording of their pricing tiers | Irrelevant to us | We have no pricing |

Also: because the app ingests users' scripts (which are frequently other people's copyrighted work), the About screen carries a short line: *"Your texts stay on your device. Only add material you have the right to use."* Local-first storage makes this a non-issue in practice — we never receive the content.

### 0.2 Design principles (these decide arguments later)

1. **The Reader is the product.** Every other screen exists to get the user into the Reader in under 15 seconds and out of the way. If a feature adds chrome to the Reader, it needs to justify itself against the alternative of living in a sheet.
2. **Calm, paper-like, boring on purpose.** Rehearsing is cognitively expensive. The UI contributes zero visual noise: no gradients, no shadows except on sheets, no brand colour in the text area, no animation that isn't communicating state.
3. **One thumb, one hand, phone held at eye level, possibly on a train.** All primary controls live in the bottom third. Nothing important in the top corners.
4. **Never lose the user's place.** Masking, unmasking, changing difficulty, rotating the device, or resizing text must not reflow the text out from under them. Scroll anchoring on the current line is a hard requirement, not a nicety.
5. **The masked word is never in the DOM.** Architectural, security-of-answer, and accessibility requirement all at once (§5.1, §7.2).
6. **Local-first, no account, no network needed after first load.** Every screen must be fully functional offline. There is no "signed out" state because there is no signed-in state.
7. **Progressive disclosure over configurability.** The app ships with one good default ladder and one good default method. Everything else is behind a sheet. Power users can find the 12 methods; a first-timer never has to.

### 0.3 Five candidate names

Chosen to be short, spellable aloud, theatre/recall-adjacent without being twee, and to leave room for a simple wordless icon.

| Name | Rationale | Icon idea | Risk |
|---|---|---|---|
| **Offbook** | The actual theatre term for "no longer holding the script" — it *is* the goal state, and it flatters the target user by using their vocabulary. Strong verb-like brand ("get offbook"). | A book silhouette closing / a bracket that closes | Common industry term, so may be crowded; check trademark class 9/42 |
| **Byheart** | Plain-English, warm, universal across all four audiences (actors, singers, speakers, students). Reads well as `byheart.app`. | A lowercase "b" whose bowl is a soft heart, or nothing at all — wordmark only | Generic-ish; weak trademark but fine for a free app |
| **Cueline** | Cue + line. Signals the actor feature (cue lines) and the reading-a-line loop. Neutral enough for non-actors. | Two horizontal rules, the second one dashed/broken | Slightly jargon-y for students |
| **Fadelines** | Describes the core mechanic literally — lines fade away step by step. Self-explanatory in one word. | Three stacked rules with descending opacity | Plural is a bit awkward as a verb |
| **Recital** | Elegant, covers music + speech + verse. Latinate calm. | A single centred vertical stroke (the teleprompter indicator) | Music-leaning; may under-sell the actor use case |

**Recommendation: Offbook**, with **Byheart** as fallback if the trademark check is messy. Both are single words, work as a domain, and read fine in a browser tab at 12px. The wordmark is set in the app's own display face at 600 weight, letter-spaced `-0.01em`, lowercase. No mascot, no gradient, no app-store-style rounded-square icon flourish — the icon is a monochrome mark on `--accent` that survives being 16px in a Safari tab.

Throughout this document the app is called **Offbook** for concreteness.

### 0.4 Vocabulary the UI uses (be consistent, it's half of good UX)

| Term | Means | Not called |
|---|---|---|
| **Text** | One thing you're memorising (a monologue, a song, a speech) | "Script", "document", "piece" — "Text" is audience-neutral |
| **Folder** | Container for Texts. One level deep only (see §3.2) | "Collection", "Tag" |
| **Line** | One rendered line of the text as authored (a verse line, or a wrapped paragraph gets its own model) | — |
| **Block** | A speech, stanza, or paragraph. Has an optional **Speaker** | "Scene", "Chunk" |
| **Speaker** | A character/role name attached to Blocks | "Character" internally is fine; UI says Speaker except in Actor Mode where it says Character |
| **Token** | A word (or punctuation) — the unit that gets masked | "Word" in UI copy; "Token" in code |
| **Method** | A masking technique (hide random words, hide first letters, …) | "Mode" is overloaded; avoid |
| **Stage** | One rung of the difficulty ladder | "Level" implies gamification we're not doing |
| **Ladder** | The ordered sequence of Stages for the current Method | — |
| **Run** | One pass from top to bottom of the text | "Attempt" |
| **Session** | One sitting = several Runs | — |
| **Peek** | A temporary reveal of a masked word | "Hint" (implies help; we want it to feel like a cost) |

---

## 1. Information architecture & navigation map

```
┌─────────────────────────────────────────────────────────────┐
│ ROOT (no auth, no splash beyond the PWA icon)               │
│                                                             │
│  Tab bar (mobile) / sidebar (≥1024px):                      │
│  ┌──────────┬──────────┬──────────┐                         │
│  │ Library  │ Progress │ Settings │                         │
│  └──────────┴──────────┴──────────┘                         │
│                                                             │
│  Library ──▶ Folder ──▶ Text Overview ──▶▶ READER (fullscreen route)
│     │                       │                    │          │
│     ├─▶ Import / Paste      ├─▶ Structure Editor ├─▶ Method sheet
│     │      └─▶ Cleanup      ├─▶ Speakers / Role  ├─▶ Text sheet (Aa)
│     └─▶ Search              └─▶ Text settings    ├─▶ Session sheet
│                                                  └─▶ Debrief
│  Progress ──▶ Text detail stats                             │
│  Settings ──▶ Appearance / Reader / Gestures / A11y /       │
│               Data (Backup & Restore) / About               │
└─────────────────────────────────────────────────────────────┘
```

**Routing.** Real URLs (hash or History API) so back/forward work and so a Text is linkable within the device: `/`, `/f/:folderId`, `/t/:textId`, `/t/:textId/read`, `/t/:textId/edit`, `/progress`, `/settings/*`. The Reader is a **route, not a modal** — otherwise Android back button and iOS back-swipe do the wrong thing.

**Depth budget:** paste → read must be **≤3 taps**. Library → read an existing text must be **1 tap** (tapping a Text card goes straight into the Reader at its last Stage; the Overview screen is reached via the card's chevron/long-press). This is the single most important IA decision in the document: people open this app to rehearse *right now*.

**The tab bar is hidden inside the Reader** and inside any editor, and it hides on scroll-down in the Library. On ≥1024px it becomes a 220px left sidebar and the Reader still goes full-bleed.

---

## 2. Screen inventory

Summary table first; details follow.

| # | Screen | Purpose (one line) | Primary action |
|---|---|---|---|
| 1 | **First run** | Prove the app works in 10 seconds with a real text | "Try it" → Reader with sample |
| 2 | **Library** | Find the text I'm rehearsing today | Tap a Text → Reader |
| 3 | **Folder** | Same as Library, scoped | Tap a Text → Reader |
| 4 | **Add sheet** | Choose how text gets in | "Paste text" |
| 5 | **Paste / Import** | Get raw text into the app | "Continue" |
| 6 | **Cleanup** | Fix the mess that import made | "Looks right" |
| 7 | **Structure editor** | Fine-grained line/block/speaker edits | Auto-saves; "Done" |
| 8 | **Speakers / Role picker** | Choose which character is me | "Rehearse as <name>" |
| 9 | **Text Overview** | Everything about one text + jump into practice | "Rehearse" |
| 10 | **READER** | Rehearse. 90% of all time in app | Advance / Harder |
| 11 | **Method sheet** | Pick the masking technique | Tap a method card |
| 12 | **Text sheet (Aa)** | Typography + theme, live | Slider drag |
| 13 | **Session sheet** | Set up a structured session | "Start session" |
| 14 | **Debrief** | What just happened, what to do next | "Drill weak lines" |
| 15 | **Progress / Stats** | Am I actually improving? | Tap a text → its trend |
| 16 | **Settings** | Everything configurable | — |
| 17 | **Backup & Restore** | Own your data, move devices | "Export backup" |
| 18 | **About** | What this is, licences, privacy | — |
| 19 | **Search** | Find a line or a text | Tap result |
| 20 | **Shortcuts overlay** | Desktop keyboard reference (`?`) | Dismiss |

---

### Screen 1 — First run

**Purpose.** Convert curiosity into one successful rehearsal loop before asking for anything. No account, no permissions, no tour.

**Structure.** Three full-bleed panels, swipeable, with a persistent skip. But — and this matters — panel 1 is **not** a marketing slide, it's the mechanic itself, live:

```
┌─────────────────────────────┐
│                             │
│   Shall I compare thee      │
│   to a ▁▁▁▁▁▁▁ day?         │   ← real masked text, tappable
│   Thou art more ▁▁▁▁▁ and   │
│   more temperate            │
│                             │
│   Tap a blank to reveal it   │  ← ghost hint, fades after first tap
│                             │
│   ●○○                       │
│                             │
│  ┌───────────────────────┐  │
│  │       Continue        │  │
│  └───────────────────────┘  │
│         Skip intro          │
└─────────────────────────────┘
```

- **Panel 1 — the mechanic.** Four lines of Sonnet 18 with two blanks. The user must tap a blank to continue (or can skip). Copy: *"Read it aloud. Tap a blank if you're stuck."*
- **Panel 2 — the ladder.** Same four lines; pressing **Harder** live-increases the masking 0% → 30% → 60% → first letters → gone. Copy: *"Each pass hides a little more. That's the whole idea."*
- **Panel 3 — get your own text in.** Two big buttons: **Paste your text** / **Import a file**, plus a quiet third: **Start with a sample** (loads 3 public-domain samples into the Library, §8.1).

**Key elements.** Progress dots; Skip (top-right, 44px, always); no email field, no notification prompt, no install prompt (the install prompt comes later, §8.5).

**Primary action.** Panel 3's "Paste your text".

**Persistence.** A `hasOnboarded` flag in local storage. Re-runnable from Settings → About → "Replay intro".

---

### Screen 2 & 3 — Library (and Folder)

**Purpose.** Get me to today's text in one tap; keep 60 texts organised without a filing system.

**Layout (mobile).**

```
┌─────────────────────────────┐
│ Offbook              ⌕   ⋮  │  ← header, scrolls away
│                             │
│  Continue                   │  ← §2.1 "Continue" rail, only if a run exists
│  ┌───────────────────────┐  │
│  │ Hamlet — Act 3 Sc 1   │  │
│  │ Stage 4 · 60% hidden  │  │
│  │ ▓▓▓▓▓▓▓░░░  2 days ago│  │
│  └───────────────────────┘  │
│                             │
│  Folders                    │
│  ┌────────┐ ┌────────┐      │
│  │ 📁 Aud-│ │ 📁 Cho-│      │  (folder chips, horizontal scroll)
│  │ itions │ │ ir     │      │
│  │   4    │ │   7    │      │
│  └────────┘ └────────┘      │
│                             │
│  All texts        Sort ⌄    │
│  ┌───────────────────────┐  │
│  │ Sonnet 18          ›  │  │
│  │ 14 lines · Stage 2    │  │
│  ├───────────────────────┤  │
│  │ Best Man Speech    ›  │  │
│  │ 340 words · new       │  │
│  └───────────────────────┘  │
│                        ╭──╮ │
│                        │ ＋│ │  ← FAB, above tab bar
│                        ╰──╯ │
│ ┌────────┬────────┬────────┐│
│ │Library │Progress│Settings││
│ └────────┴────────┴────────┘│
└─────────────────────────────┘
```

**Key elements.**
- **Header:** wordmark (not a logo lockup — just the name at 17px/600), search icon, overflow (⋮ → New folder, Select multiple, Import, Sort).
- **"Continue" rail:** the single most-recently-practised text, rendered as a taller card with a stage progress bar and a big implicit tap target. This is the 1-tap path.
- **Folder chips:** horizontally scrolling row, each with a count. `All` chip is implicit (the list below is always the current scope). Long-press a chip → rename / recolour / delete.
- **Text rows:** title (17px/600, 2-line clamp), meta line (13px muted: line count · current Stage · relative last-practised), and a 3px stage bar at the row's left edge in `--accent` at the stage fraction. The chevron `›` is a **separate 44px target** that goes to Text Overview; the rest of the row goes straight to the Reader. Document this in the row's own aria description so it isn't a mystery to SR users (§7.4).
- **Swipe actions on a row:** swipe-left reveals `Move` / `Delete` (see gesture conflicts, §5.4). Long-press enters multi-select.
- **FAB:** `＋`, 56px, bottom-right, offset above the tab bar by `12px + tabbar`, respecting `env(safe-area-inset-bottom)`. Opens the Add sheet (Screen 4). On desktop it becomes a normal "New text" button in the header.
- **Sort:** Recently practised (default) / Recently added / Title / Least practised. "Least practised" is quietly the most useful one; it surfaces neglect.

**Primary action.** Tap a Text row → Reader, resuming its saved Method + Stage + scroll position.

**Desktop (≥1024px).** Sidebar with folder tree; list becomes a 2-or-3-column card grid at `minmax(280px, 1fr)`; Reader opens full-bleed over everything (it needs the whole viewport, always).

---

### Screen 4 — Add sheet

**Purpose.** Route to the right ingestion path without a decision screen.

Bottom sheet, four rows, each 56px with a leading icon and a one-line explainer:

1. **Paste text** — *"From anywhere: Notes, email, a website."* (default focus)
2. **Import a file** — *"PDF, TXT, RTF, HTML, Markdown, DOCX*"* (*if we ship the mammoth path; otherwise drop DOCX from the copy)
3. **New folder**
4. **Load a sample** — *"Public-domain pieces to try things out."*

Plus, if the device supports it: **share-target hint** — *"Tip: you can share text to Offbook from other apps."* (Web Share Target works in installed PWAs on Android/Chromium; on iOS it does not, so this row is feature-detected and hidden rather than shown-and-broken.)

**Primary action.** Paste text.

---

### Screen 5 — Paste / Import

**Purpose.** Get the raw characters in with minimum friction.

**Paste variant.**
```
┌─────────────────────────────┐
│ ✕            New text    →  │
│ ┌─────────────────────────┐ │
│ │ Title (optional)        │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │                         │ │
│ │  Paste or type your     │ │
│ │  text here…             │ │
│ │                         │ │  ← autofocused, monospace-ish, grows
│ │                         │ │
│ └─────────────────────────┘ │
│  0 words · 0 lines          │
│  ⎘ Paste from clipboard     │  ← only if navigator.clipboard.readText exists
│ ┌───────────────────────┐   │
│ │      Continue         │   │
│ └───────────────────────┘   │
└─────────────────────────────┘
```
- Autofocus the textarea and **do not** autofocus the title (people paste first; we derive a title from line 1 if left blank).
- Live word/line count. Warn softly above 20,000 words (*"That's a long one — practice will still work, but consider splitting it into scenes."*) rather than blocking.
- `⎘ Paste from clipboard` button for iOS users who find long-press-paste in a textarea fiddly; feature-detected, and it will trigger the OS permission prompt, which we explain inline before the tap.

**Import variant.**
- A drop zone on desktop (`Drop a file, or browse`), a plain file input on mobile (`accept=".pdf,.txt,.rtf,.html,.htm,.md,.docx,text/*"`).
- **Progress with real stages** because PDF parsing is slow: `Reading file → Extracting text → Detecting structure`. Cancellable.
- All parsing is **client-side** (pdf.js in a Worker). Copy says so: *"Files are read on your device and never uploaded."* — that's both true and a differentiator worth stating once.
- Multi-file: allowed, creates one Text per file, lands them in the current folder.

**Primary action.** Continue → Cleanup.

**Errors.** See §8.3 — this screen has the most error surface in the app.

---

### Screen 6 — Cleanup

**Purpose.** Imported text is *always* wrong in the same four ways. Fix them with taps, not by editing prose. This screen is the difference between "the app is broken" and "the app is magic", and it is the most under-appreciated screen in the whole product.

The four canonical import problems and their one-tap fixes:

```
┌─────────────────────────────┐
│ ‹            Clean up    →  │
│                             │
│  We found 42 lines,         │
│  2 speakers, 3 stage        │
│  directions.                │
│                             │
│  ┌───────────────────────┐  │
│  │ ⌦ Join broken lines   │  │  ← toggle, ON by default if detected
│  │   Reflowed PDF line   │  │
│  │   breaks mid-sentence │  │
│  └───────────────────────┘  │
│  ┌───────────────────────┐  │
│  │ ⌦ Remove page numbers │  │
│  │   & headers  (7 found)│  │
│  └───────────────────────┘  │
│  ┌───────────────────────┐  │
│  │ ⌦ Hide stage          │  │
│  │   directions (3)      │  │
│  │   [Keep] [Grey] [Cut] │  │
│  └───────────────────────┘  │
│  ┌───────────────────────┐  │
│  │ ⌦ Detect speakers  ✓  │  │
│  │   HAMLET, OPHELIA     │  │
│  └───────────────────────┘  │
│  ─────────────────────────  │
│  Preview                    │
│  HAMLET                     │
│  To be, or not to be, that  │
│  is the question…           │
│  (Aside) — greyed           │
│                             │
│ ┌───────────────────────┐   │
│ │     Looks right       │   │
│ └───────────────────────┘   │
│   Edit line by line →       │
└─────────────────────────────┘
```

**Key elements.**
- Each fix is a **toggle with a count**, pre-set to our best guess, and the **preview below updates instantly**. Nobody reads the toggles; everybody looks at the preview. So the preview must be the same typography as the Reader, showing the first ~8 lines, and it must be scrollable.
- Stage directions get three states (Keep as text / Grey out and never mask / Remove) because actors care about this a lot and singers don't care at all.
- Speaker detection shows the detected names as chips; tapping a chip lets you merge (`HAMLET` + `Hamlet` + `HAM.`) or un-mark it as a speaker.
- **Undo everything:** a single `↺ Reset to original` — we always keep the raw imported string forever, so cleanup is non-destructive and re-runnable later from Text Overview.

**Primary action.** "Looks right" → if ≥2 speakers detected, go to Speakers (Screen 8); else go straight into the **Reader** (not the Overview — momentum matters).

---

### Screen 7 — Structure editor

**Purpose.** Line-level surgery for the 20% of texts that cleanup can't fix. Deliberately *not* a rich text editor.

**Layout.** A vertical list of Lines. Each line is a row with:
- a drag handle (⋮⋮) on the left for reordering,
- the line text in an inline-editable field (contenteditable single-line, or `<textarea rows=1 autoresize>`),
- a role/type control on the right: `Line ▾` → `Line / Speaker name / Stage direction / Heading / Blank`,
- swipe-left on a row: `Split` / `Merge up` / `Delete`.

**Key elements.**
- **Split at cursor** is the single most-used operation. Give it a dedicated affordance: place the caret and hit `↵` (Enter) to split; `⌫` at position 0 merges up. This makes the editor behave like the text editor people already know.
- **Bulk bar** (appears on multi-select): `Mark as: Speaker / Direction / Line`, `Delete`, `Move to block`.
- **Block boundaries** render as thin labelled dividers you can drag.
- **Never-mask marks:** select any words → `Always show`. Useful for names, numbers, foreign words. Renders with a dotted underline in the editor.
- Autosaves continuously (debounce 400ms) with a subtle "Saved" in the header; no Save button; `Done` returns to whence you came.

**Primary action.** None — it's a work surface. `Done`.

---

### Screen 8 — Speakers / Role picker

**Purpose.** "I'm playing Ophelia. Hide only her lines. Keep everyone else visible so I know my cues."

```
┌─────────────────────────────┐
│ ‹          Who are you?     │
│                             │
│  Practise only your lines.  │
│  Everyone else stays        │
│  visible as cues.           │
│                             │
│  ┌───────────────────────┐  │
│  │ ◉ OPHELIA    38 lines │  │
│  │   ▓▓▓▓▓▓▓▓░░░░  41%   │  │  ← share of the text
│  ├───────────────────────┤  │
│  │ ○ HAMLET     52 lines │  │
│  ├───────────────────────┤  │
│  │ ○ POLONIUS    9 lines │  │
│  └───────────────────────┘  │
│                             │
│  ○ Everyone (whole text)    │
│                             │
│  Cue lines                  │
│  ( ) Show in full           │
│  (•) Show last 3 words only │  ← "cue tail", the pro option
│  ( ) Hide too               │
│                             │
│ ┌───────────────────────┐   │
│ │  Rehearse as Ophelia  │   │
│ └───────────────────────┘   │
└─────────────────────────────┘
```

**Key elements.** Radio list of speakers with line counts and a share bar; an "Everyone" escape hatch; and the **cue-line treatment** control — this is the feature that makes actors love the app. "Show last 3 words only" mimics how rehearsal actually works: you only need the tail of the cue. Configurable 1–6 words.

Also here: `Mute other speakers` (visually de-emphasise cue lines to 70% opacity — always on, not optional; it's what makes your own lines scannable).

**Primary action.** "Rehearse as <name>" → Reader with `roleFilter` set. The chosen role is remembered per Text and is switchable from the Reader's Session sheet without leaving the Reader.

---

### Screen 9 — Text Overview

**Purpose.** The text's home. Reached via the row chevron, not the main tap. Answers "what state is this in, and what should I do next".

**Sections, top to bottom.**
1. **Title** (inline editable), folder chip, meta (words, lines, speakers, added date).
2. **Big primary button: `Rehearse`** — resumes exact prior state. Secondary: `Start fresh` (Stage 1).
3. **Current setup card:** Method · Stage · Role · autoscroll WPM — each tappable to change. This is a read-out, not a form.
4. **Confidence strip:** a per-line heatmap rendered as a compact stack of thin horizontal bars, one per line, coloured by peek frequency (§9.7). Tapping a bar jumps the Reader to that line. This is the highest-value information design in the app: it shows you *where* the text is weak at a glance.
5. **Recent runs:** last 5 with date, stage, duration, peeks.
6. **Actions list:** Edit structure · Change role · Re-run cleanup · Export as text · Duplicate · Move to folder · Delete.

**Primary action.** `Rehearse`.

---

### Screen 10 — THE READER

Specified in full in §3.

---

### Screen 11 — Method sheet

**Purpose.** Change *how* the text is hidden. Reached from the Reader's control sheet.

**Layout.** Bottom sheet at 85dvh, scrollable, 2-column grid of Method cards. **Each card renders a live 3-line preview using the user's own text at the current stage.** This is non-negotiable: method names are meaningless, the preview is instantly legible.

```
┌─────────────────────────────┐
│ ══                          │  ← drag handle
│ Method                      │
│ ┌──────────┐ ┌──────────┐   │
│ │Some words│ │First      │   │
│ │▁▁▁ be, or│ │T▁ b▁, o▁ │   │
│ │not to ▁▁ │ │n▁ t▁ b▁  │   │
│ │      ✓   │ │          │   │
│ └──────────┘ └──────────┘   │
│ ┌──────────┐ ┌──────────┐   │
│ │Line ends │ │Whole      │   │
│ │To be, ▁▁▁│ │lines      │   │
│ │▁▁▁▁▁▁▁▁▁ │ │▁▁▁▁▁▁▁   │   │
│ └──────────┘ └──────────┘   │
│  … (scroll for 8 more)      │
│ ─────────────────────────── │
│ Difficulty                  │
│   Stage 3 of 6 · 45% hidden │
│   ◀ Easier      Harder ▶    │
│   ⚙ Custom…                 │
└─────────────────────────────┘
```

Selecting a method applies it instantly behind the sheet (the sheet is translucent-ish over the text? **No** — use an opaque sheet but shrink it to 55dvh so 3–4 lines of live text stay visible above it. Solves preview-vs-reality without transparency legibility problems).

**Primary action.** Tap a method card.

---

### Screen 12 — Text sheet ("Aa")

**Purpose.** Typography and theme, applied live, one thumb.

Compact bottom sheet, 40dvh, so plenty of text stays visible:
- **Size:** `A−` / slider / `A+`, showing the px value. Range and behaviour in §3.2.
- **Line spacing:** 3-position segmented control (Snug / Normal / Airy) — a slider here is over-precision.
- **Line width:** slider in `ch` (Narrow ↔ Wide), disabled in teleprompter mode.
- **Font:** horizontally scrolling chips, each rendered *in its own face*: System · Hyperlegible · Serif · Mono · Dyslexic.
- **Theme:** Auto / Light / Dark / High contrast (4-up segmented).
- **Blank style:** Underline / Box / Dots / Dashes — and a `Same width as word` toggle (§3.4).

**Primary action.** Any control; changes are immediate and persisted globally (not per text) with a per-text override only for size.

---

### Screen 13 — Session sheet

**Purpose.** Turn aimless re-reading into a structured session. Optional — the app is fully usable without ever touching this.

- **Goal:** `Free practice` (default) / `N clean runs` (1–5) / `Time` (5/10/15/20 min) / `Ladder to the top`.
- **Auto-advance:** `Move up a stage after a clean run` (toggle, default ON). Definition of a clean run: zero peeks on my lines. Shown as an explainer under the toggle, because ambiguity here breeds distrust.
- **Autoscroll:** on/off + WPM stepper.
- **Range:** `Whole text` / `From line __ to __` / `Weak lines only` / `Current block`.
- **Role:** re-entry to Screen 8's radio list.
- **Metronome/count-in:** off / 3-2-1 countdown before autoscroll starts.

**Primary action.** `Start session`.

---

### Screen 14 — Debrief

**Purpose.** Close the loop with something honest and actionable, in under 5 seconds of reading. Not a trophy ceremony.

```
┌─────────────────────────────┐
│                             │
│      Run complete           │
│                             │
│      4 peeks                │  ← the hero number, 48px
│      in 42 lines            │
│                             │
│  ▂▃▁▁▂▁  last 6 runs (peeks)│  ← sparkline, down is good
│                             │
│  Stage 3 · 45% hidden       │
│  3 min 12 s · 118 wpm       │
│                             │
│  Tripped on                 │
│  ┌───────────────────────┐  │
│  │ …the slings and       │  │
│  │  arrows…        3 ×   │  │
│  ├───────────────────────┤  │
│  │ …a sea of troubles…   │  │
│  │                 2 ×   │  │
│  └───────────────────────┘  │
│                             │
│ ┌───────────────────────┐   │
│ │  Drill these 5 lines  │   │
│ └───────────────────────┘   │
│  Run again  ·  Harder ▶     │
│  Done                       │
└─────────────────────────────┘
```

**Key elements.**
- **Peeks is the hero metric**, not time, not a score out of 100. It's the only number that directly measures recall failure, it's unfakeable, and lower-is-better keeps it honest.
- Sparkline of the last 6 runs' peek counts for the same text (only shown once ≥2 runs exist).
- **"Tripped on"** — up to 5 lines with the most peeks, quoted with ellipsis context. Tapping one jumps into the Reader at that line.
- **`Drill these 5 lines`** is the primary action: it starts a new run with `range = weak lines`, at the same stage. This is the app's single strongest habit loop and should be one tap.
- If auto-advance fired: an inline note *"Clean run — moved you up to Stage 4."* with an `Undo` link. Never silently change difficulty.
- Reduced-motion respected: the sparkline doesn't animate, there is no confetti anywhere in this app.

**Primary action.** `Drill these 5 lines` (falls back to `Run again` when there were 0 peeks, with copy *"Nothing to drill. Try Stage 4?"*).

---

### Screen 15 — Progress / Stats

**Purpose.** Prove to the user that the effort is compounding, without turning into a streak-guilt machine.

- **This week:** minutes rehearsed (bar per day, 7 bars), runs completed.
- **Peeks per 100 words**, trend line over 30 days — the one real "am I getting better" number, normalised so it's comparable across texts.
- **Per-text table:** name, best stage reached, last practised, peeks trend arrow. Sortable. Tapping → that text's detail stats.
- **Calendar heatmap** of practice days (12 weeks). Deliberately *not* a streak counter with a flame — missing a day should not feel like failure to a person who has an audition on Thursday.
- Empty state at §8.2.

All stats are computed from the local run log; nothing leaves the device.

---

### Screen 16 — Settings

Grouped list, standard iOS/Android list semantics, each group on its own subpage on mobile (avoids one 40-row scroll).

1. **Appearance** — theme, font, size, line spacing, line width, blank style, high contrast, brightness dim (a full-screen overlay dimmer below OS minimum, genuinely useful for dark rehearsal spaces).
2. **Reader** — default method, default autoscroll WPM, scroll style (smooth/stepped), keep screen awake, haptics, peek duration, peek behaviour (hold / tap-to-toggle / timed), tap-empty-space action, show line numbers, show progress bar.
3. **Gestures** — handedness (mirrors the bottom bar), enable swipe navigation, enable pinch-to-resize, enable two-finger peek, "reduce accidental taps" (raises long-press threshold to 600ms).
4. **Accessibility** — reduce motion (Auto/On/Off overriding the OS), screen-reader verbosity (Terse "blank" / Verbose "blank, word 3 of 9"), announce stage changes, larger tap targets (bumps everything to 48px min), dyslexia pack (font + letter/word spacing + line focus).
5. **Data** — storage used, Backup & Restore (Screen 17), export all as plain text/Markdown, delete all data (double confirm, typed word).
6. **About** (Screen 18).

---

### Screen 17 — Backup & Restore

**Purpose.** The price of local-first is that the user is their own sysadmin. Make it trivially easy and slightly insistent.

- **`Export backup`** → single `.offbook.json` file (texts + folders + settings + run history), timestamped filename `offbook-backup-2026-07-28.json`. Uses File System Access API `showSaveFilePicker` where available, else an `<a download>` blob. Also offers `navigator.share` on mobile so it can go straight to Files/iCloud/Drive.
- **`Restore`** → file picker → **a diff preview before anything is written**: *"This backup has 14 texts (3 you don't have, 11 that match, 2 newer than yours)."* Then two explicit choices: `Merge (keep both)` / `Replace everything`. Replace requires a second confirm.
- **Reminder nudge:** if >30 days since last export AND >5 texts, show a dismissible banner in the Library once. Never a modal.
- **Storage health card:** shows `navigator.storage.estimate()` usage, and whether `navigator.storage.persisted()` is granted; a `Make storage permanent` button that calls `persist()`. Explain plainly: *"Browsers can clear data to free space. This asks yours not to."* Note the honest caveat for Safari: data can be evicted after 7 days of no use in some configurations — so the export nudge matters more on iOS.
- **Optional, later:** "Sync via a file in your cloud folder" — desktop-only, File System Access handle persisted in IndexedDB, writes the same JSON on change. Zero server cost. Explicitly out of scope for v1.

---

### Screen 18 — About

Version, what the app is in two sentences (our own words), **Privacy: "No accounts. No analytics. No network requests after the app loads. Your texts never leave your device."**, open-source licences (pdf.js, fonts — Atkinson Hyperlegible is OFL, note attribution requirement), a "Replay intro" link, and the rights reminder from §0.1. No links to competitors, no comparison table.

---

### Screen 19 — Search

Full-screen overlay from the Library header. Searches titles **and line content** (line content matches are the surprise delight: *"which speech was 'undiscovered country' in?"*). Results grouped `Texts` / `Lines`, line matches showing the line with the query highlighted, tapping a line result opens the Reader scrolled to it. Debounced 150ms, case/diacritic-insensitive, works offline over IndexedDB with a simple in-memory index built on first search.

### Screen 20 — Shortcuts overlay

`?` on desktop. A two-column card listing §5.6's table. Dismiss with `Esc`, `?`, or click-out.

---

## 3. THE READER — full specification

This is the screen. Everything above is plumbing.

### 3.1 Anatomy

```
 ┌───────────────────────────────────┐
 │ ‹  Hamlet 3.1        Stage 3  ⋮   │  status rail, 44px, auto-hides
 ├───────────────────────────────────┤
 │                                   │
 │  HAMLET                           │  ← speaker label, 13px, muted, tracked
 │                                   │
 │  To be, or not to be, that is     │
 │  the ▁▁▁▁▁▁▁▁:                    │
 │  Whether 'tis nobler in the mind  │  ← CURRENT LINE (tinted, left rule)
 │  to ▁▁▁▁▁                         │
 │  The slings and ▁▁▁▁▁▁ of         │
 │  outrageous fortune,              │
 │                                   │
 │       (reading zone: 40% from top)│
 │                                   │
 │                                   │
 │            ══════                 │  ← sheet drag handle
 ├───────────────────────────────────┤
 │  ▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░  progress  │  2px, position in text
 │  Aa    ◀ Easier   Harder ▶    ▶   │  control bar, 64px + safe area
 └───────────────────────────────────┘
```

Three layers only: **status rail** (top, disposable), **text canvas** (everything), **control bar** (bottom, thumb-reachable, disposable). No sidebars, no floating buttons over text, no toolbar in the middle.

**Status rail.** Back chevron (44px), title (truncated, tappable → Text Overview), Stage chip, overflow `⋮`. Auto-hides on scroll-down, returns on scroll-up or on a tap in the top 15% of the screen. Fully gone in Focus mode.

**Stage chip.** Reads `Stage 3` normally, `45%` when the user is in Custom, `Words` / `First letters` / `Lines` prefix when it aids clarity, e.g. `Words · 45%`. Tap → Method sheet. **Long-press → reveal everything while held** (see §5.2).

**Control bar.** Five targets, each 56×56 with 8px gaps (= 320px, fits a 375px viewport with 27px of side margin):
`Aa` · `◀ Easier` · `Harder ▶` · `▶/⏸ autoscroll` · `⋯ more`
Above them, a 2px progress rule showing scroll position through the text (not stage — stage lives in the chip).
Handedness setting mirrors the order so the two most-used controls (Harder, autoscroll) sit under the dominant thumb.
The whole bar sits above `env(safe-area-inset-bottom)` and auto-hides in Focus mode.

**Reading zone.** The current line is kept at **40% of viewport height**, not centred. Reason: when reading forward you want more text below than above; 40% is the standard teleprompter compromise and it keeps your eyeline up (good for actors, who shouldn't be looking at their chin).

### 3.2 Typography

Getting this right is most of the app's perceived quality.

| Property | Value | Rationale |
|---|---|---|
| **Font (default)** | System UI stack: `-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", Roboto, sans-serif` | Zero bytes, zero layout shift, already familiar, excellent hinting. A memorisation app must not gate first paint on a webfont. |
| **Font (option: Hyperlegible)** | Atkinson Hyperlegible Next, self-hosted, Latin subset woff2 (~40 KB), `font-display: swap` | Every glyph disambiguated (I/l/1, 0/O). Best single choice for low vision and for glancing at text from 60cm away on a music stand. Braille Institute, OFL — attribution in About. |
| **Font (option: Serif)** | Literata or Source Serif 4, subset (~45 KB) | Some users memorise verse better in a serif; long-form reading comfort. |
| **Font (option: Mono)** | System mono | Makes **first-letter mode** column-align, which genuinely helps that method. |
| **Font (option: Dyslexic)** | OpenDyslexic, self-hosted | Ship it because *preference* matters and users ask for it by name — but do **not** default to it or claim efficacy: the evidence that it improves dyslexic reading speed/accuracy is weak-to-absent. Hyperlegible is the better-evidenced default for the same users. |
| **Size** | **18–44px** on mobile, 18–72px desktop, default **22px**. Slider in 2px steps; pinch-to-resize maps to the same scale. | 22px default is deliberately larger than web body text: this is read at arm's length, sometimes while moving. 18px floor because below that, masked blanks become hard to target. |
| **Line height** | Snug 1.45 / **Normal 1.65** / Airy 1.95 | 1.65 default. Higher than typical prose because (a) masked blanks add visual noise, (b) generous leading makes line-tracking during recall much easier, (c) it gives the current-line highlight room to breathe. |
| **Measure** | **32ch default**, range 24–60ch, expressed as `max-width: 34ch` (use `ch` so it tracks font changes) | 32ch ≈ 45–55 characters — narrow. Prose guidance says 60–75ch, but memorisation is not prose reading: short lines chunk the text, and script/verse lines are naturally short. Narrow measure also means fewer wrapped lines, which means the line numbers you remember stay stable. |
| **Alignment** | Always **left-aligned, ragged right, `hyphens: none`, `text-wrap: pretty`** | Justified text creates rivers and variable word spacing, which is actively harmful when word *positions* are part of your spatial memory. Never justify. Never hyphenate — a broken word breaks recall. |
| **Letter / word spacing** | `letter-spacing: 0` default; accessibility pack offers `0.06em` / `word-spacing: 0.14em` | WCAG 1.4.12 text-spacing values as the top of the range; must not break layout. |
| **Line wrapping model** | An authored Line that wraps renders as one logical line with a hanging indent of `1.25em` on continuation rows | Makes it visually obvious that a wrapped continuation is not a new verse line. Critical for verse and for scripts. |
| **Numerals** | `font-variant-numeric: tabular-nums` on all counters/timers | No jitter in the timer. |
| **Speaker labels** | 0.62em of body size, weight 600, `letter-spacing: 0.06em`, uppercase, `--text-muted`, 0.75em bottom margin | Present but subordinate. Uppercase is the script convention and reads as metadata, not content. |
| **Stage directions** | 0.85em, italic, `--text-faint`, never masked | Convention, and they're not memorised. |

**Font size and reflow.** Changing size, line height, measure, font, or orientation must preserve reading position. Implementation: before the change, record the *logical line index* nearest the 40% reading zone plus its intra-line character offset; after the change, `scrollTo` that line's new offset. Do not try to preserve pixel scrollTop — it drifts badly. Debounce during a slider drag using rAF, applying the anchor correction each frame.

### 3.3 Line rendering & the current line

- Each logical Line is a block element with `data-line="n"`.
- **Current line** = the line whose box overlaps the reading zone, or the line the user last explicitly advanced to (stepped mode / keyboard), whichever is more recent. Tracked with a single `IntersectionObserver` with a `rootMargin` that creates a thin band at 40% height — cheap, and no scroll-event thrash.
- **Current line treatment:** a 3px left rule in `--accent` at `-16px` offset, plus a very low-contrast background tint (`--line-current-bg`). *No* bold, *no* size change, *no* colour change to the text itself — any of those cause reflow or reduce legibility. The tint plus rule is enough.
- **Line focus mode** (accessibility/dyslexia pack, and useful for everyone in Stage 1): all lines except current ± 1 drop to `opacity: 0.32`, with a 120ms transition (0ms under reduced motion). This is the single most effective concentration aid in the app and should be one tap away in the `⋯` menu, not buried in Settings.
- **Line numbers** (optional, off by default): 0.7em, `--text-faint`, in a 3ch left gutter, `tabular-nums`. Actors use them to communicate with a director; turn them on and the gutter appears without shifting the text measure (the gutter is outside the measure box).
- **Blocks** are separated by `1.25em`; a Speaker label opens each block.

### 3.4 The masked token — treatment and mechanics

The most important 40 lines of CSS in the app.

**Hard rule: the masked word's characters are never in the DOM.** The token renders as an empty inline element with a reserved width. The word lives only in JS state and is injected on reveal, then removed again. This gives us, in one decision: screen readers can't leak it, `Ctrl+F` can't leak it, "select all → copy" can't leak it, and a curious user can't defeat the exercise with devtools' Inspect (well — they can, but not accidentally).

```html
<!-- masked -->
<button class="tok tok--masked" data-i="17" style="--w:5.2ch"
        aria-hidden="true" tabindex="-1"></button>
<!-- revealed (peeked) -->
<button class="tok tok--peeked" data-i="17">question</button>
```
(Why `aria-hidden` + a line-level label: §7.2. Why a `<button>`: it gets keyboard/AT activation semantics for free, and `type=button` inside a non-form context has no side effects.)

**Visual treatment — the four blank styles:**

| Style | Rendering | When it wins |
|---|---|---|
| **Underline** (default) | Transparent background, `border-bottom: 2px solid var(--mask-rule)`, `border-radius: 0`, the box inset by 1px each side | Lowest visual noise; the page still reads as *text with gaps*, not as a form. Highest legibility of the surrounding words. |
| **Box** | `background: var(--mask-fill)`, `border-radius: 4px`, no border, plus a 1px inset ring at high contrast | Most visible from a distance; best for teleprompter and for low vision. |
| **Dots** | `border-bottom: 2px dotted` | Softer; some users find solid rules read as strikethrough. |
| **Dashes** | Renders `–` characters? **No** — renders a repeating-linear-gradient bottom border | Never insert characters; keeps the no-text-in-DOM rule intact. |

**Width.** `width: var(--w)` where `--w` is the measured advance width of the hidden word in the current font, computed once per (word, font, size) with a single offscreen `CanvasRenderingContext2D.measureText` and cached in a Map. Two settings:
- **`Same width as word` = ON (default):** blanks are the true word width. Preserves the paragraph's shape and therefore the user's spatial memory of where things are, and gives a legitimate length cue (a 3-letter blank is different from an 11-letter blank). This is why we bother measuring.
- **OFF (harder):** every blank is a uniform `3.5ch`. Removes the length cue, and *does* reflow the text — so this setting must be a deliberate, explained choice, and switching it re-anchors scroll position per §3.2.

**Reveal / peek behaviour.**
- Peek is a **hold**: press → after 140ms (below long-press threshold, so it feels instant) the word appears; release → it fades back over 180ms. Configurable to `Tap to toggle` (better for tremor / switch users) or `Timed 1.6s`.
- The revealed word appears in `--peek-text` (a warm amber, distinct from body text) on `--peek-bg`, then decays to normal-masked. The colour matters: it marks "this one cost you something", and it makes the peek visible in your peripheral vision so you notice you're leaning on it.
- **No layout shift on reveal.** Because the blank was already the word's true width, the word slots into exactly its own space. With `Same width` OFF, accept a shift but constrain it: `min-width: var(--w)` on reveal so it only ever grows.
- Every peek increments `run.peeks[lineIndex]`, which powers the confidence heatmap, the debrief, and "drill weak lines". Peeks are the app's core telemetry — local only.
- **Reveal everything:** two-finger hold, or long-press the Stage chip, or `R` on desktop, or the `⋯` menu. All the same action, all temporary-while-held, with a `Keep revealed` toggle for when you just want to read it through.

**Punctuation is never masked** (it stays outside the token) and neither are: words marked `Always show`, numbers if `Keep numbers visible` is on, and single-character words unless `Include short words` is on. Rationale: masking "a" and "," teaches nothing and makes the page look like redacted CIA files.

### 3.5 One-handed reach on a phone

- Everything interactive that matters is in the bottom **160px** (control bar + progress + drag handle). Measured against a 6.1" phone held in the right hand, the natural thumb arc covers roughly the bottom 45% and the right 70% of the screen — the control bar sits squarely inside it.
- **Targets:** 56×56px for control-bar buttons (above the 44px iOS / 48dp Android minimums, because these get hit while distracted). 44px minimum everywhere else. `Larger tap targets` in Settings raises secondary controls to 48px.
- **Nothing critical in the top corners.** Back is there because platform convention demands it, but the back gesture and the OS back button also work, and the Reader is exitable from the `⋯` sheet.
- **Handedness toggle** mirrors the control bar order. Cheap to build (`flex-direction: row-reverse`), disproportionately appreciated by left-handers.
- **The whole text canvas is the "advance" target** in stepped mode (tap anywhere in the middle 70% of the screen), so the most frequent action needs no aiming at all.
- Use `100dvh`, not `100vh`, and `interactive-widget=resizes-content` in the viewport meta, so the control bar doesn't hide behind iOS Safari's collapsing toolbar or a keyboard.
- Sheets are **bottom sheets with drag handles**, always. Never a centred dialog for anything the user does often.

### 3.6 Focus mode (distraction-free full screen)

- **Entry:** tap the text canvas edge zones? No — ambiguous. Entry is: `⋯ → Focus mode`, or `F` on desktop, or a **two-finger swipe up**. Exit: tap once anywhere (chrome returns), or `Esc`.
- **What it does:** hides status rail, control bar, progress rule, and tab bar; sets `--reader-pad-top: 12dvh`; requests the Fullscreen API (`element.requestFullscreen()` on the reader root) where supported so browser chrome goes too. Note iOS Safari does **not** support Fullscreen API on iPhone (only iPad); on iPhone we fall back to hiding our own chrome + `apple-mobile-web-app-capable` behaviour when installed. Do not show a "go fullscreen" button that does nothing — feature-detect and relabel to `Hide controls`.
- **Chrome auto-hide (the softer, default behaviour):** even outside Focus mode, both bars fade out after 4s of no interaction *while autoscroll is running*, and return on any touch. When autoscroll is off, bars persist (people are tapping to advance).
- While chrome is hidden, keep an always-present but nearly invisible affordance: a 4px, 20%-opacity handle at the bottom centre. Discoverability without noise.

### 3.7 Landscape

Landscape is not an afterthought — singers put a phone on a music stand in landscape, and actors use it for teleprompter work.

- Viewport height collapses to ~390px, so: status rail hides by default, and the **control bar becomes a vertical rail on the trailing edge** (56px wide, buttons stacked) so it eats width (which we have) instead of height (which we don't).
- `max-width` still applies — text does **not** stretch to 900px. Centre the measure and let the margins be empty. Resist the urge to fill.
- The reading zone moves to **45%** in landscape (less text visible, so centre-ish is better).
- Two-column landscape is tempting and is a **trap**: a column break in the middle of a speech destroys the vertical scroll model, the autoscroll math, and the user's sense of position. Explicitly rejected.
- Orientation change re-anchors scroll to the current line (§3.2) and re-measures token widths.

### 3.8 Keeping the screen awake

- **Screen Wake Lock API.** `navigator.wakeLock.request('screen')`. Support as of mid-2026 is effectively universal on our targets: Chrome/Edge 84+, Firefox 126+, **Safari 16.4+ (macOS and iOS)**, Samsung Internet 14+, ~94%+ global. One important caveat: in **installed iOS PWAs** the API was broken by a long-standing WebKit bug until **iOS 18.4**, so an installed home-screen app on iOS 16.4–18.3 will accept the request and still let the screen sleep.
- **Lifecycle:** the lock is auto-released when the document becomes hidden, so we must re-acquire on `visibilitychange → visible` if the session is still active. Also release explicitly on session end / leaving the Reader / autoscroll pause after 2 minutes idle — never hold it silently forever, it's the user's battery.
- **When we hold it:** whenever autoscroll is running, or a Session is active, or (setting) always while the Reader is open. Default: **during autoscroll and active sessions only**.
- **UI:** a small `☀` indicator in the status rail when held (subtle, `--text-faint`), tappable to toggle. On unsupported browsers or if `request()` rejects (`NotAllowedError` — e.g. low power mode), the toggle shows as unavailable with honest copy: *"Your browser won't let a web page keep the screen on. Set your screen timeout longer, or install the app to your home screen."*
- **Do not** ship the silent-looping-`<video>` hack as a fallback. It burns battery, can trip audio focus, and on iOS it's unreliable anyway. A clear explanation beats a flaky trick.

### 3.9 Auto-scroll

**Speed model — use WPM, not "speed 1–10".** Speaking rate is a number performers already understand (conversational ≈ 130 wpm, stage delivery 100–140, auctioneer 250). Derive pixels/second from the actual layout so it self-calibrates to font size, line height, and measure:

```
pxPerSecond = (wpm / 60) * (totalScrollableHeight / totalWordCount)
```

Recompute on any layout change. Default **120 wpm**; range 60–260 in steps of 5 (fine steps near the low end where it matters).

- **Smooth vs stepped.** Ship **both**; default **smooth**.
  - *Smooth:* rAF loop advancing fractional `scrollTop` (accumulate in a float, assign each frame). Do **not** use `scrollBy({behavior:'smooth'})` in a loop — it fights itself. At <0.4 px/frame the motion looks like judder on 60Hz, so below that threshold switch to advancing by whole pixels on a fractional schedule.
  - *Stepped:* scrolls exactly one logical line at a time, positioning the next line at the reading zone, with a 180ms ease. Feels like a teleprompter operator following you. Better for verse, for texts with wildly uneven line lengths, and for anyone who finds continuous motion nauseating.
  - **`prefers-reduced-motion: reduce` forces stepped**, and stepped becomes tap-driven rather than timer-driven unless the user opts back in.
- **Pause on touch.** `touchstart` anywhere in the canvas pauses immediately (and the pause is *visible*: the `▶` becomes `⏸` and a 1s ghost toast says `Paused`). Resume: (a) automatically after **2.5s** of no touch *if* the pause came from a scroll/peek, (b) never automatically if the user tapped the pause button. Distinguishing "the user grabbed the text to look back" from "the user wants it to stop" this way is what makes autoscroll feel obedient rather than aggressive.
- **Pause on peek**, always. Revealing a word means you've lost the thread; scrolling on would be cruel.
- **Manual scrub while running:** dragging the text works normally (the rAF loop just adds to wherever you left it after the resume delay). Never fight the user's finger.
- **End of text:** decelerate over the last 1.5s, stop, and present the Debrief after a 600ms beat.
- **Speed adjustment while running:** long-press `▶` opens a horizontal WPM slider in place *without* stopping, with a live readout. Also `[` / `]` on desktop, ±5 wpm.
- Count-in: optional `3 · 2 · 1` (visual only by default; a tick sound is opt-in) so you can start speaking on time.

### 3.10 Teleprompter mode

A distinct mode, entered from `⋯ → Teleprompter`, not just "big text".

- **Type:** size range **44–120px**, default 64px; line height 1.35 (tighter, because you're reading a phrase at a time, not studying); measure widens to 24–32ch of the larger size; weight bumps to 500 for distance legibility; letter-spacing `0.005em`.
- **Centre indicator line:** a horizontal rule at the reading zone (40%), 1px, `--accent` at 40% opacity, extending 24px beyond the text measure on both sides, plus two small triangular ticks at each end. Optional (on by default in this mode).
- **Mirror:** `transform: scaleX(-1)` on the text canvas for beam-splitter glass rigs. Must also flip: nothing else. Controls stay unmirrored and must move *outside* the mirrored container — a classic bug. Also offer `scaleY(-1)` (some rigs need vertical flip) as a second toggle. Label them **Flip horizontally / Flip vertically**, not "mirror mode", because users know which way their rig is wrong.
- **Chrome:** fully hidden; tap anywhere = pause/resume (the whole screen is the pause button — you're 2m away holding a script, precision is impossible). Speed and size get large on-screen `−/+` pills that appear on tap and fade after 3s.
- **Masking still works in teleprompter mode** — that's our twist on the format and it's genuinely useful: a teleprompter that gradually stops helping you.
- Landscape is assumed but not forced.
- Wake lock is always held in this mode.

### 3.11 Dark mode & high contrast

- **Three themes plus auto:** Light, Dark, High Contrast (which has a light and dark variant, following the same auto signal). `prefers-color-scheme` drives Auto; a manual choice is sticky and stamped as `data-theme` on `<html>` so it wins in both directions.
- Dark mode is a **true dark grey (`#121417`), not black**, and body text is a warm off-white (`#EDEBE6`, 15.5:1) rather than pure white — pure white on pure black at 22px causes halation, which is exactly the wrong thing when someone is staring at a phone in a dark wing waiting to go on.
- **`prefers-contrast: more`** switches to High Contrast automatically. HC = pure `#000`/`#FFF` text, 21:1, masked blanks get a 2px solid rule *and* fill, current-line gets a 4px rule, all decorative tints removed, focus rings 3px.
- **Brightness dim overlay:** a `position: fixed` black layer with adjustable opacity (0–70%) above everything except the control bar, letting the user go below the OS minimum brightness. Real-world useful in a dark theatre; make sure it's `pointer-events: none` and that it's obvious how to undo (the control that sets it stays above it).
- Never invert or dim the masked-blank rule in dark mode below the 3:1 non-text threshold (§9.5 has verified values).

---

## 4. Difficulty control — resolving the three-controls problem

Three plausible controls exist: a **percentage slider**, **Harder/Easier buttons**, and an **auto-ladder**. Shipping all three as peers would be confusing (which one is authoritative? what happens if I drag the slider and then press Harder?). The resolution is a single state machine.

### 4.1 One source of truth

```
difficulty = { ladderIndex: 0..N }  |  { custom: 0..100 }
```
Exactly one of these is active. Everything in the UI is a view onto it.

### 4.2 The Ladder is primary

Each Method defines its own ordered ladder of Stages. For **Hide words**:

| Stage | Hidden | Label shown in chip |
|---|---|---|
| 1 | 0% | `Read through` |
| 2 | 20% | `Stage 2` |
| 3 | 45% | `Stage 3` |
| 4 | 70% | `Stage 4` |
| 5 | 100% words, first letters kept | `First letters` |
| 6 | 100%, nothing kept | `From memory` |

Six rungs, named at the ends where names help. Ladders are per-method (Hide lines has a different, count-based ladder; see §6.2).

**`◀ Easier` / `Harder ▶` step the ladder by one.** These are the two big buttons in the control bar. They are the primary difficulty control because:
- They're one thumb-tap with no aiming and no precision, usable mid-recitation.
- They're monotonic and predictable — the user builds a mental model of "six steps to off-book".
- They never require reading a number.
- They map 1:1 to how people actually work: *this pass was fine, hide more.*

Feedback on press: the chip animates the number, a 900ms toast states the outcome in words (`Stage 4 — 70% hidden`), haptic tick (`navigator.vibrate(10)` where supported), and the newly-masked words fade out over 200ms rather than popping (0ms under reduced motion). At the ends, the button disables with the chip reading `Read through` / `From memory` — never a dead tap with no explanation.

**Re-masking is stable.** Going Easier then Harder must return to the *same* mask set, and going up a stage must be a **superset** of the previous stage's mask. Implementation: derive masks from a seeded PRNG per (text, method, seed) that assigns every token a stable priority score in [0,1); a stage at `p%` masks all tokens with score < p. This makes the ladder feel like a curtain lowering rather than a dice roll, which matters enormously for the sense of progress. A `↻ Reshuffle` action in the Method sheet advances the seed for when the user has memorised *this particular* pattern rather than the text.

### 4.3 The percentage slider is demoted to "Custom"

- It lives **only inside the Method sheet**, under a collapsed `⚙ Custom…` disclosure. It is not on the Reader's control bar and not in the chip.
- Touching it switches state to `{custom: n}`. The chip then reads `Custom · 43%`, and — importantly — `Harder`/`Easier` keep working, stepping the custom value by ±10% (clamped 0–100). So the buttons never become dead, and the user is never trapped in a mode.
- A `Back to stages` link in the Method sheet returns to the nearest ladder rung, stated explicitly: *"Return to Stage 3 (45%)"*.
- Why keep it at all: a small number of users want 82%, and the slider is a useful *explanation* device — it makes the abstract stages concrete when you first look at it.

### 4.4 The auto-ladder is a *behaviour*, not a control

- Expressed as one toggle in the Session sheet: **`Move up a stage after a clean run`** (default ON).
- It **drives the same `ladderIndex`**. It is not a parallel notion of difficulty.
- When it fires it must be loud enough to notice and never a surprise: the Debrief says *"Clean run — moved you up to Stage 4"* with an `Undo`. It never fires mid-run, only at a run boundary.
- It does nothing in Custom mode (with an explanation shown in the Session sheet when Custom is active: *"Auto-advance is paused while you're using a custom percentage."*).
- There is deliberately **no auto-*demote***. Automatically making things easier feels like the app judging you. Instead, after two runs with peeks > 15% of masked words, the Debrief offers: *"That stage is fighting you. Try Stage 3 again?"* — a suggestion with a button, never an automatic change.

### 4.5 Summary of the hierarchy

| Control | Prominence | Where |
|---|---|---|
| **Harder / Easier (ladder)** | **Primary** | Reader control bar, 56px buttons, 2 of 5 slots |
| Stage chip | Read-out + entry point | Status rail; tap → Method sheet |
| Auto-advance toggle | Set once, forget | Session sheet |
| % slider | Advanced escape hatch | Method sheet → `⚙ Custom…`, collapsed |
| Per-method extras (chunk size, cue tail length, letters kept) | Method-local | Inside the selected method's card |

---

## 5. Gestures & controls — complete map

### 5.1 Design constraints that shape every gesture

1. In the Reader, **native text selection must be off** (`user-select: none; -webkit-touch-callout: none`) because long-press is our peek gesture and because the iOS selection UI (magnifier + handles + callout bar) would otherwise appear over the text on every peek. This is a real cost: the user can't select a quote to copy. Mitigations: (a) a `Select text` item in `⋯` that toggles selection on and peek off for as long as it's active, (b) `Copy full text` and `Copy this line` actions, (c) the Structure editor always allows selection.
2. **Double-tap-to-zoom must be suppressed** on the canvas: `touch-action: manipulation` on the reader root (kills the 300ms double-tap-zoom delay too, making single taps feel instant). Keep browser zoom available *outside* the Reader, and never set `user-scalable=no` in the viewport meta — that's a WCAG 1.4.4 failure. Inside the Reader, pinch-to-resize-text is the accessible substitute and it's strictly better than pinch-zoom for this content (no horizontal panning).
3. **iOS edge back-swipe** cannot be reliably disabled, and in installed PWAs it varies by iOS version. Therefore: **no horizontal-swipe gesture that starts within 32px of either screen edge**, and no *essential* action bound to horizontal swipe at all. Where we do use it (Library rows), it starts mid-row. In the Reader, horizontal swipe is bound to a *convenience* (prev/next block) that is also available as a button, and we `preventDefault` on `touchstart` only when the gesture begins >32px from the edge, using `{passive: false}` on a narrowly scoped listener.
4. **Vertical scroll is sacred.** Nothing may hijack a one-finger vertical drag in the text canvas. All two-finger gestures use `touch-action: pan-y` so single-finger scroll still goes to the browser.
5. **Long-press threshold 450ms** (500ms is the platform norm but feels slow when it's your main verb; 450 is safely above accidental-tap territory). Peek starts showing at **140ms** with a subtle scale/opacity cue so holding feels responsive; the 450ms threshold only gates *other* long-press actions. `Reduce accidental taps` raises it to 600ms.
6. Every gesture has a **non-gesture equivalent**. No functionality is gesture-only. This is both an accessibility requirement and a discoverability one.

### 5.2 Touch gestures in the Reader

| Gesture | Action | Notes / conflicts |
|---|---|---|
| **Tap a blank** | Peek that word (per peek-behaviour setting) | 24×24 minimum hit area via `::after { inset: -10px }`; the token itself may be narrower |
| **Tap-and-hold a blank** | Peek while held, hide on release (default) | Starts revealing at 140ms |
| **Tap canvas (middle 70%)** | *Stepped mode:* advance one line. *Smooth mode:* pause/resume autoscroll. *Autoscroll off:* toggle chrome visibility | The single most-used target; needs no aim |
| **Tap top 15%** | Show chrome (status rail) if hidden | Avoids fighting the back chevron |
| **Tap bottom 15%** | Show control bar if hidden | |
| **Long-press a line (450ms)** | Line menu: `Peek whole line` · `Always show this line` · `Start here` · `Mark as weak` · `Copy line` | Haptic on threshold |
| **Long-press Stage chip** | Reveal everything while held | The "show me the whole thing" panic button |
| **Two-finger hold (no movement >12px for 180ms)** | Reveal everything while held | The primary panic gesture; see disambiguation below |
| **Two-finger pinch** | Resize text live (maps to the size scale) | Disambiguated from two-finger hold by movement threshold; shows a live `24px` badge |
| **Two-finger swipe up** | Enter Focus mode | Down exits |
| **Two-finger swipe down** | Exit Focus mode / show all chrome | |
| **Swipe up/down (one finger)** | Scroll. Always. Never overloaded | |
| **Swipe left/right (started >32px from edge)** | Previous / next Block (speech, stanza) | Convenience only; also in `⋯`. Disabled by default for texts with no blocks |
| **Swipe down from top edge when at scroll-top** | Nothing (do not implement pull-to-refresh) | Set `overscroll-behavior-y: contain` on the canvas so a rubber-band at the top doesn't trigger the browser's PTR or navigate |
| **Double-tap canvas** | Nothing (reserved; suppressed) | Explicitly unbound so it can't be hit accidentally; `touch-action: manipulation` prevents zoom |
| **Three-finger anything** | Nothing | Reserved by iOS for undo/redo shortcuts; stay away |
| **Edge swipe (<32px)** | Left to browser (back navigation) | Deliberately ceded |

**Two-finger disambiguation state machine** (needed because hold and pinch share an entry condition):

```
on touchstart with 2 touches:
  record d0 = distance, t0 = now, mode = UNDECIDED
  start 180ms timer
on touchmove:
  if mode == UNDECIDED:
     if |distance - d0| > 12px      -> mode = PINCH (begin live resize)
     else if both touches moved >16px in same direction -> mode = SWIPE
on timer fire (180ms) while mode == UNDECIDED:
     mode = PEEK_ALL (reveal everything, hold)
on touchend/cancel: commit or release per mode; reset
```
The 180ms delay before peek-all is imperceptible in practice because the user is already holding still. Both gestures are individually disableable in Settings → Gestures for users who trigger them accidentally.

### 5.3 Touch gestures elsewhere

| Screen | Gesture | Action |
|---|---|---|
| Library row | Swipe left (from mid-row) | Reveal `Move` / `Delete` |
| Library row | Long-press | Enter multi-select, that row selected |
| Folder chip | Long-press | Rename / recolour / delete |
| Any bottom sheet | Drag handle down / swipe down anywhere on the sheet header | Dismiss |
| Any bottom sheet | Drag handle up | Expand to next detent (40 / 55 / 85 dvh) |
| Editor row | Swipe left | `Split` / `Merge up` / `Delete` |
| Editor row | Drag handle vertical | Reorder |
| Stats heatmap | Tap a cell | Show that day's runs |

### 5.4 Conflict resolution register

| Conflict | Resolution |
|---|---|
| Long-press peek vs. iOS text selection & callout | `user-select: none; -webkit-touch-callout: none` on the canvas; explicit `Select text` mode as the escape hatch; editor unaffected |
| Long-press peek vs. Android context menu | Same properties; also `oncontextmenu → preventDefault` on the canvas (desktop right-click gets our own line menu instead) |
| Double-tap zoom vs. tap-to-advance | `touch-action: manipulation`; double-tap unbound; browser zoom preserved outside the Reader; pinch-to-resize as the in-Reader substitute |
| Pinch-zoom (a11y right) vs. pinch-to-resize | Resize satisfies the same user need better for this content, and text scales to 44px+; `user-scalable` left at default so OS-level zoom (iOS Zoom, Android magnification) still works everywhere |
| Horizontal swipe vs. iOS back-swipe | 32px dead zone at both edges; horizontal swipe only ever bound to non-essential actions; nothing bound to edge swipe |
| Two-finger peek vs. pinch | 12px movement / 180ms time disambiguation (§5.2) |
| Overscroll vs. pull-to-refresh / navigation | `overscroll-behavior: contain` on the scroll container |
| Space-to-advance vs. Space-scrolls-page (desktop) | Reader owns the scroll container and `preventDefault()`s Space *only* when focus is not in an input/textarea/contenteditable, and only while the Reader route is active |
| `/` and `?` shortcuts vs. typing | All single-key shortcuts are gated on `!isEditableTarget(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey` |
| Browser find (`⌘F`) leaking masked words | Impossible by construction (§3.4): the words aren't in the DOM |
| Autoscroll vs. user drag | Pause on touch, 2.5s auto-resume only for incidental pauses (§3.9) |
| Sheet drag vs. sheet content scroll | Sheet only drags from the handle/header, or from content when content `scrollTop === 0` and the drag is downward |

### 5.5 Haptics

`navigator.vibrate()` (Android/Chromium only; iOS Safari does not support the Vibration API, so this is a bonus, never load-bearing). Used sparingly: 10ms tick on stage change, 10ms on long-press threshold reached, 20ms on run complete. One Settings toggle, default ON. No haptic on peek — you'd be buzzing constantly.

### 5.6 Desktop keyboard shortcuts (complete)

Gated on focus not being in a text field. Never override `⌘/Ctrl` browser defaults (`W`, `T`, `N`, `R`, `L`, `F`, `P`, `S`, `+/-`). Shown in the `?` overlay.

**Reader**

| Key | Action |
|---|---|
| `Space` | Advance one line (stepped) / pause-resume autoscroll (smooth) |
| `⇧Space` | Back one line |
| `↓` `J` | Scroll down one line |
| `↑` `K` | Scroll up one line |
| `PgDn` / `PgUp` | Scroll one screen |
| `Home` / `End` | Top / bottom of text |
| `→` `N` | Next block |
| `←` `P` | Previous block |
| `Enter` | Peek the current line (whole line, until next keypress) |
| `Tab` / `⇧Tab` | Move focus to next / previous blank in reading order |
| `Space` *(when a blank is focused)* | Peek that blank (hold semantics: keydown reveals, keyup hides) |
| `R` (hold) | Reveal everything while held |
| `⇧R` | Toggle "keep everything revealed" |
| `]` | Harder (up a stage) |
| `[` | Easier (down a stage) |
| `1`–`9` | Jump directly to Stage n |
| `S` | Start / stop autoscroll |
| `+` / `-` *(no modifier)* | Autoscroll faster / slower (±5 wpm) |
| `⌥+` / `⌥-` | Text size up / down |
| `M` | Method sheet |
| `A` | Text (Aa) sheet |
| `G` | Session sheet |
| `F` | Focus mode |
| `T` | Teleprompter mode |
| `H` | Flip horizontally (mirror) — only in teleprompter mode |
| `L` | Line focus mode |
| `D` | Cycle theme (auto → light → dark → high contrast) |
| `W` | Toggle keep-screen-awake |
| `.` | Mark current line as weak |
| `Esc` | Exit Focus/Teleprompter → then exit Reader |
| `?` | Shortcuts overlay |

**Global**

| Key | Action |
|---|---|
| `⌘K` / `Ctrl K` | Command palette (jump to any text, run any action) |
| `/` | Search |
| `G` then `L` / `P` / `S` | Go to Library / Progress / Settings (Gmail-style chords) |
| `⌘⇧N` | New text (paste) |
| `⌘Enter` | In paste/import: Continue |
| `⌘Z` / `⌘⇧Z` | Undo / redo in the editor and for destructive list actions |
| `Esc` | Close top-most sheet / overlay / leave editor |

**Library**

| Key | Action |
|---|---|
| `↑` `↓` `J` `K` | Move selection |
| `Enter` | Open in Reader |
| `⇧Enter` / `→` | Open Text Overview |
| `E` | Edit structure |
| `X` | Toggle multi-select on the focused row |
| `⌫` | Delete (with undo toast) |
| `1`–`9` | Jump to folder n |

**Command palette** deserves a note: for a keyboard-driven desktop user it collapses the entire IA into one affordance, it's ~120 lines of code, and it makes the app feel far more finished than it is. Ship it in v1.1 if not v1.

---

## 6. Methods (the "10+ techniques")

### 6.1 How methods are picked

Method sheet (Screen 11), 2-column grid, **live previews from the user's own text**. Default for a new text: **Hide words**. Default stage: `Read through` (0%) so the first thing anyone ever sees is their text, intact, beautifully set — then they press Harder.

### 6.2 The catalogue (our own names and definitions)

| # | Name | What it hides | Ladder | Best for |
|---|---|---|---|---|
| 1 | **Hide words** | Random words by stable priority | 0 / 20 / 45 / 70 / first-letters / all | Everything; the default |
| 2 | **First letters** | All but the initial letter of each word | letters kept 3 → 2 → 1 → 0 | The classic; brutally effective late-stage |
| 3 | **Line endings** | Everything after the first *k* words of each line | k = 6 → 4 → 2 → 1 → 0 | Verse, lyrics, anything with strong line structure |
| 4 | **Line starts** | The first *k* words of each line | k = 1 → 2 → 4 | Fixing "I know it once I've started" |
| 5 | **Hide lines** | Whole lines, cumulatively from the top | every 4th → every 2nd → all but the first of each block → all | Big-picture sequence recall |
| 6 | **Snowball** | Reveals only up to line *n*; grows as you succeed | n advances per clean pass | Learning a new text from scratch, in order |
| 7 | **Keywords out** | Content words (long words, capitalised words, rare words) | 25 / 50 / 100% of content words | Speeches — you keep the scaffolding, lose the substance |
| 8 | **Glue words out** | The opposite: hide the little connectives | 50 / 100% of function words | Catches the "roughly right but not the actual words" failure mode |
| 9 | **Keep the rhymes** | Hides everything except line-final words | rhyme words only → nothing | Lyrics and verse |
| 10 | **Chunks** | Shows one block at a time, rest hidden | chunk size 4 → 2 → 1 lines | Chunk-and-chain practice |
| 11 | **Cue lines** *(Actor)* | Hides only your character's lines; cue lines show in full / last-3-words / hidden | your lines 30 / 60 / 100% × cue tail length | The actor tool |
| 12 | **Shuffle check** | Shows lines in random order; you tap to reorder | 4 → 8 → 16 lines shuffled | Order recall, as a test not a drill |
| 13 | **From memory** | Shows only title + speaker labels + line count | — | Final check |

That's 13 without copying anyone's naming. Each is a pure function `(tokens, params, seed) → Set<maskedTokenIndex>`, which keeps the whole feature area cheap and testable, and means adding #14 later is a 30-line file.

---

## 7. Accessibility

### 7.1 Baseline

WCAG 2.2 AA as the target, with the specific traps of this app called out below. Semantic HTML first; ARIA only where the semantics don't exist. Everything reachable by keyboard, everything reachable by touch, nothing reachable *only* by gesture.

### 7.2 The hard problem: screen readers and intentionally hidden text

Naive approaches and why they fail:

| Approach | Failure |
|---|---|
| `visibility: hidden` / `opacity: 0` on the word | Depends on implementation; `opacity:0` text is still read by every SR. Total leak. |
| `color: transparent` | Read by SRs, selectable, findable. Total leak. |
| `-webkit-text-security: disc` | Non-standard, WebKit-only (Firefox/Edge incomplete), MDN advises against production use — and it still leaves the real characters in the accessibility tree. Reject. |
| Replace characters with `█` in the DOM | SR reads "black square black square black square…", or the raw glyph name, dozens of times. Unusable. |
| `aria-hidden` on the token with no replacement | The line reads as *"To be, or not to be, that is the"* — a **lie**. The user has no idea a word is missing, and no way to reach the reveal control. |

**Our approach — line-level relabelling, token-level buttons:**

```html
<div class="line" data-line="12" role="group"
     aria-label="Line 12: To be, or not to be, that is the blank">
  <span>To be, or not to be, that is the </span>
  <button class="tok tok--masked" data-i="17"
          aria-label="Hidden word 1 of 1. Activate to reveal."
          style="--w:6.1ch"></button>
</div>
```

Rules:
1. The **line** carries an `aria-label` built from the visible tokens with the literal word **"blank"** substituted for each masked token. So the line reads naturally, the gap is audible, and the count is implicit. This is the behaviour blind users of fill-in-the-blank material expect, and it matches how `<input>` gaps are read in accessible cloze exercises.
2. Each masked token is a **real focusable `<button>`** with an accessible name (`Hidden word 3 of 7. Activate to reveal.`) — reachable by `Tab`, by SR element navigation, and by switch control. Verbosity is a setting: **Terse** = `blank`, **Verbose** = `blank, word 3 of 7`.
3. Activating one reveals the word and announces it via a **single polite live region** (`<div id="announcer" aria-live="polite" aria-atomic="true">`), e.g. `question`. The button's own label updates to `Revealed: question. Activate to hide.` The line's `aria-label` is rebuilt to include the revealed word.
4. **Do not** put `aria-live` on the text container — a stage change would fire a hundred announcements. All announcements funnel through the one `#announcer`, coalesced and debounced 120ms.
5. Because the label is a flat string, tokens *inside* the line are naturally not double-read in "read continuous" mode by most SRs; where they would be, `role="group"` + `aria-label` on the line is the most reliably-honoured pattern (verify manually on VoiceOver iOS, VoiceOver macOS, NVDA + Chrome, TalkBack — this is the one thing in the app that must be hand-tested on real ATs, and it should be a checklist item in the build plan).
6. **A screen-reader user can genuinely use this app**: they navigate line by line, hear the gaps, try to recall, and activate a blank to check. The peek count still works, so the debrief is meaningful. That's a real, working experience — worth the extra care.
7. The reader region as a whole: `role="region" aria-roledescription="Rehearsal text" aria-label="<title>, stage 3 of 6"`.
8. `Reveal all` announces `All words revealed` / `Words hidden again`.

### 7.3 Focus management

- **Route change:** move focus to the new view's `<h1>` (which has `tabindex="-1"`), and announce the view name. Never leave focus on a button that no longer exists.
- **Sheets:** `<dialog>` where possible (native focus trap + `Esc` + `::backdrop`); otherwise a manual trap. Focus moves to the sheet's heading on open, **returns to the exact invoking element on close** (store the trigger `Element` reference, not a selector).
- **Reader entry:** focus the reader region so `Space`/arrows work immediately without a click. This is why the region needs `tabindex="-1"`.
- **Focus mode:** hiding chrome must not orphan focus — if focus is on a control being hidden, move it to the reader region first.
- **Focus visible:** a 3px `--focus` ring with a 2px offset, on `:focus-visible` only, and it must be visible against every surface including inside masked tokens (which are dark-on-light and light-on-dark). Never `outline: none` without a replacement.
- **Skip link:** `Skip to text` as the first focusable element in the Reader.
- Tab order in the Reader: skip link → status rail → reader region → masked tokens in reading order → control bar. Masked tokens are `tabindex="0"` when masking is on, and removed from the tab order entirely at Stage 1 (nothing to reveal), so `Tab` isn't a hundred no-ops.

### 7.4 The ambiguous-row problem

The Library row has two targets (row → Reader, chevron → Overview). For AT this must be explicit: the row is a `<button>` labelled `Hamlet, Act 3 Scene 1. 42 lines, stage 3. Rehearse.` and the chevron is a separate `<button>` labelled `Details for Hamlet, Act 3 Scene 1`. Two buttons, two clear names, no mystery.

### 7.5 Dyslexia-friendly options ("Reading comfort" pack)

Presented as one switch that turns on a bundle, with individual overrides:
- Font → Atkinson Hyperlegible Next (**default of the pack**, on the evidence: it's a legibility-first design with disambiguated glyphs, which helps broadly). OpenDyslexic offered by name because users ask for it, with neutral framing and no efficacy claim.
- `letter-spacing: 0.05em`, `word-spacing: 0.16em`, line height 1.95, measure 26ch.
- **Line focus** on (dim all but current ± 1).
- Off-white background (`--paper` is already warm off-white, not `#fff` — this is why).
- Left-aligned, no hyphenation, no justification (already global).
- Optional **reading ruler**: a translucent band behind the current line, height = one line box. Cheap to add given we already track the current line.

### 7.6 Reduced motion

`prefers-reduced-motion: reduce`, with an in-app override (Auto / On / Off):
- Smooth autoscroll → **stepped**, and stepped becomes tap-advanced by default.
- Token reveal/hide transitions → instant.
- Sheet transitions → 0ms (or a 100ms opacity fade only, which is generally acceptable).
- Stage-change fade of newly masked words → instant.
- Sparklines, progress bars, page transitions → no animation.
- Nothing in the app auto-moves without the user having started it. Ever.

### 7.7 Targets, contrast, and the rest

- **Targets:** 56px (control bar), 48px (primary buttons), 44px (all other controls) — comfortably above WCAG 2.2 SC 2.5.8 (24×24). Masked tokens are inline text targets (exempt from 2.5.8 under the *inline* exception) but we still give them a `-10px` inset pseudo-element so the effective hit area is ≥24px tall, and spacing between adjacent blanks keeps their hit areas from overlapping (if two blanks are adjacent, they get 2px of real separation).
- **Contrast:** every value verified in §9.5. Body text ≥14:1 in both themes. Muted text ≥6:1 (we don't ship 4.5:1-just-barely text). **Masked-blank rule ≥3.7:1** against both its fill and the page (SC 1.4.11 needs 3:1 for meaningful non-text; we exceed it because the blank is the most important non-text element in the app).
- **Colour is never the only signal:** the masked state is signalled by absence-of-text + a rule (shape), not by colour. Peeked words are amber *and* they're the only words that just changed. Current line is a tint *and* a left rule. Stage is a number *and* a bar.
- **Zoom:** the app must work at 200% browser zoom and at 320px CSS width (SC 1.4.4, 1.4.10) with no horizontal scrolling. The `ch`-based measure makes this nearly free.
- **Orientation:** never locked (SC 1.3.4).
- **Timing:** the only timed thing is autoscroll, which is user-started, user-pausable, and adjustable (SC 2.2.1, 2.2.2). Timed peek is adjustable to "until release" or "sticky".
- **Language:** `lang` on `<html>`, and a per-text `lang` attribute (settable in Text Overview) so SRs pronounce a French song correctly.
- **Reflow of the masked state must not trap the user:** if a stage change would leave zero visible words on screen, don't; there's always the whole-text reveal.

---

## 8. First run, empty states, error states

### 8.1 Built-in samples (public domain only)

Three, chosen to cover the four audiences and to be short enough to actually finish. All are unambiguously public domain (author died centuries ago / pre-1929 US publication) — verify each before shipping and record the source in a comment:

1. **Sonnet 18** — Shakespeare, 14 lines. Verse, rhymes, perfect for `Keep the rhymes`. The default first-run sample.
2. **"To be, or not to be"** — *Hamlet* III.i, ~35 lines. Single-speaker monologue; demonstrates `Hide words` and long-text scrolling.
3. **A short two-hander scene** — e.g. an excerpt of Wilde's *The Importance of Being Earnest* (1895) with two speakers, ~20 lines. Exists purely to demonstrate the **Cue lines / role picker** feature, which is otherwise undiscoverable.

Optionally a fourth: a 150-word excerpt of Lincoln's Gettysburg Address (speech audience). Samples are marked with a small `Sample` chip in the Library, are deletable, and are restorable from Settings → About.

### 8.2 Empty states

Every empty state: an **icon or a diagram, one sentence of what goes here, one primary button**, and never an illustration of a sad box.

| Where | Copy | Primary action |
|---|---|---|
| **Library, zero texts** (post-onboarding) | **"Nothing to learn yet."** / *"Add a script, some lyrics, a speech — anything you need to know by heart."* | `Paste text` + secondary `Import a file` + tertiary `Load a sample` |
| **Folder, empty** | *"This folder is empty."* | `Move texts here` (opens a picker) |
| **Search, no results** | *"No texts or lines match "undiscoverd"."* — echo the query verbatim so typos are visible | `Clear search` |
| **Progress, no runs** | *"Your progress shows up here after your first run."* + a **greyed sample sparkline** so the user knows what they'll get | `Start rehearsing` |
| **Progress, one run** | Show the run, plus *"Come back after a few runs to see a trend."* | — |
| **Debrief, zero peeks** | **"Clean run."** / *"You didn't peek once."* | `Harder ▶` (and *not* `Drill weak lines`, which would be nonsense) |
| **Text with no speakers** (role picker reached anyway) | *"We didn't find any character names in this text."* | `Mark speakers in the editor` |
| **Weak-lines drill with no weak lines** | *"No trouble spots recorded yet."* | `Run the whole text` |
| **Backup screen, never exported** | *"No backups yet. Your texts only exist on this device."* — deliberately slightly alarming, because it's true | `Export backup` |

### 8.3 Error states

Presentation rules: **inline where the problem is, never a modal for a recoverable error**; state what happened, why, and the single next action; never show a raw exception; always keep the user's input.

| Error | Message | Recovery |
|---|---|---|
| **PDF has no text layer (scanned)** | *"This PDF is a scan — it's pictures of text, so we can't read the words."* | `Try another file` · `Paste the text instead` · (later: link to OCR guidance). This is the #1 import failure; get the copy right. |
| **PDF is password protected** | *"This PDF is locked."* | `Choose another file` — do **not** build a password prompt in v1 |
| **PDF parse partially failed** | *"We read 8 of 12 pages."* | `Use what we got` · `Try again` |
| **Unsupported file type** | *"We can read PDF, TXT, RTF, HTML and Markdown. That file is a .pages."* — name the actual extension | `Choose another file` |
| **File too large (>25 MB)** | *"That file is 40 MB — too big to read in the browser without freezing."* | `Choose another file` |
| **Import produced no text** | *"We couldn't find any text in that file."* | `Paste the text instead` |
| **RTF/HTML with heavy markup** | Silent — just clean it, and surface the result in the Cleanup preview | — |
| **Clipboard read denied** | *"Your browser wouldn't share the clipboard. Long-press the box and choose Paste."* | Inline hint, textarea stays focused |
| **IndexedDB unavailable (Safari private browsing, storage disabled)** | Blocking banner: *"This browser is blocking storage, so nothing can be saved. You can still try the app — but leave private browsing to keep your texts."* | Let them use the app in-memory; do not white-screen |
| **Quota exceeded** | *"Storage is full."* + usage breakdown | `Delete old texts` · `Export a backup first` |
| **Storage evicted / data missing on return** | *"We couldn't find your texts. If the browser cleared its storage, restore from a backup."* | `Restore from backup` — and this is exactly why §17's nudge exists |
| **Wake lock denied/unsupported** | *"Your browser won't let a page keep the screen on."* + what to do instead | Toggle renders unavailable with the explanation, not broken |
| **Fullscreen unsupported (iPhone Safari)** | No error — the control is relabelled `Hide controls` and does what it can | — |
| **Restore: not our file / corrupt JSON** | *"That doesn't look like an Offbook backup."* | `Choose another file` |
| **Restore: newer schema version** | *"This backup was made by a newer version of Offbook. Update the app, then try again."* | — |
| **Restore: conflicts** | The diff preview (§17) — not an error, a decision | `Merge` / `Replace` |
| **Autosave failure in editor** | Persistent inline `Not saved — retrying…` chip in the header, plus keep an in-memory copy and offer `Copy text to clipboard` as the panic escape | Retry with backoff |
| **App update available (new service worker)** | Quiet bottom toast: *"A new version is ready."* `Reload` — **never** auto-reload mid-rehearsal | User-initiated |
| **Unhandled exception** | Error boundary per route: *"Something broke on this screen."* + `Reload this screen` + `Export a backup` (so a bug can't cost them their data) + a copyable technical detail block | Route-level, not app-level white screen |

### 8.4 Loading & skeletons

- Library loads from IndexedDB in <50ms; show nothing (no skeleton flash) below 120ms, then a skeleton list.
- PDF parse is the only genuinely slow operation: staged progress (§Screen 5), in a Worker so the UI never blocks, cancellable.
- Fonts: `font-display: swap` and the system stack as the default means **zero** FOIT for the 90% who never change fonts.

### 8.5 Install prompt (PWA)

Never on first load. Show a dismissible bottom banner **after the user's second completed run**, when they've demonstrated intent: *"Add Offbook to your home screen — it works offline and keeps the screen on."* Uses `beforeinstallprompt` on Chromium; on iOS Safari, show the manual Share → Add to Home Screen instructions with a small diagram (feature-detect `navigator.standalone`). Dismiss = never again (one `installPromptDismissed` flag), with the option living on in Settings → About.

---

## 9. Visual design system

### 9.1 Direction in one paragraph

**Paper, ink, and one quiet accent.** The app should look like a well-set page from a good publisher, not like a SaaS dashboard. Warm off-white (never `#fff`), near-black text with real weight contrast, generous whitespace, hairline rules instead of cards-with-shadows, exactly one accent hue (a desaturated deep teal — calm, unlike red/orange which read as error, and distinct from the amber we reserve for peeks). Zero gradients. Zero shadows except a single elevation for bottom sheets. No icons where a word will do. The masked blank is the only piece of "graphic design" in the text area, and it is a hairline rule.

The identity is carried by **typography and restraint**, which is also the only kind of visual identity one developer can execute well.

### 9.2 Colour tokens — light theme

CSS custom properties on `:root`; Tailwind consumes them via `theme.extend.colors` referencing `var(--…)` so utilities and raw CSS agree.

| Token | Hex | Role | Contrast (verified) |
|---|---|---|---|
| `--paper` | `#FAF9F7` | App background, reader canvas | — |
| `--surface` | `#FFFFFF` | Cards, sheets, rows | 1.05:1 vs paper (intentionally near-invisible; rules do the work) |
| `--surface-sunk` | `#F2F0EC` | Inset areas, textarea, code | — |
| `--text-strong` | `#14161A` | Reader body, headings | **17.21:1** on paper |
| `--text-body` | `#22262B` | UI body text | **14.46:1** on paper |
| `--text-muted` | `#585F68` | Meta, labels, secondary | **6.14:1** on paper |
| `--text-faint` | `#6F7883` | Line numbers, stage directions, disabled-ish | **4.26:1** on paper (never used below 14px) |
| `--border` | `#E3DFD8` | Hairline dividers (decorative) | 1.26:1 — decorative only, never the sole indicator |
| `--border-strong` | `#C9C4BA` | Emphasised dividers, sheet edges | 1.65:1 |
| `--border-interactive` | `#868D95` | Outline of unfilled controls, checkbox borders | **3.19:1** on paper ✓ SC 1.4.11 |
| `--accent` | `#10756A` | Primary buttons, current-line rule, active states | **5.29:1** on paper |
| `--accent-ink` | `#0C6157` | Accent-coloured *text* and links | **6.97:1** on paper |
| `--accent-on` | `#FFFFFF` | Text on accent fill | **5.56:1** on `--accent`, **7.33:1** on `--accent-ink` |
| `--accent-wash` | `#E2F1EE` | Chips, selected rows, subtle accent fill | accent-ink on it = **6.30:1** |
| `--mask-fill` | `#EAE6DE` | Blank background (Box style) | 1.18:1 vs paper — the *rule* carries the signal |
| `--mask-rule` | `#6B747E` | Blank underline/border — **the load-bearing token** | **4.51:1** vs paper, **3.81:1** vs mask-fill ✓ both > 3:1 |
| `--peek-text` | `#7A4A00` | A just-revealed word | **7.11:1** on paper |
| `--peek-bg` | `#FDF0D6` | Behind a just-revealed word | text-body on it = **13.49:1** |
| `--line-current-bg` | `#FFF3CE` | Current-line tint | text-strong on it = **16.36:1** |
| `--success` | `#1E6B3A` | Clean run, confirmations | **6.20:1** on paper |
| `--danger` | `#A4262C` | Destructive actions, errors | **6.90:1** on paper; white on it = **7.26:1** |
| `--focus` | `#0C6157` | Focus ring | **6.97:1** on paper |

### 9.3 Colour tokens — dark theme

| Token | Hex | Role | Contrast (verified) |
|---|---|---|---|
| `--paper` | `#121417` | Background (a true dark grey, not black) | — |
| `--surface` | `#1A1D21` | Cards, rows | 1.09:1 vs paper |
| `--surface-sunk` | `#0D0F11` | Inset | — |
| `--surface-raised` | `#23272C` | Sheets, popovers | 1.23:1 vs paper |
| `--text-strong` | `#EDEBE6` | Reader body (warm off-white, avoids halation) | **15.49:1** |
| `--text-body` | `#DCD9D3` | UI body | **13.10:1** (and **10.66:1** on `--surface-raised`) |
| `--text-muted` | `#A3A9B1` | Meta | **7.79:1** (**6.34:1** on raised) |
| `--text-faint` | `#7C838C` | Line numbers, directions | **4.82:1** |
| `--border` | `#2F343A` | Hairlines (decorative) | 1.47:1 |
| `--border-strong` | `#414852` | Emphasised | 2.00:1 |
| `--border-interactive` | `#767E88` | Control outlines | **4.49:1** vs paper, **3.66:1** vs raised ✓ |
| `--accent` | `#5FC9BC` | Accent (text, rules, active) | **9.28:1** |
| `--accent-dim` | `#3E9E93` | Accent fill for buttons | **5.73:1** |
| `--accent-on` | `#121417` | Text on accent fill | **9.28:1** on `--accent` |
| `--accent-wash` | `#17332F` | Chips, selected | accent text `#7FDCD1` on it = **8.42:1** |
| `--mask-fill` | `#24282D` | Blank background (Box) | 1.24:1 vs paper |
| `--mask-rule` | `#79818B` | **Blank underline — load-bearing** | **4.68:1** vs paper, **3.76:1** vs mask-fill ✓ |
| `--peek-text` | `#E2B15E` | Just-revealed word | **9.39:1** |
| `--peek-bg` | `#2A2419` | Behind revealed word | — |
| `--line-current-bg` | `#1E2429` | Current-line tint | text-strong on it = **13.16:1** |
| `--success` | `#6FCB8E` | | **9.32:1** |
| `--danger` | `#F2857F` | | **7.41:1** |
| `--focus` | `#7FDCD1` | Focus ring | **11.48:1** vs paper, **9.34:1** vs raised |

### 9.4 High contrast variants

Triggered by `prefers-contrast: more` or the manual theme choice; layered as an override, not a third full palette:
- `--text-strong`/`--text-body` → `#000000` (light) / `#FFFFFF` (dark) = **21:1**
- `--paper` → `#FFFFFF` / `#000000`
- `--mask-rule` → `#000000` / `#FFFFFF`, width 2px → 3px, **and** `--mask-fill` becomes `#E0E0E0` / `#303030` so the blank is signalled twice
- `--border` → `--border-interactive` (all hairlines become real)
- `--line-current-bg` removed; current line gets a **4px** `--accent` left rule and a 1px box outline instead (shape over colour)
- Focus ring 3px, offset 3px
- All decorative tints (`--accent-wash`, `--peek-bg`) drop to transparent with a 1px outline instead
- Also honour `forced-colors: active` (Windows High Contrast): use `ButtonText`/`Canvas`/`Highlight` system colours, and make sure the masked blank survives — `forced-color-adjust: none` on the mask rule with an explicit `border-bottom-color: ButtonText`, because a blank that disappears in forced-colors mode makes the app unusable.

### 9.5 Verified contrast summary (the numbers that must not regress)

Put these in a test. A snapshot test that computes the ratio from the token values and asserts a floor is 20 lines of code and prevents the single most likely visual regression.

| Assertion | Floor | Light | Dark |
|---|---|---|---|
| Reader body text on canvas | 7:1 | 17.21 | 15.49 |
| UI body text on surface | 4.5:1 | 14.46 | 10.66 |
| Muted text on canvas | 4.5:1 | 6.14 | 7.79 |
| Faint text on canvas (≥14px) | 4.5:1 | 4.26 ⚠ | 4.82 |
| **Mask rule vs canvas** | 3:1 | **4.51** | **4.68** |
| **Mask rule vs mask fill** | 3:1 | **3.81** | **3.76** |
| Interactive border vs its surface | 3:1 | 3.19–3.36 | 3.66–4.49 |
| Text on accent fill | 4.5:1 | 5.56 | 9.28 |
| Peeked word on canvas | 4.5:1 | 7.11 | 9.39 |
| Text on current-line tint | 7:1 | 16.36 | 13.16 |
| Focus ring vs adjacent surface | 3:1 | 6.97 | 9.34 |

⚠ **One action item:** light `--text-faint` at 4.26:1 is below 4.5:1. Either restrict it to ≥18.66px/bold usage (where 3:1 suffices) or darken it to `#6B747E` (**4.51:1**). **Recommendation: darken it to `#6B747E`** — same value as `--mask-rule`, one fewer token, and it passes everywhere. Do this before writing the theme file.

### 9.6 Type scale

Base 16px = 1rem. UI scale is a modest 1.2-ish ratio; the reader scale is user-controlled and independent.

| Token | Size / line-height | Use |
|---|---|---|
| `--fs-2xs` | 11px / 16px | Chips, badges, superscripts. Never for body |
| `--fs-xs` | 12px / 16px | Line numbers, timestamps |
| `--fs-sm` | 14px / 20px | Meta lines, captions, helper text |
| `--fs-base` | 16px / 24px | UI body, list rows, form fields (16px min on inputs — anything smaller triggers iOS Safari zoom-on-focus) |
| `--fs-md` | 17px / 24px | List row titles |
| `--fs-lg` | 20px / 28px | Section headings, sheet titles |
| `--fs-xl` | 24px / 32px | Screen titles |
| `--fs-2xl` | 30px / 36px | Rare; onboarding headline |
| `--fs-hero` | 48px / 52px | The one big number on the Debrief |
| `--fs-reader` | **user: 18–44px** (default 22px), line-height token `--lh-reader` (1.45 / **1.65** / 1.95) | Reader body |
| `--fs-prompter` | **user: 44–120px** (default 64px), lh 1.35 | Teleprompter |

Weights: 400 body, **500** reader body in teleprompter/large sizes only, 600 headings and row titles, 700 the Debrief hero number. Never 300 (fails at small sizes on Android), never 800+.

### 9.7 Spacing, radii, elevation, motion

**Spacing** — 4px base, Tailwind-native: `1`=4, `2`=8, `3`=12, `4`=16, `5`=20, `6`=24, `8`=32, `10`=40, `12`=48, `16`=64. Screen gutters: 16px mobile, 24px ≥768px, and the reader measure centres inside whatever's left. Vertical rhythm between sections: 32px. Between list rows: 0 (hairline separated), row padding 14px vertical.

**Radii** — `--r-xs` 4px (masked blank Box style, chips), `--r-sm` 8px (buttons, inputs), `--r-md` 12px (cards), `--r-lg` 16px (sheets — top corners only), `--r-full` 9999px (pills, FAB, avatars). Nothing more rounded than 16px; over-rounding reads as "toy".

**Elevation** — exactly two shadows in the whole app:
- `--shadow-sheet`: `0 -8px 32px rgb(20 22 26 / 0.14)` (light) / `0 -8px 32px rgb(0 0 0 / 0.5)` (dark) — bottom sheets only.
- `--shadow-fab`: `0 2px 8px rgb(20 22 26 / 0.16)` — the FAB only.
Everything else uses a hairline border. In dark mode, elevation is expressed by `--surface-raised` being *lighter*, not by shadow.

**Motion** — durations `--t-fast` 120ms (token reveal, tint changes), `--t-base` 180ms (sheets, chrome fade, stepped scroll), `--t-slow` 260ms (route transitions). Easing: `--ease-out: cubic-bezier(0.2, 0, 0.2, 1)` for entrances, `--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1)` for moves. **All of it wrapped in a `@media (prefers-reduced-motion: no-preference)` guard** so reduced-motion is the structural default rather than an afterthought.

### 9.8 State colouring of the four text states (the crux)

| State | Light | Dark | Signalled by |
|---|---|---|---|
| **Visible** | `--text-strong` on `--paper` | `--text-strong` on `--paper` | Normal text |
| **Masked** | no glyphs; `--mask-rule` 2px bottom border (+ `--mask-fill` in Box style) | same tokens | **Absence of glyphs** (shape) + a rule (shape) — not colour |
| **Peeked** | `--peek-text` on `--peek-bg`, decaying to masked over 180ms | same | Colour **+** the change event **+** it's the only coloured word on screen |
| **Cue line** (other speaker) | `--text-strong` at `opacity: 0.7` | at `opacity: 0.66` | Opacity + never masked; still ≥7:1 |
| **Current line** | `--line-current-bg` tint + 3px `--accent` left rule | same | Tint **+** rule (two signals) |
| **Always-show word** | `--text-strong` + 1px dotted `--border-interactive` underline (editor only; invisible in reader) | same | Shape |
| **Weak line** (flagged) | a 3px `--peek-text` left rule, inset from the current-line rule | same | Position + colour |
| **Line-focus dimmed** | `opacity: 0.32` | `opacity: 0.28` | Opacity only — and it's user-initiated, so acceptable |

### 9.9 Tailwind wiring (practical note)

```js
// tailwind.config.js — colors reference CSS vars so themes swap without class churn
colors: {
  paper: 'var(--paper)', surface: 'var(--surface)',
  ink: { DEFAULT:'var(--text-body)', strong:'var(--text-strong)',
         muted:'var(--text-muted)', faint:'var(--text-faint)' },
  accent: { DEFAULT:'var(--accent)', ink:'var(--accent-ink)',
            on:'var(--accent-on)', wash:'var(--accent-wash)' },
  mask: { fill:'var(--mask-fill)', rule:'var(--mask-rule)' },
  peek: { DEFAULT:'var(--peek-text)', bg:'var(--peek-bg)' },
}
```
Theme switching = swapping the custom-property block under `:root[data-theme="dark"]` and `@media (prefers-color-scheme: dark)`, with the attribute selector winning in both directions. No `dark:` variant sprawl, no class churn, and one place to change a colour. Use `@theme`/CSS-first config if on Tailwind v4.

Also: **`.sr-only`** (the standard clip-rect version, not `display:none`), **`.tap-44`** (a `::after` inset expander utility), and a `.reader-measure` utility (`max-width: var(--measure); margin-inline: auto`) are the three custom utilities worth defining up front.

---

## 10. Handover notes for the implementation plan

### 10.1 Component inventory (roughly what needs building)

**Primitives (12):** Button, IconButton, Sheet (with detents + focus trap), ListRow, Chip, Segmented, Slider, Stepper, Toggle, Toast/Announcer, EmptyState, ErrorBoundary.
**Domain (14):** TextCard, FolderChip, StageChip, ControlBar, StatusRail, ReaderCanvas, LineView, MaskedToken, MethodCard (with live preview), CleanupToggle, SpeakerRadio, ConfidenceStrip, Sparkline, HeatmapCalendar.
**Hooks/services (11):** `useCurrentLine` (IntersectionObserver), `useAutoScroll` (rAF + wpm), `useWakeLock`, `useLongPress`, `useTwoFingerGesture`, `useScrollAnchor`, `useTokenWidths` (canvas measure + cache), `useKeyboardShortcuts`, `useTheme`, `useAnnouncer`, `usePersistedSetting`.

The Reader is ~40% of the UI work. Build it second (right after storage), against a hardcoded text, before the Library exists.

### 10.2 Suggested build order (UI-side)

1. Tokens + theme switching + the three custom utilities. (Fix `--text-faint` first, §9.5.)
2. `ReaderCanvas` + `LineView` + `MaskedToken` with a hardcoded sample and a hardcoded 45% mask. Get the typography and the blank right before anything else exists — everything downstream depends on this feeling good.
3. Stage ladder + Harder/Easier + stable seeded masking.
4. Peek (touch hold, then keyboard, then the ARIA layer).
5. Scroll anchoring + current line + the Aa sheet.
6. Library + storage + paste import.
7. Cleanup screen.
8. Autoscroll + wake lock.
9. Methods 2–5, then the rest.
10. Roles/cue lines.
11. Run logging → Debrief → Progress.
12. Backup/restore, Settings, About, onboarding, PWA install.
13. AT pass on real devices (§7.2 note 5) — schedule this, don't hope for it.

### 10.3 Things to test on real devices, not in a desktop browser

- VoiceOver on iOS reading a line with 3 blanks (the §7.2 pattern) — the single highest-risk item in this spec.
- Long-press peek vs. the iOS text-selection magnifier.
- Wake lock in an installed iOS PWA (and on an iOS 18.3-or-earlier device if one is to hand, to confirm the graceful degradation).
- iOS Safari toolbar collapse vs. the bottom control bar at `100dvh`.
- Two-finger peek vs. pinch disambiguation with real thumbs.
- Autoscroll smoothness at 60 wpm on a mid-range Android (the low-px/frame judder case).
- 200% browser zoom at 320px width.

### 10.4 Deliberate non-goals for v1 (stated so they don't creep in)

Speech recognition scoring, TTS scene partner, self-recording playback, spaced-repetition scheduling, timing/pace coaching, cloud sync, sharing, collaboration, multi-level folders, rich text formatting, OCR, gamification/streaks/badges. Several of these are excellent v2 differentiators — but each one is a whole product surface, and none of them is why someone opens the app.

---

## 11. Open questions for Ben

1. **Name** — confirm *Offbook* (recommended) or *Byheart*, then check trademark + domain before the wordmark gets baked into the manifest, icons, and copy.
2. **DOCX import** — include (adds ~200 KB of parser) or exclude from v1? The Add sheet's copy depends on the answer.
3. **`--text-faint` fix** (§9.5) — accept the darkening to `#6B747E`, or keep the lighter value with a size restriction?
4. **Stepped vs smooth autoscroll default** — spec says smooth; if Ben's own rehearsal habit is verse, stepped may be the better default.
5. **Command palette in v1?** — cheap, high perceived polish, but desktop-only value on a mobile-first product.
6. **Shuffle check (method 12)** — it's the only method that isn't "read and recall", needs its own interaction model (drag to reorder), and could slip to v2 without loss.
