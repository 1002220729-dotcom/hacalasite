// ═══════════════════════════════════════════════════════════════════
// SERVICE WORKER — פורטל הדרכה v3
// ═══════════════════════════════════════════════════════════════════

const CACHE_NAME = 'portal-v3';

const PRECACHE_URLS = [
    '/',
    '/index.html',
    '/data_manager.js',
    '/manifest.json',
];

const SUPABASE_PATTERN = /https:\/\/.*\.supabase\.co\//;

// קבצים שעוברים ישירות לרשת — ללא מגע של ה-SW
const PASSTHROUGH = [
    '/view.html',
    '/app_workplan/',
    '/app_mtss/',
    '/app_yesodi/',
    '/app_independent/',
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
    const url  = request.url;
    const path = new URL(url).pathname;

    if (request.method !== 'GET') return;

    // Passthrough — תן לדפדפן לטפל ישירות, ללא התערבות SW
    if (PASSTHROUGH.some(p => path === p || path.startsWith(p))) {
        return; // לא קורא ל-event.respondWith — הדפדפן מטפל לבד
    }

    // Supabase — Network-First
    if (SUPABASE_PATTERN.test(url)) {
        event.respondWith(networkFirst(request));
        return;
    }

    // שאר הקבצים — Cache-First
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
        const fallback = await caches.match('/index.html');
        return fallback || new Response('offline', { status: 503 });
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
