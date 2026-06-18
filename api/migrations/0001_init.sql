-- Health-app backend — initial schema (Phase-1 foundation).
--
-- Design notes:
--  * All ids are app-generated random tokens (crypto.randomUUID), not autoincrement,
--    so ids are unguessable and don't leak row counts.
--  * Passwords are NEVER stored: only a PBKDF2-HMAC-SHA256 hash + per-user salt + the
--    iteration count + algorithm tag (so params can be upgraded later without a flag day).
--  * Sessions store only a SHA-256 HASH of the opaque token (a DB leak can't be replayed).
--  * google_sub is the stable account-linking key (NOT email); email alone is never trusted.
--  * The per-user data store is a typed key/blob table: one row per (user_id, section),
--    section ∈ {profile, meals, workouts, ...}. This mirrors the app's existing
--    localStorage keys and lets the app wire each section independently next stage.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,                 -- random uuid
  email           TEXT NOT NULL,                    -- normalised (lowercased, trimmed)
  email_verified  INTEGER NOT NULL DEFAULT 0,       -- 0/1; 1 when verified via OAuth or email-verify
  -- Password credential (NULL for OAuth-only accounts):
  password_hash   TEXT,                             -- base64 PBKDF2 derived key
  password_salt   TEXT,                             -- base64 per-user random salt (16 bytes)
  password_algo   TEXT,                             -- e.g. "pbkdf2-sha256$100000" (algo$iterations)
  -- Google OAuth linkage (NULL until linked):
  google_sub      TEXT,                             -- Google subject id (stable per Google account)
  display_name    TEXT,                             -- optional, from profile/OAuth
  created_at      INTEGER NOT NULL,                 -- unix seconds
  updated_at      INTEGER NOT NULL,
  last_login_at   INTEGER
);

-- One account per email (case-insensitive: email is stored already-normalised).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email);
-- One account per Google subject (partial: only rows that have linked Google).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub
  ON users (google_sub) WHERE google_sub IS NOT NULL;

-- ---------------------------------------------------------------------------
-- sessions  (server-side session store; cookie carries the opaque token only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,                   -- random session id (also stored in cookie part 1)
  user_id       TEXT NOT NULL,
  token_hash    TEXT NOT NULL,                      -- SHA-256(base64) of the opaque secret (never the secret)
  csrf_token    TEXT NOT NULL,                      -- double-submit CSRF token bound to this session
  created_at    INTEGER NOT NULL,                   -- unix seconds
  expires_at    INTEGER NOT NULL,                   -- unix seconds (server-side expiry)
  last_seen_at  INTEGER NOT NULL,
  user_agent    TEXT,                               -- coarse, for the user's own session list later
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- oauth_states  (short-lived; anti-CSRF state + PKCE verifier + nonce for OIDC)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_states (
  state           TEXT PRIMARY KEY,                 -- random, returned by Google in the callback
  code_verifier   TEXT NOT NULL,                    -- PKCE code_verifier (exchanged, never sent to client)
  nonce           TEXT NOT NULL,                    -- OIDC nonce, checked against id_token
  redirect_after  TEXT,                             -- optional safe relative path to land on (validated)
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL                  -- short TTL (e.g. 10 min)
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states (expires_at);

-- ---------------------------------------------------------------------------
-- rate_limit  (sliding-window counters; key = bucket like "login:ip:1.2.3.4")
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limit (
  bucket        TEXT PRIMARY KEY,                   -- "<action>:<dimension>:<value>"
  count         INTEGER NOT NULL,                   -- attempts in the current window
  window_start  INTEGER NOT NULL,                   -- unix seconds the window opened
  blocked_until INTEGER                             -- if set + in future, requests are rejected
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit (window_start);

-- ---------------------------------------------------------------------------
-- user_data  (per-user typed key/blob store; the seam the app wires to next)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_data (
  user_id     TEXT NOT NULL,
  section     TEXT NOT NULL,                        -- "profile" | "meals" | "workouts" | ...
  data        TEXT NOT NULL,                        -- JSON blob (opaque to the backend)
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, section),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
