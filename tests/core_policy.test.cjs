const assert = require("node:assert/strict");
const vm = require("node:vm");
const { test } = require("node:test");
const { runScripts } = require("./load_scripts.cjs");

// No fake document, Chrome API, clock, media element or event system is needed.
const context = vm.createContext({ URL });
runScripts(context, ["vendor/domain-parser.js", "core/site-context.js", "core/settings.js", "core/playback-policy.js", "core/diagnostics.js"]);
const settings = vm.runInContext("YTAPSettings", context);
const policy = vm.runInContext("YTAPPlaybackPolicy", context);
const diagnostics = vm.runInContext("YTAPDiagnostics", context);
const plain = (value) => JSON.parse(JSON.stringify(value));
const config = (patch = {}) => ({ ...settings.mainDefaults, settingsReady: true, ...patch });
const watch = Object.freeze({ platform: "youtube", videoPage: true });

test("play request priority preserves controller identity and explicit permissions", () => {
  const blocked = { armed: true, carryover: false, userAllowed: false, userIntent: false, contentState: "unknown" };
  for (const [patch, expected] of [
    [{}, "block"], [{ armed: false }, "authorized"], [{ userAllowed: true }, "authorized"],
    [{ carryover: true, armed: false }, "deny-carryover"],
    [{ carryover: true, carryoverAllowed: true }, "carryover-gesture"],
    [{ userIntent: true }, "user-gesture"], [{ recentAreaClick: true }, "recent-area-click"],
    [{ pendingSelection: true }, "selected-controller"],
    [{ contentState: "stale", userAllowed: true, userIntent: true, pendingSelection: true }, "deny-stale"],
  ]) assert.equal(policy.playRequest({ ...blocked, ...patch }), expected);
});

test("gesture decisions require trusted playback intent, not merely a page gesture", () => {
  assert.equal(policy.gestureIntent({ trusted: false, onPlayer: true, onPlayControl: true }).accepted, false);
  const unrelated = policy.gestureIntent({ trusted: true });
  assert.equal(unrelated.player, false);
  assert.equal(unrelated.playControl, false);
  const play = policy.gestureIntent({ trusted: true, onPlayer: true, inPlayerArea: true, delegated: true });
  assert.equal(play.player, true);
  assert.equal(play.rememberArea, false);
  const late = policy.gestureIntent({ trusted: true, otherSite: true, inPlayerArea: true, onPlayControl: true, hasVideo: false });
  assert.equal(late.pendingVideo, true);
});

test("channel input canonicalizes supported forms and rejects unrelated values", () => {
  for (const value of ["@Example", "/@Example", "https://www.youtube.com/@Example/videos?view=1", "youtube.com/@Example"]) {
    assert.equal(settings.normalizeChannel(value), "/@example");
  }
  assert.equal(settings.normalizeChannel("/@\u041f\u0440\u0438\u043c\u0435\u0440"), settings.normalizeChannel("/@%D0%9F%D1%80%D0%B8%D0%BC%D0%B5%D1%80"));
  for (const value of ["arbitrary text", "https://foreign.example/@example", "https://youtube.com.foreign.example/@example", "/watch?v=example", "/@invalid name", "/@%zz", null, 42]) {
    assert.equal(settings.normalizeChannel(value), "");
  }
});

test("settings have one immutable owner and expose only playback flags to MAIN", () => {
  assert.ok(Object.isFrozen(settings.defaults));
  assert.ok(Object.isFrozen(settings.defaults.siteLibrary));
  assert.ok(Object.isFrozen(settings.defaults.allowlist));
  assert.equal(settings.defaults.debug, false);
  assert.equal(settings.defaults.applyToPlaylists, false);
  assert.equal(settings.defaults.applyToShorts, false);
  assert.equal(settings.defaults.applyToOtherSites, true);
  assert.equal(settings.defaults.applyToTwitch, false);
  assert.equal(settings.defaults.applyToKick, false);
  const stored = { ...settings.defaults, allowlist: ["/@private-marker"], siteLibrary: ["private.example"] };
  const result = settings.toMainConfig(stored, false);
  assert.equal(result.applyToOtherSites, false, "top-frame library coverage is supplied by the runtime");
  assert.equal(result.settingsReady, true);
  assert.deepEqual(Object.keys(result).sort(), [...settings.mainKeys, "settingsReady", "debug"].sort());
  assert.equal(JSON.stringify(result).includes("private"), false);
  const instance = { ...settings.mainDefaults };
  instance.enabled = false;
  assert.equal(settings.mainDefaults.enabled, true);
});

