"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const html = fs.readFileSync("index.html", "utf8");
const app = fs.readFileSync("app.js", "utf8");
const names = ["summary", "schedule", "announcements", "contributions", "expenses", "archive", "budget", "useful", "memos", "household", "notifications", "directory", "settings"];
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(ids.length, new Set(ids).size, "moving cards must not duplicate controls");
for (const view of names) assert(ids.includes(`view-${view}`), `missing destination ${view}`);
const mainNav = html.match(/<nav class="main-nav"[\s\S]*?<\/nav>/)[0];
assert.deepEqual([...mainNav.matchAll(/data-view="([^"]+)"/g)].map(match => match[1]), ["summary", "schedule", "contributions", "directory"]);
assert(!mainNav.includes("admin-only"), "admin tools must not crowd the parent navigation");
for (const view of names.filter(name => !["summary", "directory", "settings"].includes(name))) {
  assert(html.includes(`data-view="${view}"`), `destination must have a labelled route: ${view}`);
}

function element(id, classes = []) {
  const classSet = new Set(classes), attributes = {};
  return { id, attributes, dataset: {}, classList: {
    contains: name => classSet.has(name),
    toggle: (name, on) => on ? classSet.add(name) : classSet.delete(name)
  }, setAttribute: (key, value) => { attributes[key] = value; }, removeAttribute: key => { delete attributes[key]; },
  focus() { this.focused = true; }, textContent: id };
}
const elements = new Map();
const views = names.map(name => {
  const view = element(`view-${name}`, name === "summary" ? ["view", "active"] : ["view"]);
  view.heading = element(`${name}Title`);
  view.querySelector = () => view.heading;
  view.contains = () => false;
  elements.set(view.id, view); return view;
});
for (const id of ["sectionNavigation", "moneyNavigation", "currentSectionLabel"]) elements.set(id, element(id));
const nav = ["summary", "schedule", "contributions", "directory"].map(name => Object.assign(element(name), { dataset: { view: name } }));
const money = ["contributions", "expenses", "archive", "budget", "household"].map(name => Object.assign(element(name), { dataset: { view: name } }));
const history = { state: { preserved: true }, pushes: [], replaceState(value) { this.state = value; }, pushState(value) { this.state = value; this.pushes.push(value); } };
const context = { state: { isAdmin: false }, dom: { navButtons: nav }, window: { history, scrollTo() {} }, document: {
  getElementById: id => elements.get(id),
  querySelector: () => views.find(view => view.classList.contains("active")),
  querySelectorAll: selector => selector === ".view" ? views : money
} };
vm.createContext(context);
vm.runInContext(app.slice(app.indexOf("function switchView("), app.indexOf("function openReceiptPreview(")) + "\nthis.navigate = switchView;", context);
const active = () => views.find(view => view.classList.contains("active")).id;
context.navigate("schedule", { remember: true });
assert.equal(active(), "view-schedule");
assert.equal(nav[1].attributes["aria-current"], "page");
assert.equal(history.state.preserved, true);
assert.equal(history.pushes.length, 1);
assert(elements.get("view-schedule").heading.focused, "section title receives keyboard focus");
context.navigate("settings", { remember: true });
assert.equal(active(), "view-schedule", "parent cannot enter admin view");
assert.equal(history.pushes.length, 1, "denied route must not modify history");
context.navigate("not-a-view");
assert.equal(active(), "view-schedule", "invalid route must not blank the screen");
for (const view of ["expenses", "budget", "archive", "household"]) {
  context.navigate(view);
  assert.equal(active(), `view-${view}`);
  assert.equal(nav[2].attributes["aria-current"], "page");
  assert(!elements.get("moneyNavigation").classList.contains("hidden"));
  assert.equal(money.filter(button => button.attributes["aria-current"] === "page").length, 1);
}
for (const view of ["announcements", "memos", "useful", "notifications"]) {
  context.navigate(view);
  assert.equal(nav[3].attributes["aria-current"], "page");
  assert(elements.get("moneyNavigation").classList.contains("hidden"));
}
context.state.isAdmin = true; context.navigate("settings");
assert.equal(active(), "view-settings");
context.navigate("summary");
assert.equal(active(), "view-summary");
assert(elements.get("sectionNavigation").classList.contains("hidden"));
assert.equal(nav.filter(button => button.attributes["aria-current"] === "page").length, 1);
console.log("parent navigation: PASS (destinations, roles, history, focus, active states)");
