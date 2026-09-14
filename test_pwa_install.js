"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const app = fs.readFileSync("app.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("styles.css", "utf8");

assert.equal((html.match(/id="installAppButton"/g) || []).length, 1);
assert.match(html, /id="installAppButton" class="button install-button hidden"[^>]*>[\s\S]*?Установить приложение\s*<\/button>/);
assert.match(app, /async function init\(\)[\s\S]*?setupInstallExperience\(\);/);
assert.match(app, /dom\.installAppButton\.addEventListener\("click", installApp\)/);
assert.match(css, /#installAppButton:not\(\.hidden\)\s*\{[^}]*display: inline-flex !important/);
assert.match(css, /#installAppButton:not\(\.hidden\)\s*\{[^}]*min-height: 44px !important/);
assert.match(css, /#protectedContent \.hidden\.hidden,[\s\S]*?display: none !important/);

function source(name) {
  const start = app.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert(start >= 0, name);
  return app.slice(start, app.indexOf("\n}", start) + 2);
}
function harness({ standalone = false, iosStandalone = false, ios = false } = {}) {
  const classes = new Set(["hidden"]), listeners = new Map();
  let dialogs = 0, notices = 0;
  const button = { classList: { add: v => classes.add(v), remove: v => classes.delete(v) } };
  const navigator = { standalone: iosStandalone, userAgent: ios ? "iPhone" : "Chromium" };
  const c = {
    dom: { installAppButton: button, installInstructions: { innerHTML: "" }, installHelpModal: { showModal() { dialogs++; } } },
    state: { installPrompt: null }, navigator,
    window: { navigator, matchMedia(query) { assert.equal(query, "(display-mode: standalone)"); return { matches: standalone }; }, addEventListener: (type, fn) => listeners.set(type, fn) },
    showNotice() { notices++; }
  };
  vm.createContext(c);
  vm.runInContext(["setupInstallExperience", "installApp", "isStandalone"].map(source).join("\n"), c);
  c.setupInstallExperience();
  return { c, listeners, hidden: () => classes.has("hidden"), dialogs: () => dialogs, notices: () => notices };
}

(async () => {
  for (const flags of [{ standalone: true }, { iosStandalone: true }]) {
    const h = harness(flags);
    assert(h.hidden(), "standalone must retain hidden state");
    assert.equal(h.listeners.size, 0);
  }
  for (const outcome of ["accepted", "dismissed"]) {
    const h = harness();
    let prevented = 0, prompts = 0;
    const event = { preventDefault() { prevented++; }, prompt() { prompts++; }, userChoice: Promise.resolve({ outcome }) };
    h.listeners.get("beforeinstallprompt")(event);
    assert(!h.hidden(), "available install prompt must expose the control");
    assert.equal(h.c.state.installPrompt, event);
    assert.equal(prevented, 1);
    await h.c.installApp();
    assert.equal(prompts, 1);
    assert.equal(h.c.state.installPrompt, null);
    assert.equal(h.hidden(), outcome === "accepted");
    assert.equal(h.dialogs(), 0, "native prompt must not open fallback instructions");
    h.listeners.get("appinstalled")();
    assert(h.hidden(), "installed event must hide install control");
    assert.equal(h.c.state.installPrompt, null);
    assert.equal(h.notices(), 1);
  }
  for (const ios of [true, false]) {
    const h = harness({ ios });
    assert(!h.hidden(), "regular browser must expose install help before any beforeinstallprompt event");
    assert.equal(h.c.state.installPrompt, null, "fallback must work with no deferred native prompt");
    await h.c.installApp();
    assert.equal(h.dialogs(), 1);
    assert(!h.hidden(), "opening instructions must not remove the install entry point");
    assert.equal(h.notices(), 0, "missing native prompt must not produce an error notice");
    assert(h.c.dom.installInstructions.innerHTML.includes(ios ? "На экран Домой" : "меню браузера"));
    h.listeners.get("appinstalled")();
    assert(h.hidden(), "installation via browser menu must hide the button even without beforeinstallprompt");
  }
  // A delayed browser event upgrades the same entry point from help to native install.
  const delayed = harness();
  await delayed.c.installApp();
  let calls = 0;
  delayed.listeners.get("beforeinstallprompt")({ preventDefault() {}, prompt() { calls++; }, userChoice: Promise.resolve({ outcome: "dismissed" }) });
  await delayed.c.installApp();
  assert.equal(calls, 1);
  assert.equal(delayed.dialogs(), 1, "native path must not also open instructions");
  assert(!delayed.hidden());
  await delayed.c.installApp();
  assert.equal(calls, 1, "consumed prompt must never be called again");
  assert.equal(delayed.dialogs(), 2, "after a consumed prompt, instructions remain available");
  console.log("PWA install: PASS (native, no-prompt help, delayed/consumed prompt, appinstalled without prompt, standalone, iOS fallback)");
})().catch(error => { console.error(error); process.exitCode = 1; });
