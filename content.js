/* global YTAPSettings, YTAPSettingsStore, YTAPDiagnostics, YTAPPlaybackPolicy, YTAPPageContext */
const { contentDefaults: DEFAULTS, normalizeChannel, normalizeSite, siteMatchesHostname } = YTAPSettings;
const { sanitizeDebugString, sanitizeDebugArgs } = YTAPDiagnostics;

const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const LOG_VERSION = `v${EXTENSION_VERSION}`;

let settings = { ...DEFAULTS };

let navigationId = 0;
let lastNavigatedKey = "";
let lastUrl = location.href;
let pendingYouTubeNavigation = { videoId: "", at: 0 };
let manualPlaylistRouteKey = "";
let contextInvalidated = false;
let urlPollTimer = null;

const YOUTUBE_NAVIGATION_INTENT_MAX_AGE_MS = 5000;

function log(...args) {
  if (!settings.debug) return;
  console.log("%c[YT-AP ISOLATED]", "color:#4ecdc4;font-weight:700", LOG_VERSION, ...sanitizeDebugArgs(args));
}

function info(...args) {
  if (!settings.debug) return;
  console.info("%c[YT-AP ISOLATED]", "color:#4ecdc4;font-weight:700", LOG_VERSION, ...sanitizeDebugArgs(args));
}

function flow(step, ...detail) {
  if (!settings.debug) return;
  console.log(
    "%c[YT-AP ISOLATED]",
    "color:#4ecdc4;font-weight:700",
    LOG_VERSION,
    "[flow]",
    sanitizeDebugString(step),
    ...sanitizeDebugArgs(detail)
  );
}

const pageContext = YTAPPageContext.create({ location, document, window });
const {
  getSiteScopeHostname, isMobileHost, isYouTubeHost, isTwitchHost, isKickHost,
  isTwitchKickHost, isOtherSite, isWatchPage, isShortsPage, isEmbedPage, isVideoPage,
  isChannelPage, isEmbeddedContext, isPlaylistWatch, currentNavKey,
  currentDocumentVideoId: currentYouTubeVideoId,
} = pageContext;

function isCurrentSiteInLibrary() {
  const host = normalizeSite(getSiteScopeHostname());
  return !!host && (Array.isArray(settings.siteLibrary) ? settings.siteLibrary : [])
    .some((site) => siteMatchesHostname(host, site));
}

function shouldApplyToOtherSite() {
  return YTAPSettings.otherSiteRule(settings, getSiteScopeHostname()).blocked;
}

function consumeYouTubeNavigationIntent() {
  const candidate = pendingYouTubeNavigation;
  if (!candidate.videoId) {
    return { present: false, fresh: false, targetMatchesRoute: false };
  }

  const ageMs = Date.now() - candidate.at;
  const fresh = ageMs >= 0 && ageMs <= YOUTUBE_NAVIGATION_INTENT_MAX_AGE_MS;
  const targetMatchesRoute = candidate.videoId === currentYouTubeVideoId();
  pendingYouTubeNavigation = { videoId: "", at: 0 };
  return { present: true, fresh, targetMatchesRoute };
}

function classifyManualPlaylistRoute(navKey, source, routeChanged) {
  if (!isPlaylistWatch()) {
    if (routeChanged) {
      pendingYouTubeNavigation = { videoId: "", at: 0 };
      manualPlaylistRouteKey = "";
    }
    return false;
  }

  const explicitNavigation = source === "immediate" || source === "popstate";
  let navigationIntent = { present: false, fresh: false, targetMatchesRoute: false };
  if (routeChanged && explicitNavigation) {
    pendingYouTubeNavigation = { videoId: "", at: 0 };
  } else if (routeChanged) {
    navigationIntent = consumeYouTubeNavigationIntent();
  }
  const matchingNavigationIntent = navigationIntent.present
    && navigationIntent.fresh
    && navigationIntent.targetMatchesRoute;
  if (explicitNavigation || matchingNavigationIntent) {
    manualPlaylistRouteKey = navKey;
  } else if (routeChanged) {
    manualPlaylistRouteKey = "";
  }

  const manualRoute = manualPlaylistRouteKey === navKey;
  flow(
    "playlist navigation classified",
    `source=${source}`,
    `explicitNavigation=${explicitNavigation}`,
    `hadNavigationIntent=${navigationIntent.present}`,
    `navigationIntentFresh=${navigationIntent.fresh}`,
    `targetMatchesRoute=${navigationIntent.targetMatchesRoute}`,
    `matchingNavigationIntent=${matchingNavigationIntent}`,
    `manualRoute=${manualRoute}`
  );
  return manualRoute;
}

