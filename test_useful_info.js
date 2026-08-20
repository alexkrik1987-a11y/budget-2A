#!/usr/bin/env node
const fs = require("node:fs");
const html = fs.readFileSync("index.html", "utf8");
const app = fs.readFileSync("app.js", "utf8");
const css = fs.readFileSync("styles.css", "utf8");
const sql = fs.readFileSync("useful-info.sql", "utf8");
function expect(condition, message) {
  if (!condition) throw new Error(message);
}
for (const id of ["view-useful", "usefulContacts", "usefulSchedule", "usefulInfoForm", "usefulTeacherName", "usefulScheduleMon", "saveUsefulInfoButton"]) {
  expect(html.includes(`id="${id}"`), `missing html id ${id}`);
}
for (const text of ["normalizeUsefulInfo", "renderUsefulInfo", "saveUsefulInfo", "table: \"class_profile\""]) {
  expect(app.includes(text), `missing app marker ${text}`);
}
for (const text of ["useful-grid", "useful-schedule-grid", "useful-admin-editor", "@media (max-width: 640px)"]) {
  expect(css.includes(text), `missing css marker ${text}`);
}
expect(sql.includes("useful_info"), "migration has no useful_info column");
expect(sql.includes("load_class_budget_snapshot"), "migration does not refresh snapshot");
expect(app.includes('table: "class_profile"'), "realtime does not include class_profile");
console.log("useful-info checks: PASS");
