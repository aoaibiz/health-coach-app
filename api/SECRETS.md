# Secrets — health-app-api

**No secret values appear in this repo.** This file lists secret NAMES only.
Values are injected at deploy time and never committed.

## Required secrets (production)

Set with `wrangler secret put <NAME>` (prompts for the value; stored encrypted by
Cloudflare, never in the repo):

| Secret name            | Purpose                                                        |
|------------------------|----------------------------------------------------------------|
| `GOOGLE_CLIENT_ID`     | Google OAuth 2.0 / OIDC web client id (used as the ID-token `aud`). |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret — used only server-side in the code exchange. |

```bash
# Production (run at deploy, after `wrangler d1 create health_app_db`):
wrangler secret put GOOGLE_CLIENT_ID      --env production
wrangler secret put GOOGLE_CLIENT_SECRET  --env production
```

> The `GOOGLE_CLIENT_ID` is technically public (it ships in the browser redirect),
> but we still inject it as a secret/env so it isn't hardcoded and can rotate
> without a code change. The `GOOGLE_CLIENT_SECRET` is a true secret — code only.

## Local development

For `wrangler dev`, put dev-only, non-production placeholders in **`.dev.vars`**
(gitignored — see `.gitignore`). Example template (DO NOT use real prod values):

```
# .dev.vars  (gitignored — never commit)
GOOGLE_CLIENT_ID=dev-placeholder-client-id
GOOGLE_CLIENT_SECRET=dev-placeholder-client-secret
```

Without these, the Google-login endpoints return `503 oauth_unavailable`; the
email+password + data APIs work fully without any secret. The local auth-flow
verification in this task was run WITHOUT any real secret present.

## Non-secret config (safe to commit)

These live in `wrangler.toml [vars]` (and `[env.production.vars]`) — they are
configuration, not secrets: `APP_ORIGIN`, `API_ORIGIN`, `GOOGLE_REDIRECT_PATH`,
`COOKIE_DOMAIN`, `COOKIE_SECURE`, `SESSION_TTL_SECONDS`, `ENVIRONMENT`.

## Signing keys

None required. Sessions are **opaque server-side tokens** (random secret, stored
as a SHA-256 hash in D1) — there is no JWT signing key to manage. If a future
stage switches to signed JWTs, add a `SESSION_SIGNING_KEY` secret here.

## Google OAuth setup checklist (at deploy)

In Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client (Web):
- Authorized redirect URI: `https://<your-api-host>/auth/google/callback`
  (must EXACTLY match `API_ORIGIN` + `GOOGLE_REDIRECT_PATH` in `[env.production.vars]`).
- Authorized JavaScript origin: `https://<your-app-host>` (the app origin).
- Scopes: `openid email profile`.
