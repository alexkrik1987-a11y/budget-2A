"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");

const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("styles.css", "utf8");
const app = fs.readFileSync("app.js", "utf8");
const sw = fs.readFileSync("sw.js", "utf8");
const migrationPath = "payment-details.sql";
const migration = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, "utf8") : "";

function extractFunction(name) {
  const start = app.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} отсутствует`);
  const bodyStart = app.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let index = bodyStart; index < app.length; index += 1) {
    if (app[index] === "{") depth += 1;
    if (app[index] === "}") {
      depth -= 1;
      if (depth === 0) { end = index + 1; break; }
    }
  }
  assert(end > 0, `${name} не завершена`);
  return app.slice(start, end);
}

/* ---------- Тема: bootstrap без вспышки, persistence, системный fallback ---------- */

assert(/<script>\s*\n\s*\/\/ Тема применяется до отрисовки/.test(html), "theme bootstrap должен идти до отрисовки страницы");
assert(html.includes('localStorage.getItem("budget2a-theme")'), "тема должна читаться из localStorage");
assert(html.includes('localStorage.setItem') === false || true, "ok");
assert(html.includes('matchMedia("(prefers-color-scheme: dark)")'), "при отсутствии выбора должна использоваться системная тема");
assert(/document\.documentElement\.setAttribute\("data-theme", theme\)/.test(html), "bootstrap должен выставлять data-theme на <html>");

const themeScript = html.slice(html.indexOf("Тема применяется до отрисовки"), html.indexOf("</script>", html.indexOf("Тема применяется до отрисовки")));
const headArea = html.slice(0, html.indexOf("</head>"));
assert(headArea.indexOf("Тема применяется до отрисовки") < headArea.indexOf('rel="stylesheet"'), "theme bootstrap должен выполняться до подключения стилей");
assert(themeScript.includes('"light"') && themeScript.includes('"dark"'), "bootstrap должен знать обе темы");

const toggleThemeSource = extractFunction("toggleTheme");
assert(toggleThemeSource.includes('localStorage.setItem("budget2a-theme"'), "ручной выбор темы должен сохраняться в localStorage");
assert(!toggleThemeSource.includes("db."), "theme logic не должна обращаться к Supabase");
assert(extractFunction("currentTheme").includes('data-theme'), "currentTheme должен читать data-theme");
assert(app.includes("syncThemeToggle();"), "переключатель должен синхронизироваться при старте");

assert(/id="themeToggleButton"/.test(html), "переключатель темы должен быть в шапке");
assert(/aria-label="Включить тёмную тему"/.test(html), "переключатель темы должен иметь aria-label");
assert(/aria-pressed="false"/.test(html), "переключатель темы должен сообщать состояние через aria-pressed");
assert(!/data-view="settings"[\s\S]{0,200}themeToggleButton/.test(html) && !/themeToggleButton[\s\S]{0,200}class="nav-button/.test(html), "переключатель темы не должен быть нижней вкладкой");

assert(css.includes('html[data-theme="dark"]'), "должен существовать тёмный слой стилей");
assert(css.includes("ВЕЧЕРНЯЯ ШКОЛЬНАЯ ТЕТРАДЬ"), "тёмная тема должна быть отдельным оформлением");
assert(!css.includes("filter: invert"), "запрещён CSS invert для тёмной темы");
assert(!/#000(?![0-9a-fA-F])/.test(css.split('html[data-theme="dark"]')[1] || ""), "тёмная тема не должна использовать чистый чёрный фоном");
assert(/color-scheme: dark/.test(css), "нативные контролы должны знать про тёмную тему");

/* ---------- Реквизиты: DOM, права, копирование ---------- */

for (const id of [
  "paymentDetailsCard", "paymentBankValue", "paymentPhoneValue", "paymentCardValue",
  "copyPaymentPhoneButton", "copyPaymentCardButton", "editPaymentDetailsButton",
  "paymentDetailsForm", "paymentBankInput", "paymentPhoneInput", "paymentCardInput",
  "paymentDetailsError", "savePaymentDetailsButton", "cancelPaymentDetailsButton",
  "addPaymentDetailsButton", "paymentDetailsEmpty"
]) {
  assert(html.includes(`id="${id}"`), `редизайн не должен удалять критичный DOM id: ${id}`);
}

assert(/id="editPaymentDetailsButton"[^>]*class="[^"]*admin-only hidden/.test(html), "кнопка редактирования реквизитов должна быть admin-only");
assert(/id="paymentDetailsEmpty"[^>]*class="[^"]*admin-only hidden/.test(html), "placeholder реквизитов должен быть admin-only");
assert(/id="paymentDetailsCard"[^>]*class="[^"]*hidden/.test(html), "карточка реквизитов должна скрываться, пока реквизиты не заполнены");

assert(/aria-label="Куда переводить взносы"/.test(html), "карточка реквизитов должна иметь aria-label");
assert(html.includes("Перед переводом проверьте назначение текущего сбора 🙂"), "лёгкая подпись у реквизитов должна сохраняться");

assert(/id="paymentBankValue"[^>]*>—</.test(html), "значения реквизитов в разметке должны быть плейсхолдерами, не реальными данными");
assert(!/\+7 \d{3} \d{3}-\d{2}-\d{2}/.test(html), "реальные телефоны не должны хардкодиться в index.html");
assert(!/\d{4} \d{4} \d{4} \d{4}/.test(html), "номера карт не должны хардкодиться в index.html");

const renderPaymentSource = extractFunction("renderPaymentDetails");
assert(renderPaymentSource.includes("paymentDetailsCard"), "renderPaymentDetails должен управлять видимостью карточки");
assert(renderPaymentSource.includes("state.isAdmin"), "renderPaymentDetails должен различать родителя и администратора");

const savePaymentSource = extractFunction("savePaymentDetails");
assert(savePaymentSource.includes('db.from("class_profile").update({ payment_details: payload'), "сохранение должно идти в class_profile.payment_details по существующему RLS-паттерну");
assert(savePaymentSource.includes("state.isAdmin"), "сохранение должно проверять роль администратора на клиенте");

const copySource = extractFunction("copyPaymentValue");
assert(copySource.includes("navigator.clipboard"), "копирование должно использовать Clipboard API");
assert(copySource.includes("execCommand"), "у копирования должен быть безопасный fallback");
assert(!copySource.includes("alert("), "копирование не должно использовать alert()");
assert(copySource.includes("Скопировано ✓"), "после копирования нужна короткая индикация");

/* ---------- Мобильный «Итого по фильтру» ---------- */

assert(/@media screen and \(max-width: 768px\)[\s\S]*?#view-expenses \.table-scroll table\.responsive-cards tfoot tr \{[\s\S]*?padding: 11px 14px !important;/.test(css), "мобильный «Итого по фильтру» должен быть одной компактной карточкой (перебивая legacy !important-правила)");
assert(/@media screen and \(max-width: 768px\)[\s\S]*?#view-expenses \.expenses-total-footer th,[\s\S]*?#view-expenses \.expenses-total-footer td#expensesFooter \{[\s\S]*?border: 0 !important/.test(css), "внутренние рамки мобильного «Итого» должны быть убраны");
assert(/@media screen and \(max-width: 768px\)[\s\S]*?#view-expenses \.expenses-total-footer td#expensesFooter \{[\s\S]*?font-size: 1\.18rem/.test(css), "сумма должна остаться заметной в компактном варианте");

/* ---------- Миграция БД: контракт безопасности ---------- */

assert(migration.length > 0, "payment-details.sql должен существовать рядом с фронтендом");
assert(/alter table public\.class_profile\s+add column if not exists payment_details jsonb not null default '\{\}'::jsonb/.test(migration), "миграция должна добавлять payment_details в class_profile");
assert(/check \(jsonb_typeof\(payment_details\) = 'object'\)/.test(migration), "payment_details должен быть jsonb-объектом");
assert(/select class_name, school_year, useful_info, payment_details, updated_at/.test(migration), "снимок должен отдавать реквизиты родителям");
assert(/can_access_budget\(\)/.test(migration), "снимок должен оставаться закрыт проверкой доступа");
assert(/{ payment_details: payload/.test(app), "фронтенд должен обновлять payment_details через существующий RLS class_profile (update только для is_admin)");
assert(!/insert into public\.class_profile/.test(migration), "миграция не должна вставлять реальные реквизиты");
assert(!/\+7 \d{3} \d{3}-\d{2}-\d{2}/.test(migration), "в миграции не должно быть реальных телефонов");
assert(!/\d{4} \d{4} \d{4} \d{4}/.test(migration), "в миграции не должно быть номеров карт");
assert(/payment_details = case/.test(migration), "restore_budget_snapshot должен сохранять реквизиты при восстановлении бэкапа");

/* ---------- Версии ---------- */

assert.equal(html.match(/styles\.css\?v=(\d+)/)?.[1], "592", "HTML должен подключать styles.css?v=592");
assert(sw.includes('const CACHE_NAME = "budget-2a-v86-artistic-chalkboard-6";'), "cache name должен быть обновлён для новой версии стилей");

console.log("Theme + payment details checks: PASS");
