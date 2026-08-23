"use strict";

const CACHE_NAME = "budget-2a-v86-artistic-chalkboard-4";
const ROOT_PATH = new URL("./", self.location.href).pathname;
const INDEX_URL = new URL("./index.html", self.location.href).href;
const INDEX_PATH = new URL(INDEX_URL).pathname;
const SUPABASE_PATH_PREFIX = "/supabase/";
const APP_SHELL = [
  "./index.html",
  "./styles.css?v=590",
  "./app.js?v=83",
  "./vendor/supabase.min.js?v=10",
  "./manifest.webmanifest",
  "./icons/class-2a.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];
const CACHEABLE_URLS = new Set(APP_SHELL.map((path) => new URL(path, self.location.href).href));

function isSupabasePath(pathname) {
  return pathname === "/supabase" || pathname.startsWith(SUPABASE_PATH_PREFIX);
}

function isCanonicalNavigation(pathname) {
  return pathname === ROOT_PATH || pathname === INDEX_PATH;
}

async function removeSupabaseEntries(cacheName) {
  const cache = await caches.open(cacheName);
  const requests = await cache.keys();
  await Promise.all(
    requests
      .filter((request) => isSupabasePath(new URL(request.url).pathname))
      .map((request) => cache.delete(request))
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => removeSupabaseEntries(CACHE_NAME))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (url.origin === self.location.origin && isSupabasePath(url.pathname)) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    if (!isCanonicalNavigation(url.pathname)) {
      event.respondWith(fetch(request));
      return;
    }

    // Для страницы входа всегда сначала используем сеть. Это исключает возврат
    // к старому HTML после публикации новой версии и сохраняет кэш лишь как
    // резервный вариант при полном отсутствии подключения.
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          try {
            const contentType = response.headers.get("content-type") || "";
            if (response.ok && contentType.includes("text/html")) {
              const copy = response.clone();
              const cache = await caches.open(CACHE_NAME);
              await cache.put(INDEX_URL, copy);
            }
          } catch (error) {
            console.warn("Service Worker could not update the navigation cache:", error);
          }
          return response;
        }, async () => {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match(INDEX_URL)) || new Response("Нет подключения к интернету", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" }
          });
        })
    );
    return;
  }

  if (!CACHEABLE_URLS.has(url.href)) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const fresh = fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          cache.put(request, copy);
        }
        return response;
      }).catch(() => cached || new Response("Нет подключения к интернету", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" }
      }));
      return cached || fresh;
    })
  );
});
