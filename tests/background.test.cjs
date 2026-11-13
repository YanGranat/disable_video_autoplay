const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

test("every worker startup restores the persisted action icon without a lifecycle event", async () => {
  for (const enabled of [false, true]) {
    const icons = [];
    const event = { addListener() {} };
    const context = vm.createContext({
      importScripts() {},
      YTAPSettingsStore: { read: async () => ({ enabled }), subscribe() {} },
      chrome: { runtime: { onInstalled: event, onStartup: event }, storage: { onChanged: event },
        action: { setIcon: async ({ path: icon }) => icons.push(icon) } },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(icons.length, 1);
    assert.equal(icons[0][16], enabled ? "icons/icon16.png" : "icons/icon16_off.png");
    assert.equal(icons[0][32], enabled ? "icons/icon32.png" : "icons/icon32_off.png");
  }
});

test("a superseded icon read cannot overwrite a newer enabled state", async () => {
  const reads = [];
  const icons = [];
  let changed;
  const event = { addListener() {} };
  const context = vm.createContext({
    importScripts() {},
    YTAPSettingsStore: { read: () => new Promise((resolve) => reads.push(resolve)),
      subscribe: (callback) => { changed = callback; } },
    chrome: { runtime: { onInstalled: event, onStartup: event },
      action: { setIcon: async ({ path: icon }) => icons.push(icon) } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), context);
  changed({ enabled: { newValue: false } }, "sync");
  reads[1]({ enabled: false });
  await new Promise((resolve) => setImmediate(resolve));
  reads[0]({ enabled: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(icons.length, 1);
  assert.equal(icons[0][16], "icons/icon16_off.png");
});
