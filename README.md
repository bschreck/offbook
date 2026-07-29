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
- **Accounts and sync, if you want them.** Everything above works with no account. Signing in
  replicates your library so it turns up on your phone as well as your laptop — your device stays
  the source of truth, sync runs in the background, and nothing about the app stops working when
  the network or the server does.

## What it deliberately isn't

No paywall. No analytics, no tracking. No streaks, points or badges. Your texts live on your own
device in IndexedDB, and the whole app — every method, every text, offline — works without an
account. There is no free tier and no locked feature.

An account is **optional** and does exactly one thing: it copies your library to our own server so
another device can have it too. Signed out, the app makes no network requests after it loads. Signed
in, it sends your texts and your practice history to our server and to nobody else — no third
party, no analytics service, no advertiser. Your password never leaves the device; only a key
derived from it does. You can sign out, delete the account, or never make one; JSON backup and
restore work either way.

## Running it locally

```bash
npm install
npm run dev
```

```bash
npm run check   # typecheck + lint + test
```

The dev server has no backend, which is fine — the app is fully usable without one. To work on
accounts and sync you need the Functions and a local D1:

```bash
npm run build
npm run db:migrate:local
npm run dev:api
```

## Layout

| Path | What's in it |
|---|---|
| `PLAN.md` | The implementation plan. §0.0 amendments override the rest. |
| `docs/research/` | The six background design docs the plan was distilled from. |
| `docs/decisions/` | ADRs for the choices that a future refactor would innocently destroy. |
| `src/core/` | Pure engine: tokenizer, structure detection, chunking, masking. No React, no DOM. |
| `src/data/` | The only layer that touches IndexedDB. Sync's client half lives here. |
| `src/shared/` | Code that must be identical on client and server: the KDF, the wire protocol. |
| `src/features/` | UI, grouped by feature. |
| `functions/` | Cloudflare Pages Functions: the optional accounts and sync API. Same origin. |
| `migrations/` | D1 schema, applied with `npm run db:migrate`. |
| `tests/unit/` | Mirrors `src/core/`. |

## Licence

MIT. If this app ever stops being maintained, someone else can host it — that is the point.
