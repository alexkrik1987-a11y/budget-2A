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
const stylesAsset = html.match(/href="(styles\.css\?v=[^"]+)"/)?.[1];
assert(stylesAsset, "index.html должен подключать версионированный styles.css");
assert(/^styles\.css\?v=[A-Za-z0-9._-]+$/.test(stylesAsset), "styles.css должен иметь корректный cache-busting параметр");
console.log("v81 parent onboarding checks: PASS");
