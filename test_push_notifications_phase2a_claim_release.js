const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const migrationPath = path.join(root, "push-notifications-phase2a-claim-release.sql");
const phase2Path = path.join(root, "push-notifications-phase2.sql");
const migration = fs.readFileSync(migrationPath, "utf8");
const phase2 = fs.readFileSync(phase2Path);
const phase2Text = phase2.toString("utf8");

function occurrences(source, expression) {
  return [...source.matchAll(expression)].length;
}

const bodyMatch = migration.match(/as \$release\$(.*?)\$release\$;/su);
assert.ok(bodyMatch, "release RPC body must use the expected dollar quote");
const body = bodyMatch[1];
const bodyMd5 = crypto.createHash("md5").update(body).digest("hex");

assert.equal(
  crypto.createHash("sha256").update(phase2).digest("hex"),
  "bd97f39c3f7bbdf5434b9f9b10fac0a72c448e31a403a005b02348115198c1bd",
  "the applied Phase 2A migration must remain byte-for-byte unchanged",
);

assert.match(migration, /^begin;[\s\S]*notify pgrst, 'reload schema';\s*commit;/mu);
assert.match(migration, /if current_user <> 'postgres' then/u);
assert.match(migration, /to_regclass\('public\.notification_deliveries'\)/u);
assert.match(migration, /to_regclass\('public\.notification_events'\)/u);
assert.match(migration, /to_regprocedure\('public\.claim_notification_delivery_batch\(uuid,integer\)'\)/u);
assert.match(migration, /to_regprocedure\('public\.record_notification_delivery_result\(uuid,uuid,text,integer,text,integer\)'\)/u);

