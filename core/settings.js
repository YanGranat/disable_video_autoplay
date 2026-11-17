/* global YTAPSiteContext */
/* exported YTAPSettings */
/**
 * Persisted settings and value rules. No browser state, storage, DOM or timers.
 * Loaded independently in each execution world; only immutable code is shared.
 */
const YTAPSettings = (() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    applyToYouTube: true,
    applyToShorts: false,
    applyToChannelPlayer: true,
    applyToMobile: false,
    applyToTwitch: false,
    applyToKick: false,
    applyToOtherSites: true,
    siteLibrary: [], // Selected sites remain covered when the global mode is off.
    siteExclusions: [],
    applyToEmbedded: true,
    applyToPlaylists: false, // Allow auto-next, not autoplay after manual selection.
    stopInsteadOfPause: false, // Best-effort buffering stop for compatible sources.
    ignoreMiniplayer: true,
    pauseOnHidden: false,
    resumeOnVisible: false,
    allowlist: [],
    debug: false,
    uiLanguage: "auto",
  };
  Object.freeze(DEFAULTS.siteLibrary);
  Object.freeze(DEFAULTS.siteExclusions);
  Object.freeze(DEFAULTS.allowlist);
  Object.freeze(DEFAULTS);
  const { uiLanguage: _uiLanguage, ...contentDefaults } = DEFAULTS;
  Object.freeze(contentDefaults);
  const mainKeys = Object.freeze([
    "enabled",
    "applyToYouTube",
    "applyToShorts",
    "applyToChannelPlayer",
    "applyToMobile",
    "applyToEmbedded",
    "applyToPlaylists",
    "applyToTwitch",
    "applyToKick",
    "applyToOtherSites",
    "stopInsteadOfPause",
    "ignoreMiniplayer",
    "pauseOnHidden",
    "resumeOnVisible",
  ]);
  const mainDefaults = Object.freeze({
    settingsReady: false,
    ...Object.fromEntries(mainKeys.map((key) => [key, DEFAULTS[key]])),
  });

  function normalizeChannel(s) {
    let raw = typeof s === "string" ? s.trim() : "";
    if (!raw || raw.length > 2048) return "";
    if (raw.startsWith("@")) raw = `/${raw}`;
    try {
      const url = raw.startsWith("/")
        ? new URL(raw, "https://www.youtube.com")
        : new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
        || !YTAPSiteContext.matchesHostname(url.hostname, "youtube.com")) return "";
      const parts = url.pathname.split("/").map((part) => decodeURIComponent(part).normalize("NFC"));
      const handle = parts[1]?.startsWith("@") ? parts[1].slice(1) : "";
      if (handle) {
        if ([...handle].length > 30 || /[\s/\\?#%\p{Cc}]/u.test(handle)) return "";
        return `/@${encodeURIComponent(handle.toLowerCase()).toLowerCase()}`;
      }
      const [kind, name] = parts.slice(1);
      if (kind === "channel" && /^[a-zA-Z0-9_-]{1,64}$/.test(name || "")) return `/channel/${name.toLowerCase()}`;
      if (["c", "user"].includes(kind) && name && [...name].length <= 100 && !/[\s/\\?#%\p{Cc}]/u.test(name)) {
        return `/${kind}/${encodeURIComponent(name).toLowerCase()}`;
      }
      return "";
    } catch {
      return "";
    }
  }

  // The page receives only playback flags, never the stored site/channel lists.
  // Preserve the existing coercion rules for missing or legacy setting values.
  function toMainConfig(settings, otherSitesAllowed) {
    return {
      settingsReady: true,
      enabled: !!settings.enabled,
      applyToYouTube: settings.applyToYouTube !== false,
      applyToShorts: !!settings.applyToShorts,
      applyToChannelPlayer: !!settings.applyToChannelPlayer,
      applyToMobile: !!settings.applyToMobile,
      applyToTwitch: !!settings.applyToTwitch,
      applyToKick: !!settings.applyToKick,
      applyToOtherSites: otherSitesAllowed,
      applyToEmbedded: settings.applyToEmbedded !== false,
      applyToPlaylists: !!settings.applyToPlaylists,
      stopInsteadOfPause: !!settings.stopInsteadOfPause,
      ignoreMiniplayer: settings.ignoreMiniplayer !== false,
      pauseOnHidden: !!settings.pauseOnHidden,
      resumeOnVisible: !!settings.resumeOnVisible,
      debug: !!settings.debug,
    };
  }

  return Object.freeze({
    defaults: DEFAULTS, contentDefaults, mainDefaults, mainKeys, toMainConfig,
    normalizeChannel,
  });
})();
