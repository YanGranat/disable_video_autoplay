const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../adapters/playback-diagnostics.js"), "utf8");

function fixture({ emitFails = false, context: readContext = () => ({}) } = {}) {
  const calls = [];
  const lines = [];
  let clock = 100;
  let timer;
  let disconnected = 0;
  let callback;
  const failure = new Error("native-operation-failure");
  class Element {
    setAttribute(...args) { calls.push(["setAttribute", this, ...args]); return "set-result"; }
    removeAttribute(...args) { calls.push(["removeAttribute", this, ...args]); return "remove-result"; }
  }
  class Media extends Element {
    constructor() { super(); this.isConnected = true; }
    load(...args) { calls.push(["load", this, ...args]); return "load-result"; }
    pause(...args) { calls.push(["pause", this, ...args]); throw failure; }
    get src() { return this.assigned; }
    set src(value) { calls.push(["src", this, ...arguments]); this.assigned = value; }
    get srcObject() { return this.object; }
    set srcObject(value) { calls.push(["srcObject", this, value]); this.object = value; }
  }
  class MutationObserver {
    constructor(fn) { callback = fn; }
    observe() {}
    disconnect() { disconnected++; }
  }
  const context = vm.createContext({ URL });
  vm.runInContext(source, context);
  const api = vm.runInContext("YTAPPlaybackDiagnostics", context);
  const original = Object.getOwnPropertyDescriptors(Media.prototype);
  const originalAttributes = Object.getOwnPropertyDescriptors(Element.prototype);
  const diagnostic = api.create({
    mediaPrototype: Media.prototype, elementPrototype: Element.prototype,
    now: () => clock, snapshot: () => ["mediaId=m1", "sourceId=s1"],
    context: readContext,
    emit: (...args) => { if (emitFails) throw failure; lines.push(args.join(" ")); },
    MutationObserver, setTimeout: fn => { timer = fn; return 1; }, clearTimeout: () => { timer = null; },
  });
  return {
    diagnostic, video: new Media(), other: new Media(), calls, lines, failure, Media, Element,
    original, originalAttributes, advance: ms => { clock += ms; }, expire: () => timer(),
    mutate: () => callback([]), savedMutation: () => callback, savedTimer: () => timer, disconnected: () => disconnected,
  };
}

test("media observation delegates original arguments, return values, exceptions and property descriptors", () => {
  const f = fixture();
  assert.deepEqual(Object.getOwnPropertyDescriptors(f.Media.prototype), f.original);
  f.diagnostic.begin(f.video);
  const value = { privateMarker: true };
  assert.equal(f.video.load(value), "load-result");
  assert.throws(() => f.video.pause(value), e => e === f.failure);
  f.video.src = "https://media.example/private-source";
  f.video.srcObject = value;
  assert.equal(f.video.src, "https://media.example/private-source");
  assert.equal(f.video.srcObject, value);
  assert.equal(f.video.setAttribute("SRC", value), "set-result");
  assert.equal(f.video.removeAttribute("src"), "remove-result");
  assert.deepEqual(f.calls.map(call => call[0]), ["load", "pause", "src", "srcObject", "setAttribute", "removeAttribute"]);
  assert.ok(f.calls.every(call => call[1] === f.video));
  assert.equal(f.calls[0][2], value);
  Object.getOwnPropertyDescriptor(f.Media.prototype, "src").set.call(f.video, value, "extra");
  assert.deepEqual(f.calls.at(-1), ["src", f.video, value, "extra"]);
  let coerced = 0;
  const attributeName = { toString() { coerced++; return "src"; } };
  f.video.setAttribute(attributeName, value);
  assert.equal(coerced, 0);
  f.mutate();
  for (const operation of ["load", "pause", "src-set", "srcObject-set", "setAttribute", "removeAttribute", "media-mutation"]) {
    assert.ok(f.lines.some(line => line.includes(`operation=${operation} `)), operation);
  }
  assert.doesNotMatch(f.lines.join("\n"), /private-source|privateMarker|media\.example|native-operation-failure/);
  f.diagnostic.reset();
  assert.deepEqual(Object.getOwnPropertyDescriptors(f.Media.prototype), f.original);
  assert.deepEqual(Object.getOwnPropertyDescriptors(f.Element.prototype), f.originalAttributes);
  assert.equal(f.disconnected(), 1);
});

