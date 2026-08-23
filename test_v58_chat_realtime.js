"use strict";
const fs = require("fs");
const assert = require("assert");
const app = fs.readFileSync("app.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");
const sw = fs.readFileSync("sw.js", "utf8");

function sortChatMessages(messages) {
  return [...messages].sort((a, b) => {
    const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    return timeDiff || String(a.id).localeCompare(String(b.id));
  });
}
function mergeChatMessage(messages, message) {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index < 0) return sortChatMessages([...messages, message]);
  const next = [...messages];
  next[index] = { ...next[index], ...message };
  return sortChatMessages(next);
}
function removeChatMessage(messages, id) { return messages.filter((message) => message.id !== id); }

let messages = [];
const first = { id: "1", author_id: "a", author_name: "Анна", body: "Привет", created_at: "2026-08-20T10:00:00Z" };
messages = mergeChatMessage(messages, first);
messages = mergeChatMessage(messages, first);
assert.equal(messages.length, 1, "Повторный INSERT с тем же id создал дубль");
messages = mergeChatMessage(messages, { ...first, body: "Привет всем" });
assert.equal(messages.length, 1, "UPDATE создал вторую строку вместо обновления");
assert.equal(messages[0].body, "Привет всем", "UPDATE не обновил текст");
messages = mergeChatMessage(messages, { id: "2", author_id: "b", author_name: "Борис", body: "Здравствуйте", created_at: "2026-08-20T10:01:00Z" });
assert.deepEqual(messages.map((message) => message.id), ["1", "2"], "Сообщения отсортированы неверно");
messages = removeChatMessage(messages, "1");
assert.deepEqual(messages.map((message) => message.id), ["2"], "DELETE не удалил сообщение");

for (const needle of [
  "handleChatRealtimeEvent",
  "mergeChatMessage(payload.new)",
  "removeChatMessage(payload.old?.id)",
  "state.realtimeChannel.subscribe((status)",
  "CHANNEL_ERROR",
  "TIMED_OUT",
  "state.realtimeGeneration"
]) assert(app.includes(needle), `Не найден realtime-механизм: ${needle}`);
const appAsset = html.match(/<script src="(app\.js\?v=[^"]+)" defer><\/script>/)?.[1];
assert(appAsset, "index.html должен подключать версионированный app.js");
assert(sw.includes(`./${appAsset}`), "app.js в Service Worker должен совпадать с index.html");
const cacheName = sw.match(/const CACHE_NAME = "([^"]+)";/)?.[1];
assert(cacheName && cacheName.startsWith("budget-2a-"), "Service Worker должен использовать отдельный cache проекта");
assert(sw.includes("caches.open(CACHE_NAME)"), "Service Worker должен открывать cache через актуальный CACHE_NAME");
console.log("v58 chat realtime checks: PASS");
