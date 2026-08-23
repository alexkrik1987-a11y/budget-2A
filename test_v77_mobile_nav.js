"use strict";
const fs = require("fs");
const css = fs.readFileSync("styles.css", "utf8");
const html = fs.readFileSync("index.html", "utf8");
const sw = fs.readFileSync("sw.js", "utf8");

for (const needle of [
  ".site-header .nav-inner:has(.nav-button.admin-only:not(.hidden))",
  "grid-template-columns: repeat(6, minmax(0, 1fr));",
  "grid-template-columns: repeat(5, minmax(0, 1fr));"
]) {
  if (!css.includes(needle)) throw new Error(`Не найдено правило мобильной навигации: ${needle}`);
}
const stylesAsset = html.match(/href="(styles\.css\?v=[^"]+)"/)?.[1];
if (!stylesAsset) throw new Error("index.html должен подключать версионированный styles.css");
if (!sw.includes(`./${stylesAsset}`)) throw new Error("styles.css в Service Worker должен совпадать с index.html");
console.log("v77 mobile nav checks: PASS");
