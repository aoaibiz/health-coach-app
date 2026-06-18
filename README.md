# health-coach

A privacy-first **food + workout coaching PWA**. Snap a photo of a meal and get
nutrition that is **grounded to a real nutrition database, not fabricated** —
the model only identifies dishes and estimates portions; every calorie/PFC
number is computed from the bundled data source. Log workouts, chat with an AI
coach that never invents numbers, and get Web Push reminders.

The default AI path runs on a **subscription LLM via the Codex CLI** — no paid
API key required.

> Released under the MIT License (see `LICENSE`). Built by Talmudo Inc.

## Highlights

- **Meal photo → grounded nutrition.** Dishes/portions from an LLM; all numbers
  grounded against a real nutrition DB (anti-fabrication by design).
- **Workout logging** with per-exercise sets × reps × weight and daily totals.
- **Chat coach** that is explicitly prevented from fabricating nutrition figures.
- **Calendar** view of meals / workouts / weight / nutrition deltas per day.
- **Web Push** notifications (VAPID), iOS-aware.
- **Accounts**: email+password (PBKDF2 via Web Crypto) and Google OAuth (OIDC,
  PKCE, nonce), CSRF-protected, with per-user data sync.
- **Cloudflare-native backend** (Worker + D1), no external SaaS.

## Monorepo layout

```
health-coach/
├── app/        # Next.js PWA (static export) + a Node server hosting the
│               # /api/analyze-meal and /api/chat Codex routes
├── api/        # Cloudflare Worker + D1: auth, accounts, per-user data, Web Push
├── README.md   # (this file)
├── LICENSE     # MIT
├── SECURITY.md # vulnerability disclosure policy
└── .gitignore
```

Each subproject is self-contained with its own `package.json`, build, and tests.
See `app/README.md` and `api/README.md` for subproject specifics.

## Architecture (at a glance)

```
 Browser PWA (app/, static export)
   │  cross-origin, credentials: "include"
   ├──────────────► api/  (Cloudflare Worker + D1)
   │                   auth (email+password / Google OAuth), sessions,
   │                   per-user data sync, Web Push (VAPID)
   │
   └── same-origin ─► app/ Node server (server/index.mjs)
                          /api/analyze-meal, /api/chat
                          → subscription Codex CLI (no API key)
                          → nutrition grounded to a real DB
```

## LLM providers

- **Default (recommended): subscription Codex CLI** —
  `app/functions/_llm/codex.ts` (meal vision) and
  `app/functions/_llm/chat.ts` (chat). Needs **no API key**; the Node server
  spawns the `codex` binary in a read-only sandbox.
- **Optional / legacy: Anthropic Messages API** —
  `app/functions/_llm/anthropic.ts`. Kept as an alternative reference, inert
  unless wired up; requires `ANTHROPIC_API_KEY`. Most self-hosters can ignore it.

---

# Self-host quickstart

You will stand up two pieces: the **`api/` Worker** (auth + data + push) and the
**`app/`** frontend + Node server. Nothing here is auto-deployed — all config is
placeholders you fill in for your own Cloudflare account.

## 1. `api/` — Cloudflare Worker + D1

```bash
cd api
pnpm install

# Create the D1 database, then paste the returned database_id into wrangler.toml
# (BOTH [[d1_databases]] blocks: top-level and [[env.production.d1_databases]]).
wrangler d1 create health_app_db
```

Edit `api/wrangler.toml` and replace every `<PLACEHOLDER>`:

| Placeholder              | What to put                                                        |
|--------------------------|--------------------------------------------------------------------|
| `<YOUR_D1_DATABASE_ID>`  | the id printed by `wrangler d1 create` (both occurrences)          |
| `<your-app-host>`        | your app origin, e.g. `app.example.com`                            |
| `<your-api-host>`        | this Worker's host, e.g. `api.example.com` (also the prod route)   |
| `<YOUR_VAPID_PUBLIC_KEY>`| the VAPID public key from step 3 (both occurrences)               |
| `mailto:you@example.com` | a real contact `mailto:` for VAPID (`VAPID_SUBJECT`)               |

Set the secrets (never committed — see `api/SECRETS.md` and `.dev.vars.example`):

```bash
# Google login (optional — email+password works without it):
wrangler secret put GOOGLE_CLIENT_ID      --env production
wrangler secret put GOOGLE_CLIENT_SECRET  --env production

# Web Push (optional — only if you use notifications):
wrangler secret put VAPID_PRIVATE_JWK     --env production
```

Apply migrations and deploy:

```bash
pnpm db:migrate:remote
wrangler deploy --env production
```

For **local development**: copy `.dev.vars.example` → `.dev.vars`, then
`pnpm db:migrate:local && pnpm dev`. Run `pnpm test` and `pnpm typecheck` to
verify (tests run in the real Workers runtime via `@cloudflare/vitest-pool-workers`).

## 2. `app/` — frontend + Node server

```bash
cd app
npm install

# Configure (see .env.example):
#   NEXT_PUBLIC_HEALTH_API  → your api/ Worker origin (https://api.example.com)
#   HEALTH_APP_TOKEN        → a long random shared secret for the AI routes
#   CODEX_BIN               → path to the codex CLI (default: codex on PATH)

npm run build:all          # static export (out/) + compile server handlers (dist/)
npm run serve              # node server/index.mjs  (defaults to PORT 8787)
```

Alternatively deploy the static export (`out/`) to **Cloudflare Pages**
(build command `npm run build`, output dir `out`; `public/_headers` adds
baseline security headers).

> **iOS Web Push** requires the user to **Add to Home Screen** (install the PWA)
> before notifications can be enabled — this is a Safari/iOS platform rule.

## 3. Generate a VAPID keypair (for Web Push)

Web Push needs an ES256 / P-256 keypair. The **public** key (base64url,
uncompressed) goes in `api/wrangler.toml` (`VAPID_PUBLIC_KEY`, both occurrences)
and is what the browser uses as `applicationServerKey`; the **private** key (as a
JWK string) is the `VAPID_PRIVATE_JWK` Worker secret.

Generate both in the exact formats this project expects with Node (≥ 18):

```bash
node --input-type=module -e '
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign","verify"]);
const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
console.log("VAPID_PUBLIC_KEY =", Buffer.from(pub).toString("base64url"));
console.log("VAPID_PRIVATE_JWK =", JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }));
'
```

Put `VAPID_PUBLIC_KEY` into `api/wrangler.toml` (and optionally into
`app/src/lib/push.ts` `FALLBACK_VAPID_PUBLIC_KEY`), and set `VAPID_PRIVATE_JWK`
as a Worker secret. **Keep the private JWK secret — never commit it.**

## Security

Passwords use PBKDF2-HMAC-SHA256 via Web Crypto at 100,000 iterations (the
Cloudflare Workers platform hard cap for PBKDF2; the iteration count is stored in
the password algo tag so it can be raised with a re-hash-on-login upgrade path).
Sessions are opaque tokens stored hashed; CSRF uses SameSite=Lax + a strict
Origin/Referer gate + a double-submit token; OAuth uses state + PKCE + nonce with
full ID-token verification. See `api/README.md` for the full security design and
`SECURITY.md` for vulnerability reporting.
