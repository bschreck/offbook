# Voice Design — MemoCoach clone (working name: **Cue**)

**Scope:** everything voice. Speech recognition & scoring, TTS scene partner, self-recording, permissions/privacy.
**Status:** design doc, no code committed. Target dir `/Users/ben/memocoach` (empty).
**Researched:** July 2026. Browser-support claims below are dated and sourced; re-probe at runtime, never trust a UA string.

---

## 0. Executive summary — read this first

Voice is our differentiator over MemoCoach, and it is genuinely achievable **for free**, because both halves of the
Web Speech API are built into the browser at zero cost to us. But the platform reality is uneven and one specific
gap will shape the whole product:

**The five hard truths (details in §1.1, §2.1, §2.4):**

1. **`SpeechRecognition` does not work in an installed iOS home-screen web app.** The API object exists, feature
   detection passes, `start()` resolves, and then nothing ever happens. It works in Safari-the-browser on iOS 14.5+
   but not in `display: standalone`. This directly collides with our "installable PWA" plan on the single most
   important rehearsal device. We must design around it, not hope.
2. **`continuous = true` is unusable on iOS Safari** (mic never releases, results accumulate into one ever-growing
   string), and `interimResults` on WebKit is throttled/erratic. Live word-by-word tracking is a Chromium-quality
   feature; on iOS it degrades to per-line checking.
3. **Firefox has no working speech recognition** in 2026 (pref-gated, non-functional even when enabled). ~2–3% of
   our users get the silent path.
4. **Word-level `boundary` events for karaoke highlighting are not reliably available.** Chromium desktop fires
   per-word; Safari fires per-*sentence*; **Android Chrome/Firefox do not fire `boundary` at all.**
5. **Background / lock-screen TTS playback is not available, and browser TTS cannot be exported to an audio file.**
   `speechSynthesis` is not a media element, so `MediaSession`, lock-screen transport controls, and background
   audio simply do not apply to it, and there is no `AudioNode` to capture it with `MediaRecorder`.

**The consequence, which is actually good news:** truth #5 means the *user's own recorded voice* is the only path to
real background/lock-screen rehearsal audio — a recorded blob in an `<audio>` element gets MediaSession, lock-screen
controls, and background playback for free. So §3 (self-recording, the LineLearner technique) is not a nice-to-have
bolted on the side; it is the **most robust and most cross-platform** voice feature we have, and it is the one that
works identically on iOS, Android and desktop. Recommended build order is therefore:

| Phase | Feature | Platform reach | Why this order |
|---|---|---|---|
| **P0** | Silent recall + self-grade (no mic at all) | 100% | Must stand alone; everything else is enhancement |
| **P1** | **Self-recording + "mute my lines"** (§3) | ~99% | Highest value/reach ratio; works on iOS standalone |
| **P2** | **TTS scene partner + listen mode** (§2) | ~99% | Zero permissions needed; big perceived-magic win |
| **P3** | **Speech recognition + scoring** (§1) | ~75% real-world | The differentiator, but the flakiest; needs P0 as floor |
| **P4** | VAD-only "timing check" fallback (§1.7 Tier 1) | ~97% | Cheap; makes iOS-standalone feel alive |
| **P5** | Optional local Whisper "review my take" (§1.8) | Chromium/Safari 26+ desktop-ish | Opt-in, 40–150 MB download, do not ship in v1 |

Note P3 is *after* P2 despite being the differentiator. Rationale: the scoring engine (§1.3) is the single most
intricate piece of the whole app and it is worthless without a solid text/line model underneath it, whereas TTS is
mostly plumbing and ships in a session.

---

## 1. Speech recognition — "did I say it right?"

### 1.1 Platform reality, July 2026

`SpeechRecognition` (still `webkitSpeechRecognition` in shipping engines — always alias both) is **Limited
Availability** on MDN's Baseline scale: explicitly *not* Baseline, explicitly "does not work in some of the most
widely-used browsers."

| Engine / platform | Supported? | Prefix | Network? | Notes |
|---|---|---|---|---|
| Chrome desktop (Win/mac/Linux/CrOS) | Yes, 25+ | `webkit` | **Yes**, audio → Google servers, unless `processLocally` | Best implementation. Interim results good, `continuous` workable, alternatives populated, `confidence` populated |
| Chrome Android | Yes, 25+ | `webkit` | **Yes** | Works, but `continuous` needs restart-on-`end` babysitting. No on-device mode, no contextual biasing |
| Edge desktop | Yes (Chromium) | `webkit` | Yes (Microsoft service) | Behaves like Chrome; ignores `pitch` on remote voices (TTS side) |
| **Safari macOS** | Yes, 14.1+ | `webkit` | **Yes**, audio → Apple service | `interimResults` erratic; `maxAlternatives` usually returns 1 |
| **Safari iOS/iPadOS (browser tab)** | Yes, 14.5+ | `webkit` | **Yes** | Must be started inside a user gesture. Plays a **system chime on every `start()`**. `continuous` broken |
| **Safari iOS — installed web app (`standalone`)** | **NO** | — | — | **API present, silently does nothing.** Long-standing, still unfixed as of iOS 26.x. This is the killer |
| iOS Chrome / Firefox / Edge | Same as Safari iOS | `webkit` | Yes | All iOS browsers are WebKit; identical constraints |
| **Firefox (all platforms)** | **NO** | — | — | `media.webspeech.recognition.enable` + `force_enable` in `about:config`, and still non-functional in practice. Treat as unsupported |
| WKWebView / in-app browsers (Instagram, etc.) | **NO** | — | — | Errors immediately without prompting. Detect and warn |
| Samsung Internet | Yes (Chromium) | `webkit` | Yes | Untested by us; probe at runtime |

**Realistic addressable share for live voice checking: ~70–80% of sessions**, and *lower* than that among our target
users, who rehearse on phones and whom we are actively pushing to install the PWA — which on iOS turns the feature
off. Plan accordingly.

#### On-device mode (`processLocally`) — real, but narrow

Chrome 139 (Aug 2025) shipped an opt-in on-device path:

```js
const status = await SpeechRecognition.available({
  langs: ['en-GB'], processLocally: true, quality: 'dictation'
}); // 'available' | 'downloadable' | 'downloading' | 'unavailable'
if (status === 'downloadable') await SpeechRecognition.install({ langs:['en-GB'], processLocally:true });
recognition.processLocally = true; // must be true or the promise-checked guarantee doesn't hold
```

- No audio and no transcript leaves the device. This is exactly what we want for a privacy-first rehearsal app.
- **Chrome desktop only** (Win/mac/Linux, ChromeOS "to follow"). **Not Android. Not Safari. Not iOS.** ~17 languages.
- Language-pack download sizes are not documented; treat as "tens to a few hundred MB, user-visible, may sit in
  `downloading` for minutes." There are open bugs where it hangs in `downloading` forever (macOS, and Brave never
  installs the SODA component) — so **always time out `install()` at 90 s and fall back**.
- Smaller vocabulary than cloud. For scripts this is usually *fine* because of the next point.

#### Contextual biasing (`phrases`) — the one genuinely exciting API for us

Chrome 140 shipped `SpeechRecognition.phrases`, an array of `SpeechRecognitionPhrase { phrase, boost }` where
`boost ∈ [0, 10]` is roughly the natural log of how much more likely we think the phrase is.

For a rehearsal app this is close to cheating: **we already know exactly what the user is about to say.** Feeding the
next 1–3 lines in as boosted phrases should collapse most ASR error on proper nouns, archaic diction ("prithee",
"wherefore"), and character names — precisely the words that make naive ASR scoring feel unfair in Shakespeare or a
sci-fi script.

