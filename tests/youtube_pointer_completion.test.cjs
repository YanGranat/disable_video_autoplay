const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness, requestPlayback, FakeCustomEvent, trustedPlayerPointer, trustedPlayerClick, copiedConsoleText } = require("./helpers/playback.cjs");

async function pendingPointer({ debug = false } = {}) {
  const h = createHarness({ hostname: "www.youtube.com", pathname: "/watch", search: "?v=one", debug });
  h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
  await requestPlayback(h.video);
  assert.equal(h.video.paused, true);
  assert.equal(h.video.playCalls, 0);
  h.advanceTime(10);
  const outer = {
    nodeType: 1, tagName: "DIV", matches: () => false, closest: () => null,
    getAttribute: () => null, contains: node => node === h.video,
  };
  const path = [h.video, outer];
  h.windowTarget.dispatchEvent({ ...trustedPlayerPointer(h.video), pointerId: 1, pointerType: "mouse", button: 0, composedPath: () => path });
  assert.equal(h.video.playCalls, 0);
  assert.equal(h.video.paused, true);
  return { ...h, outer };
}

function retargetedClick(h, fields = {}) {
  return {
    ...trustedPlayerClick(h.video), pointerId: 1, pointerType: "mouse", button: 0, detail: 1,
    target: h.outer, composedPath: () => [h.outer],
    preventDefault() { this.defaultPrevented = true; },
    ...fields,
  };
}

test("a retargeted click remains controller-owned without a premature native start", async () => {
  const h = await pendingPointer({ debug: true });
  let siteClicks = 0;
  let play;
  h.windowTarget.addEventListener("click", () => { siteClicks++; play = h.video.play(); });
  h.advanceTime(750);
  const click = retargetedClick(h);
  h.windowTarget.dispatchEvent(click);
  await play;
  assert.equal(siteClicks, 1, "the controller must own its complete playback action");
  assert.equal(click.immediatePropagationStopped, undefined);
  assert.equal(click.defaultPrevented, undefined);
  assert.equal(h.video.playCalls, 1);
  assert.equal(h.video.paused, false);
  assert.doesNotMatch(copiedConsoleText(h.consoleEntries), /Proactive play|click swallowed/);
});

for (const mismatch of ["new-pointer", "other-pointer", "other-device", "missing-pointer", "keyboard", "synthetic", "modified", "button", "cancelled", "new-route", "expired", "unrelated-target", "disconnected"]) {
  test(`an unrelated YouTube completion remains site-controlled: ${mismatch}`, async () => {
    const h = await pendingPointer();
    let siteClicks = 0;
    h.windowTarget.addEventListener("click", () => { siteClicks++; });
    const click = retargetedClick(h);
    if (mismatch === "new-pointer") h.windowTarget.dispatchEvent({ ...trustedPlayerPointer(h.video), target: h.outer, composedPath: () => [h.outer], pointerId: 1, button: 0 });
    if (mismatch === "other-pointer") click.pointerId = 2;
    if (mismatch === "other-device") click.pointerType = "touch";
    if (mismatch === "missing-pointer") delete click.pointerId;
    if (mismatch === "keyboard") { click.pointerId = -1; click.pointerType = ""; click.detail = 0; }
    if (mismatch === "synthetic") click.isTrusted = false;
    if (mismatch === "modified") click.ctrlKey = true;
    if (mismatch === "button") h.outer.getAttribute = name => name === "role" ? "button" : null;
    if (mismatch === "cancelled") h.windowTarget.dispatchEvent({ type: "pointercancel", isTrusted: true, pointerId: 1 });
    if (mismatch === "new-route") { h.location.search = "?v=two"; h.location.href = "https://www.youtube.com/watch?v=two"; }
    if (mismatch === "expired") h.advanceTime(5001);
    if (mismatch === "unrelated-target") { const target = { ...h.outer }; click.target = target; click.composedPath = () => [target]; }
    if (mismatch === "disconnected") h.video.isConnected = false;
    h.windowTarget.dispatchEvent(click);
    assert.equal(siteClicks, 1);
    assert.equal(click.immediatePropagationStopped, undefined);
    assert.equal(click.defaultPrevented, undefined);
    assert.equal(h.video.playCalls, 0, "an unrelated completion must not create a native start");
  });
}

test("a completed retargeted click does not consume a later independent Pause", async () => {
  const h = await pendingPointer();
  h.windowTarget.addEventListener("click", () => {
    if (h.video.paused) requestPlayback(h.video); else h.video.pause();
  });
  h.windowTarget.dispatchEvent(retargetedClick(h));
  h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
  h.windowTarget.dispatchEvent(trustedPlayerClick(h.video));
  assert.equal(h.video.paused, true);
  assert.equal(h.video.playCalls, 1);
});

test("a pointer cancellation does not make the extension consume site input", async () => {
  const h = await pendingPointer();
  h.windowTarget.dispatchEvent({ type: "pointercancel", isTrusted: true, pointerId: 2 });
  const click = retargetedClick(h);
  h.windowTarget.dispatchEvent(click);
  assert.equal(click.immediatePropagationStopped, undefined);
  assert.equal(h.video.playCalls, 0);
});

test("copied playback events preserve the media clock and network state without source URLs", async () => {
  const h = createHarness({ hostname: "www.youtube.com", pathname: "/watch", search: "?v=one", debug: true });
  h.windowTarget.dispatchEvent(new FakeCustomEvent("yt-navigate-start"));
  await requestPlayback(h.video);
  h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
  await requestPlayback(h.video);
  h.video.currentTime = 12.5;
  h.video.networkState = 2;
  h.video.dispatchEvent({ type: "playing" });
  h.video.currentTime = 0;
  h.video.currentSrc = "https://media.example/private-source";
  h.video.readyState = 0;
  h.video.dispatchEvent({ type: "emptied" });
  const text = copiedConsoleText(h.consoleEntries);
  assert.match(text, /VIDEO: playing mediaId=m1 sourceId=s1.*time=12.50 networkState=2/);
  assert.match(text, /VIDEO: emptied mediaId=m1 sourceId=s2.*time=0.00 networkState=2/);
  assert.doesNotMatch(text, /media\.example|private-source/);
});
