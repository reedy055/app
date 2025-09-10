/* ==========================================================================
   Life RPG — Service Worker (sw.js)
   Cache-first app shell + network-first for navigation with offline fallback.
   ========================================================================== */

const SW_VERSION = '1.0.0';
const CACHE_NAME = `life-rpg-cache-v${SW_VERSION}`;

// App shell to precache (must match actual filenames in repo)
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png'
];

// --- Install: pre-cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// --- Activate: clean old caches immediately
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith('life-rpg-cache-') && k !== CACHE_NAME)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// --- Fetch strategy
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET
  if (req.method !== 'GET') return;

  // Navigation requests (HTML) → network-first with cached fallback to index.html
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          // Optionally: update cache with fresh index.html
          const cache = await caches.open(CACHE_NAME);
          cache.put('./index.html', fresh.clone());
          return fresh;
        } catch (err) {
          const cache = await caches.open(CACHE_NAME);
          const cached = await cache.match('./index.html');
          return cached || new Response('<h1>Offline</h1>', { headers: { 'Content-Type': 'text/html' } });
        }
      })()
    );
    return;
  }

  // For same-origin static assets → cache-first
  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) return cached;
        return fetch(req).then((res) => {
          // Cache successful responses
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
          }
          return res;
        }).catch(() => {
          // Optional: fallback images/icons could be returned here if needed
          return caches.match('./index.html');
        });
      })
    );
    return;
  }

  // Cross-origin: try network, fall back to cache if available (stale-while-revalidate lite)
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});

// --- Optional: allow page to trigger immediate activation after update
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/* End of sw.js */
