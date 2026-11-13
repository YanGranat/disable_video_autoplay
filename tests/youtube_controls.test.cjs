const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness, requestPlayback, trustedOverlayEvent, trustedPlayerPointer, copiedConsoleText } = require("./helpers/playback.cjs");

function controls(className, insideControls = true) {
  const host = {
    nodeType: 1, tagName: "YTM-CUSTOM-CONTROL",
    classList: { contains: () => false },
    matches: (selector) => selector === "ytm-custom-control",
    closest: (selector) => insideControls && selector.includes("ytm-custom-control") ? host : null,
    getAttribute: () => "",
  };
  const button = {
    nodeType: 1, tagName: "BUTTON", className,
    classList: { contains: (token) => className.split(" ").includes(token) },
    matches: () => false,
    closest: (selector) => insideControls && selector.includes("ytm-custom-control") ? host : null,
    getAttribute: () => "",
  };
  const icon = { ...button, tagName: "DIV", className: "", classList: { contains: () => false } };
  const event = (kind) => ({ ...trustedOverlayEvent(kind, icon), composedPath: () => insideControls ? [icon, button, host] : [icon, button] });
  return { event };
}

for (const className of ["player-control-play-pause-icon", "ytmCuedOverlayPlayButton"]) {
  for (const blockFirst of [false, true]) {
    test(`YouTube custom ${className} delegates one start and the next Pause to its controller, blocked=${blockFirst}`, async () => {
      const h = createHarness({ hostname: "www.youtube.com", pathname: "/embed/example", debug: true });
      if (blockFirst) {
        await requestPlayback(h.video);
        assert.equal(h.video.paused, true);
        assert.equal(h.video.playCalls, 0, "blocked requests must not reach native play");
      }
      h.advanceTime(10);
      const input = controls(className);
      let controllerClicks = 0;
      h.windowTarget.addEventListener("click", () => {
        controllerClicks++;
        if (h.video.paused) h.video.play(); else h.video.pause();
      });
      const down = input.event("pointerdown");
      h.windowTarget.dispatchEvent(down);
      assert.equal(h.video.playCalls, 0, "pointerdown must not bypass the custom controller");
      h.windowTarget.dispatchEvent(input.event("click"));
      assert.equal(controllerClicks, 1, "the native controller must receive the first click");
      assert.equal(h.video.paused, false, "the first controller Play must start media");
      assert.equal(h.video.playCalls, 1, "manual Play must reach native playback exactly once");
      h.advanceTime(10);
      h.windowTarget.dispatchEvent(input.event("pointerdown"));
      h.windowTarget.dispatchEvent(input.event("click"));
      assert.equal(controllerClicks, 2);
      assert.equal(h.video.paused, true, "the next independent click must pause");
      assert.equal(h.video.playCalls, 1, "Pause must not trigger another native start");
      assert.match(copiedConsoleText(h.consoleEntries), /YouTube controls: delegated click profile=youtube-custom mediaId=m1/);
    });
  }
}

test("YouTube custom non-play controls and matching classes outside the player cannot release autoplay", async () => {
  for (const [className, inside] of [
    ["player-settings-icon", true], ["fullscreen-icon", true], ["ytdVolumeControlsMuteIconButton", true],
    ["ytmClosedCaptioningButtonButton", true], ["player-control-seek-icon-a11y", true],
    ["ytmVideoInfoChannelAvatar", true], ["", true], ["player-control-play-pause-icon", false],
  ]) {
    const h = createHarness({ hostname: "www.youtube.com", pathname: "/embed/example" });
    await requestPlayback(h.video);
    h.advanceTime(10);
    const input = controls(className, inside);
    h.windowTarget.dispatchEvent(input.event("pointerdown"));
    h.windowTarget.dispatchEvent(input.event("click"));
    await requestPlayback(h.video);
    assert.equal(h.video.paused, true, className);
    assert.equal(h.video.playCalls, 0, "non-play inputs must not start blocked media");
  }
});

test("YouTube custom keyboard activation works without pointerdown and permission expires on navigation", async () => {
  const h = createHarness({ hostname: "www.youtube.com", pathname: "/embed/example" });
  await requestPlayback(h.video);
  h.advanceTime(10);
  const input = controls("player-control-play-pause-icon");
  let controllerClicks = 0;
  h.windowTarget.addEventListener("click", () => { controllerClicks++; h.video.play(); });
  h.windowTarget.dispatchEvent(input.event("click"));
  assert.equal(controllerClicks, 1);
  assert.equal(h.video.paused, false);
  assert.equal(h.video.playCalls, 1);
  h.video.pause();
  h.location.pathname = "/embed/another";
  h.location.href = "https://www.youtube.com/embed/another";
  await requestPlayback(h.video);
  assert.equal(h.video.paused, true, "a new embed route must not inherit manual permission");
  assert.equal(h.video.playCalls, 1);
});

