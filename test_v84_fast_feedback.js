"use strict";
const fs = require("fs");
const assert = require("assert");
const app = fs.readFileSync("app.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");
const sw = fs.readFileSync("sw.js", "utf8");

for (const needle of [
  "function refreshAfterMutation()",
  "renderAll();",
  "Background mutation refresh error",
  "localExpense",
  "localCampaign"
]) assert(app.includes(needle), `Не найден быстрый отклик: ${needle}`);
assert(!app.includes("refreshAfterMutation();.catch"), "Осталась повреждённая цепочка realtime refresh");
const appAsset = html.match(/<script src="(app\.js\?v=[^"]+)" defer><\/script>/)?.[1];
assert(appAsset, "index.html должен подключать версионированный app.js");
assert(sw.includes(`./${appAsset}`), "app.js в Service Worker должен совпадать с index.html");
const cacheName = sw.match(/const CACHE_NAME = "([^"]+)";/)?.[1];
assert(cacheName && cacheName.startsWith("budget-2a-"), "Service Worker должен использовать отдельный cache проекта");
assert(sw.includes("caches.open(CACHE_NAME)"), "Service Worker должен использовать объявленный CACHE_NAME");
console.log("v84 fast feedback checks: PASS");
