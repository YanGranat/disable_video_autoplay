const assert = require("node:assert/strict");
const vm = require("node:vm");
const { test } = require("node:test");
const { runScripts } = require("./load_scripts.cjs");
const context = vm.createContext({ URL });
runScripts(context, ["vendor/domain-parser.js", "core/site-context.js", "core/settings.js"]);
const settings = vm.runInContext("YTAPSettings", context);

test("site rules require a valid host below a public or private suffix", () => {
  for (const raw of ["garbage!!", "com", "co.uk", "github.io", "a..com", "-a.com", "a-.com", "https://user:pass@example.com", "a".repeat(64) + ".com"]) {
    assert.equal(settings.normalizeSite(raw), "", raw);
  }
  for (const host of ["example.com", "example.co.uk", "sample.github.io", "www.co.uk", "www.ck", "localhost", "127.0.0.1", "[::1]", "example.test"]) {
    assert.equal(settings.normalizeSite(host), host, host);
  }
  assert.equal(settings.normalizeSite("https://www.Example.com./path"), "example.com");
  assert.equal(settings.normalizeSite("https://例え.jp/path"), "xn--r8jz45g.jp");
  assert.deepEqual(Array.from(settings.normalizeSiteLibrary(["com", "example.com", "co.uk", "example.co.uk"])), ["example.co.uk", "example.com"]);
});

test("channel inputs have bounded decoded segments and support legacy URLs", () => {
  for (const raw of ["@" + "a".repeat(31), "@" + "a".repeat(5000), "/@good%2fbad", "/c/good%2fbad", "/channel/" + "a".repeat(65)]) {
    assert.equal(settings.normalizeChannel(raw), "", raw.slice(0, 80));
  }
  assert.equal(settings.normalizeChannel("youtube.com/c/Пример"), "/c/%d0%9f%d1%80%d0%b8%d0%bc%d0%b5%d1%80");
  assert.equal(settings.normalizeChannel("youtube.com/user/Example/videos"), "/user/example");
  assert.ok(settings.normalizeChannel("@" + "a".repeat(30)));
});

test("site exclusions override global and selected-site coverage without affecting siblings", () => {
  const cfg = { applyToOtherSites: true, siteLibrary: ["example.com"], siteExclusions: ["media.example.com"] };
  assert.equal(settings.otherSiteRule(cfg, "media.example.com").blocked, false);
  assert.equal(settings.otherSiteRule(cfg, "cdn.media.example.com").blocked, false);
  assert.equal(settings.otherSiteRule(cfg, "other.example.com").blocked, true);
  const off = settings.setSiteBlocking(cfg, "other.example.com", false);
  assert.equal(settings.otherSiteRule({ ...cfg, ...off }, "other.example.com").blocked, false);
  assert.equal(settings.otherSiteRule({ ...cfg, ...off }, "third.example.com").blocked, true);
  const on = settings.setSiteBlocking({ ...cfg, applyToOtherSites: false }, "media.example.com", true);
  assert.equal(settings.otherSiteRule({ ...cfg, applyToOtherSites: false, ...on }, "media.example.com").blocked, true);
  assert.equal(settings.setSiteBlocking(cfg, "youtube.com", true), null);
});
