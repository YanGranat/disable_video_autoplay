const assert = require("node:assert/strict");
const vm = require("node:vm");
const { test } = require("node:test");
const { runScripts } = require("./load_scripts.cjs");

function harness() {
  const requests = [];
  let ok = true;
  let vanity = "https://www.youtube.com/@example";
  let canonical = "https://www.youtube.com/channel/UCEXAMPLE";
  const html = () => `<script>var ytInitialData = ${JSON.stringify({ metadata: { channelMetadataRenderer: { vanityChannelUrl: vanity } } })};</script><link rel="canonical" href="${canonical}"><img src="https://assets.example/image.png">`;
  const context = vm.createContext({ URL, AbortSignal,
    fetch: async (url, options) => { requests.push({ url, options }); return { ok, url, text: async () => html() }; },
  });
  runScripts(context, ["vendor/domain-parser.js", "core/site-context.js", "core/settings.js", "adapters/channel-input.js"]);
  const adapter = vm.runInContext("YTAPChannelInput", context);
  return { adapter, requests, fail() { ok = false; }, canonicalOnly() { vanity = ""; }, invalid() { vanity = ""; canonical = "https://foreign.example/@unrelated"; } };
}

test("modern channel input is local; legacy resolution uses only public cookie-free requests", async () => {
  const h = harness();
  assert.equal(await h.adapter.resolve("@example"), "/@example");
  assert.equal(await h.adapter.resolve("https://foreign.example/c/example"), "");
  assert.equal(h.requests.length, 0);
  assert.equal(await h.adapter.resolve("youtube.com/c/Example"), "/@example");
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, "https://www.youtube.com/c/example");
  assert.equal(h.requests[0].options.credentials, "omit");
  assert.equal(h.requests[0].options.referrerPolicy, "no-referrer");
  h.canonicalOnly();
  assert.equal(await h.adapter.resolve("youtube.com/user/Example"), "/channel/ucexample");
});

test("unavailable or unrelated channel metadata does not create an exception", async () => {
  const h = harness();
  h.fail();
  await assert.rejects(h.adapter.resolve("youtube.com/c/example"), /channel-unavailable/);
  const invalid = harness();
  invalid.invalid();
  await assert.rejects(invalid.adapter.resolve("youtube.com/c/example"), /channel-unavailable/);
});
