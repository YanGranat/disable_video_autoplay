/* global YTAPSettings */
/* exported YTAPSettingsStore */

/**
 * Chrome Sync adapter. UI/content code works with settings operations, not
 * storage details. Rejections stay visible to each caller's recovery policy.
 * All methods are lazy: loading this file performs no reads or registrations.
 */
async function writeSettingsPatch(patch) {
  await chrome.storage.sync.set(patch);
  if ("allowlist" in patch) await chrome.storage.sync.remove?.("whitelist");
}

const YTAPSettingsStore = Object.freeze({
  async read(defaults = YTAPSettings.defaults) {
    if (!("allowlist" in defaults)) return chrome.storage.sync.get(defaults);
    const data = await chrome.storage.sync.get({ ...defaults, allowlist: null, whitelist: null });
    const channels = data.allowlist ?? data.whitelist;
    data.allowlist = Array.isArray(channels) ? [...new Set(channels.map(YTAPSettings.normalizeChannel).filter(Boolean))] : [];
    for (const key of ["siteLibrary", "siteExclusions"]) {
      if (key in data) data[key] = YTAPSettings.normalizeSiteLibrary(data[key]);
    }
    delete data.whitelist;
    return data;
  },
  write(patch) {
    return navigator.locks.request("ytap-settings", () => writeSettingsPatch(patch));
  },
  // The lock covers the entire read/modify/write across popup and options.
  // A null result means no write; errors release the lock and reach the caller.
  updateList(key, update) {
    return navigator.locks.request("ytap-settings", async () => {
      const data = await YTAPSettingsStore.read({ [key]: [] });
      const next = update(data[key]);
      if (next !== null) await writeSettingsPatch({ [key]: next });
      return next;
    });
  },
  updateSites(update) {
    return navigator.locks.request("ytap-settings", async () => {
      const data = await YTAPSettingsStore.read();
      const patch = update(data);
      if (patch !== null) await writeSettingsPatch(patch);
      return patch;
    });
  },
  subscribe(listener) {
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  },
});

