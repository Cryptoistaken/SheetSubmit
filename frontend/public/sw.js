const CACHE_NAME = "sheet-submit-v1";
const APP_SHELL_URLS = ["/config.js", "/favicon-light.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(APP_SHELL_URLS);
      try {
        const rootRes = await fetch("/", { cache: "reload" });
        if (rootRes.ok) {
          await cache.put("/", rootRes.clone());
          const html = await rootRes.text();
          const urls = [];
          const srcRe = /<script[^>]+src=["']([^"']+)["']/gi;
          const hrefRe = /<link[^>]+href=["']([^"']+)["']/gi;
          let m;
          while ((m = srcRe.exec(html))) urls.push(m[1]);
          while ((m = hrefRe.exec(html))) urls.push(m[1]);
          for (const raw of urls) {
            const u = new URL(raw, self.location.origin);
            if (u.origin !== self.location.origin) continue;
            if (u.pathname.startsWith("/assets/") || u.pathname.startsWith("/favicon")) {
              const res = await fetch(u.href, { cache: "reload" });
              if (res.ok) await cache.put(u.href, res);
            }
          }
        }
      } catch {}
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API goes through the same-origin proxy — never serve/cache auth or data GETs.
  if (url.pathname.startsWith("/api/") || url.pathname === "/webhook/tg") return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/"));
    return;
  }

  if (url.pathname === "/config.js") {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/favicon")) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(networkFirst(request));
});

async function networkFirst(request, cacheKey) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(request);
    if (res.ok) await cache.put(cacheKey || request, res.clone());
    return res;
  } catch {
    const cached = await cache.match(cacheKey || request);
    if (cached) return cached;
    return new Response("Offline", { status: 404, statusText: "Not Found" });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) await cache.put(request, res.clone());
    return res;
  } catch {
    return new Response("Offline", { status: 404, statusText: "Not Found" });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || network;
}