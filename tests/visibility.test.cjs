const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness, trustedPlayerPointer } = require("./helpers/playback.cjs");

function visibility(h, hidden) {
  h.document.hidden = hidden;
  h.document.dispatchEvent({ type: "visibilitychange" });
}

async function start(h, video = h.video) {
  await video.play();
  h.advanceTime(10);
  h.windowTarget.dispatchEvent(trustedPlayerPointer(video));
  await video.play();
}

for (const pauseOnHidden of [false, true]) {
  test(`manual Pause survives tab visibility changes, pause-on-hidden=${pauseOnHidden}`, async () => {
    const h = createHarness({ hostname: "video.example", resumeOnVisible: true, pauseOnHidden });
    await start(h);
    h.video.pause();
    const plays = h.video.playCalls;
    visibility(h, true);
    visibility(h, false);
    assert.equal(h.video.paused, true);
    assert.equal(h.video.playCalls, plays);
  });
}

test("visibility resumes only playback actually paused by the extension", async () => {
  const h = createHarness({ hostname: "video.example", resumeOnVisible: true, pauseOnHidden: true });
  await start(h);
  visibility(h, true);
  assert.equal(h.video.paused, true);
  const plays = h.video.playCalls;
  visibility(h, false);
  assert.equal(h.video.paused, false);
  assert.equal(h.video.playCalls, plays + 1);
  visibility(h, false);
  assert.equal(h.video.playCalls, plays + 1, "one hidden pause cannot resume twice");
});

test("visibility uses the manually playing video rather than the first element", async () => {
  const h = createHarness({ hostname: "video.example", resumeOnVisible: true, pauseOnHidden: true });
  const second = h.createVideo();
  const originalQuery = h.document.querySelectorAll;
  h.document.querySelectorAll = (selector) => selector === "video" ? [h.video, second] : originalQuery(selector);
  await start(h, second);
  visibility(h, true);
  assert.equal(second.paused, true);
  visibility(h, false);
  assert.equal(second.paused, false);
  assert.equal(h.video.playCalls, 0);
});

test("automatic channel exemptions do not count as manual visibility playback", async () => {
  const h = createHarness({ hostname: "www.youtube.com", pathname: "/watch", search: "?v=example", resumeOnVisible: true, pauseOnHidden: true });
  h.windowTarget.dispatchEvent({ type: "ytap-resume" });
  await Promise.resolve();
  assert.equal(h.video.paused, false);
  visibility(h, true);
  visibility(h, false);
  assert.equal(h.video.paused, true);
});

for (const cancellation of ["route", "source", "disconnect", "input", "pause"]) {
  test(`visibility recovery is cancelled by ${cancellation}`, async () => {
    const h = createHarness({ hostname: "video.example", resumeOnVisible: true, pauseOnHidden: true });
    await start(h);
    visibility(h, true);
    const plays = h.video.playCalls;
    if (cancellation === "route") {
      h.location.pathname = "/another";
      h.location.href = "https://video.example/another";
    } else if (cancellation === "source") h.video.src = "https://video.example/another.webm";
    else if (cancellation === "disconnect") h.video.isConnected = false;
    else if (cancellation === "input") h.windowTarget.dispatchEvent(trustedPlayerPointer(h.document.body));
    else {
      h.video.dispatchEvent({ type: "pause" });
      h.video.dispatchEvent({ type: "pause" });
    }
    visibility(h, false);
    assert.equal(h.video.playCalls, plays);
    assert.equal(h.video.paused, true);
  });
}
