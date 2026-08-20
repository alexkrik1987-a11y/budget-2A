#!/usr/bin/env node
import fs from "node:fs";

const app = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
const index = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

expect(app.includes("function scheduleRealtimeRetry(generation)"), "Нет общего переподключения realtime");
expect(app.includes("function startRealtimeFallback(generation)"), "Нет резервной проверки бюджета");
expect(app.includes("60 * 1000"), "Резервная проверка не настроена на минутный интервал");
expect(app.includes('document.visibilityState === "hidden"'), "Резервная проверка не учитывает скрытую вкладку");
expect(app.includes('window.addEventListener("online", handleRealtimeNetworkResume)'), "Нет восстановления после возвращения сети");
expect(app.includes('document.addEventListener("visibilitychange", handleRealtimeVisibilityChange)'), "Нет обновления при возвращении на вкладку");
expect(app.includes('if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status))'), "Ошибки общего realtime-канала не запускают retry");
expect(app.includes("window.clearInterval(state.realtimeFallbackTimer)"), "Таймер резервной проверки не очищается");
expect(app.includes("await loadAllData({ silent: true })"), "Автоматическое обновление не загружает свежий snapshot");
expect(index.includes('data-living-action="contribution"'), "Основная разметка не содержит действующие быстрые действия");
console.log("realtime budget refresh checks: PASS");
