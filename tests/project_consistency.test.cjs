const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { runScripts, contentScripts, uiScripts } = require("./load_scripts.cjs");
const { bundles, renderBundle } = require("../scripts/build.cjs");

const root = path.join(__dirname, "..");
const normalizeNewlines = (source) => source.replace(/\r\n?/g, "\n");
const read = (relativePath) => normalizeNewlines(fs.readFileSync(path.join(root, relativePath), "utf8"));

function matches(source, expression) {
  return Array.from(source.matchAll(expression), (match) => match[1]);
}

function decodeHtmlText(source) {
  return source
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

const modelContext = vm.createContext({ URL });
runScripts(modelContext, ["vendor/domain-parser.js", "core/site-context.js", "core/settings.js"]);
const model = vm.runInContext("YTAPSettings", modelContext);
for (const [input, expected] of [
  [" /@Example/videos/ ", "/@example"],
  ["/channel/UCEXAMPLE/streams", "/channel/ucexample"],
  ["/@example", "/@example"],
  ["", ""],
]) assert.equal(model.normalizeChannel(input), expected);
const defaults = model.defaults;
const contentExpected = { ...defaults };
delete contentExpected.uiLanguage;
assert.deepEqual(
  JSON.parse(JSON.stringify(model.contentDefaults)),
  JSON.parse(JSON.stringify(contentExpected)),
  "content defaults must derive from the canonical settings model"
);
assert.equal(defaults.debug, false, "debug diagnostics must remain opt-in by default");
assert.deepEqual(Object.keys(model.mainDefaults).sort(), ["settingsReady", ...model.mainKeys].sort());
for (const key of model.mainKeys) assert.equal(model.mainDefaults[key], defaults[key]);
assert.equal(model.mainDefaults.settingsReady, false, "MAIN must wait for persisted settings");

// A test must load the same dependency graph as the browser, in each world.
for (const world of ["MAIN", "ISOLATED"]) {
  const entry = world === "MAIN" ? "dist/main.js" : "dist/content.js";
  assert.deepEqual(contentScripts(world), [entry]);
  const files = bundles[entry];
  const policyIndex = files.indexOf("core/playback-policy.js");
  assert.ok(policyIndex > 0 && policyIndex < files.length - 1);
  assert.ok(files.includes("core/diagnostics.js"));
  assert.equal(files.includes("adapters/settings-store.js"), world === "ISOLATED");
  assert.equal(files.includes("adapters/player-dom.js"), world === "MAIN");
  assert.equal(files.includes("core/media-policy.js"), world === "MAIN");
  for (const file of files) assert.ok(fs.existsSync(path.join(root, file)), `missing ${file}`);
  assert.ok(read(entry) === renderBundle(files), `${entry} is stale; run node scripts/build.cjs`);
}
assert.equal(new Set([...contentScripts("MAIN"), ...contentScripts("ISOLATED")]).size, 2, "execution worlds need distinct entry paths");
for (const basename of ["popup", "options"]) {
  const files = uiScripts(basename);
  const diagnostics = basename === "popup" ? ["core/diagnostics.js"] : [];
  const inputAdapters = basename === "popup" ? ["adapters/channel-input.js"] : [];
  assert.deepEqual(files, ["vendor/domain-parser.js", "core/site-context.js", "core/settings.js", ...diagnostics, "adapters/settings-store.js", ...inputAdapters, "shared.js", `ui/${basename}-strings.js`, `${basename}.js`]);
}
for (const file of ["popup.js", "options.js", "shared.js", "content.js", "background.js"]) {
  assert.equal(/chrome\.storage/.test(read(file)), false, `${file} must use the storage adapter`);
}
for (const file of ["core/site-context.js", "core/settings.js", "core/diagnostics.js", "core/playback-policy.js", "core/media-policy.js"]) {
  assert.doesNotMatch(read(file), /\b(?:chrome|window|document|navigator|performance|Date)\s*\.|\b(?:setTimeout|setInterval|MutationObserver|HTMLMediaElement)\s*\(/, `${file} must not read browser state or perform effects`);
}

for (const basename of ["popup", "options"]) {
  const html = read(`${basename}.html`);
  const script = read(`${basename}.js`);
  const stringsContext = vm.createContext({});
  runScripts(stringsContext, [`ui/${basename}-strings.js`]);
  const strings = vm.runInContext("YTAPStrings", stringsContext);
  for (const [locale, dictionary] of Object.entries(strings)) {
    assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(strings.en).sort(), `${basename}/${locale} translation keys must match`);
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, typeof strings.en[key], `${basename}/${locale}/${key} translation type must match`);
      assert.equal(typeof (typeof value === "function" ? value(2) : value), "string");
      assert.ok((typeof value === "function" ? value(2) : value).trim(), `${basename}/${locale}/${key} must not be empty`);
    }
  }
  const languageContext = vm.createContext({});
  runScripts(languageContext, ["shared.js"]);
  const languages = vm.runInContext("Object.keys(UI_LANGUAGES)", languageContext);
  assert.deepEqual(Object.keys(strings).sort(), Array.from(languages).sort(), `${basename} dictionaries must cover each supported language`);
  const selectorValues = matches(html, /role="option"\s+data-value="([^"]+)"/g);
  assert.deepEqual(selectorValues, ["auto", ...languages], `${basename} language choices must match the supported languages`);
  assert.match(html, /<title>[^<]+<\/title>/, `${basename}.html needs a document title`);

  const htmlIds = new Set(matches(html, /\bid="([^"]+)"/g));
  const referencedIds = new Set(matches(script, /\$\("([^"]+)"\)/g));
  for (const id of referencedIds) {
    assert.ok(htmlIds.has(id), `${basename}.js references missing #${id}`);
  }

  const translationKeys = new Set(matches(html, /\bdata-i18n(?:-placeholder|-aria-label)?="([^"]+)"/g));
  for (const key of translationKeys) {
    assert.ok(Object.hasOwn(strings.en, key), `${basename}.html uses missing English translation ${key}`);
    for (const [locale, dictionary] of Object.entries(strings)) {
      assert.ok(Object.hasOwn(dictionary, key), `${basename}.html uses missing ${locale} translation ${key}`);
    }
  }

  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>([^<]*)<\/\1>/gi)) {
    const [, , key, fallbackText] = match;
    assert.equal(
      decodeHtmlText(fallbackText.trim()),
      strings.en[key],
      `${basename}.html fallback text for ${key} must match the English translation`
    );
  }

  for (const match of html.matchAll(/<[^>]*\bplaceholder="([^"]*)"[^>]*\bdata-i18n-placeholder="([^"]+)"[^>]*>/gi)) {
    const [, fallbackText, key] = match;
    assert.equal(
      decodeHtmlText(fallbackText),
      strings.en[key],
      `${basename}.html fallback placeholder for ${key} must match the English translation`
    );
  }

  const checkboxes = matches(html, /(<input\b[^>]*\btype="checkbox"[^>]*>)/g);
  for (const checkbox of checkboxes) {
    assert.match(checkbox, /\bdata-i18n-aria-label="[^"]+"/, `${basename} checkbox needs an accessible name: ${checkbox}`);
    const id = checkbox.match(/\bid="([^"]+)"/)[1];
    assert.match(html, new RegExp(`<label\\b[^>]*\\bfor="${id}"`), `${basename} switch text must activate #${id}`);
  }
}

