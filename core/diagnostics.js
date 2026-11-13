/**
 * Privacy filtering shared by UI, MAIN and ISOLATED loggers.
 * This module never logs, reads page state or stores user data.
 */
/* exported YTAPDiagnostics */
const YTAPDiagnostics = (() => {
  "use strict";

  const PRIVATE_DEBUG_KEYS = new Set([
    "url", "pageUrl", "href", "src", "currentSrc",
    "routeKey", "previousRouteKey", "nextRouteKey", "userStartedRouteKey",
    "gestureRouteKey", "currentRouteKey", "pendingVideoIntentRouteKey", "navKey",
    "from", "to", "hostname", "siteScopeHostname", "channel", "ch",
    "videoId", "playlistId", "youtubeNavigationVideoId",
  ]);
  const PRIVATE_DEBUG_COLLECTION_KEYS = new Set(["allowlist", "whitelist", "siteLibrary", "siteExclusions"]);

  function sanitizeDebugString(value) {
    return String(value)
      .replace(/\b(?:https?|blob):\/\/[^\s"'<>]+/gi, "[url]")
      .replace(/\bdata:[^\s"'<>]+/gi, "[data-url]")
      .replace(/\/(?:@|channel\/|c\/|user\/)[^/?&#\s"'<>]+/gi, "/[channel]")
      .replace(/([?&](?:v|list)=)[^&\s"'<>]+/gi, "$1[redacted]");
  }

  function sanitizeDebugValue(value, key = "", seen = new WeakSet(), depth = 0) {
    if (PRIVATE_DEBUG_COLLECTION_KEYS.has(key)) {
      return `[${Array.isArray(value) ? value.length : 0} entries]`;
    }
    if (PRIVATE_DEBUG_KEYS.has(key)) return value ? "[redacted]" : value;
    if (typeof value === "string") return sanitizeDebugString(value);
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Error) return { name: value.name, message: sanitizeDebugString(value.message) };
    if (depth >= 4) return "[object]";
    if (typeof value.tagName === "string") return { element: value.tagName.toLowerCase() };
    if (seen.has(value)) return "[circular]";

    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeDebugValue(item, "", seen, depth + 1));
    }
    const sanitized = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      sanitized[childKey] = sanitizeDebugValue(childValue, childKey, seen, depth + 1);
    }
    return sanitized;
  }

  function sanitizeDebugArgs(args) {
    return args.map((value) => sanitizeDebugValue(value));
  }

  return Object.freeze({ sanitizeDebugString, sanitizeDebugArgs });
})();
