const assert = require("node:assert/strict");
const vm = require("node:vm");
const { test } = require("node:test");
const { runScripts } = require("./load_scripts.cjs");

function uiContext(browserLanguage = "en") {
  const context = vm.createContext({ chrome: { i18n: { getUILanguage: () => browserLanguage } } });
  runScripts(context, ["shared.js"]);
  return context;
}

test("automatic UI language matches regional tags and falls back to English", () => {
  for (const [input, expected] of [
    ["de-DE", "de"], ["de_CH", "de"], ["ES-419", "es"], ["uk-UA", "uk"],
    ["ru-RU", "ru"], ["en-US", "en"], ["fr-FR", "fr"], ["fr-CA", "fr"], ["FR_ch", "fr"],
    ["it-IT", "en"], ["rubbish", "en"], ["", "en"],
  ]) {
    assert.equal(vm.runInContext('resolveUiLanguage("auto")', uiContext(input)), expected);
  }
  const unavailable = uiContext();
  vm.runInContext("chrome.i18n.getUILanguage = () => { throw Error('unavailable'); }", unavailable);
  assert.equal(vm.runInContext('resolveUiLanguage("auto")', unavailable), "en");
});

test("saved UI choices override the browser language without modifying the preference", () => {
  const context = uiContext("uk-UA");
  for (const language of ["de", "en", "es", "fr", "ru", "uk"]) {
    context.preference = language;
    assert.equal(vm.runInContext("resolveUiLanguage(preference)", context), language);
    assert.equal(context.preference, language);
  }
  assert.equal(vm.runInContext('resolveUiLanguage("unknown")', context), "en");
});

test("UI language labels use the same names as the supported language registry", () => {
  const context = uiContext();
  for (const [code, label] of Object.entries(vm.runInContext("UI_LANGUAGES", context))) {
    context.code = code;
    assert.equal(vm.runInContext("getUiLanguageLabel(code, () => 'Automatic')", context), label);
  }
  assert.equal(vm.runInContext("getUiLanguageLabel('auto', () => 'Automatic')", context), "Automatic");
  assert.equal(vm.runInContext("getUiLanguageLabel('constructor', () => 'Automatic')", context), "English");
});

for (const surface of ["popup", "options"]) {
  test(`${surface} translations preserve dynamic values and English fallback`, () => {
    const context = uiContext();
    runScripts(context, ["ui/site-rules-strings.js", `ui/${surface}-strings.js`]);
    const dictionaries = vm.runInContext("YTAPStrings", context);
    for (const [locale, dictionary] of Object.entries(dictionaries)) {
      for (const [key, value] of Object.entries(dictionary)) {
        if (typeof value !== "function") continue;
        const argument = key === "siteLibraryCount" || key === "manageSiteLibrary" ? 22 : "video.example";
        assert.ok(value(argument).includes(String(argument)), `${locale}/${key} must preserve its argument`);
      }
    }
    assert.equal(vm.runInContext('makeTranslator({ en: { text: "Fallback" }, es: {} }, "es")("text")', context), "Fallback");
    assert.equal(vm.runInContext('makeTranslator(YTAPStrings, "unknown")("subtitle")', context), dictionaries.en.subtitle);
  });
}

test("dependency guidance names the exact localized setting", () => {
  const context = uiContext();
  runScripts(context, ["ui/site-rules-strings.js", "ui/options-strings.js"]);
  const strings = vm.runInContext("YTAPStrings", context);
  for (const [locale, dictionary] of Object.entries(strings)) {
    assert.ok(dictionary.resumeRequirement.includes(dictionary.optPauseHidden), locale);
  }
});

test("shared website rules use the same translations on both settings surfaces", () => {
  const dictionaries = ["popup", "options"].map(surface => {
    const context = uiContext();
    runScripts(context, ["ui/site-rules-strings.js", `ui/${surface}-strings.js`]);
    return vm.runInContext("YTAPStrings", context);
  });
  for (const locale of Object.keys(dictionaries[0])) {
    for (const key of ["siteLibraryTitle", "siteAddCurrent", "siteDefaultHelp"]) {
      assert.equal(dictionaries[0][locale][key], dictionaries[1][locale][key], locale + "/" + key);
    }
  }
});
