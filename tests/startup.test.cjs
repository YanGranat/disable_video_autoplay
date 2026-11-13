const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness, requestPlayback, FakeCustomEvent } = require("./helpers/playback.cjs");

test("startup playback waits for the final settings and scope decision", async () => {
  const startupAllowed = createHarness({ configureImmediately: false });
  const releasedPlay = startupAllowed.video.play();
  assert.equal(startupAllowed.video.playCalls, 0, "Twitch play must wait while its setting is unknown");
  startupAllowed.configure(false);
  await releasedPlay;
  assert.equal(startupAllowed.video.paused, false, "startup play must be released when Twitch blocking is disabled");

  const startupBlocked = createHarness({ configureImmediately: false });
  const blockedPlay = startupBlocked.video.play();
  assert.equal(startupBlocked.video.playCalls, 0, "enabled Twitch startup must also wait for settings");
  startupBlocked.configure(true);
  await blockedPlay;
  assert.equal(startupBlocked.video.paused, true, "startup play must stay paused when Twitch blocking is enabled");
  assert.equal(startupBlocked.video.playCalls, 0, "blocked startup must not reach the site's original play()");

  const playlistStartup = createHarness({
    configureImmediately: false,
    hostname: "www.youtube.com",
    pathname: "/watch",
    search: "?v=one&list=PL1",
    readyState: "loading",
  });
  const playlistStartupPlay = requestPlayback(playlistStartup.video);
  assert.equal(playlistStartup.video.playCalls, 0, "initial playlist play must wait for the final scope decision");
  playlistStartup.configure();
  playlistStartup.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
  playlistStartup.document.dispatchEvent({ type: "DOMContentLoaded" });
  await playlistStartupPlay;
  assert.equal(playlistStartup.video.paused, true, "initial playlist video must remain blocked after the arm command");
  assert.equal(playlistStartup.video.playCalls, 0, "initial playlist startup must not briefly reach native play()");

  playlistStartup.configure();
  await requestPlayback(playlistStartup.video);
  assert.equal(playlistStartup.video.paused, true, "a later config refresh must preserve the manually opened playlist route");
  assert.equal(
    playlistStartup.video.playCalls,
    0,
    "a repeated blocked YouTube request must not reach native play() after settings are ready"
  );

  playlistStartup.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-disarm"));
  await requestPlayback(playlistStartup.video);
  assert.equal(playlistStartup.video.paused, false, "playlist auto-next setup must be playing while disarmed");
  playlistStartup.location.search = "?v=two&list=PL1";
  playlistStartup.location.href = `https://${playlistStartup.location.hostname}${playlistStartup.location.pathname}${playlistStartup.location.search}`;
  playlistStartup.windowTarget.dispatchEvent(new FakeCustomEvent("yt-navigate-start"));
  playlistStartup.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
  await Promise.resolve();
  assert.equal(playlistStartup.video.paused, true, "arming a manually selected playlist route must pause an already-playing reused video");

  const youtubeStopMode = createHarness({
    hostname: "www.youtube.com",
    pathname: "/watch",
    search: "?v=stop-mode",
    stopInsteadOfPause: true,
    debug: true,
  });
  const youtubeStopModeSource = youtubeStopMode.video.currentSrc;
  await requestPlayback(youtubeStopMode.video);
  assert.equal(youtubeStopMode.video.paused, true, "YouTube stop mode must still block autoplay");
  assert.equal(youtubeStopMode.video.playCalls, 0, "YouTube stop mode must block before native play()");
  assert.equal(youtubeStopMode.video.currentSrc, youtubeStopModeSource, "YouTube stop mode must not reset the selected media source");
  const youtubeStopModeLogs = youtubeStopMode.consoleEntries
    .map((entry) => entry.args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
    .join("\n");
  assert.match(
    youtubeStopModeLogs,
    /YouTube autoplay denied profile=youtube-classic.*mediaId=m1 sourceId=s1 nativePlaySkipped=true stopModeSourceResetSkipped=true/,
    "copied diagnostics must expose the safe YouTube stop-mode exception"
  );
  assert.doesNotMatch(youtubeStopModeLogs, /stop-mode/, "YouTube stop-mode diagnostics must not expose the page video id");
  assert.doesNotMatch(youtubeStopModeLogs, /blob:test-stream/, "source diagnostics must keep the raw media source private");
});
