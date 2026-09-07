"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const app = fs.readFileSync("app.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");
const sw = fs.readFileSync("sw.js", "utf8");

function sourceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, `Не найден исходный блок ${start}`);
  return source.slice(from, to);
}

// Exact public key and browser conversion contract.
const vapid = app.match(/const VAPID_PUBLIC_KEY = "([A-Za-z0-9_-]+)";/)?.[1];
assert(vapid, "frontend должен содержать production VAPID public key");
const rawVapid = Buffer.from(vapid, "base64url");
assert.equal(rawVapid.length, 65, "VAPID public key должен декодироваться в 65 байт");
assert.equal(rawVapid[0], 0x04, "VAPID public key должен быть несжатой P-256 точкой");
const conversionSnippet = sourceBetween(app, "function urlBase64ToUint8Array", "function arrayBufferToBase64Url");
const conversionContext = {
  window: { atob: (value) => Buffer.from(value, "base64").toString("binary") },
  Uint8Array
};
vm.runInNewContext(`${conversionSnippet}\nthis.convert = urlBase64ToUint8Array;`, conversionContext);
assert.deepEqual(Buffer.from(conversionContext.convert(vapid)), rawVapid, "base64url conversion должна сохранять public key");

// Browser subscription lifecycle: explicit permission, active SW, endpoint-idempotent upsert and owner-scoped disable.
const enableSource = sourceBetween(app, "async function enablePushNotifications", "async function disablePushNotifications");
assert(enableSource.includes('window.Notification.requestPermission()'), "permission должна запрашиваться только после явного включения");
assert(enableSource.includes("await activeServiceWorkerRegistration()"), "подписка должна ждать active Service Worker");
assert(enableSource.includes("registration.pushManager.subscribe({"), "должен вызываться PushManager.subscribe");
assert(enableSource.includes("userVisibleOnly: true"), "push subscription должна быть userVisibleOnly");
assert(enableSource.includes("applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)"), "должен использоваться exact VAPID public key");
assert(enableSource.includes('db.from("push_subscriptions").upsert({'), "подписка должна сохраняться через upsert");
assert(enableSource.includes('{ onConflict: "endpoint", defaultToNull: false }'), "endpoint должен быть idempotency key без обнуления schema defaults");
assert(enableSource.includes("user_id: state.user.id"), "subscription должна принадлежать текущему user");
assert(enableSource.includes('if (permission !== "granted")'), "denied permission должна завершаться fail-closed");
assert(app.includes('if (!state.pushSupported)'), "unsupported browser должен обрабатываться явно");

const disableSource = sourceBetween(app, "async function disablePushNotifications", "async function saveNotificationPreferences");
assert(disableSource.includes('.update({ enabled: false })'), "выключение должно деактивировать DB subscription");
assert(disableSource.includes('.eq("user_id", state.user.id)'), "нельзя выключать чужую subscription");
assert(disableSource.includes('.eq("endpoint", subscription.endpoint)'), "выключение должно быть ограничено текущим endpoint");
assert(disableSource.includes("await subscription.unsubscribe()"), "browser subscription должна удаляться локально");

// Preferences expose only implemented categories and preserve Phase 1 defaults.
assert(html.includes('id="notificationScheduleEnabled" type="checkbox" checked'), "schedule preference default должна быть true");
assert(html.includes('id="notificationMemosEnabled" type="checkbox" checked'), "memo preference default должна быть true");
assert(html.includes('id="notificationAnnouncementsEnabled" type="checkbox" checked'), "announcement preference default должна быть true");
const preferencesLoad = sourceBetween(app, "async function loadNotificationSettings", "async function enablePushNotifications");
assert(preferencesLoad.includes('db.from("notification_preferences")'), "preferences должны загружаться из Phase 1 table");
assert(preferencesLoad.includes('.select("schedule_enabled, memos_enabled, announcements_enabled")'), "должны читаться только реализованные preference fields");
assert(preferencesLoad.includes('.eq("user_id", state.user.id)'), "preferences load должен быть owner-scoped");
assert(preferencesLoad.includes(".maybeSingle()"), "отсутствующая preference row должна сохранять defaults");
const preferencesSource = sourceBetween(app, "async function saveNotificationPreferences", "async function requestClassNotification");
assert(preferencesSource.includes('db.from("notification_preferences").upsert({'), "preferences должны сохраняться через upsert");
assert(preferencesSource.includes('{ onConflict: "user_id", defaultToNull: false }'), "preferences должны быть idempotent per user без обнуления financial defaults");
for (const field of ["schedule_enabled", "memos_enabled", "announcements_enabled"]) {
  assert(preferencesSource.includes(field), `должно сохраняться поле ${field}`);
}
assert(!html.includes("notificationContributionsEnabled") && !html.includes("notificationExpensesEnabled"), "financial preferences пока не должны показываться");