```js
recognition.phrases = upcomingTokens(cursor, 40)
  .map(t => new SpeechRecognitionPhrase({ phrase: t.raw, boost: t.isProperNoun ? 6 : 3 }));
// plus whole-line phrases, which bias n-grams not just unigrams:
recognition.phrases.push(new SpeechRecognitionPhrase({ phrase: currentLine.text, boost: 4 }));
```

**Caveats:** Chrome ≥140, **desktop only**, and Chrome's implementation only supports biasing **in on-device mode**
(`processLocally = true`). So: desktop Chrome gets a dramatically better experience than everything else. Build the
biasing hook as an optional capability, keep the scorer's fairness rules (§1.4) strong enough that the *unbiased*
path is still not insulting.

#### Language codes

BCP-47, set explicitly — **never rely on the default**, which comes from the document's `lang` attribute and silently
destroys accuracy if wrong. Ship a per-text language selector defaulting to the UI locale:
`en-GB, en-US, en-AU, es-ES, es-MX, fr-FR, de-DE, it-IT, pt-BR, nl-NL, sv-SE, pl-PL, ja-JP`.
Store `lang` **on the text record**, not globally — an actor may have a French monologue in an English library.
Mismatched region codes (`en-US` on a British speaker) degrade accuracy noticeably; expose the choice.

#### Session-shape recipe per platform (the practical bit)

```
Chromium desktop:  continuous = true, interimResults = true, maxAlternatives = 5,
                   processLocally where available, phrases refreshed on each line advance.
                   One long session per rehearsal; restart on `end` with backoff.
Chromium Android:  continuous = true, interimResults = true, maxAlternatives = 3.
                   Expect spontaneous `end` after ~5–60 s silence → auto-restart (see below).
Safari (all):      continuous = FALSE, interimResults = FALSE, maxAlternatives = 1.
                   ONE SESSION PER LINE: start() on line begin, stop() on VAD silence or tap.
                   Accept the start chime. Do not restart-loop — the chime becomes unbearable.
iOS standalone:    unsupported → Tier 1 VAD fallback (§1.7) + a one-time "open in Safari for
                   voice checking" affordance.
```

The auto-restart loop, which every real implementation ends up needing:

```js
// Singleton — create ONCE at module load. Re-constructing per start causes iOS chime spam
// and stale-permission weirdness.
const rec = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
let wantListening = false, restarts = 0, lastStart = 0;

rec.onend = () => {
  if (!wantListening) return;
  const uptime = performance.now() - lastStart;
  if (uptime < 400) restarts++; else restarts = 0;  // rapid-fail detection
  if (restarts > 4) return fail('recognition-unstable');
  setTimeout(safeStart, Math.min(100 * 2 ** restarts, 2000));
};
rec.onerror = (e) => {
  // 'no-speech'      → benign, restart
  // 'aborted'        → we did it, honour wantListening
  // 'audio-capture'  → no mic hardware → hard fail to fallback
  // 'not-allowed'    → permission denied (Safari also uses this for OS-level speech block)
  // 'service-not-allowed' → vendor speech service refused / offline
  // 'network'        → cloud ASR unreachable → offer offline modes
  if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { wantListening = false; showPermissionHelp(e.error); }
  if (e.error === 'audio-capture') { wantListening = false; degradeTo('silent'); }
};
function safeStart(){ try { lastStart = performance.now(); rec.start(); }
                      catch { /* InvalidStateError: already started — ignore */ } }
```

Also: **stop listening after 60 s with no matched progress.** A hot mic burning battery and cloud quota while the
user has walked away is both rude and, on iOS, a reliable way to get the session wedged.

### 1.2 Normalisation — the tokeniser

Everything downstream depends on this. Build it as one pure module with a fat unit-test suite (this is the single
best place to spend testing effort in the whole app).

**Parse time (once per text, cached in IndexedDB):** produce an immutable token array per line.

```ts
type Token = {
  i: number;              // global index
  lineId: string;
  raw: string;            // "Don't," — what we render
  charStart: number; charEnd: number;   // offsets into the line's display string, for highlighting
  norm: string;           // "dont"
  variants: string[];     // ["dont","do","not"] — see contractions below
  phone: string;          // double-metaphone primary key, e.g. "TNT"
  stem: string;           // light stem: "dont"
  isFunction: boolean;    // a, the, and, of, to, is, ... (see fairness rules)
  isProperNoun: boolean;  // capitalised mid-sentence AND not in top-20k word list
  syllables: number;      // for duration estimates (§2.3, §3.4)
};
```

Pipeline, in order:

1. **Strip non-spoken material at parse time, not match time.** Stage directions `(beat)`, `[exits]`, character
   headers `HAMLET:`, page numbers, `CONT'D`, `(more)`. These become `Token`-less spans marked `spoken: false` so
   they render but never score. Getting this wrong is the #1 source of bogus "you missed a word."
2. Unicode **NFKC**; map typographic punctuation to ASCII (`’ ‘ “ ” – — …` → `' ' " " - - ...`).
3. **Lowercase** (keep the original casing in `raw` for proper-noun detection *before* lowering).
4. **Tokenise on whitespace + punctuation, keeping intra-word `'` and `-`.** `"well-meaning"` → one token with
   variants `["wellmeaning","well","meaning"]`; `"don't"` → `dont`.
5. **Numbers → words, bidirectionally.** ASR output is wildly inconsistent (`"1985"` vs `"nineteen eighty five"`,
   `"3rd"` vs `"third"`, `"£5.99"` vs `"five pounds ninety nine"`). Do **not** rewrite — generate *variants*:
   `1985 → variants ["1985","nineteen eighty five","one thousand nine hundred eighty five"]`, and on the hypothesis
   side also collapse digit-runs to words. Cover: cardinals, ordinals, years, currency, time-of-day, `%`.
