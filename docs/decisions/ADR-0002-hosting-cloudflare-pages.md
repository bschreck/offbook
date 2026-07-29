# ADR-0002 — Deploy on Cloudflare Pages at the root

**Status:** accepted. Supersedes the interim GitHub Pages decision recorded here earlier
(and PLAN.md §0.0 A7, which is now historical).

## Context

The plan chose Cloudflare Pages for two concrete reasons: deploy at the **domain root**, so the
service-worker scope and `start_url` are clean; and a `_headers` file, so the CSP can be a real
response header. Neither could be set up during the initial build — connecting Cloudflare needs
an interactive `wrangler login` or a dashboard click — so the app shipped on GitHub Pages under
`VITE_BASE=/offbook/` with the CSP as a `<meta http-equiv>` and `404.html` standing in for SPA
routing. That was always meant to be temporary.

## Decision

Deploy to **Cloudflare Pages at the root** via `cloudflare/wrangler-action` in
`.github/workflows/deploy-cloudflare.yml`, on push to `main`.

Live at `https://offbook-4ev.pages.dev` (the bare `offbook.pages.dev` subdomain was taken;
the project itself is named `offbook`).

## What the root deploy actually buys, verified against the live site

| | Before (GitHub Pages) | Now |
|---|---|---|
| CSP | `<meta http-equiv>`, no `frame-ancestors` | real header, **including `frame-ancestors 'none'`** |
| `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `COOP` | impossible | all set |
| `/assets/*` | default caching | `max-age=31536000, immutable` |
| `/sw.js` | default caching | `no-cache` |
| Deep links | `404.html` copy of `index.html` | `_redirects` 200-rewrite |
| Service-worker scope | `/offbook/` | `/` |

## Configuration

Two repository secrets:

- `CLOUDFLARE_API_TOKEN` — **Account → Cloudflare Pages → Edit**, and nothing else. Not
  `User → User Details → Read` (only `wrangler whoami` wants that), not Workers.
- `CLOUDFLARE_ACCOUNT_ID` — exactly 32 lowercase hex characters.

The workflow trims whitespace from the account id and asserts its length before deploying. This
is not defensive padding: the id is interpolated into an API **URL path**, so a trailing newline
fails as `Could not route to /client/v4/accounts/.../pages/projects [code: 7003]`, which reads
like a missing project rather than a malformed secret. It cost a debugging round; the assertion
turns it into one clear error line.

## GitHub Pages is kept, disarmed

`deploy.yml` still exists and still builds correctly under `VITE_BASE=/offbook/`, but it is
**`workflow_dispatch` only**. It is a manual escape hatch for the day Cloudflare is down or the
token is revoked.

It must not go back on `push`. Storage in this app is origin-scoped, so two live copies means
two separate IndexedDB libraries with no indication to the user which one holds their texts —
a worse failure than having no fallback at all.

## Reversal

Switching back is `VITE_BASE=/offbook/` and re-enabling the push trigger. The `_headers` and
`_redirects` files stay committed either way; GitHub Pages simply ignores them, which is why
`index.html` also carries the CSP as a meta tag.
