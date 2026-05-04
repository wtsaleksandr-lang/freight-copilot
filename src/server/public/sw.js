// Minimal service worker — exists primarily so Chrome shows the
// install prompt in the address bar. We don't cache aggressively
// (the dashboard is a single-user local-only tool, no offline use
// case), but a fetch handler is required for installability.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Pass-through. Network-first, no cache. The browser handles its
  // own HTTP caching layer; we don't need to interpose.
  event.respondWith(fetch(event.request));
});
