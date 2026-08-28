"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const app = fs.readFileSync("app.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("styles.css", "utf8");
const serviceWorker = fs.readFileSync("sw.js", "utf8");

const presenceStart = app.indexOf("/* =========================================================\n   PRIVATE REALTIME PRESENCE");
const presenceEnd = app.indexOf("function realtimeSubscriptionKey()", presenceStart);
assert(presenceStart >= 0 && presenceEnd > presenceStart, "не найден отдельный Presence lifecycle");
const presenceCode = app.slice(presenceStart, presenceEnd);
const cleanupStart = presenceCode.indexOf("async function cleanupPresenceNow()");
const cleanupEnd = presenceCode.indexOf("function cleanupPresence()", cleanupStart);
const subscribeStart = presenceCode.indexOf("async function subscribePresenceNow()");
const subscribeEnd = presenceCode.indexOf("function subscribePresence()", subscribeStart);
const trackStart = presenceCode.indexOf("async function trackPresence(");
const trackEnd = presenceCode.indexOf("async function subscribePresenceNow()", trackStart);
const cleanupCode = presenceCode.slice(cleanupStart, cleanupEnd);
const subscribeCode = presenceCode.slice(subscribeStart, subscribeEnd);
const trackCode = presenceCode.slice(trackStart, trackEnd);

