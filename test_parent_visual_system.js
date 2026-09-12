"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const html = fs.readFileSync("index.html", "utf8");
const css = fs.readFileSync("styles.css", "utf8");
const app = fs.readFileSync("app.js", "utf8");
const visual = css.slice(css.indexOf("PARENT JOURNAL — PROFESSIONAL VISUAL SYSTEM"));
assert(visual.length > 0, "visual system must exist");

function luminance(hex) {
  return hex.match(/[a-f\d]{2}/gi).map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  }).reduce((sum, channel, i) => sum + channel * [.2126, .7152, .0722][i], 0);
}
for (const theme of ["light", "dark"]) {
  const block = visual.match(new RegExp(`html\\[data-theme="${theme}"\\] \\{([^}]+)`))[1];
  const tokens = Object.fromEntries([...block.matchAll(/--ui-([\w-]+):\s*(#[a-f\d]{6})/gi)].map(m => [m[1], m[2]]));
  for (const [foreground, background] of [
    ["text", "canvas"], ["text", "surface"], ["text", "subtle"],
    ["muted", "canvas"], ["muted", "surface"], ["muted", "subtle"],
    ["primary", "subtle"], ["on-primary", "primary"],
    ["accent", "accent-surface"], ["danger", "danger-surface"]
  ]) {
    const a = luminance(tokens[foreground]), b = luminance(tokens[background]);
    assert((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `${theme}: ${foreground}/${background} normal-text contrast`);
  }
}

const symbols = [...html.matchAll(/<symbol id="(ui-[^"]+)" viewBox="0 0 24 24"/g)].map(m => m[1]);
assert.equal(new Set(symbols).size, symbols.length, "unique sprite IDs");
for (const [, reference] of html.matchAll(/<use href="#(ui-[^"]+)"/g)) assert(symbols.includes(reference), reference);
assert.match(visual, /stroke-width: 1\.75/);
assert(!html.includes("fonts.googleapis.com"), "system typography requires no external font");
assert.match(visual, /:focus-visible\s*\{[^}]*outline: 3px/);
assert.match(visual, /prefers-reduced-motion: reduce/);
assert.match(visual, /#protectedContent \.hidden\.hidden,[\s\S]*?display: none !important/,
  "role/loading hidden state must outrank presentation flex/grid selectors");
assert.match(visual, /#authGate\.hidden\s*\{ display: none !important/);
assert.match(visual, /env\(safe-area-inset-bottom\)/);
assert.match(visual, /var\(--parent-nav-height,80px\)/);
assert.match(visual, /\.modal-card :is\(\.field,\.checkbox-field\) > span \{ color: var\(--ui-muted\) !important; background: transparent !important/,
  "dialog labels must not retain old yellow backgrounds in dark mode");
assert.match(visual, /\.modal-card \.modal-actions \{ position: static/,
  "dialog actions must not overlay scrollable form fields");
assert.match(visual, /\.modal-header > div \{ min-width: 0; overflow-wrap: anywhere/,
  "long enlarged dialog titles must not force horizontal scrolling");
assert.match(visual, /\.modal-card \.checkbox-field > span \{ min-width: 0; overflow-wrap: anywhere/,
  "enlarged checkbox descriptions must fit the dialog");
assert.match(visual, /\.install-steps > ol \{ min-width: 0; max-width: 100%; overflow-wrap: anywhere/);
assert.match(visual, /\.install-steps \{ grid-template-columns: minmax\(0,1fr\)/,
  "mobile install instructions must shrink with 200% text");
const nav = html.match(/<nav class="main-nav"[\s\S]*?<\/nav>/)[0];
assert.equal((nav.match(/class="nav-button/g) || []).length, 4);
for (const view of ["summary", "schedule", "contributions", "directory"]) {
  assert(nav.includes(`data-view="${view}"`));
}
assert.match(html, /id="settingsNavButton" class="destination-link admin-only hidden"/);
assert.match(html, /id="chatToggleButton" aria-label="Чат класса"/);

// Execute the actual presentation helper: no text-only emoji fallback, no
// lost accessible state, and toggling never accumulates duplicate SVGs.
function source(name) {
  const start = app.indexOf(`function ${name}(`);
  assert(start >= 0, name);
  return app.slice(start, app.indexOf("\n}", start) + 2);
}
function element(tag) {
  return { tag, attributes: {}, children: [], setAttribute(k, v) { this.attributes[k] = v; },
    append(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; } };
}
const button = element("button");
let theme = "light", saved;
const context = {
  dom: { themeToggleButton: button },
  document: {
    documentElement: { getAttribute: () => theme, setAttribute: (_, value) => { theme = value; } },
    createElementNS(namespace, tag) { assert.equal(namespace, "http://www.w3.org/2000/svg"); return element(tag); }
  },
  localStorage: { setItem(key, value) { assert.equal(key, "budget2a-theme"); saved = value; } }
};
vm.createContext(context);
vm.runInContext(["currentTheme", "syncThemeToggle", "toggleTheme"].map(source).join("\n"), context);
for (const expected of ["light", "dark", "light"]) {
  if (expected !== theme) context.toggleTheme();
  context.syncThemeToggle();
  assert.equal(button.children.length, 1);
  const svg = button.children[0];
  assert.equal(svg.tag, "svg");
  assert.equal(svg.attributes["aria-hidden"], "true");
  assert.equal(svg.attributes.focusable, "false");
  assert.equal(svg.children[0].attributes.href, expected === "dark" ? "#ui-sun" : "#ui-moon");
  assert.equal(button.attributes["aria-pressed"], String(expected === "dark"));
  assert.equal(button.attributes["aria-label"], expected === "dark" ? "Включить светлую тему" : "Включить тёмную тему");
}
assert.equal(saved, "light");

// The new cover must keep contrast in BOTH themes, including the SVG toggle.
const edition = css.slice(css.indexOf("CLASS EDITION — paper, ink, ruled margins."));
assert(edition.includes("--edition-cover:"), "class edition must exist");
const editionTokens = Object.fromEntries([...edition.matchAll(/--edition-([\w-]+):\s*(#[a-f\d]{6})/gi)].map(m => [m[1], m[2]]));
for (const foreground of ["cover-ink", "cover-muted"]) {
  const a = luminance(editionTokens[foreground]), b = luminance(editionTokens.cover);
  assert((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `cover ${foreground} contrast`);
}
assert.match(edition, /\.site-header #themeToggleButton \.app-icon \{ color: var\(--edition-cover-ink\) !important/);
assert.match(edition, /#view-summary\.active \{ display: grid !important/,
  "desktop composition must override the legacy active view block, without making hidden views visible");
assert.match(edition, /\.useful-day-card \.useful-lesson-list li \{[^}]+border-bottom: 1px solid var\(--edition-rule\)/,
  "ruled subjects must outrank the previous day-card list rule");
assert.match(edition, /\.directory-group \.destination-link \{[^}]+border-radius: 0 !important/);
assert.match(edition, /\.modal-card \{ border-radius: 6px !important/);
assert.match(html, /class="class-cover-label">Наш дружный класс<\/span> <span data-class-name>/);
assert(!/\border\s*:|row-reverse|column-reverse/.test(edition.slice(edition.indexOf("/* Today's leaf"))),
  "content reading and keyboard order must not be visually reversed");
console.log("Parent visual system: PASS (theme/cover contrast, class edition, ruled rows, visibility guards, accessible toggle, four destinations)");
