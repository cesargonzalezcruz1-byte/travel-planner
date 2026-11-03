// Offline support: cache the app shell + Firebase SDK. Trip data is cached by Firestore itself.
const CACHE = "travel-planner-v96";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./data.js", "./firebase-config.js", "./map.js", "./album.js", "./checkin-core.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-maskable-512.png", "./icons/apple-touch-icon.png", "./icons/logo.svg", "./icons/favicon-64.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  const sameOrigin = url.origin === location.origin;
  const sdk = url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
  if (!sameOrigin && !sdk) return; // Firestore/Auth/Storage traffic goes straight to the network
  // network first (so updates show up), fall back to cache when offline
  e.respondWith(fetch(e.request, sameOrigin ? { cache: "no-cache" } : {}).then((res) => {   // no-cache: always check GitHub for a newer file
    const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html"))));
});

// Phone notifications (data messages from the check-in function via Firebase Cloud Messaging)
self.addEventListener("push", (e) => {
  let d = {};
  try { const j = e.data ? e.data.json() : {}; d = j.data || j; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  const label = /^Check-in/.test(d.title || "") ? "Check In Now" : "Directions";
  e.waitUntil(self.registration.showNotification(d.title || "Travel Planner", {
    body: d.body || "", icon: "icons/icon-192.png", badge: "icons/favicon-64.png", tag: d.tag || undefined,
    data: { url: d.url || "", app: d.app || "./" }, actions: d.url ? [{ action: "link", title: label }] : [],
  }));
});
// Tapping a notification opens the app at the right day and section (reusing an open app window);
// the button (where the phone shows one) goes straight to the airline check-in page / directions.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const { url, app } = e.notification.data || {};
  if (e.action === "link" && url) { e.waitUntil(self.clients.openWindow(url)); return; }
  const target = new URL(app || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins.find((c) => c.url.startsWith(self.registration.scope));
    if (w) { try { await w.navigate(target); return w.focus(); } catch (err) { /* fall through */ } }
    return self.clients.openWindow(target);
  })());
});
