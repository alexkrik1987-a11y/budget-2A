"use strict";

const CACHE_NAME = "budget-2a-v86-artistic-chalkboard-2";
const INDEX_URL = new URL("./index.html", self.location.href).href;
const SUPABASE_PATH_PREFIX = "/supabase/";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=589",
  "./app.js?v=81",
  "./vendor/supabase.min.js?v=10",
  "./manifest.webmanifest",
  "./images/parent-committee.webp",
  "./images/parents-piggybank-illustration.webp?v=1",
  "./icons/class-2a.svg",
  "./icons/class-2a-maskable.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

function isSupabasePath(pathname) {
  return pathname === "/supabase" || pathname.startsWith(SUPABASE_PATH_PREFIX);
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
    // Для страницы входа всегда сначала используем сеть. Это исключает возврат
    // к старому HTML после публикации новой версии и сохраняет кэш лишь как
    // резервный вариант при полном отсутствии подключения.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(INDEX_URL, copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(INDEX_URL)) || new Response("Нет подключения к интернету", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" }
        }))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const fresh = fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
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
