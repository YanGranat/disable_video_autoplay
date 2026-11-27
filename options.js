/* global $, YTAPSettings, YTAPSiteRules, YTAPSettingsStore, YTAPStrings, resolveUiLanguage, makeTranslator, setSelectedUiLanguage, applyI18n, initLanguageDropdown, withUiErrorHandling, createStatusSetter, createSettingsView, applySettingsAvailability, preserveListFocus, finishSettingsLoad, showSettingsError */

const { normalizeSite, normalizeSiteLibrary, siteMatchesHostname, isDedicatedSite } = YTAPSiteRules;

let currentLang = "en";
let t = makeTranslator(YTAPStrings, currentLang);
let currentSettings = { ...YTAPSettings.defaults };
const removals = new Map();
const safeAction = (action, errorId) => withUiErrorHandling(async (...args) => {
  try { return await action(...args); }
  finally { if (!document.documentElement.classList.contains("settings-loading")) applySettingsAvailability(currentSettings); }
}, (error, source) => recoverSettingsError(error, errorId ? $(errorId) : source));
const setSiteLibraryStatus = createStatusSetter("siteLibraryStatus", 4000);
const setExclusionStatus = createStatusSetter("exclusionStatus", 4000);
const settingsView = createSettingsView(renderSettings, recoverSettingsError);
const load = () => settingsView.load();

async function recoverSettingsError(error, source) {
  try { await load(); } catch { /* Storage may be unavailable, not merely full. */ }
  if (source?.id === "siteLibraryStatus") setSiteLibraryStatus("");
  if (source?.id === "exclusionStatus") setExclusionStatus("");
  showSettingsError(t, source);
  if (error?.code === "SETTINGS_ITEM_TOO_LARGE") {
    const excluded = error.settingKey === "siteExclusions";
    (excluded ? setExclusionStatus : setSiteLibraryStatus)(t("listFull"), { persistent: true });
    $(excluded ? "exclusionInput" : "siteInput").setAttribute("aria-invalid", "true");
  }
}

function renderSettings(data) {
  currentSettings = data;
  const uiLanguage = data.uiLanguage || "auto";
  const language = resolveUiLanguage(uiLanguage);
  if (language !== currentLang) { setSiteLibraryStatus(""); setExclusionStatus(""); }
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
  renderSiteLibrary(data.siteLibrary);
  renderSiteLibrary(data.siteExclusions, true);
  $("resumeRequirement").hidden = !!data.pauseOnHidden;
  $("resumeOnVisible").setAttribute("aria-describedby", `resumeOnVisibleDescription resumeOnVisibleError${data.pauseOnHidden ? "" : " resumeRequirement"}`);
  $("extensionVersion").textContent = chrome.runtime.getManifest().version;
  for (const excluded of [false, true]) {
    const removal = removals.get(excluded);
    if (removal) $(excluded ? "exclusionUndoBtn" : "siteUndoBtn").setAttribute("aria-label", `${t("undoLabel")}: ${removal.site}`);
  }
  applySettingsAvailability(data);
  finishSettingsLoad();
}

function renderSiteLibrary(items, excluded = false) {
  const library = normalizeSiteLibrary(items);
  const list = $(excluded ? "exclusionList" : "siteLibraryList");
  const restoreFocus = preserveListFocus(list, $(excluded ? "exclusionInput" : "siteInput"));
  list.innerHTML = "";
  $(excluded ? "exclusionCount" : "siteCount").textContent = t("siteLibraryCount", library.length);
  const filter = $(excluded ? "exclusionFilter" : "siteFilter");
  filter.hidden = library.length === 0;
  const query = filter.value.trim().toLowerCase();
  const filtered = library.filter((site) => site.includes(query));

  if (filtered.length === 0) {
    const empty = document.createElement("li");
    empty.className = "site-empty";
    empty.textContent = t(library.length ? "siteSearchEmpty" : excluded ? "exclusionEmpty" : "siteLibraryEmpty");
    list.appendChild(empty);
    restoreFocus();
    return;
  }

  filtered.forEach((site) => {
    const item = document.createElement("li");
    item.className = "site-item";
    item.setAttribute("data-key", site);

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
    remove.addEventListener("click", safeAction(() => removeSite(site, excluded), excluded ? "exclusionStatus" : "siteLibraryStatus"));

    item.appendChild(name);
    item.appendChild(remove);
    list.appendChild(item);
  });
  restoreFocus();
}

