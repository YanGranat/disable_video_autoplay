const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness, requestPlayback, FakeCustomEvent, trustedPlayerPointer, trustedPlayerClick, trustedOverlayEvent, fakePlayerOverlay, copiedConsoleText, fakeYoutubeWatchLink, trustedYoutubeNavigationPointer, trustedYoutubeNavigationClick } = require("./helpers/playback.cjs");

test("YouTube player input, playlist navigation and miniplayer ownership", async () => {
  const playlistMiniplayerNavigation = createHarness({
    hostname: "www.youtube.com",
    pathname: "/watch",
    search: "?v=miniplayer-one&list=PL1",
    debug: true,
  });
  playlistMiniplayerNavigation.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
  await requestPlayback(playlistMiniplayerNavigation.video);
  assert.equal(playlistMiniplayerNavigation.video.paused, true, "the manually opened playlist video must start paused");
  const nativePlayCallsBeforeMiniplayer = playlistMiniplayerNavigation.video.playCalls;
  playlistMiniplayerNavigation.location.pathname = "/";
  playlistMiniplayerNavigation.location.search = "";
  playlistMiniplayerNavigation.location.href = "https://www.youtube.com/";
  playlistMiniplayerNavigation.windowTarget.dispatchEvent(new FakeCustomEvent("yt-navigate-start"));
  playlistMiniplayerNavigation.video.closest = (selector) => selector.includes("ytd-miniplayer")
    ? playlistMiniplayerNavigation.video
    : null;
  await requestPlayback(playlistMiniplayerNavigation.video);
  assert.equal(
    playlistMiniplayerNavigation.video.paused,
    true,
    "a video paused by the extension must not resume automatically when YouTube moves it to the miniplayer"
  );
  assert.equal(
    playlistMiniplayerNavigation.video.playCalls,
    nativePlayCallsBeforeMiniplayer,
    "blocking the carried watch-page video must not briefly call native play()"
  );
  playlistMiniplayerNavigation.video.dispatchEvent({ type: "emptied" });
  await requestPlayback(playlistMiniplayerNavigation.video);
  assert.equal(
    playlistMiniplayerNavigation.video.paused,
    true,
    "an emptied lifecycle reset must not release the extension-owned miniplayer pause"
  );
  assert.equal(
    playlistMiniplayerNavigation.video.playCalls,
    nativePlayCallsBeforeMiniplayer,
    "the carried watch-page video must remain blocked without native play() after emptied"
  );
  const independentMiniplayer = playlistMiniplayerNavigation.addYouTubeVideo({ inMiniplayer: true });
  await requestPlayback(independentMiniplayer.video);
  assert.equal(
    independentMiniplayer.video.paused,
    false,
    "an independently existing YouTube miniplayer must remain site-controlled while ignoreMiniplayer is enabled"
  );
  assert.equal(
    playlistMiniplayerNavigation.video.paused,
    true,
    "allowing an independent miniplayer must not release the extension-owned pause on the manually opened video"
  );
  const miniplayerCarryoverLogs = playlistMiniplayerNavigation.consoleEntries
    .map((entry) => entry.args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
    .join("\n");
  assert.match(
    miniplayerCarryoverLogs,
    /YouTube paused video will remain paused after leaving the video page mediaId=m1/,
    "copied logs must identify the exact carried media element without exposing its URL"
  );
  assert.match(
    miniplayerCarryoverLogs,
    /YouTube paused video carryover retained after media reset.*mediaId.*m1/,
    "diagnostics must show that an emptied reset did not release the carried pause"
  );
  assert.match(
    miniplayerCarryoverLogs,
    /YouTube paused-video carryover blocked without native play mediaId=m1 sourceId=s1/,
    "copied logs must identify the no-native-play carryover block without assuming it is the miniplayer"
  );
  assert.doesNotMatch(miniplayerCarryoverLogs, /miniplayer-one/, "carried-media diagnostics must keep the page video id private");
  const miniplayerPlayButton = {
    nodeType: 1,
    tagName: "BUTTON",
    classList: { contains: (name) => name === "ytp-play-button" },
    getAttribute: () => "",
    matches: () => false,
    closest: (selector) => selector.includes("#movie_player") ? miniplayerPlayButton : null,
    querySelectorAll: () => [],
  };
  const miniplayerPlayerContainer = {
    nodeType: 1,
    tagName: "DIV",
    classList: { contains: (name) => name === "html5-video-player" },
    getAttribute: () => "",
    matches: () => false,
    closest: () => null,
    contains: (node) => node === playlistMiniplayerNavigation.video,
    querySelectorAll: () => [playlistMiniplayerNavigation.video],
  };
  playlistMiniplayerNavigation.windowTarget.dispatchEvent({
    ...trustedPlayerPointer(playlistMiniplayerNavigation.video),
    target: miniplayerPlayButton,
    composedPath: () => [miniplayerPlayButton, miniplayerPlayerContainer],
  });
  await requestPlayback(playlistMiniplayerNavigation.video);
  assert.equal(
    playlistMiniplayerNavigation.video.paused,
    false,
    "one trusted control action must authorize the same paused miniplayer video"
  );
  assert.equal(
    playlistMiniplayerNavigation.video.playCalls,
    nativePlayCallsBeforeMiniplayer + 1,
    "the trusted miniplayer click must be the first native play() after the transition"
  );

  const earlyMiniplayerNavigation = createHarness({
    hostname: "www.youtube.com",
    pathname: "/watch",
    search: "?v=miniplayer-early&list=PL1",
  });
  earlyMiniplayerNavigation.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
  await requestPlayback(earlyMiniplayerNavigation.video);
  assert.equal(earlyMiniplayerNavigation.video.paused, true, "the source playlist video must first be paused");
  earlyMiniplayerNavigation.location.pathname = "/";
  earlyMiniplayerNavigation.location.search = "";
  earlyMiniplayerNavigation.location.href = "https://www.youtube.com/";
  earlyMiniplayerNavigation.video.closest = (selector) => selector.includes("ytd-miniplayer")
    ? earlyMiniplayerNavigation.video
    : null;
  await requestPlayback(earlyMiniplayerNavigation.video);
  assert.equal(
    earlyMiniplayerNavigation.video.paused,
    true,
    "the play() route fallback must preserve intervention ownership before media classification resets its generation"
  );

  const nativeMiniplayerNavigation = createHarness({
    hostname: "www.youtube.com",
    pathname: "/watch",
    search: "?v=miniplayer-native&list=PL1",
  });
  nativeMiniplayerNavigation.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
  await requestPlayback(nativeMiniplayerNavigation.video);
  assert.equal(nativeMiniplayerNavigation.video.paused, true, "the source video must be extension-paused before native playback");
  nativeMiniplayerNavigation.location.pathname = "/";
  nativeMiniplayerNavigation.location.search = "";
  nativeMiniplayerNavigation.location.href = "https://www.youtube.com/";
  nativeMiniplayerNavigation.video.closest = (selector) => selector.includes("ytd-miniplayer")
    ? nativeMiniplayerNavigation.video
    : null;
  nativeMiniplayerNavigation.video.paused = false;
  nativeMiniplayerNavigation.video.dispatchEvent({ type: "playing" });
  assert.equal(
    nativeMiniplayerNavigation.video.paused,
    true,
    "the playing guard must restore the extension-owned pause even when playback starts without a patched play() call"
  );

  const playingMiniplayerNavigation = createHarness({
    hostname: "www.youtube.com",
    pathname: "/watch",
    search: "?v=miniplayer-playing",
  });
  await requestPlayback(playingMiniplayerNavigation.video);
  assert.equal(
    playingMiniplayerNavigation.video.playCalls,
    0,
    "an extension-blocked YouTube watch page must not briefly reach native play()"
  );
  playingMiniplayerNavigation.windowTarget.dispatchEvent(trustedPlayerPointer(playingMiniplayerNavigation.video));
  await requestPlayback(playingMiniplayerNavigation.video);
  assert.equal(playingMiniplayerNavigation.video.paused, false, "a trusted click must start the full-size YouTube video");
  assert.equal(
    playingMiniplayerNavigation.video.playCalls,
    1,
    "the trusted click must be the first native play() on the YouTube watch page"
  );
  playingMiniplayerNavigation.location.pathname = "/";
  playingMiniplayerNavigation.location.search = "";
  playingMiniplayerNavigation.location.href = "https://www.youtube.com/";
  playingMiniplayerNavigation.windowTarget.dispatchEvent(new FakeCustomEvent("yt-navigate-start"));
  playingMiniplayerNavigation.video.closest = (selector) => selector.includes("ytd-miniplayer")
    ? playingMiniplayerNavigation.video
    : null;
  await requestPlayback(playingMiniplayerNavigation.video);
  assert.equal(
    playingMiniplayerNavigation.video.paused,
    false,
    "a video already started by the user must continue playing when it moves to the miniplayer"
  );

  const manualPlaylistNavigation = createHarness({
    hostname: "www.youtube.com",
    pathname: "/watch",
    search: "?v=one&list=PL1",
    debug: true,
  });
  manualPlaylistNavigation.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-disarm"));
  await requestPlayback(manualPlaylistNavigation.video);
  const nativePlayCallsBeforeManualPlaylistSelection = manualPlaylistNavigation.video.playCalls;
  const playlistLink = fakeYoutubeWatchLink("two");
  manualPlaylistNavigation.windowTarget.dispatchEvent(trustedYoutubeNavigationPointer(playlistLink));
  manualPlaylistNavigation.location.search = "?v=two&list=PL1";
  manualPlaylistNavigation.location.href = `https://${manualPlaylistNavigation.location.hostname}${manualPlaylistNavigation.location.pathname}${manualPlaylistNavigation.location.search}`;
  manualPlaylistNavigation.windowTarget.dispatchEvent(new FakeCustomEvent("yt-navigate-start"));
  await requestPlayback(manualPlaylistNavigation.video);
  assert.equal(manualPlaylistNavigation.video.paused, true, "a manually selected playlist video must be armed before its first site play() call");
  assert.equal(
    manualPlaylistNavigation.video.playCalls,
    nativePlayCallsBeforeManualPlaylistSelection,
    "a manually selected playlist video must be blocked before native play() can alter controller state"
  );
  const manualPlaylistLogs = manualPlaylistNavigation.consoleEntries
    .map((entry) => entry.args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
    .join("\n");
  assert.match(
    manualPlaylistLogs,
    /YouTube playlist navigation classified hadNavigationIntent=true navigationIntentFresh=true targetMatchesRoute=true manualRoute=true/,
    "copied MAIN logs must expose the target-matched playlist decision as plain text"
  );

  manualPlaylistNavigation.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-disarm"));
  await requestPlayback(manualPlaylistNavigation.video);
  const keyboardPlaylistLink = fakeYoutubeWatchLink("three");
  manualPlaylistNavigation.windowTarget.dispatchEvent(trustedYoutubeNavigationClick(keyboardPlaylistLink));
  manualPlaylistNavigation.location.search = "?v=three&list=PL1";
  manualPlaylistNavigation.location.href = `https://${manualPlaylistNavigation.location.hostname}${manualPlaylistNavigation.location.pathname}${manualPlaylistNavigation.location.search}`;
  manualPlaylistNavigation.windowTarget.dispatchEvent(new FakeCustomEvent("yt-navigate-start"));
  await requestPlayback(manualPlaylistNavigation.video);
  assert.equal(manualPlaylistNavigation.video.paused, true, "keyboard activation of a playlist link must also arm the selected video");

  const delayedYoutubeClick = createHarness({
    hostname: "www.youtube.com",
    pathname: "/watch",
    search: "?v=delayed-click",
  });
  await requestPlayback(delayedYoutubeClick.video);
  assert.equal(delayedYoutubeClick.video.paused, true, "YouTube autoplay must be paused before the delayed user click");
  delayedYoutubeClick.windowTarget.addEventListener("click", (event) => {
    if (event.target === delayedYoutubeClick.video) {
      if (delayedYoutubeClick.video.paused) requestPlayback(delayedYoutubeClick.video);
      else delayedYoutubeClick.video.pause();
    }
  });
  delayedYoutubeClick.windowTarget.dispatchEvent(trustedPlayerPointer(delayedYoutubeClick.video));
  assert.equal(delayedYoutubeClick.video.paused, true, "pointerdown must leave source preparation to the controller");
  delayedYoutubeClick.advanceTime(750);
  const delayedClick = trustedPlayerClick(delayedYoutubeClick.video);
  delayedYoutubeClick.windowTarget.dispatchEvent(delayedClick);
  assert.equal(delayedClick.immediatePropagationStopped, undefined, "the controller must receive a delayed playback click");
  assert.equal(delayedYoutubeClick.video.paused, false, "the delayed completion of the same click must not pause YouTube again");
  delayedYoutubeClick.windowTarget.dispatchEvent(trustedPlayerPointer(delayedYoutubeClick.video));
  const intentionalPauseClick = trustedPlayerClick(delayedYoutubeClick.video);
  delayedYoutubeClick.windowTarget.dispatchEvent(intentionalPauseClick);
  assert.equal(intentionalPauseClick.immediatePropagationStopped, undefined, "a separate Pause click must reach the controller");
  assert.equal(delayedYoutubeClick.video.paused, true, "the next user click must still pause YouTube normally");

  const copiedYoutubeGesture = createHarness({
    hostname: "www.youtube.com",
    pathname: "/watch",
    search: "?v=copyable-gesture",
    debug: true,
  });
  await requestPlayback(copiedYoutubeGesture.video);
  copiedYoutubeGesture.windowTarget.dispatchEvent(
    trustedOverlayEvent("pointerdown", fakePlayerOverlay())
  );
  copiedYoutubeGesture.windowTarget.dispatchEvent(trustedPlayerPointer(copiedYoutubeGesture.video));
  await requestPlayback(copiedYoutubeGesture.video);
  await Promise.resolve();
  const copiedYoutubeGestureLogs = copiedConsoleText(copiedYoutubeGesture.consoleEntries);
  assert.match(
    copiedYoutubeGestureLogs,
    /gesture kind=pointerdown pointerSeq=1 onPlayer=false onPlayControl=false inPlayerArea=false overVideoRect=true target=div path=div/,
    "Copy all must explain a trusted click rejected outside YouTube player DOM"
  );
  assert.match(
    copiedYoutubeGestureLogs,
    /gesture kind=pointerdown pointerSeq=2 onPlayer=true onPlayControl=false inPlayerArea=true overVideoRect=true target=video path=video mediaId=m1/,
    "Copy all must distinguish the accepted follow-up click without expandable objects"
  );
  assert.match(
    copiedYoutubeGestureLogs,
    /YouTube manual play result reason=controller-play pointerSeq=2 outcome=resolved paused=false readyState=4 sameRoute=true samePointer=true mediaId=m1 sourceId=s1/,
    "Copy all must expose the browser result of the user-started native play call"
  );
  assert.equal(
    copiedYoutubeGesture.video.playCalls,
    1,
    "diagnostics must not add another native Play call"
  );

  const rootOnlyYoutubePointer = createHarness({
    hostname: "www.youtube.com",
    pathname: "/watch",
    search: "?v=root-pointer",
    debug: true,
  });
  const root = rootOnlyYoutubePointer.document.documentElement;
  Object.assign(root, { tagName: "HTML", clientWidth: 1280, clientHeight: 720 });
  Object.assign(rootOnlyYoutubePointer.windowTarget, { innerWidth: 1280, innerHeight: 720 });
  rootOnlyYoutubePointer.document.hasFocus = () => false;
  rootOnlyYoutubePointer.document.elementFromPoint = () => root;
  await requestPlayback(rootOnlyYoutubePointer.video);
  const rootPointer = {
    ...trustedPlayerPointer(rootOnlyYoutubePointer.video),
    target: root,
    button: 0,
    pointerType: "mouse",
    composedPath: () => [root, rootOnlyYoutubePointer.document, rootOnlyYoutubePointer.windowTarget],
  };
  rootOnlyYoutubePointer.windowTarget.dispatchEvent(rootPointer);
  assert.match(
    copiedConsoleText(rootOnlyYoutubePointer.consoleEntries),
    /gesture kind=pointerdown pointerSeq=1 .*overVideoRect=true target=html path=html mediaId=none/,
    "a root-only DOM path must not be reported as an empty path"
  );
  assert.match(
    copiedConsoleText(rootOnlyYoutubePointer.consoleEntries),
    /YouTube unmatched pointer pointerSeq=1 pathLength=3 button=0 pointerType=mouse focused=false hitTarget=html hitOnPlayer=false viewportScrollbar=false/,
    "an unmatched pointer above the video must expose focus and hit-test evidence in Copy all"
  );
  assert.equal(rootPointer.immediatePropagationStopped, undefined, "an unmatched pointer must remain site-controlled");
  await requestPlayback(rootOnlyYoutubePointer.video);
  assert.equal(rootOnlyYoutubePointer.video.playCalls, 0, "a root click over the video rectangle must not grant playback permission");
  rootOnlyYoutubePointer.document.hasFocus = () => true;
  rootOnlyYoutubePointer.document.elementFromPoint = () => rootOnlyYoutubePointer.video;
  rootOnlyYoutubePointer.windowTarget.dispatchEvent({ ...rootPointer, composedPath: () => [] });
  assert.match(
    copiedConsoleText(rootOnlyYoutubePointer.consoleEntries),
    /YouTube unmatched pointer pointerSeq=2 pathLength=0 .*focused=true hitTarget=video hitOnPlayer=true viewportScrollbar=false/,
    "an actually empty path must remain distinguishable from a root-only path even when hit-testing finds video"
  );
  assert.equal(rootOnlyYoutubePointer.video.playCalls, 0, "diagnostic hit-testing must not start playback");
  rootOnlyYoutubePointer.windowTarget.dispatchEvent(trustedPlayerPointer(rootOnlyYoutubePointer.video));
  await requestPlayback(rootOnlyYoutubePointer.video);
  await Promise.resolve();
  assert.equal(rootOnlyYoutubePointer.video.playCalls, 1, "the next real player pointer must still start exactly once");
  assert.equal(rootOnlyYoutubePointer.video.paused, false);
  assert.equal(
    copiedConsoleText(rootOnlyYoutubePointer.consoleEntries).match(/YouTube unmatched pointer/g)?.length,
    2,
    "normal player input must not add an unmatched-pointer trace"
  );

  const quietRootPointer = createHarness({ hostname: "www.youtube.com", pathname: "/watch", debug: false });
  let diagnosticHitTests = 0;
  quietRootPointer.document.elementFromPoint = () => { diagnosticHitTests += 1; return quietRootPointer.video; };
  quietRootPointer.windowTarget.dispatchEvent({ ...rootPointer, target: quietRootPointer.document.documentElement, composedPath: () => [] });
  assert.equal(diagnosticHitTests, 0, "debug-off playback must not perform diagnostic hit-tests");

  const resolvedButPausedYoutube = createHarness({
    hostname: "www.youtube.com",
    pathname: "/watch",
    search: "?v=resolved-but-paused",
    debug: true,
  });
  await requestPlayback(resolvedButPausedYoutube.video);
  resolvedButPausedYoutube.video.nativePlayFailures = 1;
  resolvedButPausedYoutube.windowTarget.dispatchEvent(trustedPlayerPointer(resolvedButPausedYoutube.video));
  await requestPlayback(resolvedButPausedYoutube.video);
  await Promise.resolve();
  assert.match(
    copiedConsoleText(resolvedButPausedYoutube.consoleEntries),
    /YouTube manual play result reason=controller-play pointerSeq=1 outcome=resolved paused=true readyState=4 sameRoute=true samePointer=true mediaId=m1 sourceId=s1/,
    "Copy all must reveal a resolved native Play call that still left YouTube paused"
  );
  assert.equal(resolvedButPausedYoutube.video.playCalls, 1, "resolved-but-paused diagnostics must not retry playback");

  const rapidYoutubePause = createHarness({
    hostname: "www.youtube.com",
    pathname: "/watch",
    search: "?v=rapid-pause",
  });
  await requestPlayback(rapidYoutubePause.video);
  rapidYoutubePause.windowTarget.addEventListener("click", (event) => {
    if (event.target === rapidYoutubePause.video) {
      if (rapidYoutubePause.video.paused) requestPlayback(rapidYoutubePause.video);
      else rapidYoutubePause.video.pause();
    }
  });
  rapidYoutubePause.windowTarget.dispatchEvent(trustedPlayerPointer(rapidYoutubePause.video));
  rapidYoutubePause.advanceTime(100);
  rapidYoutubePause.windowTarget.dispatchEvent(trustedPlayerClick(rapidYoutubePause.video));
  assert.equal(rapidYoutubePause.video.paused, false, "the first rapid click must start controller playback");
  rapidYoutubePause.windowTarget.dispatchEvent(trustedPlayerPointer(rapidYoutubePause.video));
  rapidYoutubePause.advanceTime(50);
  const rapidPauseClick = trustedPlayerClick(rapidYoutubePause.video);
  rapidYoutubePause.windowTarget.dispatchEvent(rapidPauseClick);
  assert.equal(rapidPauseClick.immediatePropagationStopped, undefined, "a rapid second click must reach the controller");
  assert.equal(rapidYoutubePause.video.paused, true, "a rapid second click must remain available for Pause");
});
