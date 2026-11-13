const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness } = require("./helpers/playback.cjs");

test("media evidence, replacement ownership and diagnostic privacy", async () => {
  const ordinaryAudio = createHarness({ hostname: "audio.example" }).createAudio();
  await ordinaryAudio.play();
  assert.equal(ordinaryAudio.paused, false, "ordinary audio elements must remain outside video autoplay blocking");
  assert.equal(ordinaryAudio.playCalls, 1, "ordinary audio playback must reach the native play implementation");

  const audioOnlyTransport = createHarness({
    hostname: "audio.example",
    pathname: "/library",
    mediaReadyState: 4,
    videoWidth: 0,
    videoHeight: 0,
    autoplay: true,
    debug: true,
  });
  await audioOnlyTransport.video.play();
  assert.equal(audioOnlyTransport.video.paused, false, "metadata-confirmed audio-only video transports must remain outside video autoplay blocking");
  assert.equal(audioOnlyTransport.video.playCalls, 1, "audio-only video transports must reach the native play implementation");
  assert.equal(audioOnlyTransport.video.autoplay, true, "audio-only video transports must keep their declarative autoplay state");
  audioOnlyTransport.video.dispatchEvent({ type: "playing" });
  assert.equal(audioOnlyTransport.video.paused, false, "the playing-event guard must ignore audio-only video transports");

  audioOnlyTransport.video.videoWidth = 176;
  audioOnlyTransport.video.videoHeight = 144;
  audioOnlyTransport.video.dispatchEvent({ type: "loadedmetadata" });
  assert.equal(audioOnlyTransport.video.paused, false, "a metadata-confirmed audio transport must not be paused when the same element later exposes a visual layer");
  await audioOnlyTransport.video.play();
  assert.equal(audioOnlyTransport.video.paused, false, "the established audio transport must remain playable after its visual layer appears");
  const establishedTransportLogs = audioOnlyTransport.consoleEntries
    .map((entry) => entry.args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
    .filter((line) => line.includes("play() → ALLOWED audio transport"));
  const establishedTransportIds = establishedTransportLogs
    .map((line) => line.match(/mediaId=(m\d+)/)?.[1])
    .filter(Boolean);
  assert.ok(establishedTransportIds.length >= 2, "copied logs must identify repeated allowed plays on an established audio transport");
  assert.equal(new Set(establishedTransportIds).size, 1, "the same media element must keep one stable mediaId across metadata changes");
  assert.ok(establishedTransportLogs.every((line) => /layout=\d+x\d+/.test(line)),
    "copied audio transport logs must include rendered layout dimensions");

  audioOnlyTransport.video.videoWidth = 0;
  audioOnlyTransport.video.videoHeight = 0;

  audioOnlyTransport.video.paused = true;
  audioOnlyTransport.video.readyState = 0;
  audioOnlyTransport.video.videoWidth = 0;
  audioOnlyTransport.video.videoHeight = 0;
  audioOnlyTransport.video.dispatchEvent({ type: "emptied" });
  await audioOnlyTransport.video.play();
  assert.equal(audioOnlyTransport.video.paused, false, "a proven audio-only transport must survive an emptied-to-loading reset");
  assert.equal(audioOnlyTransport.video.pauseCalls, 0, "an audio transport reset must not receive a forced pause");

  const replacementAudioTransport = audioOnlyTransport.createVideo();
  replacementAudioTransport.readyState = 0;
  replacementAudioTransport.videoWidth = 0;
  replacementAudioTransport.videoHeight = 0;
  await replacementAudioTransport.play();
  assert.equal(replacementAudioTransport.paused, false, "a replacement transport immediately following audio evidence must not be interrupted");
  replacementAudioTransport.readyState = 4;
  replacementAudioTransport.dispatchEvent({ type: "playing" });
  assert.equal(replacementAudioTransport.paused, false, "metadata-confirmed replacement audio must remain outside the video guard");
  replacementAudioTransport.paused = true;
  replacementAudioTransport.readyState = 0;
  replacementAudioTransport.videoWidth = 0;
  replacementAudioTransport.videoHeight = 0;
  replacementAudioTransport.dispatchEvent({ type: "emptied" });

  const replacementVisualTransport = audioOnlyTransport.createVideo();
  replacementVisualTransport.readyState = 0;
  replacementVisualTransport.videoWidth = 0;
  replacementVisualTransport.videoHeight = 0;
  await replacementVisualTransport.play();
  assert.equal(replacementVisualTransport.paused, false, "a replacement transport may start while its inherited audio role is awaiting metadata");
  replacementVisualTransport.readyState = 4;
  replacementVisualTransport.videoWidth = 1280;
  replacementVisualTransport.videoHeight = 720;
  replacementVisualTransport.dispatchEvent({ type: "loadedmetadata" });
  assert.equal(replacementVisualTransport.paused, true, "visual replacement metadata must revoke inherited audio evidence");

  audioOnlyTransport.video.paused = true;
  audioOnlyTransport.video.readyState = 0;
  audioOnlyTransport.video.videoWidth = 0;
  audioOnlyTransport.video.videoHeight = 0;
  await audioOnlyTransport.video.play();
  assert.equal(audioOnlyTransport.video.paused, false, "a previously proven audio transport may begin its next metadata transition");
  audioOnlyTransport.video.readyState = 4;
  audioOnlyTransport.video.videoWidth = 1280;
  audioOnlyTransport.video.videoHeight = 720;
  audioOnlyTransport.video.dispatchEvent({ type: "playing" });
  assert.equal(audioOnlyTransport.video.paused, false, "the same metadata-confirmed audio transport must keep its role across later visual metadata");

  const sameSizeSeparateVisual = audioOnlyTransport.createVideo();
  sameSizeSeparateVisual.readyState = 4;
  sameSizeSeparateVisual.videoWidth = 176;
  sameSizeSeparateVisual.videoHeight = 144;
  await sameSizeSeparateVisual.play();
  assert.equal(sameSizeSeparateVisual.paused, true, "audio transport evidence must not authorize a separate visual element with the same intrinsic size");

  const stableAudioTransport = createHarness({
    hostname: "stable-audio.example",
    pathname: "/audio",
    mediaReadyState: 4,
    videoWidth: 0,
    videoHeight: 0,
  });
  await stableAudioTransport.video.play();
  const parallelUnknownVideo = stableAudioTransport.createVideo();
  parallelUnknownVideo.readyState = 0;
  parallelUnknownVideo.videoWidth = 0;
  parallelUnknownVideo.videoHeight = 0;
  await parallelUnknownVideo.play();
  assert.equal(parallelUnknownVideo.paused, true, "a stable audio transport must not authorize an unrelated metadata-unknown video without a reset");

  const singleReplacementTransport = createHarness({
    hostname: "replacement.example",
    pathname: "/audio",
    mediaReadyState: 4,
    videoWidth: 0,
    videoHeight: 0,
  });
  await singleReplacementTransport.video.play();
  singleReplacementTransport.video.paused = true;
  singleReplacementTransport.video.readyState = 0;
  singleReplacementTransport.video.dispatchEvent({ type: "emptied" });
  const firstProvisionalReplacement = singleReplacementTransport.createVideo();
  firstProvisionalReplacement.readyState = 0;
  firstProvisionalReplacement.videoWidth = 0;
  firstProvisionalReplacement.videoHeight = 0;
  await firstProvisionalReplacement.play();
  assert.equal(firstProvisionalReplacement.paused, false, "the first immediate replacement may inherit provisional audio evidence");
  singleReplacementTransport.advanceTime(5001);
  firstProvisionalReplacement.paused = true;
  await firstProvisionalReplacement.play();
  assert.equal(firstProvisionalReplacement.paused, true, "a provisional replacement must stop inheriting audio evidence after the bounded window expires");
  const unrelatedUnknownVideo = singleReplacementTransport.createVideo();
  unrelatedUnknownVideo.readyState = 0;
  unrelatedUnknownVideo.videoWidth = 0;
  unrelatedUnknownVideo.videoHeight = 0;
  await unrelatedUnknownVideo.play();
  assert.equal(unrelatedUnknownVideo.paused, true, "one provisional replacement must not authorize another unknown video");

  const routeScopedTransport = createHarness({
    hostname: "transport.example",
    pathname: "/audio-a",
    mediaReadyState: 4,
    videoWidth: 0,
    videoHeight: 0,
  });
  await routeScopedTransport.video.play();
  assert.equal(routeScopedTransport.video.paused, false, "route-scope fixture must first establish an audio transport role");

  routeScopedTransport.location.pathname = "/video-b";
  routeScopedTransport.location.href = "https://transport.example/video-b";
  const routeBVisual = routeScopedTransport.createVideo();
  routeBVisual.readyState = 4;
  routeBVisual.videoWidth = 640;
  routeBVisual.videoHeight = 360;
  await routeBVisual.play();
  assert.equal(routeBVisual.paused, true, "a visual element on the next route must remain blocked");

  routeScopedTransport.location.pathname = "/audio-a";
  routeScopedTransport.location.href = "https://transport.example/audio-a";
  routeScopedTransport.video.paused = true;
  routeScopedTransport.video.readyState = 4;
  routeScopedTransport.video.videoWidth = 1280;
  routeScopedTransport.video.videoHeight = 720;
  await routeScopedTransport.video.play();
  assert.equal(routeScopedTransport.video.paused, true, "an old audio transport role must not revive after leaving and returning to its route");

  const historyScopedTransport = createHarness({
    hostname: "history.example",
    pathname: "/audio-a",
    mediaReadyState: 4,
    videoWidth: 0,
    videoHeight: 0,
  });
  await historyScopedTransport.video.play();
  historyScopedTransport.location.pathname = "/silent-b";
  historyScopedTransport.location.href = "https://history.example/silent-b";
  historyScopedTransport.location.pathname = "/audio-a";
  historyScopedTransport.location.href = "https://history.example/audio-a";
  historyScopedTransport.windowTarget.dispatchEvent({ type: "popstate" });
  historyScopedTransport.video.paused = true;
  historyScopedTransport.video.videoWidth = 1280;
  historyScopedTransport.video.videoHeight = 720;
  await historyScopedTransport.video.play();
  assert.equal(historyScopedTransport.video.paused, true, "browser-history navigation must invalidate an audio role even when the intermediate route had no media activity");

  const unknownMediaTransport = createHarness({
    hostname: "media.example",
    pathname: "/loading",
    mediaReadyState: 0,
    videoWidth: 0,
    videoHeight: 0,
  });
  await unknownMediaTransport.video.play();
  assert.equal(unknownMediaTransport.video.paused, true, "zero dimensions before metadata must not bypass video autoplay blocking");

  const privateDiagnosticRoute = createHarness({
    hostname: "diagnostic.example",
    pathname: "/confidential-segment",
    search: "?token=private-marker",
    debug: true,
  });
  await privateDiagnosticRoute.video.play();
  const privateDiagnosticLogs = privateDiagnosticRoute.consoleEntries
    .map((entry) => entry.args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "))
    .join("\n");
  assert.doesNotMatch(
    privateDiagnosticLogs,
    /https:\/\/|confidential-segment|private-marker/,
    "copied MAIN logs must redact page URLs and route values"
  );
  assert.match(privateDiagnosticLogs, /\[redacted\]/, "sanitized MAIN logs must keep an explicit redaction marker");
});
