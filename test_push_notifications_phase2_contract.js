'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const sql = fs.readFileSync(path.join(__dirname, 'push-notifications-phase2.sql'), 'utf8');

function extractBody(tag) {
  const open = `as $${tag}$`;
  const close = `$${tag}$;`;
  const openIndex = sql.indexOf(open);
  assert(openIndex >= 0, `Missing ${open} marker`);
  assert.strictEqual(sql.indexOf(open, openIndex + open.length), -1, `Duplicate ${open} marker`);
  const bodyStart = openIndex + open.length;
  const closeIndex = sql.indexOf(close, bodyStart);
  assert(closeIndex >= 0, `Missing ${close} marker`);
  assert.strictEqual(sql.indexOf(close, closeIndex + close.length), -1, `Duplicate ${close} marker`);
  return sql.slice(bodyStart, closeIndex);
}

function assertPattern(text, regex, message) {
  assert(regex.test(text), message);
}

function assertOrdered(text, markers) {
  let previous = -1;
  for (const marker of markers) {
    const current = text.indexOf(marker);
    assert(current >= 0, `Missing ordered marker: ${marker}`);
    assert(current > previous, `Incorrect order at marker: ${marker}`);
    previous = current;
  }
}

function extractParenthesizedAfter(text, marker) {
  const markerIndex = text.toLowerCase().indexOf(marker.toLowerCase());
  assert(markerIndex >= 0, `Missing block marker: ${marker}`);
  const openingIndex = text.indexOf('(', markerIndex + marker.length);
  assert(openingIndex >= 0, `Missing opening parenthesis after: ${marker}`);

  let depth = 0;
  let quote = false;
  for (let index = openingIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quote) {
      if (char === "'" && next === "'") index += 1;
      else if (char === "'") quote = false;
      continue;
    }

    if (char === "'") quote = true;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openingIndex + 1, index);
      assert(depth >= 0, `Unexpected closing parenthesis in ${marker}`);
    }
  }

  assert.fail(`Unclosed parenthesized block after: ${marker}`);
}

function assertAggregateContract(body, functionName) {
  assertPattern(
    body,
    /delivery\.status\s+in\s*\(\s*'queued'\s*,\s*'sending'\s*\)/i,
    `${functionName}: active queued/sending aggregate is missing`
  );
  assertPattern(
    body,
    /delivery\.status\s*=\s*'failed'/i,
    `${functionName}: failed aggregate is missing`
  );
  assertPattern(
    body,
    /case\s+when\s+v_has_active\s+then\s+'sending'\s+when\s+v_has_failed\s+then\s+'failed'\s+else\s+'sent'\s+end/i,
    `${functionName}: exact sending/failed/sent aggregate precedence drifted`
  );
}

const claim = extractBody('claim');
const record = extractBody('record');

assertPattern(claim, /from\s+public\.push_subscriptions\s+as\s+subscription\s+join\s+auth\.users\s+as\s+auth_user\s+on\s+auth_user\.id\s*=\s*subscription\.user_id\s+join\s+public\.class_members\s+as\s+class_member\s+on\s+class_member\.email\s*=\s*lower\(auth_user\.email\)\s+left\s+join\s+public\.notification_preferences\s+as\s+preference\s+on\s+preference\.user_id\s*=\s*subscription\.user_id/is, 'Recipient snapshot join chain drifted');
for (const [eventType, preference] of [
  ['schedule', 'schedule_enabled'],
  ['memo', 'memos_enabled'],
  ['announcement', 'announcements_enabled']
]) {
  const mapping = new RegExp(`when\\s+'${eventType}'\\s+then\\s+coalesce\\(preference\\.${preference}\\s*,\\s*true\\)`, 'i');
  assertPattern(claim, mapping, `Missing default-enabled ${eventType} preference mapping`);
}

assertOrdered(claim, [
  "last_error_code = 'stale_claim_recovered'",
  "last_error_code = 'subscription_removed'",
  "last_error_code = 'subscription_disabled'",
  "last_error_code = 'recipient_revoked'",
  "last_error_code = 'preference_disabled'",
  "last_error_code = 'retry_exhausted'",
  'with candidate as ('
]);

