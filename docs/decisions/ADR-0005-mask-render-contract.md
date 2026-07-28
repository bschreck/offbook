# ADR-0005 — How a masked word is rendered

**Status:** accepted. This is the one a refactor would innocently destroy.

## Decision

One `<span class="tok">` per token. The real text lives in an inner `<span class="txt">`, and
masking sets `visibility: hidden` on that inner span. `lead` and `trail` punctuation are text
nodes on the outer span and are never masked.

```html
<span class="tok" data-i="128" data-mask="rule">“<span class="txt">Ophelia</span>,</span>
```

## Why `visibility: hidden` and not something else

It buys four things in one decision, with zero measurement code:

- The box keeps its **exact advance width** in every font, at every size, with any
  `letter-spacing`, `word-spacing` or `font-variant` — so "no layout shift on reveal" is
  structurally true rather than approximately true. A word that moves when it hides destroys the
  spatial memory of the page, which is part of how people learn lines.
- The glyphs leave the **accessibility tree**, so nothing leaks to a screen reader.
- The glyphs leave **selection** and **find-in-page**, so `⌘F` and select-all cannot cheat.
- Opacity and filters do not affect layout either, so the `dim` style is equally safe.

## Rejected, and why they must not come back

| Rejected | Why |
|---|---|
| `color: transparent` + background fill | Leaks the answer to copy, select-all, find-in-page and screen readers. |
| Canvas `measureText` for blank widths | Ignores `letter-spacing`, `word-spacing`, `font-feature-settings` and synthetic bold, and rounds differently from layout — blanks land 1–3 px off and words visibly nudge on reveal, precisely for the low-vision users who turned the spacing pack on. |
| Four nested spans per token | Blows the DOM budget: ~40k elements at 10,000 words instead of ~10k. |
| `display: none` | Collapses the box. The whole point is that it must not. |

## Consequences we accept and state plainly

Devtools can see the text, and so can IndexedDB. We are not building DRM. `user-select: none` on
the reader canvas means a quote cannot be selected by dragging, which is why an explicit
"Select text" / "Copy this line" action exists.

## Enforcement

A test compares every token's `getBoundingClientRect()` at 0% masking and at 45% masking and
fails on any difference. If that test is deleted, this ADR is unenforced.
