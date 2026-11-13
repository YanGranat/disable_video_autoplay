const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { runScripts } = require("./load_scripts.cjs");

const context = vm.createContext({ URL, URLSearchParams });
runScripts(context, ["core/site-context.js", "adapters/page-context.js"]);
const sites = vm.runInContext("YTAPSiteContext", context);
const pages = vm.runInContext("YTAPPageContext", context);
function page(url, { referrer = "", ancestors = [], embedded = false, parent = null } = {}) {
  const parsed = new URL(url);
  const location = { hostname: parsed.hostname, pathname: parsed.pathname, search: parsed.search, hash: parsed.hash, ancestorOrigins: ancestors };
  const document = Object.defineProperty({}, "referrer", { value: referrer, enumerable: true });
  const window = {};
  window.parent = parent || window;
  window.top = embedded ? {} : window;
  return { location, document, window, page: pages.create({ location, document, window }) };
}

test("platform classification respects hostname boundaries without call-context requirements", () => {
  const { platform } = sites;
  for (const [host, expected] of [
    ["youtube.com", "youtube"], ["m.youtube.com", "youtube"], ["www.youtube-nocookie.com", "youtube"],
    ["twitch.tv", "twitch"], ["player.twitch.tv", "twitch"], ["kick.com", "kick"], ["sub.kick.com", "kick"],
    ["notyoutube.com", "other"], ["kick.com.example", "other"], ["", "other"],
  ]) assert.equal(platform(host), expected, host);
});

test("media route identity excludes dedicated-site UI parameters but includes generic query and hash", () => {
  const yt = page("https://www.youtube.com/watch?v=one&list=queue&index=1");
  const before = yt.page.currentRouteKey();
  const navBefore = yt.page.currentNavKey();
  yt.location.search = "?list=queue&v=one&index=2&t=50";
  assert.equal(yt.page.currentRouteKey(), before);
  assert.equal(yt.page.currentNavKey(), navBefore);
  yt.location.search = "?v=two&list=queue";
  assert.notEqual(yt.page.currentRouteKey(), before);
  assert.equal(yt.page.currentYouTubeVideoId(), "two");
  for (const host of ["twitch.tv", "kick.com"]) {
    const channel = page(`https://${host}/stream?ui=one`);
    const key = channel.page.currentRouteKey();
    channel.location.search = "?ui=two";
    assert.equal(channel.page.currentRouteKey(), key);
    channel.location.pathname = "/another-stream";
    assert.notEqual(channel.page.currentRouteKey(), key);
  }
  const generic = page("https://video.example/watch?episode=1#part1");
  const key = generic.page.currentRouteKey();
  const nav = generic.page.currentNavKey();
  generic.location.hash = "#part2";
  assert.notEqual(generic.page.currentRouteKey(), key);
  assert.equal(generic.page.currentNavKey(), nav);
  generic.location.search = "?episode=2";
  assert.notEqual(generic.page.currentNavKey(), nav);
});

test("related frame origin fallback is separate from top-level library scope", () => {
  const frame = page("about:blank", {
    referrer: "https://kick.com/stream", ancestors: ["https://kick.com", "https://library.example"], embedded: true,
  });
  assert.equal(frame.page.isKickHost(), true);
  assert.equal(frame.page.currentRouteKey(), "kick.com/stream");
  assert.equal(frame.page.getSiteScopeHostname(), "library.example");
  assert.equal(frame.page.isEmbeddedContext(), true);
  const invalid = page("about:blank", { referrer: "invalid", ancestors: ["https://kick.com"] });
  assert.equal(invalid.page.currentRouteKey(), "kick.com/");
  invalid.location.ancestorOrigins = [];
  assert.equal(invalid.page.getRuntimeHostname(), "");
  const own = page("https://video.example/watch", { referrer: "https://kick.com/stream" });
  assert.equal(own.page.isOtherSite(), true);
});

test("retained related frames follow accessible owner navigation without changing referrer", () => {
  for (const [initial, next, expected] of [
    ["https://kick.com/channel-a", "https://kick.com/channel-b", "kick.com/channel-b"],
    ["https://www.twitch.tv/channel-a", "https://www.twitch.tv/channel-b", "www.twitch.tv/channel-b"],
    ["https://video.example/watch?episode=1#one", "https://video.example/watch?episode=2#two", "video.example/watch?episode=2#two"],
    ["https://www.youtube.com/watch?v=one&list=queue&index=1", "https://www.youtube.com/watch?v=two&list=queue&index=2", "www.youtube.com/watch?v=two&list=queue"],
  ]) {
    const parent = { location: new URL(initial) };
    parent.parent = parent;
    const child = page("about:blank", { referrer: initial, parent, embedded: true });
    assert.equal(child.page.getRuntimeLocation().ownerSource, "ancestor");
    const before = child.page.currentRouteKey();
    parent.location.href = next;
    assert.equal(child.document.referrer, initial);
    assert.equal(child.page.currentRouteKey(), expected);
    assert.notEqual(child.page.currentRouteKey(), before);
    assert.equal(child.page.currentNavKey(), "blank");
    parent.location.href = initial;
    assert.equal(child.page.currentRouteKey(), before);
  }
});

test("owner lookup traverses related ancestors and tolerates inaccessible windows", () => {
  const owner = { location: new URL("https://video.example/watch?episode=2") };
  owner.parent = owner;
  const intermediate = { location: new URL("about:blank"), parent: owner };
  const nested = page("about:blank", { parent: intermediate, embedded: true });
  assert.equal(nested.page.currentRouteKey(), "video.example/watch?episode=2");
  const blocked = { get location() { throw new Error("unreadable"); } };
  blocked.parent = blocked;
  const fallback = page("about:blank", { parent: blocked, referrer: "https://kick.com/channel-a" });
  assert.equal(fallback.page.currentRouteKey(), "kick.com/channel-a");
  assert.equal(fallback.page.getRuntimeLocation().ownerSource, "referrer");
  const own = page("https://video.example/watch", { parent: owner, referrer: "https://kick.com/channel-a" });
  assert.equal(own.page.currentRouteKey(), "video.example/watch");
  assert.equal(own.page.getRuntimeLocation().ownerSource, "document");
});

test("coverage observations distinguish document paths from inherited routes", () => {
  for (const [url, facts] of [
    ["https://m.youtube.com/shorts/one", { mobile: true, shorts: true, videoPage: true }],
    ["https://www.youtube.com/embed/one", { embedded: true, videoPage: false }],
    ["https://www.youtube-nocookie.com/watch?v=one", { embedded: true, videoPage: true }],
    ["https://www.youtube.com/@channel/videos", { channelPage: true, videoPage: false }],
    ["https://www.youtube.com/watch?v=one&list=queue", { playlist: true, videoPage: true }],
  ]) {
    const actual = page(url).page.coverageFacts(true);
    for (const [key, value] of Object.entries(facts)) assert.equal(actual[key], value, key);
    assert.equal(actual.manualPlaylist, true);
  }
  const related = page("about:blank", { referrer: "https://www.youtube.com/watch?v=one&list=queue" });
  assert.equal(related.page.coverageFacts(false).videoPage, false);
  assert.equal(related.page.coverageFacts(false).playlist, false);
});
