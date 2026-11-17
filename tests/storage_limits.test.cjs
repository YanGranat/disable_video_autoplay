const assert = require("node:assert/strict");
const vm = require("node:vm");
const { test } = require("node:test");
const { runScripts } = require("./load_scripts.cjs");

test("sync writes enforce the byte limit before changing data and retain exact boundaries", async () => {
  const writes = [];
  const removed = [];
  const context = vm.createContext({ TextEncoder,
    chrome: { storage: { sync: { QUOTA_BYTES_PER_ITEM: 8192,
      set: async patch => writes.push(patch), remove: async key => removed.push(key) } } },
    navigator: { locks: { request: (_name, action) => action() } },
  });
  runScripts(context, ["adapters/settings-store.js"]);
  const store = vm.runInContext("YTAPSettingsStore", context);
  // JSON quotes and the storage key count toward the same per-item limit.
  await store.write({ probe: "a".repeat(8185) });
  assert.equal(writes.length, 1);
  for (const value of ["a".repeat(8186), "é".repeat(4093), "😀".repeat(2047)]) {
    await assert.rejects(store.write({ probe: value }), error => error.code === "SETTINGS_ITEM_TOO_LARGE" && error.settingKey === "probe");
  }
  await assert.rejects(store.write({ allowlist: ["a".repeat(8192)] }), { code: "SETTINGS_ITEM_TOO_LARGE" });
  assert.equal(writes.length, 1);
  assert.deepEqual(removed, [], "rejected writes must not remove legacy data");
  await store.write({ enabled: false });
  assert.equal(writes.length, 2, "a failed list save releases the settings lock");
});
