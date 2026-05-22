// AIML Seat Allotment — Service Worker
// MINIMAL pass-through SW. Required for PWA installability (browsers check
// that a service worker with a fetch handler is registered) but we deliberately
// do NOT cache anything in development — every request goes straight to the
// network so code changes take effect on reload without manual SW unregister.

const CACHE = "aiml-shell-v5";

self.addEventListener("install", (event) => {
  // No precaching — skip waiting so any older SW is replaced immediately.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Delete any caches from previous SW versions.
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  // Pass-through. Browsers still consider the SW "controlling" the page
  // (which makes the app installable) but we never serve from cache.
  // event.respondWith(fetch(event.request)) is intentionally NOT called —
  // an unhandled fetch event lets the browser do its normal request, which
  // is the most reliable behavior during active development.
});
