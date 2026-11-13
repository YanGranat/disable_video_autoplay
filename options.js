/* global $, YTAPSettings, YTAPSettingsStore, YTAPStrings, detectBrowserLanguage, makeTranslator, setSelectedUiLanguage, applyI18n, initLanguageDropdown, withUiErrorHandling, createStatusSetter, createSettingsView, applySettingsAvailability */

const { normalizeSite, normalizeSiteLibrary, siteMatchesHostname, isDedicatedSite } = YTAPSettings;

let currentLang = "en";
let t = makeTranslator(YTAPStrings, currentLang);
let currentSettings = { ...YTAPSettings.defaults };
const safeAction = (action) => withUiErrorHandling(async (...args) => {
  try { return await action(...args); }
  finally { applySettingsAvailability(currentSettings); }
}, recoverSettingsError);
const setSiteLibraryStatus = createStatusSetter("siteLibraryStatus", 4000);
const setExclusionStatus = createStatusSetter("exclusionStatus", 4000);
const settingsView = createSettingsView(renderSettings, recoverSettingsError);
const load = () => settingsView.load();

async function recoverSettingsError() {
  try { await load(); } catch { /* Storage may be unavailable, not merely full. */ }
  $("settingsError").textContent = t("settingsError");
  $("settingsError").hidden = false;
}

function renderSettings(data) {
  currentSettings = data;
  const uiLanguage = data.uiLanguage || "auto";
  const language = uiLanguage === "auto" ? detectBrowserLanguage() : uiLanguage;
  if (language !== currentLang) { setSiteLibraryStatus(""); setExclusionStatus(""); }
  currentLang = language;
  t = makeTranslator(YTAPStrings, currentLang);
  document.documentElement.lang = currentLang;
  document.title = `${t("title")} — ${currentLang === "ru" ? "Настройки" : "Options"}`;

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

  applyI18n(t);
  renderSiteLibrary(data.siteLibrary);
  renderSiteLibrary(data.siteExclusions, true);
  applySettingsAvailability(data);
}

function renderSiteLibrary(items, excluded = false) {
  const library = normalizeSiteLibrary(items);
  const list = $(excluded ? "exclusionList" : "siteLibraryList");
  list.innerHTML = "";
  $(excluded ? "exclusionCount" : "siteCount").textContent = t("siteLibraryCount", library.length);

  if (library.length === 0) {
    const empty = document.createElement("li");
    empty.className = "site-empty";
    empty.textContent = t(excluded ? "exclusionEmpty" : "siteLibraryEmpty");
    list.appendChild(empty);
    return;
  }

  library.forEach((site) => {
    const item = document.createElement("li");
    item.className = "site-item";

    const name = document.createElement("span");
    name.className = "site-item-name";
    name.textContent = site;
    name.title = site;

    const remove = document.createElement("button");
    remove.className = "site-remove";
    remove.type = "button";
    remove.textContent = t("removeTitle");
    remove.title = t("siteLibraryRemove", site);
    remove.setAttribute("aria-label", t("siteLibraryRemove", site));
    remove.addEventListener("click", safeAction(() => removeSite(site, excluded)));

    item.appendChild(name);
    item.appendChild(remove);
    list.appendChild(item);
  });
}

async function addSite(excluded = false) {
  const input = $(excluded ? "exclusionInput" : "siteInput");
  const status = excluded ? setExclusionStatus : setSiteLibraryStatus;
  const site = normalizeSite(input.value);
  input.setAttribute("aria-invalid", site ? "false" : "true");
  if (!site) {
    status(t("siteLibraryInvalid"));
    input.focus();
    return;
  }
  if (isDedicatedSite(site)) {
    status(t("siteLibraryDedicated"));
    input.focus();
    return;
  }

  const key = excluded ? "siteExclusions" : "siteLibrary";
  const next = await YTAPSettingsStore.updateList(key, (items) => {
    const library = normalizeSiteLibrary(items);
    if (library.some((rule) => siteMatchesHostname(site, rule))) return null;
    return normalizeSiteLibrary([...library, site]);
  });
  if (next === null) {
    status(t("siteLibraryDuplicate"));
    input.select();
    return;
  }

  if (normalizeSite(input.value) === site) input.value = "";
  input.setAttribute("aria-invalid", "false");
  renderSiteLibrary(next, excluded);
  status(t("siteLibraryAdded", site));
}

async function removeSite(site, excluded = false) {
  const next = await YTAPSettingsStore.updateList(excluded ? "siteExclusions" : "siteLibrary", (items) => normalizeSiteLibrary(items).filter((item) => item !== site));
  renderSiteLibrary(next, excluded);
  (excluded ? setExclusionStatus : setSiteLibraryStatus)(t("siteLibraryRemoved", site));
}

async function save(event) {
  // Write only the changed setting. Other open UI pages may have newer values
  // for unrelated flags, and a full reload can roll back a rapid second click.
  await settingsView.save(event.currentTarget.id, event.currentTarget.checked);
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
$("siteAddBtn").addEventListener("click", safeAction(() => addSite()));
$("exclusionAddBtn").addEventListener("click", safeAction(() => addSite(true)));
$("exclusionInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") safeAction(() => addSite(true))();
});
$("siteInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") safeAction(addSite)();
});
safeAction(load)();
