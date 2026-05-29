const CACHE_NAME = 'income-tracker-v1';
const ASSETS = [
  '/pwa/',
  '/static/pwa/index.html',
  '/static/pwa/manifest.json',
  '/static/pwa/css/app.css',
  '/static/pwa/js/db.js',
  '/static/pwa/js/sync.js',
  '/static/pwa/js/app.js',
  '/static/pwa/icons/icon-192.png',
  '/static/pwa/icons/icon-512.png',
  'https://unpkg.com/dexie@3.2.6/dist/dexie.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetched = fetch(e.request).then((resp) => {
        if (resp.ok && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
        }
        return resp;
      });
      return cached || fetched;
    })
  );
});

// 后台同步：网络恢复时触发
self.addEventListener('sync', (e) => {
  if (e.tag === 'sync-changes') {
    e.waitUntil(syncInBackground());
  }
});

async function syncInBackground() {
  try {
    const clients = await self.clients.matchAll({ type: 'window' });
    if (clients.length > 0) {
      clients[0].postMessage({ action: 'background-sync' });
    }
  } catch (_) {}
}
