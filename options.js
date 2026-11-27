/* global $, YTAPSettings, YTAPStrings, resolveUiLanguage, makeTranslator, setSelectedUiLanguage, applyI18n, initLanguageDropdown, withUiErrorHandling, createSettingsView, applySettingsAvailability, finishSettingsLoad, createSiteRulesView, showSettingsError */

let currentLang = "en";
let t = makeTranslator(YTAPStrings, currentLang);
let currentSettings = { ...YTAPSettings.defaults };

const safeAction = (action, errorId) => withUiErrorHandling(async (...args) => {
  try { return await action(...args); }
  finally { if (!document.documentElement.classList.contains("settings-loading")) applySettingsAvailability(currentSettings); }
}, (error, source) => recoverSettingsError(error, errorId ? $(errorId) : source));
const settingsView = createSettingsView(renderSettings, recoverSettingsError);
const load = () => settingsView.load();
const siteRules = createSiteRulesView({ translate: () => t, reload: load, safeAction });

async function recoverSettingsError(error, source) {
  try { await load(); } catch { /* Storage may be unavailable, not merely full. */ }
  if (source?.id === "siteLibraryStatus") { siteRules.error(error); return; }
  showSettingsError(t, source);
}

function renderSettings(data) {
  currentSettings = data;
  const uiLanguage = data.uiLanguage || "auto";
  const language = resolveUiLanguage(uiLanguage);
  currentLang = language;
  t = makeTranslator(YTAPStrings, currentLang);
  document.documentElement.lang = currentLang;
  document.title = `${t("title")} — ${t("optionsTitle")}`;

  setSelectedUiLanguage(uiLanguage, t);
  $("enabled").checked = data.enabled !== false;
  $("applyToYouTube").checked = data.applyToYouTube !== false;
  $("stopInsteadOfPause").checked = !!data.stopInsteadOfPause;
  $("applyToEmbedded").checked = data.applyToEmbedded !== false;
  $("applyToMobile").checked = !!data.applyToMobile;
  $("applyToTwitch").checked = !!data.applyToTwitch;
  $("applyToKick").checked = !!data.applyToKick;
  $("applyToOtherSites").checked = data.applyToOtherSites !== false;
  $("applyToShorts").checked = !!data.applyToShorts;
  $("applyToChannelPlayer").checked = !!data.applyToChannelPlayer;
  $("applyToPlaylists").checked = !!data.applyToPlaylists;
  $("ignoreMiniplayer").checked = data.ignoreMiniplayer !== false;
  $("pauseOnHidden").checked = !!data.pauseOnHidden;
  $("resumeOnVisible").checked = !!data.resumeOnVisible;
  $("debug").checked = !!data.debug;
  $("debug").disabled = false;

  applyI18n(t);
  siteRules.render(data);
  $("resumeRequirement").hidden = !!data.pauseOnHidden;
  $("resumeOnVisible").setAttribute("aria-describedby", `resumeOnVisibleDescription resumeOnVisibleError${data.pauseOnHidden ? "" : " resumeRequirement"}`);
  $("extensionVersion").textContent = chrome.runtime.getManifest().version;
  applySettingsAvailability(data);
  finishSettingsLoad();
}

async function save(event) {
  // Write only the changed setting. Other open UI pages may have newer values
  // for unrelated flags, and a full reload can roll back a rapid second click.
  const id = event.currentTarget.id;
  await settingsView.save(id, event.currentTarget.checked);
}

[
  "enabled",
  "applyToYouTube",
  "stopInsteadOfPause",
  "applyToEmbedded",
  "applyToMobile",
  "applyToTwitch",
  "applyToKick",
  "applyToOtherSites",
  "applyToShorts",
  "applyToChannelPlayer",
  "applyToPlaylists",
  "ignoreMiniplayer",
  "pauseOnHidden",
  "resumeOnVisible",
  "debug",
].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("change", safeAction(save));
});

initLanguageDropdown(load, recoverSettingsError);
const focusSection = () => {
  if (location.hash !== "#siteRules") return;
  $("siteRules").scrollIntoView({ block: "start" });
  $("siteRules").focus({ preventScroll: true });
};
window.addEventListener("hashchange", focusSection);
safeAction(async () => { await load(); focusSection(); })();
