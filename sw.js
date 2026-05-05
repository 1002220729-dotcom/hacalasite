const CACHE_NAME = 'portal-v6';

const PRECACHE_URLS = [
  '/hacalasite/data_manager.js',
  '/hacalasite/manifest.json',
];

const SUPABASE_PATTERN = /https:\/\/.*\.supabase\.co\//;
const API_PATTERN = /https:\/\/hacala-api\.[^/]+\.workers\.dev\//;

const PASSTHROUGH = [
  '/view.html',
  '/app_workplan/',
  '/app_mtss/',
  '/app_yesodi/',
  '/app_independent/',
];

const NETWORK_ONLY = [
  '/hacalasite/',
  '/hacalasite/index.html',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(
        PRECACHE_URLS.map(url =>
          cache.add(url).catch(err =>
            console.warn(`[SW] skip: ${url}`, err.message)
          )
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = request.url;
  const path = new URL(url).pathname;

  if (request.method !== 'GET') return;

  if (NETWORK_ONLY.some(p => path === p || path.endsWith('/index.html'))) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  if (PASSTHROUGH.some(p => path === p || path.startsWith(p))) {
    return;
  }

  if (SUPABASE_PATTERN.test(url) || API_PATTERN.test(url)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    const fallback = await caches.match('/hacalasite/index.html');
    if (fallback) return fallback;
    return new Response(
      `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8">` +
      `<title>לא מחובר</title></head><body style="font-family:sans-serif;` +
      `text-align:center;padding:60px;color:#c0392b;">` +
      `<h2>⚠️ אין חיבור לאינטרנט</h2>` +
      `<p>הדף לא נטען מהמטמון. אנא התחבר ונסה שוב.</p>` +
      `</body></html>`,
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
