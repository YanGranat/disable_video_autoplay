const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness, FakeCustomEvent, trustedPlayerPointer, trustedPlayerClick, copiedConsoleText } = require("./helpers/playback.cjs");

function playerFor(h) {
  let ad = false;
  const player = { classList: { contains: () => ad }, getVideoData: () => ({ video_id: "one" }) };
  h.video.closest = selector => selector === "#movie_player" ? player : null;
  return { setAd: value => { ad = value; } };
}

test("copied YouTube source events retain ad, content and resource-selection evidence", () => {
  const h = createHarness({ hostname: "www.youtube.com", pathname: "/watch", search: "?v=one", debug: true });
  const player = playerFor(h);
  h.windowTarget.dispatchEvent(new FakeCustomEvent("yt-navigate-start"));
  assert.match(copiedConsoleText(h.consoleEntries), /Tracing main video events/);
  player.setAd(true);
  h.video.duration = 20;
  h.video.src = "blob:private-first-source";
  h.video.currentSrc = h.video.src;
  h.video.dispatchEvent({ type: "playing" });
  player.setAd(false);
  h.video.duration = 300;
  h.video.src = "blob:private-second-source";
  h.video.dispatchEvent({ type: "emptied" });
  h.video.currentSrc = h.video.src;
  h.video.dispatchEvent({ type: "playing" });
  const text = copiedConsoleText(h.consoleEntries);
  assert.match(text, /VIDEO: playing .*duration=20\.00.*adShowing=true.*controllerContent=unknown.*assignedMatchesCurrent=true/);
  assert.match(text, /VIDEO: emptied .*duration=300\.00.*adShowing=false.*controllerContent=current.*assignedMatchesCurrent=false/);
  assert.match(text, /VIDEO: playing .*duration=300\.00.*adShowing=false.*controllerContent=current.*assignedMatchesCurrent=true/);
  assert.match(text, /VIDEO: playing .*atMs=\d+/);
  assert.doesNotMatch(text, /private-first-source|private-second-source|watch\?v=/);
});

test("authorized native outcomes are bounded observations, not playback retries", async () => {
  const h = createHarness({ hostname: "www.youtube.com", pathname: "/watch", search: "?v=one", debug: true });
  playerFor(h);
  await assert.rejects(h.video.play(), { name: "NotAllowedError" });
  assert.equal(h.video.playCalls, 0);
  h.advanceTime(10);
  h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
  h.windowTarget.dispatchEvent(trustedPlayerClick(h.video));
  await assert.doesNotReject(h.video.play());
  h.video.pause();
  const source = h.video.currentSrc;
  for (let i = 0; i < 12; i++) await assert.doesNotReject(h.video.play());
  const text = copiedConsoleText(h.consoleEntries);
  assert.equal((text.match(/reason=authorized-controller-play/g) || []).length, 8);
  assert.equal(h.video.playCalls, 13);
  assert.equal(h.video.pauseCalls, 1);
  assert.equal(h.video.currentSrc, source);
  assert.equal(h.video.paused, false);
  assert.match(text, /YouTube manual play result.*playSeq=3/);
});

test("unmeasured ad state stays unknown without logging page-provided values", () => {
  const h = createHarness({ hostname: "www.youtube.com", pathname: "/watch", search: "?v=one", debug: true });
  const player = playerFor(h);
  player.setAd("untrusted-ad-value");
  h.windowTarget.dispatchEvent(new FakeCustomEvent("yt-navigate-start"));
  assert.match(copiedConsoleText(h.consoleEntries), /Tracing main video events/);
  h.video.dispatchEvent({ type: "playing" });
  const text = copiedConsoleText(h.consoleEntries);
  assert.match(text, /VIDEO: playing .*adShowing=unknown/);
  assert.doesNotMatch(text, /untrusted-ad-value/);
});

test("native outcome observation expires and does not survive Debug or route resets", async () => {
  for (const cancel of ["expired", "debug-off", "route-return"]) {
    const h = createHarness({ hostname: "www.youtube.com", pathname: "/watch", search: "?v=one", debug: true });
    playerFor(h);
    await assert.rejects(h.video.play(), { name: "NotAllowedError" });
    h.advanceTime(10);
    h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
    await assert.doesNotReject(h.video.play());
    if (cancel === "expired") h.advanceTime(5001);
    else if (cancel === "debug-off") for (const debug of [false, true]) h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-config", { detail: { debug } }));
    else {
      for (const id of ["two", "one"]) {
        h.location.search = "?v=" + id;
        h.location.href = "https://www.youtube.com/watch?v=" + id;
        h.windowTarget.dispatchEvent(new FakeCustomEvent("yt-navigate-start"));
      }
      h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-disarm"));
    }
    await assert.doesNotReject(h.video.play());
    assert.doesNotMatch(copiedConsoleText(h.consoleEntries), /reason=authorized-controller-play/);
    assert.equal(h.video.playCalls, 2);
  }
});

test("YouTube playback remains passive with diagnostic logging off", async () => {
  const h = createHarness({ hostname: "www.youtube.com", pathname: "/watch", search: "?v=one", debug: false });
  playerFor(h);
  await assert.rejects(h.video.play(), { name: "NotAllowedError" });
  h.advanceTime(10);
  h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
  await assert.doesNotReject(h.video.play());
  await assert.doesNotReject(h.video.play());
  assert.equal(h.video.playCalls, 2);
  assert.equal(h.video.pauseCalls, 0);
  assert.equal(h.consoleEntries.length, 0);
});
