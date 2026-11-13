/**
 * UI-only helpers: translation, DOM updates, transient messages and errors.
 * Settings values, persistence and diagnostic privacy have separate owners.
 */
/* global YTAPSettingsStore, YTAPSettings */
/* exported resolveUiLanguage, makeTranslator, applyI18n, createStatusSetter, initLanguageDropdown, createSettingsView, applySettingsAvailability */

const $ = (id) => document.getElementById(id);

const UI_LANGUAGES = Object.freeze({
  de: "Deutsch",
  en: "English",
  es: "Español",
  ru: "Русский",
  uk: "Українська",
});

function detectBrowserLanguage() {
  try {
    const ui = (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || "";
    const language = ui.toLowerCase().split(/[-_]/)[0];
    if (Object.hasOwn(UI_LANGUAGES, language)) return language;
  } catch {
  }
  return "en";
}

function resolveUiLanguage(value) {
  if (!value || value === "auto") return detectBrowserLanguage();
  return Object.hasOwn(UI_LANGUAGES, value) ? value : "en";
}

function makeTranslator(strings, lang) {
  return (key, ...args) => {
    const dict = strings[lang] || strings.en;
    const v = dict[key] ?? strings.en[key] ?? "";
    return typeof v === "function" ? v(...args) : v;
  };
}

function setDropdownOpen(isOpen) {
  const dd = $("uiLanguageDropdown");
  const btn = $("uiLanguageBtn");
  if (!dd || !btn) return;
  dd.classList.toggle("open", isOpen);
  btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
}

function getUiLanguageLabel(value, t) {
  if (value === "auto") return t("languageAuto");
  return Object.hasOwn(UI_LANGUAGES, value) ? UI_LANGUAGES[value] : UI_LANGUAGES.en;
}

function setSelectedUiLanguage(value, t) {
  const v = value || "auto";
  const dd = $("uiLanguageDropdown");
  const labelEl = $("uiLanguageValue");
  if (dd) dd.setAttribute("data-value", v);
  if (labelEl) labelEl.textContent = getUiLanguageLabel(v, t);

  document.querySelectorAll("#uiLanguageMenu .menu-item").forEach((btn) => {
    const isSel = btn.getAttribute("data-value") === v;
    btn.setAttribute("aria-selected", isSel ? "true" : "false");
  });
}

function applyI18n(t) {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (!key) return;
    el.textContent = t(key);
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    if (!key) return;
    el.setAttribute("placeholder", t(key));
  });

  document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    const key = el.getAttribute("data-i18n-aria-label");
    if (!key) return;
    el.setAttribute("aria-label", t(key));
  });

  const dd = $("uiLanguageDropdown");
  if (dd) setSelectedUiLanguage(dd.getAttribute("data-value") || "auto", t);
}

// Each status area owns its timer; an old message must not clear a newer one.
function createStatusSetter(elementId, durationMs) {
  let timer = null;
  return (text) => {
    const element = $(elementId);
    if (!element) return;
    clearTimeout(timer);
    timer = null;
    element.textContent = text || "";
    if (!text) return;
    timer = setTimeout(() => {
      element.textContent = "";
      timer = null;
    }, durationMs);
  };
}