assert.equal(occurrences(migration, /create function public\.release_notification_delivery_claim\s*\(/gu), 1);
assert.doesNotMatch(migration, /create\s+or\s+replace\s+function/iu);
assert.match(migration, /procedure_entry\.proname = 'release_notification_delivery_claim'[\s\S]*if v_count <> 0 then[\s\S]*raise exception 'Function conflict:/u);
assert.ok(
  migration.indexOf("if v_count <> 0 then") < migration.indexOf("create function public.release_notification_delivery_claim"),
  "existing exact signatures and overloads must stop before CREATE FUNCTION",
);

assert.match(migration, /create function public\.release_notification_delivery_claim\(\s*p_delivery_id uuid,\s*p_claim_token uuid\s*\)/u);
assert.match(migration, /returns table \(\s*delivery_status text,\s*event_status text,\s*attempt_count integer,\s*next_attempt_at timestamptz\s*\)/u);
assert.match(migration, /language plpgsql\s*security definer\s*set search_path = pg_catalog, public, pg_temp/u);
assert.match(migration, /alter function public\.release_notification_delivery_claim\(uuid, uuid\) owner to postgres;/u);
assert.match(migration, /revoke all on function public\.release_notification_delivery_claim\(uuid, uuid\)\s*from public, anon, authenticated, service_role;/u);
assert.match(migration, /grant execute on function public\.release_notification_delivery_claim\(uuid, uuid\)\s*to service_role;/u);

assert.match(body, /if p_delivery_id is null or p_claim_token is null then/u);
assert.match(body, /from public\.notification_deliveries as delivery\s*where delivery\.id = p_delivery_id;/u);
const eventLock = body.search(/from public\.notification_events as notification_event[\s\S]*?for update;/u);
const deliveryLock = body.search(/select delivery\.\*[\s\S]*?for update;/u);
assert.ok(eventLock >= 0 && deliveryLock > eventLock, "lock order must be event then delivery");

assert.match(body, /notification_event\.status = 'sending'/u);
assert.match(body, /delivery\.status = 'sending'/u);
assert.match(body, /delivery\.claim_token = p_claim_token/u);
assert.match(body, /delivery\.attempt_count > 0/u);
assert.match(body, /delivery\.claimed_at is not null/u);
assert.match(body, /delivery\.sent_at is null/u);
assert.ok(occurrences(body, /attempt_count = delivery\.attempt_count - 1/gu) === 1);
assert.doesNotMatch(body, /greatest\s*\(\s*(?:delivery\.)?attempt_count\s*-/iu);

assert.match(body, /set status = 'queued',\s*attempt_count = delivery\.attempt_count - 1,\s*claim_token = null,\s*claimed_at = null,\s*next_attempt_at = null,\s*last_http_status = null,\s*last_error_code = 'claim_released_unsent'/u);
assert.ok("claim_released_unsent".length <= 64);
assert.match("claim_released_unsent", /^[a-z0-9][a-z0-9_.:-]{0,63}$/u);
assert.match(body, /returning delivery\.\* into v_delivery;/u);
assert.match(body, /if not found then\s*raise exception 'Notification delivery claim is no longer releasable';/u);

assert.match(body, /delivery\.status in \('queued', 'sending'\)/u);
assert.match(body, /delivery\.status = 'failed'/u);
assert.match(body, /v_event_status := case\s*when v_has_active then 'sending'\s*when v_has_failed then 'failed'\s*else 'sent'\s*end;/u);
assert.match(body, /if v_event_status <> 'sending' then/u);
assert.match(body, /set status = v_event_status,\s*last_error = case when v_has_failed then 'delivery_failed' else null end/u);
assert.match(body, /return query\s*select\s*v_delivery\.status,\s*v_event_status,\s*v_delivery\.attempt_count,\s*v_delivery\.next_attempt_at;/u);

assert.match(migration, /v_actual\.proowner <> 'postgres'::regrole/u);
assert.match(migration, /not v_actual\.prosecdef/u);
assert.match(migration, /v_actual\.lanname <> 'plpgsql'/u);
assert.match(migration, /v_actual\.arg_types <> 'uuid, uuid'/u);
assert.match(migration, /v_actual\.result_norm <> 'table\(delivery_statustext,event_statustext,attempt_countinteger,next_attempt_attimestampwithtimezone\)'/u);
assert.match(migration, /replace\(v_actual\.proconfig\[1\], ' ', ''\) is distinct from 'search_path=pg_catalog,public,pg_temp'/u);
assert.match(migration, new RegExp(`v_actual\\.body_md5 <> '${bodyMd5}'`, "u"));
assert.match(migration, /role_entry\.rolname = 'service_role'[\s\S]*acl_entry\.privilege_type = 'EXECUTE'[\s\S]*not acl_entry\.is_grantable/u);

assert.doesNotMatch(migration, /\b(?:create|alter|drop)\s+table\b/iu);
assert.doesNotMatch(migration, /\b(?:create|drop)\s+index\b/iu);
assert.doesNotMatch(migration, /\bdrop\s+(?:function|policy)\b/iu);
assert.doesNotMatch(migration, /\b(?:truncate|delete\s+from)\b/iu);
assert.doesNotMatch(migration, /\b(?:grant|revoke)\b[\s\S]{0,120}\bon\s+(?:table\s+)?public\.(?:notification_deliveries|notification_events|push_subscriptions|notification_preferences)\b/iu);
assert.doesNotMatch(migration, /\b(?:create|alter)\s+function\s+public\.(?:claim_notification_delivery_batch|record_notification_delivery_result)\b/iu);

// The SQL assertions above bind this model to every release guard. These
// behavioral cases make the intended one-shot and race outcomes explicit.
function isReleasable(delivery, eventStatus, token) {
  return eventStatus === "sending"
    && delivery.status === "sending"
    && delivery.claimToken === token
    && delivery.attemptCount > 0
    && delivery.claimedAt !== null
    && delivery.sentAt === null;
}

const currentClaim = {
  status: "sending",
  claimToken: "current-token",
  attemptCount: 2,
  claimedAt: "2026-01-01T00:00:00Z",
  sentAt: null,
};
assert.equal(isReleasable(currentClaim, "sending", "current-token"), true);
assert.equal(isReleasable(currentClaim, "sending", "wrong-token"), false);
for (const terminalStatus of ["queued", "sent", "expired", "failed"]) {
  assert.equal(
    isReleasable({ ...currentClaim, status: terminalStatus }, "sending", "current-token"),
    false,
  );
}

const releasedClaim = {
  ...currentClaim,
  status: "queued",
  claimToken: null,
  attemptCount: currentClaim.attemptCount - 1,
  claimedAt: null,
};
assert.equal(releasedClaim.attemptCount, 1, "successful release decrements exactly once");
assert.equal(isReleasable(releasedClaim, "sending", "current-token"), false, "duplicate release fails");
assert.equal(
  isReleasable({ ...currentClaim, status: "sent", claimToken: null }, "sent", "current-token"),
  false,
  "record-result winner makes release fail",
);
assert.equal(
  isReleasable({ ...currentClaim, status: "queued", claimToken: null }, "sending", "current-token"),
  false,
  "stale-recovery winner makes release fail",
);

const recordBody = phase2Text.match(/as \$record\$(.*?)\$record\$;/su)?.[1];
const claimBody = phase2Text.match(/as \$claim\$(.*?)\$claim\$;/su)?.[1];
assert.ok(recordBody && claimBody, "Phase 2A RPC bodies must remain extractable");
assert.match(recordBody, /delivery\.status = 'sending'[\s\S]*delivery\.claim_token = p_claim_token/u);
assert.match(claimBody, /set status = 'queued',[\s\S]*claim_token = null[\s\S]*delivery\.status = 'sending'[\s\S]*interval '5 minutes'/u);
assert.equal(
  releasedClaim.status === "sending" && releasedClaim.claimToken === "current-token",
  false,
  "release winner leaves a stale record-result guard",
);

console.log("PASS: Phase 2A.1 claim release migration contract and safety tests");
