// Service worker: keeps the app usable through a dropped connection.
//
// What it keeps, and why:
//  - The app's own scripts and styles (/_next/static/*), the icon and the barcode decoder (/vendor/*),
//    cache-first: the first two are versioned by name and the decoder by a ?v= query, so a cached copy is
//    never stale. This is what lets a page that is already open, or reopened, run its code (and the phone
//    camera scanner) with no network.
//  - The receive pages (/distribution/receive/*), network-first, so a receipt that is open can be reloaded
//    offline and scanning carries on. They are the only signed-in pages kept.
//  - A plain offline page for everything else that cannot be reached.
// What it never keeps: API calls, data requests, or any other signed-in page. The kept receive pages are
// deleted whenever the login page loads, so the next person to sign in on a shared PC does not inherit them.
//
// Scans themselves are not handled here: they are saved in IndexedDB by the page (offline/queue.ts) and
// sent by offline/sync.ts.

const VERSION = "v1";
const STATIC_CACHE = `ct-static-${VERSION}`;
const PAGES_CACHE = `ct-pages-${VERSION}`;
const PRECACHE = ["/offline.html", "/icon.svg"];
const KEPT_PAGE_PREFIX = "/distribution/receive/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== STATIC_CACHE && key !== PAGES_CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: STATIC_CACHE });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(STATIC_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

async function navigate(request, url) {
  try {
    const response = await fetch(request);
    if (url.pathname === "/login") await caches.delete(PAGES_CACHE);
    if (response.ok && url.pathname.startsWith(KEPT_PAGE_PREFIX)) {
      const cache = await caches.open(PAGES_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const kept = await caches.match(request, { cacheName: PAGES_CACHE });
    if (kept) return kept;
    const fallback = await caches.match("/offline.html", { cacheName: STATIC_CACHE });
    return fallback || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/vendor/") ||
    PRECACHE.includes(url.pathname)
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(navigate(request, url));
  }
});
