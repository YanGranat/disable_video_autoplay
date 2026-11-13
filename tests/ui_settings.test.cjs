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

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.checked = false;
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    const classes = new Set();
    this.classList = {
      contains: (name) => classes.has(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
    };
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  querySelectorAll() { return []; }
  appendChild(child) { this.children.push(child); }
  focus() {}
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
  for (const match of read(`${basename}.html`).matchAll(/\bid="([^"]+)"/g)) {
    elements.set(match[1], new FakeElement(match[1]));
  }
  const writes = [];
  const consoleEntries = [];
  const pendingReads = [];
  const pendingTabQueries = [];
  const pendingWrites = [];
  let deferReads = false;
  let deferTabQueries = false;
  let failWrites = false;
  let deferWrites = false;
  const document = {
    documentElement: {},
    getElementById: (id) => elements.get(id),
    querySelectorAll: () => [],
    createElement: () => new FakeElement(),
    addEventListener() {},
  };
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
    tabs: { query: () => {
      const tabs = [{ id: 1, url: "https://example.com/" }];
      if (!deferTabQueries) return Promise.resolve(tabs);
      return new Promise((resolve) => pendingTabQueries.push(() => resolve(tabs)));
    } },
    runtime: { openOptionsPage() {} },
  };
  const context = vm.createContext({
    document, chrome, URL, navigator: { locks: lockManagers.get(stored) }, HTMLElement: FakeElement, Node: FakeElement,
    setTimeout, clearTimeout,
    console: Object.fromEntries(["log", "info", "debug"].map((name) => [name, (...args) => consoleEntries.push(args)])),
  });
  runScripts(context, uiScripts(basename));
  await new Promise((resolve) => setImmediate(resolve));

  return {
    document, elements, writes, pendingReads, pendingTabQueries, pendingWrites, consoleEntries,
    deferReads() { deferReads = true; },
    deferTabQueries() { deferTabQueries = true; },
    failWrites(value = true) { failWrites = value; },
    deferWrites() { deferWrites = true; },
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

for (const surface of ["popup", "options"]) {
  test(`${surface} renders browser and saved UI languages and observes language changes`, async () => {
    const automatic = await createHarness(surface, { uiLanguage: "auto" }, "uk-UA");
    assert.equal(automatic.document.documentElement.lang, "uk");
    assert.equal(automatic.writes.length, 0);
    const stored = { uiLanguage: "de" };
    const harness = await createHarness(surface, stored, "es-ES");
    assert.equal(harness.document.documentElement.lang, "de");
    assert.equal(stored.uiLanguage, "de");
    for (const language of ["es", "ru", "uk", "en", "de"]) {
      harness.externalChange("uiLanguage", language);
      await flushMicrotasks();
      assert.equal(harness.document.documentElement.lang, language);
      assert.equal(harness.elements.get("uiLanguageDropdown").getAttribute("data-value"), language);
    }
    assert.equal(harness.writes.length, 0);
  });
}

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

test("popup current-site status does not claim blocking when the master switch is off", async () => {
  const ui = await createHarness("popup", { enabled: false, siteLibrary: ["example.com"] });
  assert.equal(ui.elements.get("currentSiteMode").textContent, "Autoplay blocking is off on this site.");
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
  const latestStatus = ui.elements.get("currentSiteMode").textContent;
  assert.notEqual(latestStatus, "Autoplay blocking is off on this site.");
  ui.pendingTabQueries[0]();
  await first;
  assert.equal(ui.elements.get("enabled").checked, true);
  assert.equal(ui.elements.get("currentSiteMode").textContent, latestStatus, "a stale tab lookup must not undo the newer current-site status");
  assert.equal(ui.elements.get("toggleCurrentSiteBtn").disabled, false);
});

for (const basename of ["popup", "options"]) {
  test(`${basename} failed settings writes are visible and restore the saved checkbox`, async () => {
    const ui = await createHarness(basename);
    ui.failWrites();
    await ui.change("applyToShorts", true);
    assert.equal(ui.elements.get("applyToShorts").checked, false);
    assert.equal(ui.elements.get("settingsError").hidden, false);
    assert.match(ui.elements.get("settingsError").textContent, /could not/i);
  });
}

test("a failed current-site write leaves the popup usable", async () => {
  const ui = await createHarness("popup");
  ui.failWrites();
  await ui.click("toggleCurrentSiteBtn");
  assert.equal(ui.elements.get("toggleCurrentSiteBtn").disabled, false);
  assert.equal(ui.elements.get("settingsError").hidden, false);
});

test("concurrent popup and options library additions preserve both sites", async () => {
  const stored = { applyToOtherSites: false };
  const popup = await createHarness("popup", stored);
  const options = await createHarness("options", stored);
  options.elements.get("siteInput").value = "other.example";
  await Promise.all([options.click("siteAddBtn"), popup.click("toggleCurrentSiteBtn")]);
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
  second.elements.get("exclusionInput").value = "excluded.example";
  await second.click("exclusionAddBtn");
  assert.equal(first.elements.get("exclusionList").children.at(-1).children[0].textContent, "excluded.example");
  assert.equal(first.elements.get("siteInput").value, "draft.example");
});

test("master off disables playback controls without losing their stored values", async () => {
  for (const basename of ["popup", "options"]) {
    const ui = await createHarness(basename, { applyToShorts: true });
    await ui.change("enabled", false);
    for (const key of ["applyToYouTube", "applyToOtherSites", "applyToShorts", "applyToTwitch"]) assert.equal(ui.elements.get(key).disabled, true, key);
    assert.equal(ui.elements.get("applyToShorts").checked, true);
    assert.equal(ui.elements.get("debug").disabled, undefined);
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

test("the current-site action creates an exclusion under global coverage", async () => {
  const stored = {};
  const ui = await createHarness("popup", stored);
  await ui.click("toggleCurrentSiteBtn");
  assert.deepEqual(stored.siteExclusions, ["example.com"]);
  assert.equal(ui.elements.get("toggleCurrentSiteBtn").textContent, "Remove exception for example.com");
  await ui.click("toggleCurrentSiteBtn");
  assert.deepEqual(stored.siteExclusions, []);
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