test("observation is exact-media, time- and count-bounded without creating media operations", () => {
  const f = fixture();
  f.diagnostic.begin(f.video);
  assert.equal(f.calls.length, 0);
  f.other.load();
  f.other.src = "private-other";
  f.video.setAttribute("title", "private-label");
  assert.equal(f.lines.length, 1);
  for (let i = 0; i < 40; i++) f.video.load();
  f.mutate();
  assert.equal(f.lines.filter(line => line.includes("operation=load")).length, 24);
  assert.equal(f.lines.filter(line => line.includes("YouTube media operation ")).length, 24);
  assert.equal(f.lines.filter(line => line.includes("operations capped")).length, 1);
  assert.equal(f.calls.length, 43);
  f.expire();
  const count = f.lines.length;
  f.video.load();
  f.mutate();
  assert.equal(f.lines.length, count);
  assert.equal(f.disconnected(), 1);
  assert.deepEqual(Object.getOwnPropertyDescriptors(f.Media.prototype), f.original);
});

test("lazy expiry, cancellation and replacement windows cannot revive old observations", () => {
  for (const cancel of ["expiry", "reset", "disconnect", "replacement"]) {
    const f = fixture();
    f.diagnostic.begin(f.video);
    if (cancel === "expiry") f.advance(5000);
    if (cancel === "reset") f.diagnostic.reset();
    if (cancel === "disconnect") f.video.isConnected = false;
    if (cancel === "replacement") f.diagnostic.begin(f.other);
    const count = f.lines.length;
    f.video.load();
    const closesLazily = cancel === "expiry" || cancel === "disconnect";
    assert.equal(f.lines.length, count + (closesLazily ? 1 : 0), cancel);
    if (closesLazily) assert.match(f.lines.at(-1), /YouTube playback summary/);
    f.diagnostic.reset();
  }
});

test("cleanup preserves methods installed by another owner and diagnostics cannot break media calls", () => {
  const f = fixture();
  f.diagnostic.begin(f.video);
  const replacement = function () { return "replacement"; };
  f.Media.prototype.load = replacement;
  f.diagnostic.reset();
  assert.equal(f.Media.prototype.load, replacement);
  const failing = fixture({ emitFails: true });
  failing.diagnostic.begin(failing.video);
  assert.equal(failing.video.load(), "load-result");
  assert.throws(() => failing.video.pause(), e => e === failing.failure);
  assert.deepEqual(Object.getOwnPropertyDescriptors(failing.Media.prototype), failing.original);
});

test("queued callbacks from a closed window cannot consume a replacement window", () => {
  const f = fixture();
  f.diagnostic.begin(f.video);
  const oldMutation = f.savedMutation();
  const oldTimer = f.savedTimer();
  f.diagnostic.begin(f.video);
  const count = f.lines.length;
  oldMutation([]);
  oldTimer();
  assert.equal(f.lines.length, count);
  f.video.load();
  assert.match(f.lines.at(-1), /operation=load/);
  f.diagnostic.reset();
});

test("opaque caller summaries retain web and extension boundaries, not identifiers or stack text", () => {
  const f = fixture();
  const originalStack = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  // The module creates errors in its own VM; use an isolated synthetic Error there.
  const context = vm.createContext({ URL, Error: class {
    constructor() {
      this.stack = "Error\n at operation (chrome-extension://self-private/adapters.js:10:2)\n at load (chrome-extension://self-private/adapters.js:20:3)\n at secretName (https://player.example/private.js?token=secret:30:4)\n at otherName (chrome-extension://other-private/private.js:40:5)\n at internal (chrome-extension://self-private/main.js:50:6)";
    }
  } });
  vm.runInContext(source, context);
  const diagnostic = vm.runInContext("YTAPPlaybackDiagnostics", context).create({
    mediaPrototype: f.Media.prototype, now: () => 100, snapshot: () => [],
    emit: (...args) => f.lines.push(args.join(" ")),
    setTimeout: () => 1, clearTimeout() {},
  });
  diagnostic.begin(f.video);
  f.video.load();
  const text = f.lines.join("\n");
  assert.match(text, /caller=web:j1:30:4>other-extension:j2:40:5>self-extension:j3:50:6/);
  assert.doesNotMatch(text, /self-private|other-private|private\.js|secret|player\.example|https?:|chrome-extension:/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(Error, "prepareStackTrace"), originalStack);
  diagnostic.reset();
});

