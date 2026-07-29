# Offbook

Learn a speech, script, song or poem by heart by progressively hiding it.

Paste or import your text, read it aloud, and hide a few words. Read it again. Hide more. Keep
going until nothing is on screen and you can still say it. A teleprompter that gradually stops
helping you.

**→ [offbook-4ev.pages.dev](https://offbook-4ev.pages.dev/)**

## What it does

- **Ten ways to hide.** Random words, first letters, line endings, line starts, whole lines,
  keywords, glue words, rhyme-keeping, a moving chunk window, and cue-lines-only for actors.
- **A difficulty ladder.** Seven rungs from a light dusting of blanks to nothing at all. Stepping
  up *adds* blanks rather than reshuffling them, so it feels like progress rather than damage.
- **Press and hold to peek** at a word you have lost, without abandoning the run.
- **Actor mode.** Pick your character; your lines get hidden and everyone else's stay as cues.
- **Auto-scroll** at a words-per-minute pace, with the screen kept awake.
- **Import** from paste, `.txt`, `.md`, `.html` or PDF.
- **Folders and search** over a library with no limit on the number of texts.

## What it deliberately isn't

No account. No server. No paywall. No analytics. No streaks, points or badges. Your texts are
stored on your own device in IndexedDB and never sent anywhere — after the app loads, it makes no
network requests at all. Back up to a JSON file whenever you like.

## Running it locally

```bash
npm install
npm run dev
```

```bash
npm run check   # typecheck + lint + test
```

## Layout

| Path | What's in it |
|---|---|
| `PLAN.md` | The implementation plan. §0.0 amendments override the rest. |
| `docs/research/` | The six background design docs the plan was distilled from. |
| `docs/decisions/` | ADRs for the choices that a future refactor would innocently destroy. |
| `src/core/` | Pure engine: tokenizer, structure detection, chunking, masking. No React, no DOM. |
| `src/data/` | The only layer that touches IndexedDB. |
| `src/features/` | UI, grouped by feature. |
| `tests/unit/` | Mirrors `src/core/`. |

## Licence

MIT. If this app ever stops being maintained, someone else can host it — that is the point.