assert(app.includes('const PRESENCE_TOPIC = "class:2a:presence";'), "не задан отдельный Presence topic");
assert(app.includes("const presenceSessionId = crypto.randomUUID();"), "Presence key должен быть случайным UUID на жизнь страницы");
assert(/db\.channel\(PRESENCE_TOPIC,\s*\{\s*config:\s*\{\s*private:\s*true,\s*presence:\s*\{\s*key:\s*presenceSessionId\s*\}/s.test(presenceCode), "Presence channel должен быть private с отдельным key");
assert(presenceCode.includes('channel.track({ online: true })'), "Presence payload должен быть только { online: true }");

for (const forbidden of ["user_id", "email", "user_metadata", "access_token", "state.isAdmin", "state.user", "roleBadge"]) {
  assert(!presenceCode.includes(forbidden), `Presence lifecycle не должен передавать или использовать PII: ${forbidden}`);
}

assert(presenceCode.includes('.on("presence", { event: "sync" }'), "счётчик должен обновляться на Presence sync");
assert(presenceCode.includes("const currentPresenceState = channel.presenceState();"), "источником должен быть presenceState()");
assert(presenceCode.includes("renderPresenceCount(Object.keys(currentPresenceState).length);"), "должны считаться ключи активных вкладок");
assert(presenceCode.includes("navigator.onLine === false"), "поздний sync после перехода offline не должен возвращать устаревший count");
assert(!/event:\s*["'](?:join|leave)["']/i.test(presenceCode), "нельзя вести ручной счёт через join/leave");
assert(!/\+\+|--/.test(app.slice(app.indexOf("function handlePresenceSync"), app.indexOf("function schedulePresenceReconnect"))), "Presence sync не должен вручную увеличивать или уменьшать count");

assert(app.includes("accessApproved: false"), "до access gate Presence должен быть запрещён");
assert(app.includes("state.accessApproved = true;"), "успешный can_access_budget должен сохранять accessApproved");
assert(/if \(!db \|\| !state\.session \|\| !state\.accessApproved\) return;/.test(presenceCode), "subscribe должен требовать session + accessApproved");
assert(/if \(!state\.session \|\| !state\.accessApproved\) return;\s*void subscribePresence\(\);/.test(presenceCode), "network reconnect должен требовать session + accessApproved");
assert(/function handlePresencePageShow\(\) \{\s*if \(state\.session && state\.accessApproved\) void subscribePresence\(\);\s*\}/.test(presenceCode), "BFCache reconnect должен требовать session + accessApproved");
assert(app.indexOf("state.accessApproved = true;") > app.indexOf('db.rpc("can_access_budget")'), "accessApproved нельзя устанавливать до can_access_budget()");

const logoutCode = app.slice(app.indexOf("async function logout()"), app.indexOf("function sessionIdentity"));
const logoutFunctionCode = logoutCode.slice(0, logoutCode.indexOf("async function restorePresenceAfterFailedLogout"));
const logoutGateIndex = logoutFunctionCode.indexOf("state.accessApproved = false;");
assert(logoutGateIndex >= 0, "logout должен немедленно закрывать accessApproved");
assert(logoutGateIndex < logoutFunctionCode.indexOf("await cleanupPresence();"), "logout должен закрывать access gate до cleanup");
assert(logoutGateIndex < logoutFunctionCode.indexOf("await db.auth.signOut();"), "logout должен закрывать access gate до signOut");
assert(logoutCode.includes("await cleanupPresence();"), "logout должен выполнить Presence cleanup");
assert(/if \(error\) \{[\s\S]*?await restorePresenceAfterFailedLogout\(logoutUserId\);[\s\S]*?\}/.test(logoutFunctionCode), "Presence можно восстанавливать только в ветке ошибки signOut");
assert(logoutCode.includes("const sessionResult = await db.auth.getSession();"), "после ошибки signOut нужно повторно проверить фактическую session");
assert(logoutCode.includes('() => db.rpc("can_access_budget")'), "после ошибки signOut нужно повторно проверить доступ");
assert(logoutCode.indexOf('db.rpc("can_access_budget")') < logoutCode.lastIndexOf("state.accessApproved = true;"), "accessApproved нельзя восстанавливать до новой проверки доступа");
assert(logoutCode.lastIndexOf("state.accessApproved = true;") < logoutCode.lastIndexOf("void subscribePresence();"), "Presence можно восстановить только после accessApproved=true");
assert(/generation !== state\.presenceGeneration[\s\S]*?channel !== state\.presenceChannel[\s\S]*?!state\.session[\s\S]*?!state\.accessApproved/.test(trackCode), "непосредственно перед track нужны generation/channel/session/access проверки");
assert(presenceCode.includes("const untrackStatus = await channel.untrack();"), "cleanup должен ожидать untrack()");
assert(presenceCode.includes("const removeStatus = await db.removeChannel(channel);"), "cleanup должен ожидать removeChannel()");
assert(presenceCode.indexOf("channel.untrack()") < presenceCode.indexOf("db.removeChannel(channel)"), "untrack должен выполняться до removeChannel");
assert(cleanupCode.includes('if (removeStatus !== "ok")'), "неуспешный removeChannel должен обрабатываться явно");
assert(/if \(removeStatus !== "ok"\) \{[\s\S]*?return false;[\s\S]*?\}/.test(cleanupCode), "неуспешный removeChannel должен возвращать false");
assert(/catch \(error\) \{\s*console\.error\("Presence removeChannel error:", error\);\s*return false;\s*\}/.test(cleanupCode), "исключение removeChannel должно возвращать false");
assert(subscribeCode.includes("const cleanupSucceeded = await cleanupPresenceNow();"), "subscribe должен получить результат cleanup");
assert(subscribeCode.indexOf("if (!cleanupSucceeded) return;") < subscribeCode.indexOf("db.channel(PRESENCE_TOPIC"), "новый канал нельзя создавать после неуспешного cleanup");

assert(presenceCode.includes('dom.presenceStatusText.textContent = "Онлайн: —"'), "до sync должен показываться неопределённый статус");
assert(!presenceCode.includes('dom.presenceStatusText.textContent = "Онлайн: 0"'), "до sync нельзя показывать ложный ноль");
assert(presenceCode.includes("if (!Object.prototype.hasOwnProperty.call(currentPresenceState, presenceSessionId))"), "счётчик нельзя показывать до появления собственной Presence key");

const budgetRealtimeStart = app.indexOf("function subscribeRealtime()");
const budgetRealtimeEnd = app.indexOf("function unsubscribeRealtime()", budgetRealtimeStart);
const budgetRealtimeCode = app.slice(budgetRealtimeStart, budgetRealtimeEnd);
assert(budgetRealtimeCode.includes('.channel("class-budget-live")'), "существующий class-budget-live должен сохраниться");
assert(!budgetRealtimeCode.includes("presence"), "Presence нельзя смешивать с class-budget-live");
for (const table of ["contributions", "expenses", "campaigns", "students", "class_profile", "access_enrollment_settings", "access_requests", "chat_messages"]) {
  assert(budgetRealtimeCode.includes(`table: "${table}"`), `class-budget-live потерял подписку ${table}`);
}

assert(/<main class="content">\s*<div class="presence-status-row">\s*<p id="presenceStatus"/s.test(html), "индикатор должен находиться в начале main.content");
assert(html.indexOf('id="presenceStatus"') < html.indexOf('id="globalNotice"'), "Presence UI должен находиться перед globalNotice");
assert(html.includes('<span id="presenceStatusText">Онлайн: —</span>'), "начальный текст индикатора должен быть безопасным");
assert(css.includes(".presence-status-row"), "нет desktop-стилей индикатора");
assert(css.includes(".presence-status.is-online .presence-status-dot"), "нет состояния успешного sync");
assert(/@media screen and \(max-width: 768px\)[\s\S]*?\.presence-status-row/.test(css), "нет mobile-стилей индикатора");

const htmlAppVersion = html.match(/app\.js\?v=(\d+)/)?.[1];
const workerAppVersion = serviceWorker.match(/\.\/app\.js\?v=(\d+)/)?.[1];
const htmlStyleVersion = html.match(/styles\.css\?v=(\d+)/)?.[1];
const workerStyleVersion = serviceWorker.match(/\.\/styles\.css\?v=(\d+)/)?.[1];
assert.equal(htmlAppVersion, "84", "index.html должен подключать app.js?v=84");
assert.equal(workerAppVersion, htmlAppVersion, "app.js asset version должна совпадать в HTML и Service Worker");
assert.equal(htmlStyleVersion, "594", "index.html должен подключать styles.css?v=594");
assert.equal(workerStyleVersion, htmlStyleVersion, "styles.css asset version должна совпадать в HTML и Service Worker");
assert(serviceWorker.includes('const CACHE_NAME = "budget-2a-v86-artistic-chalkboard-9";'), "Service Worker cache name должен быть обновлён");

function createCleanupHarness({ removeStatus = "ok", removeError = null, untrackError = null } = {}) {
  const calls = [];
  const channel = {
    async untrack() {
      calls.push("untrack");
      if (untrackError) throw untrackError;
      return "ok";
    }
  };
  const dbMock = {
    async removeChannel(actualChannel) {
      calls.push("removeChannel");
      assert.equal(actualChannel, channel, "cleanup должен удалять только сохранённый channel reference");
      if (removeError) throw removeError;
      return removeStatus;
    }
  };
  const stateMock = {
    presenceRetryTimer: null,
    presenceGeneration: 1,
    presenceTrackRequested: true,
    presenceChannel: channel
  };
  let uiText = "Онлайн: 4";
  const cleanupFactory = new Function(
    "state",
    "window",
    "db",
    "setPresencePending",
    "console",
    `${cleanupCode}\nreturn cleanupPresenceNow;`
  );
  const cleanup = cleanupFactory(
    stateMock,
    { clearTimeout() {} },
    dbMock,
    () => { uiText = "Онлайн: —"; },
    { warn() {}, error() {} }
  );
  return { cleanup, stateMock, channel, calls, getUiText: () => uiText };
}

function createLogoutHarness({ signOutError = null, remainingSession = true, accessAllowed = true } = {}) {
  const user = { id: "approved-user" };
  const stateMock = { session: { user }, accessApproved: true };
  const calls = [];
  const dbMock = {
    auth: {
      async signOut() {
        calls.push("signOut");
        return { error: signOutError };
      },
      async getSession() {
        calls.push("getSession");
        return { data: { session: remainingSession ? { user } : null }, error: null };
      }
    },
    async rpc(name) {
      calls.push(name);
      return { data: accessAllowed, error: null };
    }
  };
  const logoutFactory = new Function(
    "db",
    "state",
    "dom",
    "loginWithGoogle",
    "setButtonLoading",
    "cleanupPresence",
    "showNotice",
    "withTimeout",
    "CORE_DATA_TIMEOUT_MS",
    "subscribePresence",
    "console",
    `${logoutCode}\nreturn logout;`
  );
  const logout = logoutFactory(
    dbMock,
    stateMock,
    {},
    () => {},
    () => {},
    async () => {
      calls.push("cleanup");
      assert.equal(stateMock.accessApproved, false, "access gate должен быть закрыт до cleanup");
    },
    () => {},
    async (operation) => operation(),
    1000,
    () => { calls.push("subscribePresence"); },
    { warn() {} }
  );
  return { logout, stateMock, calls };
}

async function testCleanupSemantics() {
  const successful = createCleanupHarness();
  assert.equal(await successful.cleanup(), true, "успешный removeChannel должен разрешать новый subscribe");
  assert.equal(successful.stateMock.presenceChannel, null, "после removeChannel=ok reference должен очищаться");
  assert.deepEqual(successful.calls, ["untrack", "removeChannel"], "успешный cleanup должен сохранить безопасный порядок");

  const timedOut = createCleanupHarness({ removeStatus: "timed out" });
  assert.equal(await timedOut.cleanup(), false, "неуспешный статус removeChannel должен запрещать subscribe");
  assert.equal(timedOut.stateMock.presenceChannel, timedOut.channel, "при неуспешном removeChannel reference должен сохраняться");
  assert.equal(timedOut.getUiText(), "Онлайн: —", "при неуспешном cleanup UI должен оставаться безопасным");

  const removeFailed = createCleanupHarness({ removeError: new Error("remove failed") });
  assert.equal(await removeFailed.cleanup(), false, "исключение removeChannel должно запрещать subscribe");
  assert.equal(removeFailed.stateMock.presenceChannel, removeFailed.channel, "исключение removeChannel не должно терять reference");

  const untrackFailed = createCleanupHarness({ untrackError: new Error("untrack failed") });
  assert.equal(await untrackFailed.cleanup(), true, "ошибка untrack не должна отменять успешный removeChannel");
  assert.deepEqual(untrackFailed.calls, ["untrack", "removeChannel"], "после ошибки untrack всё равно должен вызываться removeChannel");
  assert.equal(untrackFailed.stateMock.presenceChannel, null, "успешный remove после ошибки untrack должен очищать reference");
}

async function testLogoutSemantics() {
  const successful = createLogoutHarness();
  await successful.logout();
  assert.equal(successful.stateMock.accessApproved, false, "успешный signOut должен оставлять Presence выключенным");
  assert(!successful.calls.includes("getSession"), "успешный signOut не должен запускать восстановление Presence");
  assert(!successful.calls.includes("subscribePresence"), "успешный signOut не должен пересоздавать Presence");

  const deniedAfterError = createLogoutHarness({ signOutError: new Error("signOut failed"), accessAllowed: false });
  await deniedAfterError.logout();
  assert.equal(deniedAfterError.stateMock.accessApproved, false, "ошибка signOut не должна восстанавливать доступ без can_access_budget=true");
  assert.deepEqual(deniedAfterError.calls.slice(-2), ["getSession", "can_access_budget"], "ошибка signOut должна заново проверить session и доступ");
  assert(!deniedAfterError.calls.includes("subscribePresence"), "отказ повторной проверки не должен восстанавливать Presence");

  const approvedAfterError = createLogoutHarness({ signOutError: new Error("signOut failed") });
  await approvedAfterError.logout();
  assert.equal(approvedAfterError.stateMock.accessApproved, true, "Presence можно восстановить после новой успешной проверки доступа");
  assert.deepEqual(approvedAfterError.calls.slice(-3), ["getSession", "can_access_budget", "subscribePresence"], "восстановление должно идти после session + access check");

  const noRemainingSession = createLogoutHarness({ signOutError: new Error("signOut failed"), remainingSession: false });
  await noRemainingSession.logout();
  assert.equal(noRemainingSession.stateMock.accessApproved, false, "без фактической session Presence должен остаться выключенным");
  assert(!noRemainingSession.calls.includes("can_access_budget"), "без session нельзя выполнять восстановительную проверку доступа");
}

Promise.all([testCleanupSemantics(), testLogoutSemantics()])
  .then(() => console.log("Presence frontend checks: PASS"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
