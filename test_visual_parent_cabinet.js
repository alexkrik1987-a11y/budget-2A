"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("styles.css", "utf8");
const sw = fs.readFileSync("sw.js", "utf8");
const manifest = JSON.parse(fs.readFileSync("manifest.webmanifest", "utf8"));

assert(html.includes('<body class="school-cabinet">'), "новая визуальная система должна быть явно ограничена body-классом");
assert(css.includes("«ДОСКА И КВИТАНЦИЯ» — ВИЗУАЛЬНАЯ СИСТЕМА 2 «А»"), "не найдена единая визуальная система");
assert(html.includes('<h1 id="authTitle">Наш дружный класс 2 «А»</h1>'), "первое впечатление должно представлять сайт класса, а не финансовый кабинет");
assert(/<h1><span class="class-cover-label">Наш дружный класс<\/span> <span data-class-name>2 «А»<\/span><\/h1>/.test(html), "обложка сохраняет доступную идентичность класса и динамическое имя");
assert(html.includes("НАШ ДРУЖНЫЙ КЛАСС <span>2 «А»</span>"), "верхняя подпись должна быть грамматически естественной");
assert.equal(manifest.name, "Наш дружный класс 2 «А»", "название установленного PWA должно соответствовать новой концепции");
assert(!html.includes("Родительский комитет на связи"), "официальная формулировка не должна определять первое впечатление");
assert(!html.includes("Закрытый кабинет родителей"), "сайт не должен представляться административным кабинетом");

for (const [view, label] of [
  ["summary", "Сегодня"],
  ["contributions", "Деньги"],
  ["expenses", "Расходы и чеки"],
  ["archive", "Завершённые сборы"],
  ["useful", "Контакты и школа"],
  ["settings", "Управление классом"]
]) {
  assert(
    [...html.matchAll(new RegExp(`data-view="${view}"[^>]*>([\\s\\S]*?)</button>`, "g"))].some((match) => match[1].replace(/<[^>]*>|&shy;/g, "").includes(label)),
    `навигация ${view} должна иметь понятную подпись «${label}»`
  );
}

for (const id of [
  "authGate",
  "emailPasswordForm",
  "googleLoginButton",
  "protectedContent",
  "presenceStatus",
  "view-summary",
  "view-contributions",
  "view-expenses",
  "view-archive",
  "view-useful",
  "view-settings",
  "classChatPanel"
]) {
  assert(html.includes(`id="${id}"`), `редизайн не должен удалять критичный DOM id: ${id}`);
}

assert(css.includes("grid-template-columns: minmax(0, .95fr) minmax(340px, .78fr);"), "desktop-вход должен разделять приветствие и авторизацию");
assert(/\.auth-card \{[^}]*grid-template-columns: minmax\(0, 1fr\)/.test(css) && css.indexOf(".auth-card {") < css.indexOf("@media (min-width: 900px)"), "mobile-вход должен быть одноколоночным (mobile-first)");
assert(css.includes("font-variant-numeric: tabular-nums;"), "финансовые значения должны использовать ровные табличные цифры");
const mobileNav = css.slice(css.indexOf(".main-nav {"), css.indexOf("@media"));
assert(/\.main-nav \{[^}]*position: fixed;[^}]*env\(safe-area-inset-bottom\)/.test(mobileNav), "на мобильном навигация должна оставаться доступной снизу с учётом safe-area");
assert(/\.nav-button \{[^}]*font-size: min\(clamp\(\.6875rem,[^)]*\), 15px\)/.test(css), "подписи мобильной навигации не должны быть меньше 11px (и не обрезаются при 200% тексте)");
assert(/@media \(max-width: 359px\) \{[\s\S]*?\.nav-button \{ font-size: min\(\.6875rem, 15px\); \}/.test(css), "узкий экран не уменьшает подписи ниже 11px");
assert(/\.nav-button \{[^}]*overflow-wrap: normal;[^}]*word-break: normal;/.test(css), "длинные подписи нельзя разрывать внутри слова");
assert(!css.includes("font-size: .52rem;"), "узкий viewport не должен возвращать микроскопический размер подписей");
assert(css.includes("@media (prefers-reduced-motion: reduce)"), "редизайн должен учитывать reduced motion");
assert(html.includes("Всё под контролем. Ну, почти 🙂"), "доброжелательный школьный юмор должен оставаться второстепенным");
assert(html.includes("память хорошая, а чек всё-таки надёжнее"), "подпись о чеках должна быть дружелюбной и понятной");
assert(!/2×2=5|Не пались|Где деньги, Зин/i.test(html), "в новых декоративных текстах не должно быть намеренных ошибок или резких формулировок");

const htmlStyleAsset = html.match(/href="(styles\.css\?v=\d+)"/)?.[1];
assert.equal(htmlStyleAsset, "styles.css?v=610", "HTML должен подключать новую версию стилей");
assert(sw.includes(`./${htmlStyleAsset}`), "Service Worker должен кешировать ту же версию CSS");
assert(sw.includes('const CACHE_NAME = "budget-2a-v96-board-receipt-1";'), "cache name должен быть обновлён для редизайна");

console.log("visual parent cabinet checks: PASS");
