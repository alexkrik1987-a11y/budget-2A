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
assert(html.includes('app.js?v=81'), "app.js не обновлён до v81");
assert(sw.includes("budget-2a-shell-v86"), "service worker не обновлён до v86");
assert(sw.includes('./app.js?v=81'), "service worker не содержит app.js v81");
console.log("v84 fast feedback checks: PASS");
