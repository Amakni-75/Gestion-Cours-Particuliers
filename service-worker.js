const CACHE_NAME = 'cours-particuliers-pwa-v1';
const APP_SHELL = [
  new URL('./index.html', self.registration.scope),
  new URL('./manifest.webmanifest', self.registration.scope),
  new URL('./icons/app-icon-192.png', self.registration.scope),
  new URL('./icons/app-icon-512.png', self.registration.scope),
  new URL('./icons/app-icon.svg', self.registration.scope)
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(key => key.startsWith('cours-particuliers-pwa-') && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(new URL('./index.html', self.registration.scope), response.clone());
        }
        return response;
      } catch (error) {
        const cached = await caches.match(new URL('./index.html', self.registration.scope));
        if (cached) return cached;
        throw error;
      }
    })());
  }
});
