"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const app = fs.readFileSync("app.js", "utf8");
const sql = fs.readFileSync("archive-features.sql", "utf8");

const createTablePosition = sql.indexOf("create table if not exists public.class_profile");
const grantsPosition = sql.indexOf("grant select, update on public.class_profile to authenticated;");
const realtimeBlockStart = sql.indexOf("-- Realtime-подписка frontend на class_profile");
const realtimeBlockEnd = sql.indexOf("-- 2. Самодостаточное восстановление", realtimeBlockStart);

assert(createTablePosition >= 0, "archive-features.sql не создаёт class_profile");
assert(grantsPosition > createTablePosition, "class_profile grants должны идти после создания таблицы");
assert(realtimeBlockStart > grantsPosition, "Realtime membership должна проверяться после таблицы, RLS и grants");
assert(realtimeBlockEnd > realtimeBlockStart, "не найден конец class_profile Realtime-блока");

const realtimeSql = sql.slice(realtimeBlockStart, realtimeBlockEnd);

assert(app.includes('.channel("class-budget-live")'), "frontend должен сохранять существующий class-budget-live");
assert(
  app.includes('.on("postgres_changes", { event: "*", schema: "public", table: "class_profile" }, scheduleRealtimeRefresh)'),
  "frontend не подписывается на public.class_profile"
);

for (const marker of [
  "from pg_publication as publication",
  "publication.pubname = 'supabase_realtime'",
  "if not found then",
  "if v_puballtables then",
  "to_regclass('public.class_profile') is null",
  "from pg_publication_tables as published",
  "published.schemaname = 'public'",
  "published.tablename = 'class_profile'",
  "from pg_publication_rel as relation",
  "relation.prattrs",
  "relation.prqual::text",
  "v_published_attnames @> v_expected_attnames",
  "v_published_attnames <@ v_expected_attnames",
  "v_rowfilter is not null"
]) {
  assert(realtimeSql.includes(marker), `Realtime SQL не содержит обязательную metadata-проверку: ${marker}`);
}

assert(/alter publication supabase_realtime\s+add table public\.class_profile;/i.test(realtimeSql), "отсутствующая membership не добавляется");
assert(!/drop\s+publication/i.test(realtimeSql), "нельзя удалять publication");
assert(!/create\s+publication/i.test(realtimeSql), "нельзя пересоздавать publication");
assert(!/alter\s+publication[\s\S]*?\bset\s+(?:table|tables\b)/i.test(realtimeSql), "нельзя заменять таблицы publication через SET");
assert(!/alter\s+publication[\s\S]*?\bdrop\s+table/i.test(realtimeSql), "нельзя удалять другие publication tables");
assert.equal((realtimeSql.match(/alter publication/gi) || []).length, 1, "Realtime-блок должен менять только class_profile membership");
for (const otherTable of ["students", "campaigns", "contributions", "expenses", "chat_messages", "access_requests"]) {
  assert(!new RegExp(`(?:add|drop|set)\\s+table\\s+public\\.${otherTable}`, "i").test(realtimeSql), `Realtime-блок не должен менять ${otherTable}`);
}

const fullColumns = ["id", "class_name", "school_year", "updated_by", "updated_at"];
function membershipDecision({ publicationExists = true, puballtables = false, tableExists = true, membership } = {}) {
  if (!publicationExists) throw new Error("publication supabase_realtime does not exist");
  if (puballtables) throw new Error("unexpectedly publishes all tables");
  if (!tableExists) throw new Error("public.class_profile does not exist");
  if (membership === undefined) return "add";
  const publishedColumns = [...membership.attnames].sort();
  const expectedColumns = [...fullColumns].sort();
  if (
    JSON.stringify(publishedColumns) !== JSON.stringify(expectedColumns)
    || membership.rowfilter !== null
    || membership.directPrattrs !== null
    || membership.directPrqual !== null
  ) {
    throw new Error("unexpected column list or row filter");
  }
  return "accept";
}

const correctMembership = {
  attnames: fullColumns,
  rowfilter: null,
  directPrattrs: null,
  directPrqual: null
};

assert.equal(membershipDecision({ membership: undefined }), "add", "отсутствующая membership должна добавляться");
assert.equal(membershipDecision({ membership: correctMembership }), "accept", "правильная membership должна приниматься");
assert.equal(membershipDecision({ membership: correctMembership }), "accept", "повторное применение должно быть безопасным");
assert.throws(
  () => membershipDecision({ membership: { ...correctMembership, attnames: ["id", "class_name"] } }),
  /unexpected column list/,
  "ограниченный attnames должен отклоняться"
);
assert.throws(
  () => membershipDecision({ membership: { ...correctMembership, rowfilter: "(id = true)" } }),
  /unexpected column list/,
  "rowfilter должен отклоняться"
);
assert.throws(
  () => membershipDecision({ membership: { ...correctMembership, directPrattrs: "1 2" } }),
  /unexpected column list/,
  "явный column list должен отклоняться, даже если pg_publication_tables разворачивает имена"
);
assert.throws(() => membershipDecision({ publicationExists: false }), /does not exist/);
assert.throws(() => membershipDecision({ puballtables: true }), /publishes all tables/);
assert.throws(() => membershipDecision({ tableExists: false }), /class_profile does not exist/);

console.log("class_profile realtime SQL checks: PASS");
