# MemoCoach-alike — Memorization Modes Spec

Status: implementation-ready design. Scope: the masking engine, the 16 modes, the difficulty ladder,
the reveal interactions. No code to be written from this doc other than what is described here.

Design stance (opinionated, decided — do not re-litigate during implementation):

1. **Masking is a pure function.** `computeMaskPlan(doc, modeSpec, practiceState) -> MaskPlan`. No DOM, no
   randomness beyond a seeded PRNG, no I/O. Everything else (rendering, gestures, ladder) reads the plan.
2. **Zero reflow, always.** The original word always occupies its own box. Masks are absolutely positioned
   overlays inside that box. There is no mode in which text moves when difficulty changes. This is the
   single most important UX invariant and it is cheap to guarantee structurally (see §3).
3. **Levels are nested, not reshuffled.** Going 20% -> 35% must *add* hidden words, never swap them. This
   is achieved with one seeded permutation per (text, mode, scope, reshuffleCounter); the level selects a
   prefix length of that permutation. Reshuffle is an explicit, separate action.
4. **No NLP library.** One hand-curated function-word list per language (§4) plus three cheap heuristics
   (mid-sentence capitalisation, digit presence, hapax counting). Total data cost < 3 KB gzipped for English.
5. **Modes compose as base × lens × scope**, not as 16 special cases (§6). "Actor role" is a lens, not a mode,
   which is why it works with all 15 other modes — a genuine advantage over MemoCoach's flat method list.

---

## 1. Text model

Parsing happens once at import and is persisted; practice never re-parses.

```ts
type BlockKind = 'paragraph' | 'line' | 'speaker' | 'dialogue' | 'direction' | 'heading' | 'blank';

interface Token {
  i: number;            // global index, stable forever
  text: string;         // surface form: "don't", "Ophelia", "1603"
  lower: string;        // NFKC + lowercase + curly->straight quotes
  isWord: boolean;      // contains at least one \p{L} or \p{N}
  blockIdx: number;
  lineIdx: number;      // logical line (source newline), NOT visual row
  sentIdx: number;
  posInLine: number;    // 0-based word index within line (words only)
  posInSent: number;
  lineLen: number;      // word count of its line (denormalised for speed)
  sentLen: number;
  trailing: string;     // punctuation glued after the word: ",", ".”", "?!"
  leading: string;      // "“", "(", "—"
  isFunction: boolean;  // from §4 list
  isProperish: boolean; // capitalised, not sentence-initial, not all-caps speaker label
  hasDigit: boolean;
  count: number;        // occurrences of `lower` in the doc (for hapax scoring)
  maskable: boolean;    // isWord && block.kind not in {speaker, direction, heading}
}

interface Block {
  idx: number; kind: BlockKind; speaker: string | null;
  lineIdx: number; tokenRange: [number, number]; chunkIdx: number;
}

interface Chunk { idx: number; blockRange: [number, number]; wordCount: number; label: string; }

interface Doc {
  id: string; lang: 'en' | 'es' | 'fr' | 'de';
  tokens: Token[]; blocks: Block[]; chunks: Chunk[];
  lines: { idx: number; tokenRange: [number, number]; wordCount: number }[];
  sentences: { idx: number; tokenRange: [number, number]; wordCount: number }[];
  roles: string[];      // detected speaker names, in order of first appearance
}
```

### 1.1 Tokenizer (exact)

Word regex (Unicode, `u` flag), allowing internal apostrophes and hyphens:

```
/[\p{L}\p{N}]+(?:[’'’\-‐·][\p{L}\p{N}]+)*/gu
```