function sendConfig() {
  window.dispatchEvent(
    new CustomEvent("ytap-config", {
      detail: {
        ...(settings.debug ? { extensionVersion: EXTENSION_VERSION } : {}),
        ...YTAPSettings.toMainConfig(settings, shouldApplyToOtherSite()),
      },
    })
  );
}

function sendArm() {
  flow("sendArm → ytap-arm");
  window.dispatchEvent(new CustomEvent("ytap-arm"));
}

function sendDisarm() {
  flow("sendDisarm → ytap-disarm");
  window.dispatchEvent(new CustomEvent("ytap-disarm"));
}

function sendResume() {
  flow("sendResume → ytap-resume");
  window.dispatchEvent(new CustomEvent("ytap-resume"));
}

async function loadSettings() {
  try {
    const data = await YTAPSettingsStore.read(DEFAULTS);
    return { ...DEFAULTS, ...data };
  } catch (e) {
    info("loadSettings failed; keeping current settings", e?.message || e);
    if (/extension context invalidated/i.test(String(e?.message || ""))) {
      contextInvalidated = true;
      if (urlPollTimer !== null) clearInterval(urlPollTimer);
      urlPollTimer = null;
    }
    return { ...settings };
  }
}

function getChannelKeysFromDom() {
  if (!isYouTubeHost()) return [];
  // Component data is visible in MAIN, not in this isolated execution world.
  const videoId = isWatchPage() ? currentYouTubeVideoId()
    : /^\/(?:shorts|embed)\/([^/]+)/.exec(location.pathname)?.[1];
  if (!videoId) return [];
  let channels = [];
  const receive = (event) => {
    if (event.detail?.videoId === videoId) {
      const aliases = Array.isArray(event.detail.aliases) ? event.detail.aliases.slice(0, 4) : [];
      channels = [event.detail.channel, ...aliases].map(normalizeChannel).filter(Boolean);
    }
  };
  window.addEventListener("ytap-channel-response", receive);
  try { window.dispatchEvent(new CustomEvent("ytap-channel-request")); }
  finally { window.removeEventListener("ytap-channel-response", receive); }
  return channels;
}

function getChannelFromDom() { return getChannelKeysFromDom()[0] || null; }

function isChannelAllowed(channel, allowlist) {
  return allowlist.includes(channel) || getChannelKeysFromDom().some((key) => allowlist.includes(key));
}

function getChannelFromUrl() {
  if (!isYouTubeHost()) return null;
  const p = location.pathname || "";
  if (/^\/(?:@[^/]+|channel\/[^/]+)(?:\/|$)/.test(p)) return normalizeChannel(p);
  return null;
}

async function getChannelKeyForPopup() {
  if (contextInvalidated) return null;
  if (!isYouTubeHost() || (!isVideoPage() && !isChannelPage())) return null;
  // Prefer stable URL forms if user is on a channel page.
  const fromUrl = getChannelFromUrl();
  if (fromUrl) return fromUrl;

  // On /watch or /shorts, the owner link is usually in the DOM.
  const immediate = getChannelFromDom();
  if (immediate) return immediate;

  // Retry briefly: YouTube often renders the owner section after player starts.
  const navId = navigationId;
  const ch = await waitForChannel(navId, 15, 200);
  return ch;
}