6. **Contractions as equivalence classes, not rewrites.** `dont ≡ do not`, `im ≡ i am`, `its ≡ it is` (note the
   deliberate collision with possessive `its` — accept it, that's what the homophone class is for), `wont ≡ will
   not`, `cant ≡ can not ≡ cannot`, `lets ≡ let us`, `ive`, `youre`, `theyre`, `weve`, `shouldve`, `gonna ≡ going
   to`, `gotta ≡ got to`, `wanna ≡ want to`, `o'er ≡ over`, `'tis ≡ it is`, `ne'er ≡ never`. Implementation: the
   aligner may consume **1 expected token against 2 hypothesis tokens** (and vice versa) when the concatenation
   matches a variant. This is a *merge/split* operation in the alignment — see §1.3.
7. **Filler removal, hypothesis side only:** `uh, um, erm, er, ah, hmm, mm, like` (only `like` when it is not in the
   expected line — never delete a word we're actually looking for).
8. **Homophone / near-homophone equivalence classes** (score 0.95, i.e. "correct" but flagged as
   *unverifiable-by-audio*): `to/too/two`, `there/their/they're`, `your/you're`, `its/it's`, `whose/who's`,
   `hear/here`, `know/no`, `right/write/rite/wright`, `wear/where/were/we're`, `weather/whether`, `buy/by/bye`,
   `one/won`, `four/for/fore`, `be/bee`, `see/sea`, `son/sun`, `their/there`, `peace/piece`, `principal/principle`,
   `aloud/allowed`, `passed/past`, `threw/through`, `bear/bare`, `break/brake`, `plain/plane`, `road/rode/rowed`,
   `steal/steel`, `tail/tale`, `wait/weight`, `waste/waist`, `which/witch`, `hour/our`, `new/knew`, `not/knot`,
   `flour/flower`, `great/grate`, `made/maid`, `mail/male`, `meat/meet`, `pair/pear/pare`, `sight/site/cite`,
   `some/sum`, `weak/week`, `wood/would`, `board/bored`, `cell/sell`, `cent/scent/sent`, `dear/deer`, `die/dye`,
   `fair/fare`, `find/fined`, `heard/herd`, `heel/heal`, `hole/whole`, `in/inn`, `lead/led`, `loan/lone`,
   `mist/missed`, `pale/pail`, `pause/paws`, `poor/pour/pore`, `rain/reign/rein`, `scene/seen`, `stair/stare`,
   `there's/theirs`, `throne/thrown`, `tide/tied`, `vain/vein/vane`, `war/wore`, `way/weigh`, `won't/wont`.
   **Critical:** these are cases where the *audio was correct* and only the recogniser's spelling choice differs.
   Never, ever show these as errors — the user will lose trust instantly and permanently.
9. **Double Metaphone** phonetic key per token (`phone`). This is the fairness backstop: `"Cordelia"` heard as
   `"cordial ya"` should not be a red mark.
10. **Light stemmer** (strip `s/es/ed/ing/ly`, with the usual doubling rules). Tense/number slips are a real memory
    error but a *minor* one — score 0.6, amber, never a fail on their own.

Ship all of it under ~15 KB. No NLP library, no wasm; a hand-rolled double-metaphone is ~150 lines and a number-to-
words is ~80. Do not pull in `compromise`/`natural` — they're 100s of KB and we need none of it.

### 1.3 Alignment algorithm

**Recommendation: Needleman–Wunsch global alignment over word arrays with a graded, phonetics-aware substitution
score and asymmetric gap penalties. Banded for long inputs. Plus a merge/split extension for contractions.**

**Why not the alternatives:**
- **Plain Levenshtein on words** — fine for a *number* (WER) but throws away the alignment path, and we need
  per-word verdicts and character offsets to highlight. Also can't express "this substitution is 90% right."
- **DTW** — wrong tool. DTW is monotonic *without deletion*: every expected token must consume ≥1 hypothesis frame.
  Skipped lines and dropped words — the exact things we're measuring — are unrepresentable. DTW is right for audio
  frames, wrong for token sequences. Do not use it.
- **Smith–Waterman (local)** — useful for one specific job: "where in the script is the user right now?" when they
  jump around (§1.5 re-sync). Keep it in the toolbox for that, not for scoring.

**Scoring function.** Let `sim(e, h) ∈ [0,1]`, computed in short-circuit order:

| Condition | `sim` | Verdict class |
|---|---|---|
| `e.norm === h.norm` or `e.variants ∩ h.variants ≠ ∅` | 1.00 | correct |
| same homophone class | 0.95 | correct (audio-identical) |
| `e.phone === h.phone` (double metaphone) | 0.85 | correct-ish → **near** |
| `1 - lev(e.norm,h.norm)/max(len) ≥ 0.80` | 0.82 | **near** |
| `e.stem === h.stem` | 0.60 | substituted (minor) |
| `e.isProperNoun && (phone similarity ≥ 0.6 or lev ratio ≥ 0.55)` | 0.70 | **near** (relaxed — ASR mangles names) |
| otherwise | 0.00 | substituted |

Alignment score matrix (tuned by hand against a corpus of real transcripts — see §1.9):

```
S(e,h) = +2.0   if sim ≥ 0.95
         +1.0   if sim ≥ 0.80
         -0.5   if sim ≥ 0.60
         -1.5   otherwise

gapExpected(e) = -0.55  if e.isFunction      // ASR drops "a"/"the"/"and" constantly
                 -1.30  otherwise
gapHypothesis(h) = -0.30 if h.isFiller       // "um" costs almost nothing
                   -0.45 if h.isFunction
                   -1.20 otherwise
```

Asymmetric, per-token gap costs are the whole trick. A uniform gap penalty produces alignments that punish the user
for the recogniser's dropped articles; these numbers don't.

**Merge/split extension.** In the DP recurrence, additionally allow:
- `(1 expected, 2 hypothesis)`: `S(e, h_j + h_{j+1})` where the hypothesis pair is concatenated and normalised
  (`"do"+"not"` vs `dont`).
- `(2 expected, 1 hypothesis)`: symmetric (`"can"+"not"` vs `cannot`).
Cost = `S` of the merged comparison, minus 0.15. This turns contraction handling from a pile of special cases into
two extra cells in the recurrence.

**Banding for long texts.** Full NW on a 5 000-word script against a 5 000-word transcript is 25 M cells — too slow
for a phone and unnecessary, because the two sequences are near-monotonic. Use a **banded** NW: only compute cells
where `|i·(m/n) - j| ≤ k`, with `k = 24 + |n-m|`. Complexity drops to `O(n·k)` — ~120 K cells for a full script,
low single-digit milliseconds. Guard: if the optimal path touches the band edge, widen `k` ×2 and redo (at most
3 times). Below 400 tokens, just do the full matrix; it's simpler and fast enough.

**Live streaming aligner (different code path — do not re-run whole-text NW on every interim event).**

```
state: cursor (expected token index), committed[] (verdicts), hypCursor
on each interim/final result:
  W  = expected tokens [cursor, cursor + 30)              // look-ahead window
  H  = new hypothesis tokens since hypCursor, plus 8 tokens of context before
  run full NW on W × H              (≈ 30 × 40 = 1200 cells, ~50 µs — do it on every keystroke-equivalent)
  advance cursor past the longest prefix of W that is matched AND stable (§1.4 rule 5)
  emit provisional verdicts for the window; DO NOT commit them yet
```

Interim results are *revised* by every recogniser — words appear, change, and vanish. Verdicts must be provisional
until either the segment goes `isFinal`, or the cursor has moved ≥4 tokens beyond them. Committing early and then
flickering a word from red to green is the fastest way to make the app feel broken.

### 1.4 Fairness rules — never blame the user for the recogniser

This section is the product. Everything else is table stakes; an ASR-scored rehearsal tool that blames you for its
own mishearings is worse than no tool, because it actively teaches you to distrust your own recall.

1. **Phonetic escape hatch.** Never mark a token wrong when `e.phone === h.phone`. If it sounded the same, you said
   it. Render as green with a tiny dotted underline meaning "heard as *cordial ya*" on tap.
2. **Function words are free by default.** Omitted/inserted `a/an/the/and/of/to/is/that/it/in` do not count. Expose a
   "strict articles" toggle for people doing verse or legal text where every word matters; default OFF.
3. **Score against all alternatives.** Set `maxAlternatives = 5` (Chromium) and score the hypothesis that gives the
   *best* score, not `results[i][0]`. Cheap and buys several points of apparent accuracy. Safari usually returns 1
   alternative — handle gracefully.
4. **Confidence gating.** Where `alternative.confidence` is populated (Chromium finals), a segment with
   `confidence < 0.5` is marked **unscored** — "didn't catch that" — not wrong. Safari's confidence values are
   unreliable/absent; if `confidence` is `undefined` or `0`, treat as *unknown* and skip gating entirely rather than
   guessing.
5. **Stability window.** A verdict is committed only when `isFinal` OR cursor has advanced ≥4 tokens past it.
   Retro-correct silently on revision. Never animate a green→red transition.
6. **Two-strike rule for the stats.** A word only enters "your most-missed words" if it was missed at
   *final-result* time in **two separate attempts**. One-off ASR noise never pollutes long-term stats.
7. **Proper nouns and invented words get `sim ≥ 0.65` = correct.** Names, places, sci-fi coinage, Shakespearean
   diction. Also: auto-add every proper noun in the text to `phrases` biasing where available (§1.1).
8. **"Didn't hear you" ≠ "wrong".** If `nomatch` or `no-speech` fired, or our own VAD says mic RMS never exceeded
   the noise floor, show a neutral "we couldn't hear you — check the mic" state. Distinguish silence from error in
   the UI with different colours and different copy.
9. **Never fail a line on one discrepancy** when the line is ≥8 tokens long. One word out of twelve is a fluff, not
   a failure; mark the word, pass the line.
10. **Show the recogniser's raw transcript on demand.** A "what we heard" disclosure under each scored line. This
    single affordance converts "this app is broken" into "oh, the recogniser misheard me" and it costs nothing.
11. **A visible, honest accuracy caveat** in the results screen: "Voice checking uses your browser's speech
    recogniser, which makes mistakes — especially with names, accents and fast delivery. Treat the score as a hint,
    not a verdict." Say it once, prominently, and then never nag.

### 1.5 Thresholds — "you got this line"

Compute over **content tokens** (`!isFunction`) unless strict mode:

```
correctish  = count(verdict ∈ {correct, near})
N           = count(content tokens)
wordAcc     = correctish / N
runIntegrity= longestOrderedMatchRun / N        // guards against saying the right words in the wrong order
worstGap    = longest run of consecutive omitted content tokens
```

**PASS** iff:

```
wordAcc ≥ T
AND worstGap < 3
AND (N ≥ 4 ? true : wordAcc === 1.0)            // very short lines ("Yes." / "Get out!") need exact
AND runIntegrity ≥ 0.6
```

| Difficulty | `T` | Function words counted? | Homophones | Intended for |
|---|---|---|---|---|
| Gentle | 0.75 | no | free | first pass, students, kids |
| **Normal (default)** | **0.90** | no | free | actors learning lines |
| Strict | 0.98 | **yes** | free | verse, legal, liturgical, lyrics |
| Verbatim | 1.00 | yes | **counted as errors** | final polish; warn that ASR spelling noise will bite |

Scene/whole-text pass: **≥90% of lines pass and no line failed twice in the same run.**

Also report an honest **WER** (`(S+D+I)/N`) alongside our **adjusted score**, with both numbers visible on the
results screen. Two numbers, clearly labelled, is more trustworthy than one massaged number.

### 1.6 Live prompting UX

**The half-duplex law.** `SpeechRecognition` manages its own microphone stream; we do not control its
`getUserMedia` constraints and therefore cannot rely on echo cancellation against our own `speechSynthesis` output.
If TTS and recognition run at once, the recogniser will happily transcribe *our own prompt* and score the user as
having said it. **Never run TTS and recognition simultaneously.** Enforce with a single state machine:

```
IDLE → PARTNER_SPEAKING → (utterance end + 250 ms) → USER_TURN(listening) → SCORING → …
Any transition into PARTNER_SPEAKING must first abort() recognition and await its `end`.
Any transition into USER_TURN must first speechSynthesis.cancel() (and not await `end` — Safari never fires it).
```

**Text display states** (composes with the hide-words masking from the core memorisation modes):

| State | Rendering |
|---|---|
| Consumed & correct | dimmed 45%, no mask |
| Consumed & near | dimmed, dotted underline; tap → "heard as …" |
| Consumed & wrong/omitted | amber underline, word visible (you need to see what you missed) |
| Current window (next ~6 tokens) | full contrast, mask applied per the chosen memorisation method |
| Not yet reached | mask applied, slightly dimmed |
| Whisper-prompted | word revealed with a distinct "hinted" tint, permanently marked in the report |

**Auto-advance.** On a *provisional* pass from interim results, advance immediately (150 ms debounce) — perceived
responsiveness matters more than correctness here, because we retro-correct on the final result anyway. Advance
means: scroll the next line into view at 38% viewport height, and move the mask window. Keep auto-scroll on the same
smooth-scroll engine as the core auto-scroll feature; honour `prefers-reduced-motion`.

**Whisper prompt (stuck-detection ladder).** Cursor hasn't advanced for `T` (default 3 s, settings 2/3/5/off):

```
T×1  → reveal the NEXT ONE WORD only, with a soft pulse animation
T×2  → reveal the next 3 words
T×3  → reveal the rest of the line, mark line as `prompted`, and offer "say it again"
```

Optional **spoken** whisper prompt ("earpiece mode"): speak just the next word at reduced volume. Because of the
half-duplex law this requires `abort()` → `speak()` → `restart()`, costing ~400–900 ms and, on iOS, a chime. Gate it
behind a "headphones connected?" self-declaration and default it OFF. One-word-at-a-time is deliberately stingier
than MemoCoach's long-press reveal — it's a *prompt*, like a real prompter in the wings, not a spoiler.

**Also worth capturing per line, cheaply, and surprisingly motivating:**
- **Time-to-first-word** (hesitation). The clearest single signal of "not yet in the body."
- **Pace** (content words/sec) vs the user's own rolling median. Flags rushing, which is the classic
  under-rehearsed tell.
- **Prompt count.** The number that should go to zero.

**End-of-session report:**
1. Per-line strip: pass/fail, hesitation, prompts, and the exact fluffed words (tap → "what we heard").
2. **Trouble spots**: heatmap over the script. Persist per-token miss counters keyed `(textId, tokenIdx)` with an
   EWMA (`α = 0.4`) so recent runs dominate and old struggles fade.
3. **Most-missed words across sessions**, aggregated across texts too — actors discover real patterns here
   ("I always drop 'therefore'").
4. **Drill mode**: generate a practice set of only the lines containing the top-N troubled tokens. This is where
   voice scoring pays for itself, and it is something MemoCoach cannot do at all because it never hears you.

### 1.7 Fallbacks — the honest degraded path

**Never silently degrade.** A persistent, tappable mode badge in the practice header naming the active mode, e.g.
`◉ Voice check` / `◉ Timing only` / `◉ Self-grade`, with a tap-through explaining exactly what is and isn't being
checked and why.

| Tier | Requires | What it actually checks | Where it works |
|---|---|---|---|
| **0 — Silent recall / self-grade** | nothing | Nothing automatic. Tap/space reveals next chunk; user self-grades **Got it / Shaky / Missed**. Feeds the same trouble-spot stats | Everywhere. **This is the floor and must be genuinely good on its own** |
| **1 — Timing only (VAD)** | `getUserMedia` | That you spoke, when you started, when you stopped, and whether the duration is plausible for the line (±40% of `syllables × 190 ms / rate`). **No words are verified.** Auto-advances on 700 ms of silence | Anywhere with mic access, incl. iOS standalone (verify — there are reports of empty audio in iOS standalone; probe by checking RMS > floor within 3 s and fall to Tier 0 if not) |
| **2 — Record & self-review** | `MediaRecorder` | Nothing automatic; you listen back and judge (§3) | ~99% |
| **3 — Voice check** | `SpeechRecognition` | Words, per §1.3–1.5 | ~70–80% |
| **4 — Local Whisper review** | WebGPU + 40–150 MB | Words, post-hoc, more accurately (§1.8) | Opt-in, modern desktop mostly |

Tier 1 is worth building properly because it is cheap and it rescues the iOS-standalone case. Implementation: one
`AudioWorkletNode` (fall back to `AnalyserNode` + `getByteTimeDomainData` on older Safari) computing RMS at ~50 Hz;
adaptive noise floor = 20th percentile of the last 3 s; speech = RMS > floor × 3.5 for >120 ms; end = below for
>700 ms. ~60 lines of code. Copy must be scrupulously honest: **"Timing only — we can hear that you're speaking,
but we're not checking the words."**

Detection, once, at app start, and cached:

```ts
export const caps = {
  asr: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
  asrLikelyBroken:                       // the iOS-standalone trap
    isIOS() && (navigator.standalone === true ||
                matchMedia('(display-mode: standalone)').matches),
  asrOnDevice: 'available' in (window.SpeechRecognition ?? {}),
  asrPhrases: 'phrases' in ((window.SpeechRecognition ?? window.webkitSpeechRecognition)?.prototype ?? {}),
  tts: 'speechSynthesis' in window,
  mic: !!navigator.mediaDevices?.getUserMedia,
  recorder: typeof MediaRecorder !== 'undefined',
  webgpu: 'gpu' in navigator,
  wakeLock: 'wakeLock' in navigator,
};
```

Because feature detection **cannot** see the iOS-standalone failure, add a **runtime watchdog**: after `start()`,
if no `start`/`audiostart`/`result`/`error` event arrives within 2500 ms, declare ASR non-functional, persist that
verdict for this install, degrade to Tier 1, and show a one-time card: *"Voice checking doesn't work in installed
web apps on iPhone — an Apple limitation. Open Cue in Safari to use it."* with a copy-link button. Ship the
watchdog on all platforms; it also catches WKWebView and enterprise-blocked cases.

**Re-sync (all voice tiers).** Users skip, restart, and jump. Every 2 s during a session, run **Smith–Waterman
(local alignment)** of the last 12 hypothesis tokens against the *whole* text. If the best local match is ≥8 tokens
away from the cursor and scores >1.6× the local-window score, offer a non-modal "Jump to *'…but soft, what light'*?"
chip rather than silently teleporting. Silent teleporting feels haunted.

### 1.8 Local Whisper — recommendation: **not in v1; opt-in "Review my take" later**

Numbers, July 2026 (Transformers.js + ONNX Runtime Web):

| Model | Quantised size | WASM speed | WebGPU speed |
|---|---|---|---|
| `whisper-tiny.en` | ~40 MB | ~2–5× real-time (10 s audio → 20–50 s) — **unusable** | roughly real-time or better |
| `whisper-base.en` | ~80 MB q8 / 145 MB fp16 | worse | real-time on modern hardware; hybrid-quantised builds reported at 5–8× real-time |
| `whisper-small.en` | ~150–240 MB | no | near real-time on a good GPU only |

WebGPU is now everywhere that matters — Chrome/Edge 113+, Firefox (2025), and **Safari 26 on macOS Tahoe 26 / iOS 26
/ iPadOS 26** (Sept 2025) — with automatic WASM fallback. So the *platform* is finally there. The problems are
product problems, not support problems:

- **Whisper is a batch model.** It wants 5–30 s chunks. It gives you a good transcript 1–3 s *after* the fact. It
  cannot drive word-by-word live highlighting, which is the feature people will actually love.
- **It hallucinates on silence** — invents "Thank you for watching" and similar on empty audio. Fatal for a
  rehearsal app full of dramatic pauses. Requires a VAD gate in front of it (which we have from Tier 1).
- **It normalises text**: adds punctuation, writes numbers as digits, capitalises. Must go through the same §1.2
  normaliser; don't assume it's cleaner than the Web Speech output just because it's better ASR.
- **Contextual biasing is awkward** (prefix/`initial_prompt` tokens; Transformers.js support is limited), so we lose
  the one trick that makes our domain easy.
- **Weight hosting.** 40–150 MB is not free to serve. Loading from the Hugging Face CDN is free-as-in-beer but
  introduces a third-party network dependency, which sits awkwardly with our privacy pitch — and it's a
  ~30–120 s first-run download on mobile data.

**Recommendation:** ship it in a later phase as **"Accurate review (offline)"** — explicit opt-in, explicit "download
82 MB?" confirmation, weights fetched from the HF CDN and then cached in Cache Storage / OPFS so it is genuinely
offline afterwards. Use it for **post-hoc scoring of a recorded take** (which pairs perfectly with §3 — you're
already recording the audio, so score the blob), *not* for live prompting. Live prompting stays on Web Speech.
Gate on `caps.webgpu`; refuse on WASM-only with an honest "your device is too slow for this."

This also yields the best combination available today: **Web Speech for live, Whisper for the honest scorecard,**
and on desktop Chrome, on-device Web Speech with contextual biasing for both.

### 1.9 Testing the scorer

The scorer cannot be tested by hand-waving; build the harness first.

1. **Fixture corpus.** Record ~40 real attempts across 6 scripts (Shakespeare, contemporary drama, stand-up, song
   lyrics, a wedding speech, a GCSE poem) at 3 accents and 3 speeds. Save the *raw transcripts + our expected text +
   a human-labelled per-word verdict*. Commit the JSON, not the audio (privacy, size).
2. **Golden tests** on the tokeniser: ~200 normalisation cases, every homophone class, every contraction, numbers
   in both directions, stage-direction stripping.
3. **Metric to optimise:** not raw agreement, but **false-blame rate** = fraction of tokens the human labelled
   correct that we mark wrong. Target **< 2%**. Then maximise recall of true misses subject to that ceiling. Weight
   asymmetrically and deliberately: **a false accusation costs ~10× a missed detection.**
4. **Property test:** for any text, feeding the *exact* expected text as the hypothesis must yield a 100% score with
   zero flags. Sounds trivial; catches a startling number of tokeniser asymmetries.

---

## 2. Text-to-speech — the scene partner

### 2.1 Platform reality

`speechSynthesis` is the well-supported half — available in **every** modern browser including iOS 7+, including
installed iOS web apps, no permission prompt, no network required for local voices. It is also a minefield of
per-engine quirks.

| Quirk | Detail | Mitigation |
|---|---|---|
| **`getVoices()` returns `[]` on first call** | Chromium loads voices asynchronously | Await a promise resolved by `voiceschanged` **and** a 100 ms poll, 3 s timeout → fall back to default voice |
| **Safari has no `addEventListener('voiceschanged')`** | Only the `onvoiceschanged` property works | Assign the property *and* poll. Don't rely on either alone |
| **Voice names are not unique in Safari** | Two "Daniel"s | Key everything on `voiceURI`, never `name` |
| **iOS needs a user gesture** | First `speak()` must be inside a gesture-initiated task or it's silently dropped | On the "Start rehearsal" tap, immediately `speak(new SpeechSynthesisUtterance(' '))` to unlock the synth for the session |
| **iOS honours the hardware mute switch** for TTS | Silent switch = silent scene partner, no error, no clue | Warn in the pre-flight card. Creating/resuming an `AudioContext` on the same gesture sometimes promotes the audio session to playback — try it, don't promise it |
| **Chrome cuts off long utterances at ~15 s** | Only with **remote** (network) voices | Chunk to sentences / ≤180 chars. (The `resume()`-every-14 s hack works but is grim; chunking is right) |
| **Android cannot change voice** | Effectively locked to the system default | Differentiate characters by `rate`/`pitch` only, and **say so in the UI** |
| **Android `pause()`/`resume()` don't work** | Non-functional | Implement pause as `cancel()` + remember position + re-`speak()` the remainder |
| **Safari doesn't fire `end` after `cancel()`** | Your state machine deadlocks waiting | Generation counter; treat `cancel()` as immediately terminal. Never `await` `end` |
| **`pitch ≤ 0.5` all sounds the same in Safari**; Safari `rate` sticks when going high→low; Edge ignores `pitch` on remote voices; Chrome resets `pitch: 0`→1 and refuses `rate > 2` on remote voices | | **Clamp `rate` to [0.5, 2.0] and `pitch` to [0.6, 1.6]** and accept that character voices vary by platform |
| **Remote voices send your text to the vendor** | Chrome's "Google …" voices are network voices | In offline/private mode, filter to `voice.localService === true` (§4) |

**`boundary` events — the karaoke problem.** Not Baseline. **Chromium desktop: per word. Safari: per *sentence*
only, and without `charLength`. Android Chrome/Firefox: does not fire at all.** macOS never reports
`name === 'sentence'`; Windows returns wrong `charLength` for sentence boundaries.

**Conclusion: word-level karaoke highlighting is not reliably available.** Do not fake it. Capability-probe once:

```ts
// Probe with volume 0 on a short utterance; observe what arrives.
async function probeBoundary(): Promise<'word'|'sentence'|'none'> { /* 1.5 s timeout, cache in localStorage */ }
```

Then:
- `'word'` → true word-level highlighting.
- `'sentence'` → **highlight at sentence level.** Honest and still useful.
- `'none'` → **highlight at sentence level using estimated timings**, never word level. Estimator:
  `ms(sentence) = (syllables × 190 + tokens × 55) / rate`, then snap to the real `end` event. Word-level estimation
  drifts visibly within two lines and looks broken; sentence-level drift is invisible because the snap corrects it.

Also: `boundary.charIndex` is an offset into *that utterance's* text. Since we chunk (Chrome 15 s limit), keep a map
from utterance-local char offsets → global token indices, or you will highlight the wrong words in long lines.

### 2.2 Scene partner mode

The actor's core need, and a direct extension of MemoCoach's "practise only my character's lines": **the app reads
everyone else, and shuts up for you.**

```
Setup (once per text): detect character headers → user assigns "me" + optional voice per character.
Loop per line:
  if line.character !== me:
     PARTNER_SPEAKING — speak with that character's voice; highlight per §2.1 probe result;
                        the last 4–6 words render as the CUE, in full contrast, always unmasked
                        (matching how actors actually work off cue lines)
  else:
     USER_TURN — see the four sub-modes below
```

**USER_TURN sub-modes**, in preference order, auto-selected from `caps` and user setting:

| Mode | Ends the turn when | Notes |
|---|---|---|
| **(a) Listen** | line passes §1.5, or stuck-ladder exhausts | Best experience. Requires ASR. Half-duplex: recognition starts **250 ms after** the partner's last utterance ends, so we don't transcribe the tail of our own voice |
| **(b) VAD** | speech detected, then 700 ms silence (cap at 2.5× estimated duration) | Available almost everywhere. Feels remarkably good — it's what a human partner does |
| **(c) Timed** | `estimatedDuration(line) × paceFactor` elapses, min 800 ms | `estimatedDuration = words / (targetWPM/60)`, `targetWPM` default 150 and **learned from the user's own measured pace** (§1.6). `paceFactor` slider 0.7–1.6. Zero permissions |
| **(d) Tap** | tap anywhere / spacebar / earbud remote-ish | The reliable floor. Note media-key capture is not dependable; don't promise it |

Timing polish that makes the difference between "toy" and "rehearsal partner":
- **250 ms lead-in** before the user's turn and **150 ms tail** after, so the user is never clipped and never feels
  rushed into their cue.
- **Pre-queue the next utterance on the current utterance's `start` event**, not its `end` — otherwise there is an
  audible 100–400 ms hole between every line, which destroys the illusion completely.
- **Count-in** option: three soft ticks before the user's first line of a run.
- **"Overlap" toggle** for advanced users: start the user's turn 300 ms *before* the partner finishes, which is how
  real dialogue works and is great for comedy timing.

### 2.3 Listen mode

Read the whole text aloud. Rate 0.5–2.0 (clamped per §2.1). Sentence-level highlight. Auto-scroll keeping the active
sentence at 38% viewport height using `scroll-margin-block-start` + `scrollIntoView({behavior:'smooth', block:'start'})`,
suppressed under `prefers-reduced-motion`. Options: skip my lines / only my lines / everything; loop; A–B section
repeat (invaluable for a tricky passage).

**Background and lock-screen playback — honest answer: not available.**

`speechSynthesis` is not a media element and not an `AudioNode`. Therefore:
- **`MediaSession` does not apply.** No lock-screen artwork, no transport controls, no `nowplaying`.
- **Backgrounding the tab or locking the screen stops or indefinitely stalls speech** on iOS; Android Chrome often
  continues but uncontrollably and inconsistently. There is no supported way to hold the audio session.
- **There is no way to record or export browser TTS to a file.** No node to tap, so `MediaRecorder` and
  `OfflineAudioContext` are both out. "Export my rehearsal MP3" is impossible with `speechSynthesis`, full stop.

Mitigations, in order of honesty:
1. **Keep listen mode foreground** and hold the screen on with the **Screen Wake Lock API**
   (`navigator.wakeLock.request('screen')` — Chromium, and Safari 16.4+; always feature-detect, re-acquire on
   `visibilitychange`, and release on stop). Show a "screen staying awake" indicator.
2. **Route background listening through §3 instead.** A recording of the user's own voice *is* an `<audio>` source,
   so it gets MediaSession, lock-screen controls, background playback, AirPlay and Bluetooth-remote control for
   free. Surface this in the UI as **"Want to rehearse with the screen off? Record your read-through."** This turns
   a platform limitation into a feature discovery — and it's the better rehearsal technique anyway.
3. If a user really wants a shareable audio file, that's a "record yourself" export (§3), not a TTS export.

---

## 3. Self-recording — the LineLearner technique, done properly

This is the sleeper feature: highest cross-platform reliability, works in installed iOS web apps, works with the
screen off, and it is the technique working actors have used since cassette tapes. MemoCoach doesn't advertise it.

### 3.1 Capture

`MediaRecorder` is supported in iOS Safari 14.5+ and everywhere else that matters. Format negotiation (Safari only
gained WebM/Ogg/ALAC/PCM in **18.4**; 14.1–18.3 is MP4/AAC only, and `isTypeSupported('audio/webm')` returned
`false` with no workaround):

```ts
const CANDIDATES = ['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/mp4;codecs=mp4a.40.2','audio/mp4',''];
const mimeType = CANDIDATES.find(t => t === '' || MediaRecorder.isTypeSupported(t));
const rec = new MediaRecorder(stream, {
  mimeType,
  audioBitsPerSecond: mimeType.includes('opus') ? 32_000 : 48_000,   // Opus mono voice is clean at 32k; AAC needs more
});
```

Request the stream with `{ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true,
autoGainControl: true } }`. For a "performance take" where the user wants to hear their real dynamics, offer a
**"raw" toggle** that disables NS/AGC — voice-processing constraints flatten dynamic range, and an actor evaluating
their own delivery will notice.

**Two capture modes:**

- **A — Read-through (default).** One continuous recording over the whole text. The user advances line by line (tap,
  or automatically via VAD/ASR), and we store cue marks `{lineId, startMs, endMs}`. One blob + an index. Fast,
  natural, no clipping.
- **B — Per-line re-record.** Overrides a single line with its own blob. Necessary (you always fluff one line) but
  should not be the default: `MediaRecorder.start()/stop()` has 100–300 ms of latency, so per-line capture reliably
  clips the first syllable.

**Timestamp accuracy.** Don't use wall-clock from `rec.start()` — the encoder starts late. Instead take
`t0 = audioContext.currentTime` at the recorder's first `dataavailable`/`start` event and record marks as offsets
from that; then **pad every mark by 150 ms on each side**. Padding is cheap and hides all remaining drift; unpadded
marks produce the "cuts off the first word" bug that makes the whole feature feel broken.

### 3.2 Storage

Blobs go in IndexedDB (store `takes`, keyed `(textId, takeId)`) alongside a `marks` array. IndexedDB stores `Blob`s
natively in all target browsers — do **not** base64 them (+33% and a main-thread stall).

| Format | Bitrate | Per minute | Per hour | 10-min scene |
|---|---|---|---|---|
| Opus mono (Chromium, Safari 18.4+) | 32 kbps | ~240 KB | ~14 MB | ~2.4 MB |
| AAC mono (Safari ≤18.3) | 48 kbps | ~360 KB | ~22 MB | ~3.6 MB |

50 scenes of 10 minutes ≈ **120–180 MB**. Against the quotas — Chromium ~60% of free disk; **macOS Sonoma / iOS 17+
compute per-origin quota from total disk space, with browser-wide allowance up to ~80% of disk** — storage volume is
**not** the binding constraint. **Eviction is.**

### 3.3 Retention & eviction policy

The actual risk is Safari's rule: **an origin with no user interaction in the last seven days of browser use has its
script-created data deleted.** Recordings are the one thing a user cannot recover.

1. Call `navigator.storage.persist()` on the **first recording**, framed as "keep my recordings safe." Chromium
   grants on engagement/installation; Safari grants for home-screen web apps. Persisted origins are skipped by
   eviction.
2. **Installed web apps added to the home screen are exempt from the 7-day rule** → prompt "Add to Home Screen"
   *before* the user accumulates takes, not after. (Note the tension with §1.1: installing kills ASR on iOS but
   saves the recordings. Resolve it by telling the truth in the install prompt and letting the user choose; the
   recordings matter more.)
3. **Tiered retention**, with a visible storage meter from `navigator.storage.estimate()`:
   - takes are `ephemeral` by default: **auto-delete after 30 days**, with a banner at 7 days remaining;
   - **keep max 3 takes per text**: newest + best-scored + any pinned;
   - "📌 Keep" pins a take forever;
   - one-tap "Free up space" listing takes by size with checkboxes;
   - deleting a text deletes its takes (with an undo window, not a scary modal).
4. **Never upload audio anywhere.** Not even to optional cloud sync — text and stats only. Say so explicitly (§4).

### 3.4 Playback: per-line seek and "mute my lines"

**The seeking trap.** A `MediaRecorder` WebM/Opus blob typically has no Cues element and no duration, so
`audio.duration === Infinity` and `currentTime` seeking is unreliable or outright broken. This will bite; plan for
it. Safari's MP4/AAC blobs seek fine, which perversely means iOS works and Chrome doesn't.

**Recommended architecture: decode once, schedule precisely.**

- Keep the blob for archival/export.
- For the rehearsal player, `decodeAudioData()` the blob into an `AudioBuffer` once per session and play segments
  with `AudioBufferSourceNode` + `start(when, offset, duration)`. This gives sample-accurate, gapless, glitch-free
  segment playback and makes "mute my lines" trivial to schedule ahead of time.
- **Memory:** 1 min mono float32 @48 kHz = 11.5 MB. So **downsample to 16 kHz mono on decode → ~3.8 MB/min**;
  decode lazily per section (2-minute windows) for long texts; release buffers on section change.
- Trade-off to be explicit about: `AudioBufferSourceNode.playbackRate` shifts pitch. For variable-speed playback,
  use an `<audio>` element with `preservesPitch = true` instead. **So: two players.** `AudioBuffer` engine for
  rehearsal (precision), `<audio>` engine for plain listen-back and background/lock-screen playback (MediaSession,
  speed control). Roughly 150 lines each; worth it.

**"Mute my lines" — the core LineLearner loop.** Build a segment playlist:

```
for each line in order:
  if line.character !== me:  PLAY   recorded audio for [start-150ms, end+150ms]
  else:                      SILENCE of duration = recordedDuration(line) × gapFactor   (default 1.0, slider 0.8–1.6)
                             + optional soft tick at start and end of the window
                             + visual countdown ring so the gap window is unambiguous
```

Refinements that make it feel professional:
- **Cue tail**: always play the last ~1.2 s of the preceding partner line at full volume, even in "only my lines"
  mode. The pickup cue must be unmistakable.
- **Duck, don't mute** (training wheels): a `volume: 0.08` setting instead of silence, so a struggling user still
  gets a faint prompt. Graduate to full silence.
- **Hybrid partner**: partner lines from **TTS** (§2) + user gaps from **estimated timing**. This delivers the full
  LineLearner experience with **no recording at all** — a genuinely better product than either alone, and it should
  probably be the default first-run experience.
- **Loop a section** with an adjustable gap; that's how lines actually get learned.
- Overlay `MediaSession` metadata (title = text name, artist = character) on the `<audio>` engine so the lock screen
  shows something meaningful and the play/pause/skip buttons map to line navigation.

---

## 4. Permissions & privacy

### 4.1 Microphone permission UX

**Never call `start()` or `getUserMedia()` on page load.** A cold permission prompt is the fastest way to a
permanent denial, and on iOS a denial is annoying to reverse.

1. **Pre-permission explainer**, reached only by the user tapping "Check my lines": one short card naming (a) why we
   need the mic, (b) **where the audio goes**, (c) that they can rehearse fully without it. Single primary button
   **"Enable microphone"**, secondary "Not now".
2. The real prompt is triggered **inside that tap's gesture** (required on iOS regardless).
3. State detection: `navigator.permissions.query({name:'microphone'})` works in Chromium. **Safari does not support
   it for microphone** — treat a throw as `'unknown'` and rely on the outcome of the attempt plus the §1.7 watchdog.
4. **Distinct recovery copy per platform and per error.** `not-allowed` on Safari can mean either the site was
   denied *or* speech recognition is blocked at OS level, which are different fixes:
   - iOS: Settings → Safari → Microphone; and check Settings → Privacy & Security → Microphone → Safari.
   - macOS Safari: Safari → Settings → Websites → Microphone.
   - Chrome: the lock/tune icon in the address bar → Microphone → Allow, then reload.
5. **Always-visible listening indicator**: a live level meter, not just a red dot, plus the mode badge (§1.7). Auto-
   stop after 60 s of no progress. Users must never wonder whether the mic is hot.
6. **Note for iOS:** speech recognition breaks after lock/unlock (mic button appears active but no audio arrives).
   Detect via the watchdog on `visibilitychange` and re-initialise rather than leaving a dead session.

### 4.2 What actually leaves the device — say this plainly

This is the section to be scrupulous about, because the truthful answer is not the one users assume.

| Feature | Leaves the device? |
|---|---|
| Texts, folders, progress, stats, recordings | **Never.** IndexedDB only |
| Silent recall, self-grade, hide-words modes | Nothing |
| VAD / timing-only mode | Nothing — audio is analysed in-page, never stored, never sent |
| Self-recording + playback | Nothing — blobs stay in IndexedDB |
| TTS with a **local** voice (`localService === true`) | Nothing |
| **TTS with a remote voice** (Chrome's "Google …" voices) | **The text of your script is sent to the vendor** |
| **Speech recognition** (Chrome/Edge/Safari, default) | **Your microphone audio is streamed to Google / Apple / Microsoft for transcription.** We never see it or store it — and we cannot prevent or inspect it |
| Speech recognition with `processLocally = true` | Nothing (Chrome desktop only) |
| Optional Whisper model download | One fetch of model weights from the Hugging Face CDN, on explicit tap; then fully offline |
| App itself | Static files on first load, then served from the service worker cache |

The cloud-ASR line must appear **in the mic explainer card**, not only in a privacy page. It is the one genuinely
surprising fact about this app and burying it would be a real breach of trust.

### 4.3 Draft privacy statement

> **Cue keeps your scripts on your device.**
> No account. No sign-up. No analytics. No trackers. No ads. Your texts, recordings, and practice history live in
> your browser's storage on this device and are never uploaded to us — we don't run a server that could receive them.
>
> Two features involve someone else's computer, and only when you switch them on:
>
> **Voice checking** uses your browser's own speech recogniser. In Chrome, Edge and Safari that means **your
> microphone audio is sent to Google, Microsoft or Apple** to be turned into text. That happens inside your browser,
> under their privacy policy, not ours — we only receive the text that comes back, and we don't store the audio. On
> Chrome for desktop you can turn on **On-device recognition**, and then nothing leaves your device at all.
>
> **Some computer voices are cloud voices.** If you pick one (usually named "Google …"), the text of your script is
> sent to the vendor to be spoken. Voices marked "on-device" don't do this.
>
> **Recordings of your voice never leave your device.** Not to us, not to anyone, not even if you turn on sync.
>
> **Private mode** turns off everything that talks to the network. See the toggle in Settings.
>
> Delete everything at any time: Settings → Clear all data. That's a real delete, not a flag.

### 4.4 Fully-offline / private mode toggle

One switch, `settings.privateMode`, on by default? — **No: default OFF, but offer it prominently in first-run**, and
force it ON if the user declines the mic. When ON:

- `SpeechRecognition` disabled entirely **unless** `processLocally` reports `'available'` (then allowed, and labelled
  "on-device"). Show *why* it's off, with a one-tap "use it anyway just this once."
- Voice list filtered to `localService === true`; remote voices shown greyed with "cloud voice" labels.
- Whisper download blocked (it's a network fetch) unless already cached.
- Any optional cloud sync disabled.
- A **`Content-Security-Policy` with `connect-src 'self'`** so that network egress from our own code is
  *structurally* impossible and auditable by anyone who cares. Be honest that CSP cannot restrain the browser's
  internal speech service — that traffic isn't ours to block.
- Service worker precaches everything; the app is fully functional in airplane mode in every non-ASR tier.

---

## 5. Module layout & phasing

```
src/voice/
  capabilities.ts      // caps probe + watchdog + persisted verdicts (§1.7)
  tokenize.ts          // normaliser, variants, metaphone, syllables (§1.2)  ← test this hardest
  align.ts             // banded Needleman–Wunsch + merge/split + Smith–Waterman resync (§1.3)
  score.ts             // verdicts, fairness rules, thresholds, WER (§1.4–1.5)
  asr.ts               // singleton SpeechRecognition, per-platform session shapes, restart logic (§1.1)
  vad.ts               // AudioWorklet RMS, speech/silence events (§1.7 Tier 1)
  tts.ts               // voice registry, gesture unlock, chunking, boundary probe, half-duplex lock (§2)
  partner.ts           // scene-partner state machine (§2.2)
  recorder.ts          // MediaRecorder negotiation, marks, blob store (§3.1–3.2)
  player.ts            // AudioBuffer segment engine + <audio> engine + mute-my-lines playlist (§3.4)
  stats.ts             // EWMA per-token miss counters, trouble spots, drill sets (§1.6)
  whisper.ts           // P5, lazy-imported, never in the main bundle (§1.8)
```

Everything in `src/voice/` must be importable and testable in Node with no DOM except `asr/tts/vad/recorder/player`,
which are thin adapters behind interfaces so `align`/`score`/`tokenize`/`stats` — the hard parts — are pure and
fixture-tested.

**Acceptance criteria worth writing down now:**
- Feeding the exact script text as a transcript scores 100% with zero flags, for all 6 fixture scripts.
- False-blame rate < 2% on the labelled corpus (§1.9).
- No green→red verdict transition ever occurs (assert in a test harness replaying real interim-result streams).
- Recognition and synthesis are never simultaneously active (assert via a state-machine invariant test).
- Every tier degrades with a visible, correctly-named mode badge; no tier ever silently pretends to check words.
- Full app works in airplane mode in tiers 0–2.

---

## 6. Sources

- [MDN: SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition) ·
  [processLocally](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/processLocally) ·
  [available()](https://developer.mozilla.org/docs/Web/API/SpeechRecognition/available_static) ·
  [phrases](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/phrases) ·
  [boundary event](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisUtterance/onboundary) ·
  [Storage quotas & eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- [W3C/WebAudio: on-device speech recognition explainer](https://github.com/WebAudio/web-speech-api/blob/main/explainers/on-device-speech-recognition.md) ·
  [contextual biasing explainer](https://github.com/WebAudio/web-speech-api/blob/main/explainers/contextual-biasing.md) ·
  [Intent to Ship: contextual biasing (Chrome 140, desktop only)](https://www.mail-archive.com/blink-dev@chromium.org/msg14350.html)
- [What PWA Can Do Today — Speech Recognition](https://whatpwacando.today/speech-recognition/) ("works in Safari on
  iOS but not (yet) for installed web apps") · [firt.dev — iOS PWA compatibility](https://firt.dev/notes/pwa-ios/)
- [Taming the Web Speech API — Andrea Giammarchi](https://webreflection.medium.com/taming-the-web-speech-api-ef64f5a245e1)
  (continuous mode on iOS) · [Stabilising WebSpeech on iOS](https://lilting.ch/en/articles/ios-webspeech-api-tips) ·
  [WebKit/Documentation issue #120 — interimResults on iOS](https://github.com/WebKit/Documentation/issues/120)
- [JavaScript Text to Speech and Its Many Quirks](https://codersblock.com/blog/javascript-text-to-speech-and-its-many-quirks/)
  (per-engine TTS quirk catalogue) · [Chromium bug 41294170 — synthesis stops after ~15 s](https://issues.chromium.org/issues/41294170)
- [WebKit: MediaRecorder API](https://webkit.org/blog/11353/mediarecorder-api/) ·
  [MediaRecorder browser support & codecs](https://www.testmuai.com/learning-hub/mediarecorder-browser-support/) ·
  [WebKit: Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/) ·
  [WebKit Features in Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)
- [web.dev: WebGPU now in all major browsers](https://web.dev/blog/webgpu-supported-major-browsers) ·
  [Browser speech recognition in 2026: Whisper & the STT landscape](https://offlinetts.com/blog/browser-speech-recognition-whisper-comparison/) ·
  [Transcribing audio in-browser: WebGPU, WASM, Transformers.js](https://whisperstt.com/blog/transcribe-audio-in-browser/)
- [Chromium issue 444393111 — available({processLocally}) broken on macOS](https://issues.chromium.org/issues/444393111) ·
  [Apple Developer Forums — iOS audio lock-screen problem in PWA](https://developer.apple.com/forums/thread/762582)
