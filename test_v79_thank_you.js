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
assert(html.includes('styles.css?v=584'), "index.html не обновил cache-busting styles.css");
assert(fs.readFileSync("sw.js", "utf8").includes("budget-2a-shell-v80"), "sw.js не обновил PWA-кэш до v79");
console.log("v79 thank-you checks: PASS");
