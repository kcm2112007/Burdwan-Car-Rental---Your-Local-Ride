// Minimal service worker: caches the app shell only, so the site is
// installable. It does NOT cache or fake booking data — booking, tracking
// and admin actions all require a live connection to the storage layer,
// and the offline page makes that explicit instead of pretending to work.
const CACHE = 'routeline-shell-v1';
const SHELL = ['./index.html', './app.js', './manifest.json', './offline.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(() =>
      caches.match(e.request).then((r) => r || caches.match('./offline.html'))
    )
  );
});
