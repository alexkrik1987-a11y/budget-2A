"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const expectedCleanInstallOrder = [
  "supabase.sql",
  "class-chat.sql",
  "chat-pinning.sql",
  "chat-archive.sql",
  "parent-access-requests.sql",
  "archive-features.sql",
  "class-receipts-storage.sql",
  "useful-info.sql"
];

const retiredLegacyFiles = ["setup.sql", "oauth-protect.sql"];
for (const retiredFile of retiredLegacyFiles) {
  assert(!fs.existsSync(retiredFile), `${retiredFile} не должен находиться в актуальном дереве`);
}

const readme = fs.readFileSync("README.md", "utf8");
assert(!/setup\.sql/i.test(readme), "README не должен предлагать legacy setup.sql");
assert(!/oauth-protect\.sql/i.test(readme), "README не должен предлагать legacy oauth-protect.sql");

const installSectionStart = readme.indexOf("SQL Editor → New query");
const installSectionEnd = readme.indexOf("Для существующей базы", installSectionStart);
assert(installSectionStart >= 0 && installSectionEnd > installSectionStart, "в README не найден актуальный clean-install раздел");
const installSection = readme.slice(installSectionStart, installSectionEnd);
const actualCleanInstallOrder = [...installSection.matchAll(/^\d+\.\s+`([^`]+)`/gm)].map((match) => match[1]);
assert.deepEqual(actualCleanInstallOrder, expectedCleanInstallOrder, "clean-install порядок должен оставаться каноническим");

assert(fs.existsSync("class-presence.sql"), "отдельный class-presence.sql должен сохраняться");
assert(!actualCleanInstallOrder.includes("class-presence.sql"), "Presence SQL должен оставаться отдельным от основного clean-install порядка");
for (const retiredFile of retiredLegacyFiles) {
  assert(!actualCleanInstallOrder.includes(retiredFile), `${retiredFile} не должен входить в clean-install порядок`);
}

for (const entry of fs.readdirSync(".", { withFileTypes: true })) {
  if (!entry.isFile() || entry.name === path.basename(__filename)) continue;
  if (!/\.(?:md|js|sql)$/i.test(entry.name)) continue;
  const contents = fs.readFileSync(entry.name, "utf8");
  assert(!/setup\.sql/i.test(contents), `${entry.name} не должен содержать активную ссылку на удалённый setup.sql`);
  assert(!/oauth-protect\.sql/i.test(contents), `${entry.name} не должен содержать активную ссылку на удалённый oauth-protect.sql`);
}

console.log("legacy setup retirement checks: PASS");
