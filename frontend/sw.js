// Service Worker for AIML Seat Allotment PWA
// Minimal SW — just enough to enable the install prompt
// Does NOT cache anything (all data is live from server)

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener("fetch", (event) => {
  // Pass through all requests to the network (no offline caching)
  return;
});
