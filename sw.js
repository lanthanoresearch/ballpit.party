/* ballpit.party service worker: lets the game install as an app and open without a network.
   Network first (so you always get the newest files), the saved copy is only the fallback. */
const CACHE = 'ballpit-v206';
const FILES = ['/', '/index.html', '/maps.js', '/physics.js', '/icon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES).catch(() => {})).then(() => self.skipWaiting())); });
const META = 'ballpit-meta';   // (small notes kept across updates: whether the game is installed as an app on this device)
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== META).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
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
/* Tapping a notification opens the game as the app on your home screen when it is installed there, and in the browser only when it is not.
   The game tells this worker when it is running as the app, and that is remembered (so it is known even when the app is closed). */
const appWins = new Set();
const markApp = () => caches.open(META).then(c => c.put('/__app', new Response(String(Date.now())))).catch(() => {});
const appKnown = () => caches.open(META).then(c => c.match('/__app')).then(r => r ? r.text() : '0').then(t => Date.now() - (+t || 0) < 180 * 864e5).catch(() => false);
const isAppWin = c => appWins.has(c.id) || /[?&]app=1(&|$)/.test(c.url);
const asApp = u => { try { const x = new URL(u, self.location.origin); x.searchParams.set('app', '1'); return x.pathname + x.search + x.hash; } catch (e) { return '/?app=1'; } };
self.addEventListener('message', e => {
  const d = e.data || {}, src = e.source;
  if (d.t === 'mode' && src) { if (d.app) { appWins.add(src.id); e.waitUntil(markApp()); } else appWins.delete(src.id); }
  else if (d.t === 'installed') e.waitUntil(markApp());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const app = cs.find(c => isAppWin(c) && 'focus' in c);
    if (app) return app.focus();   // the app is open: back to it
    return appKnown().then(inst => {
      if (inst) return self.clients.openWindow(asApp(url));   // installed: open the app (phones open links of an installed app in the app)
      const tab = cs.find(c => 'focus' in c); if (tab) return tab.focus();   // no app: the game already open in the browser
      return self.clients.openWindow(url);
    });
  }));
});
