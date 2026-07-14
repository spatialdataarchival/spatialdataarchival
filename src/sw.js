/* Service worker — offline support with modern caching strategies.
   - App shell precached on install.
   - HTML navigations: network-first (fresh content) with cache + offline fallback.
   - Static assets: stale-while-revalidate (fast, self-healing).
*/
const VERSION = "v2";
const PRECACHE = `sda-precache-${VERSION}`;
const RUNTIME = `sda-runtime-${VERSION}`;

const APP_SHELL = [
  "/",
  "/offline/",
  "/assets/css/styles.css",
  "/assets/css/prism-light.css",
  "/assets/js/app.js",
  "/assets/img/logo.svg",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(PRECACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== PRECACHE && k !== RUNTIME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // HTML navigations → network-first, fall back to cache, then offline page.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || caches.match("/offline/"))
        )
    );
    return;
  }

  // Static assets → stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(RUNTIME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
