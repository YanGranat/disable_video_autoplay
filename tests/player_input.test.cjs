const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness, requestPlayback, trustedPlayerPointer, trustedExternalControlEvent } = require("./helpers/playback.cjs");

for (const control of ["settings", "progress", "mute", "fullscreen"]) {
  test(`classic YouTube ${control} input stays site-owned without authorizing playback`, async () => {
    const h = createHarness({ hostname: "www.youtube.com", pathname: "/watch", search: "?v=example" });
    await requestPlayback(h.video);
    h.advanceTime(10);
    const panel = { nodeType: 1, tagName: "DIV", matches: (selector) => selector === ".ytp-chrome-bottom",
      closest: (selector) => selector.includes("#movie_player") || selector.includes(".ytp-chrome-bottom") ? panel : null,
      classList: { contains: () => false }, getAttribute: () => "" };
    const button = { ...panel, tagName: "BUTTON", className: `ytp-${control}-button`, matches: () => false };
    const path = [button, panel];
    h.document.activeElement = { closest: () => panel };
    let controllerActions = 0;
    h.windowTarget.addEventListener("click", () => { controllerActions++; });
    h.windowTarget.dispatchEvent(trustedExternalControlEvent("pointerdown", button, path));
    h.windowTarget.dispatchEvent(trustedExternalControlEvent("click", button, path));
    assert.equal(controllerActions, 1, "non-play actions must reach the controller");
    assert.equal(h.video.paused, true);
    assert.equal(h.video.playCalls, 0);
    await requestPlayback(h.video);
    assert.equal(h.video.paused, true, "a later automatic request must not inherit non-play intent");
    assert.equal(h.video.playCalls, 0);
    h.advanceTime(10);
    h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
    await requestPlayback(h.video);
    assert.equal(h.video.paused, false, "a real surface Play must remain available");
    assert.equal(h.video.playCalls, 1);
  });
}

test("scripted pointer and click events cannot release blocked playback", async () => {
  for (const hostname of ["www.youtube.com", "www.twitch.tv", "kick.com", "video.example"]) {
    const h = createHarness({ hostname, pathname: hostname.includes("youtube") ? "/watch" : "/channel-a", search: "?v=example" });
    await requestPlayback(h.video);
    h.advanceTime(10);
    h.windowTarget.dispatchEvent({ ...trustedPlayerPointer(h.video), isTrusted: false });
    h.windowTarget.dispatchEvent({ ...trustedPlayerPointer(h.video), type: "click", isTrusted: false });
    await requestPlayback(h.video);
    assert.equal(h.video.paused, true, hostname);
  }
});

test("a generic player gesture cannot authorize a different media element", async () => {
  const h = createHarness({ hostname: "video.example" });
  const other = h.createVideo();
  const originalQuery = h.document.querySelectorAll;
  h.document.querySelectorAll = (selector) => selector === "video" ? [h.video, other] : originalQuery(selector);
  await h.video.play();
  await other.play();
  h.advanceTime(10);
  h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
  await other.play();
  assert.equal(other.paused, true);
  await h.video.play();
  assert.equal(h.video.paused, false);
});

test("expired player gestures do not release autoplay", async () => {
  const h = createHarness({ hostname: "video.example" });
  await h.video.play();
  h.advanceTime(10);
  h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
  h.advanceTime(1501);
  await h.video.play();
  assert.equal(h.video.paused, true);
});

test("unrelated page controls cannot use the document body as a recovery target", async () => {
  for (const [label, className] of [["Start trial", ""], ["Watch updates", ""], ["Download", "application-play-badge"], ["Play", ""]]) {
    const h = createHarness({ hostname: "video.example" });
    await h.video.play();
    h.advanceTime(10);
    const button = { nodeType: 1, tagName: "BUTTON", className, classList: { contains: () => false },
      matches: () => false, closest: () => null, getAttribute: (name) => name === "aria-label" ? label : "" };
    const body = { nodeType: 1, tagName: "BODY", querySelectorAll: () => [h.video], matches: () => false, closest: () => null };
    const path = [button, body];
    h.windowTarget.dispatchEvent(trustedExternalControlEvent("pointerdown", button, path));
    h.windowTarget.dispatchEvent(trustedExternalControlEvent("click", button, path));
    await new Promise((resolve) => setTimeout(resolve, 390));
    assert.equal(h.video.paused, true, `${label} must not trigger native recovery`);
    assert.equal(h.video.playCalls, 1);
  }
});
