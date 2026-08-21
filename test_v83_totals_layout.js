"use strict";
const fs = require("fs");
const assert = require("assert");
const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("styles.css", "utf8");
const app = fs.readFileSync("app.js", "utf8");

assert(html.indexOf("campaignCollectedTotal") < html.indexOf("campaignPlanTotal"), "В карточке сбора «Собрано» не стоит перед «План»");
assert(html.indexOf("contributionsPaidFooter") < html.indexOf("contributionsPlanFooter"), "В итогах взносов «Собрано» не стоит перед «План»");
for (const needle of [
  "contributions-total-footer",
  "expenses-total-footer",
  "Итого по фильтру",
  "Сумма видимых расходов"
]) assert(html.includes(needle), `Не найден блок итогов: ${needle}`);
for (const needle of [
  ".campaign-total-collected",
  ".campaign-total-plan",
  ".contributions-total-collected",
  ".expenses-total-footer",
  "@media (max-width: 700px)"
]) assert(css.includes(needle), `Не найден стиль итогов: ${needle}`);
assert(app.includes("if (dom.expensesFooter) dom.expensesFooter.textContent"), "Расчёт суммы расходов по фильтру не найден");
console.log("v83 totals layout checks: PASS");