Algorithm: split source into logical lines on `\n`. Within a line, walk with the regex; everything between
matches is punctuation/whitespace and is attached as `trailing` of the previous token and/or `leading` of the
next (rule: attach to `trailing` unless the run contains an opening character `“ ‘ ( [ { ¿ ¡ —` at its end, in
which case that tail goes to the next token's `leading`). **Punctuation is never masked** — it always renders
in its own span outside the masked area. Keeping commas, periods and question marks visible is what makes
heavily-masked text still readable as structure; MemoCoach does this too and it matters.

Sentence split: `[.!?…]+` followed by whitespace + (uppercase | quote | digit | EOL), with an abbreviation
guard list (`Mr Mrs Ms Dr Prof St Sgt vs etc e.g i.e Jr Sr No Fig Ch p pp Rev Hon Capt Lt`). A logical line
break always closes a sentence in `line`/`dialogue`/verse blocks (lyrics and verse are line-organised, not
sentence-organised, and pretending otherwise breaks every line-based mode).

### 1.2 Script / role parsing

Applied at import; user can correct it in a 2-tap review screen.

- **Standalone speaker label** (screenplay): a line matching `^\s{0,20}([\p{Lu}][\p{Lu}\p{N} .'’\-]{0,29})\s*(\(.*\))?\s*:?\s*$`
  and the following line is non-blank → `kind: 'speaker'`, `speaker = normalized(name)`. Following lines until
  the next blank line / speaker / direction are `kind: 'dialogue'` with the same speaker.
- **Inline speaker label** (playscript / novel): `^\s*([\p{Lu}][\p{L} .'’\-]{0,29})\s*[:.]\s+(?=\S)` → the label is
  a `speaker` run of tokens at the head of a `dialogue` block. Requires the same label to appear ≥ 2 times in
  the doc, or ≥ 2 distinct labels to exist; this kills false positives like `Note: remember to breathe`.
- **Stage direction**: a whole line wrapped in `(...)` or `[...]`, or an all-italic line in imported HTML/RTF
  → `kind: 'direction'`. Never masked by default.
- If zero roles are detected the doc is `prose` and the My Lines lens is hidden in the UI.

### 1.3 Chunking

Default auto-chunk: accumulate blocks until `wordCount >= 45`, then close the chunk at the next block
boundary; hard-close at 90 words or 12 logical lines. Blank-line-separated groups and speaker changes are
preferred boundaries (cost function: prefer break after blank line > after end of speech > after sentence end
> mid-block never). Verse/lyrics: chunk = stanza (blank-line group), regardless of word count. User can
merge/split chunks; chunk identity is stored as a block range so edits to text re-derive gracefully.

Chunks are the unit of mastery and of the Chunk Focus / Snowball modes.

---

## 2. Determinism, seeding, and the nested-prefix rule

```ts
// cyrb128 -> sfc32; ~15 lines total, no dependency.
function seedFrom(parts: string[]): [number,number,number,number]  // cyrb128 of parts.join('')
function prng(seed): () => number                                   // sfc32, uniform [0,1)
```

Seed string: `` `${doc.id}|${modeId}|${scopeKey}|${reshuffleCounter}` ``
**The level/rung is deliberately NOT part of the seed.**

```ts
// 1. candidates: token indices eligible for this mode, in ascending index order
// 2. stable ranks: r[k] = rand() for k-th candidate  (one pass, order-independent of level)
// 3. pickOrder: candidates sorted by r ascending, then by index ascending as tie-break
// 4. optional spacing pass (below) reorders pickOrder without breaking prefix-consistency
// 5. masked set at rung with fraction p = pickOrder.slice(0, Math.round(p * candidates.length))
```

**Spacing pass** (used by Fade Words, Key Words, Blur-partial): at low densities, adjacent hidden words are
disproportionately hard and look like damage. Greedy re-order: iterate `pickOrder`; accept a candidate if no
already-accepted candidate lies within `minGap` word positions **on the same line** (`minGap = 2` default);
rejected candidates go to a deferred queue. When the main pass ends, replay the deferred queue with
`minGap - 1`, then again with `0`, until all candidates are placed. Result is a single total order, so the
prefix property (and therefore level nesting) still holds exactly.

Guarantees to test:
- same (doc, mode, scope, reshuffle, rung) ⇒ byte-identical MaskPlan;
- `maskedSet(rung n) ⊂ maskedSet(rung n+1)` for all percentage-driven modes;
- `reshuffleCounter++` ⇒ different set with the same cardinality (assert Jaccard < 0.9 in tests).

**Structural modes** (Skeleton, Line Endings, Sentence Tail, Openers, Line Curtain(alternating), Spotlight,
Snowball, Chunk Focus, Word Shapes, Facts & Figures) use no PRNG at all. For those, the Reshuffle button is
repurposed as **Phase shift**: it advances a `phase` integer that flips alternation parity (Line Curtain),
shifts which sentence/line offsets get the extra masked token when `p*len` is fractional, and rotates the
starting line of Chunk Focus. Reshuffle is never a no-op; it is never destructive either.

---

## 3. Rendering contract (the no-reflow guarantee)

Every word token renders as:

```html
<span class="tok" data-i="128" data-mask="rule">
  <span class="lead">“</span><!-- never masked -->
  <span class="txt">Ophelia</span><!-- always present, always its natural size -->
  <span class="ovl" aria-hidden="true"></span><!-- absolutely positioned overlay -->
  <span class="trail">,</span><!-- never masked -->
</span>
```

```css
.tok { position: relative; }
.tok .ovl { display: none; position: absolute; left: 0; right: 0; top: 0; bottom: 0; pointer-events: none; }
.tok[data-mask]:not([data-mask="none"]) .txt { visibility: hidden; }
.tok[data-mask]:not([data-mask="none"]) .ovl { display: block; }
.tok[data-mask="blur"]  .txt { visibility: visible; filter: blur(var(--blur, 3px)); }
.tok[data-mask="blur"]  .ovl { display: none; }
.tok[data-mask="dim"]   .txt { visibility: visible; opacity: var(--dim, .28); }
.tok[data-mask="dim"]   .ovl { display: none; }
.tok.peek .txt, .tok.revealed .txt { visibility: visible; filter: none; opacity: 1; }
.tok.peek .ovl, .tok.revealed .ovl { display: none; }
```

`visibility: hidden` (not `display:none`, not `opacity:0`) is the load-bearing choice: the box keeps its exact
advance width and the glyphs leave the accessibility tree, which is semantically correct for a hidden word.
Filters and opacity do not affect layout either, so blur/dim are equally safe.

### 3.1 Mask styles (the complete enum)

| code | name | rendering | used by |
|---|---|---|---|
| `none` | visible | — | everything unmasked |
| `rule` | **default blank** | 2px `currentColor` bar at 24% alpha, `bottom: .12em`, spanning the token box | Fade Words, Line Endings, Key Words, Sentence Tail, Line Curtain, Openers |
| `dots` | letter-count dots | `•` × letterCount, monospace, fitted (§3.2) | Word Shapes (alt), Type It Back placeholder |
| `shape` | word shape | per char: lower→`x`, upper→`X`, digit→`#`, keep `'` `-`; monospace, fitted | Word Shapes |
| `initial` | first letter kept | first grapheme in normal font at left + `rule` for the remaining width | First Letter, Skeleton |
| `blur` | blur | `filter: blur(Npx)` on `.txt` | Blur |
| `dim` | greyed | `opacity` on `.txt` | warm-up rungs, Chunk Focus lookback, cue tails |
| `blank` | invisible box | nothing drawn at all | Spotlight/Chunk Focus "after window", Fade Words final rung option |
| `input` | typing field | `<input>` sized to the token box (§9) | Type It Back |

Notes.
- The **default blank is a drawn rule, not literal underscore characters.** A rule is exactly as wide as the
  word (it inherits the box), so it conveys word length for free with no measurement and no clipping. Literal
  `_____` is offered as a skin (`blankStyle: 'underscores'`) for users who prefer it, rendered as repeated `_`
  in monospace with the fit transform of §3.2.
- `initial` never needs glyph alignment because the overlay covers the whole box: draw the letter at the left
  edge and the rule from `letterWidth + 0.08em` to the right edge.
- Trailing/leading punctuation stays visible in *every* style, including whole-line hiding.

### 3.2 The fit pass (only for `dots`, `shape`, `underscores`)

Monospace placeholder strings can be wider than the proportional word they cover. On first paint of any token
using these styles, in one batched `requestAnimationFrame`: measure `natural = ovl.scrollWidth`,
`box = tok.clientWidth`; if `natural > box`, set `--fit: box/natural` and apply
`transform: scaleX(var(--fit)); transform-origin: left center`. Cache per `(lower, styleCode, fontSizePx)` in a
`Map`, so a 2000-word text does at most a few hundred measurements once. Never measure during scroll.

### 3.3 Line-level masking

Whole-line hiding sets every token in the line to `rule` (or `blank`). It does **not** collapse the line — a
hidden line keeps its full height and wraps identically. Optional polish `lineBarOverlay` (default off): after
paint, draw one absolutely positioned bar per visual row using `Range.getClientRects()` of the line's token
range, giving the "curtain" look; recompute on resize with a debounced `ResizeObserver`. Off by default
because it costs layout reads and the per-token rules already read well.

### 3.4 Performance

- MaskPlan is a `Uint8Array` of style codes, length = `tokens.length`, plus a `Uint8Array` for block/line
  flags. Applying it = writing `data-mask` on changed tokens only (diff against previous plan).
- Texts > 2500 tokens: virtualise by block with an `IntersectionObserver`, rendering window ±1.5 viewports.
  Tokens outside the window still exist in the plan; only DOM is windowed. Auto-scroll pre-warms ahead.
- Recomputing a plan for a 5000-token doc must stay < 8 ms; all mode selectors are O(n) or O(n log n).

### 3.5 Accessibility

- Masked token: `role="text"`, `aria-label` = `"hidden word"` (or `"hidden word, N letters"` when the style
  reveals letter count). Overlay always `aria-hidden`.
- Peeking/revealing announces the word in a polite live region.
- Every gesture has a keyboard equivalent (§10). Long-press timing is user-adjustable (§10.1) for motor
  accessibility; a "tap to peek instead of hold" setting exists.
- `prefers-reduced-motion`: peek/reveal transitions become instant (no 120 ms fade).
- Contrast: rules and dots are drawn with `currentColor` alpha so they work in both themes.

---

## 4. The function-word list (instead of NLP)

One file per language, plain array of lowercase strings. English list, ~210 entries, conceptually:

- **Articles / determiners**: a, an, the, this, that, these, those, each, every, either, neither, both, all,
  any, some, no, none, such, another, other, others, much, many, more, most, few, fewer, less, least, several,
  enough, own, same.
- **Pronouns**: i, me, my, mine, myself, you, your, yours, yourself, yourselves, he, him, his, himself, she,
  her, hers, herself, it, its, itself, we, us, our, ours, ourselves, they, them, their, theirs, themselves,
  who, whom, whose, which, what, whatever, whoever, whichever, one, ones, oneself, thou, thee, thy, thine
  (Shakespeare and hymns are a real use case).
- **Be / have / do, all inflections**: am, is, are, was, were, be, been, being, ’s, ’re, ’m, has, have, had,
  having, ’ve, ’d, do, does, did, doing, don’t, doesn’t, didn’t, isn’t, aren’t, wasn’t, weren’t, hasn’t,
  haven’t, hadn’t.
- **Modals + negations**: can, cannot, can’t, could, couldn’t, shall, shan’t, should, shouldn’t, will, won’t,
  would, wouldn’t, may, might, must, mustn’t, ought, need, dare, let, ’ll.
- **Prepositions**: of, in, on, at, to, from, by, for, with, without, about, above, across, after, against,
  along, among, around, as, before, behind, below, beneath, beside, besides, between, beyond, but, despite,
  down, during, except, inside, into, like, near, off, onto, out, outside, over, past, per, round, since,
  than, through, throughout, till, toward, towards, under, until, unto, up, upon, via, within.
- **Conjunctions / complementisers**: and, or, nor, so, yet, because, although, though, if, unless, whether,
  while, whilst, whereas, that, when, whenever, where, wherever, how, however, why, once, until, lest.
- **Degree / common adverbs & particles**: not, n’t, very, too, so, quite, rather, just, only, even, also,
  still, again, ever, never, always, here, there, then, now, well, back, away, please, yes, no, oh, ah, ok.
- **Numerals as words** are NOT in the list (they are high-value content in speeches).

Derived flags:
- `isFunction = list.has(lower)` — plus: a token is treated as function if `lower.length <= 2` and not in a
  small `keepShort` allowlist (`ok, no, id, ai, us, uk, tv, dr, mr, ms, st, go, be, do` are handled by the
  list anyway; the rule mainly protects initials and stray letters).
- `isProperish = /^\p{Lu}/.test(text) && posInSent > 0 && !isAllCaps(text)`. Cheap, wrong for German nouns —
  so for `lang: 'de'` this heuristic is disabled and Facts & Figures falls back to digits + list-negation only.
- `isContent = isWord && !isFunction`.

**Interjection protection** (`protectInterjections`, default **on** for scripts, off for prose): oh, ah, well,
hey, hm, hmm, huh, ugh, wow, yeah, yes, no, please, god, look, listen, now, why — never masked below rung 5,
because actors lose the *rhythm* of a line, not its content, when these vanish, and MemoCoach's random hiding
is annoying for exactly this reason.

**Optional frequency list** (`top1000.en.txt`, ~6 KB gz, off by default): enables `orderBy: 'hard-first' |
'easy-first'` weighting in Key Words. Ship it, keep it lazy-loaded, never make a mode require it.

---

## 5. Mode interface

```ts
interface ModeSpec {
  id: ModeId;                 // 'fade' | 'firstLetter' | ... (16 values)
  rung: number;               // 0..7, the ladder position
  params: Record<string, number|string|boolean>;   // mode params, defaults per §7
  lens: LensSpec;             // { role?: string; cueStyle: 'full'|'tail'|'hidden'; ... }
  scope: { kind: 'text'|'chunk'|'selection'; chunkIdx?: number; range?: [number,number] };
  blankStyle: 'rule'|'underscores'|'dots';   // user skin for the default blank
  reshuffle: number;          // counter
  phase: number;              // structural-mode phase shift
}

interface MaskPlan {
  styles: Uint8Array;         // per token, MaskStyle code
  lineFlags: Uint8Array;      // bit0 hiddenLine, bit1 dimLine, bit2 cueLine, bit3 focusLine
  focus: { firstLine: number; lastLine: number } | null;  // for Spotlight/Chunk Focus/Snowball
  step: { index: number; total: number } | null;          // for stepped modes
  maskedCount: number; candidateCount: number;
  inputs: number[];           // token indices rendered as typing fields
}
```

Each mode is `(doc, spec) => { candidates: number[]; assign(order): void }`, but in practice a mode exports:

```ts
interface Mode {
  id: ModeId; name: string; blurb: string;
  usesPRNG: boolean; stepped: boolean;          // stepped modes advance with a tap/Space
  ladder: (rung: number) => Record<string, any>; // rung -> params (table in §7)
  build(doc: Doc, spec: ModeSpec): MaskPlan;
}
```

---

## 6. Composition: base × lens × scope

- **Base mode** (one of the 16) decides *which tokens get masked and how*.
- **Lens** post-processes the plan. Lenses:
  - `MyLines(role)` — see M13; restricts maskable tokens to `role`'s dialogue, styles cue lines.
  - `Protect` — un-masks protected classes at low rungs: first word of each line (rungs ≤ 2), interjections
    (rungs ≤ 4 when enabled), speaker labels and stage directions (always), numbers (unless the mode is Facts
    & Figures or rung ≥ 6).
  - `Reveals` — applies the user's session state: peeked tokens (transient) and permanently revealed tokens.
  - `Window` — applied by Spotlight/Chunk Focus/Snowball; forces `blank`/`dim` outside the active window and
    lets the base mode operate inside it.
- **Scope** limits candidates to a chunk or a selection; tokens outside scope render `none` (visible) unless a
  Window lens says otherwise.

Order of application: `base -> Window -> MyLines -> Protect -> Reveals`. Later stages may only *reduce*
masking, except `Window`, which may add `blank`/`dim`. This ordering is a hard rule; it makes every
combination well-defined and testable.

This composition is why we advertise "16 methods × role isolation × 3 scopes" rather than 10 flat methods.

---

## 7. The 16 modes

Naming convention in UI: short verb-y names, one line of explanation, no jargon. Each mode's ladder row gives
the parameter value at rungs L0..L7 (see §8 for what the rungs mean).

---

### M01 — Fade Words
**"Hide a growing share of the words, spread evenly through the text."**

- Candidates: `maskable && isWord` within scope, minus `Protect` exclusions.
- Order: seeded permutation (§2) + spacing pass with `minGap = 2`.
- Masked count: `k = Math.round(p * candidates.length)`, `p` from the ladder.
- Style: `blankStyle` (default `rule`).
- Params: `p` 0–1; `minGap` 0–3 (default 2, auto-relaxes when `p > 0.5`); `weighting: 'uniform' | 'content-first'`
  (default `uniform` — Key Words is the content-first mode, keep this one honest); `finalStyle: 'rule' | 'blank'`
  (default `rule`).
- Ladder `p`: **0 / .10 / .20 / .35 / .50 / .70 / .85 / 1.00**
- Determinism: full. Reshuffle → new permutation, same `k`.
- Why it exists: the baseline MemoCoach behaviour and the safest default for any text type.

---

### M02 — First Letter
**"Every hidden word keeps its first letter as a nudge."**

- Identical selection to M01 (same candidate set, same permutation family, seeded with `modeId='firstLetter'`
  so it is independent of Fade Words).
- Style: `initial` — first grapheme (grapheme cluster, via `Intl.Segmenter` when available, else code point)
  rendered normally, remainder of the box drawn as a rule.
- Params: `p` as M01; `keepLetters` 1–3 (default 1); `keepFinalLetter` bool (default false — a nice
  intermediate for hard words: shows `O……a`).
- Ladder `p`: **0 / .20 / .35 / .55 / .75 / .90 / 1.00 / 1.00**, with `keepLetters` dropping `2 → 1` at L6 and
  L7 additionally switching `p=1.00, keepLetters=1` → this mode's ceiling is deliberately below M01's, because
  its ceiling *is* M03.
- Determinism: full.
- Why: the single most effective crutch level; users who fail at 35% in Fade Words succeed at 55% here.

---

### M03 — Skeleton
**"The whole text collapses to first letters and punctuation. The classic."**

- Every `maskable` word in scope → `initial` with `keepLetters` letters. No selection, no PRNG.
- Punctuation, capitalisation and line breaks preserved (that is the mnemonic: `T b, o n t b, t i t q.`).
- Params: `keepLetters` 1–3 (default 1); `includeFunctionWords` bool (default **true**; when false, function
  words stay fully visible, which is a much gentler skeleton and a great L3–L4 rung);
  `showLetterCount` bool (default false; when true the rule after the initial is replaced by `dots` of the
  remaining letter count).
- Ladder: L0 `{keepLetters:3, includeFunction:false}` / L1 `{3,false}` / L2 `{2,false}` / L3 `{2,true}` /
  L4 `{1,false}` / L5 `{1,true, showLetterCount:true}` / L6 `{1,true}` / L7 `{1,true, punctuationOnly:false}`.
  (An extra `punctuationOnly` flag at a hidden L8 hides even the initials — that is just M01 at 100%, so we
  cap here.)
- Determinism: total (structural). Phase shift is a no-op → the Reshuffle button is replaced by a
  `keepLetters` stepper in this mode's control bar.

---

### M04 — Line Endings
**"Hide the end of every line — the part people always fumble."**

- For each line in scope with `wordCount >= 2`: mask the last `n` word tokens.
  `n = min(ladder.n, wordCount - ladder.keepMin)` with `keepMin = 1` until the ladder says `n = 'all'`.
  If `ladder.n === 'all'`, mask all words in the line.
- Fractional variant: `ladder.n` may be the string `'half'` → `n = Math.ceil(wordCount / 2)`.
- Style: `blankStyle`.
- Params: `n` 1–6 | `'half'` | `'all'`; `keepMin` 0–3 (default 1); `unit: 'line' | 'sentence'` (default `line`);
  `rhymeOnly` bool (default false) — when true and the doc is verse, only mask the final word of lines that
  rhyme with another line (rhyme detected by matching the last 3 characters of `lower`, ignoring trailing
  punctuation and final `s`; crude, cheap, and works startlingly well for song lyrics).
- Ladder `n`: **0 / 1 / 1 / 2 / 3 / 'half' / 'half' / 'all'** (L2 differs from L1 by `phase`-driven inclusion of
  short lines, i.e. `keepMin` drops 2 → 1).
- Determinism: total (structural).
- Why: line ends carry rhyme, punchlines and hand-offs; this is the highest-yield structural mode for lyrics
  and stand-up.

---

### M05 — Key Words
**"Only the words that carry meaning disappear. Grammar stays as scaffolding."**

- Candidates: `isContent` tokens (`isWord && !isFunction`) in scope.
- Order: by descending `value`, ties broken by the seeded rank (so it is still shuffleable and reproducible):

```
value = 3.0 * isProperish
      + 2.5 * hasDigit
      + 1.0 * (count === 1 ? 1 : 0)                 // hapax = high information
      + Math.min(text.length, 12) / 6               // 0.17 .. 2.0
      + 1.0 * (freqListLoaded && !top1000.has(lower) ? 1 : 0)
      - 0.6 * (count >= 4 ? 1 : 0)                  // refrains/repeats are easy, defer them
```

- `k = Math.round(p * candidates.length)` from the head of that order.
- Style: `blankStyle`; `isProperish` and `hasDigit` tokens optionally get `dots` instead so the user sees
  length (`showLengthForNames`, default true — names are the thing people blank on).
- Params: `p` 0–1; `orderBy: 'value' | 'hard-first' | 'easy-first' | 'random'` (default `value`);
  `minGap` 0–2 (default 1); `showLengthForNames` bool.
- Ladder `p`: **0 / .15 / .30 / .45 / .65 / .80 / .90 / 1.00**
- Determinism: full; the order is deterministic even before the PRNG (PRNG only breaks ties).
- Why: this is the "no heavy NLP" win — a 210-word list plus one scoring formula gets you 90% of a POS tagger's
  usefulness for this task.

---

### M06 — Sentence Tail
**"Each sentence fades from its end backwards, until only the opening survives."**

- For each sentence (or line, per `unit`) in scope of length `L`: mask the last `m = Math.max(1, Math.ceil(p * L))`
  word tokens when `p > 0`; at `p = 1` mask all.
- Fractional-rounding phase: when `p * L` has a fractional part in `[0.25, 0.75)`, whether we round up is
  decided by `(sentIdx + phase) % 2`, so consecutive sentences don't all step together and Reshuffle gives a
  genuinely different-feeling drill at the same nominal difficulty.
- Style: `blankStyle`; the **first masked token of each sentence** gets `initial` at rungs ≤ 4 (a launch hint).
- Params: `p` 0–1; `unit: 'sentence' | 'line'` (default `sentence` for prose, `line` for verse/lyrics —
  set from `doc` structure at first run); `direction: 'tail' | 'head'` (default `tail`; `head` masks sentence
  openings, which is a surprisingly hard and useful variant for speeches).
- Ladder `p`: **0 / .15 / .25 / .40 / .55 / .75 / .90 / 1.00**
- Determinism: total apart from the rounding phase.
- Why: matches the natural failure mode — people know how a sentence starts and lose the landing.

---

### M07 — Line Curtain
**"Whole lines vanish. Alternating, random, or all of them."**

- Line-level selection over lines in scope where `wordCount >= 1` and `kind ∈ {line, paragraph, dialogue}`:
  - `pattern: 'alternate'` → hide lines where `(lineOrdinal + phase) % period === 0`, `period` 2–4.
  - `pattern: 'random'` → seeded permutation of lines, prefix of length `Math.round(p * lines.length)`.
  - `pattern: 'all'` → every line.
  - `pattern: 'stanzaAlternate'` → alternate at chunk/stanza granularity instead of line.
- All word tokens in a hidden line → `blankStyle`; punctuation stays; line box preserved (§3.3).
- Params: `pattern`; `period` 2–4 (default 2); `p` 0–1 for random; `keepFirstWord` bool (default false — when
  true the line's first word stays visible, turning this into a very effective "prompt line" drill);
  `lineBarOverlay` bool.
- Ladder: L0 none / L1 `alternate period 4` / L2 `alternate period 3` / L3 `alternate period 2, keepFirstWord`
  / L4 `alternate period 2` / L5 `random p .65` / L6 `random p .85` / L7 `all`.
- Determinism: full (`random`) / total (`alternate`); Reshuffle flips `phase` (so the *other* half of the
  couplets is hidden — pedagogically the right pairing).

---

### M08 — Spotlight
**"One line at a time. Everything ahead is dark; you advance when you've said it."**

- Stepped mode. State: `step` = active line ordinal within scope.
- Lines with ordinal `< step - lookback` → `dim` (or `none` if `pastStyle:'visible'`).
- Lines in `[step - lookback, step - 1]` → `dim` at `opacity .45`.
- Active line (`step`) → masked by `innerMode` at the current rung (default `innerMode: 'fade'`, so Spotlight
  composes with the percentage ladder). At rungs 0–1 `innerMode` is effectively "visible" — the mode is still
  useful because everything *after* is hidden.
- Lines `step + 1 .. step + preview` → per `previewStyle`: `'none'` (blank), `'firstWord'` (first word visible,
  rest `rule`), `'skeleton'` (`initial`, keepLetters 1). Default `'skeleton'` with `preview = 1`.
- Lines beyond → `blank`.
- Advance: tap anywhere in the "next" zone / `Space` / `↓`. Auto-advance option paced by `wordsPerMinute`
  (default 130) with a 400 ms grace after the line's last word.
- Params: `lookback` 0–3 (default 1); `preview` 0–2 (default 1); `previewStyle`; `innerMode` (any percentage
  mode); `advance: 'tap' | 'auto'`; `wpm` 80–220.
- Ladder: rung drives `innerMode`'s `p` **0/.10/.25/.45/.65/.85/1.0/1.0** and simultaneously
  `preview: 1,1,1,1,0,0,0,0` and `previewStyle: skeleton → firstWord → none`.
- Determinism: inherits `innerMode`'s.
- Why: the strongest mode for long monologues; also the natural "run lines in bed" mode.

---

### M09 — Snowball
**"Recite line 1. Then lines 1–2. Then 1–2–3. The text disappears behind you."**

- Stepped, cumulative. `step` = number of lines currently *hidden* (counted from the start when
  `direction: 'forward'`, from the end when `'backward'`).
- Forward: lines `[0, step)` → all tokens masked by `innerMode` at rung (default `blankStyle`, `p=1`);
  lines `[step, end]` → visible. You recite the hidden prefix, then read on.
- Backward ("build from the end" — the standard stage technique for last-minute learning): lines
  `(end - step, end]` hidden, earlier lines visible; you read up to the hidden tail and finish from memory.
- Advance: when the user completes the hidden span (tap "Got it" / `Space`), `step++`. On a miss ("Again"),
  `step` holds; two consecutive misses → `step--` (never below 1).
- Unit: `unit: 'line' | 'sentence' | 'chunk'` (default `line`; `chunk` for long prose).
- Params: `direction`; `unit`; `growBy` 1–3 (default 1); `innerMode` (default full mask; `firstLetter` makes a
  gentler snowball); `restartFromTop` bool (default true — the whole point is re-reciting from the start).
- Ladder: rung does **not** drive `p` here; `step` *is* the difficulty. The rung instead selects `innerMode`
  crutch level: L0–L1 `firstLetter p=1 keepLetters 2`, L2–L3 `firstLetter keepLetters 1`, L4+ `rule`.
  Mastery is `step === totalLines` with `rule`.
- Determinism: total.

---

### M10 — Chunk Focus
**"Work one chunk at a time, with the neighbours faded for context."**

- Window over chunks (or lines, per `unit`). Active window = `[w, w + windowSize)`.
- Inside window → `innerMode` at rung. Before window → `dim` (`opacity .3`) for `lookback` chunks, `blank`
  beyond. After window → `blank` for `lookahead` chunks shown as `dim` skeleton, `blank` beyond.
- Advance/retreat with swipe left/right, `→`/`←`, or the chunk chips in the header. Window position persists.
- Params: `unit: 'chunk' | 'line'`; `windowSize` 1–3 (default 1 chunk / 4 lines); `lookback` 0–2 (default 1);
  `lookahead` 0–2 (default 0); `innerMode` (default `fade`); `autoAdvanceOnMastery` bool (default true — when
  the chunk reaches mastery, slide the window forward and offer a "join the seam" run over the last chunk +
  this one, which is where memorisation actually breaks).
- Ladder: passes rung to `innerMode`; additionally `lookback` shrinks 1 → 0 at L5.
- Determinism: inherits.
- The **seam drill** (chunk boundaries at `windowSize = 2` scoped to the last 2 lines of chunk *i* and first 2
  of *i+1*) is a first-class generated practice, not a mode: it is offered automatically after two adjacent
  chunks are mastered.

---

### M11 — Blur
**"Words go soft-focus. You can almost read them — which is exactly the point."**

- Candidates: as M01. Selection: `all` (default) or seeded prefix at fraction `p`.
- Style: `blur`, `--blur: {radius}px` on the token (radius scales with font size: actual radius =
  `radius * fontSizePx / 17`, so it looks identical on phone and desktop).
- `progressive` option: radius ramps within each line from `radiusMin` at the first word to `radius` at the
  last (`r_i = radiusMin + (radius - radiusMin) * posInLine / max(1, lineLen - 1)`), which merges nicely with
  the Sentence Tail idea.
- Params: `radius` 1–10 px (default 3); `radiusMin` 0–6 (default 0.5, `progressive` only);
  `coverage: 'all' | 'content' | 'p'`; `p` 0–1; `progressive` bool (default false).
- Ladder `radius` (coverage `all`): **0 / 1.5 / 2.5 / 3.5 / 4.5 / 6 / 8 / 10** — at 10 px nothing is legible,
  which is intentionally equivalent to a blank but keeps the word's colour-shape as a faint cue.
- Determinism: full when `coverage: 'p'`; total otherwise.
- Peek un-blurs with a 120 ms transition (skipped under `prefers-reduced-motion`).
- Note: blur is GPU-cheap but *not* free at 2000 tokens. Apply `will-change: filter` only to tokens in the
  viewport window, and prefer one blurred wrapper per line when `coverage === 'all'` (identical visual result,
  1/20th the layers).

---

### M12 — Word Shapes
**"Words become their own silhouettes — same length, same punctuation, no letters."**

- Every `maskable` word in scope (or a seeded prefix at fraction `p`) → `shape`.
- Overlay string: per grapheme, `\p{Ll}` → `x`, `\p{Lu}` → `X`, `\p{N}` → `#`, `'` `’` `-` kept verbatim.
  `glyphSet: 'xX' | 'dots' | 'blocks'` (`dots` → `•`, `blocks` → `▪`, both losing case info).
- `ascenderHints` (default false, power-user): use `l` for letters with ascenders (b d f h k l t), `p` for
  descenders (g j p q y), `x` otherwise — preserves the visual profile of the word, a genuinely different and
  quite effective cue.
- Style: `shape`, monospace, `font-size: .86em`, fitted per §3.2. Punctuation outside the mask stays as-is.
- Params: `p` 0–1 (default 1); `glyphSet`; `ascenderHints`; `caseSensitive` bool (default true).
- Ladder: `p` **0 / .35 / .60 / 1.0 / 1.0 / 1.0 / 1.0 / 1.0** with `glyphSet` moving `xX(ascenderHints) → xX →
  dots` at L4 and L6 (progressively less shape information).
- Determinism: full/total.
- Why: keeps the *metre* of a line — indispensable for verse, lyrics and Shakespeare, where the rhythm is the
  retrieval cue.

---

### M13 — My Lines  *(lens + standalone mode)*
**"Only your character's lines hide. Cue lines stay in front of you."**

- Requires `doc.roles.length > 0`. User picks one or more roles (`roles: string[]`; multi-select supports
  doubling).
- Effect as a **lens** (composable with M01–M12, M14–M16): candidate set is intersected with tokens whose
  block `speaker ∈ roles`; every other dialogue block is a **cue line**.
- Cue-line styling by `cueStyle`:
  - `'full'` (default, = MemoCoach) — cue lines fully visible.
  - `'tail'` — only the last `cueTail` words of a cue line visible (default 3), earlier words `dim`. This
    trains the actual cue-listening skill and is our differentiator; nothing in MemoCoach does it.
  - `'hidden'` — cue lines masked too, forcing you to hold the whole scene.
- **Cue highlight**: the final word of each cue line immediately preceding one of your lines gets
  `class="cue-word"` (subtle underline). Always on; it is the single most useful affordance for actors.
- Stage directions: `dim`, never masked (unless `maskDirections`, default false).
- Metrics: only your words count toward `peekRate` and mastery. A scene where you have 40 of 500 words must
  not report 92% mastery because the other characters are visible.
- **Standalone mode M13** = `MyLines` lens + `innerMode: 'fade'` + a role picker in the toolbar, so it appears
  in the mode list as a first-class "Actor mode" for discoverability.
- Params: `roles`; `cueStyle`; `cueTail` 1–6; `maskDirections`; `innerMode`; plus the inner mode's params.
- Ladder: rung → `innerMode` `p` **0/.15/.30/.50/.70/.85/1.0/1.0**, and `cueStyle` escalates
  `full (L0–L4) → tail (L5–L6) → tail/hidden (L7, user choice)`.
- Determinism: inherits.

---

### M14 — Type It Back
**"Type the missing words. Instant right/wrong, no self-kidding."**

- Selection: any percentage mode's candidate set (default `fade`'s; `keyWords` is the better default for
  students and is offered as a one-tap preset). Masked tokens become `input` style.
- Rendering: `<input class="tokin" size=...>` inside the token box, width pinned to the measured box width
  (`width: 100%` of `.tok`, which is the original word's width) — **no reflow, and the field width leaks the
  word length, which is a feature**. Placeholder = `dots` of letter count when `showLength` (default true).
  `autocapitalize=off autocorrect=off spellcheck=false autocomplete=off inputmode=text`.
- Matching (`normalize`): NFKD → strip combining marks → lowercase → curly to straight quotes → strip all
  non-`[\p{L}\p{N}']` → collapse repeated letters? **no** (that would accept "helo"). Then:
  - exact match → correct (green, field locks, moves on);
  - `strictness: 'loose'` → Damerau-Levenshtein ≤ 1 for `len ≥ 4`, ≤ 2 for `len ≥ 9` → "almost" (amber,
    accepted, counted as 0.5);
  - `strictness: 'normal'` (default) → distance ≤ 1 for `len ≥ 5` → amber, accepted as 0.5;
  - `strictness: 'strict'` → exact only.
  - Contractions: `dont ≡ don't`, `im ≡ i'm` fall out of the apostrophe stripping automatically.
- Interaction: `Space`, `Tab` or `Enter` commits and jumps to the next input; `Shift+Tab` goes back;
  `Esc` peeks the current word (counts as a peek and marks that item wrong); 3 wrong attempts auto-reveals
  with a shake animation and marks it wrong. Wrong items are re-queued at the end of the rep for one retry
  (`requeueMisses`, default true).
- Mobile: on focus, scroll the active input to 35% viewport height above the keyboard; a compact "next /
  peek / skip" bar sits directly above the keyboard.
- Scoring: `accuracy = (correct + 0.5*almost) / total`. This is the only mode with a hard accuracy number, so
  it is the **mastery gate** (§8.4).
- Params: `selector` (any percentage mode); `p`; `strictness`; `showLength`; `requeueMisses`;
  `punctuationRequired` bool (default false).
- Ladder `p`: **.10 / .15 / .25 / .40 / .55 / .70 / .85 / 1.00** (L0 is not zero — a typing rep with nothing to
  type is pointless).
- Determinism: full; a failed rep can be replayed with the identical item set (same seed) or reshuffled.

---

### M15 — Openers
**"Only the first words of each line survive. They're the hooks you actually need."**

- For each line in scope: keep the first `k` word tokens visible; mask everything after with `blankStyle`.
  (Exactly the inverse of M04, and the technique most reciters converge on naturally.)
- `k = 0` at the top rung → whole-line hiding, but arriving there via Openers feels different from M07 because
  the *ladder* is line-internal.
- `firstLetterOfRest` option (default true at rungs ≤ 3): masked tokens use `initial` instead of `rule`,
  producing the very readable "T q b f j… " look.
- Params: `k` 0–6 (default per ladder); `firstLetterOfRest` bool; `unit: 'line' | 'sentence'`;
  `perLineFloor` bool (default true — never mask a line down to fewer than `k` visible words even if short).
- Ladder `k`: **∞ / 5 / 4 / 3 / 2 / 2 / 1 / 0**, with `firstLetterOfRest` true at L1–L3, false after.
- Determinism: total.

---

### M16 — Facts & Figures
**"Hide only the names, numbers and dates — the bits you get wrong under pressure."**

- Candidates: tokens where `hasDigit || isProperish || inUnitList(lower)`, where `unitList` is ~60 entries:
  percent, percentage, million, billion, trillion, thousand, hundred, dozen, kilo(s), km, kg, mile(s),
  metre(s)/meter(s), litre(s), dollar(s), euro(s), pound(s), cent(s), year(s), month(s), week(s), day(s),
  hour(s), minute(s), second(s), monday…sunday, january…december, first…twelfth, half, quarter, double,
  triple, per, versus.
- Order: `hasDigit` first (value +2.5), then `isProperish`, then unit words; ties by seeded rank.
- `k = Math.round(p * candidates.length)`.
- Style: `dots` (letter/digit count preserved — for numbers, knowing "4 digits" is a real cue); names get
  `initial` at rungs ≤ 3.
- Params: `p` 0–1; `include: {digits, names, units}` (all true); `showLength` bool (default true).
- Ladder `p`: **0 / .30 / .50 / .70 / .85 / 1.0 / 1.0 / 1.0**, with L6 adding `include.units` weighting to 1.0
  and L7 switching names from `initial` to `dots`.
- Determinism: full. Disabled `isProperish` for German (§4) → falls back to digits + units.
- Why: the highest-value mode for speakers, students and pitch decks, and no competitor ships it.

---

### 7.1 Mode summary table

| # | Id | Name | Stepped | PRNG | Primary knob | Best for |
|---|---|---|---|---|---|---|
| M01 | `fade` | Fade Words | – | ✓ | `p` | anything (default) |
| M02 | `firstLetter` | First Letter | – | ✓ | `p`, `keepLetters` | early reps, hard vocabulary |
| M03 | `skeleton` | Skeleton | – | – | `keepLetters` | poems, vows, speeches |
| M04 | `lineEnds` | Line Endings | – | – | `n` | lyrics, jokes, verse |
| M05 | `keyWords` | Key Words | – | ✓ (ties) | `p` | lessons, presentations |
| M06 | `sentTail` | Sentence Tail | – | – | `p` | prose, speeches |
| M07 | `lineCurtain` | Line Curtain | – | ✓ | `pattern`,`p` | couplets, songs |
| M08 | `spotlight` | Spotlight | ✓ | inherits | `step` + inner `p` | monologues |
| M09 | `snowball` | Snowball | ✓ | – | `step` | long texts, cold learning |
| M10 | `chunkFocus` | Chunk Focus | ✓ | inherits | window + inner `p` | anything long |
| M11 | `blur` | Blur | – | ✓ (partial) | `radius` | first pass, gentle |
| M12 | `shapes` | Word Shapes | – | ✓ (partial) | `p`, `glyphSet` | verse, metre-driven text |
| M13 | `myLines` | My Lines | – | inherits | role + inner `p` | actors |
| M14 | `typeBack` | Type It Back | – | ✓ | `p`, `strictness` | mastery testing |
| M15 | `openers` | Openers | – | – | `k` | recall of line starts |
| M16 | `facts` | Facts & Figures | – | ✓ | `p` | speakers, students |

### 7.2 Recommended default per text type (set at import, user-overridable)

- **Script with roles** → M13 (My Lines, inner `fade`), then M08 Spotlight, then M04.
- **Lyrics / verse** (short lines, high line count, blank-line stanzas) → M04 Line Endings, then M12, then M07.
- **Speech / prose** → M06 Sentence Tail, then M05 Key Words, then M16.
- **Lesson / notes** → M05 Key Words, then M14 Type It Back, then M16.
- **Poem / vows / short text (< 120 words)** → M03 Skeleton, then M09 Snowball.

Auto-detection heuristic: `roles.length > 0` → script; else `medianLineWords < 12 && lineCount > 8 &&
blankLineGroups > 1` → verse/lyrics; else `wordCount < 120` → short; else prose.

---

## 8. The ladder

### 8.1 Rungs

Eight rungs, `L0..L7`, one shared scale. Per-mode meaning is the table in each mode above. The canonical
percentage curve is:

| rung | p | intent |
|---|---|---|
| L0 | 0% | **Read** — read it aloud once, nothing hidden. Always offered, never skipped for a new text. |
| L1 | 10% | first blanks; should feel almost free |
| L2 | 20% | still reading, starting to recall |
| L3 | 35% | the real work begins |
| L4 | 50% | half memory, half text |
| L5 | 70% | mostly memory |
| L6 | 85% | prompts only |
| L7 | 100% | **Recite** — nothing visible |

Spacing is deliberately non-linear: small early steps (people quit when step 1 hurts), a wide middle, and an
85% rung immediately before 100% because 100% is a cliff and users who jump 70 → 100 fail and blame the app.

### 8.2 Rep metrics

A **rep** = one pass over the current scope in the current mode/rung. Recorded:

```ts
interface Rep {
  id; textId; chunkIdx|null; modeId; rung; seed; reshuffle; startedAt; endedAt;
  maskedCount;                 // denominator
  peeks: number;               // long-press peeks (weight 0.5)
  reveals: number;             // permanent taps (weight 1.0)
  revealAllUsed: boolean;
  misses: number;              // Type It Back / stepped "Again" presses
  typedAccuracy: number|null;  // M14 only
  wpm: number|null;            // words in scope / minutes, when a full pass was made
  completed: boolean;          // reached the end of the scope
}
```

`assistRate = (0.5 * peeks + 1.0 * reveals) / max(1, maskedCount)`. This single number drives the ladder. It
must be normalised by `maskedCount`, not word count, or the ladder becomes level-dependent.

### 8.3 Escalation rules (default `adaptive: true`)

Evaluated when a rep is marked complete:

- **Step up** (`rung + 1`) if `assistRate <= 0.05` **and** `!revealAllUsed` **and** `completed`
  **and** (for M14) `typedAccuracy >= 0.9`.
- **Hold** if `0.05 < assistRate <= 0.18`.
- **Step down** (`rung - 1`, floor L1) if `assistRate > 0.35` **or** `revealAllUsed` **or** `!completed && elapsed > 20s`.
- **Deep step down** (`rung - 2`) if `assistRate > 0.6`.
- **Two consecutive holds at the same rung** → do not step up; instead **change the intervention**, in this
  priority order: (1) if scope is `text` and `chunks.length > 1`, narrow scope to the weakest chunk;
  (2) if the mode is a percentage mode, suggest its crutch sibling (`fade → firstLetter`, `keyWords → facts`,
  `shapes → firstLetter`); (3) suggest M08 Spotlight or M09 Snowball for the failing chunk. Never silently
  loop the same drill three times — that is the thing that makes memorisation apps feel useless.
- **Never** step up more than one rung per rep, even on a perfect run. Ladders that skip feel like they are
  guessing.
- Manual override always available (`[` / `]`, or the rung chips). A manual change sets
  `adaptiveSuspended = true` for that (text, mode) until the user taps "Auto" again — respect the human.

Cooldown: a step-up requires `elapsed >= 8s` and `maskedCount >= 3` (prevents laddering to L7 on a 4-word
scope by tapping through).

### 8.4 Mastery

Per **chunk**, state machine: `new → learning → recallable → mastered → maintenance`.

- `learning`: rung < 5.
- `recallable`: one completed rep at rung ≥ 5 with `assistRate <= 0.10`.
- **`mastered`** requires all three:
  1. two completed reps at **L7** with `assistRate <= 0.02`,
  2. those two reps in **different sessions** separated by `>= 6 hours` (a session boundary is 30 min idle),
  3. one **M14 Type It Back** rep at `p >= 0.55` with `typedAccuracy >= 0.95` **or**, if the user has typing
     disabled, a third L7 rep with `assistRate == 0`. Requiring an objective check somewhere in the chain is
     what stops "I basically knew that" self-deception.
- Per **text**: `mastered` when every chunk is mastered **and** one full-text L7 rep is completed with
  `assistRate <= 0.02`, `revealAllUsed == false`, and `wpm` within ±25% of the user's L0 read-aloud baseline
  (pace matters for performers; a correct-but-halting recitation is not a mastered text).

**Text rung** displayed in the UI = `min(chunk rungs)` (the weakest link is the truth), with the mean shown as
a secondary number.

**Maintenance (SRS-lite, deliberately minimal):** on mastery, schedule reviews at **1, 3, 7, 16, 35, 75 days**
(each interval `× 2.2`, `± 15%` jitter, capped at 120 days). A maintenance rep is a single L7 rep on the whole
text, or on 2 randomly chosen chunks if the text is > 400 words. Pass (`assistRate <= 0.05`) → next interval.
Fail → chunk(s) involved drop to rung 5, state `recallable`, interval resets to 1 day. No FSRS, no ease
factors, no per-card scheduling: the unit is the chunk, the review is a recitation, and that is enough.

**Leech handling:** a chunk that fails (step-down) 4+ times at rungs ≥ 3 is flagged. On flag: auto-split the
chunk at its best internal boundary (≤ 25 words per part), reset both parts to rung 3, and switch the
recommended mode to M08 Spotlight with `preview: skeleton`. Show the user one line of why.

### 8.5 Session composition

A "Practice" tap on a text builds a queue rather than dumping the user into one drill:
1. any chunk in `maintenance` that is due (L7, its mastered mode);
2. the weakest 1–2 chunks at their own rung (Chunk Focus scope);
3. one **seam drill** if two adjacent chunks are both ≥ `recallable`;
4. one full-text rep at `min(chunk rungs)` to close the session.
Target session length is a user setting (5 / 10 / 20 min, default 10); the queue is truncated to fit using
estimated `wordCount / wpm × (1 + rung × 0.15)`.

---

## 9. Type It Back rendering detail (no-reflow inputs)

```html
<span class="tok" data-mask="input" data-i="128">
  <span class="txt">Ophelia</span>          <!-- visibility:hidden, holds the width -->
  <input class="tokin" aria-label="type the hidden word, 7 letters">
</span>
.tok[data-mask="input"] .tokin {
  position: absolute; inset: 0; width: 100%;
  font: inherit; padding: 0; border: 0; background: none; text-align: left;
  border-bottom: 2px solid currentColor; outline: none;
}
```

Because the input is absolutely positioned over the hidden word, typing a longer answer than the target does
not widen anything (`overflow` is clipped and the caret scrolls inside the field). Short words get short
fields, which is honest information, not a bug. Minimum touch width: `min-width: 2.5em` applied to `.tok`
**only in this mode** (accepted, tiny, and stated in the UI: "boxes are at least this wide so you can tap
them") — this is the one sanctioned exception to the no-reflow rule, and it is applied when the plan is built
so the layout is stable *within* the rep.

---

## 10. Reveal interactions (exact)

State per rep: `peeked: Set<tokenIdx>` (transient, one at a time by default), `revealed: Set<tokenIdx>`
(sticky for the rep), `revealAll: boolean`.

### 10.1 Long-press peek (primary touch gesture)

Pointer Events only; `touch-action: manipulation` on the text container; no `click` handlers on tokens.

| phase | timing / threshold | behaviour |
|---|---|---|
| `pointerdown` | t=0 | record `{x, y, tokenIdx, t}`; start timer |
| pressing | t=120 ms | `.tok` gets `.pressing` (subtle 4% background tint) — teaches the gesture |
| reveal | **t=250 ms** (`peekHoldMs`, adjustable 120–600) | `.peek` added, word visible, 80 ms fade-in, `navigator.vibrate(8)` if available; log a peek |
| move | >10 px (`moveTolerance`) before reveal | cancel — the gesture becomes a scroll (scroll must always win) |
| move after reveal | any | keep revealed; if the pointer moves onto another token, `peekSlide` (default true) moves the peek to it and logs an additional peek |
| `pointerup` / `pointercancel` | — | re-hide after **120 ms** (`peekReleaseMs`) with a 120 ms fade |
| release before 250 ms | — | treated as a **tap** (§10.2) |

Max one token peeked at a time unless `multiPeek` (default false). Peek does not count toward the ladder if
the same token was already permanently revealed.

### 10.2 Tap to reveal permanently

- A `pointerup` under `peekHoldMs` with movement < 10 px = tap → toggle `revealed.has(i)`.
- Revealed tokens stay visible for the rest of the rep, drawn with a faint dotted underline so the user can
  see how much help they took (and so a screenshot tells the truth).
- Tap on a revealed token re-hides it and decrements the reveal count (honest correction, not gaming: only
  the highest count reached in the rep is used by the ladder).
- Double-tap a token (within 280 ms) = reveal the **whole line** for the rep (counted as
  `reveals += lineMaskedCount`), because "I've lost the line, not the word" is the common case.

### 10.3 Reveal All / Reset

One button, two gestures — mirroring MemoCoach, which got this right:

- **Tap "Reveal"** → `revealAll = true`, whole scope visible; button becomes "Hide"; a toast offers
  "Re-hide (H)". Sets `revealAllUsed = true` for the rep, which blocks step-up (§8.3) but does not abort.
- **Long-press "Reveal" ≥ 600 ms** (`resetHoldMs`) → **hard reset of the rep**: clear `peeked`, `revealed`,
  `revealAll`, reset the timer and the step counter, keep the same seed and rung. Haptic double-pulse, and the
  progress ring visibly refills during the hold so the gesture is discoverable.
- **Shift-long-press / "Reset all" in the sheet** → also resets the *rung* to L1 for this scope (confirm dialog).
- **Reshuffle** (`R`): new `reshuffleCounter`, same rung, new rep. On structural modes this is `phase++`.

### 10.4 Stepped modes

- Tap the lower third of the screen / `Space` / `↓` → next step. Tap upper third / `↑` → previous step.
- Swipe left/right → chunk window (M10) or step ±1 (M08/M09) per `swipeAction` (default: horizontal = chunk,
  vertical = step).
- M09 shows two explicit buttons: **"Got it"** (`step++`) and **"Again"** (hold; two in a row → `step--`).

### 10.5 Auto-scroll

- Toggle `S`; speed set in WPM (default 130, range 60–260, `+`/`-` in steps of 10).
- Implementation: `requestAnimationFrame` with sub-pixel accumulation (`scrollTop += px`), not
  `scroll-behavior: smooth`, so speed is exact. Pauses immediately on `pointerdown`, wheel, or key; resumes
  after **2.5 s** idle (`autoScrollResumeMs`, 0 = manual resume only).
- Keeps the current step/line at 38% viewport height in stepped modes (`scrollIntoView` with a computed offset,
  not `block: 'center'`, because performers read slightly above centre).
- Never auto-scrolls while a peek is active.

### 10.6 Keyboard map (desktop)

A **token cursor** exists on desktop (a thin caret-style outline). It is the desktop analogue of a fingertip.

| key | action |
|---|---|
| `→` / `L` | next masked token (cursor) — `Shift` for next token of any kind |
| `←` / `H` | previous masked token |
| `↓` / `J` | next line / next step (stepped modes) |
| `↑` / `K` | previous line / previous step |
| `Space` (tap) | stepped modes: advance. Non-stepped: peek the cursor token while held |
| `Space` (hold) | peek at cursor for as long as held (the desktop long-press), no 250 ms delay |
| `Alt` (hold) | peek whatever token is **under the mouse pointer** — hover-peek on demand |
| `Enter` | toggle permanent reveal of the cursor token |
| `Shift+Enter` | reveal the whole current line for the rep |
| `A` | toggle Reveal All |
| `H` | re-hide (after Reveal All) |
| `Shift+A` | hard reset of the rep (equivalent of the 600 ms long-press) |
| `[` / `]` | rung down / up (suspends adaptive) |
| `R` | reshuffle / phase shift |
| `M` | mode sheet; `1`–`9` + `0`,`-`,`=` quick-select the 12 most-used modes |
| `C` | scope: cycle text → chunk → selection |
| `T` | toggle Type It Back on the current selection |
| `S` | auto-scroll on/off; `+` / `-` speed |
| `F` | focus/zen mode (hide chrome) |
| `?` | shortcut cheat sheet |
| `Esc` | close sheet / exit focus / cancel peek |

Additional pointer affordance on desktop: **hover dwell peek** (`hoverPeekMs = 400`, default **on** for
`(pointer: fine)`, off for coarse) — hovering a masked word for 400 ms peeks it until the pointer leaves.
Users who find this too easy turn it off in one tap; the setting is remembered per device.

In Type It Back, the keyboard map is suppressed except `Tab`, `Shift+Tab`, `Enter`, `Esc` (peek current) and
`Cmd/Ctrl+Z`.

---

## 11. Persistence

```
texts        : id, title, source, lang, kind, createdAt, updatedAt, folderId, rawText
parses       : textId -> {tokens, blocks, chunks, lines, sentences, roles}   // regenerable, cached
modeState    : (textId, modeId) -> {rung, reshuffle, phase, params, adaptiveSuspended, lastUsedAt}
chunkState   : (textId, chunkIdx) -> {rung, state, masteredAt, dueAt, interval, failCount, leech}
reps         : append-only, capped at 200 per text (ring buffer), used for the ladder and the stats screen
settings     : peekHoldMs, resetHoldMs, hoverPeek, blankStyle, wpm, sessionMinutes, adaptive, ...
```

All IndexedDB (via a thin wrapper; no ORM). `parses` are disposable cache; everything else is user data and is
included in JSON export/import.

---

## 12. Test checklist for the engine

1. **No-reflow property test**: for a fixture text, record `getBoundingClientRect()` of every `.tok` at L0,
   then assert identical rects (±0.02 px) at every rung of every mode and mask style, and after peek/reveal.
   This test is the reason the architecture looks the way it does; it must run in CI (Playwright).
2. **Nesting property**: for each percentage mode, `masked(L_n) ⊆ masked(L_{n+1})` over 50 random fixtures.
3. **Determinism**: identical plans across two builds with the same spec; `Uint8Array` equality.
4. **Reshuffle efficacy**: Jaccard(plan, plan after reshuffle) < 0.9 at rungs 1–5.
5. **Cardinality**: `maskedCount === Math.round(p * candidateCount)` exactly, for all `p` in the ladder.
6. **Golden files** per mode on three fixtures (Hamlet soliloquy, a 3-verse song, a 300-word speech): the
   masked text serialised as `"To ▁▁ or ▁▁ to be"` snapshots. These catch every accidental behaviour change.
7. **Tokenizer round-trip**: `tokens.map(t => t.leading + t.text + t.trailing).join(' ')` reconstructs the
   source modulo whitespace normalisation, for a corpus of 20 imported files.
8. **Script parsing**: 10 real scripts in 3 formats; role detection precision/recall reported, target ≥ 0.95
   precision (false roles are worse than missed ones — a wrong role wrecks My Lines).
9. **Ladder simulation**: synthetic users (perfect / average / struggling) run 40 reps; assert the perfect
   user reaches L7 in ≤ 8 reps, the struggling user never oscillates more than ±1 rung three times in a row,
   and the "two holds → change intervention" rule always fires.
10. **Performance**: 5000-token doc, plan build < 8 ms, plan apply < 16 ms, blur mode holds 60 fps on an
    iPhone 12-class device.

---

## 13. Deliberate non-goals for v1 (revisit later)

Speech recognition scoring, TTS scene partner, self-recording playback, pace/prosody coaching, cloud sync,
sharing. All are listed as differentiators elsewhere in the plan; none of them belong in the masking engine,
and every one of them is a rabbit hole that would delay the thing that actually teaches lines. The engine
above is a few hundred lines of pure TypeScript plus about 60 lines of CSS, and that is the whole product.
