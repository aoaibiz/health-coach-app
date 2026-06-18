# health-coach app (frontend + Node server)

The `app/` half of the monorepo: a mobile-first PWA for food + workout coaching,
plus the small Node server that backs its AI features. The companion auth /
account / data backend lives in `../api` (a Cloudflare Worker + D1).

> See the repository **root `README.md`** for the project overview and the full
> self-host quickstart. This file documents the `app/` subproject specifically.

## What this subproject contains

- **Next.js 14 (App Router) + TypeScript + Tailwind** UI, exported as a static
  site (`output: "export"` → `out/`). Deployable to Cloudflare Pages or served
  by the bundled Node server.
- A **Node server** (`server/index.mjs`, plain `node:http`, zero extra deps) that:
  - serves the static export from `out/`, and
  - hosts `POST /api/analyze-meal` and `POST /api/chat`, which call the
    **subscription Codex CLI** (no paid API key) to identify dishes / power the
    chat coach. Every nutrition number is then grounded against a bundled
    nutrition DB (anti-fabrication) — the model only names dishes and estimates
    grams.
- **Auth, accounts, per-user data sync, and Web Push** are provided by the
  `../api` Worker; the app talks to it cross-origin with credentials (see
  `src/lib/authApi.ts`, `src/lib/push.ts`).

Local-first storage is still used as the on-device cache (meal metadata in
`localStorage`, meal photos in `IndexedDB`), but — unlike the original MVP —
this app DOES have a backend and account-based auth.

## Features

- **Meals** — log by text and/or photo; photo analysis identifies dishes and
  estimates portions, grounded to real nutrition data (never fabricated).
- **Workouts** — per-exercise sets × reps × weight with a daily-total summary.
- **Chat coach** — a conversational coach (subscription Codex CLI) that never
  fabricates calorie/nutrition numbers.
- **Calendar** — per-day view of meals / workouts / weight / nutrition deltas.
- **Web Push** notifications (via the `api/` Worker).
- **Light/dark theme**, persisted.

## LLM provider

The DEFAULT meal-vision + chat path is the **subscription Codex CLI**
(`functions/_llm/codex.ts`, `functions/_llm/chat.ts`) — it needs **no API key**.
An optional **Anthropic Messages API** provider (`functions/_llm/anthropic.ts`)
is kept as a LEGACY alternative and requires `ANTHROPIC_API_KEY`; it is inert
unless you deliberately wire it up.

## Setup & run

```bash
cd app
npm install

# Dev server (http://localhost:3000)
npm run dev
```

Configure the environment via `.env` (see `.env.example`): at minimum set
`NEXT_PUBLIC_HEALTH_API` (your `api/` Worker origin) and `HEALTH_APP_TOKEN`
(shared secret for the Node server's AI routes).

## Typecheck / build / serve

```bash
npm run typecheck      # tsc --noEmit, zero errors
npm run test           # vitest

# Static export → out/
npm run build

# Compile the server-side handlers (functions/*) → dist/, then run the server
npm run build:all      # next build && tsc -p tsconfig.server.json
npm run serve          # node server/index.mjs  (defaults to PORT 8787)
```

For a Cloudflare Pages deploy, build command `npm run build`, output directory
`out`. The `public/_headers` file adds baseline security headers.

> iOS Web Push requires the app to be **added to the Home Screen** (installed as
> a PWA) before notifications can be enabled.
