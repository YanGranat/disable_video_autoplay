const assert = require("node:assert/strict");
const vm = require("node:vm");
const { test, after } = require("node:test");
const { runScripts, contentScripts } = require("./load_scripts.cjs");
const timers = new Set();
after(() => { for (const timer of timers) clearTimeout(timer); });

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener));
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) {
      listener.call(this, event);
    }
    return true;
  }
}

class FakeCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

function createHarness({
  hostname = "www.youtube.com",
  pathname = "/watch",
  search = "?v=one&list=PL1",
  referrer = "",
  ancestorOrigins = [],
  settings = {},
  settingsProvider = null,
  channelHref = null,
} = {}) {
  const windowTarget = new FakeEventTarget();
  windowTarget.top = windowTarget;

  const commands = [];
  const logs = [];
  for (const type of ["ytap-arm", "ytap-disarm", "ytap-resume", "ytap-config"]) {
    windowTarget.addEventListener(type, (event) => commands.push({ type, detail: event.detail }));
  }

  const documentTarget = {
    readyState: "complete",
    referrer,
    querySelector: (selector) => selector === "ytd-watch-flexy" ? {
      getAttribute: () => new URLSearchParams(search).get("v"),
      querySelector: () => channelHref ? { href: channelHref } : null,
    } : null,
    querySelectorAll: () => [],
  };
  const location = {
    hostname,
    pathname,
    search,
    hash: "",
    origin: hostname ? `https://${hostname}` : "null",
    href: hostname ? `https://${hostname}${pathname}${search}` : "about:blank",
    ancestorOrigins,
  };

  const defaults = {
    enabled: true,
    applyToYouTube: true,
    applyToShorts: false,
    applyToChannelPlayer: true,
    applyToMobile: false,
    applyToTwitch: false,
    applyToKick: false,
    applyToOtherSites: true,
    siteLibrary: [],
    applyToEmbedded: true,
    applyToPlaylists: false,
    stopInsteadOfPause: false,
    ignoreMiniplayer: true,
    pauseOnHidden: false,
    resumeOnVisible: false,
    allowlist: [],
    debug: false,
  };
  const storedSettings = { ...defaults, ...settings };

  let messageListener;
  let polling = false;
  const pendingTimers = new Map();
  const chrome = {
    runtime: {
      getManifest: () => ({ version: "test" }),
      onMessage: { addListener(listener) { messageListener = listener; } },
    },
    storage: {
      sync: { get: async () => settingsProvider ? settingsProvider() : ({ ...storedSettings }) },
      onChanged: { addListener() {} },
    },
  };

  const context = vm.createContext({
    chrome,
    console: {
      log: (...args) => logs.push(args),
      info: (...args) => logs.push(args),
      error: (...args) => logs.push(args),
    },
    CustomEvent: FakeCustomEvent,
    document: documentTarget,
    location,
    URL,
    URLSearchParams,
    window: windowTarget,
    setTimeout(callback, delay) {
      const timer = setTimeout(() => { pendingTimers.delete(timer); callback(); }, delay);
      timers.add(timer);
      pendingTimers.set(timer, callback);
      return timer;
    },
    clearTimeout,
    setInterval: () => { polling = true; return 1; },
    clearInterval: () => { polling = false; },
  });

  runScripts(context, ["vendor/domain-parser.js", "core/site-context.js", "core/settings.js", "adapters/youtube-channel.js"]);
  vm.runInContext("YTAPYouTubeChannel.install({ window, document, location, CustomEvent })", context);
  runScripts(context, contentScripts("ISOLATED"));

  return {
    commands, document: documentTarget, location, logs, window: windowTarget,
    requestChannel: () => new Promise((resolve) => messageListener({ type: "YTAP_GET_CHANNEL" }, {}, resolve)),
    isPolling: () => polling,
    runPendingTimers() {
      for (const [timer, callback] of Array.from(pendingTimers)) {
        clearTimeout(timer);
        pendingTimers.delete(timer);
        timers.delete(timer);
        callback();
      }
    },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function lastScopeCommand(commands) {
  return commands.filter(({ type }) => type === "ytap-arm" || type === "ytap-disarm").at(-1)?.type;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("isolated navigation preserves scope, channel ownership and the newest settings read", async () => {
  for (const [pathname, expected] of [["/@example/videos", "/@example"], ["/channel/UCEXAMPLE/streams", "/channel/ucexample"]]) {
    const channelPage = createHarness({ pathname, search: "", channelHref: "https://www.youtube.com/@unrelated", settings: { allowlist: [expected] } });
    await settle();
    assert.equal((await channelPage.requestChannel()).channel, expected, "channel tabs must resolve to their canonical channel, not a recommended channel");
    assert.equal(lastScopeCommand(channelPage.commands), "ytap-disarm", "a allowlisted channel page must use the channel from its URL");
  }
  const foreignChannel = createHarness({ hostname: "other.example", pathname: "/@example", search: "", channelHref: "https://www.youtube.com/@example" });
  await settle();
  assert.equal((await foreignChannel.requestChannel()).channel, null, "a non-YouTube page cannot supply the current YouTube channel");
  const foreignOwner = createHarness({ channelHref: "https://other.example/@example", settings: { allowlist: ["/@example"] } });
  await settle();
  assert.equal(lastScopeCommand(foreignOwner.commands), "ytap-arm", "a foreign owner link must not unlock a YouTube video");

  const playlist = createHarness();
  await settle();
  assert.equal(lastScopeCommand(playlist.commands), "ytap-arm", "initial playlist navigation must block autoplay");
  assert.equal(playlist.logs.length, 0, "debug logging must remain opt-in");

  const diagnostics = createHarness({
    settings: {
      debug: true,
      allowlist: ["/@private-channel"],
      siteLibrary: ["private.example"],
    },
  });
  await settle();
  assert.ok(
    diagnostics.logs.some((args) => args.includes("vtest")),
    "copied ISOLATED logs must expose the running content-script version as plain text"
  );
  const diagnosticText = diagnostics.logs
    .map((args) => args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
    .join("\n");
  assert.doesNotMatch(
    diagnosticText,
    /private-channel|private\.example|https:\/\/|\?v=one|list=PL1/,
    "copied ISOLATED logs must redact URLs, page media identifiers, channels, and stored site rules"
  );
  assert.match(
    diagnosticText,
    /playlist navigation classified source=immediate .*manualRoute=true/,
    "copied ISOLATED logs must expose playlist decisions as plain text"
  );

  playlist.commands.length = 0;
  playlist.location.search = "?v=one&list=PL1&index=2";
  playlist.location.href = `https://${playlist.location.hostname}${playlist.location.pathname}${playlist.location.search}`;
  playlist.window.dispatchEvent(new FakeCustomEvent("yt-navigate-finish"));
  await settle();
  assert.equal(
    lastScopeCommand(playlist.commands),
    undefined,
    "an index-only playlist URL update must preserve the initial autoplay block"
  );

  playlist.commands.length = 0;
  playlist.location.search = "?v=two&list=PL1";
  playlist.location.href = `https://${playlist.location.hostname}${playlist.location.pathname}${playlist.location.search}`;
  playlist.window.dispatchEvent(new FakeCustomEvent("yt-navigate-finish"));
  await settle();
  assert.equal(lastScopeCommand(playlist.commands), "ytap-disarm", "playlist auto-next must stay allowed without a recent user gesture");

  playlist.commands.length = 0;
  playlist.window.dispatchEvent(new FakeCustomEvent("ytap-gesture", { detail: { ts: Date.now() } }));
  playlist.location.search = "?v=three&list=PL1";
  playlist.location.href = `https://${playlist.location.hostname}${playlist.location.pathname}${playlist.location.search}`;
  playlist.window.dispatchEvent(new FakeCustomEvent("yt-navigate-finish"));
  await settle();
  assert.equal(
    lastScopeCommand(playlist.commands),
    "ytap-disarm",
    "a recent player or page gesture must not turn playlist auto-next into a manual navigation"
  );

  playlist.commands.length = 0;
  playlist.window.dispatchEvent(new FakeCustomEvent("ytap-gesture", {
    detail: { ts: Date.now(), youtubeNavigationVideoId: "four" },
  }));
  playlist.location.search = "?v=four&list=PL1";
  playlist.location.href = `https://${playlist.location.hostname}${playlist.location.pathname}${playlist.location.search}`;
  playlist.window.dispatchEvent(new FakeCustomEvent("yt-navigate-finish"));
  await settle();
  assert.equal(lastScopeCommand(playlist.commands), "ytap-arm", "a matching manual playlist selection must still block autoplay");

  playlist.commands.length = 0;
  playlist.window.dispatchEvent(new FakeCustomEvent("ytap-gesture", {
    detail: { ts: Date.now(), youtubeNavigationVideoId: "different-video" },
  }));
  playlist.location.search = "?v=five&list=PL1";
  playlist.location.href = `https://${playlist.location.hostname}${playlist.location.pathname}${playlist.location.search}`;
  playlist.window.dispatchEvent(new FakeCustomEvent("yt-navigate-finish"));
  await settle();
  assert.equal(lastScopeCommand(playlist.commands), "ytap-disarm", "a navigation intent for another video must not unlock playlist auto-next");

  const relatedKick = createHarness({
    hostname: "",
    pathname: "blank",
    search: "",
    referrer: "https://kick.com/channel-a",
    ancestorOrigins: ["https://kick.com"],
    settings: { applyToKick: false, applyToOtherSites: true },
  });
  await settle();
  assert.equal(lastScopeCommand(relatedKick.commands), "ytap-disarm", "a related Kick frame must use the Kick switch instead of generic-site coverage");

  const firstSettingsRead = deferred();
  const secondSettingsRead = deferred();
  let settingsReadCount = 0;
  const overlappingNavigation = createHarness({
    settingsProvider: () => settingsReadCount++ === 0 ? firstSettingsRead.promise : secondSettingsRead.promise,
  });
  overlappingNavigation.location.search = "?v=two&list=PL1";
  overlappingNavigation.location.href = `https://${overlappingNavigation.location.hostname}${overlappingNavigation.location.pathname}${overlappingNavigation.location.search}`;
  overlappingNavigation.window.dispatchEvent(new FakeCustomEvent("yt-navigate-finish"));

  secondSettingsRead.resolve({});
  await settle();
  assert.equal(lastScopeCommand(overlappingNavigation.commands), "ytap-disarm", "the newest playlist navigation must decide scope first");
  const commandsAfterNewestNavigation = overlappingNavigation.commands.length;

  firstSettingsRead.resolve({});
  await settle();
  assert.equal(lastScopeCommand(overlappingNavigation.commands), "ytap-disarm", "a stale settings read must not re-arm the newer auto-next route");
  assert.equal(overlappingNavigation.commands.length, commandsAfterNewestNavigation, "a superseded navigation must not emit stale config or scope commands");

});

test("a failed settings refresh preserves the last complete coverage configuration", async () => {
  for (const initial of [
    { hostname: "www.twitch.tv", settings: { applyToTwitch: true } },
    { hostname: "www.twitch.tv", settings: { enabled: false, applyToTwitch: true } },
    { hostname: "video.example", settings: { applyToOtherSites: false, siteLibrary: ["selected.example"] } },
  ]) {
    let fail = false;
    const h = createHarness({ ...initial, pathname: "/first", search: "", settingsProvider: async () => {
      if (fail) throw new Error("temporary storage failure");
      return initial.settings;
    } });
    await settle();
    const before = h.commands.filter(({ type }) => type === "ytap-config").at(-1).detail;
    const previousScope = lastScopeCommand(h.commands);
    fail = true;
    h.location.pathname = "/second";
    h.location.href = `https://${initial.hostname}/second`;
    h.window.dispatchEvent(new FakeCustomEvent("popstate"));
    await settle();
    const after = h.commands.filter(({ type }) => type === "ytap-config").at(-1).detail;
    assert.deepEqual(after, before);
    assert.equal(lastScopeCommand(h.commands), previousScope);
  }
});

test("an invalidated extension context retains coverage and stops navigation polling", async () => {
  let reads = 0;
  const h = createHarness({ hostname: "www.twitch.tv", pathname: "/first", search: "", settingsProvider: async () => {
    if (reads++) throw new Error("Extension context invalidated.");
    return { applyToTwitch: true };
  } });
  await settle();
  assert.equal(h.isPolling(), true);
  h.location.pathname = "/second";
  h.location.href = "https://www.twitch.tv/second";
  h.window.dispatchEvent(new FakeCustomEvent("popstate"));
  await settle();
  assert.equal(lastScopeCommand(h.commands), "ytap-arm");
  assert.equal(h.isPolling(), false);
  const readsAtInvalidation = reads;
  h.window.dispatchEvent(new FakeCustomEvent("popstate"));
  await settle();
  assert.equal(reads, readsAtInvalidation);
});

test("duplicate navigation diagnostics redact relative paths and query values", async () => {
  for (const [pathname, search, marker] of [
    ["/results", "?search_query=synthetic-query-marker", "synthetic-query-marker"],
    ["/shorts/SyntheticMediaMarker", "", "SyntheticMediaMarker"],
  ]) {
    const h = createHarness({ pathname, search, settings: { debug: true } });
    await settle();
    h.window.dispatchEvent(new FakeCustomEvent("yt-navigate-finish"));
    await settle();
    assert.ok(h.logs.some((args) => args.some((arg) => String(arg).includes("onNavigate SKIPPED"))));
    assert.equal(JSON.stringify(h.logs).includes(marker), false);
  }
});

test("channel exceptions wait for a matching watch identity in both navigation directions", async () => {
  const h = createHarness({ search: "?v=first", settings: { allowlist: ["/@allowed"] } });
  const owner = { href: "https://www.youtube.com/@allowed" };
  let renderedId = "first";
  const watch = { getAttribute: (name) => name === "video-id" ? renderedId : null,
    querySelector: () => owner };
  h.document.querySelector = (selector) => selector === "ytd-watch-flexy" ? watch : owner;
  h.document.querySelectorAll = () => [watch];
  await settle();
  const initialResumes = h.commands.filter(({ type }) => type === "ytap-resume").length;
  assert.equal(initialResumes, 1);
  h.location.search = "?v=second";
  h.location.href = "https://www.youtube.com/watch?v=second";
  h.window.dispatchEvent(new FakeCustomEvent("popstate"));
  await settle();
  assert.equal(lastScopeCommand(h.commands), "ytap-arm");
  assert.equal(h.commands.filter(({ type }) => type === "ytap-resume").length, initialResumes);
  renderedId = "second";
  owner.href = "https://www.youtube.com/@other";
  h.runPendingTimers();
  await settle();
  assert.equal(lastScopeCommand(h.commands), "ytap-arm");
  h.location.search = "?v=first";
  h.location.href = "https://www.youtube.com/watch?v=first";
  h.window.dispatchEvent(new FakeCustomEvent("popstate"));
  await settle();
  assert.equal(lastScopeCommand(h.commands), "ytap-arm");
  renderedId = "first";
  owner.href = "https://www.youtube.com/@allowed";
  h.runPendingTimers();
  await settle();
  assert.equal(lastScopeCommand(h.commands), "ytap-disarm");
  assert.equal(h.commands.filter(({ type }) => type === "ytap-resume").length, initialResumes + 1);
});

test("the page bridge exposes the version only with opt-in debugging", async () => {
  for (const debug of [false, true]) {
    const h = createHarness({ settings: { debug } });
    await settle();
    const config = h.commands.filter(({ type }) => type === "ytap-config").at(-1).detail;
    assert.equal(Object.hasOwn(config, "extensionVersion"), debug);
    assert.equal(config.debug, debug);
  }
});

test("a generic site exception follows the top-level website into embedded media", async () => {
  const h = createHarness({ hostname: "player.example", pathname: "/embed", search: "", referrer: "https://excluded.example/page", ancestorOrigins: ["https://excluded.example"], settings: { siteExclusions: ["excluded.example"] } });
  await settle();
  assert.equal(lastScopeCommand(h.commands), "ytap-disarm");
});
