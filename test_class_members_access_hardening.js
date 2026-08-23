"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const schemaSql = fs.readFileSync("supabase.sql", "utf8");
const accessSql = fs.readFileSync("parent-access-requests.sql", "utf8");

const rlsPosition = schemaSql.indexOf("alter table public.class_members enable row level security;");
const hardeningStart = schemaSql.indexOf("-- class_members читается только через SECURITY DEFINER RPC");
const hardeningEnd = schemaSql.indexOf("alter table public.students enable row level security;", hardeningStart);

assert(rlsPosition >= 0, "RLS для public.class_members должен включаться");
assert(hardeningStart > rlsPosition, "hardening должен выполняться после включения RLS");
assert(hardeningEnd > hardeningStart, "не найден конец hardening-блока class_members");

const hardeningSql = schemaSql.slice(hardeningStart, hardeningEnd);

for (const marker of [
  "from pg_class as relation",
  "relation.relrowsecurity",
  "from pg_policy as policy",
  "policy.polrelid = 'public.class_members'::regclass",
  "policy.polname = 'Allow public read'",
  "policy.polpermissive",
  "policy.polcmd",
  "policy.polroles",
  "pg_get_expr(policy.polqual, policy.polrelid, false)",
  "pg_get_expr(policy.polwithcheck, policy.polrelid, false)",
  "raise exception 'Security conflict: RLS is not enabled for public.class_members'",
  "raise exception 'Security conflict: policy \"Allow public read\" on public.class_members has an unexpected definition'",
  "drop policy \"Allow public read\" on public.class_members;",
  "revoke all on table public.class_members from public, anon, authenticated;"
]) {
  assert(hardeningSql.includes(marker), `hardening SQL не содержит обязательную проверку: ${marker}`);
}

assert(hardeningSql.includes("v_policy_command <> 'r'"), "policy должна быть только FOR SELECT");
assert(hardeningSql.includes("v_policy_roles <> array[0::oid]"), "policy должна относиться только к PUBLIC");
assert(hardeningSql.includes("<> 'true'"), "policy должна иметь USING (true)");
assert(hardeningSql.includes("v_policy_with_check is not null"), "WITH CHECK должен отсутствовать");
assert(!/create\s+policy/i.test(hardeningSql), "hardening не должен создавать разрешающую policy");
assert(!/service_role/i.test(hardeningSql), "hardening не должен менять права service_role");
assert(!/\bpostgres\b/i.test(hardeningSql), "hardening не должен менять права postgres");
assert.equal(
  (hardeningSql.match(/revoke\s+all\s+on\s+table/gi) || []).length,
  1,
  "должен быть ровно один узкий REVOKE для class_members"
);
assert(!/create\s+or\s+replace\s+function|alter\s+function|drop\s+function/i.test(hardeningSql), "hardening не должен менять RPC");

function hardeningDecision({ rlsEnabled = true, policy } = {}) {
  if (!rlsEnabled) throw new Error("RLS is not enabled");
  if (policy === undefined) return "accept";
  const expectedPolicy = {
    permissive: true,
    command: "SELECT",
    roles: ["PUBLIC"],
    using: true,
    withCheck: null
  };
  if (JSON.stringify(policy) !== JSON.stringify(expectedPolicy)) {
    throw new Error('policy "Allow public read" has an unexpected definition');
  }
  return "drop";
}

const expectedLegacyPolicy = {
  permissive: true,
  command: "SELECT",
  roles: ["PUBLIC"],
  using: true,
  withCheck: null
};

assert.equal(hardeningDecision({ policy: expectedLegacyPolicy }), "drop", "ожидаемая legacy-policy должна удаляться");
assert.equal(hardeningDecision({ policy: undefined }), "accept", "отсутствующая policy должна приниматься");
assert.equal(hardeningDecision({ policy: undefined }), "accept", "повторное применение правильного состояния должно быть безопасно");
assert.throws(() => hardeningDecision({ rlsEnabled: false }), /RLS is not enabled/, "выключенный RLS должен останавливать применение");
assert.throws(
  () => hardeningDecision({ policy: { ...expectedLegacyPolicy, roles: ["authenticated"] } }),
  /unexpected definition/,
  "неожиданная одноимённая policy должна отклоняться"
);
assert.throws(
  () => hardeningDecision({ policy: { ...expectedLegacyPolicy, using: false } }),
  /unexpected definition/,
  "policy с другим USING должна отклоняться"
);
assert.throws(
  () => hardeningDecision({ policy: { ...expectedLegacyPolicy, withCheck: true } }),
  /unexpected definition/,
  "policy с WITH CHECK должна отклоняться"
);

function extractFunction(sql, name) {
  const start = sql.indexOf(`create or replace function public.${name}`);
  assert.notEqual(start, -1, `${name} не определена`);
  const dollarTagMatch = sql.slice(start).match(/as (\$[a-z_]*\$)/i);
  assert(dollarTagMatch, `не найдено тело ${name}`);
  const bodyStart = start + dollarTagMatch.index;
  const end = sql.indexOf(`${dollarTagMatch[1]};`, bodyStart);
  assert.notEqual(end, -1, `не найден конец ${name}`);
  return sql.slice(start, end + dollarTagMatch[1].length + 1);
}

for (const [sql, signature] of [
  [schemaSql, "can_access_budget()"],
  [schemaSql, "is_admin()"],
  [accessSql, "approve_access_request(p_request_id uuid)"],
  [accessSql, "revoke_class_access(p_request_id uuid)"]
]) {
  const rpc = extractFunction(sql, signature);
  assert(/security definer/i.test(rpc), `${signature} должна оставаться SECURITY DEFINER`);
}

console.log("class_members access hardening checks: PASS");
