const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness, FakeTwitchControl, trustedPlayerPointer, trustedPlayerClick, trustedOverlayEvent, fakePlayerOverlay, copiedConsoleText, trustedControlEvent } = require("./helpers/playback.cjs");

test("configuration diagnostics identify inherited owner resolution without exposing its URL", () => {
  const harness = createHarness({
    hostname: "", pathname: "blank", debug: true,
    referrer: "https://video.example/first",
    ownerLocation: new URL("https://video.example/second"),
  });
  const text = copiedConsoleText(harness.consoleEntries);
  assert.ok(text.includes("ownerSource=ancestor"));
  assert.ok(!text.includes("video.example"));
  const quiet = createHarness({ debug: false });
  assert.equal(quiet.consoleEntries.length, 0);
});

test("Twitch and Kick controller ownership and route permissions", async () => {
  const { video, windowTarget, location } = createHarness();
  await Promise.resolve();

  await video.play();
  assert.equal(video.paused, true, "initial Twitch autoplay must be paused");
  assert.equal(video.playCalls, 0, "blocked Twitch autoplay must not reach native play() or add IVS listeners");

  windowTarget.addEventListener("click", () => video.play());
  windowTarget.dispatchEvent(trustedPlayerPointer(video));
  assert.equal(video.paused, true, "Twitch pointerdown must not bypass the site controller");
  windowTarget.dispatchEvent(trustedPlayerClick(video));
  await Promise.resolve();
  assert.equal(video.paused, false, "trusted player click must start the current channel");

  video.pause();
  location.search = "?referrer=raid";
  location.href = `https://${location.hostname}${location.pathname}${location.search}`;
  await video.play();
  assert.equal(video.paused, false, "Twitch UI query changes must keep current-channel permission");
  assert.equal(video.playCalls, 2, "only the two user-authorized starts may reach native play()");

  video.pause();
  location.pathname = "/channel-b";
  location.search = "";
  location.href = `https://${location.hostname}${location.pathname}`;
  await video.play();
  assert.equal(video.paused, true, "autoplay on a new Twitch channel must be paused");
  assert.equal(video.playCalls, 2, "new-channel autoplay must not reach native play()");

  const twitchFailedFirstStart = createHarness({ nativePlayFailures: 1 });
  await twitchFailedFirstStart.video.play();
  twitchFailedFirstStart.windowTarget.addEventListener("click", () => twitchFailedFirstStart.video.play());
  twitchFailedFirstStart.windowTarget.dispatchEvent(trustedPlayerPointer(twitchFailedFirstStart.video));
  twitchFailedFirstStart.windowTarget.dispatchEvent(trustedPlayerClick(twitchFailedFirstStart.video));
  await Promise.resolve();
  assert.equal(twitchFailedFirstStart.video.paused, true, "fixture must reproduce a controller play attempt that did not stick");
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(twitchFailedFirstStart.video.paused, false, "a failed first Twitch controller attempt must recover without waiting for site retries");
  assert.equal(twitchFailedFirstStart.video.playCalls, 2, "Twitch recovery must add exactly one native retry after the failed user start");

  const twitchReadyLater = createHarness({ nativePlayFailures: 1, mediaReadyState: 1 });
  await twitchReadyLater.video.play();
  twitchReadyLater.windowTarget.addEventListener("click", () => twitchReadyLater.video.play());
  twitchReadyLater.windowTarget.dispatchEvent(trustedPlayerPointer(twitchReadyLater.video));
  twitchReadyLater.windowTarget.dispatchEvent(trustedPlayerClick(twitchReadyLater.video));
  await Promise.resolve();
  setTimeout(() => { twitchReadyLater.video.readyState = 4; }, 120);
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.equal(twitchReadyLater.video.paused, false, "Twitch user start must recover soon after delayed media readiness");
  assert.equal(twitchReadyLater.video.playCalls, 2, "delayed-readiness recovery must still retry native playback only once");

  const twitchRetryCancelled = createHarness({ nativePlayFailures: 1 });
  await twitchRetryCancelled.video.play();
  twitchRetryCancelled.windowTarget.addEventListener("click", () => twitchRetryCancelled.video.play());
  twitchRetryCancelled.windowTarget.dispatchEvent(trustedPlayerPointer(twitchRetryCancelled.video));
  twitchRetryCancelled.windowTarget.dispatchEvent(trustedPlayerClick(twitchRetryCancelled.video));
  await Promise.resolve();
  twitchRetryCancelled.windowTarget.dispatchEvent(trustedPlayerPointer(twitchRetryCancelled.video));
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(twitchRetryCancelled.video.paused, true, "a newer user gesture must cancel the pending Twitch start retry");
  assert.equal(twitchRetryCancelled.video.playCalls, 1, "cancelled Twitch recovery must not add a native retry");

  const twitchUiSync = createHarness();
  const twitchUiControl = new FakeTwitchControl(twitchUiSync.windowTarget, "pause");
  twitchUiSync.setTwitchControl(twitchUiControl);
  let twitchUiState = "playing";
  twitchUiSync.windowTarget.addEventListener("click", (event) => {
    if (event.target !== twitchUiControl) return;
    if (twitchUiState === "playing") {
      twitchUiState = "paused";
      twitchUiControl.action = "play";
      twitchUiSync.video.pause();
      return;
    }
    twitchUiState = "playing";
    twitchUiControl.action = "pause";
    twitchUiSync.video.play();
  });

  await twitchUiSync.video.play();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(twitchUiSync.video.paused, true, "Twitch autoplay must stay paused while controller UI is synchronized");
  assert.equal(twitchUiState, "paused", "blocked Twitch autoplay must synchronize the controller to paused state");
  assert.equal(twitchUiControl.action, "play", "paused Twitch UI must show the Play action");

  twitchUiSync.windowTarget.dispatchEvent(trustedControlEvent("pointerdown", twitchUiControl));
  twitchUiSync.windowTarget.dispatchEvent(trustedControlEvent("click", twitchUiControl));
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(twitchUiState, "playing", "first trusted Twitch control click must switch the controller to playing");
  assert.equal(twitchUiSync.video.paused, false, "first trusted Twitch control click must start the stream");

  const twitchRecovery = createHarness();
  const blockedRecoveryPlay = twitchRecovery.video.play();
  const twitchRecoveryControl = new FakeTwitchControl(twitchRecovery.windowTarget, "pause");
  twitchRecovery.setTwitchControl(twitchRecoveryControl);
  let twitchRecoveryState = "playing";
  twitchRecovery.windowTarget.addEventListener("click", (event) => {
    if (event.target !== twitchRecoveryControl) return;
    if (twitchRecoveryState === "playing") {
      twitchRecoveryState = "paused";
      twitchRecoveryControl.action = "play";
      twitchRecovery.video.pause();
      return;
    }
    twitchRecoveryState = "playing";
    twitchRecoveryControl.action = "pause";
    twitchRecovery.video.play();
  });
  twitchRecovery.windowTarget.dispatchEvent(trustedControlEvent("pointerdown", twitchRecoveryControl));
  twitchRecovery.windowTarget.dispatchEvent(trustedControlEvent("click", twitchRecoveryControl));
  await blockedRecoveryPlay;
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(twitchRecoveryState, "playing", "Twitch recovery must retoggle a stale Pause controller through its Play action");
  assert.equal(twitchRecovery.video.paused, false, "a first click on stale Twitch Pause UI must still start the stream");

  const nativeStart = createHarness();
  await Promise.resolve();
  await nativeStart.video.play();
  nativeStart.windowTarget.addEventListener("click", () => nativeStart.video.play());
  nativeStart.windowTarget.dispatchEvent(trustedPlayerPointer(nativeStart.video));
  nativeStart.windowTarget.dispatchEvent(trustedPlayerClick(nativeStart.video));
  await Promise.resolve();
  assert.equal(nativeStart.video.paused, false, "guard scenario must begin with user-started playback");

  nativeStart.location.pathname = "/channel-native-start";
  nativeStart.location.href = `https://${nativeStart.location.hostname}${nativeStart.location.pathname}`;
  nativeStart.video.paused = false;
  nativeStart.video.dispatchEvent({ type: "playing" });
  assert.equal(nativeStart.video.paused, true, "native playing event on a new route must also be paused");

  const kick = createHarness({ hostname: "kick.com", pathname: "/channel-a" });
  await kick.video.play();
  assert.equal(kick.video.paused, true, "initial Kick autoplay must be paused");
  kick.windowTarget.addEventListener("click", () => kick.video.play());
  kick.windowTarget.dispatchEvent(trustedPlayerPointer(kick.video));
  assert.equal(kick.video.paused, true, "Kick pointerdown must not bypass the site controller");
  kick.windowTarget.dispatchEvent(trustedPlayerClick(kick.video));
  await Promise.resolve();
  assert.equal(kick.video.paused, false, "Kick controller must receive the playback click");
  assert.equal(kick.video.playCalls, 2, "Kick should have one blocked native attempt and one controller-authorized start");

  // The current Kick controls use an icon-only button inside a portal player.
  // Its tooltip is separate, so the button itself has no Play label to match.
  const kickPortal = createHarness({ hostname: "kick.com", pathname: "/channel-a", debug: true });
  const portalRoot = {
    ...fakePlayerOverlay(),
    id: "injected-embedded-channel-player-video",
    className: "flex h-full w-full items-center justify-center",
    matches(selector) { return selector.trim() === `#${this.id}`; },
    closest(selectors) { return selectors.split(",").some((selector) => this.matches(selector)) ? this : null; },
  };
  const portalButton = {
    ...fakePlayerOverlay(), tagName: "BUTTON", className: "",
    closest: (selectors) => portalRoot.closest(selectors),
  };
  const portalIcon = { ...portalButton, tagName: "svg" };
  const portalPath = { ...portalButton, tagName: "path" };
  const portalEvent = (type, button = portalButton) => ({
    ...trustedOverlayEvent(type, portalPath),
    composedPath: () => [portalPath, portalIcon, button, portalRoot],
  });
  await kickPortal.video.play();
  assert.equal(kickPortal.video.paused, true, "the portal player must still block initial autoplay");
  kickPortal.advanceTime(10);
  kickPortal.windowTarget.addEventListener("click", (event) => {
    if (!event.composedPath().includes(portalButton)) return;
    if (kickPortal.video.paused) kickPortal.video.play();
    else kickPortal.video.pause();
  });
  kickPortal.windowTarget.dispatchEvent(portalEvent("pointerdown"));
  assert.equal(kickPortal.video.playCalls, 1, "portal pointerdown must leave Play to the site controller");
  kickPortal.windowTarget.dispatchEvent(portalEvent("click"));
  assert.equal(kickPortal.video.paused, false, "the icon-only Kick portal Play button must start in one click");
  assert.equal(kickPortal.video.playCalls, 2, "the portal controller must start exactly once");
  assert.match(copiedConsoleText(kickPortal.consoleEntries), /kind=pointerdown.*onPlayer=true.*onPlayControl=false.*playLike=false/,
    "Copy all must distinguish the recognized portal from a missing Play label");
  kickPortal.advanceTime(10);
  kickPortal.windowTarget.dispatchEvent(portalEvent("pointerdown"));
  kickPortal.windowTarget.dispatchEvent(portalEvent("click"));
  await new Promise((resolve) => setTimeout(resolve, 170));
  assert.equal(kickPortal.video.paused, true, "the next portal click must stay paused, without fallback restart");
  assert.equal(kickPortal.video.playCalls, 2, "Pause must not add another native Play");

  kickPortal.location.pathname = "/channel-b";
  kickPortal.location.href = "https://kick.com/channel-b";
  await kickPortal.video.play();
  assert.equal(kickPortal.video.paused, true, "portal recognition must not carry Play permission to another channel");
  const callsBeforeSettings = kickPortal.video.playCalls;
  for (const [tagName, label] of [["BUTTON", "Settings"], ["BUTTON", "Mute"], ["BUTTON", ""], ["DIV", ""]]) {
    // Like Play, other icon-only controls may have their tooltip outside the button.
    const portalAuxiliary = { ...portalButton, tagName,
      getAttribute: (name) => name === "role" && tagName === "DIV" ? "button" : name === "aria-label" ? label : "" };
    kickPortal.advanceTime(10);
    kickPortal.windowTarget.dispatchEvent(portalEvent("pointerdown", portalAuxiliary));
    kickPortal.windowTarget.dispatchEvent(portalEvent("click", portalAuxiliary));
    await new Promise((resolve) => setTimeout(resolve, 170));
    assert.equal(kickPortal.video.paused, true, "non-play portal controls, including unlabelled buttons, must not trigger fallback playback");
    assert.equal(kickPortal.video.playCalls, callsBeforeSettings, "non-play portal controls must not call native Play");
  }

  const kickPortalKeyboard = createHarness({ hostname: "kick.com", pathname: "/channel-a" });
  await kickPortalKeyboard.video.play();
  kickPortalKeyboard.advanceTime(10);
  kickPortalKeyboard.document.activeElement = portalButton;
  kickPortalKeyboard.windowTarget.addEventListener("keydown", () => kickPortalKeyboard.video.play());
  kickPortalKeyboard.windowTarget.dispatchEvent({
    type: "keydown", key: " ", isTrusted: true, target: portalButton,
    composedPath: () => [portalButton, portalRoot],
  });
  assert.equal(kickPortalKeyboard.video.paused, false, "Space focused inside the Kick portal must allow the controller's Play");

  const kickCoveredButton = createHarness({ hostname: "kick.com", pathname: "/channel-a", debug: true });
  await kickCoveredButton.video.play();
  kickCoveredButton.advanceTime(10);
  const unrelatedButton = { ...fakePlayerOverlay(), tagName: "BUTTON", className: "" };
  const unrelatedIcon = { ...fakePlayerOverlay(), tagName: "svg", className: "" };
  const coveredButtonEvent = (type) => ({
    ...trustedOverlayEvent(type, unrelatedIcon),
    composedPath: () => [unrelatedIcon, unrelatedButton],
  });
  kickCoveredButton.windowTarget.dispatchEvent(coveredButtonEvent("pointerdown"));
  kickCoveredButton.windowTarget.dispatchEvent(coveredButtonEvent("click"));
  await new Promise((resolve) => setTimeout(resolve, 170));
  assert.equal(kickCoveredButton.video.paused, true, "an unrelated button covering the Kick video must not trigger fallback playback");
  assert.equal(kickCoveredButton.video.playCalls, 1, "a covering button must not add any native Play after the initial blocked attempt");
  await kickCoveredButton.video.play();
  assert.equal(kickCoveredButton.video.paused, true, "a covering button must not authorize a later site-owned Play either");
  assert.match(copiedConsoleText(kickCoveredButton.consoleEntries), /overVideoRect=unknown/, "unmeasured non-YouTube geometry must not be logged as a negative measurement");

  kickCoveredButton.advanceTime(10);
  kickCoveredButton.windowTarget.addEventListener("click", (event) => {
    if (event.target === kickCoveredButton.video) kickCoveredButton.video.play();
  });
  kickCoveredButton.windowTarget.dispatchEvent(trustedPlayerPointer(kickCoveredButton.video));
  kickCoveredButton.windowTarget.dispatchEvent(trustedPlayerClick(kickCoveredButton.video));
  assert.equal(kickCoveredButton.video.paused, false, "the next actual Kick video click must still start in one click");

  const kickPointerOnly = createHarness({ hostname: "kick.com", pathname: "/channel-a" });
  await kickPointerOnly.video.play();
  kickPointerOnly.advanceTime(10);
  kickPointerOnly.windowTarget.dispatchEvent(coveredButtonEvent("pointerdown"));
  await kickPointerOnly.video.play();
  assert.equal(kickPointerOnly.video.paused, true, "rejected pointerdown must not leave permission for a synchronous site Play");

  for (const explicitPlay of [false, true]) {
    const kickOverlay = createHarness({ hostname: "kick.com", pathname: "/channel-a" });
    await kickOverlay.video.play();
    kickOverlay.advanceTime(10);
    const surface = explicitPlay
      ? { ...unrelatedButton, getAttribute: (name) => name === "aria-label" ? "Play" : "" }
      : fakePlayerOverlay();
    kickOverlay.windowTarget.dispatchEvent(trustedOverlayEvent("pointerdown", surface));
    kickOverlay.windowTarget.dispatchEvent(trustedOverlayEvent("click", surface));
    assert.equal(kickOverlay.video.paused, true, "Kick overlay must retain its controller-first delay");
    await new Promise((resolve) => setTimeout(resolve, 170));
    assert.equal(kickOverlay.video.paused, false, "a player surface or explicit Play overlay must still recover after a real block");
    assert.equal(kickOverlay.video.playCalls, 2, "valid Kick overlay adds exactly one fallback Play");
  }

  const relatedKickDisabled = createHarness({
    configureImmediately: false,
    applyToKick: false,
    applyToOtherSites: true,
    hostname: "",
    pathname: "blank",
    referrer: "https://kick.com/channel-a",
    ancestorOrigins: ["https://kick.com"],
  });
  const relatedReleasedPlay = relatedKickDisabled.video.play();
  assert.equal(relatedKickDisabled.video.playCalls, 0, "related Kick frame must wait while Kick settings are unknown");
  relatedKickDisabled.configure(true, false);
  await relatedReleasedPlay;
  assert.equal(relatedKickDisabled.video.paused, false, "related Kick frame must respect the disabled Kick switch, not the generic all-sites mode");

  const ownerLocation = new URL("https://kick.com/channel-a");
  const relatedKickEnabled = createHarness({
    applyToKick: true,
    hostname: "",
    pathname: "blank",
    referrer: "https://kick.com/channel-a",
    ownerLocation,
    ancestorOrigins: ["https://kick.com"],
  });
  await relatedKickEnabled.video.play();
  assert.equal(relatedKickEnabled.video.paused, true, "enabled Kick must block autoplay in a related frame");
  relatedKickEnabled.windowTarget.addEventListener("click", () => relatedKickEnabled.video.play());
  relatedKickEnabled.windowTarget.dispatchEvent(trustedPlayerPointer(relatedKickEnabled.video));
  relatedKickEnabled.windowTarget.dispatchEvent(trustedPlayerClick(relatedKickEnabled.video));
  await Promise.resolve();
  assert.equal(relatedKickEnabled.video.paused, false, "related Kick frame must keep controller-first playback");

  relatedKickEnabled.video.pause();
  ownerLocation.pathname = "/channel-b";
  await relatedKickEnabled.video.play();
  assert.equal(relatedKickEnabled.video.paused, true, "related Kick permission must be scoped to the owner route");
  ownerLocation.pathname = "/channel-a";
  await relatedKickEnabled.video.play();
  assert.equal(relatedKickEnabled.video.paused, true, "returning to a route must not restore an old playback permission");

  await Promise.resolve();
});
