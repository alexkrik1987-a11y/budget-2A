"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const app = fs.readFileSync("app.js", "utf8");
const pinSql = fs.readFileSync("chat-pinning.sql", "utf8");
const accessSql = fs.readFileSync("parent-access-requests.sql", "utf8");
const archiveSql = fs.readFileSync("chat-archive.sql", "utf8");
const snapshotSql = fs.readFileSync("useful-info.sql", "utf8");

const expectedColumns = {
  is_pinned: { type: "boolean", nullable: false, default: "false" },
  pinned_at: { type: "timestamptz", nullable: true, default: null },
  pinned_by: { type: "uuid", nullable: true, default: null }
};
const expectedFk = {
  source: "public.chat_messages(pinned_by)",
  target: "auth.users(id)",
  onUpdate: "NO ACTION",
  onDelete: "SET NULL",
  deferrable: false
};
const expectedIndexes = {
  idx_chat_messages_pinned_at: {
    table: "public.chat_messages", method: "btree", unique: false,
    columns: ["pinned_at"], descending: [true], predicate: "is_pinned = true",
    valid: true, ready: true, live: true
  },
  idx_chat_messages_single_pinned: {
    table: "public.chat_messages", method: "btree", unique: true,
    columns: ["is_pinned"], descending: [false], predicate: "is_pinned = true",
    valid: true, ready: true, live: true
  }
};

function schemaDecision(actual, expected, objectName) {
  if (actual === undefined) return "create";
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Schema conflict: ${objectName}`);
  }
  return "accept";
}

function extractFunction(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}`);
  assert.notEqual(start, -1, `${name} не определена в SQL`);
  const dollarTagMatch = sql.slice(start).match(/as (\$[a-z_]*\$)/i);
  assert(dollarTagMatch, `не найден dollar-quote для ${name}`);
  const bodyStart = start + dollarTagMatch.index;
  const end = sql.indexOf(`${dollarTagMatch[1]};`, bodyStart);
  assert.notEqual(end, -1, `не найден конец ${name}`);
  return sql.slice(start, end + dollarTagMatch[1].length + 1);
}

function assertProductionGrants(sql, signature) {
  assert(sql.includes(`grant execute on function public.${signature} to authenticated;`), `${signature}: нет EXECUTE для authenticated`);
  assert(sql.includes(`grant execute on function public.${signature} to service_role;`), `${signature}: нет EXECUTE для service_role`);
  assert(sql.includes(`revoke execute on function public.${signature} from anon;`), `${signature}: EXECUTE не отозван у anon`);
  assert(sql.includes(`revoke execute on function public.${signature} from public;`), `${signature}: EXECUTE не отозван у PUBLIC`);
}

for (const rpcName of ["pin_class_chat_message", "unpin_class_chat_message", "revoke_class_access"]) {
  assert(app.includes(`db.rpc("${rpcName}"`), `frontend не вызывает ${rpcName}`);
}

const pinFunction = extractFunction(pinSql, "pin_class_chat_message(p_message_id uuid)");
const unpinFunction = extractFunction(pinSql, "unpin_class_chat_message()");
const revokeFunction = extractFunction(accessSql, "revoke_class_access(p_request_id uuid)");

const firstFunctionPosition = pinSql.indexOf("create or replace function public.pin_class_chat_message");
for (const column of ["is_pinned", "pinned_at", "pinned_by"]) {
  const columnPosition = pinSql.indexOf(`add column if not exists ${column}`);
  assert(columnPosition >= 0 && columnPosition < firstFunctionPosition, `${column} должна создаваться до pin RPC`);
}

