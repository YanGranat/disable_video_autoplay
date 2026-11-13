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
    ["ru-RU", "ru"], ["en-US", "en"], ["fr-FR", "en"], ["rubbish", "en"], ["", "en"],
  ]) {
    assert.equal(vm.runInContext('resolveUiLanguage("auto")', uiContext(input)), expected);
  }
  const unavailable = uiContext();
  vm.runInContext("chrome.i18n.getUILanguage = () => { throw Error('unavailable'); }", unavailable);
  assert.equal(vm.runInContext('resolveUiLanguage("auto")', unavailable), "en");
});

test("saved UI choices override the browser language without modifying the preference", () => {
  const context = uiContext("uk-UA");
  for (const language of ["de", "en", "es", "ru", "uk"]) {
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
    runScripts(context, [`ui/${surface}-strings.js`]);
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

test("website counters select singular, plural and Ukrainian count forms", () => {
  const context = uiContext();
  runScripts(context, ["ui/options-strings.js"]);
  const strings = vm.runInContext("YTAPStrings", context);
  assert.equal(strings.de.siteLibraryCount(1), "1 Website");
  assert.equal(strings.de.siteLibraryCount(2), "2 Websites");
  assert.equal(strings.es.siteLibraryCount(1), "1 sitio");
  assert.equal(strings.es.siteLibraryCount(2), "2 sitios");
  for (const [count, noun] of [[0, "сайтів"], [1, "сайт"], [2, "сайти"], [5, "сайтів"], [11, "сайтів"], [12, "сайтів"], [21, "сайт"], [22, "сайти"], [25, "сайтів"], [111, "сайтів"]]) {
    assert.equal(strings.uk.siteLibraryCount(count), `${count} ${noun}`);
  }
});
