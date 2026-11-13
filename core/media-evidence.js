/* global YTAPMediaPolicy */

/* exported YTAPMediaEvidence */
const YTAPMediaEvidence = Object.freeze({
  create({ now, replacementMs }) {
    const roles = new WeakMap();
    let scope = { routeKey: "", generation: 0 };
    let visualSeen = false;
    let replacement = null;

    function inScope(entry) {
      return entry?.routeKey === scope.routeKey && entry?.generation === scope.generation;
    }

    function reset(nextScope) {
      scope = { routeKey: nextScope.routeKey, generation: nextScope.generation };
      visualSeen = false;
      replacement = null;
    }

    function classify(identity, metadata, generic) {
      const remembered = roles.get(identity);
      const role = inScope(remembered) ? { source: remembered.source, at: remembered.at } : null;
      const { readyState, videoWidth, videoHeight } = metadata;
      // Metadata-backed roles do not expire and need no clock read.
      const needsClock = generic && readyState < 1 && videoWidth === 0 && videoHeight === 0
        && role?.source !== "metadata";
      const decision = YTAPMediaPolicy.classify(metadata, {
        generic, role, visualSeen,
        replacement: {
          inScope: !!replacement,
          at: replacement?.at || 0,
          owned: replacement?.identity === identity,
          available: !replacement?.identity || replacement.identity === identity,
        },
      }, needsClock ? now() : 0, replacementMs);

      if (decision.claimReplacement) replacement.identity = identity;
      if (decision.rememberRole === "metadata") {
        roles.set(identity, { ...scope, source: "metadata" });
      } else if (decision.rememberRole === "replacement") {
        roles.set(identity, { ...scope, source: "replacement", at: now() });
      } else if (decision.forgetRole) {
        roles.delete(identity);
      }
      if (decision.recordVisual) visualSeen = true;
      if (decision.clearReplacement) replacement = null;
      return { kind: decision.kind, evidence: decision.evidence };
    }

    function noteReset(identity, generic) {
      const role = roles.get(identity);
      if (!generic || role?.source !== "metadata" || !inScope(role)) return false;
      replacement = { at: now(), identity: null };
      return true;
    }

    return Object.freeze({ reset, classify, noteReset });
  },
});
