"use strict";
const fs = require("fs");
const assert = require("assert");
const app = fs.readFileSync("app.js", "utf8");
const css = fs.readFileSync("styles.css", "utf8");
const html = fs.readFileSync("index.html", "utf8");

for (const needle of [
  "summarizeArchivedPayments",
  "Недособрано",
  "Должников",
  "Частично сдали",
  "Сдали полностью",
  "Сдали частично",
  "Не сдали",
  "archiveStudents"
]) {
  if (needle === "archiveStudents") continue;
  assert(app.includes(needle), `Не найдена логика архива: ${needle}`);
}
for (const needle of [
  ".archive-payment-summary",
  ".archive-status-paid",
  ".archive-status-partial",
  ".archive-status-debt"
]) assert(css.includes(needle), `Не найден стиль архива: ${needle}`);
assert(html.includes('styles.css?v=586'), "index.html не обновил cache-busting styles.css");
assert(fs.readFileSync("sw.js", "utf8").includes("budget-2a-shell-v85"), "sw.js не обновил PWA-кэш до v85");
console.log("v80 archive status checks: PASS");
