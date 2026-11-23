/* ballpit.party service worker: lets the game install as an app and open without a network.
   Network first (so you always get the newest files), the saved copy is only the fallback. */
const CACHE = 'ballpit-v217';
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
   A window counts as the app only when the game itself says so (it checks how it was opened). The address is never trusted for that: a browser tab can carry
   the app's address too, and treating it as the app is what kept sending taps to the browser.
   Installed: the phone is asked to open the app's address. Android hands an address of an installed app to the app (and just brings it to the front when it
   is already open), so a browser tab never takes over. The game tells this worker when it runs as the app, or when the browser says it is installed, and
   that is remembered (so it is known even when the app is closed). */
const appWins = new Set();
const markApp = () => caches.open(META).then(c => c.put('/__app', new Response(String(Date.now())))).catch(() => {});
const appKnown = () => caches.open(META).then(c => c.match('/__app')).then(r => r ? r.text() : '0').then(t => Date.now() - (+t || 0) < 180 * 864e5).catch(() => false);
const asApp = u => { try { const x = new URL(u, self.location.origin); if (x.origin !== self.location.origin) return '/?app=1'; x.searchParams.set('app', '1'); return x.pathname + x.search + x.hash; } catch (e) { return '/?app=1'; } };
const sameSite = u => { try { const x = new URL(u, self.location.origin); return x.origin === self.location.origin ? x.pathname + x.search + x.hash : '/'; } catch (e) { return '/'; } };   // (only ever this game's own pages)
self.addEventListener('message', e => {
  const d = e.data || {}, src = e.source;
  if (d.t === 'mode' && src) { if (d.app) { appWins.add(src.id); e.waitUntil(markApp()); } else appWins.delete(src.id); }
  else if (d.t === 'installed') e.waitUntil(markApp());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    let cs = []; try { cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true }); } catch (x) {}
    const app = cs.find(c => appWins.has(c.id) && 'focus' in c);
    if (app) { try { await app.focus(); return; } catch (x) {} }   // the app is open, and it told us so: back to it
    if (await appKnown()) { try { await self.clients.openWindow(asApp(url)); return; } catch (x) {} }   // installed: open the app
    const tab = cs.find(c => 'focus' in c); if (tab) { try { await tab.focus(); return; } catch (x) {} }   // not installed: the game already open in the browser
    try { await self.clients.openWindow(sameSite(url)); } catch (x) {}
  })());
});
