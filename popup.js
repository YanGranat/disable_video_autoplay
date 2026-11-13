/* global $, YTAPSettings, YTAPSettingsStore, YTAPDiagnostics, YTAPStrings, YTAPChannelInput, detectBrowserLanguage, makeTranslator, setSelectedUiLanguage, applyI18n, initLanguageDropdown, withUiErrorHandling, createStatusSetter, createSettingsView, applySettingsAvailability */

const { defaults: DEFAULTS, normalizeChannel, normalizeSite, normalizeSiteLibrary, isDedicatedSite } = YTAPSettings;
const { sanitizeDebugArgs } = YTAPDiagnostics;

let popupDebugEnabled = DEFAULTS.debug !== false;
const logPopup = (...args) => {
  if (!popupDebugEnabled) return;
  console.debug("%c[YT-AP POPUP]", "color:#ffb347;font-weight:700", ...sanitizeDebugArgs(args));
};

let currentLang = "en";
let t = makeTranslator(YTAPStrings, currentLang);
let currentSite = "";
let currentSiteRule = { blocked: false };
let currentSiteRequestId = 0;
let currentSettings = { ...DEFAULTS };
const safeAction = (action) => withUiErrorHandling(async (...args) => {
  try { return await action(...args); }
  finally { applySettingsAvailability(currentSettings); }
}, recoverSettingsError);
const setStatus = createStatusSetter("status", 3500);
const setSiteStatus = createStatusSetter("siteStatus", 3500);
const settingsView = createSettingsView(renderSettings, recoverSettingsError);
const load = () => settingsView.load();

async function recoverSettingsError() {
  try { await load(); } catch { /* Storage may be unavailable, not merely full. */ }
  $("settingsError").textContent = t("settingsError");
  $("settingsError").hidden = false;
}

async function renderSettings(data) {
  currentSettings = data;
  popupDebugEnabled = data.debug !== false;
  logPopup("load", data);

  const uiLanguage = data.uiLanguage || "auto";
  const language = uiLanguage === "auto" ? detectBrowserLanguage() : uiLanguage;
  if (language !== currentLang) { setStatus(""); setSiteStatus(""); }
  currentLang = language;
  t = makeTranslator(YTAPStrings, currentLang);
  document.documentElement.lang = currentLang;
  document.title = t("title");

  setSelectedUiLanguage(uiLanguage, t);

  $("enabled").checked = !!data.enabled;
  $("applyToYouTube").checked = data.applyToYouTube !== false;
  $("applyToPlaylists").checked = !!data.applyToPlaylists;
  $("ignoreMiniplayer").checked = data.ignoreMiniplayer !== false;
  $("applyToShorts").checked = !!data.applyToShorts;
  $("applyToTwitch").checked = !!data.applyToTwitch;
  $("applyToKick").checked = !!data.applyToKick;
  $("applyToOtherSites").checked = data.applyToOtherSites !== false;
  $("debug").checked = !!data.debug;
  applyI18n(t);
  renderList(data.allowlist || []);
  applySettingsAvailability(data);
  await renderCurrentSite(data);
}

async function renderCurrentSite(data) {
  const requestId = ++currentSiteRequestId;
  const card = $("currentSiteCard");
  const titleEl = $("currentSiteTitle");
  const detailsEl = $("currentSiteDetails");
  const hostEl = $("currentSiteHost");
  const modeEl = $("currentSiteMode");
  const toggleBtn = $("toggleCurrentSiteBtn");
  const manageBtn = $("manageSiteLibraryBtn");
  const library = normalizeSiteLibrary(data.siteLibrary);

  currentSite = "";
  card.hidden = true;
  detailsEl.hidden = true;
  hostEl.textContent = t("currentSiteChecking");
  modeEl.textContent = "";
  toggleBtn.hidden = true;
  toggleBtn.disabled = true;
  manageBtn.textContent = t("manageSiteLibrary", library.length + normalizeSiteLibrary(data.siteExclusions).length);

  const tab = await getActiveTab();
  // A later refresh owns the card even if this tab lookup finishes last.
  if (requestId !== currentSiteRequestId) return;
  const tabUrl = tab?.url || "";
  if (!/^https?:\/\//i.test(tabUrl)) {
    titleEl.textContent = t("siteLibraryCardTitle");
    card.hidden = false;
    return;
  }

  currentSite = normalizeSite(tabUrl);
  if (!currentSite) {
    titleEl.textContent = t("siteLibraryCardTitle");
    card.hidden = false;
    return;
  }

  hostEl.textContent = currentSite;
  hostEl.title = currentSite;

  if (isDedicatedSite(currentSite)) {
    titleEl.textContent = t("siteLibraryCardTitle");
    card.hidden = false;
    return;
  }

  titleEl.textContent = t("currentSiteTitle");
  card.hidden = false;
  detailsEl.hidden = false;
  currentSiteRule = YTAPSettings.otherSiteRule(data, currentSite);
  if (data.enabled === false) {
    modeEl.textContent = t("currentSiteAllowed");
  } else if (currentSiteRule.source === "exclusion") {
    modeEl.textContent = t("currentSiteExcluded", currentSiteRule.rule);
  } else if (currentSiteRule.source === "library") {
    modeEl.textContent = t("currentSiteBlockedFromLibrary", currentSiteRule.rule);
  } else if (currentSiteRule.blocked) {
    modeEl.textContent = t("currentSiteBlockedGlobally");
  } else {
    modeEl.textContent = t("currentSiteAllowed");
  }

  toggleBtn.textContent = currentSiteRule.blocked ? t("disableCurrentSite")
    : currentSiteRule.source === "exclusion" ? t("removeSiteExclusion", currentSiteRule.rule) : t("enableCurrentSite");
  toggleBtn.hidden = false;
  toggleBtn.disabled = !data.enabled;
}