assert(/add constraint chat_messages_pinned_by_fkey\s+foreign key \(pinned_by\)\s+references auth\.users\(id\)\s+on update no action\s+on delete set null\s+not deferrable;/i.test(pinSql), "FK pinned_by не совпадает с production");
assert(pinSql.includes("c.conkey = array["), "FK-проверка не сверяет исходную колонку");
assert(pinSql.includes("c.confrelid = 'auth.users'::regclass"), "FK-проверка не сверяет auth.users");
assert(pinSql.includes("c.confkey = array["), "FK-проверка не сверяет auth.users(id)");
assert(pinSql.includes("c.confupdtype = 'a'"), "FK-проверка не сверяет ON UPDATE NO ACTION");
assert(pinSql.includes("c.confdeltype = 'n'"), "FK-проверка не сверяет ON DELETE SET NULL");
assert(pinSql.includes("not c.condeferrable") && pinSql.includes("not c.condeferred"), "FK-проверка не сверяет deferrability");
assert(/create unique index idx_chat_messages_single_pinned\s+on public\.chat_messages using btree \(is_pinned\)\s+where \(is_pinned = true\);/i.test(pinSql), "нет production unique partial index для единственного закрепления");
assert(/create index idx_chat_messages_pinned_at\s+on public\.chat_messages using btree \(pinned_at desc\)\s+where \(is_pinned = true\);/i.test(pinSql), "нет production partial index по pinned_at");
assert(!pinSql.includes("pg_get_indexdef"), "проверка индексов не должна зависеть от форматирования pg_get_indexdef()");
for (const marker of [
  "i.indrelid = 'public.chat_messages'::regclass",
  "access_method.amname = 'btree'",
  "i.indnkeyatts = 1",
  "i.indnatts = 1",
  "i.indexprs is null",
  "i.indpred is not null",
  "pg_get_expr(i.indpred, i.indrelid, false)",
  "i.indisvalid",
  "i.indisready",
  "i.indislive"
]) {
  assert(pinSql.includes(marker), `структурная проверка индекса не содержит ${marker}`);
}
assert(pinSql.includes("and not i.indisunique"), "pinned_at index должен быть non-unique");
assert(pinSql.includes("and i.indisunique"), "single pinned index должен быть unique");
assert(pinSql.includes("a.attname = 'pinned_at'"), "pinned_at index не сверяет ключевую колонку");
assert(pinSql.includes("a.attname = 'is_pinned'"), "single pinned index не сверяет ключевую колонку");
assert(pinSql.includes("(i.indoption[0] & 1) = 1"), "pinned_at index не сверяет DESC");
assert(pinSql.includes("(i.indoption[0] & 1) = 0"), "single pinned index не сверяет обычный порядок");
assert(pinSql.includes("'is_pinned=true'"), "partial predicate не сверяется логически");
assert(!/idx_chat_messages_(active_created_at|archived_at)/.test(pinSql), "архивные индексы не должны дублироваться в chat-pinning.sql");
assert((archiveSql.match(/idx_chat_messages_active_created_at/g) || []).length === 1, "active archive index должен определяться один раз");
assert((archiveSql.match(/idx_chat_messages_archived_at/g) || []).length === 1, "archived index должен определяться один раз");

assert(pinSql.includes("a.atttypid = 'pg_catalog.bool'::regtype"), "is_pinned type не проверяется");
assert(pinSql.includes("a.atttypid = 'pg_catalog.timestamptz'::regtype"), "pinned_at type не проверяется");
assert(pinSql.includes("a.atttypid = 'pg_catalog.uuid'::regtype"), "pinned_by type не проверяется");
assert(pinSql.includes("pg_get_expr(d.adbin, d.adrelid)"), "DEFAULT false не проверяется");
assert(pinSql.includes("raise exception 'Schema conflict: public.chat_messages.is_pinned"), "конфликт is_pinned не останавливает миграцию");
assert(pinSql.includes("raise exception 'Schema conflict: public.chat_messages.pinned_at"), "конфликт pinned_at не останавливает миграцию");
assert(pinSql.includes("raise exception 'Schema conflict: public.chat_messages.pinned_by"), "конфликт pinned_by не останавливает миграцию");
assert(pinSql.includes("raise exception 'Schema conflict: chat_messages_pinned_by_fkey"), "конфликт FK не останавливает миграцию");
assert(pinSql.includes("raise exception 'Schema conflict: idx_chat_messages_pinned_at"), "конфликт pinned_at index не останавливает миграцию");
assert(pinSql.includes("raise exception 'Schema conflict: idx_chat_messages_single_pinned"), "конфликт unique index не останавливает миграцию");
assert(!/drop\s+(constraint|index)/i.test(pinSql), "конфликтующие FK/индексы нельзя исправлять автоматически");

for (const [name, source] of [["pin", pinFunction], ["unpin", unpinFunction], ["revoke", revokeFunction]]) {
  assert(source.includes("security definer"), `${name}: отсутствует SECURITY DEFINER`);
  assert(source.includes("set search_path to 'public', 'pg_temp'"), `${name}: неверный search_path`);
  assert(source.includes("if not public.is_admin() then"), `${name}: отсутствует проверка администратора`);
  assert(source.includes("raise exception 'Administrator access required'"), `${name}: отсутствует production-ошибка доступа`);
}