function initLanguageDropdown(reload, onError) {
  const dd = $("uiLanguageDropdown");
  const btn = $("uiLanguageBtn");
  const menu = $("uiLanguageMenu");
  if (!dd || !btn || !menu) return;

  const getItems = () => Array.from(menu.querySelectorAll(".menu-item"));
  const focusItem = (index) => {
    const items = getItems();
    if (items.length === 0) return;
    items[(index + items.length) % items.length].focus();
  };
  const openAndFocus = (preferLast = false) => {
    setDropdownOpen(true);
    const items = getItems();
    const selectedIndex = items.findIndex((item) => item.getAttribute("aria-selected") === "true");
    focusItem(selectedIndex >= 0 ? selectedIndex : preferLast ? items.length - 1 : 0);
  };

  btn.addEventListener("click", () => {
    setDropdownOpen(!dd.classList.contains("open"));
  });

  btn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    openAndFocus(e.key === "ArrowUp");
  });

  menu.addEventListener("click", withUiErrorHandling(async (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const item = target.closest(".menu-item");
    if (!item) return;
    const v = item.getAttribute("data-value") || "auto";
    dd.setAttribute("data-value", v);
    setDropdownOpen(false);
    await YTAPSettingsStore.write({ uiLanguage: v });
    await reload();
    btn.focus();
  }, onError));

  menu.addEventListener("keydown", (e) => {
    const items = getItems();
    const currentIndex = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      focusItem(currentIndex + (e.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      focusItem(e.key === "Home" ? 0 : items.length - 1);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setDropdownOpen(false);
      btn.focus();
    }
  });

  document.addEventListener("click", (e) => {
    if (!dd.classList.contains("open")) return;
    if (!(e.target instanceof Node)) return;
    if (!dd.contains(e.target)) setDropdownOpen(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setDropdownOpen(false);
  });
}

// EventTarget does not handle rejected async listeners. Keep failed storage
// operations visible without printing stored values or raw browser errors.
function withUiErrorHandling(action, onError) {
  return async (...args) => {
    const error = $("settingsError");
    if (error) error.hidden = true;
    try {
      return await action(...args);
    } catch {
      await onError();
    }
  };
}

// Storage events update the current view without replacing input drafts.
function createSettingsView(render, onError) {
  let data = { ...YTAPSettings.defaults };
  let revision = 0;
  const pending = new Map();
  const show = () => render({ ...data, ...Object.fromEntries([...pending].map(([key, entry]) => [key, entry.value])) });
  YTAPSettingsStore.subscribe((changes, area) => {
    if (area !== "sync") return;
    revision += 1;
    for (const [key, change] of Object.entries(changes)) {
      if (key in YTAPSettings.defaults) data[key] = change.newValue ?? YTAPSettings.defaults[key];
      if (pending.has(key)) pending.get(key).observed = true;
    }
    if (Object.keys(changes).some((key) => key in YTAPSettings.defaults && !pending.has(key))) {
      Promise.resolve(show()).catch(onError);
    }
  });
  return Object.freeze({
    async load() {
      const start = revision;
      const snapshot = await YTAPSettingsStore.read();
      if (start !== revision) return this.load();
      data = snapshot;
      await show();
    },
    async save(key, value) {
      const entry = { value };
      pending.set(key, entry);
      const painted = Promise.resolve(show()).catch(onError);
      try {
        await YTAPSettingsStore.write({ [key]: value });
        await painted;
        if (pending.get(key) === entry && !entry.observed) data[key] = value;
      } finally {
        if (pending.get(key) === entry) {
          pending.delete(key);
          if (entry.observed && data[key] !== value) await show();
        }
      }
    },
  });
}

function applySettingsAvailability(data) {
  const youtubeKeys = ["applyToShorts", "applyToPlaylists", "ignoreMiniplayer", "applyToEmbedded", "applyToMobile", "applyToChannelPlayer"];
  for (const key of YTAPSettings.mainKeys) {
    const input = $(key);
    if (!input || key === "enabled") continue;
    input.disabled = !data.enabled || (youtubeKeys.includes(key) && data.applyToYouTube === false)
      || (key === "resumeOnVisible" && !data.pauseOnHidden);
    input.closest?.(".row, .toggle-row")?.classList.toggle("is-disabled", input.disabled);
  }
  for (const id of ["newItem", "addBtn", "addCurrentBtn"]) {
    const input = $(id);
    if (input) input.disabled = !data.enabled || data.applyToYouTube === false;
  }
  for (const id of ["siteInput", "siteAddBtn", "exclusionInput", "exclusionAddBtn", "toggleCurrentSiteBtn"]) {
    const input = $(id);
    if (input) input.disabled = !data.enabled;
  }
  for (const button of document.querySelectorAll(".btn-remove")) button.disabled = !data.enabled || data.applyToYouTube === false;
  for (const button of document.querySelectorAll(".site-remove")) button.disabled = !data.enabled;
}
