"use strict";
const fs = require("fs");
const assert = require("assert");
const app = fs.readFileSync("app.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("styles.css", "utf8");

for (const needle of [
  "createThankYouMessage",
  "latestClosedCampaign",
  'thank-you-message-${context}',
  'context === "main"',
  "Спасибо, сбор завершён!"
]) assert(app.includes(needle), `Не найдена благодарственная логика: ${needle}`);
for (const needle of [
  ".thank-you-message",
  ".thank-you-message-main",
  "@media (max-width: 640px)"
]) assert(css.includes(needle), `Не найдены благодарственные стили: ${needle}`);
const sw = fs.readFileSync("sw.js", "utf8");
const stylesAsset = html.match(/href="(styles\.css\?v=[^"]+)"/)?.[1];
assert(stylesAsset, "index.html должен подключать версионированный styles.css");
assert(sw.includes(`./${stylesAsset}`), "styles.css в Service Worker должен совпадать с index.html");
const cacheName = sw.match(/const CACHE_NAME = "([^"]+)";/)?.[1];
assert(cacheName && cacheName.startsWith("budget-2a-"), "Service Worker должен использовать отдельный cache проекта");
assert(sw.includes("caches.open(CACHE_NAME)"), "Service Worker должен использовать объявленный CACHE_NAME");
console.log("v79 thank-you checks: PASS");
