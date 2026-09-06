'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const sql = fs.readFileSync(path.join(__dirname, 'push-notifications-phase2.sql'), 'utf8');

function countMatches(text, regex) {
  return [...text.matchAll(regex)].length;
}

function extractFunction(name, bodyTag) {
  const declaration = `create function public.${name}`;
  const start = sql.toLowerCase().indexOf(declaration);
  assert(start >= 0, `Missing ${name} declaration`);
  const open = `as $${bodyTag}$`;
  const bodyStartMarker = sql.indexOf(open, start);
  assert(bodyStartMarker >= 0, `Missing $${bodyTag}$ body opener`);
  const bodyStart = bodyStartMarker + open.length;
  const close = `$${bodyTag}$;`;
  const bodyEnd = sql.indexOf(close, bodyStart);
  assert(bodyEnd >= 0, `Missing $${bodyTag}$ body closer`);
  return {
    header: sql.slice(start, bodyStartMarker),
    body: sql.slice(bodyStart, bodyEnd)
  };
}

assert(
  /if\s+current_user\s*<>\s*'postgres'\s+then\s+raise exception/si.test(sql),
  'Migration must require current_user=postgres'
);
assert(
  /select\s+c\.relkind\s*,\s*c\.relowner\s*,\s*c\.relforcerowsecurity[\s\S]*?v_relation\.relowner\s*<>\s*'postgres'::regrole[\s\S]*?or\s+v_relation\.relforcerowsecurity/si.test(sql),
  'Early existing-table owner/FORCE RLS fail-fast validation is missing'
);
assert(
  /select\s+c\.relkind\s*,\s*c\.relpersistence\s*,\s*c\.relispartition\s*,\s*c\.relowner\s*,\s*c\.relrowsecurity\s*,\s*c\.relforcerowsecurity[\s\S]*?v_actual\.relowner\s*<>\s*'postgres'::regrole[\s\S]*?not\s+v_actual\.relrowsecurity[\s\S]*?v_actual\.relforcerowsecurity/si.test(sql),
  'Final owner/RLS/FORCE RLS catalog validation is missing'
);

assert(
  /revoke\s+all\s+on\s+public\.notification_deliveries\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role\s*;/si.test(sql),
  'Deterministic table ACL revoke is missing'
);
assert.strictEqual(
  countMatches(sql, /create\s+policy\b/gi),
  0,
  'notification_deliveries must not create RLS policies'
);
assert(
  /from\s+pg_policies[\s\S]*?tablename\s*=\s*'notification_deliveries'[\s\S]*?if\s+v_count\s*<>\s*0\s+then/si.test(sql),
  'Exact zero-policy validation is missing'
);
assert(
  /a\.attrelid\s*=\s*'public\.notification_deliveries'::regclass[\s\S]*?a\.attacl\s+is\s+not\s+null[\s\S]*?explicit column ACL/si.test(sql),
  'Explicit column ACL rejection is missing'
);
assert(
  /acl\.grantee\s*<>\s*c\.relowner[\s\S]*?unexpected direct grant/si.test(sql),
  'Unexpected non-owner table grant validation is missing'
);
assert.strictEqual(
  countMatches(sql, /grant\s+[\s\S]*?on\s+(?:table\s+)?public\.notification_deliveries\b/gi),
  0,
  'Direct client/backend table grants on notification_deliveries are forbidden'
);

const functions = [
  {
    name: 'claim_notification_delivery_batch',
    tag: 'claim',
    signature: 'uuid, integer',
    returns: ['delivery_id', 'claim_token', 'endpoint', 'p256dh', 'auth', 'event_id', 'event_type', 'title', 'body', 'deep_link', 'attempt_count']
  },
  {
    name: 'record_notification_delivery_result',
    tag: 'record',
    signature: 'uuid, uuid, text, integer, text, integer',
    returns: ['delivery_status', 'event_status', 'next_attempt_at']
  }
];

for (const expected of functions) {
  const definition = extractFunction(expected.name, expected.tag);
  assert(/language\s+plpgsql/i.test(definition.header), `${expected.name} must use plpgsql`);
  assert(/security\s+definer/i.test(definition.header), `${expected.name} must be SECURITY DEFINER`);
  assert(!/security\s+invoker/i.test(definition.header), `${expected.name} must not be SECURITY INVOKER`);
  assert(
    /set\s+search_path\s*=\s*pg_catalog\s*,\s*public\s*,\s*pg_temp/i.test(definition.header),
    `${expected.name} search_path must be pg_catalog, public, pg_temp`
  );
  assert(!/\bexecute\b/i.test(definition.body), `${expected.name} body must not use dynamic EXECUTE`);

  const returnMatch = definition.header.match(/returns\s+table\s*\(([\s\S]*?)\)\s*language/i);
  assert(returnMatch, `${expected.name} RETURNS TABLE contract is missing`);
  const returnedNames = returnMatch[1]
    .split(',')
    .map((entry) => entry.trim().split(/\s+/)[0].toLowerCase());
  assert.deepStrictEqual(returnedNames, expected.returns, `${expected.name} return columns drifted`);
  for (const forbidden of ['email', 'user_id', 'jwt', 'vapid_private_key', 'private_key']) {
    assert(!returnedNames.includes(forbidden), `${expected.name} must not return ${forbidden}`);
  }

  const escapedName = expected.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const signaturePattern = expected.signature.replace(/, /g, '\\s*,\\s*');
  const ownerRegex = new RegExp(`alter\\s+function\\s+public\\.${escapedName}\\s*\\(\\s*${signaturePattern}\\s*\\)\\s+owner\\s+to\\s+postgres\\s*;`, 'i');
  const revokeRegex = new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${escapedName}\\s*\\(\\s*${signaturePattern}\\s*\\)\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*,\\s*service_role\\s*;`, 'i');
  const grantRegex = new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${escapedName}\\s*\\(\\s*${signaturePattern}\\s*\\)\\s+to\\s+service_role\\s*;`, 'i');
  assert(ownerRegex.test(sql), `${expected.name} owner must be postgres`);
  assert(revokeRegex.test(sql), `${expected.name} EXECUTE revoke matrix drifted`);
  assert(grantRegex.test(sql), `${expected.name} must grant EXECUTE only to service_role`);
}

const claimReturns = functions[0].returns;
for (const required of ['endpoint', 'p256dh', 'auth']) {
  assert(claimReturns.includes(required), `Backend claim result must include ${required}`);
}

assert.strictEqual(
  countMatches(sql, /grant\s+execute\s+on\s+function\s+public\.(?:claim_notification_delivery_batch|record_notification_delivery_result)/gi),
  2,
  'Expected exactly two backend RPC EXECUTE grants'
);
assert(
  /role_entry\.rolname\s*=\s*'service_role'[\s\S]*?acl\.privilege_type\s*=\s*'EXECUTE'[\s\S]*?not\s+acl\.is_grantable/si.test(sql),
  'Strict non-grantable service_role EXECUTE validation is missing'
);

console.log('PASS: push notification Phase 2 security contract');
