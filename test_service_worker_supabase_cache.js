"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const ORIGIN = "https://budget.example";
const SW_URL = `${ORIGIN}/sw.js?v=86`;
const OLD_CACHE_NAME = "budget-2a-v86-artistic-chalkboard-4";
const EXPECTED_CACHE_NAME = "budget-2a-v86-artistic-chalkboard-6";
const EXPECTED_APP_SHELL = [
  "./index.html",
  "./styles.css?v=592",
  "./app.js?v=83",
  "./vendor/supabase.min.js?v=10",
  "./manifest.webmanifest",
  "./icons/class-2a.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

class FakeHeaders {
  constructor(values = {}) {
    this.values = new Map(
      Object.entries(values).map(([name, value]) => [name.toLowerCase(), String(value)])
    );
  }

  get(name) {
    return this.values.get(String(name).toLowerCase()) || null;
  }
}

class FakeResponse {
  constructor(body, options = {}) {
    this.body = body;
    this.status = options.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new FakeHeaders(options.headers);
  }

  clone() {
    return new FakeResponse(this.body, {
      status: this.status,
      headers: Object.fromEntries(this.headers.values)
    });
  }
}

function makeRequest(path, options = {}) {
  return {
    url: new URL(path, ORIGIN).href,
    method: options.method || "GET",
    mode: options.mode || "cors"
  };
}

function requestUrl(request) {
  return new URL(typeof request === "string" ? request : request.url, ORIGIN).href;
}

class FakeCache {
  constructor(name, operations) {
    this.name = name;
    this.operations = operations;
    this.entries = new Map();
    this.putFailures = new Set();
  }

  async addAll(paths) {
    this.operations.push({ type: "addAll", cache: this.name, paths: [...paths] });
    for (const path of paths) {
      const url = new URL(path, SW_URL).href;
      this.entries.set(url, new FakeResponse(`cached:${url}`));
    }
  }

  async match(request) {
    const url = requestUrl(request);
    this.operations.push({ type: "match", cache: this.name, url });
    return this.entries.get(url);
  }

  async put(request, response) {
    const url = requestUrl(request);
    this.operations.push({ type: "put", cache: this.name, url });
    if (this.putFailures.has(url)) throw new Error(`cache put failed: ${url}`);
    this.entries.set(url, response);
  }

  async keys() {
    this.operations.push({ type: "keys", cache: this.name });
    return Array.from(this.entries.keys(), (url) => makeRequest(url));
  }

  async delete(request) {
    const url = requestUrl(request);
    this.operations.push({ type: "delete-entry", cache: this.name, url });
    return this.entries.delete(url);
  }
}

async function main() {
  const listeners = new Map();
  const operations = [];
  const cacheStores = new Map();
  const networkRequests = [];
  const networkResponses = new Map();
  const networkFailures = new Set();
  const cacheOpenFailures = new Set();
  let claimed = false;

  const caches = {
    async open(name) {
      operations.push({ type: "open", cache: name });
      if (cacheOpenFailures.has(name)) throw new Error(`cache open failed: ${name}`);
      if (!cacheStores.has(name)) {
        cacheStores.set(name, new FakeCache(name, operations));
      }
      return cacheStores.get(name);
    },

    async keys() {
      operations.push({ type: "cache-names" });
      return Array.from(cacheStores.keys());
    },

    async delete(name) {
      operations.push({ type: "delete-cache", cache: name });
      return cacheStores.delete(name);
    },

    async match() {
      operations.push({ type: "forbidden-global-match" });
      throw new Error("sw.js не должен использовать глобальный caches.match()");
    }
  };

  const self = {
    location: new URL(SW_URL),
    clients: {
      async claim() {
        claimed = true;
      }
    },
    skipWaiting() {},
    addEventListener(type, listener) {
      listeners.set(type, listener);
    }
  };

  const context = {
    URL,
    Promise,
    Response: FakeResponse,
    Set,
    caches,
    console: { warn() {} },
    self,
    fetch: async (request) => {
      const url = requestUrl(request);
      networkRequests.push(url);
      if (networkFailures.has(url)) throw new Error(`network failed: ${url}`);
      const configured = networkResponses.get(url);
      return configured ? configured.clone() : new FakeResponse(`network:${url}`);
    }
  };

  const source = fs.readFileSync("sw.js", "utf8");
  vm.runInNewContext(source, context, { filename: "sw.js" });

  let installPromise;
  listeners.get("install")({
    waitUntil(promise) {
      installPromise = promise;
    }
  });
  await installPromise;

  assert.equal(cacheStores.size, 1, "install должен создать один актуальный кэш");
  const currentCacheName = Array.from(cacheStores.keys())[0];
  assert.equal(currentCacheName, EXPECTED_CACHE_NAME, "Service Worker должен использовать новую безопасную версию кэша");
  const currentCache = cacheStores.get(currentCacheName);
  const addAllOperation = operations.find((operation) => operation.type === "addAll");
  assert.deepEqual(addAllOperation.paths, EXPECTED_APP_SHELL, "APP_SHELL должен точно совпадать с runtime allowlist");
  assert.deepEqual(
    Array.from(currentCache.entries.keys()).sort(),
    EXPECTED_APP_SHELL.map((path) => new URL(path, SW_URL).href).sort(),
    "install должен кэшировать только точный APP_SHELL"
  );

  const supabaseUrls = [
    "/supabase",
    "/supabase/rest/v1/class_members?select=*",
    "/supabase/rest/v1/rpc/can_access_budget",
    "/supabase/auth/v1/user",
    "/supabase/storage/v1/object/public/class/photo.webp"
  ];

  for (const path of supabaseUrls) {
    await currentCache.put(makeRequest(path), new FakeResponse(`old-sensitive:${path}`));
  }

  const staticUrl = new URL("/styles.css?v=592", ORIGIN).href;
  assert(currentCache.entries.has(staticUrl), "статический файл должен находиться в app-shell кэше");

  const oldCache = await caches.open(OLD_CACHE_NAME);
  await oldCache.put(
    makeRequest("/supabase/auth/v1/user"),
    new FakeResponse("old-cache-sensitive-entry")
  );
  await oldCache.put(
    makeRequest("/.github/workflows/deploy.yml"),
    new FakeResponse("old-developer-file")
  );

  let activatePromise;
  listeners.get("activate")({
    waitUntil(promise) {
      activatePromise = promise;
    }
  });
  await activatePromise;

  assert.equal(claimed, true, "Service Worker должен получить управление страницами");
  assert.equal(cacheStores.has(OLD_CACHE_NAME), false, "предыдущий cache ...-3 должен быть удалён целиком");
  for (const path of supabaseUrls) {
    assert.equal(
      currentCache.entries.has(new URL(path, ORIGIN).href),
      false,
      `актуальный кэш должен быть очищен от ${path}`
    );
  }
  assert(currentCache.entries.has(staticUrl), "очистка Supabase не должна удалять статические файлы");

  async function dispatchFetch(path, options = {}) {
    let responsePromise;
    listeners.get("fetch")({
      request: makeRequest(path, options),
      respondWith(promise) {
        responsePromise = Promise.resolve(promise);
      }
    });
    assert(responsePromise, `fetch ${path} должен обрабатываться Service Worker`);
    const response = await responsePromise;
    await new Promise((resolve) => setImmediate(resolve));
    return response;
  }

  for (const path of supabaseUrls) {
    operations.length = 0;
    networkRequests.length = 0;
    const response = await dispatchFetch(path);
    assert.equal(response.body, `network:${new URL(path, ORIGIN).href}`);
    assert.deepEqual(networkRequests, [new URL(path, ORIGIN).href]);
    assert.equal(operations.length, 0, `${path} не должен обращаться к Cache Storage`);
  }

  operations.length = 0;
  networkRequests.length = 0;
  await dispatchFetch("/supabase/auth/v1/token", { method: "POST" });
  assert.deepEqual(networkRequests, [new URL("/supabase/auth/v1/token", ORIGIN).href]);
  assert.equal(operations.length, 0, "POST Auth не должен обращаться к Cache Storage");

  for (const path of ["/styles.css?v=592", "/app.js?v=83"]) {
    operations.length = 0;
    networkRequests.length = 0;
    const url = new URL(path, ORIGIN).href;
    const response = await dispatchFetch(path);
    assert.equal(response.body, `cached:${url}`, `${path} должен читаться из текущего cache`);
    assert(operations.some((operation) => operation.type === "match" && operation.url === url));
    assert(operations.some((operation) => operation.type === "put" && operation.url === url));
    assert.deepEqual(networkRequests, [url], `${path} должен обновляться в фоне`);
    assert(!operations.some((operation) => operation.type === "forbidden-global-match"));
  }

  const unknownUrls = [
    "/.github/workflows/deploy.yml",
    "/.env.local",
    "/supabase.sql",
    "/README.md",
    "/test_presence_frontend.js",
    "/debug.log",
    "/archive.backup",
    "/temporary.tmp",
    "/random.txt",
    "/unknown-path",
    "/app.js",
    "/app.js?v=82",
    "/sw.js?v=86"
  ];

  for (const path of unknownUrls) {
    const url = new URL(path, ORIGIN).href;
    await currentCache.put(makeRequest(path), new FakeResponse(`stale:${url}`));
    operations.length = 0;
    networkRequests.length = 0;
    networkResponses.set(url, new FakeResponse(`spa-fallback:${url}`, {
      headers: { "content-type": "text/html; charset=utf-8" }
    }));
    const response = await dispatchFetch(path);
    assert.equal(response.body, `spa-fallback:${url}`, `${path} должен вернуть только сетевой ответ`);
    assert.deepEqual(networkRequests, [url]);
    assert.equal(operations.length, 0, `${path} не должен читать или писать Cache Storage`);
  }

  const unknownNavigation = "/not-a-client-route";
  const unknownNavigationUrl = new URL(unknownNavigation, ORIGIN).href;
  networkResponses.set(unknownNavigationUrl, new FakeResponse("unknown-navigation-spa-fallback", {
    headers: { "content-type": "text/html; charset=utf-8" }
  }));
  operations.length = 0;
  networkRequests.length = 0;
  const unknownNavigationResponse = await dispatchFetch(unknownNavigation, { mode: "navigate" });
  assert.equal(unknownNavigationResponse.body, "unknown-navigation-spa-fallback");
  assert.deepEqual(networkRequests, [unknownNavigationUrl]);
  assert.equal(operations.length, 0, "неизвестная navigation не должна использовать Cache Storage");

  networkFailures.add(unknownNavigationUrl);
  operations.length = 0;
  await assert.rejects(
    dispatchFetch(unknownNavigation, { mode: "navigate" }),
    /network failed/,
    "неизвестная offline navigation не должна получать cached index fallback"
  );
  assert.equal(operations.length, 0, "неизвестная offline navigation не должна читать Cache Storage");
  networkFailures.delete(unknownNavigationUrl);

  const queryNavigation = "/?code=oauth-code";
  const queryNavigationUrl = new URL(queryNavigation, ORIGIN).href;
  const indexUrl = new URL("/index.html", ORIGIN).href;
  networkResponses.set(queryNavigationUrl, new FakeResponse("fresh-root-html", {
    headers: { "content-type": "text/html; charset=utf-8" }
  }));
  operations.length = 0;
  networkRequests.length = 0;
  const queryNavigationResponse = await dispatchFetch(queryNavigation, { mode: "navigate" });
  assert.equal(queryNavigationResponse.body, "fresh-root-html");
  assert.deepEqual(networkRequests, [queryNavigationUrl]);
  assert(operations.some((operation) => operation.type === "put" && operation.url === indexUrl));
  assert(!operations.some((operation) => operation.type === "put" && operation.url === queryNavigationUrl));
  assert.equal(currentCache.entries.has(queryNavigationUrl), false, "query navigation не должна создавать отдельный cache key");

  const indexNavigation = "/index.html?error=oauth-error";
  const indexNavigationUrl = new URL(indexNavigation, ORIGIN).href;
  networkResponses.set(indexNavigationUrl, new FakeResponse("fresh-index-html", {
    headers: { "content-type": "text/html; charset=utf-8" }
  }));
  operations.length = 0;
  await dispatchFetch(indexNavigation, { mode: "navigate" });
  assert(operations.some((operation) => operation.type === "put" && operation.url === indexUrl));
  assert(!operations.some((operation) => operation.type === "put" && operation.url === indexNavigationUrl));

  const rootUrl = new URL("/", ORIGIN).href;
  networkResponses.set(rootUrl, new FakeResponse("FRESH_NETWORK_INDEX", {
    headers: { "content-type": "text/html; charset=utf-8" }
  }));
  currentCache.entries.set(indexUrl, new FakeResponse("OLD_CACHED_INDEX"));
  currentCache.putFailures.add(indexUrl);
  operations.length = 0;
  const cachePutFailureResponse = await dispatchFetch("/", { mode: "navigate" });
  assert.equal(cachePutFailureResponse.body, "FRESH_NETWORK_INDEX", "ошибка cache.put не должна заменять свежий network response");
  assert.notEqual(cachePutFailureResponse.body, "OLD_CACHED_INDEX");
  assert(operations.some((operation) => operation.type === "put" && operation.url === indexUrl));
  currentCache.putFailures.delete(indexUrl);

  cacheOpenFailures.add(EXPECTED_CACHE_NAME);
  operations.length = 0;
  const cacheOpenFailureResponse = await dispatchFetch("/", { mode: "navigate" });
  assert.equal(cacheOpenFailureResponse.body, "FRESH_NETWORK_INDEX", "ошибка caches.open не должна заменять свежий network response");
  assert.notEqual(cacheOpenFailureResponse.body, "OLD_CACHED_INDEX");
  cacheOpenFailures.delete(EXPECTED_CACHE_NAME);

  currentCache.entries.set(indexUrl, new FakeResponse("fresh-index-html"));
  networkFailures.add(rootUrl);
  operations.length = 0;
  networkRequests.length = 0;
  const offlineRootResponse = await dispatchFetch("/", { mode: "navigate" });
  assert.equal(offlineRootResponse.body, "fresh-index-html", "offline / должен использовать canonical cached index.html");
  assert.deepEqual(networkRequests, [rootUrl]);
  assert(operations.some((operation) => operation.type === "match" && operation.url === indexUrl));
  assert(!operations.some((operation) => operation.type === "match" && operation.url === rootUrl));
  networkFailures.delete(rootUrl);

  assert(!source.includes("caches.match(request)"), "глобальный caches.match(request) запрещён");

  console.log("OK: Supabase и неизвестные same-origin URL не используют Cache Storage.");
  console.log("OK: только точный allowlist из 9 URL может читаться и записываться в текущий cache.");
  console.log("OK: / и /index.html используют один canonical fallback, неизвестные navigation идут только в сеть.");
  console.log("OK: успешный network response сохраняется при ошибке caches.open/cache.put.");
  console.log("OK: cache ...-3 удаляется при activation новой версии ...-4.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
