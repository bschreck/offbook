-- Offbook sync backend. ADR-0008.
-- Applied with: npx wrangler d1 migrations apply offbook --remote

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  -- Normalised for identity (NFKC, trimmed, lowercased). The salt is derived from this
  -- exact value, so the two must never diverge — see shared/auth/kdf.ts.
  username      TEXT NOT NULL UNIQUE,
  -- What the user typed, for display only.
  username_display TEXT NOT NULL,
  -- PBKDF2(authKey, server_salt, SERVER_ITERATIONS). Never the password, never authKey.
  pw_hash       TEXT NOT NULL,
  server_salt   TEXT NOT NULL,
  -- Which KDF parameters produced pw_hash, so an upgrade is a coordinated change and old
  -- rows stay verifiable.
  kdf_version   INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  -- Monotonic per-user revision counter: the sync cursor every client compares against.
  rev           INTEGER NOT NULL DEFAULT 0,
  usage_bytes   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  -- SHA-256 of the cookie token. A leaked database yields no usable sessions.
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE INDEX sessions_by_user ON sessions(user_id);
CREATE INDEX sessions_by_expiry ON sessions(expires_at);

-- One generic table rather than five typed ones: the server never inspects a payload, it
-- only routes by (store, id) and orders by rev.
CREATE TABLE records (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store         TEXT NOT NULL,
  id            TEXT NOT NULL,
  rev           INTEGER NOT NULL,
  -- Client clock. The last-write-wins comparand for mutable stores.
  updated_at    INTEGER NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  -- NULL when deleted. JSON, opaque to the server.
  payload       TEXT,
  bytes         INTEGER NOT NULL DEFAULT 0,
  -- Which device last wrote this, so a last-write-wins tie has a deterministic winner.
  device_id     TEXT,
  PRIMARY KEY (user_id, store, id)
);

-- The only query shape pull uses: "everything for this user above my cursor, in order".
CREATE INDEX records_by_rev ON records(user_id, rev);

-- Rate limiting for sign-in, keyed by username and by IP separately so neither a targeted
-- nor a spray attack is cheap.
CREATE TABLE login_attempts (
  key           TEXT PRIMARY KEY,
  count         INTEGER NOT NULL DEFAULT 0,
  window_start  INTEGER NOT NULL
);
CREATE INDEX login_attempts_by_window ON login_attempts(window_start);