function renderList(items) {
  const ul = $("list");
  ul.innerHTML = "";
  const cleaned = items.map(normalizeChannel).filter(Boolean);

  if (cleaned.length === 0) {
    ul.innerHTML = `<li class="empty-state">${t("emptyState")}</li>`;
    return;
  }

  cleaned.forEach((item) => {
    const li = document.createElement("li");
    li.className = "channel-item";

    const span = document.createElement("span");
    span.textContent = decodeURIComponent(item);

    const btn = document.createElement("button");
    btn.className = "btn-remove";
    btn.textContent = t("removeTitle");
    btn.title = t("removeTitle");
    btn.setAttribute("aria-label", `${t("removeTitle")}: ${item}`);
    btn.addEventListener("click", safeAction(async () => {
      const next = await YTAPSettingsStore.updateList("allowlist", (items) => (items || []).map(normalizeChannel).filter((x) => x && x !== item));
      renderList(next);
    }));

    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

async function saveFlags(event) {
  // Capture currentTarget before awaiting: DOM events clear it after dispatch.
  const id = event.currentTarget.id;
  const payload = { [id]: event.currentTarget.checked };
  if (id === "debug") popupDebugEnabled = payload.debug;
  logPopup("saveFlags", payload);
  await settingsView.save(id, payload[id]);
}

async function toggleCurrentSite() {
  if (!currentSite || isDedicatedSite(currentSite)) return;

  const btn = $("toggleCurrentSiteBtn");
  btn.disabled = true;
  const site = currentSite;
  const blocked = !currentSiteRule.blocked;
  await YTAPSettingsStore.updateSites((data) => YTAPSettings.setSiteBlocking(data, site, blocked));
  await load();
  setSiteStatus(t("siteRuleSaved"));
}

async function addItem() {
  const input = $("newItem");
  const value = normalizeChannel(input.value);
  input.setAttribute("aria-invalid", value ? "false" : "true");
  $("channelInputError").hidden = !!value;
  $("channelInputError").textContent = value ? "" : t("channelInputInvalid");
  if (!value) {
    input.focus();
    return;
  }

  let resolved;
  try { resolved = await YTAPChannelInput.resolve(value); }
  catch {
    $("channelInputError").hidden = false;
    $("channelInputError").textContent = t("channelResolveFailed");
    return;
  }
  const next = await YTAPSettingsStore.updateList("allowlist", (items) => Array.from(new Set([...(items || []).map(normalizeChannel).filter(Boolean), resolved])));
  if (normalizeChannel($("newItem").value) === value) $("newItem").value = "";
  renderList(next);
  setStatus(t("statusAdded", decodeURIComponent(resolved)));
  logPopup("allowlist:add", { channel: value });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

async function getChannelFromActiveTab() {
  const tab = await getActiveTab();
  if (!tab?.id) return { channel: null, error: "No active tab" };

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "YTAP_GET_CHANNEL" }, { frameId: 0 });
    return { channel: res?.channel || null, pageUrl: res?.pageUrl || tab.url || null, error: res?.error || null };
  } catch (e) {
    return { channel: null, pageUrl: tab.url || null, error: "unavailable" };
  }
}

async function addCurrentChannel() {
  const btn = $("addCurrentBtn");
  btn.disabled = true;
  setStatus(t("statusDetecting"));

  const { channel, pageUrl, error } = await getChannelFromActiveTab();
  logPopup("allowlist:currentChannel", { channel, pageUrl, error });

  if (error) {
    setStatus(t("statusCantRead"));
    btn.disabled = false;
    return;
  }

  const value = normalizeChannel(channel);
  if (!value) {
    setStatus(t("statusNotFound"));
    btn.disabled = false;
    return;
  }

  const next = await YTAPSettingsStore.updateList("allowlist", (items) => Array.from(new Set([...(items || []).map(normalizeChannel).filter(Boolean), value])));
  renderList(next);

  setStatus(t("statusAllowlisted", channel));
  btn.disabled = false;
}

$("enabled").addEventListener("change", safeAction(saveFlags));
$("applyToYouTube").addEventListener("change", safeAction(saveFlags));
$("applyToPlaylists").addEventListener("change", safeAction(saveFlags));
$("applyToShorts").addEventListener("change", safeAction(saveFlags));
$("applyToTwitch").addEventListener("change", safeAction(saveFlags));
$("applyToKick").addEventListener("change", safeAction(saveFlags));
$("applyToOtherSites").addEventListener("change", safeAction(saveFlags));
$("ignoreMiniplayer").addEventListener("change", safeAction(saveFlags));
$("debug").addEventListener("change", safeAction(saveFlags));
$("addBtn").addEventListener("click", safeAction(addItem));
$("newItem").addEventListener("input", () => {
  $("newItem").setAttribute("aria-invalid", "false");
  $("channelInputError").hidden = true;
});
$("addCurrentBtn").addEventListener("click", safeAction(addCurrentChannel));
$("toggleCurrentSiteBtn").addEventListener("click", safeAction(toggleCurrentSite));
$("manageSiteLibraryBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("newItem").addEventListener("keydown", (e) => {
  if (e.key === "Enter") safeAction(addItem)();
});

(() => {
  const link = $("openOptions");
  if (!link) return;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();

initLanguageDropdown(load, recoverSettingsError);
safeAction(load)();
