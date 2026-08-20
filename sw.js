"use strict";

const CACHE_NAME = "budget-2a-shell-v66";
const INDEX_URL = new URL("./index.html", self.location.href).href;
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css?v=572",
  "./app.js?v=52",
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

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
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
