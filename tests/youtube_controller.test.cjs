const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness, FakeCustomEvent, trustedPlayerPointer, trustedPlayerClick, copiedConsoleText } = require("./helpers/playback.cjs");

function controller(h, initial = "one") {
  let id = initial;
  const player = {
    getVideoData: () => ({ video_id: id }),
    classList: { contains: () => false },
  };
  h.video.closest = selector => selector.includes("#movie_player") ? player : null;
  return { setId: value => { id = value; }, player };
}

for (const outcome of ["ready", "expired", "new-pointer", "new-click", "new-route", "disabled", "disarmed"]) {
  test(`pending controller Play is route-scoped and cancellable: ${outcome}`, async () => {
    const h = createHarness({ hostname: "www.youtube.com", pathname: "/watch", search: "?v=two" });
    const player = controller(h, "one");
    h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
    h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
    h.windowTarget.dispatchEvent(trustedPlayerClick(h.video));
    await assert.rejects(h.video.play(), { name: "NotAllowedError" });
    assert.equal(h.video.playCalls, 0);
    if (outcome === "new-pointer") h.windowTarget.dispatchEvent({ ...trustedPlayerPointer(h.video), target: h.document.body, composedPath: () => [h.document.body] });
    if (outcome === "new-click") h.windowTarget.dispatchEvent({ ...trustedPlayerClick(h.video), target: h.document.body, composedPath: () => [h.document.body] });
    if (outcome === "new-route") { h.location.search = "?v=three"; h.location.href = "https://www.youtube.com/watch?v=three"; }
    if (outcome === "disabled") {
      for (const enabled of [false, true]) h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-config", { detail: { enabled } }));
    }
    if (outcome === "disarmed") {
      for (const type of ["ytap-disarm", "ytap-arm"]) h.windowTarget.dispatchEvent(new FakeCustomEvent(type));
    }
    h.advanceTime(outcome === "expired" ? 5001 : 2000);
    player.setId(outcome === "new-route" ? "three" : "two");
    h.video.currentSrc = "blob:prepared-stream";
    h.video.readyState = 0;
    if (outcome === "ready") {
      await assert.doesNotReject(h.video.play());
      assert.equal(h.video.playCalls, 1);
      assert.equal(h.video.paused, false);
    } else {
      await assert.rejects(h.video.play(), { name: "NotAllowedError" });
      assert.equal(h.video.playCalls, 0);
    }
  });
}

test("trusted click-only input is recorded after synchronizing a late route", async () => {
  const h = createHarness({ hostname: "www.youtube.com", pathname: "/embed/one" });
  await assert.rejects(h.video.play(), { name: "NotAllowedError" });
  h.location.pathname = "/embed/two";
  h.location.href = "https://www.youtube.com/embed/two";
  h.windowTarget.dispatchEvent(trustedPlayerClick(h.video));
  await assert.doesNotReject(h.video.play());
  assert.equal(h.video.playCalls, 1);
  assert.equal(h.video.paused, false);
});

test("ad and unavailable controller metadata do not become false content mismatches", async () => {
  for (const kind of ["ad", "missing", "throwing"]) {
    const h = createHarness({ hostname: "www.youtube.com", pathname: "/watch", search: "?v=two" });
    const { player } = controller(h, "one");
    if (kind === "ad") player.classList.contains = name => name === "ad-showing";
    if (kind === "missing") player.getVideoData = undefined;
    if (kind === "throwing") player.getVideoData = () => { throw new Error("unavailable"); };
    h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
    await assert.rejects(h.video.play(), { name: "NotAllowedError" });
    h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
    h.windowTarget.dispatchEvent(trustedPlayerClick(h.video));
    await assert.doesNotReject(h.video.play());
    assert.equal(h.video.playCalls, 1);
  }
});

test("classic YouTube uses controller-owned Play and Pause after an autoplay denial", async () => {
  const h = createHarness({ hostname: "www.youtube.com", pathname: "/watch", search: "?v=one", debug: true });
  controller(h);
  h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
  await assert.rejects(h.video.play(), { name: "NotAllowedError" });
  assert.equal(h.video.playCalls, 0);
  let clicks = 0;
  let play;
  h.windowTarget.addEventListener("click", () => {
    clicks++;
    if (h.video.paused) play = h.video.play(); else h.video.pause();
  });
  const down = trustedPlayerPointer(h.video);
  h.windowTarget.dispatchEvent(down);
  assert.equal(h.video.playCalls, 0, "pointerdown must not start the current native source");
  assert.equal(down.immediatePropagationStopped, undefined);
  h.windowTarget.dispatchEvent(trustedPlayerClick(h.video));
  assert.equal(clicks, 1, "the first playback click must reach its controller");
  await assert.doesNotReject(play);
  assert.equal(h.video.playCalls, 1);
  assert.equal(h.video.paused, false);
  h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
  h.windowTarget.dispatchEvent(trustedPlayerClick(h.video));
  assert.equal(clicks, 2);
  assert.equal(h.video.paused, true);
  assert.equal(h.video.playCalls, 1);
  assert.match(copiedConsoleText(h.consoleEntries), /YouTube controls: delegated click profile=youtube-classic/);
});

test("a newly selected route cannot start the previous controller content", async () => {
  const h = createHarness({ hostname: "www.youtube.com", pathname: "/watch", search: "?v=one", debug: true });
  const player = controller(h);
  h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
  await assert.rejects(h.video.play(), { name: "NotAllowedError" });
  h.location.search = "?v=two";
  h.location.href = "https://www.youtube.com/watch?v=two";
  h.windowTarget.dispatchEvent(new FakeCustomEvent("yt-navigate-start"));
  h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
  h.windowTarget.dispatchEvent(trustedPlayerClick(h.video));
  await assert.rejects(h.video.play(), { name: "NotAllowedError" });
  assert.equal(h.video.playCalls, 0, "stale controller content must not reach native play");
  assert.equal(h.video.paused, true);
  player.setId("two");
  h.video.currentSrc = "blob:next-stream";
  h.video.readyState = 0;
  await assert.doesNotReject(h.video.play());
  assert.equal(h.video.playCalls, 1, "the prepared controller source must consume the existing input once");
  assert.equal(h.video.paused, false);
  const text = copiedConsoleText(h.consoleEntries);
  assert.match(text, /YouTube autoplay denied.*reason=stale-content/);
  assert.doesNotMatch(text, /watch\?v=|next-stream/);
});

test("a stale controller is passive outside the enabled scope", async () => {
  for (const config of [{ enabled: false }, { applyToYouTube: false }]) {
    const h = createHarness({ hostname: "www.youtube.com", pathname: "/watch", search: "?v=two", ...config });
    controller(h, "one");
    if (config.applyToYouTube === false) h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-config", { detail: config }));
    await assert.doesNotReject(h.video.play());
    assert.equal(h.video.paused, false);
    assert.equal(h.video.playCalls, 1);
  }
});
