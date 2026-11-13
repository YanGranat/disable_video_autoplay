const assert = require("node:assert/strict");
const vm = require("node:vm");
const { test } = require("node:test");
const { runScripts } = require("./load_scripts.cjs");

const context = vm.createContext({});
runScripts(context, ["core/media-policy.js"]);
const policy = vm.runInContext("YTAPMediaPolicy", context);
const unknown = Object.freeze({ readyState: 0, videoWidth: 0, videoHeight: 0 });
const audio = Object.freeze({ ...unknown, readyState: 1 });
const visual = Object.freeze({ readyState: 4, videoWidth: 1280, videoHeight: 720 });
const noReplacement = Object.freeze({ inScope: false, owned: false, available: true, at: 0 });

function classify(metadata, { role = null, replacement = noReplacement, ...rest } = {}, now = 100) {
  const history = Object.freeze({ generic: true, visualSeen: false, ...rest,
    role: role && Object.freeze(role), replacement: Object.freeze(replacement) });
  return policy.classify(Object.freeze(metadata), history, now, 5000);
}

test("metadata is required to establish an audio role", () => {
  assert.equal(classify(unknown).kind, "unknown");
  const result = classify(audio);
  assert.equal(result.kind, "audio-transport");
  assert.equal(result.evidence, "metadata-audio-only");
  assert.equal(result.rememberRole, "metadata");
  assert.equal(result.clearReplacement, true);
  assert.equal(classify(audio, { generic: false }).kind, "audio-transport");
  for (const [videoWidth, videoHeight] of [[1, 0], [0, 1], [1280, 720]]) {
    const seen = classify({ readyState: 1, videoWidth, videoHeight });
    assert.equal(seen.kind, "visual");
    assert.equal(seen.forgetRole, true);
    assert.equal(seen.recordVisual, true);
  }
});

test("confirmed evidence belongs to the same generic element, never to a visual replacement", () => {
  const confirmed = { role: { source: "metadata" } };
  assert.equal(classify(visual, confirmed).evidence, "confirmed-transport-visual-metadata");
  assert.equal(classify(unknown, confirmed, 1000000).evidence, "remembered-element");
  assert.equal(classify(visual, { ...confirmed, generic: false }).kind, "visual");
  const provisional = { role: { source: "replacement", at: 100 } };
  const result = classify(visual, provisional);
  assert.equal(result.kind, "visual");
  assert.equal(result.forgetRole, true);
  assert.equal(result.recordVisual, true);
  assert.equal(classify(unknown, { ...provisional, generic: false }).kind, "unknown");
  assert.equal(classify({ ...visual, readyState: 0 }, confirmed).kind, "unknown");
});

test("one available reset claimant may inherit evidence only before the window expires", () => {
  const replacement = { inScope: true, owned: false, available: true, at: 100 };
  for (const now of [100, 5099, 5100]) {
    const result = classify(unknown, { replacement }, now);
    assert.equal(result.evidence, "recent-replacement");
    assert.equal(result.claimReplacement, true);
    assert.equal(result.rememberRole, "replacement");
  }
  for (const now of [99, 5101]) {
    const result = classify(unknown, { replacement }, now);
    assert.equal(result.kind, "unknown");
    assert.equal(result.clearReplacement, true);
    assert.equal(result.claimReplacement, false);
  }
  for (const patch of [
    { visualSeen: true }, { generic: false },
    { replacement: { ...replacement, inScope: false } },
    { replacement: { ...replacement, available: false } },
  ]) {
    assert.equal(classify(unknown, { replacement, ...patch }).kind, "unknown");
  }
});

test("a provisional role is checked again and expires without clearing another claimant", () => {
  const role = { source: "replacement", at: 100 };
  assert.equal(classify(unknown, { role }, 5100).kind, "audio-transport");
  for (const owned of [true, false]) {
    const result = classify(unknown, { role, replacement: { ...noReplacement, owned } }, 5101);
    assert.equal(result.kind, "unknown");
    assert.equal(result.evidence, "replacement-expired");
    assert.equal(result.forgetRole, true);
    assert.equal(result.clearReplacement, owned);
    assert.equal(result.claimReplacement, false);
  }
  // Preserve the existing monotonic-clock contract: only new claims reject a
  // negative age; an already remembered role is checked for expiry, not rebased.
  assert.equal(classify(unknown, { role }, 99).kind, "audio-transport");
});

test("metadata confirmation closes the reset window and visual evidence clears only its own scope", () => {
  const pending = { ...noReplacement, inScope: true };
  const role = { source: "replacement", at: 100 };
  const confirmed = classify(audio, { role, replacement: pending }, 10000);
  assert.equal(confirmed.rememberRole, "metadata", "actual metadata supersedes an expired provisional role");
  assert.equal(confirmed.clearReplacement, true);
  assert.equal(confirmed.forgetRole, false);
  assert.equal(classify(visual, { replacement: pending }).clearReplacement, true);
  assert.equal(classify(visual).clearReplacement, false);
});
