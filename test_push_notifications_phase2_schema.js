'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const sqlPath = path.join(__dirname, 'push-notifications-phase2.sql');
const sql = fs.readFileSync(sqlPath, 'utf8');

function countMatches(text, regex) {
  return [...text.matchAll(regex)].length;
}

function compact(text) {
  return text.toLowerCase().replace(/\s+/g, '');
}

function maskDollarBody(text, tag) {
  const open = `as $${tag}$`;
  const close = `$${tag}$;`;
  const openIndex = text.indexOf(open);
  assert(openIndex >= 0, `Missing ${open} marker`);
  assert.strictEqual(text.indexOf(open, openIndex + open.length), -1, `Duplicate ${open} marker`);
  const bodyStart = openIndex + open.length;
  const closeIndex = text.indexOf(close, bodyStart);
  assert(closeIndex >= 0, `Missing ${close} marker`);
  assert.strictEqual(text.indexOf(close, closeIndex + close.length), -1, `Duplicate ${close} marker`);
  return `${text.slice(0, bodyStart)}\n/* ${tag} RPC body masked */\n${text.slice(closeIndex)}`;
}

function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '');
}

function extractBalancedParentheses(text, openingIndex) {
  let depth = 0;
  let quote = false;

  for (let index = openingIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quote) {
      if (char === "'" && next === "'") {
        index += 1;
      } else if (char === "'") {
        quote = false;
      }
      continue;
    }

    if (char === "'") {
      quote = true;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openingIndex + 1, index);
      assert(depth >= 0, 'Unexpected closing parenthesis in CREATE TABLE');
    }
  }

  assert.fail('Unclosed CREATE TABLE parenthesis');
}

function splitTopLevel(text) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quote) {
      if (char === "'" && next === "'") {
        index += 1;
      } else if (char === "'") {
        quote = false;
      }
      continue;
    }

    if (char === "'") quote = true;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }

  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

const transactionBegin = [...sql.matchAll(/^begin;$/gim)];
const transactionCommit = [...sql.matchAll(/^commit;$/gim)];
assert.strictEqual(transactionBegin.length, 1, 'Expected exactly one transaction BEGIN');
assert.strictEqual(transactionCommit.length, 1, 'Expected exactly one transaction COMMIT');

const notifyIndex = sql.search(/^notify\s+pgrst\s*,\s*'reload schema';$/im);
const commitIndex = transactionCommit[0].index;
assert(notifyIndex >= 0, 'NOTIFY pgrst reload schema is missing');
assert(notifyIndex < commitIndex, 'NOTIFY pgrst must precede COMMIT');

