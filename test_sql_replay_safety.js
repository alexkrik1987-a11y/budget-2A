"use strict";

const fs = require("node:fs");
const assert = require("node:assert/strict");

const classChatSql = fs.readFileSync("class-chat.sql", "utf8");
const chatArchiveSql = fs.readFileSync("chat-archive.sql", "utf8");
const archiveFeaturesSql = fs.readFileSync("archive-features.sql", "utf8");
const usefulInfoSql = fs.readFileSync("useful-info.sql", "utf8");
const legacyUpgradeSql = fs.readFileSync("upgrade-features.sql", "utf8");
const readme = fs.readFileSync("README.md", "utf8");
const app = fs.readFileSync("app.js", "utf8");

function extractFunction(sql, functionName) {
  const start = sql.indexOf(`create or replace function public.${functionName}`);
  assert.notEqual(start, -1, `${functionName} не найдена`);
  const dollarTag = sql.slice(start).match(/as (\$[a-z_]*\$)/i)?.[1];
  assert(dollarTag, `${functionName}: не найдено тело функции`);
  const bodyStart = sql.indexOf(dollarTag, start) + dollarTag.length;
  const bodyEnd = sql.indexOf(dollarTag, bodyStart);
  assert.notEqual(bodyEnd, -1, `${functionName}: не найден конец тела`);
  return sql.slice(start, bodyEnd + dollarTag.length).toLowerCase();
}

// До chat-archive.sql class-chat.sql не должен ссылаться на отсутствующую колонку
// в обычной ветке, а после её появления обязан восстанавливать только safe policy.
assert(classChatSql.includes("from pg_attribute as attribute"), "replay не проверяет наличие archived_at через metadata");
assert(classChatSql.includes("attribute.attname = 'archived_at'"), "replay не проверяет archived_at");
assert(classChatSql.includes("execute $policy$"), "archive-aware policy должна создаваться только после metadata-проверки");
assert(classChatSql.includes("and (archived_at is null or public.is_admin())"), "replay class-chat.sql потерял архивный фильтр");
assert(chatArchiveSql.includes("and (archived_at is null or public.is_admin())"), "итоговая chat-archive policy потеряла архивный фильтр");

function replayedChatPolicy({ archivedAtExists }) {
  return archivedAtExists
    ? "can_access_budget AND (archived_at IS NULL OR is_admin)"
    : "can_access_budget";
}

assert.equal(replayedChatPolicy({ archivedAtExists: false }), "can_access_budget", "clean install до archived_at должен работать");
assert.equal(
  replayedChatPolicy({ archivedAtExists: true }),
  "can_access_budget AND (archived_at IS NULL OR is_admin)",
  "replay после chat-archive.sql не должен открывать архив родителям"
);
assert.equal(
  replayedChatPolicy({ archivedAtExists: true }),
  replayedChatPolicy({ archivedAtExists: true }),
  "повторный replay безопасной схемы должен быть idempotent"
);

// Оба файла, способные переопределить restore, должны сохранять useful_info.
for (const [fileName, sql] of [
  ["archive-features.sql", archiveFeaturesSql],
  ["useful-info.sql", usefulInfoSql]
]) {
  const restore = extractFunction(sql, "restore_budget_snapshot(p_snapshot jsonb)");
  assert(restore.includes("useful_info = case"), `${fileName}: restore может потерять useful_info`);
  assert(restore.includes("jsonb_typeof(p_snapshot #> '{class_profile,useful_info}') = 'object'"), `${fileName}: нет безопасной проверки useful_info`);
  assert(restore.includes("else useful_info"), `${fileName}: старый backup без useful_info должен оставаться совместимым`);
}

// Действующие инструкции больше не направляют владельца на legacy-монолит.
assert(!readme.includes("upgrade-features.sql"), "README всё ещё советует legacy upgrade-features.sql");
assert(!app.includes("upgrade-features.sql"), "frontend всё ещё советует legacy upgrade-features.sql");
assert(legacyUpgradeSql.includes("LEGACY / ИСТОРИЧЕСКИЙ ФАЙЛ — НЕ ЗАПУСКАТЬ"), "legacy SQL не содержит явного запрета на текущую установку/replay");

const expectedOrder = [
  "supabase.sql",
  "class-chat.sql",
  "chat-pinning.sql",
  "chat-archive.sql",
  "parent-access-requests.sql",
  "archive-features.sql",
  "class-receipts-storage.sql",
  "useful-info.sql"
];
let previousPosition = -1;
for (const fileName of expectedOrder) {
  const position = readme.indexOf(`\`${fileName}\``);
  assert(position > previousPosition, `${fileName} отсутствует или стоит не в том месте clean-install порядка`);
  previousPosition = position;
}

console.log("SQL replay safety checks: PASS");
