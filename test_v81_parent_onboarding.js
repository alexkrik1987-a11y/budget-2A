"use strict";
const fs = require("fs");
const assert = require("assert");
const app = fs.readFileSync("app.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("styles.css", "utf8");

for (const needle of [
  "parentOnboardingGuide",
  "renderParentOnboardingGuide",
  "handleParentOnboardingGuideAction",
  "PARENT_ONBOARDING_GUIDE_KEY",
  'action === "my-contribution"',
  'action === "contributions"',
  'action === "useful"',
  'state.isAdmin || !getReminderStudentId()'
]) assert(app.includes(needle), `Не найдена onboarding-логика: ${needle}`);
for (const needle of [
  'id="parentOnboardingGuide"',
  'parent-onboarding-guide',
  'parent-onboarding-guide-step'
]) assert(html.includes(needle) || css.includes(needle), `Не найден onboarding-элемент: ${needle}`);
assert(html.includes('styles.css?v=585'), "index.html не обновил cache-busting styles.css");
console.log("v81 parent onboarding checks: PASS");
