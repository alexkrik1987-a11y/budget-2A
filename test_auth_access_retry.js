"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const app = fs.readFileSync("app.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");
const future = { code: "PGRST303", message: "JWT issued at future" };

function source(name) {
  const start = app.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert(start >= 0, name);
  return app.slice(start, app.indexOf("\n}", start) + 2);
}

function node() {
  const classes = new Set(["hidden"]);
  return { textContent: "", classList: {
    add: value => classes.add(value), remove: value => classes.delete(value),
    contains: value => classes.has(value)
  } };
}

function harness(results, onWait = null) {
  const calls = [], waits = [], errors = [], notices = [];
  const state = { sessionRunId: 0, handledSessionIdentity: null, session: null, user: null, accessRetryAvailable: false };
  const dom = { retryAccessButton: node(), authError: node(), emailPasswordStatus: node() };
  let opened = 0, signedOut = 0;
  const ctx = {
    state, dom, APP_VERSION: "test", CORE_DATA_TIMEOUT_MS: 10000, OPTIONAL_DATA_TIMEOUT_MS: 7000,
    window: { clearTimeout() {}, setTimeout(fn, ms) {
      waits.push(ms);
      Promise.resolve().then(async () => { if (onWait) await onWait(ctx, ms); fn(); });
    } },
    console: { error: error => errors.push(error), warn() {} },
    db: { rpc: async name => {
      calls.push(name);
      if (name === "can_access_budget") {
        assert(results.length > 0, "unexpected extra access call");
        return results.shift();
      }
      if (name === "is_admin") return { data: false, error: null };
      if (name === "request_class_access") return { data: { request_status: "PENDING" }, error: null };
      throw Error(name);
    }, auth: { signOut() { signedOut++; } } },
    withTimeout: async fn => fn(),
    cleanupPresence: async () => {}, resetBudgetDataState() {}, renderUser() {}, applyRoleToUi() {},
    setProtectedAccess(value) { if (value) opened++; },
    showNotice: text => notices.push(text), clearSessionRestoreHint() {}, rememberSessionRestoreHint() {},
    hideLoadingScreen() {}, showAuthError: text => { dom.authError.textContent = text; dom.authError.classList.remove("hidden"); },
    showEmailPasswordStatus: text => { dom.emailPasswordStatus.textContent = text; dom.emailPasswordStatus.classList.remove("hidden"); },
    hideElement: element => element?.classList.add("hidden"), friendlyError: error => error.message,
    subscribePresence() {}, loadNotificationSettings() {}, loadAllData: async () => {}, subscribeRealtime() {},
    unsubscribeRealtime() {}, closeChatPanel() {}, renderAccessRequestStatus() {}
  };
  vm.createContext(ctx);
  for (const name of ["sessionIdentity", "queueSessionHandling", "isCurrentSessionRun", "isFutureIssuedJwtError", "isCurrentAccessSession", "checkClassAccess", "retryClassAccess", "handleSession"])
    vm.runInContext(source(name), ctx);
  return { ctx, state, dom, calls, waits, notices, errors, opened: () => opened, signedOut: () => signedOut };
}

const session = () => ({ user: { id: "test-user" }, access_token: "test-token-never-log" });
const fail = () => ({ data: null, error: future });
const ok = () => ({ data: true, error: null });

