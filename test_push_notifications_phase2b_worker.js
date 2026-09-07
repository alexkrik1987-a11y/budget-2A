"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { createECDH, randomUUID } = require("node:crypto");
const root = __dirname;
const dir = path.join(root, "supabase/functions");
const sql = fs.readFileSync(path.join(root, "push-notifications-durable-dispatch.sql"), "utf8");
const workerSource = fs.readFileSync(path.join(dir, "dispatch-class-notifications/index.ts"), "utf8");
assert.match(workerSource, /withSupabase\(\{ auth: "secret", cors: "disabled" \}/,
  "worker must disable SDK wildcard CORS, including auth errors and OPTIONS");
assert.doesNotMatch(workerSource, /access-control-allow-origin|withAdminCors/i);
const contractPath = path.join(dir, "_shared/notification-contract.ts");
async function loadWorker() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "budget2a-durable-worker-test-"));
  try {
    for (const file of ["_shared/notification-contract.ts", "_shared/web-push.ts", "dispatch-class-notifications/index.ts"]) {
      const target = path.join(tmp, "functions", file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(dir, file), target);
    }
    for (const [name, code] of [
      ["@supabase/server", "export function withSupabase(options, handler) { return handler; }"],
      ["web-push", "export function generateRequestDetails() { throw new Error('real_crypto_transport_not_used_by_worker_unit'); }"],
    ]) {
      const target = path.join(tmp, "node_modules", name);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
      fs.writeFileSync(path.join(target, "index.js"), code);
    }
    return await import(pathToFileURL(path.join(tmp, "functions/dispatch-class-notifications/index.ts")).href);
  } finally { fs.rmSync(tmp, { force: true, recursive: true }); }
}
const key = createECDH("prime256v1"); key.generateKeys();
// node:crypto's ECDH.getPrivateKey() omits fixed-width padding, so a key with a
// leading zero byte comes back short (~1/256 of keys); pad to 32 bytes so this
// module-level fixture is never flaky.
function fixedLengthPrivateKey(ecdh, length = 32) {
  const raw = ecdh.getPrivateKey();
  if (raw.length === length) return raw;
  const padded = Buffer.alloc(length);
  raw.copy(padded, length - raw.length);
  return padded;
}
const env = { VAPID_SUBJECT: "mailto:test@example.invalid",
  VAPID_PUBLIC_KEY: key.getPublicKey().toString("base64url"), VAPID_PRIVATE_KEY: fixedLengthPrivateKey(key).toString("base64url") };
