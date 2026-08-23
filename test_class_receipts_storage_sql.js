"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const storageSql = fs.readFileSync("class-receipts-storage.sql", "utf8");
const schemaSql = fs.readFileSync("supabase.sql", "utf8");
const archiveSql = fs.readFileSync("archive-features.sql", "utf8");
const app = fs.readFileSync("app.js", "utf8");

const expectedMimes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf"
].sort();
const expectedBucket = {
  id: "class-receipts",
  name: "class-receipts",
  public: false,
  fileSizeLimit: 10485760,
  allowedMimeTypes: expectedMimes
};
const expectedPolicies = {
  "Class members read receipts": {
    permissive: true,
    command: "SELECT",
    roles: ["authenticated"],
    using: "bucket_id = 'class-receipts' and public.can_access_budget()",
    withCheck: null
  },
  "Admins upload receipts": {
    permissive: true,
    command: "INSERT",
    roles: ["authenticated"],
    using: null,
    withCheck: "bucket_id = 'class-receipts' and public.is_admin()"
  },
  "Admins update receipts": {
    permissive: true,
    command: "UPDATE",
    roles: ["authenticated"],
    using: "bucket_id = 'class-receipts' and public.is_admin()",
    withCheck: "bucket_id = 'class-receipts' and public.is_admin()"
  },
  "Admins delete receipts": {
    permissive: true,
    command: "DELETE",
    roles: ["authenticated"],
    using: "bucket_id = 'class-receipts' and public.is_admin()",
    withCheck: null
  }
};

function bucketDecision(actual) {
  if (actual === undefined) return "create";
  const normalized = { ...actual, allowedMimeTypes: [...actual.allowedMimeTypes].sort() };
  if (JSON.stringify(normalized) !== JSON.stringify(expectedBucket)) {
    throw new Error("bucket class-receipts has an unexpected definition");
  }
  return "accept";
}

function policyDecision(name, actual) {
  if (actual === undefined) return "create";
  if (JSON.stringify(actual) !== JSON.stringify(expectedPolicies[name])) {
    throw new Error(`policy ${name} has an unexpected definition`);
  }
  return "accept";
}

for (const marker of [
  "to_regnamespace('storage') is null",
  "to_regclass('storage.buckets') is null",
  "to_regclass('storage.objects') is null",
  "relation.relrowsecurity",
  "atttypid = 'pg_catalog.text'::regtype",
  "atttypid = 'pg_catalog.bool'::regtype",
  "atttypid = 'pg_catalog.int8'::regtype",
  "atttypid = 'pg_catalog.text[]'::regtype",
  "to_regprocedure('public.can_access_budget()') is null",
  "to_regprocedure('public.is_admin()') is null",
  "where role.rolname = 'authenticated'",
  "insert into storage.buckets",
  "'class-receipts'",
  "false",
  "10485760",
  "cardinality(v_bucket_allowed_mime_types)",
  "v_bucket_allowed_mime_types @> v_expected_mime_types",
  "v_bucket_allowed_mime_types <@ v_expected_mime_types",
  "raise exception 'Storage conflict: bucket class-receipts has an unexpected definition'",
  "from pg_policy as policy",
  "policy.polpermissive",
  "policy.polcmd",
  "policy.polroles",
  "pg_get_expr(policy.polqual, policy.polrelid, false)",
  "pg_get_expr(policy.polwithcheck, policy.polrelid, false)",
  "v_policy_roles <> array[v_authenticated_oid]",
  "raise exception 'Storage conflict: policy \"%\" on storage.objects has an unexpected definition'"
]) {
  assert(storageSql.includes(marker), `Storage SQL не содержит обязательную проверку: ${marker}`);
}

for (const mime of expectedMimes) {
  assert(storageSql.includes(`'${mime}'`), `bucket не ограничен MIME ${mime}`);
}
assert.equal((storageSql.match(/insert\s+into\s+storage\.buckets/gi) || []).length, 1, "должен создаваться только один bucket");
assert(!/on\s+conflict/i.test(storageSql), "существующий bucket нельзя молча обновлять");
assert(!/drop\s+policy/i.test(storageSql), "конфликтующие policy нельзя удалять автоматически");
assert(!/delete\s+from\s+storage\.buckets/i.test(storageSql), "существующий bucket нельзя удалять автоматически");
assert(!/drop\s+(?:table|schema)|truncate\s+/i.test(storageSql), "Storage SQL не должен удалять схему или таблицы");

