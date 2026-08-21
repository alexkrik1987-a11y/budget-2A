"use strict";
const fs = require("fs");
const assert = require("assert");
const app = fs.readFileSync("app.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");

for (const needle of [
  'setButtonLoading(button, true, isApproval ? "Одобряем…" : "Отклоняем…")',
  'setButtonLoading(button, true, "Удаляем…")',
  'state.accessRequests = state.accessRequests.filter',
  'request.request_status = isApproval ? "APPROVED" : "REJECTED"',
  'renderAccessManagement();',
  'Доступ родителя одобрен ✓'
]) assert(app.includes(needle), `Не найдена мгновенная обработка заявки: ${needle}`);
assert(html.includes('id="accessRequestList"'), "В index.html отсутствует список заявок");
console.log("v82 access actions checks: PASS");
