// Web Push subscription + test-send API — the LINE-style push notification
// foundation. Mirrors routes/data.ts: the router enforces a valid session
// (and CSRF on state-changing methods) BEFORE these run, and passes the resolved
// userId, so a user can only ever touch THEIR OWN subscriptions (the user_id is
// server-derived from the session, never from the request body).
//
// Endpoints:
//   GET  /api/push/public-key  — public; returns the VAPID applicationServerKey
//   POST /api/push/subscribe   — authed+CSRF; UPSERT the browser's subscription
//   POST /api/push/unsubscribe — authed+CSRF; delete the user's subscription
//   POST /api/push/test        — authed+CSRF; send a test push to all of the
//                                user's subscriptions, reaping GONE ones.

import type { Env } from "../lib/env";
import { json, errorJson } from "../lib/http";
import {
  validatePushSubscription,
  validateUnsubscribe,
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
} from "../lib/validate";
import {
  countPushSubscriptions,
  getPushEndpointOwner,
  upsertPushSubscription,
  getPushSubscriptionsForUser,
  deletePushSubscription,
} from "../lib/db";
import { sendPush } from "../lib/webpush";

// ---- GET /api/push/public-key ----------------------------------------------
// Public: the VAPID public key is the browser's applicationServerKey and ships
// to every client anyway. No auth, no CSRF.
export function handleGetPublicKey(env: Env): Response {
  return json({ publicKey: env.VAPID_PUBLIC_KEY });
}

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// ---- POST /api/push/subscribe ----------------------------------------------
export async function handleSubscribe(req: Request, env: Env, userId: string): Promise<Response> {
  const body = await readBody(req);
  const valid = validatePushSubscription(body);
  if (!valid.ok) return errorJson("invalid_subscription", valid.reason, 400);

  // Resolve who (if anyone) currently owns this endpoint. An endpoint owned by a
  // DIFFERENT user must NEVER be reassigned — that would silently break the
  // victim's notifications. So:
  //   * owned by someone else → 409, leave their row untouched.
  //   * owned by THIS user    → in-place key refresh (re-subscribe), always ok.
  //   * unowned (new)         → insert, subject to the per-user cap.
  const owner = await getPushEndpointOwner(env, valid.value.endpoint);
  if (owner !== null && owner !== userId) {
    return errorJson("endpoint_conflict", "この通知先は使用できません", 409);
  }
  if (owner === null) {
    const count = await countPushSubscriptions(env, userId);
    if (count >= MAX_PUSH_SUBSCRIPTIONS_PER_USER) {
      return errorJson("too_many_subscriptions", "登録できる端末数の上限に達しました", 409);
    }
  }

  await upsertPushSubscription(env, {
    id: crypto.randomUUID(),
    userId,
    endpoint: valid.value.endpoint,
    p256dh: valid.value.p256dh,
    auth: valid.value.auth,
  });
  return json({ ok: true });
}

// ---- POST /api/push/unsubscribe --------------------------------------------
export async function handleUnsubscribe(req: Request, env: Env, userId: string): Promise<Response> {
  const body = await readBody(req);
  const valid = validateUnsubscribe(body);
  if (!valid.ok) return errorJson("invalid_request", valid.reason, 400);

  await deletePushSubscription(env, userId, valid.endpoint);
  return json({ ok: true });
}

// ---- POST /api/push/test ----------------------------------------------------
// Send a test notification to every subscription the user has, reaping any that
// the push service reports GONE (404/410). This is the end-to-end proof of the
// pipe once a real browser has subscribed.
export async function handleTest(_req: Request, env: Env, userId: string): Promise<Response> {
  const subs = await getPushSubscriptionsForUser(env, userId);

  const payload = {
    title: "通知テスト",
    body: "コーチからの通知が届くか確認しています📣",
    url: "/",
  };

  let sent = 0;
  let gone = 0;
  for (const s of subs) {
    let result: { gone: boolean };
    try {
      result = await sendPush(
        { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth },
        payload,
        env,
      );
    } catch {
      // A malformed stored key or a network error: don't fail the whole request,
      // and don't delete on an ambiguous error (only delete on an explicit GONE).
      continue;
    }
    if (result.gone) {
      await deletePushSubscription(env, userId, s.endpoint);
      gone++;
    } else {
      sent++;
    }
  }

  return json({ sent, gone });
}
