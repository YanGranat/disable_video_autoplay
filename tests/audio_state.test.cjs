const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness, requestPlayback, trustedPlayerPointer } = require("./helpers/playback.cjs");

for (const hostname of ["www.twitch.tv", "kick.com"]) {
  test(`${hostname} restores the blocked video's exact audio state, not a fixed level`, async () => {
    for (const [muted, volume] of [[true, 0], [true, 0.2], [false, 0.2], [false, 0.5], [false, 0]]) {
      const h = createHarness({ hostname });
      h.video.muted = muted;
      h.video.volume = volume;
      await h.video.play();
      h.video.muted = true;
      h.video.volume = 0;
      h.advanceTime(10);
      h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
      await h.video.play();
      assert.equal(h.video.muted, muted);
      assert.equal(h.video.volume, volume);
    }
  });

  test(`${hostname} leaves a deliberate audio change under controller ownership`, async () => {
    const h = createHarness({ hostname });
    h.video.volume = 0.2;
    await h.video.play();
    h.windowTarget.dispatchEvent({ type: "keydown", isTrusted: true, key: "m", target: h.document.body,
      composedPath: () => [h.document.body] });
    h.video.muted = true;
    h.video.volume = 0;
    h.advanceTime(10);
    h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
    await h.video.play();
    assert.equal(h.video.muted, true);
    assert.equal(h.video.volume, 0);
  });
}

test("a new source keeps its own audio state instead of an earlier pointer preference", async () => {
  for (const hostname of ["www.youtube.com", "video.example"]) {
    const h = createHarness({ hostname, pathname: "/watch", search: "?v=first" });
    await requestPlayback(h.video);
    h.advanceTime(10);
    h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
    await requestPlayback(h.video);
    h.video.volume = 1;
    h.video.muted = false;
    h.video.dispatchEvent({ type: "volumechange" });
    h.video.pause();
    h.location.pathname = hostname.includes("youtube") ? "/watch" : "/another";
    h.location.search = "?v=second";
    h.location.href = `https://${hostname}${h.location.pathname}?v=second`;
    await requestPlayback(h.video);
    h.video.muted = true;
    h.video.volume = 0.47;
    h.advanceTime(2000);
    h.windowTarget.dispatchEvent(trustedPlayerPointer(h.video));
    await requestPlayback(h.video);
    assert.equal(h.video.muted, true);
    assert.equal(h.video.volume, 0.47);
  }
});
