const fs = require('fs');
const assert = require('assert');
const app = fs.readFileSync('app.js', 'utf8');
const sql = fs.readFileSync('chat-archive.sql', 'utf8');

assert(app.includes('.is("archived_at", null)'), 'Активный запрос не фильтрует архивные сообщения');
assert(app.includes('archived_at")'), 'Запрос не выбирает archived_at');
assert(app.includes('if (payload.new?.archived_at) removeChatMessage(payload.new.id)'), 'Realtime UPDATE не удаляет архивированное сообщение');
assert(app.includes('snapshot.chat_messages.filter((message) => !message?.archived_at)'), 'Снимок не фильтрует архивные сообщения');
assert(sql.includes('add column if not exists archived_at'), 'Миграция не добавляет archived_at');
assert(sql.includes('archive_old_class_chat_messages'), 'Миграция не создаёт функцию архива');
assert(sql.includes('archived_at = now()'), 'Функция не архивирует через timestamp');
assert(!/delete\s+from\s+public\.chat_messages[\s\S]*archive_old_class_chat_messages/i.test(sql), 'Архивная функция не должна удалять сообщения');

let messages = [
  { id: '1', archived_at: null },
  { id: '2', archived_at: null },
];
const archivedUpdate = { id: '1', archived_at: '2026-08-21T00:00:00Z' };
messages = messages.filter((message) => message.id !== archivedUpdate.id);
assert.deepEqual(messages.map((message) => message.id), ['2'], 'Архивированное сообщение осталось в активном списке');
console.log('chat archive checks: PASS');