test("a blocked YouTube custom player receives an autoplay denial without native playback", async () => {
  const h = createHarness({ hostname: "www.youtube.com", pathname: "/embed/example", debug: true });
  const originalQuery = h.document.querySelector;
  h.document.querySelector = (selector) => selector.includes("ytm-custom-control") ? {} : originalQuery(selector);
  await assert.rejects(h.video.play(), { name: "NotAllowedError" });
  assert.equal(h.video.paused, true);
  assert.equal(h.video.playCalls, 0, "denial must never briefly start native playback");
  assert.match(copiedConsoleText(h.consoleEntries), /YouTube autoplay denied profile=youtube-custom.*mediaId=m1/);
  h.advanceTime(10);
  const input = controls("ytmCuedOverlayPlayButton");
  let result;
  h.windowTarget.addEventListener("click", () => { result = h.video.play(); });
  h.windowTarget.dispatchEvent(input.event("pointerdown"));
  h.windowTarget.dispatchEvent(input.event("click"));
  await result;
  assert.equal(h.video.paused, false, "the same controller's trusted manual request must succeed");
  assert.equal(h.video.playCalls, 1);
});

test("a custom click-only Pause is not consumed by an earlier surface pointer sequence", async () => {
  const h = createHarness({ hostname: "www.youtube.com", pathname: "/embed/example" });
  await requestPlayback(h.video);
  h.advanceTime(10);
  h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
  await requestPlayback(h.video);
  assert.equal(h.video.paused, false);
  h.advanceTime(10);
  let controllerClicks = 0;
  const input = controls("player-control-play-pause-icon");
  h.windowTarget.addEventListener("click", () => { controllerClicks++; h.video.pause(); });
  h.windowTarget.dispatchEvent(input.event("click"));
  assert.equal(controllerClicks, 1, "custom Pause must reach the site despite an unfinished surface pointer");
  assert.equal(h.video.paused, true);
});

test("held custom-player requests use the final autoplay result after settings arrive", async () => {
  for (const enabled of [false, true]) {
    const h = createHarness({ hostname: "www.youtube.com", pathname: "/embed/example", configureImmediately: false, enabled });
    const originalQuery = h.document.querySelector;
    h.document.querySelector = (selector) => selector.includes("ytm-custom-control") ? {} : originalQuery(selector);
    const pending = h.video.play();
    const settled = enabled ? assert.rejects(pending, { name: "NotAllowedError" }) : pending;
    assert.equal(h.video.playCalls, 0);
    h.configure();
    await settled;
    assert.equal(h.video.paused, enabled);
    assert.equal(h.video.playCalls, enabled ? 0 : 1);
  }
});

test("startup denial remains consistent across controller replacements", async () => {
  for (const customAtSettlement of [false, true]) {
    const h = createHarness({ hostname: "www.youtube.com", pathname: "/embed/example", configureImmediately: false });
    let custom = !customAtSettlement;
    const originalQuery = h.document.querySelector;
    h.document.querySelector = (selector) => selector.includes("ytm-custom-control") ? custom ? {} : null : originalQuery(selector);
    const first = h.video.play();
    const second = h.video.play();
    const pending = [first, second].map(request => assert.rejects(request, { name: "NotAllowedError" }));
    custom = customAtSettlement;
    h.configure();
    await Promise.all(pending);
    assert.equal(h.video.playCalls, 0, "startup must not transiently play either player variant");
    assert.equal(h.video.paused, true);
    await assert.rejects(h.video.play(), { name: "NotAllowedError" });
    assert.equal(h.video.playCalls, 0, "immediate and held requests must share the controller contract");
  }
});

test("blocked requests follow controller replacement without retaining an earlier profile", async () => {
  const h = createHarness({ hostname: "www.youtube.com", pathname: "/embed/example" });
  const originalQuery = h.document.querySelector;
  let custom = false;
  h.document.querySelector = (selector) => selector.includes("ytm-custom-control") ? custom ? {} : null : originalQuery(selector);
  await requestPlayback(h.video);
  custom = true;
  await assert.rejects(h.video.play(), { name: "NotAllowedError" });
  custom = false;
  await requestPlayback(h.video);
  assert.equal(h.video.playCalls, 0);
  assert.equal(h.video.paused, true);
});
