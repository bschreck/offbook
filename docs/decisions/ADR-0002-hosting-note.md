# Note on `_redirects` and Pages Functions

`public/_redirects` used to contain `/*  /index.html  200` as an SPA fallback. It was deleted
when the sync backend landed, because **Cloudflare Pages evaluates `_redirects` before
Functions**, so that catch-all rewrote every `/api/*` request to the SPA shell. The symptom was
`GET /api/auth/me` returning `index.html` with status 200 instead of a 401 JSON body — a
sign-in button in front of a backend that appeared to exist and did nothing.

Pages already has native single-page-app behaviour: a path that matches neither a static asset
nor a Function is served the root document. So the fallback was redundant as well as harmful.

The GitHub Pages workflow does not rely on this file either — it copies `index.html` to
`404.html`, which is that platform's equivalent.

**If you ever reintroduce a catch-all here, carve out `/api/*` first, or the entire backend
disappears silently.**
