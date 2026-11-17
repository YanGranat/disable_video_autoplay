const assert = require("node:assert/strict");
const vm = require("node:vm");
const { test } = require("node:test");
const { createHarness, requestPlayback } = require("./helpers/playback.cjs");
const { runScripts, contentScripts } = require("./load_scripts.cjs");

class TestStream {
  #tracks = [];
  getTracks() { return this.#tracks; }
}

test("live streams keep native playback, autoplay and event guards outside video blocking", async () => {
  const h = createHarness({ hostname: "video.example", autoplay: true,
    srcObject: new TestStream(), MediaStream: TestStream });
  assert.equal(h.video.autoplay, true);
  await h.video.play();
  assert.equal(h.video.playCalls, 1);
  assert.equal(h.video.paused, false);
  h.video.dispatchEvent({ type: "playing" });
  assert.equal(h.video.paused, false);
  h.video.srcObject = null;
  h.video.pause();
  await requestPlayback(h.video);
  assert.equal(h.video.paused, true, "a later recorded source must not inherit the stream exemption");
  assert.equal(h.video.playCalls, 2, "ordinary generic autoplay retains its native pause-only contract");
});

test("a non-MediaStream srcObject is not a live-stream exemption", async () => {
  const h = createHarness({ hostname: "video.example", MediaStream: TestStream, srcObject: { getTracks() { return []; } } });
  await requestPlayback(h.video);
  assert.equal(h.video.playCalls, 1);
  assert.equal(h.video.paused, true);
});

test("the initial invalidated settings reply settles a MAIN play promise through the real bridge", async () => {
  const h = createHarness({ hostname: "video.example", configureImmediately: false });
  const pending = h.video.play();
  h.context.chrome = {
    runtime: { getManifest: () => ({ version: "test" }), onMessage: { addListener() {} } },
    storage: { sync: { get: async () => { throw new Error("Extension context invalidated."); } }, onChanged: { addListener() {} } },
  };
  runScripts(h.context, contentScripts("ISOLATED"));
  const outcome = await Promise.race([pending.then(() => "settled"), new Promise(resolve => {
    const timer = setTimeout(() => resolve("timed-out"), 1000);
    timer.unref();
  })]);
  assert.equal(outcome, "settled");
  assert.equal(h.video.playCalls, 1);
  assert.equal(h.video.paused, false);
  assert.equal(vm.runInContext("typeof YTAPDomainParser", h.context), "undefined", "world bundles must keep private scopes");
});
