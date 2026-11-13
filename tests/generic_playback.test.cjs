const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness, requestPlayback, FakeCustomEvent, trustedPlayerPointer, trustedPlayerClick, trustedOverlayEvent, fakePlayerOverlay, fakePlayControl, fakeCompactPlayPauseControl, trustedExternalControlEvent } = require("./helpers/playback.cjs");

test("independent player contexts retain their own media prototype and permissions", async () => {
  const blocked = createHarness({ hostname: "first.example" });
  await blocked.video.play();
  const allowed = createHarness({ hostname: "second.example", enabled: false });
  await allowed.video.play();
  assert.equal(allowed.video.paused, false);
  await blocked.video.play();
  assert.equal(blocked.video.paused, true);
  const replacement = blocked.createVideo();
  await replacement.play();
  assert.equal(replacement.paused, true);
});

test("generic player recovery, source restoration and visibility scope", async () => {
  const compactExternalControl = createHarness({ hostname: "audio.example", pathname: "/compact-control", debug: true });
  await compactExternalControl.video.play();
  assert.equal(compactExternalControl.video.paused, true, "compact-control fixture must begin with autoplay blocked");
  const compactControl = fakeCompactPlayPauseControl();
  compactExternalControl.windowTarget.addEventListener("click", (event) => {
    if (event.target === compactControl.icon) compactExternalControl.video.play();
  });
  compactExternalControl.windowTarget.dispatchEvent(
    trustedExternalControlEvent("pointerdown", compactControl.icon, [compactControl.icon, compactControl.button])
  );
  compactExternalControl.windowTarget.dispatchEvent(
    trustedExternalControlEvent("click", compactControl.icon, [compactControl.icon, compactControl.button])
  );
  await Promise.resolve();
  assert.equal(compactExternalControl.video.paused, false, "a trusted external Play/Pause control must authorize playback even when its compact token has no separator");
  const compactControlLogs = compactExternalControl.consoleEntries
    .map((entry) => entry.args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
    .join("\n");
  assert.match(compactControlLogs, /gesture classification .*path=svg>button .*interactive=button:other .*attributes=data-testid .*playLike=true/,
    "copied logs must explain why the compact external control was recognized");
  assert.doesNotMatch(compactControlLogs, /media-control-playpause|custom-control-role/,
    "sanitized gesture diagnostics must not copy page-provided attribute or custom role values");

  const reusedStopSource = createHarness({ hostname: "media.example", pathname: "/first", stopInsteadOfPause: true });
  // Chromium can retain currentSrc after removing src + load(). Do not model
  // that browser-owned state as synchronously empty during a source reset.
  reusedStopSource.video.load = function () { if (this.src) this.currentSrc = this.src; };
  reusedStopSource.video.src = "https://media.example/first.webm";
  await reusedStopSource.video.play();
  assert.equal(reusedStopSource.video.src, "", "Stop mode must remove a restorable source");
  reusedStopSource.windowTarget.dispatchEvent(trustedPlayerPointer(reusedStopSource.video));
  await reusedStopSource.video.play();
  assert.equal(reusedStopSource.video.src, "https://media.example/first.webm", "manual Play must restore the stopped source");
  reusedStopSource.location.pathname = "/second";
  reusedStopSource.location.href = "https://media.example/second";
  reusedStopSource.video.src = "https://media.example/second.webm";
  // currentSrc can still describe the previous resource until resource selection.
  await reusedStopSource.video.play();
  await reusedStopSource.video.play();
  reusedStopSource.windowTarget.dispatchEvent(trustedPlayerPointer(reusedStopSource.video));
  await reusedStopSource.video.play();
  assert.equal(reusedStopSource.video.src, "https://media.example/second.webm", "repeated Stop requests must restore the newly selected source, never the old video");

  for (const sourceKind of ["stream", "children"]) {
    const siteOwnedSource = createHarness({ hostname: "media.example", stopInsteadOfPause: true });
    siteOwnedSource.video.src = "https://media.example/fallback.webm";
    if (sourceKind === "stream") siteOwnedSource.video.srcObject = {};
    else siteOwnedSource.video.querySelector = () => ({});
    await siteOwnedSource.video.play();
    assert.equal(siteOwnedSource.video.src, "https://media.example/fallback.webm", `Stop mode must not detach a ${sourceKind}-based player's source`);
    assert.equal(siteOwnedSource.video.paused, true);
  }

  for (const disabledFlag of ["stopInsteadOfPause", "enabled"]) {
    const stoppedThenDisabled = createHarness({ hostname: "media.example", stopInsteadOfPause: true });
    stoppedThenDisabled.video.src = "https://media.example/current.webm";
    await stoppedThenDisabled.video.play();
    stoppedThenDisabled.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-config", { detail: { [disabledFlag]: false } }));
    stoppedThenDisabled.windowTarget.dispatchEvent(trustedPlayerPointer(stoppedThenDisabled.video));
    await stoppedThenDisabled.video.play();
    assert.equal(stoppedThenDisabled.video.src, "https://media.example/current.webm", `turning off ${disabledFlag} must not strand media without its source`);
  }

  const outsideGenericPlayer = createHarness({ hostname: "media.example" });
  await outsideGenericPlayer.video.play();
  const pageContainer = { ...fakePlayerOverlay(), className: "page-content", querySelectorAll: () => [outsideGenericPlayer.video] };
  const outsideLink = { ...fakePlayerOverlay(), tagName: "A", className: "navigation-link" };
  outsideGenericPlayer.windowTarget.dispatchEvent(trustedExternalControlEvent("pointerdown", outsideLink, [outsideLink, pageContainer]));
  outsideGenericPlayer.windowTarget.dispatchEvent(trustedExternalControlEvent("click", outsideLink, [outsideLink, pageContainer]));
  await outsideGenericPlayer.video.play();
  assert.equal(outsideGenericPlayer.video.paused, true, "a page container holding one video does not make every external link a Play control");

  for (const editableKind of ["INPUT", "TEXTAREA", "contenteditable"]) {
    const typing = createHarness({ hostname: "www.youtube.com", pathname: "/watch" });
    await requestPlayback(typing.video);
    typing.advanceTime(10);
    const field = { ...fakePlayerOverlay(), tagName: editableKind === "contenteditable" ? "DIV" : editableKind, isContentEditable: editableKind === "contenteditable" };
    typing.document.activeElement = field;
    typing.windowTarget.dispatchEvent({ type: "keydown", key: "k", isTrusted: true, target: field, composedPath: () => [field] });
    await requestPlayback(typing.video);
    assert.equal(typing.video.paused, true, `typing into ${editableKind} must not authorize YouTube autoplay`);
  }
  const youtubeHotkey = createHarness({ hostname: "www.youtube.com", pathname: "/watch" });
  await requestPlayback(youtubeHotkey.video);
  youtubeHotkey.advanceTime(10);
  youtubeHotkey.windowTarget.dispatchEvent({ type: "keydown", key: "k", isTrusted: true, target: youtubeHotkey.document.body, composedPath: () => [youtubeHotkey.document.body] });
  await requestPlayback(youtubeHotkey.video);
  assert.equal(youtubeHotkey.video.paused, false, "the normal YouTube K shortcut must remain available outside text fields");

  const generic = createHarness({ hostname: "player.example", pathname: "/frame5.php" });
  await Promise.resolve();
  let controllerState = "paused";
  generic.windowTarget.addEventListener("click", () => {
    if (controllerState === "paused") {
      controllerState = "playing";
      generic.video.play();
    } else {
      controllerState = "paused";
      generic.video.pause();
    }
  });

  generic.windowTarget.dispatchEvent(trustedPlayerPointer(generic.video));
  generic.windowTarget.dispatchEvent(trustedPlayerClick(generic.video));
  await Promise.resolve();
  assert.equal(controllerState, "playing", "generic controller must receive the first click");
  assert.equal(generic.video.paused, false, "generic controller must start media itself");
  assert.equal(generic.video.playCalls, 1, "generic user click must reach native play exactly once");

  generic.windowTarget.dispatchEvent(trustedPlayerPointer(generic.video));
  generic.windowTarget.dispatchEvent(trustedPlayerClick(generic.video));
  assert.equal(controllerState, "paused", "generic controller must pause on the second click");
  assert.equal(generic.video.paused, true, "generic second click must pause without controller desync");

  generic.location.pathname = "/frame6.php";
  generic.location.href = `https://${generic.location.hostname}${generic.location.pathname}`;
  await generic.video.play();
  assert.equal(generic.video.paused, true, "permission for a reused generic video must not leak into another SPA route");
  generic.location.pathname = "/frame5.php";
  generic.location.href = `https://${generic.location.hostname}${generic.location.pathname}`;
  await generic.video.play();
  assert.equal(generic.video.paused, true, "manual playback permission must not revive after leaving and returning to its old route");

  const naturallyPausedController = createHarness({
    hostname: "media.example",
    pathname: "/page.php",
    search: "?id=909",
  });
  let naturallyPausedControllerActions = 0;
  let naturallyPausedControllerSawPaused = null;
  naturallyPausedController.windowTarget.addEventListener("click", (event) => {
    if (event.target !== naturallyPausedController.video) return;
    setTimeout(() => {
      naturallyPausedControllerActions += 1;
      naturallyPausedControllerSawPaused = naturallyPausedController.video.paused;
      if (naturallyPausedController.video.paused) naturallyPausedController.video.play();
      else naturallyPausedController.video.pause();
    }, 200);
  });
  naturallyPausedController.windowTarget.dispatchEvent(trustedPlayerPointer(naturallyPausedController.video));
  naturallyPausedController.windowTarget.dispatchEvent(trustedPlayerClick(naturallyPausedController.video));
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(naturallyPausedControllerActions, 1, "naturally-paused site controller must receive the original click exactly once");
  assert.equal(naturallyPausedControllerSawPaused, true, "extension must not preempt a naturally-paused site's delayed Play toggle");
  assert.equal(naturallyPausedController.video.paused, false, "naturally-paused site controller must remain the playback owner");
  assert.equal(naturallyPausedController.video.playCalls, 1, "extension must not add its own play() on a naturally-paused site");

  const untouchedControllerless = createHarness({ hostname: "example.com", pathname: "/naturally-paused-video" });
  untouchedControllerless.windowTarget.dispatchEvent(trustedPlayerPointer(untouchedControllerless.video));
  untouchedControllerless.windowTarget.dispatchEvent(trustedPlayerClick(untouchedControllerless.video));
  await new Promise((resolve) => setTimeout(resolve, 390));
  assert.equal(untouchedControllerless.video.paused, true, "extension must not invent playback when it did not block autoplay");
  assert.equal(untouchedControllerless.video.playCalls, 0, "naturally-paused controllerless media must stay untouched");

  const lateCreatedVideo = createHarness({
    hostname: "player.example",
    pathname: "/season/late-video",
    videoInitiallyPresent: false,
  });
  const earlyPlayControl = fakePlayControl();
  lateCreatedVideo.windowTarget.dispatchEvent(trustedOverlayEvent("pointerdown", earlyPlayControl));
  lateCreatedVideo.windowTarget.dispatchEvent(trustedOverlayEvent("click", earlyPlayControl));
  assert.equal(lateCreatedVideo.video.playCalls, 0, "early Play click must precede video creation in the regression fixture");
  lateCreatedVideo.video.autoplay = true;
  lateCreatedVideo.setVideoPresent(true);
  lateCreatedVideo.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
  await Promise.resolve();
  assert.equal(lateCreatedVideo.video.autoplay, false, "late-created autoplay attribute must still be neutralized");
  await new Promise((resolve) => setTimeout(resolve, 390));
  assert.equal(lateCreatedVideo.video.paused, false, "an explicit Play intent must follow the late-created autoplay video");
  assert.equal(lateCreatedVideo.video.playCalls, 1, "late-created video recovery must start native playback exactly once");

  const cancelledLateVideo = createHarness({
    hostname: "player.example",
    pathname: "/season/cancelled-late-video",
    videoInitiallyPresent: false,
  });
  const cancelledPlayControl = fakePlayControl();
  cancelledLateVideo.windowTarget.dispatchEvent(trustedOverlayEvent("pointerdown", cancelledPlayControl));
  cancelledLateVideo.windowTarget.dispatchEvent(trustedOverlayEvent("click", cancelledPlayControl));
  cancelledLateVideo.windowTarget.dispatchEvent(trustedOverlayEvent("pointerdown", fakePlayerOverlay()));
  cancelledLateVideo.video.autoplay = true;
  cancelledLateVideo.setVideoPresent(true);
  cancelledLateVideo.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 390));
  assert.equal(cancelledLateVideo.video.paused, true, "a newer pointer gesture must cancel stale pending Play intent");
  assert.equal(cancelledLateVideo.video.playCalls, 0, "cancelled pending intent must not start a later video");

  for (const cancellation of ["new-pointer", "disable"]) {
    const boundLateVideo = createHarness({ hostname: "player.example", videoInitiallyPresent: false });
    const control = fakePlayControl();
    boundLateVideo.windowTarget.dispatchEvent(trustedOverlayEvent("pointerdown", control));
    boundLateVideo.windowTarget.dispatchEvent(trustedOverlayEvent("click", control));
    boundLateVideo.video.autoplay = true;
    boundLateVideo.setVideoPresent(true);
    boundLateVideo.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
    await Promise.resolve();
    if (cancellation === "new-pointer") {
      boundLateVideo.windowTarget.dispatchEvent(trustedOverlayEvent("pointerdown", fakePlayerOverlay()));
    } else {
      boundLateVideo.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-config", { detail: { enabled: false } }));
    }
    await new Promise((resolve) => setTimeout(resolve, 390));
    assert.equal(boundLateVideo.video.playCalls, 0, `${cancellation} must cancel fallback even after late video has consumed the intent`);
    assert.equal(boundLateVideo.video.paused, true);
  }

  const expiredLateVideo = createHarness({
    hostname: "player.example",
    pathname: "/season/expired-late-video",
    videoInitiallyPresent: false,
  });
  const expiredPlayControl = fakePlayControl();
  expiredLateVideo.windowTarget.dispatchEvent(trustedOverlayEvent("pointerdown", expiredPlayControl));
  expiredLateVideo.windowTarget.dispatchEvent(trustedOverlayEvent("click", expiredPlayControl));
  expiredLateVideo.advanceTime(5100);
  expiredLateVideo.video.autoplay = true;
  expiredLateVideo.setVideoPresent(true);
  expiredLateVideo.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
  await new Promise((resolve) => setTimeout(resolve, 390));
  assert.equal(expiredLateVideo.video.paused, true, "expired pending Play intent must not authorize a later video");
  assert.equal(expiredLateVideo.video.playCalls, 0, "expired pending intent must not schedule native playback");

  const delayedController = createHarness({ hostname: "player.example", pathname: "/season/episode-4" });
  const delayedOverlay = fakePlayerOverlay();
  let delayedControllerActions = 0;
  await delayedController.video.play();
  assert.equal(delayedController.video.paused, true, "delayed-controller fixture must begin with autoplay blocked by the extension");
  delayedController.windowTarget.addEventListener("click", (event) => {
    if (event.target !== delayedOverlay) return;
    setTimeout(() => {
      delayedControllerActions += 1;
      if (delayedController.video.paused) delayedController.video.play();
      else delayedController.video.pause();
    }, 200);
  });
  delayedController.windowTarget.dispatchEvent(trustedOverlayEvent("pointerdown", delayedOverlay));
  delayedController.windowTarget.dispatchEvent(trustedOverlayEvent("click", delayedOverlay));
  await new Promise((resolve) => setTimeout(resolve, 380));
  assert.equal(delayedControllerActions, 1, "delayed generic controller must receive the original click exactly once");
  assert.equal(delayedController.video.paused, false, "fallback must not preempt a delayed generic controller and turn Play into Pause");
  assert.equal(delayedController.video.playCalls, 2, "delayed generic controller must add the only playback start after blocked autoplay");

  const controllerless = createHarness({ hostname: "player.example", pathname: "/player/episode-1" });
  await controllerless.video.play();
  assert.equal(controllerless.video.paused, true, "controllerless fallback fixture must begin with autoplay blocked by the extension");
  controllerless.windowTarget.dispatchEvent(trustedPlayerPointer(controllerless.video));
  controllerless.windowTarget.dispatchEvent(trustedPlayerClick(controllerless.video));
  await new Promise((resolve) => setTimeout(resolve, 390));
  assert.equal(controllerless.video.paused, false, "controllerless custom player must start through the bounded fallback");
  assert.equal(controllerless.video.playCalls, 2, "controller fallback must add exactly one native play after the blocked autoplay attempt");
  controllerless.video.pause();
  controllerless.windowTarget.dispatchEvent(trustedPlayerPointer(controllerless.video));
  controllerless.windowTarget.dispatchEvent(trustedPlayerClick(controllerless.video));
  await new Promise((resolve) => setTimeout(resolve, 390));
  assert.equal(controllerless.video.paused, false, "controller fallback must remain available after a later pause");
  assert.equal(controllerless.video.playCalls, 3, "each controllerless playback click must start exactly once after intervention");

  const overlayControllerless = createHarness({ hostname: "example.com", pathname: "/custom-overlay-player" });
  const controllerlessOverlay = fakePlayerOverlay();
  await overlayControllerless.video.play();
  assert.equal(overlayControllerless.video.paused, true, "overlay fallback fixture must begin with autoplay blocked by the extension");
  overlayControllerless.windowTarget.dispatchEvent(trustedOverlayEvent("pointerdown", controllerlessOverlay));
  overlayControllerless.windowTarget.dispatchEvent(trustedOverlayEvent("click", controllerlessOverlay));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(overlayControllerless.video.paused, true, "custom overlay fallback must leave time for a delayed site controller");
  await new Promise((resolve) => setTimeout(resolve, 190));
  assert.equal(overlayControllerless.video.paused, false, "controllerless custom overlay must still start after the extended fallback");
  assert.equal(overlayControllerless.video.playCalls, 2, "custom overlay fallback must add one native playback after intervention");

  const bottomControl = createHarness({ hostname: "example.com", pathname: "/video" });
  await bottomControl.video.play();
  bottomControl.advanceTime(10);
  bottomControl.windowTarget.dispatchEvent(trustedPlayerPointer(bottomControl.video, 700));
  bottomControl.windowTarget.dispatchEvent(trustedPlayerClick(bottomControl.video, 700));
  await new Promise((resolve) => setTimeout(resolve, 390));
  assert.equal(bottomControl.video.paused, true, "an unlabelled bottom-bar click must not trigger fallback playback");
  assert.equal(bottomControl.video.playCalls, 1, "bottom-bar input must not add native play after intervention");

  const disabledVisibility = createHarness({
    hostname: "video.example",
    pathname: "/watch",
    enabled: false,
    pauseOnHidden: true,
    resumeOnVisible: true,
  });
  await disabledVisibility.video.play();
  const disabledPauseCalls = disabledVisibility.video.pauseCalls;
  disabledVisibility.document.hidden = true;
  disabledVisibility.document.dispatchEvent({ type: "visibilitychange" });
  assert.equal(disabledVisibility.video.paused, false, "visibility options must do nothing while the extension is disabled");
  assert.equal(disabledVisibility.video.pauseCalls, disabledPauseCalls, "disabled visibility handling must not call pause()");

  const uncoveredTwitchVisibility = createHarness({
    hostname: "www.twitch.tv",
    pathname: "/channel-a",
    applyToTwitch: false,
    pauseOnHidden: true,
  });
  await uncoveredTwitchVisibility.video.play();
  uncoveredTwitchVisibility.document.hidden = true;
  uncoveredTwitchVisibility.document.dispatchEvent({ type: "visibilitychange" });
  assert.equal(uncoveredTwitchVisibility.video.paused, false, "visibility options must respect a disabled dedicated-site switch");

  const coveredVisibility = createHarness({
    hostname: "video.example",
    pathname: "/watch",
    pauseOnHidden: true,
    resumeOnVisible: true,
  });
  coveredVisibility.windowTarget.dispatchEvent(trustedPlayerPointer(coveredVisibility.video));
  await coveredVisibility.video.play();
  coveredVisibility.document.hidden = true;
  coveredVisibility.document.dispatchEvent({ type: "visibilitychange" });
  assert.equal(coveredVisibility.video.paused, true, "covered user-started media must still pause when its tab is hidden");
  coveredVisibility.document.hidden = false;
  coveredVisibility.document.dispatchEvent({ type: "visibilitychange" });
  assert.equal(coveredVisibility.video.paused, false, "covered user-started media must still resume when its tab becomes visible");
});
