-- Web Push subscriptions (Phase-1 push-notification foundation).
--
-- Design notes (mirrors 0001_init.sql conventions):
--  * id is an app-generated random token (crypto.randomUUID), not autoincrement —
--    unguessable, doesn't leak row counts.
--  * One row per browser push subscription. The push service `endpoint` URL is
--    the natural unique key (a given browser+service yields one endpoint), so it
--    is UNIQUE: re-subscribing the same browser UPSERTs the same row rather than
--    accumulating duplicates.
--  * p256dh / auth are the client-supplied keys (base64url) needed to encrypt the
--    payload (RFC 8291). They are NOT secrets of ours but are per-subscription; we
--    never log them.
--  * user_id FK → users(id) ON DELETE CASCADE: deleting a user reaps their
--    subscriptions automatically (same pattern as sessions / user_data).
--  * created_at is unix seconds, matching the timestamp convention used throughout
--    0001_init.sql.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          TEXT PRIMARY KEY,                   -- random uuid
  user_id     TEXT NOT NULL,
  endpoint    TEXT NOT NULL,                       -- push service URL (unique per browser+service)
  p256dh      TEXT NOT NULL,                       -- base64url client public key (RFC 8291)
  auth        TEXT NOT NULL,                       -- base64url client auth secret (RFC 8291)
  created_at  INTEGER NOT NULL,                    -- unix seconds
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- The endpoint is globally unique: a re-subscribe UPSERTs by endpoint (see
-- routes/push.ts) so we never store the same browser twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint ON push_subscriptions (endpoint);
-- Look up all of a user's subscriptions (the /api/push/test fan-out, deletes).
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id);
