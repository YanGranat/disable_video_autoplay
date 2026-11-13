const assert = require("node:assert/strict");
const vm = require("node:vm");
const { test } = require("node:test");
const { runScripts } = require("./load_scripts.cjs");
const { createHarness, requestPlayback } = require("./helpers/playback.cjs");

const context = vm.createContext({});
runScripts(context, ["adapters/player-dom.js"]);
const players = vm.runInContext("YTAPPlayerDom", context);

function createPlayer(platform = "youtube") {
  let custom = false;
  let reads = 0;
  const adapter = players.create({
    document: { querySelector: () => { reads++; return custom ? {} : null; } },
    isTwitchHost: () => platform === "twitch",
    isKickHost: () => platform === "kick",
    isOtherSite: () => platform === "other",
  });
  return { adapter, mount: (value) => { custom = value; }, reads: () => reads };
}

function button(className, root = "") {
  return {
    nodeType: 1, tagName: "BUTTON",
    classList: { contains: (token) => token === className },
    getAttribute: () => "", matches: () => false,
    closest: (selector) => root && selector.includes(root) ? {} : null,
  };
}

test("generic playback labels distinguish media actions from unrelated calls to action", () => {
  const { adapter } = createPlayer("other");
  for (const [label, expected] of [["Start free trial", false], ["Watch updates", false],
    ["Start video", true], ["Watch stream", true], ["Play", true], ["Pause", true]]) {
    const control = button("");
    control.getAttribute = (name) => name === "aria-label" ? label : "";
    assert.equal(adapter.isOnPlayControl([control]), expected, label);
  }
});

test("YouTube content evidence belongs to the media controller and leaves uncertainty unknown", () => {
  let expected = "two";
  const adapter = players.create({
    document: { querySelector: () => null },
    isTwitchHost: () => false, isKickHost: () => false, isOtherSite: () => false,
    currentYouTubeVideoId: () => expected,
  });
  let id = "one";
  const root = { getVideoData: () => ({ video_id: id }), classList: { contains: () => false } };
  const video = { closest: selector => selector === "#movie_player" ? root : null };
  assert.equal(adapter.youtubeContentState(video), "stale");
  id = "two";
  assert.equal(adapter.youtubeContentState(video), "current");
  id = "";
  assert.equal(adapter.youtubeContentState(video), "unknown");
  id = "one";
  root.classList.contains = name => name === "ad-showing";
  assert.equal(adapter.youtubeContentState(video), "unknown");
  root.classList.contains = () => false;
  root.getVideoData = () => { throw new Error("unavailable"); };
  assert.equal(adapter.youtubeContentState(video), "unknown");
  expected = "";
  assert.equal(adapter.youtubeContentState(video), "unknown");
  assert.equal(adapter.youtubeContentState({ closest: () => null }), "unknown");
});

test("player profiles bind recognition, input ownership and blocked-play results", () => {
  const youtube = createPlayer();
  const classic = youtube.adapter.profileForPlayback();
  assert.equal(classic.id, "youtube-classic");
  assert.equal(classic.inputMode, "delegate");
  assert.equal(classic.blockedPlay, "deny-youtube");
  const classicPath = [button("ytp-play-button")];
  assert.equal(youtube.adapter.profileForInput(classicPath), classic);
  assert.equal(classic.isOnPlayControl(classicPath), true);

  youtube.mount(true);
  const custom = youtube.adapter.profileForPlayback();
  assert.equal(custom.id, "youtube-custom");
  assert.equal(custom.inputMode, "delegate");
  assert.equal(custom.blockedPlay, "deny-youtube");
  assert.equal(custom.isOnPlayControl([button("ytmCuedOverlayPlayButton")]), false,
    "matching classes outside the custom player do not express playback intent");
  for (const root of ["ytm-custom-control", "ytm-watch-player-controls"]) {
    const playPath = [button("player-control-play-pause-icon", root)];
    assert.equal(youtube.adapter.profileForInput(playPath), custom);
    assert.equal(custom.isOnPlayer(playPath), true);
    assert.equal(custom.isOnPlayControl(playPath), true);
    const settingsPath = [button("player-settings-icon", root)];
    assert.equal(custom.isOnPlayer(settingsPath), false);
    assert.equal(custom.isOnPlayControl(settingsPath), false);
  }
  assert.equal(youtube.adapter.profileForInput(classicPath), classic,
    "an unrelated custom overlay must not own a classic input");
  assert.equal(Object.isFrozen(classic), true);
  assert.equal(Object.isFrozen(custom), true);
  youtube.mount(false);
  assert.equal(youtube.adapter.profileForPlayback(), classic, "player discovery must stay live");
});

test("non-YouTube profiles retain their controller contract regardless of overlay markup", () => {
  for (const [platform, result] of [
    ["twitch", "acknowledge-twitch"], ["kick", "native-pause"], ["other", "native-pause"],
  ]) {
    const player = createPlayer(platform);
    player.mount(true);
    const profile = player.adapter.profileForPlayback();
    assert.equal(profile.inputMode, "fallback");
    assert.equal(profile.blockedPlay, result);
    assert.equal(player.adapter.profileForInput([button("ytmCuedOverlayPlayButton", "ytm-custom-control")]), profile);
    assert.equal(player.reads(), 0, "unrelated platforms must not probe YouTube controls");
    assert.equal(Object.isFrozen(profile), true);
  }
});

test("controller-managed blocks skip native play while native-pause profiles retain their chain", async () => {
  for (const [hostname, pathname, nativeCalls] of [
    ["www.youtube.com", "/embed/example", 0], ["www.twitch.tv", "/channel-a", 0],
    ["kick.com", "/channel-a", 1], ["player.example", "/video", 1],
  ]) {
    const h = createHarness({ hostname, pathname });
    await requestPlayback(h.video);
    assert.equal(h.video.playCalls, nativeCalls);
    assert.equal(h.video.paused, true);
  }
});
