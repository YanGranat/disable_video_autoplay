const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { runScripts, uiScripts } = require("./load_scripts.cjs");

const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const lockManagers = new WeakMap();
const storageListeners = new WeakMap();

function fullCollection(key) {
  const entries = [];
  for (let i = 0; ; i++) {
    const next = key === "allowlist" ? `/@${"a".repeat(25)}${String(i).padStart(4, "0")}`
      : `site${i}.${"a".repeat(50)}.example`;
    if (key.length + new TextEncoder().encode(JSON.stringify([...entries, next])).length > 8192) return { entries, next };
    entries.push(next);
  }
}

for (const [surface, key, inputId, addId, statusId] of [
  ["popup", "allowlist", "newItem", "addBtn", "channelInputError"],
  ["popup", "siteLibrary", "siteInput", "siteAddBtn", "siteLibraryStatus"],
  ["options", "siteLibrary", "siteInput", "siteAddBtn", "siteLibraryStatus"],
]) {
  test(`${surface} ${key} rejects an oversized list beside the retained input`, async () => {
    const { entries, next } = fullCollection(key);
    const ui = await createHarness(surface, { [key]: entries });
    const input = ui.elements.get(inputId);
    input.value = next;
    await ui.click(addId);
    assert.equal(ui.writes.length, 0);
    assert.equal(input.value, next);
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.match(ui.elements.get(statusId).textContent, /storage limit/);
  });
}

