/*
 * The /app service worker (DECISIONS 34.2).
 *
 * WHY THIS FILE EXISTS: Chrome on Android requires a service worker with a
 * fetch handler before it will offer "Add to home screen" as a full
 * standalone install. That is its entire job here.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: cache. Not app pages, not CSS, not the
 * attendance panel, not anything. An attendance decision must never be made
 * on a stale page -- a supervisor standing at a gate needs the CURRENT state,
 * and a "checked in" screen served from a cache would be a lie. Every request
 * passes straight through to the network, exactly as it would without the
 * worker. If the network is down, the request fails like any other and the
 * browser shows its own offline page.
 */
self.addEventListener('install', function (event) {
  // No precaching: there is nothing this worker is allowed to keep.
  self.skipWaiting()
})

self.addEventListener('activate', function (event) {
  // Clear anything an earlier version might have cached, and take control
  // immediately so the fetch handler is authoritative from the first load.
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) { return caches.delete(name) }))
    }).then(function () { return self.clients.claim() })
  )
})

self.addEventListener('fetch', function (event) {
  // Network-only, for every request this worker sees. The handler must exist
  // for installability; what it does is pass through untouched.
  event.respondWith(fetch(event.request))
})
