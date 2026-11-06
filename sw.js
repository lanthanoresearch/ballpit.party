/* ballpit.party service worker: lets the game install as an app and open without a network.
   Network first (so you always get the newest files), the saved copy is only the fallback. */
const CACHE = 'ballpit-v121';
const FILES = ['/', '/index.html', '/maps.js', '/physics.js', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname === '/stats') return;   // never touch the live connection or stats
  e.respondWith(fetch(r, { cache: 'no-store' }).then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); } return res; }).catch(() => caches.match(r, { ignoreSearch: true }).then(m => m || (r.mode === 'navigate' ? caches.match('/') : Response.error()))));
});
/* notifications: the server pushes them when the app is closed; tapping one opens (or returns to) the game */
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { try { d = { title: e.data.text() }; } catch (y) {} }
  const title = d.title || 'ballpit.party';
  e.waitUntil(self.registration.showNotification(title, { body: d.body || '', tag: d.tag || 'bp', icon: '/icon-192.png', badge: '/icon-192.png', renotify: false, data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
