const assert = require("node:assert/strict");
const { createECDH } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = __dirname;
const contractPath = path.join(root, "supabase/functions/_shared/notification-contract.ts");
const webPushPath = path.join(root, "supabase/functions/_shared/web-push.ts");
const functionPath = path.join(root, "supabase/functions/send-class-notification/index.ts");
const denoPath = path.join(root, "supabase/functions/send-class-notification/deno.json");
const configPath = path.join(root, "supabase/config.toml");

const contractSource = fs.readFileSync(contractPath, "utf8");
const webPushSource = fs.readFileSync(webPushPath, "utf8");
const functionSource = fs.readFileSync(functionPath, "utf8");
const denoConfig = JSON.parse(fs.readFileSync(denoPath, "utf8"));
const supabaseConfig = fs.readFileSync(configPath, "utf8");

function expectContractError(fn, code) {
  assert.throws(fn, (error) => error?.name === "ContractError" && error?.code === code);
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

// node:crypto's ECDH.getPrivateKey() returns the raw scalar without fixed-width
// padding, so a key with a leading zero byte comes back short (~1/256 of keys).
// Pad to the curve's 32-byte width so key generation here is never flaky.
function fixedLengthPrivateKey(ecdh, length = 32) {
  const raw = ecdh.getPrivateKey();
  if (raw.length === length) return raw;
  const padded = Buffer.alloc(length);
  raw.copy(padded, length - raw.length);
  return padded;
}

async function importWebPushWithLocalStub() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "budget2a-web-push-test-"));
  const modulePath = path.join(temporaryRoot, "web-push.ts");
  const packagePath = path.join(temporaryRoot, "node_modules/web-push");
  fs.mkdirSync(packagePath, { recursive: true });
  fs.writeFileSync(path.join(packagePath, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  fs.writeFileSync(path.join(packagePath, "index.js"), "export async function sendNotification() { throw new Error('network_forbidden'); }\n");
  fs.copyFileSync(webPushPath, modulePath);
  try {
    return await import(`${pathToFileURL(modulePath).href}?audit=${Date.now()}`);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function importFunctionWithLocalStubs() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "budget2a-notification-function-test-"));
  const sharedPath = path.join(temporaryRoot, "supabase/functions/_shared");
  const functionDirectory = path.join(temporaryRoot, "supabase/functions/send-class-notification");
  const serverPackagePath = path.join(temporaryRoot, "node_modules/@supabase/server");
  const webPushPackagePath = path.join(temporaryRoot, "node_modules/web-push");
  fs.mkdirSync(sharedPath, { recursive: true });
  fs.mkdirSync(functionDirectory, { recursive: true });
  fs.mkdirSync(serverPackagePath, { recursive: true });
  fs.mkdirSync(webPushPackagePath, { recursive: true });
  fs.copyFileSync(contractPath, path.join(sharedPath, "notification-contract.ts"));
  fs.copyFileSync(path.join(root, "supabase/functions/_shared/cors.ts"), path.join(sharedPath, "cors.ts"));
  fs.copyFileSync(webPushPath, path.join(sharedPath, "web-push.ts"));
  fs.copyFileSync(functionPath, path.join(functionDirectory, "index.ts"));
  fs.writeFileSync(path.join(serverPackagePath, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  fs.writeFileSync(path.join(serverPackagePath, "index.js"), "export function withSupabase(_options, handler) { return handler; }\n");
  fs.writeFileSync(path.join(webPushPackagePath, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  fs.writeFileSync(path.join(webPushPackagePath, "index.js"), [
    "export async function sendNotification() {",
    "  globalThis.__budget2aWebPushSendCount = (globalThis.__budget2aWebPushSendCount ?? 0) + 1;",
    "  return { statusCode: 201, headers: {} };",
    "}",
    "",
  ].join("\n"));
  try {
    return await import(`${pathToFileURL(path.join(functionDirectory, "index.ts")).href}?audit=${Date.now()}`);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

(async () => {
  const contract = await import(pathToFileURL(contractPath).href);
  const { withAdminCors, ADMIN_ORIGIN } = await import(pathToFileURL(path.join(root, "supabase/functions/_shared/cors.ts")).href);
  let corsCalls = 0;
  const corsHandler = withAdminCors(() => {
    corsCalls++;
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { vary: "Accept" } });
  });
  const corsRequest = (origin, method = "POST", extra = {}) => new Request("http://localhost/admin", {
    method, headers: { ...(origin === undefined ? {} : { origin }), ...extra },
  });
  for (const origin of [ADMIN_ORIGIN, undefined]) {
    const result = await corsHandler(corsRequest(origin));
    assert.equal(result.status, 401, "CORS must not bypass authentication");
    assert.equal(result.headers.get("access-control-allow-origin"), origin ?? null);
    assert.equal(result.headers.get("vary"), "Accept, Origin");
  }
  for (const origin of ["https://evil.invalid", "null", ADMIN_ORIGIN + ".evil.invalid"]) {
    const result = await corsHandler(corsRequest(origin));
    assert.equal(result.status, 403);
    assert.equal(result.headers.get("access-control-allow-origin"), null);
  }
  const preflight = { "access-control-request-method": "POST",
    "access-control-request-headers": "Authorization, apikey, Content-Type, x-client-info" };
  const accepted = await corsHandler(corsRequest(ADMIN_ORIGIN, "OPTIONS", preflight));
  assert.equal(accepted.status, 204);
  assert.equal(accepted.headers.get("access-control-allow-origin"), ADMIN_ORIGIN);
  assert.equal(accepted.headers.get("access-control-allow-methods"), "POST");
  for (const [origin, extra] of [["https://evil.invalid", preflight], [undefined, preflight],
    [ADMIN_ORIGIN, { ...preflight, "access-control-request-method": "DELETE" }],
    [ADMIN_ORIGIN, { ...preflight, "access-control-request-headers": "x-unapproved" }]]) {
    assert.equal((await corsHandler(corsRequest(origin, "OPTIONS", extra))).status, 403);
  }
  assert.equal(corsCalls, 2, "preflight/rejected origins never invoke authenticated handler");
  assert.match(functionSource, /withAdminCors\(withSupabase\(\{ auth: "user", cors: "disabled" \}/);
  const { buildEventDraft, buildPushPayload, canonicalJson, FIXED_SOURCE_IDS, parseNotificationRequest,
    validateNotificationRequest } = contract;
  const { loadVapidConfig } = await importWebPushWithLocalStub();
  const encode = (value) => new TextEncoder().encode(value);
  assert.equal(parseNotificationRequest(
    "POST",
    "application/json; charset=utf-8",
    encode(JSON.stringify({ eventType: "schedule", sourceId: FIXED_SOURCE_IDS.schedule, notify: true })),
  ).eventType, "schedule");
  expectContractError(() => parseNotificationRequest("GET", "application/json", encode("{}")), "method_not_allowed");
  expectContractError(() => parseNotificationRequest("POST", "text/plain", encode("{}")), "json_required");
  expectContractError(() => parseNotificationRequest("POST", "application/json", new Uint8Array()), "empty_request");
  expectContractError(() => parseNotificationRequest("POST", "application/json", encode("{")), "invalid_json");
  expectContractError(() => parseNotificationRequest("POST", "application/json", new Uint8Array(contract.REQUEST_MAX_BYTES + 1)), "request_too_large");

  assert.deepEqual(validateNotificationRequest({
    eventType: "schedule",
    sourceId: FIXED_SOURCE_IDS.schedule,
    notify: true,
  }), {
    eventType: "schedule",
    sourceId: "class_profile:useful_info.schedule",
    notify: true,
  });
  assert.equal(validateNotificationRequest({
    eventType: "memo",
    sourceId: FIXED_SOURCE_IDS.memo,
    notify: true,
  }).eventType, "memo");
  assert.equal(validateNotificationRequest({
    eventType: "announcement",
    sourceId: "550E8400-E29B-41D4-A716-446655440000",
    notify: true,
  }).sourceId, "550e8400-e29b-41d4-a716-446655440000");

  expectContractError(() => validateNotificationRequest(null), "invalid_request");
  expectContractError(() => validateNotificationRequest({ eventType: "schedule", sourceId: FIXED_SOURCE_IDS.schedule }), "invalid_request_fields");
  expectContractError(() => validateNotificationRequest({ eventType: "schedule", sourceId: FIXED_SOURCE_IDS.schedule, notify: true, title: "Injected" }), "invalid_request_fields");
  expectContractError(() => validateNotificationRequest({ eventType: "schedule", sourceId: FIXED_SOURCE_IDS.schedule, notify: true, body: "Injected" }), "invalid_request_fields");
  expectContractError(() => validateNotificationRequest({ eventType: "schedule", sourceId: FIXED_SOURCE_IDS.schedule, notify: true, url: "https://evil.invalid" }), "invalid_request_fields");
  expectContractError(() => validateNotificationRequest({ eventType: "schedule", sourceId: FIXED_SOURCE_IDS.schedule, notify: false }), "notification_not_confirmed");
  expectContractError(() => validateNotificationRequest({ eventType: "expense", sourceId: "x", notify: true }), "unsupported_event_type");
  expectContractError(() => validateNotificationRequest({ eventType: "schedule", sourceId: "class_profile", notify: true }), "invalid_source_id");
  expectContractError(() => validateNotificationRequest({ eventType: "memo", sourceId: FIXED_SOURCE_IDS.schedule, notify: true }), "invalid_source_id");
  expectContractError(() => validateNotificationRequest({ eventType: "announcement", sourceId: "not-a-uuid", notify: true }), "invalid_source_id");

  assert.equal(canonicalJson({ z: 1, a: { d: 2, b: 1 } }), canonicalJson({ a: { b: 1, d: 2 }, z: 1 }));
  const scheduleRequest = validateNotificationRequest({
    eventType: "schedule",
    sourceId: FIXED_SOURCE_IDS.schedule,
    notify: true,
  });
  const scheduleA = await buildEventDraft(scheduleRequest, {
    usefulInfo: { schedule: { tue: ["Математика"], mon: ["Русский язык"] } },
  });
  const scheduleB = await buildEventDraft(scheduleRequest, {
    usefulInfo: { schedule: { mon: ["Русский язык"], tue: ["Математика"] } },
  });
  const scheduleChanged = await buildEventDraft(scheduleRequest, {
    usefulInfo: { schedule: { mon: ["Литература"], tue: ["Математика"] } },
  });
  assert.equal(scheduleA.eventKey, scheduleB.eventKey, "canonical content must create a deterministic event key");
  assert.equal(scheduleA.contentHash, scheduleB.contentHash);
  assert.notEqual(scheduleA.eventKey, scheduleChanged.eventKey, "authoritative content changes must change the event key");
  assert.match(scheduleA.eventKey, /^class_push:v1:schedule:[0-9a-f]{64}$/u);
  assert.ok(scheduleA.title.length <= 160 && scheduleA.body.length <= 500);

  const memo = await buildEventDraft(validateNotificationRequest({
    eventType: "memo",
    sourceId: FIXED_SOURCE_IDS.memo,
    notify: true,
  }), { usefulInfo: { notes: ["  Принести форму  ", "Собрание в пятницу"] } });
  assert.equal(memo.sourceEntity, "class_profile");
  assert.match(memo.body, /Принести форму/u);

  const announcementRequest = validateNotificationRequest({
    eventType: "announcement",
    sourceId: "550e8400-e29b-41d4-a716-446655440000",
    notify: true,
  });
  const announcement = await buildEventDraft(announcementRequest, {
    announcement: {
      id: announcementRequest.sourceId,
      body: "Важное объявление",
      is_pinned: true,
      archived_at: null,
    },
  });
  assert.equal(announcement.sourceEntity, "chat_messages");
  await assert.rejects(() => buildEventDraft(announcementRequest, {
    announcement: { id: announcementRequest.sourceId, body: "Скрыто", is_pinned: false, archived_at: null },
  }), (error) => error?.code === "announcement_not_eligible");
  await assert.rejects(() => buildEventDraft(announcementRequest, {
    announcement: { id: announcementRequest.sourceId, body: "Архив", is_pinned: true, archived_at: "2026-01-01" },
  }), (error) => error?.code === "announcement_not_eligible");

  const payload = buildPushPayload(scheduleA, "c2c269c8-a70e-4b61-9cc1-1bbfac3b0c0d");
  assert.deepEqual(Object.keys(payload).sort(), ["body", "eventId", "title", "type", "url"]);
  assert.equal(payload.url, "/");
  assert.ok(!JSON.stringify(payload).match(/endpoint|p256dh|claim_token|recipient|email/iu));

  const firstPair = createECDH("prime256v1");
  firstPair.generateKeys();
  const secondPair = createECDH("prime256v1");
  secondPair.generateKeys();
  const validPublicKey = encodeBase64Url(firstPair.getPublicKey(undefined, "uncompressed"));
  const validPrivateKey = encodeBase64Url(fixedLengthPrivateKey(firstPair));
  const otherPublicKey = encodeBase64Url(secondPair.getPublicKey(undefined, "uncompressed"));
  const vapidEnv = (subject, publicKey = validPublicKey, privateKey = validPrivateKey) => (name) => ({
    VAPID_SUBJECT: subject,
    VAPID_PUBLIC_KEY: publicKey,
    VAPID_PRIVATE_KEY: privateKey,
  })[name];
  assert.deepEqual(loadVapidConfig(vapidEnv("mailto:test@example.invalid")), {
    subject: "mailto:test@example.invalid",
    publicKey: validPublicKey,
    privateKey: validPrivateKey,
  });
  assert.equal(loadVapidConfig(vapidEnv("https://example.invalid/push-contact")).subject, "https://example.invalid/push-contact");
  assert.throws(() => loadVapidConfig(vapidEnv("not-a-contact-uri")), /invalid_vapid_subject/u);
  assert.throws(() => loadVapidConfig(vapidEnv("mailto:test@example.invalid", "not+base64url", validPrivateKey)), /invalid_vapid_public_key/u);
  assert.throws(() => loadVapidConfig(vapidEnv("mailto:test@example.invalid", encodeBase64Url(new Uint8Array(64)), validPrivateKey)), /invalid_vapid_public_key/u);
  const wrongPrefix = firstPair.getPublicKey(undefined, "uncompressed");
  wrongPrefix[0] = 0x05;
  assert.throws(() => loadVapidConfig(vapidEnv("mailto:test@example.invalid", encodeBase64Url(wrongPrefix), validPrivateKey)), /invalid_vapid_public_key/u);
  const invalidPoint = new Uint8Array(65);
  invalidPoint[0] = 0x04;
  assert.throws(() => loadVapidConfig(vapidEnv("mailto:test@example.invalid", encodeBase64Url(invalidPoint), validPrivateKey)), /invalid_vapid_public_key/u);
  assert.throws(() => loadVapidConfig(vapidEnv("mailto:test@example.invalid", validPublicKey, encodeBase64Url(new Uint8Array(32)))), /invalid_vapid_private_key/u);
  assert.throws(() => loadVapidConfig(vapidEnv("mailto:test@example.invalid", validPublicKey, encodeBase64Url(new Uint8Array(32).fill(0xff)))), /invalid_vapid_private_key/u);
  assert.throws(() => loadVapidConfig(vapidEnv("mailto:test@example.invalid", otherPublicKey, validPrivateKey)), /invalid_vapid_key_pair/u);


  const { handleAdminRequest } = await importFunctionWithLocalStubs();
  const userId = "550e8400-e29b-41d4-a716-446655440000";
  const jobId = "c2c269c8-a70e-4b61-9cc1-1bbfac3b0c0d";
  const eventId = "41b4f33b-6cfa-410e-a5e1-2d909a246ae6";
  const enqueue = { disposition: "created", job_id: jobId, event_id: eventId, job_stage: "ready", event_status: "queued" };
  function context(options = {}) {
    const calls = [];
    const ctx = {
      userClaims: { id: userId },
      supabase: {
        async rpc(name) { calls.push(name); return { data: options[name] ?? true, error: options.authError ?? null }; },
        from(table) {
          calls.push(table);
          const query = { select() { return query; }, eq() { return query; }, is() { return query; },
            async maybeSingle() { return { data: { useful_info: { schedule: { mon: ["Math"] } } }, error: null }; } };
          return query;
        },
      },
      supabaseAdmin: {
        from() { throw new Error("direct table mutation forbidden"); },
        rpc(name, args) {
          calls.push([name, args]);
          const promise = Promise.resolve({ data: Object.hasOwn(options, "data") ? options.data : [enqueue],
            error: options.error ?? null });
          return { then: promise.then.bind(promise), abortSignal() { return promise; } };
        },
      },
    };
    return { ctx, calls };
  }
  const request = (input = { eventType: "schedule", sourceId: FIXED_SOURCE_IDS.schedule, notify: true }) =>
    new Request("http://localhost/send-class-notification", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  let count = 0;
  for (const [row, status, ok] of [
    [enqueue, 202, true],
    [{ ...enqueue, disposition: "existing" }, 202, true],
    [{ ...enqueue, disposition: "existing", job_stage: "leased", event_status: "sending" }, 202, true],
    [{ ...enqueue, disposition: "existing", job_stage: "completed", event_status: "sent" }, 200, true],
    [{ ...enqueue, disposition: "existing", job_stage: "completed", event_status: "failed" }, 409, false],
    [{ ...enqueue, disposition: "existing", job_stage: "blocked", event_status: "failed" }, 503, false],
  ]) {
    const { ctx, calls } = context({ data: [row] });
    const result = await handleAdminRequest(request(), ctx);
    assert.equal(result.status, status);
    const body = await result.json(); assert.equal(body.ok, ok);
    assert.equal(body.duplicate, row.disposition === "existing");
    const privileged = calls.filter(Array.isArray);
    assert.equal(privileged.length, 1);
    assert.equal(privileged[0][0], "enqueue_notification_dispatch");
    assert.equal(privileged[0][1].p_created_by, userId);
    assert.equal(privileged[0][1].p_deep_link, "/");
    assert.equal(privileged[0][1].p_title, "Расписание класса обновлено");
    assert(calls.indexOf("is_admin") < calls.indexOf(privileged[0]));
    count++;
  }
  for (const message of ["EVENT_CONFLICT", "EVENT_WITHOUT_DISPATCH_JOB"]) {
    const { ctx } = context({ error: { message, endpoint: "SECRET" } });
    const result = await handleAdminRequest(request(), ctx);
    assert.equal(result.status, 409); assert.equal((await result.json()).error, "event_conflict"); count++;
  }
  for (const data of [null, undefined, {}, [], [null], [{ ...enqueue, job_id: "bad" }],
    [{ ...enqueue, event_status: null }], [{ ...enqueue, job_stage: "alien" }],
    [{ ...enqueue, disposition: "created", job_stage: "completed" }]]) {
    const { ctx } = context({ data }); const result = await handleAdminRequest(request(), ctx);
    assert.equal(result.status, 502); assert(!JSON.stringify(await result.json()).includes("SECRET")); count++;
  }
  for (const options of [{ can_access_budget: false }, { is_admin: false }, { authError: { message: "SECRET" } }]) {
    const { ctx, calls } = context(options);
    const result = await handleAdminRequest(request(), ctx);
    assert(result.status >= 400); assert.equal(calls.filter(Array.isArray).length, 0); count++;
  }
  {
    const { ctx, calls } = context(); ctx.userClaims = {};
    assert.equal((await handleAdminRequest(request(), ctx)).status, 401);
    assert.equal(calls.length, 0); count++;
  }
  {
    const { ctx, calls } = context();
    assert.equal((await handleAdminRequest(request({ eventType: "schedule", sourceId: FIXED_SOURCE_IDS.schedule,
      notify: true, recipientIds: [userId] }), ctx)).status, 400);
    assert.equal(calls.filter(Array.isArray).length, 0); count++;
  }
  assert.equal(globalThis.__budget2aWebPushSendCount ?? 0, 0);
  assert.doesNotMatch(functionSource, /sendWebPush|web-push|claim_notification_delivery_batch|record_notification_delivery_result|release_notification_delivery_claim|deliverImmediately/);
  assert.doesNotMatch(functionSource, /\.insert\(|\.update\(|\.delete\(/);
  assert.match(functionSource, /auth: "user"/);
  assert.match(supabaseConfig, /\[functions.send-class-notification\][\s\S]*?verify_jwt = true/);
  assert.equal(denoConfig.imports["@supabase/server"], "npm:@supabase/server@1.5.3");
  assert.equal(denoConfig.imports["web-push"], "npm:web-push@3.6.7");
  console.log("PASS: Phase 2B admin enqueue-only, request/source, VAPID behavioral regression; admin cases=" + count);
})().catch(error => { console.error(error); process.exitCode = 1; });
