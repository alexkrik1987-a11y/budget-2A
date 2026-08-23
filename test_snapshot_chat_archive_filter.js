"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const sourceSql = fs.readFileSync("useful-info.sql", "utf8");
const patchSql = fs.readFileSync("fix-chat-snapshot-archive-visibility.sql", "utf8");

function extractSnapshotFunction(sql) {
  const start = sql.indexOf("create or replace function public.load_class_budget_snapshot()");
  assert.notEqual(start, -1, "load_class_budget_snapshot() не найдена");
  const end = sql.indexOf("\n$$;", start);
  assert.notEqual(end, -1, "конец load_class_budget_snapshot() не найден");
  return sql.slice(start, end + 4);
}

const sourceFunction = extractSnapshotFunction(sourceSql);
const patchFunction = extractSnapshotFunction(patchSql);
assert.equal(
  patchFunction,
  sourceFunction,
  "канонический snapshot и отдельный production hotfix должны содержать одну безопасную функцию"
);

const chatSectionStart = patchFunction.indexOf("'chat_messages', coalesce((");
const chatSection = patchFunction.slice(chatSectionStart);
assert(chatSection.includes("where archived_at is null or public.is_admin()"));
assert(chatSection.includes("order by created_at desc, id desc\n        limit 120"));
assert(sourceFunction.includes("where archived_at is null or public.is_admin()"));

for (const section of ["students", "campaigns", "contributions", "expenses", "class_profile", "chat_messages"]) {
  assert(patchFunction.includes(`'${section}'`), `snapshot должен сохранять раздел ${section}`);
}

const messages = [
  { id: "active", archived_at: null },
  { id: "archived", archived_at: "2026-01-01T00:00:00.000Z" }
];
const visibleMessages = (isAdmin) => messages.filter((message) => message.archived_at === null || isAdmin);

assert.deepEqual(visibleMessages(false).map((message) => message.id), ["active"]);
assert.deepEqual(visibleMessages(true).map((message) => message.id), ["active", "archived"]);

assert(!/\b(create|alter|drop)\s+(table|policy)\b/i.test(patchSql), "патч не должен менять таблицы или RLS");
assert(!/pin_class_chat_message|unpin_class_chat_message/.test(patchSql), "патч не должен менять pin/unpin RPC");

console.log("snapshot chat archive filter checks: PASS");