async function run() {
  assert.equal((html.match(/id="retryAccessButton"/g) || []).length, 1);
  assert.match(html, /id="retryAccessButton"[^>]*type="button">Повторить/);
  assert(app.includes('dom.retryAccessButton.addEventListener("click", retryClassAccess)'));

  const second = harness([fail(), ok()]);
  const s = session();
  await second.ctx.queueSessionHandling(s);
  assert.deepEqual(second.waits, [2000]);
  assert.equal(second.calls.filter(n => n === "can_access_budget").length, 2);
  assert.equal(second.state.accessApproved, true);
  assert.equal(second.opened(), 1);
  assert.equal(second.state.session, s);
  assert.equal(second.signedOut(), 0);
  assert(second.dom.retryAccessButton.classList.contains("hidden"));
  await second.ctx.queueSessionHandling(s);
  assert.equal(second.calls.filter(n => n === "can_access_budget").length, 2, "normal duplicate stays deduplicated");

  const exhausted = harness([fail(), fail(), fail(), ok()]);
  await exhausted.ctx.queueSessionHandling(session());
  assert.deepEqual(exhausted.waits, [2000, 5000]);
  assert.equal(exhausted.opened(), 0);
  assert.equal(exhausted.state.accessApproved, false);
  assert(exhausted.state.session);
  assert.equal(exhausted.signedOut(), 0);
  assert.equal(exhausted.state.accessRetryAvailable, true);
  assert(!exhausted.dom.retryAccessButton.classList.contains("hidden"));
  assert.match(exhausted.dom.authError.textContent, /Вы остались в аккаунте/);
  const retryRun = exhausted.state.sessionRunId;
  const retry = exhausted.ctx.retryClassAccess();
  await exhausted.ctx.retryClassAccess(); // Rapid second click must not start another run.
  await retry;
  assert.equal(exhausted.state.sessionRunId, retryRun + 1);
  assert.equal(exhausted.calls.filter(n => n === "can_access_budget").length, 4);
  assert.equal(exhausted.opened(), 1);

  const denied = harness([{ data: false, error: null }]);
  await denied.ctx.queueSessionHandling(session());
  assert.deepEqual(denied.calls, ["can_access_budget", "request_class_access"]);
  assert.deepEqual(denied.waits, []);
  assert.equal(denied.opened(), 0);
  assert.equal(denied.state.accessRetryAvailable, false);

  for (const error of [{ code: "PGRST303", message: "JWT expired" }, { code: "OTHER", message: "JWT issued at future" }]) {
    const other = harness([{ data: null, error }]);
    await other.ctx.queueSessionHandling(session());
    assert.deepEqual(other.waits, []);
    assert.equal(other.calls.length, 1);
    assert.equal(other.opened(), 0);
    assert.equal(other.state.accessRetryAvailable, false);
  }

  const logout = harness([fail()], async ctx => { await ctx.queueSessionHandling(null); });
  await logout.ctx.queueSessionHandling(session());
  assert.equal(logout.calls.length, 1);
  assert.equal(logout.state.session, null);
  assert.equal(logout.opened(), 0);
  assert(logout.dom.retryAccessButton.classList.contains("hidden"));

  const replaced = harness([fail()], ctx => { ctx.state.session = { ...session(), access_token: "replacement-token" }; });
  await replaced.ctx.queueSessionHandling(session());
  assert.equal(replaced.calls.length, 1, "changed session cancels pending automatic retry");
  assert.equal(replaced.opened(), 0);

  const third = harness([fail(), fail(), ok()]);
  await third.ctx.queueSessionHandling(session());
  assert.deepEqual(third.waits, [2000, 5000]);
  assert.equal(third.opened(), 1);

  const diagnosticLogs = [];
  let response = new Response(JSON.stringify({ ...future, details: "secret-must-not-be-logged" }), {
    status: 401, headers: { "sb-request-id": "test-request-id" }
  });
  const d = { fetch: async () => response, URL, window: { location: { href: "https://site.invalid/" } },
    console: { warn: (...args) => diagnosticLogs.push(args) } };
  vm.createContext(d);
  vm.runInContext(source("isFutureIssuedJwtError") + "\n" + source("fetchWithAccessDiagnostics"), d);
  const returned = await d.fetchWithAccessDiagnostics("/supabase/rest/v1/rpc/can_access_budget", { headers: { Authorization: "Bearer never-log-this" } });
  assert.equal(returned, response, "SDK receives unchanged response");
  assert.equal((await returned.json()).details, "secret-must-not-be-logged");
  assert.equal(diagnosticLogs[0][1].code, "PGRST303");
  assert.equal(diagnosticLogs[0][1].requestId, "test-request-id");
  assert(!JSON.stringify(diagnosticLogs).includes("secret-must-not-be-logged"));
  assert(!JSON.stringify(diagnosticLogs).includes("never-log-this"));
  response = new Response(JSON.stringify(future), { status: 401 });
  await d.fetchWithAccessDiagnostics("/supabase/rest/v1/rpc/can_access_budget");
  assert.equal(diagnosticLogs[1][1].requestId, null, "missing ID is not fabricated");
  await d.fetchWithAccessDiagnostics("/supabase/rest/v1/rpc/another_rpc");
  assert.equal(diagnosticLogs.length, 2, "diagnostics is scoped to access RPC");
  console.log("Auth access retry: PASS (2nd/3rd attempt, exhaustion/manual retry, denial/other JWT, logout/session change, safe request ID)");
}

run().catch(error => { console.error(error); process.exitCode = 1; });