const readEnv = name => env[name];
const at = Date.now();
const stamp = ms => new Date(at + ms).toISOString();
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(n = 1, config = {}) {
  const eventId = randomUUID(), jobId = randomUUID(), batchId = randomUUID(), settleId = randomUUID();
  let lease = null, prepared = false, now = 0, sent = 0, active = 0, maxActive = 0, permits = 0, maxPermits = 0;
  const calls = [], timeouts = [];
  const attempts = Array.from({ length: n }, () => ({
    id: randomUUID(), delivery: randomUUID(), token: randomUUID(), begin: randomUUID(), record: randomUUID(),
    release: randomUUID(), ambiguity: randomUUID(), stage: "prepared", deliveryStatus: "sending",
    count: config.attemptCount ?? 1, provider: null, sendDeadline: null, resultAt: null,
  }));
  const jobState = () => ({
    row_kind: "job", job_id: jobId, event_id: eventId, job_stage: lease ? "leased" : "ready",
    event_status: prepared ? "sending" : "queued", lease_epoch: lease ? 1 : 0,
    lease_owner: lease?.p_worker_id ?? null, lease_until: lease ? stamp(90_000) : null,
    next_run_at: lease ? null : stamp(0), snapshot_at: prepared ? stamp(0) : null,
    batch_id: lease ? batchId : null, batch_prepared: prepared, batch_count: prepared ? n : null,
    settle_operation_id: lease ? settleId : null,
    attempt_id: null, delivery_id: null, attempt_stage: null, prepared_epoch: null, attempt_no: null, claim_token: null,
    begin_operation_id: null, record_operation_id: null, ambiguity_operation_id: null, release_operation_id: null,
    send_owner: null, send_epoch: null, send_deadline_at: null, ambiguity_after: null,
    delivery_status: null, delivery_attempt_count: null, delivery_next_attempt_at: null,
    provider_outcome: null, result_recorded_at: null, ambiguity_at: null, released_at: null,
  });
  function attemptState(a) {
    return { ...jobState(), row_kind: "attempt", attempt_id: a.id, delivery_id: a.delivery,
      attempt_stage: a.stage, prepared_epoch: 1, attempt_no: a.count, claim_token: a.token,
      begin_operation_id: a.begin, record_operation_id: a.record, ambiguity_operation_id: a.ambiguity,
      release_operation_id: a.release, delivery_status: a.deliveryStatus, delivery_attempt_count: a.count,
      send_owner: a.sendDeadline ? lease.p_worker_id : null, send_epoch: a.sendDeadline ? 1 : null,
      send_deadline_at: a.sendDeadline, ambiguity_after: a.sendDeadline ? stamp(13_000) : null,
      provider_outcome: a.provider, result_recorded_at: a.resultAt };
  }
  function handle(name, args) {
    const a = attempts.find(a => a.id === args.p_attempt_id);
    if (config.fail === name) return { data: null, error: { message: config.error ?? "SAFE_DB_ERROR" } };
    let data;
    switch (name) {
      case "get_notification_dispatch_state":
        data = [jobState(), ...(args.p_batch_id ? attempts.map(attemptState) : [])];
        if (config.stateStarted && args.p_batch_id) data[1] = {
          ...data[1], attempt_stage: "send_started", send_owner: lease.p_worker_id, send_epoch: 1,
          send_deadline_at: stamp(8_000), ambiguity_after: stamp(13_000),
        };
        break;
      case "acquire_notification_dispatch_job":
        assert.equal(args.p_expected_epoch, 0); assert.equal(args.p_limit, 25);
        lease = args;
        data = [{ disposition: "acquired", job_id: jobId, event_id: eventId, job_stage: "leased",
          lease_epoch: 1, lease_until: stamp(90_000), batch_id: batchId, batch_limit: 25, settle_operation_id: settleId }];
        break;
      case "prepare_notification_dispatch_batch":
        prepared = true;
        data = [{ disposition: "prepared", job_id: jobId, event_id: eventId, job_stage: "leased",
          batch_id: batchId, batch_count: n, snapshot_at: stamp(0), event_status: "sending" }];
        break;
      case "begin_notification_dispatch_send":
        assert(a); assert.equal(args.p_operation_id, a.begin);
        assert.equal(a.stage, "prepared"); a.stage = "send_started"; permits++; maxPermits = Math.max(maxPermits, permits);
        a.sendDeadline = stamp(now + args.p_timeout_ms);
        data = [{ permit_granted: !config.permitFalse, current_stage: "send_started", attempt_id: a.id, claim_token: a.token,
          send_deadline_at: a.sendDeadline, endpoint: null, p256dh: null, auth: null, event_id: null,
          event_type: null, title: null, body: null, deep_link: null }];
        if (!config.permitFalse) Object.assign(data[0], { endpoint: "https://example.invalid/" + a.id, p256dh: "local-key",
          auth: "local-auth", event_id: eventId, event_type: "schedule", title: "Class", body: "Local", deep_link: "/" });
        if (config.afterBegin) now += config.afterBegin;
        break;
      case "record_notification_dispatch_result":
        assert(a); assert.equal(a.stage, "send_started");
        assert.equal(args.p_claim_token, a.token); assert.equal(args.p_worker_id, lease.p_worker_id);
        assert.equal(args.p_send_epoch, 1);
        assert.equal(args.p_operation_id, args.p_outcome === "ambiguous" ? a.ambiguity : a.record);
        permits--; a.stage = args.p_outcome === "ambiguous" ? "ambiguous" : "result_recorded";
        a.provider = args.p_outcome === "ambiguous" ? null : args.p_outcome;
        a.deliveryStatus = args.p_outcome === "sent" ? "sent" : args.p_outcome === "expired" ? "expired" :
          args.p_outcome === "retryable" && a.count < 5 ? "queued" : "failed";
        data = [{ disposition: args.p_outcome === "ambiguous" ? "ambiguity_recorded" : "recorded",
          attempt_id: a.id, attempt_stage: a.stage, provider_outcome: a.provider,
          delivery_status: a.deliveryStatus, delivery_attempt_count: a.count,
          next_attempt_at: a.deliveryStatus === "queued" ? stamp(30_000) : null, event_status: "sending", job_stage: "leased" }];
        break;
      case "release_notification_dispatch_attempt":
        assert(a); assert.equal(a.stage, "prepared", "never release a committed/unknown begin");
        assert.equal(args.p_reason, "worker_budget"); a.stage = "released"; a.count--;
        data = [{ disposition: "released", attempt_id: a.id, attempt_stage: "released", released_attempt_count: a.count,
          delivery_status: "queued", delivery_attempt_count: a.count, next_attempt_at: null,
          event_status: "sending", job_stage: "leased" }];
        break;
      case "settle_notification_dispatch_job":
        assert.equal(args.p_operation_id, settleId);
        data = [{ disposition: "settled", job_id: jobId, job_stage: "waiting", event_status: "sending", next_run_at: stamp(30_000),
          queued_count: attempts.filter(a => a.stage === "prepared" || a.stage === "released").length,
          sending_count: attempts.filter(a => a.stage === "send_started").length,
          sent_count: attempts.filter(a => a.deliveryStatus === "sent").length,
          expired_count: 0, failed_count: 0, skipped_count: 0, ambiguous_count: attempts.filter(a => a.stage === "ambiguous").length }];
        break;
      default: throw new Error("Unexpected RPC: " + name);
    }
    if (config.malformed === name) data = config.badData;
    return { data, error: null };
  }
  const admin = { rpc(name, args) {
    calls.push({ name, args });
    const promise = Promise.resolve().then(() => handle(name, args));
    return { then: promise.then.bind(promise), abortSignal(signal) { assert(signal instanceof AbortSignal); return promise; } };
  } };
  const send = async (_subscription, _payload, _vapid, ms, signal) => {
    assert(permits > 0); assert(signal instanceof AbortSignal);
    sent++; active++; maxActive = Math.max(maxActive, active); timeouts.push(ms);
    await tick();
    active--;
    if (config.afterSend) now += config.afterSend;
    if (config.sendError) throw config.sendError;
    return config.response ?? { statusCode: 201, headers: {} };
  };
  return { admin, attempts, calls, timeouts, jobId, handle, jobState,
    options: { readEnv, send, wallNow: () => at + now,
      budget: { deadlineAt: 45_000, now: () => now, remaining: () => Math.max(0, 45_000 - now) } },
    setNow(value) { now = value; }, metrics: () => ({ sent, maxActive, maxPermits }),
  };
}
(async () => {
  const { runWorker, handleWorkerRequest } = await loadWorker();
  const contract = await import(pathToFileURL(contractPath).href);
  let groups = 0;
  async function test(name, fn) { await fn(); groups++; console.log("PASS worker: " + name); }
  await test("acquire/prepare/begin/send/record/settle, 25 max batch, 5 max concurrency", async () => {
    const f = fixture(25); const result = await runWorker(f.admin, f.options);
    assert.equal(result.sent, 25); assert(result.settled);
    assert.equal(f.metrics().maxActive, 5); assert(f.metrics().maxPermits <= 5);
    assert(f.timeouts.every(n => n > 0 && n <= 8000));
    const names = f.calls.map(c => c.name);
    assert.deepEqual(names.slice(0, 4), ["get_notification_dispatch_state", "acquire_notification_dispatch_job",
      "prepare_notification_dispatch_batch", "get_notification_dispatch_state"]);
    assert.equal(names.at(-1), "settle_notification_dispatch_job");
    assert.equal(names.filter(n => n === "acquire_notification_dispatch_job").length, 1);
  });
  await test("permit=false -> zero sends, zero record, zero release", async () => {
    const f = fixture(1, { permitFalse: true }); await runWorker(f.admin, f.options);
    assert.equal(f.metrics().sent, 0);
    assert(!f.calls.some(c => /record_notification|release_notification/.test(c.name)));
  });
  await test("provider result mapping, raw Retry-After, unknown network -> ambiguity", async () => {
    for (const [response, sendError, expected, retry, errorCode] of [
      [{ statusCode: 201 }, null, "sent", null, null],
      [{ statusCode: 404 }, null, "expired", null, null],
      [{ statusCode: 410 }, null, "expired", null, null],
      [{ statusCode: 429, headers: { "retry-after": "1" } }, null, "retryable", 1, null],
      [{ statusCode: 503 }, null, "retryable", null, null],
      [{ statusCode: 403 }, null, "permanent_failure", null, null],
      [null, Object.assign(new Error("SECRET"), { code: "ETIMEDOUT" }), "ambiguous", null, "provider_timeout"],
      [null, new Error("SECRET"), "ambiguous", null, "provider_reset"],
      [{ statusCode: "201" }, null, "ambiguous", null, "provider_unknown_response"],
      [null, { statusCode: 429, headers: { "retry-after": "90" } }, "retryable", 90, null],
    ]) {
      const f = fixture(1, { response, sendError }); await runWorker(f.admin, f.options);
      const record = f.calls.find(c => c.name === "record_notification_dispatch_result").args;
      assert.equal(record.p_outcome, expected); assert.equal(record.p_retry_after_seconds, retry);
      assert.equal(record.p_error_code, errorCode); assert.equal(f.metrics().sent, 1);
      assert(!f.calls.some(c => c.name === "release_notification_dispatch_attempt"));
    }
  });
  await test("budget yield releases only unsent; fifth attempt -> 4; no second batch", async () => {
    const f = fixture(6, { afterSend: 6000, attemptCount: 5 }); const result = await runWorker(f.admin, f.options);
    assert.equal(f.metrics().sent, 5); assert.equal(result.released, 1);
    assert.equal(f.attempts[5].count, 4);
    assert.equal(f.calls.filter(c => c.name === "prepare_notification_dispatch_batch").length, 1);
    assert.equal(f.calls.at(-1).name, "settle_notification_dispatch_job");
  });
  await test("permit response too late -> ambiguity, never release and never send", async () => {
    const f = fixture(1, { afterBegin: 9000 }); const result = await runWorker(f.admin, f.options);
    assert.equal(f.metrics().sent, 0); assert.equal(result.ambiguous, 1);
    assert(!f.calls.some(c => c.name === "release_notification_dispatch_attempt"));
  });
  await test("uncertain/malformed begin -> no blind retry, no send/release, settle attempted", async () => {
    for (const badData of [null, undefined, {}, [], [{}]]) {
      const f = fixture(1, { malformed: "begin_notification_dispatch_send", badData });
      await assert.rejects(runWorker(f.admin, f.options), e => e.code === "dispatch_recovery_required");
      assert.equal(f.metrics().sent, 0);
      assert.equal(f.calls.filter(c => c.name === "begin_notification_dispatch_send").length, 1);
      assert(!f.calls.some(c => c.name === "release_notification_dispatch_attempt"));
      assert.equal(f.calls.at(-1).name, "settle_notification_dispatch_job");
    }
  });
  await test("every RPC malformed response fails closed", async () => {
    for (const name of ["get_notification_dispatch_state", "acquire_notification_dispatch_job",
      "prepare_notification_dispatch_batch", "record_notification_dispatch_result", "settle_notification_dispatch_job"]) {
      const f = fixture(1, { malformed: name, badData: null });
      await assert.rejects(runWorker(f.admin, f.options), e => e instanceof Error);
      assert(f.metrics().sent <= (name === "record_notification_dispatch_result" || name === "settle_notification_dispatch_job" ? 1 : 0));
    }
    const f = fixture(6, { afterSend: 6000, malformed: "release_notification_dispatch_attempt", badData: null });
    await assert.rejects(runWorker(f.admin, f.options), e => e.code === "dispatch_recovery_required");
    assert.equal(f.calls.at(-1).name, "settle_notification_dispatch_job");
  });
  await test("old active attempts / recovery reads never authorize a send", async () => {
    const f = fixture(1, { fail: "prepare_notification_dispatch_batch", error: "RECOVERY_REQUIRED" });
    const result = await runWorker(f.admin, f.options);
    assert.equal(f.metrics().sent, 0); assert(result.recoveryPending);
    assert.equal(f.calls.at(-1).args.p_reason, "yield");
    const g = fixture(1, { stateStarted: true }); await runWorker(g.admin, g.options);
    assert.equal(g.metrics().sent, 0);
    assert(!g.calls.some(c => c.name === "begin_notification_dispatch_send"));
  });
  await test("VAPID/config malformed -> no DB call; worker input malformed -> no client access", async () => {
    const f = fixture();
    await assert.rejects(runWorker(f.admin, { ...f.options, readEnv: () => undefined }), e => e.code === "worker_configuration_invalid");
    assert.equal(f.calls.length, 0);
    for (const body of ["null", "[]", '{"jobId":null}', '{"recipientIds":[]}']) {
      const r = await handleWorkerRequest(new Request("http://localhost", { method: "POST",
        headers: { "content-type": "application/json" }, body }), { supabaseAdmin: f.admin });
      assert.equal(r.status, 400);
    }
    assert.equal(f.calls.length, 0);
  });
  await test("bounded await sends AbortSignal and rejects without treating timeout as rollback", async () => {
    let signal;
    await assert.rejects(contract.bounded(s => { signal = s; return new Promise(() => {}); }, 5),
      e => e.code === "operation_response_unavailable");
    assert(signal.aborted);
    await assert.rejects(contract.durableRpc({ rpc() { return Promise.resolve({ data: [], error: null }); } },
      "get_notification_dispatch_state", {}, contract.createBudget()), e => e.code === "rpc_abort_api_unavailable");
  });
  await test("validators correspond to SQL RETURNS TABLE; field mutations fail, no coercion", async () => {
    const f = fixture();
    const args = { p_worker_id: randomUUID(), p_expected_epoch: 0, p_limit: 25 };
    const samples = {};
    samples.get_notification_dispatch_state = f.handle("get_notification_dispatch_state", {}).data;
    samples.acquire_notification_dispatch_job = f.handle("acquire_notification_dispatch_job", args).data;
    samples.prepare_notification_dispatch_batch = f.handle("prepare_notification_dispatch_batch", {}).data;
    const a = f.attempts[0];
    samples.begin_notification_dispatch_send = f.handle("begin_notification_dispatch_send",
      { p_attempt_id: a.id, p_operation_id: a.begin, p_timeout_ms: 8000 }).data;
    samples.record_notification_dispatch_result = f.handle("record_notification_dispatch_result",
      { p_attempt_id: a.id, p_claim_token: a.token, p_worker_id: args.p_worker_id, p_send_epoch: 1,
        p_operation_id: a.record, p_outcome: "sent" }).data;
    samples.settle_notification_dispatch_job = f.handle("settle_notification_dispatch_job",
      { p_operation_id: samples.acquire_notification_dispatch_job[0].settle_operation_id }).data;
    samples.enqueue_notification_dispatch = [{ disposition: "created", job_id: f.jobId, event_id: a.id,
      job_stage: "ready", event_status: "queued" }];
    samples.release_notification_dispatch_attempt = [{ disposition: "released", attempt_id: a.id, attempt_stage: "released",
      released_attempt_count: 0, delivery_status: "queued", delivery_attempt_count: 0, next_attempt_at: null,
      event_status: "sending", job_stage: "leased" }];
    for (const [name, rows] of Object.entries(samples)) {
      const header = sql.split("create function public." + name + "(")[1].split("language plpgsql")[0];
      const expected = header.match(/returns table\(([^\n]+)\)/)[1].split(",").map(c => c.trim().split(" ")[0]).sort();
      assert.deepEqual(Object.keys(rows[0]).sort(), expected);
      assert.deepEqual(contract.validateDurableResponse(name, rows), rows);
      for (const key of Object.keys(rows[0])) {
        const missing = { ...rows[0] }; delete missing[key];
        assert.throws(() => contract.validateDurableResponse(name, [missing]), /unexpected|rejected/);
        assert.throws(() => contract.validateDurableResponse(name, [{ ...rows[0], [key]: {} }]));
      }
      for (const value of [null, undefined, {}, [null]]) assert.throws(() => contract.validateDurableResponse(name, value));
    }
    assert.throws(() => contract.validateDurableResponse("begin_notification_dispatch_send",
      [{ ...samples.begin_notification_dispatch_send[0], permit_granted: false }]), "false permit cannot carry credentials");
  });
  assert.match(workerSource, /auth: "secret"/);
  assert.doesNotMatch(workerSource, /auth: "none"|auth: "user"|claim_notification_delivery_batch|record_notification_delivery_result|release_notification_delivery_claim/);
  assert.match(fs.readFileSync(path.join(root, "supabase/config.toml"), "utf8"),
    /\[functions.dispatch-class-notifications\][\s\S]*verify_jwt = false/);
  console.log("PASS: Phase 2B durable worker behavioral groups=" + groups + "; real push=NO");
})().catch(error => { console.error(error); process.exitCode = 1; });
