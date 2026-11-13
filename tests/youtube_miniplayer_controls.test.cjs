const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness, requestPlayback, FakeCustomEvent, trustedPlayerPointer, trustedPlayerClick } = require("./helpers/playback.cjs");

async function pausedMiniplayer() {
  const h = createHarness({ hostname: "www.youtube.com", pathname: "/watch", search: "?v=one&list=queue" });
  h.windowTarget.dispatchEvent(new FakeCustomEvent("ytap-arm"));
  await requestPlayback(h.video);
  assert.equal(h.video.paused, true);
  assert.equal(h.video.playCalls, 0);
  h.location.pathname = "/";
  h.location.search = "";
  h.location.href = "https://www.youtube.com/";
  h.windowTarget.dispatchEvent(new FakeCustomEvent("yt-navigate-start"));
  h.video.closest = (selector) => selector.includes("ytd-miniplayer") ? h.video : null;
  return h;
}

function playerControl(video, { tagName = "BUTTON", className = "", role = "", href = "" } = {}) {
  const player = {
    nodeType: 1, tagName: "DIV",
    classList: { contains: (name) => name === "html5-video-player" },
    matches: (selector) => selector === "#movie_player" || selector === ".html5-video-player",
    getAttribute: () => "", closest: () => null,
    contains: (node) => node === video, querySelectorAll: () => [video],
  };
  const control = {
    nodeType: 1, tagName,
    classList: { contains: (name) => name === className },
    getAttribute: (name) => name === "role" ? role : name === "href" ? href : "",
    matches: () => false,
    closest: (selector) => selector.includes("#movie_player") ? player : null,
    querySelectorAll: () => [],
  };
  const icon = { nodeType: 1, tagName: "path", matches: () => false, closest: control.closest };
  return { control, path: [icon, control, player] };
}

function input(type, path, fields = {}) {
  return {
    type, isTrusted: true, target: path[0], clientX: 100, clientY: 100,
    composedPath: () => path,
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
    preventDefault() { this.defaultPrevented = true; },
    ...fields,
  };
}

for (const [name, attributes] of [
  ["close button", { className: "ytp-miniplayer-close-button" }],
  ["unlabelled button", {}],
  ["button role", { tagName: "DIV", role: "button" }],
  ["link", { tagName: "A", href: "/watch?v=two" }],
]) {
  test(`YouTube ${name} retains its native action without starting carried media`, async () => {
    for (const pointer of [true, false]) {
      const h = await pausedMiniplayer();
      const { path } = playerControl(h.video, attributes);
      let closed = 0;
      h.windowTarget.addEventListener("click", () => { closed++; });
      const events = [...(pointer ? [input("pointerdown", path)] : []), input("click", path)];
      for (const event of events) h.windowTarget.dispatchEvent(event);
      await requestPlayback(h.video);
      assert.equal(h.video.playCalls, 0, "non-play controls must not call native play");
      assert.equal(h.video.paused, true);
      assert.equal(closed, 1, "the site must receive its click exactly once");
      for (const event of events) {
        assert.equal(event.defaultPrevented, undefined);
        assert.equal(event.immediatePropagationStopped, undefined);
      }
    }
  });
}

test("Space activates a focused non-play YouTube button without authorizing media", async () => {
  const h = await pausedMiniplayer();
  const { control, path } = playerControl(h.video, { className: "ytp-miniplayer-close-button" });
  h.document.activeElement = control;
  h.windowTarget.dispatchEvent(input("keydown", [control, ...path.slice(2)], { key: " " }));
  await requestPlayback(h.video);
  assert.equal(h.video.playCalls, 0, "button activation must not create playback permission");
  let closed = 0;
  h.windowTarget.addEventListener("click", () => { closed++; });
  h.windowTarget.dispatchEvent(input("click", [control, ...path.slice(2)], { detail: 0 }));
  assert.equal(closed, 1);
  assert.equal(h.video.paused, true);
});

test("YouTube Play controls and the video surface still start carried media", async () => {
  for (const className of ["ytp-play-button", "ytp-large-play-button", null]) {
    const h = await pausedMiniplayer();
    const path = className ? playerControl(h.video, { className }).path : [h.video];
    let play;
    h.windowTarget.addEventListener("click", () => { play = h.video.play(); });
    h.windowTarget.dispatchEvent({ ...trustedPlayerPointer(h.video), composedPath: () => path, target: path[0] });
    h.windowTarget.dispatchEvent({ ...trustedPlayerClick(h.video), composedPath: () => path, target: path[0] });
    await play;
    assert.equal(h.video.playCalls, 1, "one playback action must produce one native start");
    assert.equal(h.video.paused, false);
  }
});

test("YouTube playback shortcuts retain their media permission", async () => {
  for (const [key, className] of [[" ", "ytp-play-button"], ["k", "ytp-miniplayer-close-button"]]) {
    const h = await pausedMiniplayer();
    const { control, path } = playerControl(h.video, { className });
    h.document.activeElement = control;
    h.windowTarget.dispatchEvent(input("keydown", [control, ...path.slice(2)], { key }));
    await requestPlayback(h.video);
    assert.equal(h.video.playCalls, 1);
    assert.equal(h.video.paused, false);
  }
});