for (const [surface, key, listId, inputId] of [
  ["popup", "allowlist", "list", "newItem"],
  ["options", "siteLibrary", "siteLibraryList", "siteInput"],
  ["options", "siteExclusions", "siteLibraryList", "siteInput"],
]) {
  test(`${surface} ${key} preserves keyboard focus across repaint and removal`, async () => {
    const values = key === "allowlist" ? ["/@alpha", "/@beta"] : ["alpha.example", "beta.example"];
    const ui = await createHarness(surface, { [key]: values });
    const list = ui.elements.get(listId);
    list.children[0].lastElementChild.focus();
    ui.externalChange("debug", true);
    await flushMicrotasks();
    assert.equal(ui.document.activeElement, list.children[0].lastElementChild);
    for (let remaining = 1; remaining >= 0; remaining--) {
      const button = list.children[0].lastElementChild;
      await button.listeners.get("click")[0]({ currentTarget: button, target: button });
      assert.equal(ui.document.activeElement, remaining ? list.children[0].lastElementChild : ui.elements.get(inputId));
    }
    ui.elements.get(inputId).focus();
    ui.externalChange(key, values);
    await flushMicrotasks();
    assert.equal(ui.document.activeElement, ui.elements.get(inputId), "external updates must not steal input focus");
  });
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.value = "";
    this.checked = false;
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    const classes = new Set();
    this.classList = {
      contains: (name) => classes.has(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    };
  }

  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html || ""; }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  querySelectorAll() { return []; }
  querySelector(selector) {
    const action = selector.match(/^\[data-action="([^"]+)"\]$/)?.[1];
    for (const child of this.children) {
      if (action && child.getAttribute("data-action") === action) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  appendChild(child) { this.children.push(child); }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  get lastElementChild() { return this.children.at(-1); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() { this.scrolledIntoView = true; }
}

async function createHarness(basename, stored = {}, browserLanguage = "en") {
  if (!storageListeners.has(stored)) storageListeners.set(stored, new Set());
  if (!lockManagers.has(stored)) {
    const queues = new Map();
    lockManagers.set(stored, { request(name, action) {
      const result = (queues.get(name) || Promise.resolve()).catch(() => {}).then(action);
      queues.set(name, result);
      return result;
    } });
  }
  const elements = new Map();
  for (const match of read(`${basename}.html`).matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new FakeElement(match[1]);
    element.hidden = /\bhidden(?:\s|>)/.test(match[0]);
    element.disabled = /\bdisabled(?:\s|\/?>)/.test(match[0]);
    for (const attribute of match[0].matchAll(/\b([a-z][a-z0-9-]*)="([^"]*)"/g)) element.setAttribute(attribute[1], attribute[2]);
    elements.set(match[1], element);
  }
  const writes = [];
  const consoleEntries = [];
  const pendingReads = [];
  const pendingTabQueries = [];
  const pendingWrites = [];
  const channelRequests = [];
  let deferReads = false;
  let deferTabQueries = false;
  let failWrites = false;
  let deferWrites = false;
  let deferChannels = false;
  let tabUrl = "https://example.com/";
  const pendingChannels = [];
  const navigation = [];
  const optionViews = [];
  const location = { hash: "" };
  const document = {
    documentElement: new FakeElement("html"),
    getElementById: (id) => elements.get(id),
    querySelectorAll(selector) {
      const attribute = selector.match(/^\[([a-z0-9-]+)\]$/)?.[1];
      const all = new Set();
      const visit = element => { all.add(element); element.children.forEach(visit); };
      elements.forEach(visit);
      if (attribute) return [...all].filter(element => element.getAttribute(attribute) !== null);
      if (selector.startsWith(".")) return [...all].filter(element => (element.className || "").split(" ").includes(selector.slice(1)));
      return [];
    },
    querySelector() { return null; },
    createElement: () => Object.assign(new FakeElement(), { ownerDocument: document }),
    addEventListener() {},
  };
  document.documentElement.classList.add("settings-loading");
  for (const element of elements.values()) element.ownerDocument = document;
  const chrome = {
    i18n: { getUILanguage: () => browserLanguage },
    storage: {
      onChanged: {
        addListener: (fn) => storageListeners.get(stored).add(fn),
        removeListener: (fn) => storageListeners.get(stored).delete(fn),
      },
      sync: {
        get(defaults) {
          const snapshot = { ...defaults, ...stored };
          if (!deferReads) return Promise.resolve(snapshot);
          return new Promise((resolve) => pendingReads.push(() => resolve(snapshot)));
        },
        async set(patch) {
          if (failWrites) throw new Error("QUOTA_BYTES_PER_ITEM quota exceeded");
          const copy = JSON.parse(JSON.stringify(patch));
          const changes = Object.fromEntries(Object.entries(copy).filter(([key, value]) => JSON.stringify(stored[key]) !== JSON.stringify(value)).map(([key, value]) => [key, { oldValue: stored[key], newValue: value }]));
          writes.push(copy);
          Object.assign(stored, copy);
          for (const listener of storageListeners.get(stored)) listener(changes, "sync");
          if (deferWrites) await new Promise(resolve => pendingWrites.push(resolve));
        },
        async remove(key) { delete stored[key]; },
      },
    },
    tabs: { create: async ({ url }) => navigation.push(url), query: () => {
      const tabs = [{ id: 1, url: tabUrl }];
      if (!deferTabQueries) return Promise.resolve(tabs);
      return new Promise((resolve) => pendingTabQueries.push(() => resolve(tabs)));
    } },
    runtime: { openOptionsPage: async () => navigation.push("options"), getManifest: () => ({ version: "test" }), getURL: (name) => `chrome-extension://fixture/${name}` },
    extension: { getViews: () => optionViews },
  };
  const context = vm.createContext({
    document, chrome, URL, AbortSignal, TextEncoder, location, window: { addEventListener() {} }, navigator: { locks: lockManagers.get(stored) }, HTMLElement: FakeElement, Node: FakeElement,
    requestAnimationFrame: callback => callback(),
    fetch: async (url) => {
      channelRequests.push(url);
      if (!deferChannels) return { ok: false };
      return new Promise(resolve => pendingChannels.push(resolve));
    },
    setTimeout, clearTimeout,
    console: Object.fromEntries(["log", "info", "debug"].map((name) => [name, (...args) => consoleEntries.push(args)])),
  });
  runScripts(context, uiScripts(basename));
  await new Promise((resolve) => setImmediate(resolve));

  return {
    document, elements, writes, pendingReads, pendingTabQueries, pendingWrites, consoleEntries, channelRequests, pendingChannels, navigation, context, optionViews,
    deferReads() { deferReads = true; },
    deferTabQueries() { deferTabQueries = true; },
    failWrites(value = true) { failWrites = value; },
    deferWrites() { deferWrites = true; },
    deferChannels() { deferChannels = true; },
    setTabUrl(value) { tabUrl = value; },
    async input(id, value) {
      const input = elements.get(id);
      input.value = value;
      for (const callback of input.listeners.get("input") || []) await callback({ currentTarget: input, target: input });
    },
    async key(id, key) {
      const input = elements.get(id);
      for (const callback of input.listeners.get("keydown") || []) await callback({ currentTarget: input, target: input, key, preventDefault() {} });
      await flushMicrotasks();
    },
    externalChange(key, newValue) {
      stored[key] = newValue;
      for (const listener of storageListeners.get(stored)) listener({ [key]: { newValue } }, "sync");
    },
    async click(id) {
      const target = elements.get(id);
      for (const callback of target.listeners.get("click") || []) await callback({ currentTarget: target, target });
    },
    async change(id, checked) {
      const input = elements.get(id);
      input.checked = checked;
      const callbacks = input.listeners.get("change") || [];
      for (const callback of callbacks) await callback({ currentTarget: input, target: input });
    },
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function siteRow(ui, site) {
  return ui.elements.get("siteLibraryList").children.find(row => row.getAttribute("data-key") === site);
}

async function setSiteBlocked(ui, site, checked) {
  const checkbox = siteRow(ui, site).querySelector('[data-action="blocking"]');
  checkbox.checked = checked;
  for (const callback of checkbox.listeners.get("change") || []) await callback({ currentTarget: checkbox, target: checkbox });
}

for (const surface of ["popup", "options"]) {
  test(`${surface} site validation survives a language change in its local feedback`, async () => {
    const ui = await createHarness(surface);
    await ui.input("siteInput", "garbage!!");
    await ui.key("siteInput", "Enter");
    const old = ui.elements.get("siteLibraryStatus").textContent;
    ui.externalChange("uiLanguage", "fr");
    await flushMicrotasks();
    assert.notEqual(ui.elements.get("siteLibraryStatus").textContent, old);
    assert.match(ui.elements.get("siteLibraryStatus").textContent, /Saisissez/);
    assert.equal(ui.elements.get("siteInput").getAttribute("aria-invalid"), "true");
    await ui.input("siteInput", "valid.example");
    assert.equal(ui.elements.get("siteLibraryStatus").textContent, "");
  });

  test(`${surface} renders browser and saved UI languages and observes language changes`, async () => {
    const automatic = await createHarness(surface, { uiLanguage: "auto" }, "uk-UA");
    assert.equal(automatic.document.documentElement.lang, "uk");
    assert.equal(automatic.writes.length, 0);
    const stored = { uiLanguage: "de" };
    const harness = await createHarness(surface, stored, "es-ES");
    assert.equal(harness.document.documentElement.lang, "de");
    assert.equal(stored.uiLanguage, "de");
    for (const language of ["es", "fr", "ru", "uk", "en", "de"]) {
      harness.externalChange("uiLanguage", language);
      await flushMicrotasks();
      assert.equal(harness.document.documentElement.lang, language);
      assert.equal(harness.elements.get("uiLanguageDropdown").getAttribute("data-value"), language);
    }
    assert.equal(harness.writes.length, 0);
  });

  test(`${surface} visible settings errors follow external language changes`, async () => {
    const harness = await createHarness(surface, { uiLanguage: "en" });
    harness.failWrites();
    await harness.change("applyToShorts", true);
    const error = harness.elements.get("applyToShortsError");
    assert.equal(error.hidden, false);
    harness.failWrites(false);
    const context = vm.createContext({});
    runScripts(context, ["ui/site-rules-strings.js", `ui/${surface}-strings.js`]);
    const dictionaries = vm.runInContext("YTAPStrings", context);
    for (const language of ["de", "es", "fr", "ru", "uk", "en"]) {
      harness.externalChange("uiLanguage", language);
      await flushMicrotasks();
      assert.equal(error.hidden, false, "changing language must not dismiss an unresolved error");
      assert.equal(error.textContent, dictionaries[language].settingsError);
    }
  });
}

test("channel errors preserve their meaning across settings and language changes", async () => {
  const harness = await createHarness("popup", { uiLanguage: "en" });
  harness.elements.get("newItem").value = "/c/example";
  await harness.click("addBtn");
  assert.equal(harness.channelRequests.length, 1);
  const error = harness.elements.get("channelInputError");
  const context = vm.createContext({});
  runScripts(context, ["ui/site-rules-strings.js", "ui/popup-strings.js"]);
  const dictionaries = vm.runInContext("YTAPStrings", context);
  assert.equal(error.textContent, dictionaries.en.channelResolveFailed);
  for (const language of ["de", "es", "fr", "ru", "uk", "en"]) {
    harness.externalChange("uiLanguage", language);
    await flushMicrotasks();
    assert.equal(error.hidden, false);
    assert.equal(error.textContent, dictionaries[language].channelResolveFailed);
  }
  harness.externalChange("debug", true);
  await flushMicrotasks();
  assert.equal(error.textContent, dictionaries.en.channelResolveFailed);
  harness.elements.get("newItem").value = "not a channel";
  await harness.click("addBtn");
  harness.externalChange("uiLanguage", "de");
  await flushMicrotasks();
  assert.equal(error.textContent, dictionaries.de.channelInputInvalid);
});

test("status messages keep independent timers and replace or clear old messages", () => {
  const elements = new Map([["first", new FakeElement()], ["second", new FakeElement()]]);
  const timers = new Map();
  let nextTimer = 0;
  let now = 0;
  const context = vm.createContext({
    document: { getElementById: (id) => elements.get(id) },
    setTimeout(callback, delay) {
      timers.set(++nextTimer, { callback, due: now + delay });
      return nextTimer;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  const advance = (ms) => {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.due > now) continue;
      timers.delete(id);
      timer.callback();
    }
  };
  vm.runInContext(read("shared.js"), context);
  const first = vm.runInContext('createStatusSetter("first", 3500)', context);
  const second = vm.runInContext('createStatusSetter("second", 4000)', context);
  first("old");
  second("independent");
  advance(3000);
  first("new");
  advance(500);
  assert.equal(elements.get("first").textContent, "new", "the old deadline must not clear the replacement");
  assert.equal(elements.get("second").textContent, "independent");
  advance(500);
  assert.equal(elements.get("second").textContent, "");
  advance(2499);
  assert.equal(elements.get("first").textContent, "new");
  advance(1);
  assert.equal(elements.get("first").textContent, "");
  first("validation", { persistent: true });
  advance(10000);
  assert.equal(elements.get("first").textContent, "validation", "validation must not expire like a success message");
  first("clear me");
  first("");
  assert.equal(timers.size, 0, "explicitly clearing a status must cancel its timer");
  assert.doesNotThrow(() => vm.runInContext('createStatusSetter("missing", 3500)("ignored")', context));
});

test("popup and options save only the changed checkbox without overwriting each other", async () => {
  const stored = {};
  const popup = await createHarness("popup", stored);
  const options = await createHarness("options", stored);

  await options.change("debug", true);
  await popup.change("applyToShorts", true);
  assert.equal(stored.debug, true, "a stale popup must not overwrite an options-page setting");
  assert.deepEqual(popup.writes.at(-1), { applyToShorts: true });

  await popup.change("applyToPlaylists", true);
  await options.change("applyToMobile", true);
  assert.equal(stored.applyToPlaylists, true, "a stale options page must not overwrite a popup setting");
  assert.deepEqual(options.writes.at(-1), { applyToMobile: true });
});

for (const basename of ["popup", "options"]) {
  test(`${basename} checkbox changes each save one isolated setting`, async () => {
    const ui = await createHarness(basename);
    const ids = Array.from(read(`${basename}.html`).matchAll(/<input\b[^>]*type="checkbox"[^>]*id="([^"]+)"/g), (match) => match[1]);
    assert.ok(ids.length > 0);
    for (const id of ids) {
      const checked = !ui.elements.get(id).checked;
      const before = ui.writes.length;
      await ui.change(id, checked);
      assert.equal(ui.writes.length, before + 1, `${id} must be saved once`);
      assert.deepEqual(ui.writes.at(-1), { [id]: checked });
    }
  });
}

for (const basename of ["popup", "options"]) {
  test(`${basename} rapid checkbox changes do not roll back after a stale storage read`, async () => {
    const stored = {};
    const ui = await createHarness(basename, stored);
    ui.deferReads();
    const first = ui.change("applyToShorts", true);
    await flushMicrotasks();
    const second = ui.change("applyToShorts", false);
    await flushMicrotasks();

    ui.pendingReads.reverse().forEach((resolve) => resolve());
    await Promise.all([first, second]);
    assert.equal(stored.applyToShorts, false);
    assert.equal(ui.elements.get("applyToShorts").checked, false, "the last user action must remain visible");
  });
}

test("saved current websites are managed once in the library", async () => {
  const ui = await createHarness("popup", { enabled: false, siteLibrary: ["example.com"] });
  assert.equal(ui.elements.get("currentSiteCard").hidden, true);
  assert.equal(siteRow(ui, "example.com").querySelector('[data-action="blocking"]').disabled, true);
});

test("popup retains the current-site card during an active-tab refresh", async () => {
  const ui = await createHarness("popup");
  const card = ui.elements.get("currentSiteCard");
  const details = ui.elements.get("currentSiteDetails");
  const host = ui.elements.get("currentSiteHost");
  const toggle = ui.elements.get("addCurrentSiteBtn");
  const previousHost = host.textContent;
  ui.deferTabQueries();
  const save = ui.change("applyToTwitch", false);
  await flushMicrotasks();

  assert.equal(ui.pendingTabQueries.length, 1);
  assert.equal(card.hidden, false, "pending settings updates must not collapse the card");
  assert.equal(details.hidden, false);
  assert.equal(host.textContent, previousHost);
  assert.equal(toggle.hidden, false);
  assert.equal(toggle.disabled, true, "the site action must wait for the current tab");
  const writesBeforeClick = ui.writes.length;
  await ui.click("addCurrentSiteBtn");
  assert.equal(ui.writes.length, writesBeforeClick, "a pending tab lookup must not edit the previous website");
  ui.pendingTabQueries[0]();
  await save;
  assert.equal(card.hidden, false);
  assert.equal(toggle.disabled, false);
  assert.equal(host.textContent, previousHost);
});

test("debug remains an advanced setting and is preserved by popup changes", async () => {
  const stored = {};
  const popup = await createHarness("popup", stored);
  const options = await createHarness("options", stored);
  assert.equal(popup.elements.has("debug"), false);
  assert.equal(options.elements.has("debug"), true);
  await options.change("debug", true);
  await flushMicrotasks();
  await popup.change("applyToTwitch", false);
  assert.equal(stored.debug, true);
  assert.equal(options.elements.get("debug").checked, true);
  assert.ok(popup.consoleEntries.some((args) => args.includes("saveFlags")));
  await options.change("debug", false);
  assert.equal(stored.debug, false);
});

test("popup current-site status ignores a superseded active-tab response", async () => {
  const ui = await createHarness("popup");
  ui.deferTabQueries();
  const first = ui.change("enabled", false);
  await flushMicrotasks();
  const second = ui.change("enabled", true);
  await flushMicrotasks();
  assert.equal(ui.pendingTabQueries.length, 2);
  ui.pendingTabQueries[1]();
  await second;
  const latestStatus = ui.elements.get("currentSiteHost").textContent;
  ui.pendingTabQueries[0]();
  await first;
  assert.equal(ui.elements.get("enabled").checked, true);
  assert.equal(ui.elements.get("currentSiteHost").textContent, latestStatus, "a stale tab lookup must not undo the newer current-site status");
  assert.equal(ui.elements.get("addCurrentSiteBtn").disabled, false);
});

for (const basename of ["popup", "options"]) {
  test(`${basename} failed settings writes are visible and restore the saved checkbox`, async () => {
    const ui = await createHarness(basename);
    ui.failWrites();
    await ui.change("applyToShorts", true);
    assert.equal(ui.elements.get("applyToShorts").checked, false);
    assert.equal(ui.elements.get("applyToShortsError").hidden, false);
    assert.match(ui.elements.get("applyToShortsError").textContent, /could not/i);
  });
}

test("a failed current-site write leaves the popup usable", async () => {
  const ui = await createHarness("popup");
  ui.failWrites();
  await ui.click("addCurrentSiteBtn");
  assert.equal(ui.elements.get("addCurrentSiteBtn").disabled, false);
  assert.match(ui.elements.get("siteLibraryStatus").textContent, /could not/i);
});

test("concurrent popup and options library additions preserve both sites", async () => {
  const stored = { applyToOtherSites: false };
  const popup = await createHarness("popup", stored);
  const options = await createHarness("options", stored);
  options.elements.get("siteInput").value = "other.example";
  await Promise.all([options.click("siteAddBtn"), popup.click("addCurrentSiteBtn")]);
  assert.deepEqual(stored.siteLibrary.sort(), ["example.com", "other.example"]);
});

test("concurrent channel additions preserve both entries", async () => {
  const stored = {};
  const first = await createHarness("popup", stored);
  const second = await createHarness("popup", stored);
  first.elements.get("newItem").value = "/@first";
  second.elements.get("newItem").value = "/@second";
  await Promise.all([first.click("addBtn"), second.click("addBtn")]);
  assert.deepEqual(stored.allowlist.sort(), ["/@first", "/@second"]);
});

test("channel lookup admits one request, keeps a newer draft and releases busy state", async () => {
  const stored = {};
  const ui = await createHarness("popup", stored);
  ui.deferChannels();
  await ui.input("newItem", "/c/example");
  const first = ui.click("addBtn");
  await flushMicrotasks();
  assert.equal(ui.elements.get("addBtn").disabled, true);
  assert.equal(ui.elements.get("addBtn").getAttribute("aria-busy"), "true");
  assert.match(ui.elements.get("status").textContent, /Adding/);
  await ui.key("newItem", "Enter");
  assert.equal(ui.channelRequests.length, 1);
  await ui.input("newItem", "@newdraft");
  ui.pendingChannels[0]({ ok: true, url: "https://www.youtube.com/c/example", text: async () => '<link rel="canonical" href="https://www.youtube.com/@resolved">' });
  await first;
  assert.deepEqual(stored.allowlist, ["/@resolved"]);
  assert.equal(ui.elements.get("newItem").value, "@newdraft");
  assert.equal(ui.elements.get("addBtn").disabled, false);
  assert.equal(ui.elements.get("addBtn").getAttribute("aria-busy"), "false");
});

test("failed channel lookup can be retried and duplicate channels do not claim a new write", async () => {
  const ui = await createHarness("popup", { allowlist: ["/@example"] });
  await ui.input("newItem", "/c/example");
  await ui.click("addBtn");
  assert.equal(ui.elements.get("addBtn").disabled, false);
  assert.equal(ui.elements.get("channelInputError").hidden, false);
  await ui.input("newItem", "@EXAMPLE");
  await ui.click("addBtn");
  assert.equal(ui.writes.length, 0);
  assert.equal(ui.elements.get("status").textContent, "Already added: /@example");
});

test("the current-channel action is only offered on YouTube", async () => {
  const ui = await createHarness("popup");
  assert.equal(ui.elements.get("addCurrentBtn").hidden, true);
  ui.setTabUrl("https://www.youtube.com/watch?v=example");
  ui.externalChange("debug", true);
  await flushMicrotasks();
  assert.equal(ui.elements.get("addCurrentBtn").hidden, false);
  ui.setTabUrl("https://notyoutube.example/watch");
  ui.externalChange("debug", false);
  await flushMicrotasks();
  assert.equal(ui.elements.get("addCurrentBtn").hidden, true);
});

test("popup manages website rules without navigating to options", async () => {
  const stored = {};
  const popup = await createHarness("popup", stored);
  await popup.input("siteInput", "video.example");
  await popup.key("siteInput", "Enter");
  assert.equal(popup.elements.get("siteLibraryList").children.length, 1);
  assert.equal(siteRow(popup, "video.example").querySelector('[data-action="blocking"]').checked, true);
  await setSiteBlocked(popup, "video.example", false);
  assert.deepEqual(stored.siteExclusions, ["video.example"]);
  assert.equal(popup.elements.get("siteLibraryList").children.length, 1);
  const remove = siteRow(popup, "video.example").lastElementChild;
  await remove.listeners.get("click")[0]({ currentTarget: remove, target: remove });
  assert.equal(popup.elements.get("siteLibraryList").children.length, 0);
  await popup.click("siteUndoBtn");
  assert.equal(popup.elements.get("siteLibraryList").children.length, 1);
  assert.equal(siteRow(popup, "video.example").querySelector('[data-action="blocking"]').checked, false);
  assert.deepEqual(popup.navigation, []);
});

for (const surface of ["popup", "options"]) {
  test(`${surface} toggles an exact rule without deleting unrelated entries`, async () => {
    const stored = { siteLibrary: ["first.example"], siteExclusions: ["video.example", "other.example"] };
    const ui = await createHarness(surface, stored);
    await setSiteBlocked(ui, "video.example", true);
    assert.deepEqual(stored.siteLibrary, ["first.example", "video.example"]);
    assert.deepEqual(stored.siteExclusions, ["other.example"]);
    await setSiteBlocked(ui, "video.example", false);
    assert.deepEqual(stored.siteLibrary, ["first.example"]);
    assert.deepEqual(stored.siteExclusions, ["other.example", "video.example"]);
  });

  test(`${surface} preserves a parent exception when a subdomain is saved`, async () => {
    const stored = { siteExclusions: ["example.com"] };
    const ui = await createHarness(surface, stored);
    await ui.input("siteInput", "video.example.com");
    await ui.key("siteInput", "Enter");
    assert.deepEqual(stored.siteExclusions, ["example.com", "video.example.com"]);
    assert.equal(siteRow(ui, "video.example.com").querySelector('[data-action="blocking"]').checked, false);
    const writes = ui.writes.length;
    await setSiteBlocked(ui, "video.example.com", true);
    assert.equal(ui.writes.length, writes);
    assert.match(ui.elements.get("siteLibraryStatus").textContent, /example\.com/);
    assert.equal(siteRow(ui, "video.example.com").querySelector('[data-action="blocking"]').checked, false);
  });

  test(`${surface} a full exception collection rolls back the checkbox and keeps membership`, async () => {
    const { entries, next: site } = fullCollection("siteExclusions");
    const stored = { siteLibrary: [site], siteExclusions: entries };
    const ui = await createHarness(surface, stored);
    await setSiteBlocked(ui, site, false);
    assert.deepEqual(stored.siteLibrary, [site]);
    assert.deepEqual(stored.siteExclusions, entries);
    assert.equal(siteRow(ui, site).querySelector('[data-action="blocking"]').checked, true);
    assert.match(ui.elements.get("siteLibraryStatus").textContent, /storage limit/);
  });

  test(`${surface} repeated Enter submits one site while retaining a newer draft`, async () => {
    const stored = {};
    const ui = await createHarness(surface, stored);
    ui.deferWrites();
    await ui.input("siteInput", "first.example");
    const submit = ui.key("siteInput", "Enter");
    await flushMicrotasks();
    assert.equal(ui.elements.get("siteAddBtn").disabled, true);
    await ui.input("siteInput", "second.example");
    const repeated = ui.key("siteInput", "Enter");
    await flushMicrotasks();
    assert.equal(ui.writes.length, 1);
    ui.pendingWrites[0]();
    await submit;
    await flushMicrotasks();
    if (ui.pendingWrites[1]) ui.pendingWrites[1]();
    await repeated;
    assert.equal(ui.writes.length, 1);
    assert.deepEqual(stored.siteLibrary, ["first.example"]);
    assert.equal(ui.elements.get("siteInput").value, "second.example");
    assert.equal(ui.elements.get("siteAddBtn").disabled, false);
  });

  test(`${surface} undo cannot override a newer opposite rule`, async () => {
    const stored = { siteLibrary: ["video.example"] };
    const ui = await createHarness(surface, stored);
    const button = ui.elements.get("siteLibraryList").children[0].lastElementChild;
    await button.listeners.get("click")[0]({ currentTarget: button, target: button });
    ui.externalChange("siteExclusions", ["video.example"]);
    await ui.click("siteUndoBtn");
    assert.deepEqual(stored.siteLibrary, []);
    assert.deepEqual(stored.siteExclusions, ["video.example"]);
    assert.match(ui.elements.get("siteLibraryStatus").textContent, /already in your library/);
  });
}

for (const [inputId, addId, statusId, key, listId, filterId, undoId] of [
  ["siteInput", "siteAddBtn", "siteLibraryStatus", "siteLibrary", "siteLibraryList", "siteFilter", "siteUndoBtn"],
  ["siteInput", "siteAddBtn", "siteLibraryStatus", "siteExclusions", "siteLibraryList", "siteFilter", "siteUndoBtn"],
]) {
  test(`${key} clears obsolete validation when edited and filters without changing saved rules`, async () => {
    const stored = { [key]: ["alpha.example", "beta.example"] };
    const ui = await createHarness("options", stored);
    await ui.input(inputId, "garbage!!");
    await ui.click(addId);
    assert.equal(ui.elements.get(inputId).getAttribute("aria-invalid"), "true");
    assert.match(ui.elements.get(statusId).textContent, /valid/);
    await ui.input(inputId, "valid.example");
    assert.equal(ui.elements.get(inputId).getAttribute("aria-invalid"), "false");
    assert.equal(ui.elements.get(statusId).textContent, "");
    await ui.input(filterId, "BETA");
    assert.equal(ui.elements.get(listId).children.length, 1);
    assert.equal(ui.elements.get(listId).children[0].children[0].textContent, "beta.example");
    await ui.input(filterId, "missing");
    assert.equal(ui.elements.get(listId).children.length, 0);
    assert.equal(ui.elements.get("siteEmpty").textContent, "No websites match this search.");
    assert.deepEqual(stored[key], ["alpha.example", "beta.example"]);
    assert.equal(ui.writes.length, 0);
    await ui.input(filterId, "");
    assert.equal(ui.elements.get(listId).children.length, 2);
  });

  test(`${key} undo restores only the removed rule and preserves later edits in both windows`, async () => {
    const stored = { [key]: ["alpha.example", "beta.example"] };
    const first = await createHarness("options", stored);
    const second = await createHarness("options", stored);
    const button = first.elements.get(listId).children[0].lastElementChild;
    await button.listeners.get("click")[0]({ currentTarget: button, target: button });
    assert.deepEqual(stored[key], ["beta.example"]);
    assert.equal(first.elements.get(undoId).hidden, false);
    await second.input(inputId, "gamma.example");
    await second.click(addId);
    if (key === "siteExclusions") await setSiteBlocked(second, "gamma.example", false);
    first.elements.get(undoId).focus();
    await first.click(undoId);
    assert.deepEqual(stored[key].sort(), ["alpha.example", "beta.example", "gamma.example"]);
    assert.equal(first.elements.get(undoId).hidden, true);
    assert.equal(second.elements.get(listId).children.length, 3);
    assert.equal(first.document.activeElement, first.elements.get(listId).children[0].lastElementChild);
    await first.click(undoId);
    assert.deepEqual(stored[key].sort(), ["alpha.example", "beta.example", "gamma.example"]);
  });

  test(`${key} undo does not erase later overlapping rules and a failed restore stays retryable`, async () => {
    const stored = { [key]: ["alpha.example"] };
    const ui = await createHarness("options", stored);
    const remove = async () => {
      const button = ui.elements.get(listId).children[0].lastElementChild;
      await button.listeners.get("click")[0]({ currentTarget: button, target: button });
    };
    await remove();
    ui.failWrites();
    await ui.click(undoId);
    assert.equal(ui.elements.get(undoId).hidden, false);
    assert.deepEqual(stored[key], []);
    assert.match(ui.elements.get(statusId).textContent, /could not/);
    ui.failWrites(false);
    await ui.click(undoId);
    assert.deepEqual(stored[key], ["alpha.example"]);
    await remove();
    ui.externalChange(key, ["sub.alpha.example"]);
    await ui.click(undoId);
    assert.deepEqual(stored[key], ["sub.alpha.example"]);
    assert.match(ui.elements.get(statusId).textContent, /have changed/);
  });
}

test("popup diagnostics redact free-form channel input", async () => {
  const ui = await createHarness("popup", { debug: true });
  ui.elements.get("newItem").value = "@private-channel-marker";
  await ui.click("addBtn");
  assert.ok(ui.consoleEntries.some((args) => args.includes("allowlist:add")), "debug capture must include the relevant action");
  assert.ok(!JSON.stringify(ui.consoleEntries).includes("private-channel-marker"), "raw user input must be hidden even without a channel-path prefix");
});

test("popup rejects invalid channel input without clearing it or writing settings", async () => {
  const ui = await createHarness("popup");
  const input = ui.elements.get("newItem");
  input.value = "unstructured channel value";
  await ui.click("addBtn");
  assert.equal(input.getAttribute("aria-invalid"), "true");
  assert.equal(input.value, "unstructured channel value");
  assert.equal(ui.writes.length, 0);
  const error = ui.elements.get("channelInputError");
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /handle|YouTube/);
  input.value = "@ValidHandle";
  await ui.click("addBtn");
  assert.equal(input.getAttribute("aria-invalid"), "false");
  assert.equal(error.hidden, true);
  assert.equal(input.value, "");
  assert.deepEqual(ui.writes.at(-1), { allowlist: ["/@validhandle"] });
});

test("a failed list write retains input and releases the lock for retry", async () => {
  const stored = {};
  const options = await createHarness("options", stored);
  options.elements.get("siteInput").value = "retry.example";
  options.failWrites();
  await options.click("siteAddBtn");
  assert.equal(options.elements.get("siteInput").value, "retry.example");
  assert.equal(stored.siteLibrary, undefined);
  options.failWrites(false);
  await options.click("siteAddBtn");
  assert.deepEqual(stored.siteLibrary, ["retry.example"]);
  assert.equal(options.elements.get("siteInput").value, "");
  assert.equal(options.elements.get("settingsError").hidden, true);
});

test("settings views reflect storage changes while preserving unsubmitted drafts", async () => {
  const stored = {};
  const first = await createHarness("options", stored);
  const second = await createHarness("options", stored);
  first.elements.get("siteInput").value = "draft.example";
  await second.change("applyToOtherSites", false);
  assert.equal(first.elements.get("applyToOtherSites").checked, false);
  assert.equal(first.elements.get("siteInput").value, "draft.example");
  second.elements.get("siteInput").value = "excluded.example";
  await second.click("siteAddBtn");
  await setSiteBlocked(second, "excluded.example", false);
  assert.equal(first.elements.get("siteLibraryList").children.at(-1).children[0].textContent, "excluded.example");
  assert.equal(first.elements.get("siteInput").value, "draft.example");
});

test("master off disables playback controls without losing their stored values", async () => {
  for (const basename of ["popup", "options"]) {
    const ui = await createHarness(basename, { applyToShorts: true });
    await ui.change("enabled", false);
    for (const key of ["applyToYouTube", "applyToOtherSites", "applyToShorts", "applyToTwitch"]) assert.equal(ui.elements.get(key).disabled, true, key);
    assert.equal(ui.elements.get("applyToShorts").checked, true);
    if (basename === "options") assert.equal(ui.elements.get("debug").disabled, false);
    await ui.change("enabled", true);
    assert.equal(ui.elements.get("applyToShorts").disabled, false);
  }
});

test("legacy channel settings migrate on edit without losing entries", async () => {
  const stored = { whitelist: ["/@existing"] };
  const ui = await createHarness("popup", stored);
  ui.elements.get("newItem").value = "@additional";
  await ui.click("addBtn");
  assert.deepEqual(stored.allowlist, ["/@existing", "/@additional"]);
  assert.equal("whitelist" in stored, false);
});

test("the current-site action adds membership and the row controls blocking", async () => {
  const stored = {};
  const ui = await createHarness("popup", stored);
  await ui.click("addCurrentSiteBtn");
  assert.deepEqual(stored.siteLibrary, ["example.com"]);
  assert.equal(ui.elements.get("currentSiteCard").hidden, true);
  await setSiteBlocked(ui, "example.com", false);
  assert.deepEqual(stored.siteExclusions, ["example.com"]);
  assert.deepEqual(stored.siteLibrary, []);
  await setSiteBlocked(ui, "example.com", true);
  assert.deepEqual(stored.siteExclusions, []);
  assert.deepEqual(stored.siteLibrary, ["example.com"]);
});

test("a later storage event wins after a pending flag write completes", async () => {
  const ui = await createHarness("options");
  ui.deferWrites();
  const save = ui.change("debug", true);
  await flushMicrotasks();
  assert.equal(ui.pendingWrites.length, 1);
  ui.externalChange("debug", false);
  ui.pendingWrites[0]();
  await save;
  assert.equal(ui.elements.get("debug").checked, false);
});

for (const [surface, inputId, actionId, key, listId, added, latest] of [
  ["options", "siteInput", "siteAddBtn", "siteLibrary", "siteLibraryList", "first.example", "latest.example"],
  ["popup", "newItem", "addBtn", "allowlist", "list", "@first", "/@latest"],
]) {
  test(`${surface} list completion cannot overwrite a newer ${key} storage update`, async () => {
    const stored = {};
    const ui = await createHarness(surface, stored);
    ui.deferWrites();
    ui.elements.get(inputId).value = added;
    const save = ui.click(actionId);
    await flushMicrotasks();
    assert.equal(ui.pendingWrites.length, 1, "the original write must still be pending");
    ui.externalChange(key, [latest]);
    await flushMicrotasks();
    assert.equal(ui.elements.get(listId).children.at(-1).children[0].textContent, latest);
    ui.pendingWrites[0]();
    await save;
    assert.deepEqual(stored[key], [latest]);
    assert.equal(ui.elements.get(listId).children.at(-1).children[0].textContent, latest);
    assert.equal(ui.elements.get(inputId).value, "");
  });
}

for (const [surface, key, listId] of [
  ["options", "siteLibrary", "siteLibraryList"],
  ["options", "siteExclusions", "siteLibraryList"],
  ["popup", "allowlist", "list"],
]) {
  test(`${surface} removal completion preserves the latest ${key} and input draft`, async () => {
    const old = key === "allowlist" ? "/@first" : "first.example";
    const latest = key === "allowlist" ? "/@latest" : "latest.example";
    const ui = await createHarness(surface, { [key]: [old] });
    const inputId = surface === "popup" ? "newItem" : "siteInput";
    const input = ui.elements.get(inputId);
    input.value = "unsubmitted-draft";
    const button = ui.elements.get(listId).children[0].lastElementChild;
    ui.deferWrites();
    const remove = button.listeners.get("click")[0]({ currentTarget: button, target: button });
    await flushMicrotasks();
    assert.equal(ui.pendingWrites.length, 1);
    ui.externalChange(key, [latest]);
    await flushMicrotasks();
    ui.pendingWrites[0]();
    await remove;
    const items = ui.elements.get(listId).children;
    assert.equal(items.length, 1);
    assert.equal(items[0].children[0].textContent, latest);
    assert.equal(input.value, "unsubmitted-draft");
    assert.equal(ui.writes.length, 1);
  });
}