const tableDeclaration = 'create table if not exists public.notification_deliveries';
assert.strictEqual(
  countMatches(sql, /create\s+table\s+if\s+not\s+exists\s+public\.notification_deliveries\s*\(/gi),
  1,
  'Expected exactly one notification_deliveries CREATE TABLE'
);
const tableStart = sql.toLowerCase().indexOf(tableDeclaration);
assert(tableStart >= 0, 'notification_deliveries CREATE TABLE is missing');
const tableOpen = sql.indexOf('(', tableStart + tableDeclaration.length);
const tableBody = extractBalancedParentheses(sql, tableOpen);
const tableEntries = splitTopLevel(tableBody);
const columns = tableEntries.filter((entry) => !/^constraint\b/i.test(entry));
const constraints = tableEntries.filter((entry) => /^constraint\b/i.test(entry));

const expectedColumns = [
  'id uuid not null default gen_random_uuid()',
  'event_id uuid not null',
  'subscription_id uuid null',
  'subscription_ref uuid not null',
  "status text not null default 'queued'",
  'attempt_count integer not null default 0',
  'last_http_status smallint null',
  'last_error_code varchar(64) null',
  'claim_token uuid null',
  'claimed_at timestamptz null',
  'next_attempt_at timestamptz null',
  'sent_at timestamptz null',
  'created_at timestamptz not null default now()',
  'updated_at timestamptz not null default now()'
].map(compact);

assert.strictEqual(columns.length, 14, 'notification_deliveries must have exactly 14 columns');
assert.deepStrictEqual(columns.map(compact), expectedColumns, 'Column order/type/nullability/default contract drifted');

const expectedConstraints = [
  'constraint notification_deliveries_pkey primary key (id)',
  'constraint notification_deliveries_event_fkey foreign key (event_id) references public.notification_events(id) on delete restrict',
  'constraint notification_deliveries_subscription_fkey foreign key (subscription_id) references public.push_subscriptions(id) on delete set null',
  'constraint notification_deliveries_event_subscription_ref_key unique (event_id, subscription_ref)',
  'constraint notification_deliveries_subscription_ref_matches check (subscription_id is null or subscription_ref = subscription_id)',
  "constraint notification_deliveries_status_check check (status in ('queued', 'sending', 'sent', 'expired', 'failed', 'skipped'))",
  'constraint notification_deliveries_attempt_count_check check (attempt_count between 0 and 5)',
  'constraint notification_deliveries_http_status_check check (last_http_status is null or last_http_status between 100 and 599)',
  "constraint notification_deliveries_error_code_check check (last_error_code is null or (char_length(last_error_code) between 1 and 64 and last_error_code ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$'))",
  "constraint notification_deliveries_claim_state_check check ((status = 'sending' and claim_token is not null and claimed_at is not null) or (status <> 'sending' and claim_token is null))",
  "constraint notification_deliveries_sent_state_check check ((status = 'sent' and sent_at is not null) or (status <> 'sent' and sent_at is null))"
].map(compact);

assert.strictEqual(constraints.length, 11, 'Expected exactly 11 named constraints');
assert.deepStrictEqual(constraints.map(compact), expectedConstraints, 'Constraint contract drifted');

const expectedIndexes = [
  'create index if not exists idx_notification_deliveries_event_status on public.notification_deliveries (event_id, status);',
  "create index if not exists idx_notification_deliveries_claimable on public.notification_deliveries (event_id, next_attempt_at, created_at) where status = 'queued';",
  "create index if not exists idx_notification_deliveries_stale_claims on public.notification_deliveries (event_id, claimed_at) where status = 'sending';",
  'create index if not exists idx_notification_deliveries_subscription on public.notification_deliveries (subscription_id) where subscription_id is not null;'
].map(compact);
const actualIndexes = [...sql.matchAll(
  /create\s+index\s+if\s+not\s+exists\s+idx_notification_deliveries_[a-z_]+\s+on\s+public\.notification_deliveries\s*\([^;]+?\)(?:\s+where\s+[^;]+)?;/gi
)].map((match) => compact(match[0]));
assert.deepStrictEqual(actualIndexes, expectedIndexes, 'Index key/order/predicate contract drifted');

assert.strictEqual(
  countMatches(sql, /alter\s+table\s+public\.notification_deliveries\s+enable\s+row\s+level\s+security\s*;/gi),
  1,
  'RLS enable statement missing or duplicated'
);
assert(
  /execute\s+'create trigger notification_deliveries_set_updated_at '\s*\|\|\s*'before update on public\.notification_deliveries '\s*\|\|\s*'for each row execute function public\.set_updated_at\(\)'/i.test(sql),
  'Exact notification_deliveries updated_at trigger contract is missing'
);
assert(
  /t\.tgname\s*=\s*'notification_deliveries_set_updated_at'[\s\S]*?v_actual\.tgfoid\s*<>\s*'public\.set_updated_at\(\)'::regprocedure/i.test(sql),
  'Strict trigger name/function validation is missing'
);

// Object allowlist: the migration may create only the delivery table and the
// two accepted RPC definitions (which intentionally live inside $definition$).
const createdTables = [...sql.matchAll(/^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_.]+)/gim)]
  .map((match) => match[1].toLowerCase());
assert.deepStrictEqual(
  createdTables,
  ['public.notification_deliveries'],
  'Unexpected CREATE TABLE found in Phase 2A migration'
);

const createdFunctions = [...sql.matchAll(/^\s*create\s+function\s+([a-z0-9_.]+)\s*\(/gim)]
  .map((match) => match[1].toLowerCase());
assert.deepStrictEqual(
  createdFunctions,
  [
    'public.claim_notification_delivery_batch',
    'public.record_notification_delivery_result'
  ],
  'Unexpected CREATE FUNCTION found in Phase 2A migration'
);

// Mask executable RPC bodies before checking migration-time DDL/DML. Expected
// INSERT/UPDATE statements inside the RPCs must not be mistaken for migration
// mutations of existing Phase 1 data.
const migrationSurface = withoutComments(maskDollarBody(maskDollarBody(sql, 'claim'), 'record'));
for (const relation of [
  'notification_events',
  'push_subscriptions',
  'notification_preferences',
  'class_members'
]) {
  const escaped = relation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert(
    !new RegExp(`\\balter\\s+table\\s+public\\.${escaped}\\b`, 'i').test(migrationSurface),
    `Migration must not ALTER Phase 1 table public.${relation}`
  );
}

for (const forbidden of [
  /\bdrop\s+table\b/i,
  /\bdrop\s+function\b/i,
  /\bdrop\s+policy\b/i,
  /\btruncate\b/i,
  /\bdelete\s+from\s+public\./i,
  /\binsert\s+into\s+public\.(?:notification_events|push_subscriptions|notification_preferences)\b/i,
  /\bupdate\s+public\.(?:notification_events|push_subscriptions|notification_preferences|class_members)\b/i
]) {
  assert(!forbidden.test(migrationSurface), `Forbidden migration-level SQL matched ${forbidden}`);
}

console.log('PASS: push notification Phase 2 schema contract');
