const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { runScripts } = require("./load_scripts.cjs");

function tracker() {
  const context = vm.createContext({});
  runScripts(context, ["core/media-policy.js", "core/media-evidence.js"]);
  let time = 100;
  let clockReads = 0;
  const evidence = vm.runInContext("YTAPMediaEvidence", context).create({
    now: () => { clockReads += 1; return time; }, replacementMs: 5000,
  });
  evidence.reset({ routeKey: "first", generation: 1 });
  return { evidence, advance: (ms) => { time += ms; }, clockReads: () => clockReads };
}

const unknown = { readyState: 0, videoWidth: 0, videoHeight: 0 };
const audio = { readyState: 1, videoWidth: 0, videoHeight: 0 };
const visual = { readyState: 1, videoWidth: 1280, videoHeight: 720 };

test("audio evidence owns one provisional replacement and checks its expiry", () => {
  const { evidence, advance } = tracker();
  const original = {}, replacement = {}, parallel = {};
  assert.equal(evidence.classify(original, audio, true).kind, "audio-transport");
  assert.equal(evidence.noteReset(original, true), true);
  assert.equal(evidence.classify(replacement, unknown, true).kind, "audio-transport");
  assert.equal(evidence.classify(parallel, unknown, true).kind, "unknown");
  assert.equal(evidence.noteReset(replacement, true), false);
  advance(5001);
  assert.equal(evidence.classify(replacement, unknown, true).kind, "unknown");
  assert.equal(evidence.classify(parallel, unknown, true).kind, "unknown");
});

test("route generations invalidate roles, reset windows and visual history", () => {
  const { evidence } = tracker();
  const original = {}, replacement = {};
  evidence.classify(original, audio, true);
  evidence.noteReset(original, true);
  evidence.reset({ routeKey: "second", generation: 2 });
  assert.equal(evidence.classify(replacement, unknown, true).kind, "unknown");
  evidence.reset({ routeKey: "first", generation: 3 });
  assert.equal(evidence.classify(original, unknown, true).kind, "unknown");
  evidence.classify({}, visual, true);
  evidence.classify(original, audio, true);
  evidence.noteReset(original, true);
  assert.equal(evidence.classify(replacement, unknown, true).kind, "unknown");
  evidence.reset({ routeKey: "third", generation: 4 });
  evidence.classify(original, audio, true);
  evidence.noteReset(original, true);
  assert.equal(evidence.classify(replacement, unknown, true).kind, "audio-transport");
});

test("confirmed roles and visual metadata do not consume replacement clock samples", () => {
  const { evidence, clockReads, advance } = tracker();
  const identity = {};
  assert.equal(evidence.classify(identity, visual, true).kind, "visual");
  assert.equal(evidence.classify(identity, audio, true).kind, "audio-transport");
  advance(6000);
  assert.equal(evidence.classify(identity, unknown, true).kind, "audio-transport");
  assert.equal(clockReads(), 0);
  assert.equal(evidence.noteReset(identity, false), false);
  assert.equal(clockReads(), 0);
  assert.equal(evidence.classify({}, unknown, false).kind, "unknown");
  assert.equal(clockReads(), 0);
});
