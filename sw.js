/* MP Models — PWA service worker.
   Deliberately minimal and SAFE with respect to deploys:
   - NETWORK FIRST for everything, so a deploy is picked up exactly like before
     (no stale-app-shell problem — the team's stale-tab pain must never come back).
   - The cache is only an OFFLINE FALLBACK for pages/assets already visited.
   - /api/ is never touched: live data stays live, and offline API calls fail
     loudly instead of showing yesterday's jobs as if they were today's. */
const CACHE = 'mp-shell-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Push = "a new client job request arrived". Pushes carry no payload
   (kept simple + encryption-free) — the note is fixed, the app shows details. */
self.addEventListener('push', e => {
  e.waitUntil(self.registration.showNotification('MP Models', {
    body: '📩 New client job request — open Requests',
    icon: '/images/mp-icon-192.png',
    badge: '/images/mp-icon-192.png',
    tag: 'mp-request',
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) if (w.url.includes('/admin.html') && 'focus' in w) return w.focus();
    return clients.openWindow('/admin.html');
  }));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;          // never cache live data
  e.respondWith(
    fetch(req).then(resp => {
      if (resp.ok) {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return resp;
    }).catch(() => caches.match(req).then(hit => hit || Response.error()))
  );
});
