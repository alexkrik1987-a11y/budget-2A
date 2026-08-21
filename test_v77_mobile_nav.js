"use strict";
const fs = require("fs");
const css = fs.readFileSync("styles.css", "utf8");
const html = fs.readFileSync("index.html", "utf8");

for (const needle of [
  ".site-header .nav-inner:has(.nav-button.admin-only:not(.hidden))",
  "grid-template-columns: repeat(6, minmax(0, 1fr));",
  "grid-template-columns: repeat(5, minmax(0, 1fr));"
]) {
  if (!css.includes(needle)) throw new Error(`Не найдено правило мобильной навигации: ${needle}`);
}
if (!html.includes('styles.css?v=581')) throw new Error("index.html не обновил cache-busting styles.css");
console.log("v77 mobile nav checks: PASS");
