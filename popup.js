/* global $, YTAPSettings, YTAPSiteContext, YTAPSiteRules, YTAPSettingsStore, YTAPDiagnostics, YTAPStrings, YTAPChannelInput, resolveUiLanguage, makeTranslator, setSelectedUiLanguage, applyI18n, initLanguageDropdown, withUiErrorHandling, createStatusSetter, createSettingsView, applySettingsAvailability, preserveListFocus, finishSettingsLoad, createSiteRulesView, showSettingsError */

const { defaults: DEFAULTS, normalizeChannel } = YTAPSettings;
const { normalizeSite, normalizeSiteLibrary, isDedicatedSite } = YTAPSiteRules;
const { sanitizeDebugArgs } = YTAPDiagnostics;

let popupDebugEnabled = DEFAULTS.debug !== false;
const logPopup = (...args) => {
  if (!popupDebugEnabled) return;
  console.debug("%c[YT-AP POPUP]", "color:#ffb347;font-weight:700", ...sanitizeDebugArgs(args));
};

let currentLang = "en";
let t = makeTranslator(YTAPStrings, currentLang);
let currentSite = "";
let currentSiteRequestId = 0;
let currentSettings = { ...DEFAULTS };
let channelPending = false;
let channelPendingStatus = "statusAdding";
const safeAction = (action, errorId) => withUiErrorHandling(async (...args) => {
  try { return await action(...args); }
  finally { if (!document.documentElement.classList.contains("settings-loading")) applySettingsAvailability(currentSettings); }
}, (error, source) => recoverSettingsError(error, errorId ? $(errorId) : source));
const setStatus = createStatusSetter("status", 3500);
const settingsView = createSettingsView(renderSettings, recoverSettingsError);
const load = () => settingsView.load();
const siteRules = createSiteRulesView({ translate: () => t, reload: load, safeAction });

async function recoverSettingsError(error, source) {
  try { await load(); } catch { /* Storage may be unavailable, not merely full. */ }
  if (source?.id === "siteLibraryStatus") { siteRules.error(error); return; }
  if (source?.id === "channelInputError") setStatus("");
  if (source?.id === "status") setStatus("");
  showSettingsError(t, source);
  if (error?.code === "SETTINGS_ITEM_TOO_LARGE") {
    if (error.settingKey === "allowlist") {
      const message = $("channelInputError");
      message.setAttribute("data-i18n", "listFull");
      message.textContent = t("listFull");
      message.hidden = false;
      $("newItem").setAttribute("aria-invalid", "true");
    }
  }
}

async function renderSettings(data) {
  currentSettings = data;
  popupDebugEnabled = data.debug !== false;
  logPopup("load", data);

  const uiLanguage = data.uiLanguage || "auto";
  const language = resolveUiLanguage(uiLanguage);
  if (language !== currentLang) setStatus("");
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
  applyI18n(t);
  renderList(data.allowlist || []);
  siteRules.render(data);
  applySettingsAvailability(data);
  if (channelPending) setStatus(t(channelPendingStatus), { persistent: true });
  finishSettingsLoad();
  await renderCurrentSite(data);
}

async function renderCurrentSite(data) {
  const requestId = ++currentSiteRequestId;
  const card = $("currentSiteCard");
  const button = $("addCurrentSiteBtn");
  currentSite = "";
  button.disabled = true;
  const tab = await getActiveTab();
  if (requestId !== currentSiteRequestId) return;
  const url = tab?.url || "";
  const valid = /^https?:\/\//i.test(url);
  $("addCurrentBtn").hidden = !valid || YTAPSiteContext.platform(new URL(url).hostname) !== "youtube";
  const site = valid ? normalizeSite(url) : "";
  const saved = new Set([...normalizeSiteLibrary(data.siteLibrary), ...normalizeSiteLibrary(data.siteExclusions)]);
  card.hidden = !site || isDedicatedSite(site) || saved.has(site);
  if (card.hidden) return;
  currentSite = site;
  $("currentSiteHost").textContent = site;
  $("currentSiteHost").title = site;
  button.textContent = t("siteAddCurrent");
  button.disabled = !data.enabled || button.getAttribute("aria-busy") === "true";
}

function renderList(items) {
  const ul = $("list");
  const restoreFocus = preserveListFocus(ul, $("newItem"));
  ul.innerHTML = "";
  const cleaned = items.map(normalizeChannel).filter(Boolean);

  if (cleaned.length === 0) {
    ul.innerHTML = `<li class="empty-state">${t("emptyState")}</li>`;
    restoreFocus();
    return;
  }

  cleaned.forEach((item) => {
    const li = document.createElement("li");
    li.className = "channel-item";
    li.setAttribute("data-key", item);

    const span = document.createElement("span");
    span.textContent = decodeURIComponent(item);
    span.title = span.textContent;
    span.tabIndex = 0;

    const btn = document.createElement("button");
    btn.className = "btn-remove";
    btn.textContent = t("removeTitle");
    btn.title = t("removeTitle");
    btn.setAttribute("aria-label", `${t("removeTitle")}: ${item}`);
    btn.addEventListener("click", safeAction(async () => {
      await YTAPSettingsStore.updateList("allowlist", (items) => (items || []).map(normalizeChannel).filter((x) => x && x !== item));
      await load();
    }, "status"));

    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  });
  restoreFocus();
}

