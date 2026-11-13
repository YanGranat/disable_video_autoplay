const assert = require("node:assert/strict");
const vm = require("node:vm");
const { test } = require("node:test");
const { runScripts } = require("./load_scripts.cjs");

function harness(pathname = "/watch", hostname = "www.youtube.com") {
  const roots = new Map();
  const context = vm.createContext({ URL, URLSearchParams });
  runScripts(context, ["vendor/domain-parser.js", "core/site-context.js", "core/settings.js", "adapters/youtube-channel.js"]);
  const read = vm.runInContext("YTAPYouTubeChannel.read", context);
  const location = { hostname, pathname, search: "?v=current" };
  const document = { querySelector: (s) => roots.get(s), querySelectorAll: (s) => roots.get(s) || [] };
  return { roots, location, read: () => read(document, location) };
}

test("desktop channel metadata must agree with both document and rendered video identity", () => {
  const h = harness();
  const owner = { navigationEndpoint: { browseEndpoint: { canonicalBaseUrl: "/@current" } } };
  const data = { currentVideoEndpoint: { watchEndpoint: { videoId: "current" } },
    contents: { twoColumnWatchNextResults: { results: { results: { contents: [{ videoSecondaryInfoRenderer: { owner: { videoOwnerRenderer: owner } } }] } } } } };
  let renderedId = "current";
  h.roots.set("ytd-watch-flexy", { data, getAttribute: () => renderedId,
    querySelector: () => ({ href: "https://www.youtube.com/@stale" }) });
  assert.equal(h.read().channel, "/@current");
  owner.navigationEndpoint.browseEndpoint.browseId = "UCEXAMPLE";
  assert.deepEqual(Array.from(h.read().aliases), ["/channel/ucexample"]);
  delete owner.navigationEndpoint.browseEndpoint.browseId;
  renderedId = "previous";
  assert.equal(h.read(), null);
  renderedId = "current";
  data.currentVideoEndpoint.watchEndpoint.videoId = "previous";
  assert.equal(h.read(), null);
  data.currentVideoEndpoint.watchEndpoint.videoId = "current";
  owner.navigationEndpoint.browseEndpoint.canonicalBaseUrl = "https://other.example/@current";
  assert.equal(h.read(), null);
});

test("mobile owner belongs to matching metadata rather than recommendations or an older component", () => {
  const h = harness("/watch", "m.youtube.com");
  const node = (id, channel) => ({ data: { videoId: id,
    contents: [{ slimOwnerRenderer: { navigationEndpoint: { browseEndpoint: { canonicalBaseUrl: channel } } } }] } });
  const current = node("current", "/@current");
  h.roots.set("ytm-slim-video-metadata-section-renderer", [node("previous", "/@previous"), current]);
  assert.equal(h.read().channel, "/@current");
  current.data.videoId = "previous";
  assert.equal(h.read(), null);
});

test("Shorts channel is scoped to its matching renderer", () => {
  const h = harness("/shorts/current");
  const node = (id) => ({ data: { command: { reelWatchEndpoint: { videoId: id } } },
    querySelector: () => ({ href: `https://www.youtube.com/@${id}` }) });
  h.roots.set("ytd-reel-video-renderer,ytm-reel-item-renderer", [node("previous"), node("current")]);
  assert.equal(h.read().channel, "/@current");
  h.location.pathname = "/shorts/absent";
  assert.equal(h.read(), null);
});

test("embedded channel lookup uses only player-owned links on a video document", () => {
  const h = harness("/embed/current");
  h.roots.set("embedded-player-video-details a.ytmVideoInfoChannelTitle[href],.ytp-title-channel a[href]", { href: "https://www.youtube.com/@current" });
  assert.equal(h.read().channel, "/@current");
  h.location.pathname = "/results";
  assert.equal(h.read(), null);
  h.location.pathname = "/embed/current";
  h.location.hostname = "youtube.com.example";
  assert.equal(h.read(), null);
});
