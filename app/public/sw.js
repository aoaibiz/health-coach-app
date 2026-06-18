// Web Push service worker — dependency-free vanilla JS.
//
// Served from the ORIGIN ROOT (/sw.js) so its scope (`/`) covers the whole app.
// (public/ → out/ root in the Next.js static export does this.)
//
// Responsibilities:
//   1. push           → show a LINE-style notification from the push payload.
//   2. notificationclick → focus an existing tab at the target url, else open it.
//
// The payload is best-effort JSON ({title, body, url, icon, tag}); we stay
// defensive so a non-JSON / text payload still surfaces *something* rather than
// throwing inside the push event (which would silently drop the notification).

// Take control as soon as a new SW version is installed/activated, instead of
// waiting for every tab to close. Without this, an UPDATED service worker stays
// "waiting" and the previous (possibly handler-less) worker keeps controlling —
// on an installed iOS PWA that shows up as "push accepted by Apple but no
// notification appears". skipWaiting + clients.claim make the push handler live
// immediately after the app is reopened once.
self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (_e) {
      // Not JSON — fall back to the raw text as the body.
      try {
        data = { body: event.data.text() };
      } catch (_e2) {
        data = {};
      }
    }
  }

  const title = (data && data.title) || "Health";
  const body = (data && data.body) || "新しいお知らせがあります";
  const icon = (data && data.icon) || "/icon-192.png";
  const tag = data && data.tag ? data.tag : undefined;
  const url = (data && data.url) || "/";

  const options = {
    body,
    icon,
    badge: "/icon-192.png",
    data: { url },
  };
  if (tag) options.tag = tag;

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Focus an already-open tab on the same origin (prefer one at the url).
        for (const client of clientList) {
          if ("focus" in client) {
            // Match by path so we re-use a tab even if it's on another route.
            try {
              const u = new URL(target, self.location.origin);
              if (client.url === u.href && "focus" in client) {
                return client.focus();
              }
            } catch (_e) {
              /* ignore bad url, fall through */
            }
          }
        }
        // No matching tab → focus any open client and navigate, else open new.
        for (const client of clientList) {
          if ("focus" in client && "navigate" in client) {
            return client.focus().then((c) => (c && c.navigate ? c.navigate(target) : c));
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(target);
        }
        return undefined;
      }),
  );
});
