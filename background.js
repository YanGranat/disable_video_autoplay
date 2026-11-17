/* global YTAPSettings */
importScripts("core/site-context.js", "core/settings.js");

let visualRevision = 0;

async function updateActionVisuals() {
  const revision = ++visualRevision;
  const settings = await chrome.storage.sync.get({ enabled: YTAPSettings.defaults.enabled });
  if (revision !== visualRevision) return;
  const enabled = settings?.enabled !== false;

  const icon = enabled
    ? {
        16: "icons/icon16.png",
        32: "icons/icon32.png",
      }
    : {
        16: "icons/icon16_off.png",
        32: "icons/icon32_off.png",
      };

  await chrome.action.setIcon({ path: icon });
}

chrome.runtime.onInstalled.addListener(() => {
  updateActionVisuals().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  updateActionVisuals().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if (!changes.enabled) return;
  updateActionVisuals().catch(() => {});
});

// A worker can restart without an install, browser-start or settings event.
updateActionVisuals().catch(() => {});