test("settings projection preserves existing coercion and normalization", () => {
  const result = settings.toMainConfig({ enabled: 0, applyToYouTube: null, applyToEmbedded: undefined,
    applyToShorts: "yes", ignoreMiniplayer: false }, true);
  assert.equal(result.enabled, false);
  assert.equal(result.applyToYouTube, true);
  assert.equal(result.applyToEmbedded, true);
  assert.equal(result.applyToShorts, true);
  assert.equal(result.ignoreMiniplayer, false);
  assert.equal(settings.normalizeChannel(" /@Example/videos/ "), "/@example");
  assert.equal(settings.normalizeSite("https://www.Example.com./watch?v=one"), "example.com");
  assert.equal(settings.normalizeSite("file:///example"), "");
  assert.deepEqual(plain(settings.normalizeSiteLibrary(["sub.example.com", "example.com", "other.example"])), ["example.com", "other.example"]);
  assert.equal(settings.siteMatchesHostname("notexample.com", "example.com"), false);
  assert.equal(settings.isDedicatedSite("notyoutube.com"), false);
  assert.equal(settings.isDedicatedSite("www.youtube-nocookie.com"), true);
});

test("coverage preserves startup, master switch and independent platform settings", () => {
  for (const platform of ["youtube", "twitch", "kick", "other"]) {
    const page = { ...watch, platform };
    assert.equal(policy.coverage(config({ enabled: false, settingsReady: false }), page).armed, false);
    assert.equal(policy.coverage(config({ settingsReady: false }), page).armed, true);
    const flag = { youtube: "applyToYouTube", twitch: "applyToTwitch", kick: "applyToKick", other: "applyToOtherSites" }[platform];
    for (const enabled of [false, true]) {
      assert.equal(policy.coverage(config({ [flag]: enabled }), page).armed, enabled);
    }
  }
});

test("YouTube coverage obeys independent platform and context switches", () => {
  const cases = [
    ["desktop watch", {}, { videoPage: true }, true],
    ["platform off", { applyToYouTube: false }, { videoPage: true }, false],
    ["home feed", {}, {}, false],
    ["channel", {}, { channelPage: true }, true],
    ["channel off", { applyToChannelPlayer: false }, { channelPage: true }, false],
    ["mobile off", {}, { videoPage: true, mobile: true }, false],
    ["mobile on", { applyToMobile: true }, { videoPage: true, mobile: true }, true],
    ["embedded", {}, { embedded: true }, true],
    ["embedded off", { applyToEmbedded: false }, { embedded: true, videoPage: true }, false],
    ["shorts off", {}, { videoPage: true, shorts: true }, false],
    ["shorts on", { applyToShorts: true }, { videoPage: true, shorts: true }, true],
    ["manual playlist", {}, { videoPage: true, playlist: true, manualPlaylist: true }, true],
    ["playlist auto-next", {}, { videoPage: true, playlist: true }, false],
    ["playlist auto-next on", { applyToPlaylists: true }, { videoPage: true, playlist: true }, true],
    ["mobile switch still applies to a manual playlist", {}, { videoPage: true, playlist: true, manualPlaylist: true, mobile: true }, false],
    ["playlist switch still applies to an embed", {}, { embedded: true, playlist: true }, false],
    ["shorts switch still applies on mobile", { applyToMobile: true }, { videoPage: true, mobile: true, shorts: true }, false],
  ];
  for (const [label, flags, facts, expected] of cases) {
    assert.equal(policy.coverage(Object.freeze(config(flags)), Object.freeze({ platform: "youtube", ...facts })).armed, expected, label);
  }
});

