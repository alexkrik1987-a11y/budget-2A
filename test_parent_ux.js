"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const app = fs.readFileSync("app.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");
function source(name) {
  const start = app.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  return app.slice(start, app.indexOf("\n}", start) + 2);
}
const context = { Intl, Date };
vm.createContext(context);
vm.runInContext(source("schoolWeekday") + "\n" + source("todaySchedulePreview"), context);
const monday = new Date("2026-09-06T15:00:00Z"); // Monday in Vladivostok, Sunday UTC.
const schedule = { mon: ["Русский язык", "Математика", "Чтение"] };
assert.equal(context.schoolWeekday(monday), "mon");
assert.equal(context.todaySchedulePreview(schedule, true, monday), "Сегодня: Русский язык, Математика · ещё 1");
assert.match(context.todaySchedulePreview({}, true, monday), /ещё не указаны/);
assert.match(context.todaySchedulePreview(schedule, false, monday), /загружается/);
assert.match(context.todaySchedulePreview({}, true, new Date("2026-09-12T02:00Z")), /выходной/);

function node() { return { children: [], append(...children) { this.children.push(...children); }, setAttribute(k, v) { this[k] = v; }, classList: { toggle() {}, remove() {}, add() {} } }; }
context.el = (tag, cls, text) => Object.assign(node(), { tag, textContent: text });
vm.runInContext(source("createUsefulContact"), context);
assert.equal(context.createUsefulContact("Учитель", "Имя", "+7 (900) 123-45-67").children[1].href, "tel:+79001234567");
assert.equal(context.createUsefulContact("Учитель", "", "").children.length, 1, "no dead phone action");

context.dom = { paymentDetailsUnavailable: node() };
context.state = { isAdmin: false, budgetDataReady: false, classProfile: { payment_details: {} } };
context.hideElement = () => {};
vm.runInContext(["normalizePaymentDetails", "paymentDetailsFilled", "renderPaymentDetails"].map(source).join("\n"), context);
context.renderPaymentDetails(); assert.match(context.dom.paymentDetailsUnavailable.textContent, /загрузки/);
context.state.budgetDataReady = true; context.renderPaymentDetails();
assert.match(context.dom.paymentDetailsUnavailable.textContent, /родительского комитета в чате/);
let hidden;
context.dom.paymentDetailsUnavailable.classList.toggle = (_, value) => { hidden = value; };
context.state.classProfile.payment_details.phone = "+79001234567";
context.renderPaymentDetails(); assert.equal(hidden, true, "empty state hidden when details available");
context.state.classProfile.payment_details = {}; context.state.isAdmin = true;
context.renderPaymentDetails(); assert.equal(hidden, true, "admin retains own guarded editor");

assert.match(html, /id="copyStatus"[^>]*role="status"/);
assert.match(html, /aria-label="Скопировать номер телефона"/);
assert.match(html, /aria-label="Скопировать номер карты"/);
assert.match(html, /<details class="home-money-details">/);
for (const id of ["expense", "campaign", "student"]) assert.match(html, new RegExp(`<dialog id="${id}Modal"[^>]*aria-labelledby="${id}ModalTitle"`));

(async () => {
  let clipboard, feedback, fallback = false;
  context.state = { classProfile: { payment_details: { phone: "+79001234567", card: "2200 0000 0000 0000" } } };
  context.navigator = { clipboard: { writeText: async value => { clipboard = value; } } };
  context.showCopyFeedback = message => { feedback = message; };
  context.window = { setTimeout() {} };
  context.document = { createElement: () => ({ setAttribute() {}, select() {}, remove() {} }), body: { append() {} }, execCommand: () => fallback };
  vm.runInContext("async " + source("copyPaymentValue"), context);
  const button = node();
  await context.copyPaymentValue("phone", button);
  assert.equal(clipboard, "+79001234567"); assert.equal(feedback, "Номер телефона скопирован");
  await context.copyPaymentValue("card", button); assert.equal(feedback, "Номер карты скопирован");
  context.navigator.clipboard.writeText = async () => { throw new Error("denied"); };
  await context.copyPaymentValue("phone", button); assert.match(feedback, /вручную/);
  fallback = true; await context.copyPaymentValue("phone", button); assert.equal(feedback, "Номер телефона скопирован");
  console.log("Parent UX: PASS (local date, truthful empty/loading, phone links, copy success/failure/fallback, accessibility)");
})().catch(error => { console.error(error); process.exitCode = 1; });