async function addSite(excluded = false) {
  const input = $(excluded ? "exclusionInput" : "siteInput");
  const status = excluded ? setExclusionStatus : setSiteLibraryStatus;
  const site = normalizeSite(input.value);
  input.setAttribute("aria-invalid", site ? "false" : "true");
  if (!site) {
    status(t("siteLibraryInvalid"), { persistent: true });
    input.focus();
    return;
  }
  if (isDedicatedSite(site)) {
    input.setAttribute("aria-invalid", "true");
    status(t("siteLibraryDedicated"), { persistent: true });
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
    status(t("siteRuleDuplicate"));
    input.select();
    return;
  }

  if (normalizeSite(input.value) === site) input.value = "";
  input.setAttribute("aria-invalid", "false");
  clearUndo(excluded);
  $(excluded ? "exclusionFilter" : "siteFilter").value = "";
  $(excluded ? "exclusionCollection" : "siteCollection").open = true;
  await load();
  status(t("siteLibraryAdded", site));
}

async function removeSite(site, excluded = false) {
  const next = await YTAPSettingsStore.updateList(excluded ? "siteExclusions" : "siteLibrary", (items) => {
    const library = normalizeSiteLibrary(items);
    return library.includes(site) ? library.filter((item) => item !== site) : null;
  });
  if (next === null) return;
  removals.set(excluded, { site });
  $(excluded ? "exclusionUndoBtn" : "siteUndoBtn").hidden = false;
  await load();
  (excluded ? setExclusionStatus : setSiteLibraryStatus)(t("siteLibraryRemoved", site), { persistent: true });
}

function clearUndo(excluded) {
  removals.delete(excluded);
  $(excluded ? "exclusionUndoBtn" : "siteUndoBtn").hidden = true;
}

async function undoRemove(excluded) {
  const removal = removals.get(excluded);
  if (!removal || removal.pending) return;
  removal.pending = true;
  const button = $(excluded ? "exclusionUndoBtn" : "siteUndoBtn");
  const focused = document.activeElement === button;
  button.setAttribute("aria-busy", "true");
  applySettingsAvailability(currentSettings);
  try {
    const next = await YTAPSettingsStore.updateList(excluded ? "siteExclusions" : "siteLibrary", (items) => {
      const library = normalizeSiteLibrary(items);
      if (library.some((rule) => siteMatchesHostname(removal.site, rule))) return null;
      // A later, narrower rule is a new decision, not part of the old removal.
      if (library.some((rule) => siteMatchesHostname(rule, removal.site))) throw Object.assign(new Error("Related rules changed"), { code: "SITE_RULE_CHANGED" });
      return normalizeSiteLibrary([...library, removal.site]);
    });
    if (removals.get(excluded) === removal) clearUndo(excluded);
    await load();
    if (!removals.has(excluded)) (excluded ? setExclusionStatus : setSiteLibraryStatus)(t(next === null ? "siteRuleDuplicate" : "siteLibraryRestored", removal.site));
    if (focused && (document.activeElement === button || document.activeElement === document.body)) {
      const list = $(excluded ? "exclusionList" : "siteLibraryList");
      const row = Array.from(list.children).find(item => item.getAttribute("data-key") === removal.site);
      (row?.lastElementChild || $(excluded ? "exclusionInput" : "siteInput")).focus();
    }
  } catch (error) {
    if (error.code !== "SITE_RULE_CHANGED") throw error;
    if (removals.get(excluded) === removal) {
      clearUndo(excluded);
      (excluded ? setExclusionStatus : setSiteLibraryStatus)(t("siteUndoChanged"), { persistent: true });
    }
  } finally {
    removal.pending = false;
    button.setAttribute("aria-busy", "false");
  }
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
$("siteAddBtn").addEventListener("click", safeAction(() => addSite(), "siteLibraryStatus"));
$("exclusionAddBtn").addEventListener("click", safeAction(() => addSite(true), "exclusionStatus"));
$("exclusionInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") safeAction(() => addSite(true), "exclusionStatus")();
});
$("siteInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") safeAction(addSite, "siteLibraryStatus")();
});
for (const excluded of [false, true]) {
  const input = $(excluded ? "exclusionInput" : "siteInput");
  input.addEventListener("input", () => {
    input.setAttribute("aria-invalid", "false");
    (excluded ? setExclusionStatus : setSiteLibraryStatus)("");
  });
  $(excluded ? "exclusionFilter" : "siteFilter").addEventListener("input", () => renderSiteLibrary(currentSettings[excluded ? "siteExclusions" : "siteLibrary"], excluded));
  $(excluded ? "exclusionUndoBtn" : "siteUndoBtn").addEventListener("click", safeAction(() => undoRemove(excluded), excluded ? "exclusionStatus" : "siteLibraryStatus"));
}
const focusSection = () => {
  if (location.hash !== "#siteRules") return;
  $("siteRules").scrollIntoView({ block: "start" });
  $("siteRules").focus({ preventScroll: true });
};
window.addEventListener("hashchange", focusSection);
safeAction(async () => { await load(); focusSection(); })();
