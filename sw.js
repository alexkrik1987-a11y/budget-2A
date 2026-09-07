"use strict";

const CACHE_NAME = "budget-2a-v87-push-notifications-1";
const ROOT_PATH = new URL("./", self.location.href).pathname;
const INDEX_URL = new URL("./index.html", self.location.href).href;
const INDEX_PATH = new URL(INDEX_URL).pathname;
const SUPABASE_PATH_PREFIX = "/supabase/";
const APP_SHELL = [
  "./index.html",
  "./styles.css?v=601",
  "./app.js?v=85",
  "./vendor/supabase.min.js?v=10",
  "./manifest.webmanifest",
  "./icons/class-2a.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];
const CACHEABLE_URLS = new Set(APP_SHELL.map((path) => new URL(path, self.location.href).href));
const PUSH_EVENT_TYPES = new Set(["schedule", "memo", "announcement"]);
const PUSH_EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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

function boundedPushText(value, maxLength) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || Array.from(normalized).length > maxLength) return null;
  return normalized;
}

function safeNotificationPath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (_) {
    return null;
  }
}

function parsePushPayload(data) {
  if (!data) return null;
  try {
    const payload = data.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const type = PUSH_EVENT_TYPES.has(payload.type) ? payload.type : null;
    const title = boundedPushText(payload.title, 160);
    const body = boundedPushText(payload.body, 500);
    const url = safeNotificationPath(payload.url);
    const eventId = typeof payload.eventId === "string" && PUSH_EVENT_ID_PATTERN.test(payload.eventId)
      ? payload.eventId.toLowerCase()
      : null;
    return type && title && body && url && eventId ? { type, title, body, url, eventId } : null;
  } catch (_) {
    return null;
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    const payload = parsePushPayload(event.data);
    if (!payload) return;
    await self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: `class-notification:${payload.eventId}`,
      renotify: false,
      data: { type: payload.type, eventId: payload.eventId, url: payload.url }
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification?.close();
  event.waitUntil((async () => {
    const requestedPath = safeNotificationPath(event.notification?.data?.url) || "/";
    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const matchingClient = clientList.find((client) => {
      try {
        const url = new URL(client.url);
        return url.origin === self.location.origin && `${url.pathname}${url.search}${url.hash}` === requestedPath;
      } catch (_) {
        return false;
      }
    });
    if (matchingClient?.focus) return matchingClient.focus();
    return self.clients.openWindow ? self.clients.openWindow("/") : undefined;
  })());
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