// Admin notification is opt-in and sends only the exact trusted Edge request after the primary write.
for (const id of ["notifyScheduleParents", "notifyMemoParents", "chatNotifyParentsInput"]) {
  const input = html.match(new RegExp(`<input id="${id}"[^>]*>`))?.[0] || "";
  assert(input && !/\schecked(?:\s|>)/.test(input), `${id} должен быть OFF по умолчанию`);
}
const notifySource = sourceBetween(app, "async function requestClassNotification", "async function saveUsefulInfo");
assert(notifySource.includes('db.functions.invoke("send-class-notification"'), "admin должен вызывать только send-class-notification");
assert(notifySource.includes("body: { eventType, sourceId, notify: true }"), "Edge payload должен быть exact eventType/sourceId/notify");
const usefulSave = sourceBetween(app, "async function saveUsefulInfo", "function renderChat");
assert(usefulSave.includes('if (notifySchedule) notificationResults.push'), "unchecked schedule notify не должен enqueue событие");
assert(usefulSave.includes('if (notifyMemo) notificationResults.push'), "unchecked memo notify не должен enqueue событие");
assert(usefulSave.indexOf('db.from("class_profile").update') < usefulSave.indexOf('requestClassNotification("schedule"'), "основное сохранение должно завершаться до schedule enqueue");
assert(usefulSave.indexOf('db.from("class_profile").update') < usefulSave.indexOf('requestClassNotification("memo"'), "основное сохранение должно завершаться до memo enqueue");
assert(usefulSave.includes("notificationResults.length ? 9000 : 4000"), "результат enqueue должен показываться отдельно от успешного save");
assert(app.includes('requestClassNotification("announcement", message.id)'), "закреплённое объявление должно использовать trusted message UUID");
assert(app.includes('action === "pin" && dom.chatNotifyParentsInput?.checked === true'), "announcement enqueue должен требовать явный checkbox ON");
assert(!app.includes('functions.invoke("dispatch-class-notifications"'), "browser не должен вызывать worker");
for (const forbidden of ["SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY", "VAPID_PRIVATE_KEY", "sb_secret_"]) {
  assert(!`${app}\n${html}\n${sw}`.includes(forbidden), `${forbidden} не должен попадать во frontend`);
}

// Execute the real Service Worker handlers with local mocks: no network and no production calls.
const listeners = new Map();
const shown = [];
const opened = [];
let clients = [];
const self = {
  location: { href: "https://rodcomitet.budget2a.kriknexus.pro/sw.js?v=87", origin: "https://rodcomitet.budget2a.kriknexus.pro" },
  registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
  clients: {
    claim: async () => {},
    matchAll: async () => clients,
    openWindow: async (url) => { opened.push(url); return { url }; }
  },
  addEventListener: (type, handler) => listeners.set(type, handler),
  skipWaiting: () => {}
};
const caches = {
  open: async () => ({ addAll: async () => {}, keys: async () => [], delete: async () => false, match: async () => null, put: async () => {} }),
  keys: async () => []
};
vm.runInNewContext(sw, { self, caches, fetch: async () => { throw new Error("network disabled"); }, URL, Response, Set, console });
assert(listeners.has("push"), "Service Worker должен регистрировать push handler");
assert(listeners.has("notificationclick"), "Service Worker должен регистрировать notificationclick handler");

async function dispatch(type, event) {
  let pending;
  event.waitUntil = (promise) => { pending = Promise.resolve(promise); };
  listeners.get(type)(event);
  await pending;
}

(async () => {
  const validPayload = {
    type: "announcement",
    title: "Объявление класса",
    body: "Завтра собрание",
    url: "/",
    eventId: "7d9a4f62-1c8f-4bb6-8a2d-7efb4c76f06d"
  };
  await dispatch("push", { data: { json: () => validPayload } });
  assert.equal(shown.length, 1, "valid push должен показать одно notification");
  assert.equal(shown[0].options.tag, `class-notification:${validPayload.eventId}`, "eventId должен задавать deduplication tag");
  assert.deepEqual(JSON.parse(JSON.stringify(shown[0].options.data)), { type: "announcement", eventId: validPayload.eventId, url: "/" });

  await dispatch("push", { data: { json: () => { throw new Error("malformed"); } } });
  await dispatch("push", { data: { json: () => ({ ...validPayload, url: "https://evil.example/" }) } });
  await dispatch("push", { data: { json: () => ({ ...validPayload, title: "x".repeat(161) }) } });
  assert.equal(shown.length, 1, "malformed/external/oversized push payload должен игнорироваться");

  let closed = false;
  let focused = false;
  clients = [{ url: "https://rodcomitet.budget2a.kriknexus.pro/", focus: async () => { focused = true; } }];
  await dispatch("notificationclick", { notification: { data: { url: "/" }, close: () => { closed = true; } } });
  assert.equal(closed, true, "notification click должен закрывать notification");
  assert.equal(focused, true, "существующий same-origin matching client должен получать focus");
  assert.equal(opened.length, 0, "matching client не должен открывать новое окно");

  clients = [];
  await dispatch("notificationclick", { notification: { data: { url: "https://evil.example/path" }, close: () => {} } });
  assert.deepEqual(opened, ["/"], "external/invalid destination должна открывать только root");
  console.log("Push frontend/PWA tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
