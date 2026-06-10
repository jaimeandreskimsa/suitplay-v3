/* Service worker de SuitPlay Pro.
 * Estrategia: app shell en caché (carga instantánea / offline),
 * API siempre por red (auth y créditos nunca se cachean). */
'use strict';

const CACHE = 'suitplay-pro-v1';
const SHELL = [
  '/',
  '/index.html',
  '/engine.js',
  '/worker.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || e.request.method !== 'GET') {
    return; // red directa
  }
  // shell: red primero con respaldo de caché (siempre fresco online, funciona offline)
  e.respondWith(
    fetch(e.request)
      .then(r => {
        const copy = r.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return r;
      })
      .catch(() => caches.match(e.request, {ignoreSearch: url.pathname === '/'}))
  );
});
