"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("styles.css", "utf8");
const sw = fs.readFileSync("sw.js", "utf8");
const manifest = JSON.parse(fs.readFileSync("manifest.webmanifest", "utf8"));

assert(html.includes('<body class="school-cabinet">'), "новая визуальная система должна быть явно ограничена body-классом");
assert(css.includes("НАШ ДРУЖНЫЙ КЛАСС 2 «А» — ЕДИНАЯ ВИЗУАЛЬНАЯ СИСТЕМА"), "не найден итоговый слой редизайна");
assert(html.includes('<h1 id="authTitle">Наш дружный класс 2 «А»</h1>'), "первое впечатление должно представлять сайт класса, а не финансовый кабинет");
assert(/<h1>Наш дружный класс <span data-class-name>2 «А»<\/span><\/h1>/.test(html), "защищённая шапка должна сохранять главную идентичность класса");
assert(html.includes("НАШ ДРУЖНЫЙ КЛАСС <span>2 «А»</span>"), "верхняя подпись должна быть грамматически естественной");
assert.equal(manifest.name, "Наш дружный класс 2 «А»", "название установленного PWA должно соответствовать новой концепции");
assert(!html.includes("Родительский комитет на связи"), "официальная формулировка не должна определять первое впечатление");
assert(!html.includes("Закрытый кабинет родителей"), "сайт не должен представляться административным кабинетом");

for (const [view, label] of [
  ["summary", "Наш класс"],
  ["contributions", "Сборы"],
  ["expenses", "Расходы"],
  ["archive", "История"],
  ["useful", "Полезное"],
  ["settings", "Ещё"]
]) {
  assert(
    new RegExp(`data-view="${view}"[^>]*>[\\s\\S]*?${label}</button>`).test(html),
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
assert(/@media screen and \(max-width: 900px\)[\s\S]*?\.monitor-showcase \{[\s\S]*?grid-template-columns: minmax\(0,1fr\)/.test(css), "mobile-вход должен становиться одноколоночным");
assert(css.includes("font-variant-numeric: tabular-nums;"), "финансовые значения должны использовать ровные табличные цифры");
assert(css.includes("body.school-cabinet .main-nav"), "навигация должна входить в единую визуальную систему");
assert(/@media screen and \(max-width: 768px\)[\s\S]*?body\.school-cabinet \.main-nav \{[\s\S]*?position: fixed !important/.test(css), "на мобильном навигация должна оставаться доступной снизу");
assert(/body\.school-cabinet \.main-nav \.nav-button \{[\s\S]*?font-size: \.6875rem !important;/.test(css), "подписи мобильной навигации не должны быть меньше 11px");
assert(/\.nav-inner:has\(\.nav-button\.admin-only:not\(\.hidden\)\) \.nav-button \{ font-size: \.6875rem !important; \}/.test(css), "шестая admin-вкладка не должна возвращать мелкий legacy-шрифт");
assert(/font-size: \.6875rem !important;[\s\S]*?overflow-wrap: normal !important;[\s\S]*?word-break: normal !important;/.test(css), "длинные подписи нельзя разрывать внутри слова");
assert(!css.includes("font-size: .52rem;"), "узкий viewport не должен возвращать микроскопический размер подписей");
assert(css.includes("@media (prefers-reduced-motion: reduce)"), "редизайн должен учитывать reduced motion");
assert(html.includes("Всё под контролем. Ну, почти 🙂"), "доброжелательный школьный юмор должен оставаться второстепенным");
assert(html.includes("память хорошая, а чек всё-таки надёжнее"), "подпись о чеках должна быть дружелюбной и понятной");
assert(!/2×2=5|Не пались|Где деньги, Зин/i.test(html), "в новых декоративных текстах не должно быть намеренных ошибок или резких формулировок");

const htmlStyleAsset = html.match(/href="(styles\.css\?v=\d+)"/)?.[1];
assert.equal(htmlStyleAsset, "styles.css?v=594", "HTML должен подключать новую версию стилей");
assert(sw.includes(`./${htmlStyleAsset}`), "Service Worker должен кешировать ту же версию CSS");
assert(sw.includes('const CACHE_NAME = "budget-2a-v86-artistic-chalkboard-9";'), "cache name должен быть обновлён для редизайна");

console.log("visual parent cabinet checks: PASS");
