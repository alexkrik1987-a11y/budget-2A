"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const ORIGIN = "https://budget.example";
const SW_URL = `${ORIGIN}/sw.js?v=86`;
const OLD_CACHE_NAME = "budget-2a-v86-artistic-chalkboard-1";

class FakeResponse {
  constructor(body, options = {}) {
    this.body = body;
    this.status = options.status || 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = options.headers || {};
  }

  clone() {
    return new FakeResponse(this.body, {
      status: this.status,
      headers: this.headers
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
  }

  async addAll(paths) {
    this.operations.push({ type: "addAll", cache: this.name });
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
  let claimed = false;

  const caches = {
    async open(name) {
      operations.push({ type: "open", cache: name });
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

    async match(request) {
      const url = requestUrl(request);
      operations.push({ type: "storage-match", url });
      for (const cache of cacheStores.values()) {
        const response = await cache.match(request);
        if (response) return response;
      }
      return undefined;
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
    caches,
    self,
    fetch: async (request) => {
      const url = requestUrl(request);
      networkRequests.push(url);
      return new FakeResponse(`network:${url}`);
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
  assert.notEqual(currentCacheName, OLD_CACHE_NAME, "имя кэша должно измениться для очистки старой версии");
  const currentCache = cacheStores.get(currentCacheName);

  const supabaseUrls = [
    "/supabase/rest/v1/class_members?select=*",
    "/supabase/rest/v1/rpc/can_access_budget",
    "/supabase/auth/v1/user",
    "/supabase/storage/v1/object/public/class/photo.webp"
  ];

  for (const path of supabaseUrls) {
    await currentCache.put(makeRequest(path), new FakeResponse(`old-sensitive:${path}`));
  }

  const staticUrl = new URL("/styles.css?v=590", ORIGIN).href;
  assert(currentCache.entries.has(staticUrl), "статический файл должен находиться в app-shell кэше");

  const oldCache = await caches.open(OLD_CACHE_NAME);
  await oldCache.put(
    makeRequest("/supabase/auth/v1/user"),
    new FakeResponse("old-cache-sensitive-entry")
  );

  let activatePromise;
  listeners.get("activate")({
    waitUntil(promise) {
      activatePromise = promise;
    }
  });
  await activatePromise;

  assert.equal(claimed, true, "Service Worker должен получить управление страницами");
  assert.equal(cacheStores.has(OLD_CACHE_NAME), false, "старый кэш должен быть удалён целиком");
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

  operations.length = 0;
  networkRequests.length = 0;
  const staticResponse = await dispatchFetch("/styles.css?v=590");
  assert.equal(staticResponse.body, `cached:${staticUrl}`, "статический asset должен читаться из кэша");
  assert(operations.some((operation) => operation.type === "storage-match" && operation.url === staticUrl));
  assert(operations.some((operation) => operation.type === "put" && operation.url === staticUrl));
  assert.deepEqual(networkRequests, [staticUrl], "статический asset должен обновляться в фоне");

  console.log("OK: Supabase REST/RPC/Auth/Storage всегда идут в сеть и не используют Cache Storage.");
  console.log("OK: старый кэш удаляется, а Supabase-записи очищаются из актуального кэша.");
  console.log("OK: обычный статический asset продолжает работать по прежней cache-first схеме.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
