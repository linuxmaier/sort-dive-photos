const CACHE_NAME = 'sdp-v7';
const SHARES_CACHE = 'sdp-shares';

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './config.js',
  './src/auth.js',
  './src/db.js',
  './src/ocr.js',
  './src/sheets.js',
  './src/sync.js',
  './src/ui.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== SHARES_CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Handle Web Share Target POST
  if (url.pathname.endsWith('/share-target') && event.request.method === 'POST') {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  // Cache-first for same-origin assets, network-first for everything else
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
  }
});

async function handleShareTarget(request) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return Response.redirect('./?error=share', 303);
  }

  const files = formData.getAll('media');
  if (!files.length) return Response.redirect('./', 303);

  const cache = await caches.open(SHARES_CACHE);
  const index = [];

  for (const file of files) {
    if (!(file instanceof File)) continue;
    const cacheKey = `/sdp-share/${encodeURIComponent(file.name)}`;
    await cache.put(cacheKey, new Response(file, {
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': file.name,
      },
    }));
    index.push({ name: file.name, type: file.type });
  }

  await cache.put('/sdp-share-index', new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json' },
  }));

  return Response.redirect('./?shared=true', 303);
}