// Claim-time eligibility must be complete inside the candidate CTE itself;
// initial-snapshot checks elsewhere in the RPC are not sufficient.
const candidate = extractParenthesizedAfter(claim, 'with candidate as');
assertPattern(candidate, /delivery\.event_id\s*=\s*v_event\.id/i, 'Candidate must filter the requested event');
assertPattern(candidate, /delivery\.status\s*=\s*'queued'/i, 'Candidate must require queued delivery status');
assertPattern(candidate, /join\s+public\.push_subscriptions\s+as\s+subscription\s+on\s+subscription\.id\s*=\s*delivery\.subscription_id/i, 'Candidate must resolve the current subscription by delivery.subscription_id');
assertPattern(candidate, /subscription\.enabled\s*=\s*true/i, 'Candidate must re-check enabled subscription state');
assertPattern(candidate, /join\s+auth\.users\s+as\s+auth_user\s+on\s+auth_user\.id\s*=\s*subscription\.user_id/i, 'Candidate must re-check the current auth user');
assertPattern(candidate, /auth_user\.email\s+is\s+not\s+null/i, 'Candidate must reject auth users without email');
assertPattern(candidate, /join\s+public\.class_members\s+as\s+class_member\s+on\s+class_member\.email\s*=\s*lower\(auth_user\.email\)/i, 'Candidate must re-check current class approval');
assertPattern(candidate, /left\s+join\s+public\.notification_preferences\s+as\s+preference\s+on\s+preference\.user_id\s*=\s*subscription\.user_id/i, 'Candidate must load current notification preferences');
for (const [eventType, preference] of [
  ['schedule', 'schedule_enabled'],
  ['memo', 'memos_enabled'],
  ['announcement', 'announcements_enabled']
]) {
  const mapping = new RegExp(`when\\s+'${eventType}'\\s+then\\s+coalesce\\(preference\\.${preference}\\s*,\\s*true\\)`, 'i');
  assertPattern(candidate, mapping, `Candidate missing default-enabled ${eventType} preference check`);
}
assertPattern(candidate, /else\s+false\s+end/i, 'Candidate must reject unsupported event types');
assertPattern(candidate, /delivery\.next_attempt_at\s+is\s+null\s+or\s+delivery\.next_attempt_at\s*<=\s*now\(\)/i, 'Candidate due-time predicate drifted');
assertPattern(candidate, /delivery\.attempt_count\s*<\s*5/i, 'Candidate must enforce remaining attempts');
assertPattern(candidate, /for\s+update\s+of\s+delivery\s+skip\s+locked/i, 'Candidate must lock with SKIP LOCKED');
assertPattern(candidate, /limit\s+p_limit/i, 'Candidate must enforce p_limit');

const deliveryInsertions = [...claim.matchAll(/insert\s+into\s+public\.notification_deliveries\b/gi)];
assert.strictEqual(deliveryInsertions.length, 1, 'Claim RPC must contain exactly one delivery snapshot INSERT');
const queuedBranchStart = claim.search(/if\s+v_event\.status\s*=\s*'queued'\s+then/i);
const sendingResumeBoundary = claim.search(/elsif\s+v_event\.status\s*<>\s*'sending'\s+then/i);
assert(queuedBranchStart >= 0, 'Queued-event branch is missing');
assert(sendingResumeBoundary > queuedBranchStart, 'Sending resume boundary is missing or misplaced');
assert(
  deliveryInsertions[0].index > queuedBranchStart && deliveryInsertions[0].index < sendingResumeBoundary,
  'Delivery snapshot INSERT must exist only inside the queued-event branch'
);

assertPattern(claim, /p_limit\s+is\s+null\s+or\s+p_limit\s*<\s*1\s+or\s+p_limit\s*>\s*25/i, 'p_limit 1..25 validation drifted');
assertPattern(claim, /from\s+public\.notification_events\s+as\s+notification_event[\s\S]*?where\s+notification_event\.id\s*=\s*p_event_id\s+for\s+update/si, 'Event row FOR UPDATE lock is missing');
assertPattern(claim, /if\s+v_event\.status\s*=\s*'queued'\s+then[\s\S]*?insert\s+into\s+public\.notification_deliveries/si, 'Initial snapshot must occur only for a queued event');
assertPattern(claim, /set\s+status\s*=\s*'sending'\s*,\s*attempt_count\s*=\s*notification_event\.attempt_count\s*\+\s*1/si, 'Event queued-to-sending attempt increment drifted');
assertPattern(claim, /for\s+update\s+of\s+delivery\s+skip\s+locked/i, 'Delivery SKIP LOCKED claim is missing');
assertPattern(claim, /set\s+status\s*=\s*'sending'\s*,\s*claim_token\s*=\s*gen_random_uuid\(\)\s*,\s*claimed_at\s*=\s*now\(\)[\s\S]*?attempt_count\s*=\s*delivery\.attempt_count\s*\+\s*1/si, 'Atomic queued-to-sending claim transition drifted');