function waitForChannel(navId, maxAttempts = 25, intervalMs = 250) {
  return new Promise((resolve) => {
    let attempts = 0;

    const check = () => {
      if (contextInvalidated || navId !== navigationId) {
        log("waitForChannel: nav changed → abort");
        resolve(null);
        return;
      }

      const ch = getChannelFromDom();
      if (ch) {
        log("waitForChannel: found", { attempts, ch });
        resolve(ch);
        return;
      }

      attempts += 1;
      if (attempts >= maxAttempts) {
        log("waitForChannel: gave up", { maxAttempts });
        resolve(null);
        return;
      }

      setTimeout(check, intervalMs);
    };

    check();
  });
}

// Popup → content script messaging
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "YTAP_GET_CHANNEL") return;

  (async () => {
    try {
      const channel = await getChannelKeyForPopup();
      sendResponse({
        channel,
        pageUrl: location.href,
      });
    } catch (e) {
      sendResponse({
        channel: null,
        pageUrl: location.href,
        error: e?.message || String(e),
      });
    }
  })();

  return true;
});

async function onNavigate(source) {
  if (contextInvalidated) return;
  const navKey = currentNavKey();
  const previousNavKey = lastNavigatedKey;

  // Deduplicate: yt-navigate-finish + url-poll often fire for the same URL.
  // But do NOT skip when settings changed (we want to re-apply rules immediately).
  if (navKey === lastNavigatedKey && source !== "immediate" && source !== "storage-change") {
    flow("onNavigate SKIPPED (duplicate)", source, { navKey });
    return;
  }
  lastNavigatedKey = navKey;

  navigationId += 1;
  const navId = navigationId;
  flow("onNavigate start", { navId, source, navKey });

  const loadedSettings = await loadSettings();
  if (contextInvalidated || navId !== navigationId) {
    flow("onNavigate ABORTED (superseded while loading settings)", { navId, currentNavigationId: navigationId, source, navKey });
    return;
  }
  settings = loadedSettings;
  sendConfig();

  const manualPlaylistRoute = classifyManualPlaylistRoute(navKey, source, previousNavKey !== navKey);

  log(`=== onNavigate #${navId}`, {
    source,
    url: location.href,
    isVideoPage: isVideoPage(),
    isWatch: isWatchPage(),
    isShorts: isShortsPage(),
    isEmbed: isEmbedPage(),
    isChannelPage: isChannelPage(),
    isMobile: isMobileHost(),
    isEmbedded: isEmbeddedContext(),
    isPlaylist: isPlaylistWatch(),
    isTwitchKick: isTwitchKickHost(),
    isOtherSite: isOtherSite(),
    siteScopeHostname: getSiteScopeHostname(),
    isCurrentSiteInLibrary: isCurrentSiteInLibrary(),
    settings,
  });

  const coverage = YTAPPlaybackPolicy.coverage(
    YTAPSettings.toMainConfig(settings, shouldApplyToOtherSite()),
    pageContext.coverageFacts(manualPlaylistRoute)
  );
  if (!coverage.armed) {
    flow("onNavigate → sendDisarm", coverage.reason);
    if (coverage.reason === "playlist-auto-next") {
      log("Playlist autoplay allowed (auto-next, no matching navigation intent)");
    }
    sendDisarm();
    return;
  }
  if (isOtherSite() || isTwitchKickHost()) {
    sendArm();
    log(isOtherSite() ? "Other site: autoplay block armed" : "Twitch/Kick: autoplay block armed");
    return;
  }
  if (isPlaylistWatch() && !settings.applyToPlaylists) {
    log("Playlist: explicit navigation or matching manual selection → keep autopause");
  }

  // Default behavior is pause. We arm immediately, then possibly unpause if allowlisted.
  flow("onNavigate → sendArm", "in scope");
  sendArm();
  await applyChannelException(navId);
}

