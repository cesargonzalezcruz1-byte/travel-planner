// Offline support: cache the app shell + Firebase SDK. Trip data is cached by Firestore itself.
const CACHE = "travel-planner-v53";
const SHELL = ["./", "./index.html", "./styles.css", "./app.js", "./data.js", "./firebase-config.js", "./map.js", "./album.js", "./manifest.webmanifest",
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
