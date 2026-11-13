const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness, FakeCustomEvent, trustedPlayerPointer, trustedPlayerClick, trustedOverlayEvent, fakePlayerOverlay, fakePlayControl } = require("./helpers/playback.cjs");
const waitForFallback = () => new Promise(resolve => setTimeout(resolve, 420));

for (const kind of ["button", "role-button", "text"]) {
  test(`a generic ${kind} overlay does not authorize or recover playback`, async () => {
    const h = createHarness({ hostname: "video.example" });
    await h.video.play();
    assert.equal(h.video.paused, true);
    const calls = h.video.playCalls;
    const overlay = {
      ...fakePlayerOverlay(),
      tagName: kind === "button" ? "BUTTON" : kind === "text" ? "SPAN" : "DIV",
      getAttribute: name => name === "role" && kind === "role-button" ? "button" : "",
    };
    h.windowTarget.dispatchEvent(trustedOverlayEvent("pointerdown", overlay));
    h.windowTarget.dispatchEvent(trustedOverlayEvent("click", overlay));
    await waitForFallback();
    assert.equal(h.video.playCalls, calls, "unrelated input must not trigger a native recovery");
    assert.equal(h.video.paused, true);
    await h.video.play();
    assert.equal(h.video.paused, true, "a later site Play must not inherit unrelated input permission");
  });
}

for (const target of ["video", "play-control"]) {
  test(`generic ${target} input retains explicit playback recovery`, async () => {
    const h = createHarness({ hostname: "video.example" });
    await h.video.play();
    const calls = h.video.playCalls;
    const control = target === "video" ? h.video : fakePlayControl();
    h.windowTarget.dispatchEvent(target === "video" ? trustedPlayerPointer(h.video) : trustedOverlayEvent("pointerdown", control));
    h.windowTarget.dispatchEvent(target === "video" ? trustedPlayerClick(h.video) : trustedOverlayEvent("click", control));
    await waitForFallback();
    assert.equal(h.video.playCalls, calls + 1);
    assert.equal(h.video.paused, false);
  });
}

for (const platform of ["generic", "twitch", "kick"]) {
  test(`enabling ${platform} coverage preserves existing playback without permitting a new route`, async () => {
    const hostname = platform === "generic" ? "video.example" : platform === "twitch" ? "www.twitch.tv" : "kick.com";
    const h = createHarness({ hostname, enabled: false, applyToTwitch: true, applyToKick: true });
    await h.video.play();
    assert.equal(h.video.paused, false);
    const pauses = h.video.pauseCalls;
    h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-config", { detail: { enabled: true } }));
    h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
    await Promise.resolve();
    assert.equal(h.video.pauseCalls, pauses, "activation must not pause an existing stream");
    assert.equal(h.video.paused, false);
    await h.video.play();
    assert.equal(h.video.paused, false);
    h.location.pathname = "/next";
    h.location.href = `https://${hostname}/next`;
    await h.video.play();
    assert.equal(h.video.paused, true, "the next route must still reject autoplay");
  });
}

test("enabling a dedicated platform preserves an already-playing stream", async () => {
  const h = createHarness({ hostname: "www.twitch.tv", applyToTwitch: false });
  await h.video.play();
  const pauses = h.video.pauseCalls;
  h.configure(true);
  h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
  await Promise.resolve();
  assert.equal(h.video.paused, false);
  assert.equal(h.video.pauseCalls, pauses);
  await h.video.play();
  assert.equal(h.video.paused, false);
});

test("activation grants permission only to videos already playing on a generic page", async () => {
  const h = createHarness({ hostname: "video.example", enabled: false });
  await h.video.play();
  h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-config", { detail: { enabled: true } }));
  const other = h.createVideo();
  await other.play();
  assert.equal(other.paused, true);
  assert.equal(h.video.paused, false);
});

test("a settings refresh after navigation does not adopt media when coverage was already enabled", async () => {
  const h = createHarness({ hostname: "video.example" });
  await h.video.play();
  h.advanceTime(10);
  h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
  await h.video.play();
  h.location.pathname = "/next";
  h.location.href = "https://video.example/next";
  h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-config", { detail: { enabled: true } }));
  h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
  await Promise.resolve();
  assert.equal(h.video.paused, true);
});

for (const hostname of ["video.example", "www.twitch.tv", "kick.com"]) {
  test(`activation preserves playback started on the current route while disabled: ${hostname}`, async () => {
    const h = createHarness({ hostname, enabled: false, applyToTwitch: true, applyToKick: true });
    await h.video.play();
    h.location.pathname = "/selected";
    h.location.href = `https://${hostname}/selected`;
    await h.video.play();
    h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-config", { detail: { enabled: true } }));
    h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
    await Promise.resolve();
    assert.equal(h.video.paused, false, "settings activation must preserve playback already in progress");
    h.location.pathname = "/next";
    h.location.href = `https://${hostname}/next`;
    await h.video.play();
    assert.equal(h.video.paused, true, "a subsequent navigation must still invalidate permission");
  });
}

test("ordinary player input does not emit a navigation bridge signal", () => {
  for (const hostname of ["video.example", "www.twitch.tv", "www.youtube.com"]) {
    const h = createHarness({ hostname, pathname: "/watch", search: "?v=one" });
    let signals = 0;
    h.windowTarget.addEventListener("ytap-gesture", () => signals++);
    h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
    h.windowTarget.dispatchEvent(trustedPlayerClick(h.video));
    assert.equal(signals, 0, hostname);
  }
});
