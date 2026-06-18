# health-coach-api

The **backend** for the health-coach app: a standalone **Cloudflare Worker**
providing account-based auth (email+password and Google OAuth) + a per-user data
API, backed by **Cloudflare D1**. Cloudflare-native (no external SaaS). The
static app lives in `../app` and calls this Worker cross-origin with credentials.

> This is the `api/` half of the monorepo. See the root `README.md` for the full
> self-host quickstart (creating the D1 database, filling the `wrangler.toml`
> placeholders, setting secrets, applying migrations, and generating a VAPID
> keypair).

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/register` | none | email+password; strict Origin gate; rate-limited; uniform 202 accepted (NO auto-login, no existing-vs-new oracle) |
| POST | `/auth/login` | none | email+password; strict Origin gate; generic errors; constant-time (dummy PBKDF2 for absent users); rate-limited |
| POST | `/auth/logout` | session + CSRF | revokes the session server-side |
| GET  | `/auth/me` | session | current user + CSRF token |
| GET  | `/auth/google/start` | none | 302 → Google (state + PKCE + nonce) |
| GET  | `/auth/google/callback` | none | validates state, verifies ID token, links/creates account |
| GET  | `/api/user/data?section=` | session | read a per-user JSON section |
| PUT  | `/api/user/data?section=` | session + CSRF | write a per-user JSON section |
| GET  | `/health` | none | liveness |

`section ∈ { profile, meals, workouts }` — mirrors the app's existing
localStorage keys, so each can be wired independently next.

## Security design (summary — full detail in code comments + SECURITY notes)

- **Passwords**: PBKDF2-HMAC-SHA256 via Web Crypto (the password-grade KDF the
  Workers runtime actually supports), 100,000 iterations, 16-byte per-user random
  salt, stored as `hash`/`salt`/`algo` (`pbkdf2-sha256$<iters>`) so params can be
  upgraded later. Never plaintext; never logged. Constant-time verify.
  (NOTE: 100,000 is the Cloudflare Workers platform HARD CAP for PBKDF2 —
  `crypto.subtle.deriveBits` throws above it, so OWASP's higher floor isn't
  reachable on Workers. The iteration count is stored in the algo tag, so if the
  cap is ever raised you can bump it and transparently re-hash on the next
  successful login — no flag day.)
- **Sessions**: opaque 256-bit secret in an `HttpOnly; Secure; SameSite=Lax`
  cookie; the DB stores only the SHA-256 hash (a DB leak can't be replayed).
  Fresh session minted on every login (anti-fixation). Server-side expiry +
  revocation on logout. `Secure` is FORCED in production (fail-closed: a prod
  deploy with `COOKIE_SECURE != "true"` is rejected at the entrypoint).
- **CSRF**: SameSite=Lax + strict, fail-closed Origin/Referer check + double-submit
  token (`ha_csrf` cookie ↔ `X-CSRF-Token` header) on state-changing requests.
  The pre-session endpoints (`/auth/register`, `/auth/login`) enforce the strict
  Origin/Referer gate (anti login-CSRF) since no CSRF token exists yet.
- **CORS**: locked to `APP_ORIGIN` exactly (no wildcard), credentials enabled.
- **Rate limiting**: D1-backed fixed-window + lockout, per-IP AND per-email on
  login/register, plus per-IP on `/auth/google/start`. The client IP is taken
  ONLY from `CF-Connecting-IP` (edge-trusted, unspoofable); client-supplied
  headers (`X-Real-IP`/`X-Forwarded-For`) are never trusted. Expired sessions +
  oauth_states are GC'd by a cron (`scheduled`) + opportunistically on OAuth start.
- **OAuth**: state (anti-CSRF, single-use) + PKCE S256 + OIDC nonce; full ID-token
  verification (RS256 signature vs Google JWKS, `iss`/`aud`/`exp`/`iat`/`nonce`);
  account linking keyed on `google_sub`. We NEVER auto-link a Google identity to a
  pre-existing account (anti pre-account-takeover): a known `sub` logs in; a
  verified email with no existing account creates a new account; a verified email
  that already has an account is REFUSED (`oauth_link_required`) — the safe path is
  log in with the password, then link Google while authenticated.
- **SQLi**: D1 prepared statements with bound params exclusively (see `src/lib/db.ts`).
- **Errors/logs**: generic auth errors (no user enumeration); no PII/secret/stack in responses or logs.

## Local development

```bash
pnpm install
pnpm db:migrate:local          # apply migrations to the local D1
pnpm dev                       # wrangler dev --local
pnpm test                      # vitest in the real Workers runtime (workerd + D1)
pnpm typecheck                 # tsc --noEmit, zero errors
```

Secrets: see `SECRETS.md` (names only). Email+password + data APIs work with no
secrets; Google login needs `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

## Deploy

1. `wrangler d1 create health_app_db` → put the returned `database_id` into
   `wrangler.toml` (both `[[d1_databases]]` blocks).
2. Fill in the remaining `wrangler.toml` placeholders (`APP_ORIGIN`,
   `API_ORIGIN`, the production `route` host, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`).
3. `pnpm db:migrate:remote`.
4. `wrangler secret put GOOGLE_CLIENT_ID --env production` (+ `GOOGLE_CLIENT_SECRET`),
   and `wrangler secret put VAPID_PRIVATE_JWK --env production` if you use Web Push.
5. Configure the Google OAuth client (redirect URI / origins) per `SECRETS.md`.
6. `wrangler deploy --env production`.