test("source-reset observations retain deeper initiators without expanding ordinary play traces", () => {
  const f = fixture();
  const stack = [
    "Error",
    " at operation (chrome-extension://self-private/main.js:10:2)",
    " at sourceSetter (chrome-extension://self-private/main.js:20:3)",
    ...Array.from({ length: 6 }, (_, i) => ` at privatePlayerMethod (https://player.example/private.js?token=secret:${30 + i}:4)`),
    " at privateInitiator (chrome-extension://other-private/private.js:40:5)",
    " at privateBridge (https://bridge.example/private.js:50:6)",
    " at privateOverflow (https://overflow.example/private.js:60:7)",
  ].join("\n");
  const context = vm.createContext({ URL, Error: class { constructor() { this.stack = stack; } } });
  vm.runInContext(source, context);
  const diagnostic = vm.runInContext("YTAPPlaybackDiagnostics", context).create({
    mediaPrototype: f.Media.prototype, now: () => 100, snapshot: () => [],
    emit: (...args) => f.lines.push(args.join(" ")),
    setTimeout: () => 1, clearTimeout() {},
  });
  diagnostic.begin(f.video);
  try {
    f.video.src = "https://media.example/private-source";
    const sourceLine = f.lines.at(-1);
    assert.match(sourceLine, /operation=src-set.*other-extension:j2:40:5/);
    assert.equal(sourceLine.match(/caller=(\S+)/)[1].split(">").length, 8);
    assert.equal(f.calls.length, 1);
    diagnostic.recordPlay(f.video);
    const playLine = f.lines.at(-1);
    assert.equal(playLine.match(/caller=(\S+)/)[1].split(">").length, 3);
    assert.doesNotMatch(playLine, /other-extension/);
    assert.doesNotMatch(f.lines.join("\n"), /private|secret|\.example|https?:|chrome-extension:|:60:7/);
  } finally { diagnostic.reset(); }
});

test("playback summaries distinguish source restarts, buffering and extension actions", () => {
  const state = { mediaId: "m1", sourceId: "s1", pointerSeq: 7, clickSeq: 7, keySeq: 0, generation: 2, frame: "top", tracing: true };
  const f = fixture({ context: () => ({ ...state }) });
  f.diagnostic.begin(f.video, true);
  f.diagnostic.recordEvent(f.video, "play", "s1");
  f.diagnostic.recordEvent(f.video, "playing", "s1");
  f.diagnostic.recordEvent(f.video, "waiting", "s1");
  f.diagnostic.recordEvent(f.video, "playing", "s1");
  assert.equal(f.lines.filter(line => line.includes("playback summary")).length, 0);
  f.video.src = "private-next-source";
  f.diagnostic.recordEvent(f.video, "emptied", "s1");
  state.sourceId = "s2";
  f.diagnostic.recordPlay(f.video, "authorized");
  f.diagnostic.recordEvent(f.video, "play", "s2");
  f.diagnostic.recordEvent(f.video, "playing", "s2");
  const restart = f.lines.at(-1);
  assert.match(restart, /playback summary.*reason=media-restarted.*starts=2/);
  assert.match(restart, /sourceStart=s1.*sourceEnd=s2.*sourceResets=1.*sourceChanges=1/);
  assert.match(restart, /playRequests=2.*blockedRequests=0.*extensionActions=0.*actionKinds=none/);
  assert.match(restart, /pointerStart=7.*pointerEnd=7.*clickStart=7.*clickEnd=7.*routeChanged=false.*waiting=1/);
  state.pointerSeq++;
  state.clickSeq++;
  f.diagnostic.recordAction(f.video, "visibility");
  f.diagnostic.recordEvent(f.video, "pause", "s2");
  f.expire();
  assert.match(f.lines.at(-1), /reason=expired.*extensionActions=1.*actionKinds=visibility.*pointerEnd=8/);
  assert.equal(f.lines.filter(line => line.includes("playback summary")).length, 2);
  assert.equal(f.calls.length, 1, "observation must not create playback or source operations");
  assert.doesNotMatch(f.lines.join("\n"), /private-next-source/);
});

test("closed-session summaries are complete after caps and cannot revive after debug-off", () => {
  const f = fixture();
  f.diagnostic.begin(f.video);
  for (let i = 0; i < 30; i++) f.diagnostic.recordPlay(f.video, "block");
  for (const kind of ["intervention", "source", "play"]) f.diagnostic.recordAction(f.video, kind);
  f.diagnostic.reset("route");
  assert.match(f.lines.at(-1), /playRequests=30.*blockedRequests=30.*extensionActions=3.*actionKinds=intervention,source,play/);
  assert.match(f.lines.at(-1), /routeChanged=true/);
  const count = f.lines.length;
  f.diagnostic.recordEvent(f.video, "playing", "s2");
  assert.equal(f.lines.length, count);
  f.diagnostic.begin(f.video);
  const before = f.lines.length;
  f.diagnostic.reset("debug-off");
  assert.equal(f.lines.length, before);
});
