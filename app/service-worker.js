// Cheap Chess service worker — offline-first PWA caching.
// Cache-first for the app shell (index, styles, scripts, icons, manifest);
// network-first for navigations with a cached fallback.

const VERSION = 'cheap-chess-v1';
const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './src/main.js',
  './src/board.js',
  './src/eval.js',
  './src/search.js',
  './src/learner.js',
  './src/game.js',
  './src/san.js',
  './src/uci.js',
  './src/chess-board.js',
  './src/chess-worker.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    // network-first for page loads, cache fallback for offline
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((cache) => cache.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // cache-first for everything else
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok && req.url.startsWith(self.location.origin)) {
        const copy = res.clone();
        caches.open(VERSION).then((cache) => cache.put(req, copy));
      }
      return res;
    }))
  );
});
