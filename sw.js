'use strict';

const CACHE = 'ana-w-anta-v7';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/app.css',
  './assets/js/questions.js',
  './assets/js/app.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(PRECACHE))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('ana-w-anta-') && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isAppAsset(url) {
  if (url.origin !== self.location.origin) return false;
  return /\/(?:index\.html|manifest\.webmanifest|assets\/(?:css\/app\.css|js\/(?:app|questions)\.js))$/.test(url.pathname)
    || url.pathname.endsWith('/');
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!isAppAsset(url)) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response && response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(event.request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      if (event.request.mode === 'navigate') {
        const shell = await caches.match(new URL('./index.html', self.registration.scope));
        if (shell) return shell;
      }
      return new Response('تعذر تحميل اللعبة دون اتصال.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});
