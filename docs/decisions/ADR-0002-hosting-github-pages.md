# ADR-0002 — Deploy on GitHub Pages, keep Cloudflare Pages one click away

**Status:** accepted, amending the plan's original Cloudflare-first choice (PLAN.md §0.0 A7).

## Context

The plan chose Cloudflare Pages for two real reasons: deploy at the **domain root** (clean
service-worker scope and `start_url`) and a `_headers` file for a strict CSP. Connecting it
requires either an interactive `wrangler login` or a click-through in the Cloudflare dashboard,
neither of which could be automated during the build. GitHub was already authenticated.

## Decision

Deploy to GitHub Pages at `https://bschreck.github.io/offbook/` via GitHub Actions.

## Consequences, and how each is handled

| Consequence | Handling |
|---|---|
| Project sites are served from a sub-path, not the root | Vite `base` comes from `VITE_BASE` (default `/`). CI sets `/offbook/`. The router's `basename` reads `import.meta.env.BASE_URL`. Moving to a root domain is an env change, not a refactor. |
| Service-worker scope is the sub-path | Correct and self-consistent — the whole app lives under that scope. |
| Pages cannot serve custom headers | The CSP ships as a `<meta http-equiv>` in `index.html`. `public/_headers` is still committed and stays in sync. |
| `frame-ancestors` and `X-Content-Type-Options` cannot be set by meta | Accepted v1 gap. `frame-ancestors` is the one that matters, and it returns the moment this moves to Cloudflare. |
| No SPA fallback for deep links | CI copies `dist/index.html` to `dist/404.html`, which Pages serves for unknown paths. |

## Switching to Cloudflare later

Connect the repo in the Cloudflare Pages dashboard, build `npm run build`, output `dist`. The
committed `_headers` and `_redirects` are picked up automatically and `VITE_BASE` stays at its
`/` default. No code change.