async function applyChannelException(navId) {
  const allowlist = (settings.allowlist || []).map(normalizeChannel).filter(Boolean);
  if (allowlist.length === 0) {
    flow("onNavigate → staying paused", "allowlist empty");
    return;
  }

  const immediateChannel = getChannelFromUrl() || getChannelFromDom();
  if (immediateChannel) {
    flow("onNavigate channel immediate", immediateChannel, "allowlisted:", allowlist.includes(immediateChannel));
    if (isChannelAllowed(immediateChannel, allowlist)) {
      info("Allowlisted channel (immediate) → resume");
      sendDisarm();
      sendResume();
    }
    return;
  }

  let ch = null;
  try {
    ch = await waitForChannel(navId);
  } catch (e) {
    info("waitForChannel error:", e?.message || e);
  }
  if (navId !== navigationId) {
    log("Allowlist check: nav changed → abort");
    return;
  }

  flow("onNavigate channel resolved", ch, "allowlisted:", !!(ch && allowlist.includes(ch)));
  if (ch && isChannelAllowed(ch, allowlist)) {
    info("Allowlisted channel → resume");
    sendDisarm();
    sendResume();
    return;
  }

  flow("onNavigate → staying paused", "not allowlisted");
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

info("Loaded.", { version: EXTENSION_VERSION, readyState: document.readyState, url: location.href });

window.addEventListener("yt-navigate-start", () => {
  flow("EVENT yt-navigate-start");
  log("EVENT: yt-navigate-start", { url: location.href });
});

window.addEventListener("yt-navigate-finish", () => {
  flow("EVENT yt-navigate-finish");
  log("EVENT: yt-navigate-finish", { url: location.href });
  onNavigate("yt-navigate-finish").catch((e) => info("onNavigate error:", e?.message || e));
});

window.addEventListener("popstate", () => {
  flow("EVENT popstate");
  log("EVENT: popstate", { url: location.href });
  onNavigate("popstate").catch((e) => info("onNavigate error:", e?.message || e));
});

// MAIN sends a target video id only for a trusted primary click on a YouTube
// watch link. Generic player/page gestures intentionally carry no navigation
// intent, so they cannot turn a real playlist auto-next into a manual route.
window.addEventListener("ytap-gesture", (ev) => {
  const videoId = ev?.detail?.youtubeNavigationVideoId;
  if (typeof videoId !== "string" || !videoId) return;
  pendingYouTubeNavigation = { videoId, at: Date.now() };
  flow("YouTube navigation intent recorded", "hasTargetVideo=true");
});

// Storage updates from popup (no reload needed)
YTAPSettingsStore.subscribe((changes, areaName) => {
  if (contextInvalidated) return;
  if (areaName !== "sync") return;

  const keys = Object.keys(changes || {});
  if (keys.length === 0) return;

  log("storage.onChanged", keys);

  for (const k of keys) {
    settings[k] = changes[k].newValue;
  }

  sendConfig();
  onNavigate("storage-change").catch((e) => info("onNavigate error:", e?.message || e));
});

const URL_POLL_MS = 800;

// Poll only dedicated SPA documents. MAIN also validates the route synchronously
// in play()/playing, so this interval updates settings/logs rather than carrying
// correctness on its own.
if (isYouTubeHost() || isTwitchHost() || isKickHost()) {
  urlPollTimer = setInterval(() => {
    if (location.href !== lastUrl) {
      log("URL changed (poll)", { from: lastUrl, to: location.href });
      lastUrl = location.href;
      onNavigate("url-poll").catch((e) => info("onNavigate error:", e?.message || e));
    }
  }, URL_POLL_MS);
}

// Load persisted settings immediately. Waiting for DOMContentLoaded lets early autoplay win.
onNavigate("immediate").catch((e) => info("onNavigate error:", e?.message || e));
