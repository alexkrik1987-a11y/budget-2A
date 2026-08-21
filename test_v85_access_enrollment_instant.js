"use strict";
const fs = require("fs");
const assert = require("assert");
const app = fs.readFileSync("app.js", "utf8");
const sw = fs.readFileSync("sw.js", "utf8");

for (const needle of [
  'state.enrollmentOpen = next;',
  'renderAccessManagement();',
  'pendingEnrollmentMutation',
  'keepOptimisticEnrollment',
  'void refreshAccessAdministration().catch',
  'Приём заявок открыт. ✓',
  'Приём заявок закрыт. ✓'
]) assert(app.includes(needle), `Не найдено мгновенное обновление приёма заявок: ${needle}`);
const mutationStart = app.indexOf('async function toggleAccessEnrollment()');
const mutationEnd = app.indexOf('async function handleAccessRequestAction', mutationStart);
const mutation = app.slice(mutationStart, mutationEnd);
assert(!mutation.includes('await refreshAccessAdministration();'), "Переключение снова блокируется ожиданием полного refresh");
assert(app.includes('./sw.js?v=86'), "app.js всё ещё регистрирует старый Service Worker");
assert(sw.includes('budget-2a-shell-v86'), "sw.js не содержит актуальный shell-кеш");
assert(app.includes('Date.now() - pendingEnrollment.startedAt < 8000'), "нет защиты от устаревшего realtime-ответа");
console.log("v85 access enrollment instant checks: PASS");
