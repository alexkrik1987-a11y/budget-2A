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
const workerAsset = app.match(/new URL\("(\.\/sw\.js\?v=[^"]+)"/)?.[1];
assert(workerAsset, "app.js должен регистрировать версионированный Service Worker");
assert(app.includes('updateViaCache: "none"'), "регистрация Service Worker должна обходить устаревший HTTP cache");
const cacheName = sw.match(/const CACHE_NAME = "([^"]+)";/)?.[1];
assert(cacheName && cacheName.startsWith("budget-2a-"), "Service Worker должен использовать отдельный cache проекта");
assert(sw.includes("keys.filter((key) => key !== CACHE_NAME)"), "activate должен удалять прежние cache проекта");
assert(app.includes('Date.now() - pendingEnrollment.startedAt < 8000'), "нет защиты от устаревшего realtime-ответа");
console.log("v85 access enrollment instant checks: PASS");
