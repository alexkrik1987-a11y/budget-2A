"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const sql = fs.readFileSync("class-presence.sql", "utf8");

const expectedPolicies = {
  "Approved class members listen to class presence": {
    permissive: true,
    command: "SELECT",
    roles: ["authenticated"],
    using: "topic='class:2a:presence'andextension='presence'andcan_access_budget",
    withCheck: null
  },
  "Approved class members track class presence": {
    permissive: true,
    command: "INSERT",
    roles: ["authenticated"],
    using: null,
    withCheck: "topic='class:2a:presence'andextension='presence'andcan_access_budget"
  }
};

function policyDecision(name, actual) {
  if (actual === undefined) return "create";
  if (JSON.stringify(actual) !== JSON.stringify(expectedPolicies[name])) {
    throw new Error(`policy ${name} has an unexpected definition`);
  }
  return "accept";
}

for (const marker of [
  "to_regnamespace('realtime') is null",
  "to_regclass('realtime.messages') is null",
  "relation.relkind = 'p'",
  "relation.relrowsecurity",
  "attribute.attname = 'topic'",
  "attribute.attname = 'extension'",
  "attribute.atttypid = 'pg_catalog.text'::regtype",
  "attribute.attnotnull",
  "where role.rolname = 'authenticated'",
  "to_regprocedure('realtime.topic()')",
  "procedure.prorettype = 'pg_catalog.text'::regtype",
  "not procedure.prosecdef",
  "to_regprocedure('public.can_access_budget()')",
  "procedure.prorettype = 'pg_catalog.bool'::regtype",
  "procedure.prosecdef",
  "procedure.proconfig @> array['search_path=public']::text[]",
  "has_function_privilege(v_authenticated_oid, v_topic_function_oid, 'EXECUTE')",
  "has_function_privilege(v_authenticated_oid, v_access_function_oid, 'EXECUTE')",
  "from pg_policy as policy",
  "policy.polpermissive",
  "policy.polcmd",
  "policy.polroles",
  "pg_get_expr(policy.polqual, policy.polrelid, false)",
  "pg_get_expr(policy.polwithcheck, policy.polrelid, false)",
  "v_policy_roles <> array[v_authenticated_oid]",
  "raise exception 'Presence conflict: policy \"%\" on realtime.messages has an unexpected definition'"
]) {
  assert(sql.includes(marker), `Presence SQL не содержит обязательную fail-closed проверку: ${marker}`);
}

const createPolicies = [...sql.matchAll(/create\s+policy\s+"([^"]+)"/gi)].map((match) => match[1]);
assert.deepEqual(
  createPolicies.sort(),
  Object.keys(expectedPolicies).sort(),
  "SQL должен создавать ровно две согласованные policy"
);
assert.equal(createPolicies.length, 2, "в SQL должно быть ровно две CREATE POLICY");

assert(/create policy "Approved class members listen to class presence"\s+on realtime\.messages for select to authenticated\s+using \(\s*\(select realtime\.topic\(\)\) = 'class:2a:presence'\s+and realtime\.messages\.extension = 'presence'\s+and public\.can_access_budget\(\)\s*\);/i.test(sql), "SELECT policy должна иметь точный topic, extension и access gate");
assert(/create policy "Approved class members track class presence"\s+on realtime\.messages for insert to authenticated\s+with check \(\s*\(select realtime\.topic\(\)\) = 'class:2a:presence'\s+and realtime\.messages\.extension = 'presence'\s+and public\.can_access_budget\(\)\s*\);/i.test(sql), "INSERT policy должна иметь точный topic, extension и access gate");

assert.equal((sql.match(/'class:2a:presence'/g) || []).length >= 4, true, "topic должен проверяться в обеих policy и их ожидаемых моделях");
assert.equal((sql.match(/'presence'/g) || []).length >= 4, true, "extension presence должна проверяться в обеих policy и их ожидаемых моделях");
assert(!/\bto\s+(?:anon|public|service_role)\b/i.test(sql), "policy не должны выдаваться anon, PUBLIC или service_role");
assert(!/for\s+(?:update|delete)\b/i.test(sql), "UPDATE/DELETE policy создавать нельзя");
assert(!/drop\s+policy/i.test(sql), "существующие policy нельзя удалять");
assert(!/\b(?:grant|revoke)\b/i.test(sql), "SQL не должен менять grants");
assert(!/(?:create|alter|drop)\s+publication/i.test(sql), "SQL не должен менять publication");
assert(!/class-budget-live/i.test(sql), "SQL не должен затрагивать frontend channel class-budget-live");

for (const [name, expected] of Object.entries(expectedPolicies)) {
  assert.equal(policyDecision(name, undefined), "create", `${name}: отсутствующая policy должна создаваться`);
  assert.equal(policyDecision(name, expected), "accept", `${name}: правильная policy должна приниматься`);
  assert.equal(policyDecision(name, expected), "accept", `${name}: повторное применение должно быть безопасно`);
  assert.throws(
    () => policyDecision(name, { ...expected, roles: ["anon"] }),
    /unexpected definition/,
    `${name}: конфликтующая роль должна останавливать применение`
  );
  assert.throws(
    () => policyDecision(name, { ...expected, command: "UPDATE" }),
    /unexpected definition/,
    `${name}: конфликтующая команда должна останавливать применение`
  );
  const alteredExpression = expected.using
    ? { ...expected, using: `${expected.using}ortrue` }
    : { ...expected, withCheck: `${expected.withCheck}ortrue` };
  assert.throws(
    () => policyDecision(name, alteredExpression),
    /unexpected definition/,
    `${name}: расширенное условие должно отклоняться`
  );
}

console.log("class Presence SQL checks: PASS");
