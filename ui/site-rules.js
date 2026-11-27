/* global $, YTAPSiteRules, YTAPSettingsStore, createStatusSetter, preserveListFocus, applySettingsAvailability */
/* exported createSiteRulesView */

function createSiteRulesView({ translate, reload, safeAction }) {
  const { normalizeSite, normalizeSiteLibrary, siteMatchesHostname, isDedicatedSite, otherSiteRule, setSiteBlocking } = YTAPSiteRules;
  const status = createStatusSetter("siteLibraryStatus", 4000);
  const input = $("siteInput");
  const list = $("siteLibraryList");
  const undoButton = $("siteUndoBtn");
  const pendingRules = new Map();
  let settings = { enabled: false };
  let language = "";
  let validation = null;
  let removal = null;
  let pendingAdd = false;
  const t = (key, ...args) => translate()(key, ...args);
  const keys = ["siteLibrary", "siteExclusions"];
  const entries = data => [...new Set(keys.flatMap(key => normalizeSiteLibrary(data[key])))].sort();

  function render(data) {
    settings = data;
    const nextLanguage = document.documentElement.lang;
    if (language !== nextLanguage) {
      language = nextLanguage;
      if (validation) status(t(validation.key, ...validation.args), { persistent: true });
      else if (removal) status(t("siteLibraryRemoved", removal.site), { persistent: true });
      else status("");
    }
    const sites = entries(data);
    const query = $("siteFilter").value.trim().toLowerCase();
    const visible = sites.filter(site => site.includes(query));
    const restoreFocus = preserveListFocus(list, input);
    list.innerHTML = "";
    for (const site of visible) {
      const row = document.createElement("li");
      row.className = "site-item";
      row.setAttribute("data-key", site);
      const name = document.createElement("span");
      name.className = "site-item-name";
      name.textContent = site;
      name.title = site;
      const toggle = document.createElement("label");
      toggle.className = "switch site-switch";
      toggle.title = t("siteCheckboxLabel", site);
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "site-blocking";
      checkbox.setAttribute("data-action", "blocking");
      checkbox.setAttribute("aria-label", t("siteCheckboxLabel", site));
      checkbox.setAttribute("aria-describedby", "siteLibraryStatus");
      checkbox.checked = pendingRules.has(site) ? pendingRules.get(site) : otherSiteRule(data, site).blocked;
      checkbox.setAttribute("aria-busy", String(pendingRules.has(site)));
      checkbox.setAttribute("aria-disabled", String(data.enabled === false || pendingRules.has(site)));
      checkbox.disabled = data.enabled === false;
      checkbox.addEventListener("change", safeAction(event => setBlocked(site, event.currentTarget.checked), "siteLibraryStatus"));
      const slider = document.createElement("span");
      slider.className = "slider";
      slider.setAttribute("aria-hidden", "true");
      toggle.appendChild(checkbox);
      toggle.appendChild(slider);
      const remove = document.createElement("button");
      remove.className = "site-remove";
      remove.type = "button";
      remove.setAttribute("data-action", "remove");
      remove.textContent = t("removeTitle");
      remove.title = t("siteLibraryRemove", site);
      remove.setAttribute("aria-label", remove.title);
      remove.disabled = data.enabled === false;
      remove.addEventListener("click", safeAction(() => removeSite(site), "siteLibraryStatus"));
      row.appendChild(name);
      row.appendChild(toggle);
      row.appendChild(remove);
      list.appendChild(row);
    }
    restoreFocus();
    $("siteCount").textContent = String(sites.length);
    $("siteFilter").hidden = sites.length === 0;
    $("siteEmpty").hidden = visible.length > 0;
    $("siteEmpty").textContent = t(sites.length ? "siteSearchEmpty" : "siteLibraryEmpty");
    undoButton.hidden = !removal;
    if (removal) undoButton.setAttribute("aria-label", t("undoLabel") + ": " + removal.site);
  }

  function clearUndo() { removal = null; undoButton.hidden = true; }
  function invalid(key, ...args) {
    validation = { key, args };
    status(t(key, ...args), { persistent: true });
    input.setAttribute("aria-invalid", "true");
    input.focus();
  }
  function setAdding(value) {
    pendingAdd = value;
    for (const id of ["siteAddBtn", "addCurrentSiteBtn"]) $(id)?.setAttribute("aria-busy", String(value));
    applySettingsAvailability(settings);
  }

  async function addSite(raw = input.value, fromInput = true) {
    if (pendingAdd || settings.enabled === false) return;
    const site = normalizeSite(raw);
    if (!site) return invalid("siteLibraryInvalid");
    if (isDedicatedSite(site)) return invalid("siteLibraryDedicated");
    setAdding(true);
    input.setAttribute("aria-invalid", "false");
    validation = null;
    try {
      const next = await YTAPSettingsStore.updateSites(data => {
        if (entries(data).includes(site)) return null;
        const inheritedException = normalizeSiteLibrary(data.siteExclusions).some(rule => siteMatchesHostname(site, rule));
        return setSiteBlocking(data, site, !inheritedException);
      });
      if (next === null) { status(t("siteRuleDuplicate")); return; }
      if (fromInput && normalizeSite(input.value) === site) input.value = "";
      clearUndo();
      $("siteFilter").value = "";
      await reload();
      status(t("siteLibraryAdded", site));
    } catch (error) {
      error.uiAction = "site-add";
      throw error;
    } finally { setAdding(false); }
  }

  async function setBlocked(site, blocked) {
    if (settings.enabled === false) return;
    if (pendingRules.has(site)) { render(settings); return; }
    pendingRules.set(site, blocked);
    render(settings);
    try {
      const next = await YTAPSettingsStore.updateSites(data => entries(data).includes(site) ? setSiteBlocking(data, site, blocked) : null);
      if (next !== null) clearUndo();
      if (!validation) status("");
    } catch (error) {
      if (error.code !== "SITE_PARENT_EXCEPTION") throw error;
      validation = { key: "siteParentException", args: [error.site] };
      status(t(validation.key, ...validation.args), { persistent: true });
    } finally {
      pendingRules.delete(site);
      await reload();
    }
  }

  async function removeSite(site) {
    if (settings.enabled === false) return;
    let entry;
    const next = await YTAPSettingsStore.updateSites(data => {
      const present = keys.filter(key => normalizeSiteLibrary(data[key]).includes(site));
      if (!present.length) return null;
      entry = { site, keys: present };
      return Object.fromEntries(keys.map(key => [key, normalizeSiteLibrary(data[key]).filter(rule => rule !== site)]));
    });
    if (next === null) return;
    removal = entry;
    await reload();
    if (removal === entry) status(t("siteLibraryRemoved", site), { persistent: true });
  }

  async function undoRemove() {
    const entry = removal;
    if (!entry || entry.pending || settings.enabled === false) return;
    entry.pending = true;
    const focused = document.activeElement === undoButton;
    undoButton.setAttribute("aria-busy", "true");
    applySettingsAvailability(settings);
    try {
      const next = await YTAPSettingsStore.updateSites(data => {
        if (entries(data).includes(entry.site)) return null;
        if (entries(data).some(rule => siteMatchesHostname(rule, entry.site))) {
          throw Object.assign(new Error("Related rules changed"), { code: "SITE_RULE_CHANGED" });
        }
        return Object.fromEntries(entry.keys.map(key => [key, normalizeSiteLibrary([...normalizeSiteLibrary(data[key]), entry.site])]));
      });
      if (removal === entry) clearUndo();
      await reload();
      if (!removal) status(t(next === null ? "siteRuleDuplicate" : "siteLibraryRestored", entry.site));
      if (focused && (document.activeElement === undoButton || document.activeElement === document.body)) {
        const row = Array.from(list.children).find(item => item.getAttribute("data-key") === entry.site);
        (row?.lastElementChild || input).focus();
      }
    } catch (error) {
      if (error.code !== "SITE_RULE_CHANGED") throw error;
      if (removal === entry) { clearUndo(); status(t("siteUndoChanged"), { persistent: true }); }
    } finally {
      entry.pending = false;
      undoButton.setAttribute("aria-busy", "false");
      applySettingsAvailability(settings);
    }
  }

  function clearValidation() {
    validation = null;
    input.setAttribute("aria-invalid", "false");
    if (removal) status(t("siteLibraryRemoved", removal.site), { persistent: true });
    else status("");
  }
  input.addEventListener("input", clearValidation);
  input.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    return safeAction(() => addSite(), "siteLibraryStatus")();
  });
  $("siteAddBtn").addEventListener("click", safeAction(() => addSite(), "siteLibraryStatus"));
  $("siteFilter").addEventListener("input", () => render(settings));
  undoButton.addEventListener("click", safeAction(undoRemove, "siteLibraryStatus"));
  return Object.freeze({
    render,
    addCurrent: site => addSite(site, false),
    error(error) {
      status("");
      const key = error?.code === "SETTINGS_ITEM_TOO_LARGE" ? "listFull" : "settingsError";
      if (error?.uiAction === "site-add") invalid(key);
      else { validation = { key, args: [] }; status(t(key), { persistent: true }); }
    },
  });
}