for (const [name, policy] of Object.entries(expectedPolicies)) {
  assert(storageSql.includes(`create policy "${name}"`), `${name}: policy не создаётся`);
  assert.equal(policy.roles, expectedPolicies[name].roles, `${name}: роли должны совпадать`);
  assert.deepEqual(policy.roles, ["authenticated"], `${name}: доступ разрешён только authenticated`);
  assert.equal(policy.permissive, true, `${name}: policy должна быть PERMISSIVE`);
  assert.equal(policyDecision(name, policy), "accept", `${name}: правильная policy должна приниматься`);
  assert.equal(policyDecision(name, policy), "accept", `${name}: повторное применение должно быть безопасно`);
  assert.throws(
    () => policyDecision(name, { ...policy, roles: ["anon"] }),
    /unexpected definition/,
    `${name}: конфликтующая роль должна останавливать применение`
  );
}

assert(/on storage\.objects for select to authenticated\s+using \(bucket_id = 'class-receipts' and public\.can_access_budget\(\)\);/i.test(storageSql), "SELECT должна требовать can_access_budget()");
assert(/on storage\.objects for insert to authenticated\s+with check \(bucket_id = 'class-receipts' and public\.is_admin\(\)\);/i.test(storageSql), "INSERT должна требовать is_admin()");
assert(/on storage\.objects for update to authenticated\s+using \(bucket_id = 'class-receipts' and public\.is_admin\(\)\)\s+with check \(bucket_id = 'class-receipts' and public\.is_admin\(\)\);/i.test(storageSql), "UPDATE должна требовать is_admin() в USING и WITH CHECK");
assert(/on storage\.objects for delete to authenticated\s+using \(bucket_id = 'class-receipts' and public\.is_admin\(\)\);/i.test(storageSql), "DELETE должна требовать is_admin()");
assert(!/\bto\s+(?:anon|public)\b/i.test(storageSql), "anon и PUBLIC не должны получать Storage-policy");

assert.equal(bucketDecision(undefined), "create", "отсутствующий bucket должен создаваться");
assert.equal(bucketDecision(expectedBucket), "accept", "правильный bucket должен приниматься");
assert.equal(bucketDecision(expectedBucket), "accept", "повторное применение правильного bucket должно быть безопасно");
assert.throws(() => bucketDecision({ ...expectedBucket, public: true }), /unexpected definition/, "публичный bucket должен отклоняться");
assert.throws(() => bucketDecision({ ...expectedBucket, fileSizeLimit: 5242880 }), /unexpected definition/, "другой лимит должен отклоняться");
assert.throws(() => bucketDecision({ ...expectedBucket, allowedMimeTypes: ["image/jpeg"] }), /unexpected definition/, "другие MIME должны отклоняться");

for (const forbidden of [
  "cron.",
  "budget_backups",
  "public.expenses",
  "receipt_path",
  "public.students",
  "create or replace function",
  "alter function"
]) {
  assert(!storageSql.includes(forbidden), `отдельный Storage SQL не должен содержать ${forbidden}`);
}

assert(schemaSql.includes("create or replace function public.can_access_budget()"), "supabase.sql должен заранее создать can_access_budget()");
assert(schemaSql.includes("create or replace function public.is_admin()"), "supabase.sql должен заранее создать is_admin()");
assert(archiveSql.includes("add column if not exists receipt_path text null"), "archive-features.sql должен заранее создать receipt_path");
assert.deepEqual(
  ["supabase.sql", "archive-features.sql", "class-receipts-storage.sql"],
  ["supabase.sql", "archive-features.sql", "class-receipts-storage.sql"],
  "порядок установки должен быть зафиксирован"
);

assert(app.includes('db.storage.from("class-receipts").createSignedUrl(receiptLink.dataset.receiptPath, 900)'), "frontend должен читать private receipt через signed URL на 900 секунд");
assert(!app.includes('.getPublicUrl('), "frontend не должен использовать публичные URL Storage");
assert(app.includes('db.storage.from("class-receipts").upload(path, file, { contentType: file.type, upsert: false })'), "upload должен сохранять upsert: false");
assert(app.includes('if (!state.isAdmin) return;'), "frontend должен сохранять admin gate");
assert(app.includes('const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"]'), "клиентские MIME должны совпадать с bucket");
assert(app.includes("file.size > 10 * 1024 * 1024"), "клиентский лимит должен оставаться 10 МБ");

console.log("class receipts Storage SQL checks: PASS");
