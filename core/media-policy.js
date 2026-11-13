/**
 * Classify media evidence and describe the resulting bookkeeping changes.
 * The caller owns element identity, route scoping, the clock and all mutations.
 */
/* exported YTAPMediaPolicy */
const YTAPMediaPolicy = (() => {
  "use strict";

  function result(kind, evidence, changes = {}) {
    return {
      kind, evidence,
      rememberRole: null,
      forgetRole: false,
      clearReplacement: false,
      claimReplacement: false,
      recordVisual: false,
      ...changes,
    };
  }

  // role is evidence for this exact element in the current route generation.
  // replacement describes the reset window, not permission to start any video.
  function classify({ readyState, videoWidth, videoHeight }, {
    generic, role, replacement, visualSeen,
  }, now, replacementMs) {
    const zeroDimensions = videoWidth === 0 && videoHeight === 0;
    if (readyState >= 1) {
      if (zeroDimensions) {
        return result("audio-transport", "metadata-audio-only", {
          rememberRole: "metadata", clearReplacement: true,
        });
      }
      // Confirmed audio may expose a visual layer on the same generic element.
      // A replacement has only provisional evidence and cannot use this rule.
      if (generic && role?.source === "metadata") {
        return result("audio-transport", "confirmed-transport-visual-metadata");
      }
      return result("visual", "metadata", {
        forgetRole: true, recordVisual: true, clearReplacement: replacement.inScope,
      });
    }

    // Zero dimensions before metadata are not evidence of audio by themselves.
    if (!generic || !zeroDimensions) return result("unknown", "no-metadata");
    if (role) {
      if (role.source === "replacement" && now - role.at > replacementMs) {
        return result("unknown", "replacement-expired", {
          forgetRole: true, clearReplacement: replacement.owned,
        });
      }
      return result("audio-transport", role.source === "metadata" ? "remembered-element" : "recent-replacement");
    }

    const ageMs = now - replacement.at;
    if (replacement.inScope && (ageMs < 0 || ageMs > replacementMs)) {
      return result("unknown", "no-metadata", { clearReplacement: true });
    }
    if (!visualSeen && replacement.inScope && replacement.available && ageMs >= 0) {
      return result("audio-transport", "recent-replacement", {
        rememberRole: "replacement", claimReplacement: true,
      });
    }
    return result("unknown", "no-metadata");
  }

  return Object.freeze({ classify });
})();