const privacy = read("PRIVACY.md");
const storedSettingsSection = privacy.split("If Chrome Sync")[0];
const documentedSettings = new Set(matches(storedSettingsSection, /^- `([^`]+)`$/gm));
assert.deepEqual(documentedSettings, new Set(Object.keys(defaults)), "privacy policy must list every persisted setting exactly once");

const manifest = JSON.parse(read("manifest.json"));
const packageMetadata = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
assert.equal(packageMetadata.version, manifest.version);
assert.equal(lock.version, manifest.version);
assert.equal(lock.packages[""].version, manifest.version);
assert.ok(Number.parseInt(manifest.minimum_chrome_version, 10) >= 119, "related-frame injection through match_origin_as_fallback requires Chrome 119+");

const readme = read("README.md");
const readmeReferences = [
  ...matches(readme, /\]\(([^)\s]+)\)/g),
  ...matches(readme, /<img\b[^>]*\bsrc="([^"]+)"/g),
];
for (const reference of readmeReferences) {
  const target = reference.split("#")[0];
  if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
  assert.ok(fs.existsSync(path.join(root, target)), `README target must exist: ${target}`);
}

const localeEn = JSON.parse(read("_locales/en/messages.json"));
const manifestLocales = fs.readdirSync(path.join(root, "_locales")).sort();
const languageContext = vm.createContext({});
runScripts(languageContext, ["shared.js"]);
assert.deepEqual(manifestLocales, Array.from(vm.runInContext("Object.keys(UI_LANGUAGES)", languageContext)).sort());
for (const locale of manifestLocales) {
  const messages = JSON.parse(read(`_locales/${locale}/messages.json`));
  assert.deepEqual(Object.keys(messages).sort(), Object.keys(localeEn).sort(), `${locale} manifest keys must match`);
  for (const key of matches(JSON.stringify(manifest), /__MSG_([^_]+)__/g)) {
    assert.ok(messages[key]?.message?.trim(), `${locale} manifest locale is missing ${key}`);
  }
  assert.ok(messages.extensionDescription.message.length <= 132);
}

process.stdout.write("PASS project defaults, UI bindings, translations, privacy settings, version, and locales\n");
