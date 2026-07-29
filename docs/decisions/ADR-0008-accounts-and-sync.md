# ADR-0008 — Optional accounts and local-first sync

**Status:** accepted. Reverses part of the original "no accounts, no server" scope
(PLAN.md §3.2), which is now amended rather than pretended about.

## Context

Local-first storage gives you offline, privacy and zero running cost, but it cannot give you
your library on a second device. That is the one thing no amount of IndexedDB work can fix, and
it is what was actually wanted.

## Decision

**Accounts are optional. IndexedDB stays the source of truth.**

- The app works exactly as before with no account. Nothing is gated behind signing in.
- Signing in opts you into replication. The server is a **replica**, not the origin.
- The reader never awaits a network call. Sync happens in the background; if it fails, nothing
  in the app stops working.
- A server outage or a revoked token can never prevent you rehearsing a text already on the
  device.

Server is **Cloudflare Pages Functions** in the existing `offbook` Pages project, with a **D1**
binding. Same project, same deploy, same origin — which means no CORS, and crucially no CSP
change, because `connect-src 'self'` already permits it.

## Why the password KDF runs in the browser

This is the load-bearing and least obvious decision, so it is written down properly.

**The constraint:** Workers Free allows **10 ms of CPU per request**. OWASP's current guidance
for PBKDF2-HMAC-SHA256 is **600,000 iterations**, which costs roughly 300–600 ms of CPU. A
conventional server-side password hash does not merely run slowly here — it exceeds the limit
and the request is killed with error 1102. Reducing iterations to fit 10 ms would mean roughly
20–30k, far below anything defensible.

**The design:**

```
client:  authKey = PBKDF2-SHA256(password, salt = HKDF(username + "offbook"), 600_000, 32 bytes)
wire:    base64(authKey), over TLS. The password itself never leaves the device.
server:  stored = PBKDF2-SHA256(authKey, random per-user serverSalt, 1_000, 32 bytes)
```

**What this preserves.** The expensive work factor still protects the password after a database
leak: the stored value commits to `authKey`, which commits to the password through 600,000
iterations. An attacker with the database who wants the *password* must pay the full 600k per
guess, exactly as with conventional hashing. Recovering `authKey` itself from the stored hash
means inverting PBKDF2 over a 32-byte high-entropy input, which is not feasible.

**What this costs, stated honestly.** `authKey` is a password-equivalent bearer credential in
transit. TLS covers that, and a live server compromise sees it — but a live compromise of a
conventional design sees the plaintext password too, so this is not worse in the threat model
that matters. What *is* genuinely worse: the server cannot unilaterally raise the iteration
count, because the client computes it. The count is therefore a shared constant with a version
field beside it, so an upgrade is a coordinated change and old records can be re-derived on next
successful login.

**The salt is deterministic** (`HKDF(username + "offbook")`) because the client must know it
before it can authenticate, and a salt-fetch endpoint would leak which usernames exist. It
includes the app name so a hash is not reusable against another site. Usernames are unique, so
two users cannot collide.

`authKey` derivation takes 300–800 ms on a phone. That is acceptable for a sign-in with a
spinner, and it is paid once per session, not per request.

## Sessions

Opaque 32-byte random tokens, not JWTs — we have a database, so revocation should be real. The
token goes in an `httpOnly; Secure; SameSite=Lax` cookie, and only its SHA-256 is stored, so a
database leak does not yield usable sessions. Logging out deletes the row.

Login attempts are rate limited per username and per IP in D1, to make credential stuffing
expensive.

## Why sync is unusually cheap here

The existing data model was not designed for sync, but three earlier decisions make it almost
free:

| Store | Property | Merge |
|---|---|---|
| `docText` | `sourceText` is **immutable** (PLAN.md §3.1) | Content-addressed by `textHash`. Push once. Cannot conflict. |
| `reps` | **append-only**, UUID keys (ADR-0006) | Set union. Cannot conflict. |
| `documents`, `folders` | mutable metadata, already carry `updatedAt` and `deletedAt` | Last-write-wins on `updatedAt`, device id breaking ties. |
| `settings` | small, per-key | Last-write-wins per key. |
| `derived` | a **cache** | Never synced. Recomputed locally. |

So the only genuine conflict surface is document metadata — title, folder, practice prefs,
cursor — where last-write-wins is honest and adequate. If you practise the same text on two
devices, the rung from the device that synced last wins. That is the expected behaviour, and it
loses nothing, because `reps` from both devices merge by union.

## The protocol

A monotonic per-user revision counter, which is the standard sync-cursor pattern:

- `POST /api/sync/pull { sinceRev }` → `{ rev, records[] }` — everything changed since the
  client's cursor.
- `POST /api/sync/push { records[] }` → `{ rev, applied, rejected[] }` — the server assigns new
  revisions and reports what it refused.
- The client stores `lastSyncedRev` and a stable `deviceId` in `meta`.

One generic `records(user_id, store, id, rev, updated_at, deleted, payload)` table rather than
five typed ones: the server never inspects a payload, it only routes by `(store, id)` and
orders by `rev`. Deletions are tombstones, which the existing soft-delete already provides.

## Quotas

Per record 1 MB, per account 50 MB, enforced server-side with a specific error rather than a
generic failure — a two-hour play is a legitimate document and the limit should say so out loud
when it is hit.

## Consequences

- **The privacy copy must change.** "After the app loads it makes no network requests at all"
  becomes false for a signed-in user. About and Settings now state the truth: nothing leaves the
  device unless you sign in, and then only your own texts, to our own server, never to a third
  party. Shipping the old sentence alongside a sync feature would be a lie.
- `src/shared/**` is a new layer for code that must be identical on client and server (the KDF,
  the wire types). It may use WebCrypto; it may not touch the DOM or IndexedDB.
- The Cloudflare API token needs **Account → D1 → Edit** added for migrations.
- Free-tier D1 is 5 GB and 5M row reads/day, which is not a constraint at this scale.