async function saveFlags(event) {
  // Capture currentTarget before awaiting: DOM events clear it after dispatch.
  const id = event.currentTarget.id;
  const payload = { [id]: event.currentTarget.checked };
  logPopup("saveFlags", payload);
  await settingsView.save(id, payload[id]);
}

async function addCurrentSite() {
  const site = currentSite;
  if (!site || isDedicatedSite(site)) return;
  await siteRules.addCurrent(site);
}

async function addItem() {
  if (channelPending) return;
  const input = $("newItem");
  const value = normalizeChannel(input.value);
  input.setAttribute("aria-invalid", value ? "false" : "true");
  $("channelInputError").hidden = !!value;
  $("channelInputError").setAttribute("data-i18n", "channelInputInvalid");
  $("channelInputError").textContent = value ? "" : t("channelInputInvalid");
  if (!value) {
    input.focus();
    return;
  }

  setChannelPending(true);
  setStatus(t("statusAdding"), { persistent: true });
  try {
    let resolved;
    try { resolved = await YTAPChannelInput.resolve(value); }
    catch {
      $("channelInputError").hidden = false;
      $("channelInputError").setAttribute("data-i18n", "channelResolveFailed");
      $("channelInputError").textContent = t("channelResolveFailed");
      setStatus("");
      return;
    }
    const next = await YTAPSettingsStore.updateList("allowlist", (items) => {
      const channels = (items || []).map(normalizeChannel).filter(Boolean);
      return channels.includes(resolved) ? null : [...new Set([...channels, resolved])];
    });
    if (normalizeChannel(input.value) === value) input.value = "";
    await load();
    setStatus(t(next === null ? "statusDuplicate" : "statusAdded", decodeURIComponent(resolved)));
    logPopup("allowlist:add", { channel: value });
  } finally {
    setChannelPending(false);
  }
}

function setChannelPending(pending, status = "statusAdding") {
  channelPending = pending;
  channelPendingStatus = status;
  for (const id of ["addBtn", "addCurrentBtn"]) $(id).setAttribute("aria-busy", String(pending));
  applySettingsAvailability(currentSettings);
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
  if (channelPending || $("addCurrentBtn").hidden) return;
  setChannelPending(true, "statusDetecting");
  setStatus(t("statusDetecting"), { persistent: true });

  try {
    const { channel, pageUrl, error } = await getChannelFromActiveTab();
    logPopup("allowlist:currentChannel", { channel, pageUrl, error });

    if (error) {
      setStatus(t("statusCantRead"));
      return;
    }

    const value = normalizeChannel(channel);
    if (!value) {
      setStatus(t("statusNotFound"));
      return;
    }

    const next = await YTAPSettingsStore.updateList("allowlist", (items) => {
      const channels = (items || []).map(normalizeChannel).filter(Boolean);
      return channels.includes(value) ? null : [...new Set([...channels, value])];
    });
    await load();

    setStatus(t(next === null ? "statusDuplicate" : "statusAllowlisted", channel));
  } finally {
    setChannelPending(false);
  }
}

$("enabled").addEventListener("change", safeAction(saveFlags));
$("applyToYouTube").addEventListener("change", safeAction(saveFlags));
$("applyToPlaylists").addEventListener("change", safeAction(saveFlags));
$("applyToShorts").addEventListener("change", safeAction(saveFlags));
$("applyToTwitch").addEventListener("change", safeAction(saveFlags));
$("applyToKick").addEventListener("change", safeAction(saveFlags));
$("applyToOtherSites").addEventListener("change", safeAction(saveFlags));
$("ignoreMiniplayer").addEventListener("change", safeAction(saveFlags));
$("addBtn").addEventListener("click", safeAction(addItem, "channelInputError"));
$("newItem").addEventListener("input", () => {
  $("newItem").setAttribute("aria-invalid", "false");
  $("channelInputError").hidden = true;
  $("channelInputError").textContent = "";
  $("channelInputError").removeAttribute("data-i18n");
});
$("addCurrentBtn").addEventListener("click", safeAction(addCurrentChannel, "status"));
$("addCurrentSiteBtn").addEventListener("click", safeAction(addCurrentSite, "siteLibraryStatus"));
$("newItem").addEventListener("keydown", (e) => {
  if (e.key === "Enter") safeAction(addItem, "channelInputError")();
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