assert(pinFunction.includes("where is_pinned = true;"), "pin должен снять прежнее закрепление");
assert(pinFunction.includes("pinned_at = now()"), "pin должен записать pinned_at");
assert(pinFunction.includes("pinned_by = auth.uid()"), "pin должен записать pinned_by");
assert(pinFunction.includes("where id = p_message_id\n  returning * into v_message;"), "pin должен вернуть выбранное сообщение");
assert(unpinFunction.includes("pinned_at = null") && unpinFunction.includes("pinned_by = null"), "unpin должен очистить метаданные закрепления");
assert(revokeFunction.includes("if v_role = 'ADMIN'::public.member_role then"), "revoke должен защищать ADMIN от удаления");
assert(revokeFunction.includes("delete from public.class_members"), "revoke должен удалить доступ родителя");
assert(revokeFunction.includes("delete from public.access_requests"), "revoke должен удалить заявку");

assertProductionGrants(pinSql, "pin_class_chat_message(uuid)");
assertProductionGrants(pinSql, "unpin_class_chat_message()");
assertProductionGrants(accessSql, "revoke_class_access(uuid)");

assert(snapshotSql.includes("where archived_at is null or public.is_admin()"), "канонический snapshot не фильтрует архив для родителя");
assert(snapshotSql.includes("order by created_at desc, id desc\n        limit 120"), "snapshot потерял production-сортировку или LIMIT 120");

for (const marker of [
  "add column if not exists is_pinned",
  "add column if not exists pinned_at",
  "add column if not exists pinned_by",
  "v_constraint_oid is null",
  "v_index_oid is null",
  "create or replace function public.pin_class_chat_message",
  "create or replace function public.unpin_class_chat_message"
]) {
  assert(pinSql.includes(marker), `повторный запуск не защищён: отсутствует ${marker}`);
}
assert(accessSql.includes("create or replace function public.revoke_class_access"), "revoke RPC должна безопасно переопределяться");

assert.equal(schemaDecision(undefined, expectedColumns.is_pinned, "is_pinned"), "create", "отсутствующая колонка должна создаваться");
assert.equal(schemaDecision(expectedColumns.is_pinned, expectedColumns.is_pinned, "is_pinned"), "accept", "правильная колонка должна приниматься");
assert.throws(
  () => schemaDecision({ ...expectedColumns.is_pinned, nullable: true }, expectedColumns.is_pinned, "is_pinned"),
  /Schema conflict: is_pinned/,
  "неправильная колонка должна останавливать миграцию"
);
assert.equal(schemaDecision(expectedFk, expectedFk, "chat_messages_pinned_by_fkey"), "accept", "правильный FK должен приниматься");
assert.throws(
  () => schemaDecision({ ...expectedFk, onDelete: "CASCADE" }, expectedFk, "chat_messages_pinned_by_fkey"),
  /Schema conflict: chat_messages_pinned_by_fkey/,
  "неправильный одноимённый FK должен останавливать миграцию"
);
for (const [indexName, structure] of Object.entries(expectedIndexes)) {
  assert.equal(schemaDecision(structure, structure, indexName), "accept", `${indexName}: правильный индекс должен приниматься`);
  assert.throws(
    () => schemaDecision({ ...structure, predicate: null }, structure, indexName),
    new RegExp(`Schema conflict: ${indexName}`),
    `${indexName}: неправильный одноимённый индекс должен останавливать миграцию`
  );
}
assert.equal(expectedIndexes.idx_chat_messages_single_pinned.unique, true, "single pinned index должен быть UNIQUE");
assert.equal(expectedIndexes.idx_chat_messages_single_pinned.predicate, "is_pinned = true", "single pinned index должен быть partial");
assert.throws(
  () => schemaDecision(
    { ...expectedIndexes.idx_chat_messages_single_pinned, unique: false },
    expectedIndexes.idx_chat_messages_single_pinned,
    "idx_chat_messages_single_pinned"
  ),
  /Schema conflict: idx_chat_messages_single_pinned/,
  "single pinned index без UNIQUE должен отклоняться"
);
assert.equal(expectedIndexes.idx_chat_messages_pinned_at.unique, false, "pinned_at index не должен быть UNIQUE");
assert.deepEqual(expectedIndexes.idx_chat_messages_pinned_at.descending, [true], "pinned_at index должен использовать DESC");

for (const [columnName, definition] of Object.entries(expectedColumns)) {
  assert.equal(schemaDecision(definition, definition, columnName), "accept", `${columnName}: повторный запуск должен быть безопасен`);
}
assert.equal(schemaDecision(expectedFk, expectedFk, "chat_messages_pinned_by_fkey"), "accept");
for (const [indexName, structure] of Object.entries(expectedIndexes)) {
  assert.equal(schemaDecision(structure, structure, indexName), "accept", `${indexName}: повторный запуск должен быть безопасен`);
}

console.log("production chat RPC schema sync checks: PASS");
