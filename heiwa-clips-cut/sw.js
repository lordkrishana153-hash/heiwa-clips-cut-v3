/* Stage 9 Service Worker: versioned app-shell precaching, offline fallback, controlled updates, and Mediabunny CDN caching. */

const CACHE_VERSION = 'v9.0.0';
const APP_CACHE = `heiwa-clips-cut-shell-${CACHE_VERSION}`;
const VENDOR_CACHE = `heiwa-clips-cut-vendor-${CACHE_VERSION}`;
const MEDIABUNNY_CDN_URL = 'https://cdn.jsdelivr.net/npm/mediabunny@1.62.0/+esm';

const APP_SHELL_URLS = [
  './',
  './index.html',
  './offline.html',
  './manifest.webmanifest',
  './css/app.css',
  './css/layout.css',
  './css/components.css',
  './icons/favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './js/main.js',
  './js/store.js',
  './js/capabilities.js',
  './js/errors.js',
  './js/time.js',
  './js/media-input.js',
  './js/metadata.js',
  './js/preview.js',
  './js/timeline.js',
  './js/clips.js',
  './js/crop.js',
  './js/export-queue.js',
  './js/export-worker.js',
  './js/download.js',
  './js/zip.js',
  './js/storage.js',
  './js/pwa.js',
  './js/shortcuts.js',
  './js/ui/layout.js',
  './js/ui/dialogs.js',
  './js/ui/toasts.js'
];

function isPinnedMediabunnyRequest(url) {
  return (
    url.origin === 'https://cdn.jsdelivr.net' &&
    url.pathname.includes('/npm/mediabunny@1.62.0')
  );
}

async function precacheAppShell() {
  const shellCache = await caches.open(APP_CACHE);
  await shellCache.addAll(APP_SHELL_URLS);

  /* Best-effort warm cache of Mediabunny ESM without failing install when offline or behind a blocked CDN. */
  try {
    const vendorCache = await caches.open(VENDOR_CACHE);
    const response = await fetch(MEDIABUNNY_CDN_URL, { mode: 'cors', credentials: 'omit' });
    if (response && response.ok) {
      await vendorCache.put(MEDIABUNNY_CDN_URL, response.clone());
    }
  } catch {
    /* Ignore CDN warm-cache failures; runtime fetch handler will cache it on first online use. */
  }
}

async function cleanupOldCaches() {
  const names = await caches.keys();
  const valid = new Set([APP_CACHE, VENDOR_CACHE]);
  const removals = names
    .filter((name) => name.startsWith('heiwa-clips-cut-') && !valid.has(name))
    .map((name) => caches.delete(name));
  await Promise.all(removals);
}

async function handleNavigationRequest(request) {
  const shellCache = await caches.open(APP_CACHE);
  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
      shellCache.put('./index.html', networkResponse.clone()).catch(() => {});
    }
    return networkResponse;
  } catch {
    const cachedIndex = await shellCache.match('./index.html');
    if (cachedIndex) {
      return cachedIndex;
    }
    const cachedOffline = await shellCache.match('./offline.html');
    if (cachedOffline) {
      return cachedOffline;
    }
    return new Response('Offline — Heiwa Clips Cut could not load the cached app shell.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

async function handleSameOriginAsset(request) {
  const shellCache = await caches.open(APP_CACHE);
  const cached = await shellCache.match(request);

  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok && response.type === 'basic') {
        shellCache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    return cached;
  }
  const fresh = await networkPromise;
  if (fresh) {
    return fresh;
  }
  return new Response('', { status: 504, statusText: 'Offline asset unavailable' });
}

async function handlePinnedVendorRequest(request) {
  const vendorCache = await caches.open(VENDOR_CACHE);
  const cached = await vendorCache.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (response && response.ok) {
    vendorCache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheAppShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    cleanupOldCaches().then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }
  if (request.headers && request.headers.has('range')) {
    return;
  }

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigationRequest(request));
    return;
  }

  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/sw.js')) {
      return;
    }
    event.respondWith(handleSameOriginAsset(request));
    return;
  }

  if (isPinnedMediabunnyRequest(url)) {
    event.respondWith(handlePinnedVendorRequest(request));
  }
});