assertPattern(claim, /delivery\.status\s*=\s*'sending'\s+and\s+delivery\.claimed_at\s*<=\s*now\(\)\s*-\s*interval\s*'5 minutes'/i, 'Five-minute stale lease predicate drifted');
assertPattern(claim, /set\s+status\s*=\s*'queued'\s*,\s*claim_token\s*=\s*null\s*,\s*next_attempt_at\s*=\s*now\(\)\s*,\s*last_error_code\s*=\s*'stale_claim_recovered'/si, 'Stale claim recovery transition drifted');
assertPattern(claim, /delivery\.attempt_count\s*>=\s*5/i, 'Fifth-attempt exhaustion guard is missing');

for (const [attempt, seconds] of [[1, 30], [2, 60], [3, 120], [4, 240]]) {
  assertPattern(record, new RegExp(`when\\s+${attempt}\\s+then\\s+${seconds}`, 'i'), `Missing ${seconds}s backoff for attempt ${attempt}`);
}
assertPattern(record, /else\s+480\s+end/i, 'Missing bounded 480s backoff slot');
assertPattern(record, /p_retry_after_seconds\s+is\s+not\s+null\s+and\s+p_http_status\s+is\s+distinct\s+from\s+429/i, 'Retry-After must be accepted only for 429');
assertPattern(record, /greatest\(\s*30\s*,\s*least\(\s*86400\s*,\s*p_retry_after_seconds\s*\)\s*\)/i, 'Retry-After clamp 30..86400 drifted');

assertPattern(record, /p_outcome\s*=\s*'success'[\s\S]*?p_http_status\s+is\s+null\s+or\s+p_http_status\s+not\s+between\s+200\s+and\s+299/si, 'Success must require HTTP 200..299');
assertPattern(record, /p_outcome\s*=\s*'expired'[\s\S]*?p_http_status\s+is\s+null\s+or\s+p_http_status\s+not\s+in\s*\(\s*404\s*,\s*410\s*\)/si, 'Expired must require exactly HTTP 404/410');
assertPattern(record, /p_outcome\s*=\s*'transient'[\s\S]*?p_http_status\s+is\s+null\s+or\s+p_http_status\s*=\s*429\s+or\s+p_http_status\s+between\s+500\s+and\s+599/si, 'Transient must allow only network NULL, 429, or 5xx');
assertPattern(record, /p_http_status\s+is\s+null\s+or\s+p_http_status\s+not\s+between\s+400\s+and\s+499\s+or\s+p_http_status\s+in\s*\(\s*404\s*,\s*410\s*,\s*429\s*\)/si, 'Permanent must be 4xx excluding 404/410/429');
assertPattern(record, /delivery\.status\s*=\s*'sending'\s+and\s+delivery\.claim_token\s*=\s*p_claim_token\s+for\s+update/i, 'Exact status/claim-token mutation guard drifted');

assertPattern(record, /p_outcome\s*=\s*'success'[\s\S]*?set\s+status\s*=\s*'sent'/si, 'Success-to-sent transition missing');
assertPattern(record, /p_outcome\s*=\s*'expired'[\s\S]*?set\s+status\s*=\s*'expired'[\s\S]*?set\s+enabled\s*=\s*false/si, 'Expired transition/subscription disable missing');
assertPattern(record, /p_outcome\s*=\s*'transient'[\s\S]*?status\s*=\s*'failed'[\s\S]*?last_error_code\s*=\s*'retry_exhausted'[\s\S]*?status\s*=\s*'queued'/si, 'Transient retry/exhaustion transitions missing');
assertPattern(record, /else\s+v_error_code\s*:=\s*coalesce\(p_error_code,\s*'push_client_error'\)[\s\S]*?set\s+status\s*=\s*'failed'/si, 'Permanent-to-failed transition missing');
for (const field of ['last_success_at', 'last_failure_at', 'failure_count']) {
  assertPattern(record, new RegExp(`\\b${field}\\b`, 'i'), `Subscription health update missing ${field}`);
}

assertAggregateContract(claim, 'claim RPC');
assertAggregateContract(record, 'record RPC');

const expectedHashes = {
  claim: '1d6335bf315f67709121e55d5e153505',
  record: '46eec83b405642f16ecf566ea259a599'
};
for (const [tag, body] of [['claim', claim], ['record', record]]) {
  const actual = crypto.createHash('md5').update(body, 'utf8').digest('hex');
  assert.strictEqual(actual, expectedHashes[tag], `${tag} exact prosrc-style body MD5 drifted`);
  const constantCount = sql.split(`'${expectedHashes[tag]}'`).length - 1;
  assert.strictEqual(constantCount, 2, `${tag} MD5 must appear in preflight and final validation`);
}

console.log('PASS: push notification Phase 2 behavioral contract');
