// Service worker: cache-first app shell, live network for Firebase traffic.
const CACHE = 'diner-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'game.js', 'firebase.js', 'manifest.json', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const r = e.request, u = r.url;
  // Never intercept auth / realtime database traffic.
  if (r.method !== 'GET' || /googleapis\.com|firebaseio\.com|identitytoolkit/.test(u)) return;
  if (u.startsWith(self.location.origin)) {   // own files: network first so updates arrive, cache when offline
    e.respondWith(fetch(r).then(res => { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)); return res; }).catch(() => caches.match(r).then(h => h || caches.match('index.html'))));
    return;
  }
  e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(res => {
    // Also cache the Firebase SDK modules (gstatic) the first time they load.
    if (res.ok && (u.startsWith(self.location.origin) || /gstatic\.com|jsdelivr/.test(u))) {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy));
    }
    return res;
  }).catch(() => caches.match('index.html'))));
});
