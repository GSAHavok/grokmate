/* GrokMate Mobile service worker: keeps the app shell available offline.
   It never touches requests to other sites (AI providers, Gumroad, weather). */
const VERSION = "grokmate-mobile-1.0.0";
const SHELL = [
  "./", "index.html", "app.css", "manifest.webmanifest",
  "js/app.js", "js/config.js", "js/store.js", "js/license.js", "js/llm.js", "js/tools.js", "js/mathx.js", "js/ics.js", "js/voice.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("grokmate-mobile-") && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API calls go straight to the network
  if (req.mode === "navigate") {
    // Network first for the page (fresh after updates), cached copy when offline.
    e.respondWith(fetch(req).then((r) => {
      const copy = r.clone();
      caches.open(VERSION).then((c) => c.put("index.html", copy));
      return r;
    }).catch(() => caches.match("index.html", { ignoreSearch: true })));
    return;
  }
  // Shell files: cache first, refresh in the background.
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => {
    const net = fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return r;
    }).catch(() => hit);
    return hit || net;
  }));
});