test("manual playlist selection blocks while automatic continuation follows the setting", () => {
  const playlist = { ...watch, playlist: true };
  assert.equal(policy.coverage(config(), { ...playlist, manualPlaylist: true }).armed, true);
  assert.equal(policy.coverage(config(), playlist).reason, "playlist-auto-next");
  assert.equal(policy.coverage(config({ applyToPlaylists: true }), playlist).armed, true);
  assert.equal(policy.coverage(config(), { platform: "youtube" }).armed, false);
});

test("gesture decisions preserve exact time boundaries, media/route matching and autopause ownership", () => {
  const match = { sameMedia: true, sameRoute: true, pausedOnce: true };
  const gesture = Object.freeze({ lastPlayerAt: 110, lastPlayControlAt: 0, lastAutopauseAt: 100 });
  const recent = policy.gestureTiming(gesture, 1609, 1500);
  assert.equal(policy.userPlay(match, recent).allowed, true);
  assert.equal(policy.userPlay(match, policy.gestureTiming(gesture, 1610, 1500)).allowed, false);
  assert.equal(policy.userPlay({ ...match, sameMedia: false }, recent).allowed, false);
  assert.equal(policy.userPlay({ ...match, sameRoute: false }, recent).allowed, false);
  assert.equal(policy.userPlay({ ...match, pausedOnce: false }, recent).allowed, false, "a surface click before any intervention is not a Play control");
  const explicit = policy.gestureTiming({ ...gesture, lastPlayControlAt: 110 }, 120, 1500);
  assert.equal(policy.userPlay({ ...match, pausedOnce: false }, explicit).allowed, true);
  for (const autopause of [110, 111, 0]) {
    assert.equal(policy.userPlay(match, policy.gestureTiming({ ...gesture, lastAutopauseAt: autopause }, 120, 1500)).allowed, false);
  }
});

test("privacy filtering is shared, bounded and does not mutate its input", () => {
  const value = { channel: "free-form-private-marker", routeKey: "private.example/route", mediaId: "m1", nested: { src: "https://private.example/stream" }, allowlist: ["/@private"] };
  value.self = value;
  const result = diagnostics.sanitizeDebugArgs(["https://private.example/", value]);
  assert.doesNotMatch(JSON.stringify(result), /private/);
  assert.equal(result[1].mediaId, "m1");
  assert.equal(result[1].self, "[circular]");
  assert.equal(value.channel, "free-form-private-marker");
  assert.equal(value.self, value);
});

test("all persisted collections are redacted in copied diagnostics", () => {
  const keys = Object.entries(settings.defaults).filter(([, value]) => Array.isArray(value)).map(([key]) => key);
  for (const key of [...keys, "whitelist"]) {
    const result = diagnostics.sanitizeDebugArgs([{ [key]: ["synthetic-private-value"] }]);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private-value/, key);
    assert.equal(result[0][key], "[1 entries]");
  }
});

test("storage adapter is lazy, preserves rejection and unregisters subscriptions", async () => {
  let reads = 0;
  let writes = 0;
  const listeners = new Set();
  const storageContext = vm.createContext({
    chrome: { storage: {
      sync: {
        get: async (defaults) => { reads++; return defaults; },
        set: async () => { writes++; throw new Error("test write failure"); },
      },
      onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    } },
    navigator: { locks: { request: (_key, action) => action() } },
  });
  runScripts(storageContext, ["vendor/domain-parser.js", "core/site-context.js", "core/settings.js", "adapters/settings-store.js"]);
  const store = vm.runInContext("YTAPSettingsStore", storageContext);
  assert.equal(reads + writes + listeners.size, 0);
  assert.equal((await store.read()).enabled, true);
  const unsubscribe = store.subscribe(() => {});
  assert.equal(listeners.size, 1);
  unsubscribe();
  assert.equal(listeners.size, 0);
  await assert.rejects(store.write({ enabled: false }), /test write failure/);
  assert.equal(await store.updateList("siteLibrary", () => null), null);
  assert.equal(writes, 1, "null list updates must not write");
});
