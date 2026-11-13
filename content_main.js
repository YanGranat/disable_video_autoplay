/* global YTAPSettings, YTAPDiagnostics, YTAPPlaybackPolicy, YTAPMediaEvidence, YTAPVisibilityPlayback, YTAPPlayerDom, YTAPPageContext, YTAPSiteContext, YTAPMediaSource, YTAPYouTubeChannel */

(() => {
  "use strict";

  const STYLE = "color:#ff6b6b;font-weight:700";
  const PREFIX = "[YT-AP MAIN]";

  let debug = false;

  const { sanitizeDebugString, sanitizeDebugArgs } = YTAPDiagnostics;

  const info = (...args) => {
    if (!debug) return;
    console.info(`%c${PREFIX}`, STYLE, ...sanitizeDebugArgs(args));
  };
  const log = (...args) => {
    if (!debug) return;
    console.log(`%c${PREFIX}`, STYLE, ...sanitizeDebugArgs(args));
  };
  const flow = (step, ...detail) => {
    if (!debug) return;
    console.log(`%c${PREFIX}`, STYLE, "[flow]", sanitizeDebugString(step), ...sanitizeDebugArgs(detail));
  };

  const originalPlay = HTMLMediaElement.prototype.play;
  const mediaSources = YTAPMediaSource.create();

  // ---------------------------------------------------------------------------
  // Timing constants (ms)
  // These values are tuned empirically for YouTube's behavior. Adjust with care.
  // ---------------------------------------------------------------------------

  // YouTube may call play() 500-1000ms after user clicks; 1500ms gives safe margin
  const MS_RECENT_GESTURE = 1500;
  const MS_YOUTUBE_CONTROLLER_INTENT = 5000;

  // Handles race: click arrives before YouTube's autoplay attempt
  const MS_CLICK_IN_PLAYER_ALLOW_PLAY = 600;

  // After the extension has blocked autoplay on a non-YouTube video, give its
  // controller the current click first. If it does nothing, use a native fallback.
  const MS_CONTROLLER_PLAY_FALLBACK = 120;

  // Generic controllers may process even a direct <video> click asynchronously
  // (about 200 ms on observed players). Starting native playback first makes
  // their late toggle pause it, so all generic recovery gets the longer grace.
  const MS_GENERIC_CONTROLLER_PLAY_FALLBACK = 350;

  // Some custom players create their <video> only after a trusted Play click.
  // Keep that explicit intent long enough to bind it to the late-created media,
  // while a new pointer gesture or route change cancels it immediately.
  const MS_PENDING_VIDEO_INTENT = 5000;

  // Audio services may replace a metadata-confirmed audio-only <video> during
  // a stream reset. Carry that role to an immediate replacement on the same
  // route; visual metadata revokes provisional replacement evidence before the
  // playing guard runs. A confirmed role stays with its original element.
  const MS_AUDIO_TRANSPORT_REPLACEMENT = 5000;

  // Twitch can optimistically show Pause after our resolved autoplay
  // acknowledgement even though its media is paused. Retry through Twitch's
  // own controller so the first real user click does not become a no-op Pause.
  const MS_TWITCH_CONTROLLER_RETRY = 80;

  // Twitch's controller can issue a real user-authorized play() that resolves
  // but is immediately rolled back while IVS finishes restoring the stream.
  // Retry the already controller-owned native start once when media is ready.
  const MS_TWITCH_USER_START_RETRY = 80;
  const MS_TWITCH_USER_START_READY_RETRY = 220;
  const MS_TWITCH_USER_START_FINAL_RETRY = 450;

  const INTERVAL_TRACE_MS = 500;

  // A trusted click on a YouTube watch link must be tied to the exact target
  // video. This survives the SPA route reset long enough to block the target's
  // first play(), while unrelated player gestures cannot affect auto-next.
  const MS_YOUTUBE_NAVIGATION_INTENT = 5000;

  // ---------------------------------------------------------------------------
  // Configuration (received from ISOLATED world via ytap-config event)
  // The model owns defaults; this instance owns runtime configuration.
  // ---------------------------------------------------------------------------
  const cfg = { ...YTAPSettings.mainDefaults };

  // ---------------------------------------------------------------------------
  // Playback state
  // ---------------------------------------------------------------------------
  const state = {
    armed: false,
    pausedOnce: false,
    userStarted: false,
    userStartedRouteKey: "", // Manual permission belongs to one SPA route.
    routeKey: "",
    navSeq: 0,
    playSeq: 0,
  };

  // ---------------------------------------------------------------------------
  // Gesture tracking (timestamps in ms from performance.now())
  // ---------------------------------------------------------------------------
  const gesture = {
    lastAnyAt: 0,
    lastPlayerAt: 0,
    lastPlayControlAt: 0,
    lastAutopauseAt: 0,
    lastInPlayerAreaAt: 0,
    lastVideo: null,
    routeKey: "",
    pointerSeq: 0,
    pendingVideoIntentAt: 0,
    pendingVideoIntentRouteKey: "",
  };

  // Debug-only: video event tracing
  let traceIntervalId = null;
  const tracedVideos = new WeakSet();
  const guardedVideos = new WeakSet();
  const userAllowedVideoRoutes = new WeakMap();
  const videoPlayAttemptCounts = new WeakMap();
  const autoplayInterventionRoutes = new WeakMap();
  const mediaDebugIds = new WeakMap();
  const mediaSourceDebugStates = new WeakMap();
  let youtubePlayDebugWindows = new WeakMap();
  const twitchControllerSyncRoutes = new WeakMap();
  const twitchUserStartRetries = new WeakMap();
  const startupHeldVideos = new Set();
  const startupAutoplayVideos = new WeakSet();
  const startupPlayRequests = [];
  const mediaEvidence = YTAPMediaEvidence.create({ now: nowMs, replacementMs: MS_AUDIO_TRANSPORT_REPLACEMENT });
  let mediaRouteScope = { routeKey: "", generation: 0 };
  let pendingYouTubeNavigation = { videoId: "", at: 0 };
  let pendingYouTubePlay = null;
  let manualYouTubePlaylistRouteKey = "";
  let pausedYouTubeVideoCarryover = { video: null, at: 0 };
  let nextMediaDebugId = 1;
  let nextMediaSourceDebugId = 1;

  function nowMs() {
    return performance.now();
  }

  function mediaDebugId(media) {
    if (!media || (typeof media !== "object" && typeof media !== "function")) return "none";
    let id = mediaDebugIds.get(media);
    if (!id) {
      id = `m${nextMediaDebugId}`;
      nextMediaDebugId += 1;
      mediaDebugIds.set(media, id);
    }
    return id;
  }

  function mediaSourceDebugSnapshot(media) {
    if (!media || (typeof media !== "object" && typeof media !== "function")) {
      return { sourceId: "none" };
    }
    let state = mediaSourceDebugStates.get(media) || { rawSource: "", sourceId: "none" };
    let rawSource = "";
    try {
      rawSource = String(media.currentSrc || media.src || "");
    } catch {
      // A hostile/custom media element may reject source access.
    }
    if (rawSource && rawSource !== state.rawSource) {
      state = { rawSource, sourceId: `s${nextMediaSourceDebugId}` };
      nextMediaSourceDebugId += 1;
      mediaSourceDebugStates.set(media, state);
    } else if (!mediaSourceDebugStates.has(media)) {
      mediaSourceDebugStates.set(media, state);
    }
    return {
      // Retain the last safe id while currentSrc is empty so an `emptied`
      // event still identifies which source lifecycle was reset. A later
      // non-empty different source receives the next id.
      sourceId: state.sourceId,
    };
  }

  const pageContext = YTAPPageContext.create({ location, document, window });
  const visibilityPlayback = YTAPVisibilityPlayback.install({
    document,
    getConfig: () => cfg,
    isCovered: () => cfg.settingsReady && shouldArmForUrl(),
    getScope: () => syncMediaRouteScope("visibility"),
    isMainVideo,
    isUserAllowedVideo,
    play: (video) => originalPlay.call(video),
    onAction: (action, video) => log(`visibilitychange: ${action}`, `mediaId=${mediaDebugId(video)}`),
  });
  const {
    isYouTubeHost, isTwitchHost, isKickHost,
    isTwitchKickHost, isOtherSite, isDedicatedSpaHost, isVideoPage, isPlaylistWatch,
    currentRouteKey, currentYouTubeVideoId,
  } = pageContext;

  function youtubeWatchTargetVideoId(path) {
    if (!isYouTubeHost()) return "";
    for (const node of path || []) {
      if (!node || String(node.tagName || "").toUpperCase() !== "A") continue;
      const href = typeof node.href === "string" && node.href
        ? node.href
        : node.getAttribute?.("href");
      if (!href) continue;
      try {
        const url = new URL(href, location.href);
        const host = url.hostname.toLowerCase();
        const isYouTubeTarget = YTAPSiteContext.platform(host) === "youtube";
        if (!isYouTubeTarget || url.pathname !== "/watch") continue;
        const videoId = url.searchParams.get("v") || "";
        if (videoId) return videoId;
      } catch {
        // Ignore malformed/non-URL href values.
      }
    }
    return "";
  }

  function isPrimaryUnmodifiedNavigationEvent(e, kind) {
    if (kind !== "pointerdown" && kind !== "click") return false;
    if (typeof e?.button === "number" && e.button !== 0) return false;
    return !e?.ctrlKey && !e?.metaKey && !e?.shiftKey && !e?.altKey;
  }

  function rememberYouTubeNavigationIntent(videoId) {
    pendingYouTubeNavigation = { videoId, at: nowMs() };
    flow("YouTube navigation intent recorded", "hasTargetVideo=true");
  }

  function dispatchGestureSignal(detail) {
    try {
      window.dispatchEvent(new CustomEvent("ytap-gesture", { detail }));
    } catch {}
  }

  function resolveManualYouTubePlaylistRoute(routeKey = currentRouteKey()) {
    if (manualYouTubePlaylistRouteKey && manualYouTubePlaylistRouteKey !== routeKey) {
      manualYouTubePlaylistRouteKey = "";
    }
    if (!isPlaylistWatch()) {
      pendingYouTubeNavigation = { videoId: "", at: 0 };
      manualYouTubePlaylistRouteKey = "";
      return false;
    }
    if (!pendingYouTubeNavigation.videoId) {
      const manualRoute = manualYouTubePlaylistRouteKey === routeKey;
      flow(
        "YouTube playlist navigation classified",
        "hadNavigationIntent=false",
        "navigationIntentFresh=false",
        "targetMatchesRoute=false",
        `manualRoute=${manualRoute}`
      );
      return manualRoute;
    }

    const ageMs = nowMs() - pendingYouTubeNavigation.at;
    const navigationIntentFresh = ageMs >= 0 && ageMs <= MS_YOUTUBE_NAVIGATION_INTENT;
    const targetMatchesRoute = pendingYouTubeNavigation.videoId === currentYouTubeVideoId();
    const matches = navigationIntentFresh && targetMatchesRoute;
    pendingYouTubeNavigation = { videoId: "", at: 0 };
    if (matches) {
      manualYouTubePlaylistRouteKey = routeKey;
    }
    const manualRoute = manualYouTubePlaylistRouteKey === routeKey;
    flow(
      "YouTube playlist navigation classified",
      "hadNavigationIntent=true",
      `navigationIntentFresh=${navigationIntentFresh}`,
      `targetMatchesRoute=${targetMatchesRoute}`,
      `manualRoute=${manualRoute}`
    );
    return manualRoute;
  }

  function resetMediaRouteScope(routeKey = currentRouteKey(), source = "") {
    visibilityPlayback.cancel();
    pendingYouTubePlay = null;
    youtubePlayDebugWindows = new WeakMap();
    const previousRouteKey = mediaRouteScope.routeKey;
    mediaRouteScope = {
      routeKey,
      generation: mediaRouteScope.generation + 1,
    };
    mediaEvidence.reset(mediaRouteScope);
    if (previousRouteKey) {
      gesture.lastAnyAt = 0;
      gesture.lastPlayerAt = 0;
      gesture.lastPlayControlAt = 0;
      gesture.lastInPlayerAreaAt = 0;
      gesture.lastAutopauseAt = 0;
      gesture.lastVideo = null;
      gesture.routeKey = "";
      clearPendingVideoIntent("media route scope reset");
      state.pausedOnce = false;
      state.playSeq = 0;
    }
    flow("media route scope reset", {
      source,
      previousRouteKey,
      routeKey,
      generation: mediaRouteScope.generation,
    });
    return mediaRouteScope;
  }

  function syncMediaRouteScope(source = "") {
    const routeKey = currentRouteKey();
    if (mediaRouteScope.routeKey === routeKey) return mediaRouteScope;
    return resetMediaRouteScope(routeKey, source);
  }

  function mediaLayoutSize(media) {
    if (!debug || !media || typeof media.getBoundingClientRect !== "function") return "not-collected";
    try {
      const rect = media.getBoundingClientRect();
      const width = Math.max(0, Math.round(Number(rect?.width) || 0));
      const height = Math.max(0, Math.round(Number(rect?.height) || 0));
      return `${width}x${height}`;
    } catch {
      return "unavailable";
    }
  }

  function shouldArmForUrl() {
    return YTAPPlaybackPolicy.coverage(cfg,
      pageContext.coverageFacts(manualYouTubePlaylistRouteKey === currentRouteKey())
    ).armed;
  }

  function shouldHoldForStartupSettings() {
    return !cfg.settingsReady;
  }

  function blockedPlaybackMode() {
    return shouldHoldForStartupSettings() ? "hold" : profileForPlayback().blockedPlay;
  }

  function youtubeAutoplayDeniedError(video, reason = "autoplay") {
    log("YouTube autoplay denied", `profile=${profileForPlayback().id}`, `reason=${reason}`,
      `mediaId=${mediaDebugId(video)}`, `sourceId=${mediaSourceDebugSnapshot(video).sourceId}`,
      "nativePlaySkipped=true", `stopModeSourceResetSkipped=${cfg.stopInsteadOfPause}`);
    return new DOMException("Autoplay is blocked until the user starts playback.", "NotAllowedError");
  }

  function isUserAllowedVideo(video) {
    if (!video) return false;
    if (isOtherSite()) {
      const mediaScope = syncMediaRouteScope("user-allow-check");
      const allowedScope = userAllowedVideoRoutes.get(video);
      return allowedScope?.routeKey === mediaScope.routeKey
        && allowedScope?.generation === mediaScope.generation;
    }
    return state.userStarted && state.userStartedRouteKey === currentRouteKey();
  }

  function markUserStarted(video, reason) {
    if (pausedYouTubeVideoCarryover.video === video) {
      clearPausedYouTubeVideoCarryover("user started carried video");
    }
    const mediaScope = syncMediaRouteScope("mark-user-started");
    visibilityPlayback.markManual(video, mediaScope);
    if (isOtherSite()) {
      userAllowedVideoRoutes.set(video, {
        routeKey: mediaScope.routeKey,
        generation: mediaScope.generation,
      });
      flow("user allowed video", { reason, routeKey: mediaScope.routeKey, generation: mediaScope.generation });
      return;
    }
    state.userStarted = true;
    state.userStartedRouteKey = currentRouteKey();
    flow("user allowed route", { reason, routeKey: state.userStartedRouteKey });
    setArmed(false, reason);
  }

  function getVideoPlayAttemptCount(video) {
    return videoPlayAttemptCounts.get(video) || 0;
  }

  function noteVideoPlayAttempt(video) {
    videoPlayAttemptCounts.set(video, getVideoPlayAttemptCount(video) + 1);
  }

  function noteAutoplayIntervention(video, reason) {
    if (!video) return;
    const mediaScope = syncMediaRouteScope("autoplay-intervention");
    const previous = autoplayInterventionRoutes.get(video);
    const sameIntervention = previous?.routeKey === mediaScope.routeKey
      && previous?.generation === mediaScope.generation;
    autoplayInterventionRoutes.set(video, {
      routeKey: mediaScope.routeKey,
      generation: mediaScope.generation,
      audio: sameIntervention ? previous.audio : isTwitchKickHost()
        ? { muted: video.muted, volume: video.volume } : null,
    });
    flow("autoplay intervention recorded", {
      reason,
      routeKey: mediaScope.routeKey,
      generation: mediaScope.generation,
    });
  }

  function hasAutoplayIntervention(video) {
    if (!video) return false;
    const mediaScope = syncMediaRouteScope("intervention-check");
    const interventionScope = autoplayInterventionRoutes.get(video);
    return interventionScope?.routeKey === mediaScope.routeKey
      && interventionScope?.generation === mediaScope.generation;
  }

  function clearAutoplayIntervention(video) {
    if (video) autoplayInterventionRoutes.delete(video);
  }

  function clearPausedYouTubeVideoCarryover(reason = "") {
    const video = pausedYouTubeVideoCarryover.video;
    if (!video) return;
    pausedYouTubeVideoCarryover = { video: null, at: 0 };
    flow("YouTube paused video carryover cleared", {
      reason,
      mediaId: mediaDebugId(video),
    });
  }

  function rememberPausedYouTubeVideoCarryover() {
    if (!isYouTubeHost() || isVideoPage()) {
      clearPausedYouTubeVideoCarryover("entered video route");
      return;
    }

    const existingVideo = pausedYouTubeVideoCarryover.video;
    if (existingVideo && existingVideo.isConnected !== false) return;
    clearPausedYouTubeVideoCarryover("previous media disconnected");

    // Do not call findMainVideo() here: its media classification synchronizes
    // the new URL and would discard the previous route generation before we can
    // prove that this exact element was paused by the extension.
    const video = [
      document.querySelector("video.html5-main-video"),
      document.querySelector("#movie_player video"),
      document.querySelector("ytd-player video"),
    ].find((candidate) => candidate instanceof HTMLVideoElement) || null;
    const intervention = video ? autoplayInterventionRoutes.get(video) : null;
    const interventionBelongsToPreviousRoute = intervention?.routeKey === mediaRouteScope.routeKey
      && intervention?.generation === mediaRouteScope.generation;
    const userStartedPreviousRoute = state.userStarted
      && state.userStartedRouteKey === state.routeKey;
    if (!video || !interventionBelongsToPreviousRoute || userStartedPreviousRoute) return;

    pausedYouTubeVideoCarryover = { video, at: nowMs() };
    flow("YouTube paused video carryover recorded", {
      mediaId: mediaDebugId(video),
      paused: video.paused,
    });
    log("YouTube paused video will remain paused after leaving the video page", `mediaId=${mediaDebugId(video)}`);
  }

  function isPausedYouTubeVideoCarryover(video) {
    if (pausedYouTubeVideoCarryover.video !== video) return false;
    if (
      video?.isConnected === false
      || !cfg.enabled
      || !cfg.applyToYouTube
      || !isYouTubeHost()
      || isVideoPage()
    ) {
      clearPausedYouTubeVideoCarryover("carryover no longer applies");
      return false;
    }
    return true;
  }

  function shouldAllowPausedYouTubeCarryover(video) {
    if (!isPausedYouTubeVideoCarryover(video)) return false;
    if (gesture.routeKey !== currentRouteKey() || gesture.lastVideo !== video) return false;
    const t = nowMs();
    const playerIntentAt = Math.max(gesture.lastPlayerAt, gesture.lastPlayControlAt);
    const recentPlayerIntent = playerIntentAt > 0 && t - playerIntentAt < MS_RECENT_GESTURE;
    return recentPlayerIntent && playerIntentAt >= pausedYouTubeVideoCarryover.at;
  }

  function clearPendingVideoIntent(reason = "") {
    if (gesture.pendingVideoIntentAt > 0 && reason) {
      flow("pending video intent cleared", { reason, routeKey: gesture.pendingVideoIntentRouteKey });
    }
    gesture.pendingVideoIntentAt = 0;
    gesture.pendingVideoIntentRouteKey = "";
  }

  function rememberPendingVideoIntent(reason) {
    if (!isOtherSite() || !state.armed) return;
    gesture.pendingVideoIntentAt = nowMs();
    gesture.pendingVideoIntentRouteKey = currentRouteKey();
    flow("pending video intent recorded", { reason, routeKey: gesture.pendingVideoIntentRouteKey });
  }

  function consumePendingVideoIntent(video, reason) {
    if (!isOtherSite() || !state.armed || !video || gesture.pendingVideoIntentAt <= 0) return false;
    const routeKey = currentRouteKey();
    const ageMs = nowMs() - gesture.pendingVideoIntentAt;
    if (gesture.pendingVideoIntentRouteKey !== routeKey || ageMs < 0 || ageMs > MS_PENDING_VIDEO_INTENT) {
      clearPendingVideoIntent("expired or route changed");
      return false;
    }

    clearPendingVideoIntent();
    const t = nowMs();
    gesture.lastAnyAt = t;
    gesture.lastPlayerAt = t;
    gesture.lastPlayControlAt = t;
    gesture.lastInPlayerAreaAt = t;
    gesture.lastVideo = video;
    gesture.routeKey = routeKey;
    markUserStarted(video, reason);
    flow("pending video intent → bound to video", { reason, routeKey, ageMs: Math.round(ageMs) });
    return true;
  }

  function schedulePendingVideoIntentFallback(video) {
    const routeKey = currentRouteKey();
    const pointerSeq = gesture.pointerSeq;
    const playAttemptsBefore = getVideoPlayAttemptCount(video);
    flow("pending video intent fallback scheduled", {
      routeKey,
      delayMs: MS_GENERIC_CONTROLLER_PLAY_FALLBACK,
      playAttemptsBefore,
    });

    setTimeout(() => {
      if (gesture.pointerSeq !== pointerSeq || !state.armed || !shouldArmForUrl()) return;
      if (video.isConnected === false || currentRouteKey() !== routeKey || !video.paused) return;
      if (!isUserAllowedVideo(video)) return;
      const playAttemptsAfter = getVideoPlayAttemptCount(video);
      if (playAttemptsAfter !== playAttemptsBefore) {
        flow("pending video intent fallback skipped", "site attempted play", { playAttemptsBefore, playAttemptsAfter });
        return;
      }

      flow("pending video intent fallback → start playback", { routeKey });
      prepareUserPlayback(video);
      try {
        const promise = originalPlay.call(video);
        promise?.catch?.((error) => log("pending video intent fallback play() rejected", error?.message || error));
      } catch (error) {
        log("pending video intent fallback play() threw", error?.message || error);
      }
    }, MS_GENERIC_CONTROLLER_PLAY_FALLBACK);
  }

  function restoreStoppedSource(video) {
    if (mediaSources.restore(video)) {
      log("stop-mode source restored", `mediaId=${mediaDebugId(video)}`, `sourceId=${mediaSourceDebugSnapshot(video).sourceId}`);
    }
  }

  function prepareUserPlayback(video) {
    try {
      restoreStoppedSource(video);
      const intervention = autoplayInterventionRoutes.get(video);
      if (isTwitchKickHost() && intervention?.audio && hasAutoplayIntervention(video)) {
        const audio = intervention.audio;
        intervention.audio = null;
        video.muted = audio.muted;
        video.volume = audio.volume;
        log("Audio restored after autoplay block", `mediaId=${mediaDebugId(video)}`, `muted=${video.muted}`, `volume=${video.volume}`);
      }
    } catch {
      // Best-effort restoration; the site's play path may still succeed.
    }
  }

  function releaseAudioRestoration(video) {
    const intervention = autoplayInterventionRoutes.get(video);
    if (!intervention?.audio) return;
    intervention.audio = null;
    log("Audio restoration released by user input", `mediaId=${mediaDebugId(video)}`);
  }

  function classifyVideoMedia(el) {
    try {
      if (!(el instanceof HTMLVideoElement)) return { kind: "not-video", evidence: "element-type", mediaId: mediaDebugId(el) };

      syncMediaRouteScope("classify");
      const readyState = Number(el.readyState) || 0;
      const videoWidth = Number(el.videoWidth) || 0;
      const videoHeight = Number(el.videoHeight) || 0;
      const mediaId = mediaDebugId(el);
      const decision = mediaEvidence.classify(el, { readyState, videoWidth, videoHeight }, isOtherSite());
      return {
        kind: decision.kind, evidence: decision.evidence, mediaId, readyState, videoWidth, videoHeight,
      };
    } catch {
      return { kind: "unknown", evidence: "classification-error", mediaId: mediaDebugId(el), readyState: 0, videoWidth: 0, videoHeight: 0 };
    }
  }

  function isKnownAudioTransportVideo(el) {
    return classifyVideoMedia(el).kind === "audio-transport";
  }

  function noteAudioTransportReset(video, source) {
    if (!isOtherSite() || !(video instanceof HTMLVideoElement)) return;
    const mediaScope = syncMediaRouteScope(source);
    if (!mediaEvidence.noteReset(video, true)) return;
    flow("audio replacement window opened", {
      source,
      mediaId: mediaDebugId(video),
      routeKey: mediaScope.routeKey,
      generation: mediaScope.generation,
    });
    log(
      "audio replacement window opened",
      `mediaId=${mediaDebugId(video)}`,
      `generation=${mediaScope.generation}`,
      `source=${source}`
    );
  }

  function isMainVideo(el) {
    try {
      if (!(el instanceof HTMLVideoElement)) return false;
      if (isKnownAudioTransportVideo(el)) return false;
      if (!isYouTubeHost()) return true;
      if (cfg.ignoreMiniplayer) {
        // PiP uses the same <video> element; we should not fight it.
        if (document.pictureInPictureElement === el) return false;

        // YouTube miniplayer containers (best-effort; DOM varies).
        if (el.closest?.("ytd-miniplayer, ytd-miniplayer-bar, #miniplayer")) return false;
      }
      if (el.classList?.contains("html5-main-video")) return true;
      if (el.closest?.("#movie_player, .html5-video-player")) return true;
      if (cfg.applyToChannelPlayer && el.closest?.("ytd-channel-video-player-renderer, ytd-player")) return true;
      return false;
    } catch {
      return false;
    }
  }

  function findMainVideo() {
    const preferred = [
      document.querySelector("video.html5-main-video"),
      document.querySelector("#movie_player video"),
      document.querySelector("ytd-player video"),
      document.querySelector("video"),
    ];
    const preferredVisualVideo = preferred.find((video) => video && !isKnownAudioTransportVideo(video));
    if (preferredVisualVideo) return preferredVisualVideo;
    return Array.from(document.querySelectorAll("video")).find((video) => !isKnownAudioTransportVideo(video)) || null;
  }

  function shouldAllowUserPlay(video) {
    const t = nowMs();
    const sameMedia = !isOtherSite() || gesture.lastVideo === video;
    if (!sameMedia) return false;
    const sameRoute = gesture.routeKey === currentRouteKey();
    if (!sameRoute) {
      flow("shouldAllowUserPlay → false", "gesture belongs to another route");
      return false;
    }
    const timing = YTAPPlaybackPolicy.gestureTiming(gesture, t, MS_RECENT_GESTURE);
    const decision = YTAPPlaybackPolicy.userPlay({
      sameMedia,
      sameRoute,
      pausedOnce: state.pausedOnce,
    }, timing);
    return decision.allowed;
  }

  function setArmed(nextArmed, reason) {
    const prev = state.armed;
    state.armed = nextArmed;
    if (prev !== state.armed) flow("setArmed", `prev=${prev}`, `next=${nextArmed}`, `reason=${reason}`);
    if (!state.armed) clearPendingVideoIntent("extension disarmed");
    updateVideoObserver();
    if (state.armed) queueMicrotask(() => scanVideos(document));
  }

  function resetForNavigation(reason, nextRouteKey = currentRouteKey()) {
    resolveManualYouTubePlaylistRoute(nextRouteKey);
    rememberPausedYouTubeVideoCarryover();
    resetMediaRouteScope(nextRouteKey, reason);
    state.navSeq += 1;
    state.playSeq = 0;
    state.routeKey = nextRouteKey;
    gesture.lastInPlayerAreaAt = 0;
    gesture.lastAnyAt = 0;
    gesture.lastPlayerAt = 0;
    gesture.lastPlayControlAt = 0;
    gesture.lastAutopauseAt = 0;
    gesture.lastVideo = null;
    gesture.routeKey = "";
    clearPendingVideoIntent("navigation reset");
    state.userStarted = false;
    state.userStartedRouteKey = "";
    state.pausedOnce = false;
    flow("resetForNavigation", { navSeq: state.navSeq, reason, routeKey: nextRouteKey });
    setArmed(shouldArmForUrl(), `nav#${state.navSeq}:${reason}`);
  }

  /**
   * Twitch/Kick/YouTube reuse a document and often the same <video> across routes.
   * Check the route at every correctness-critical entry point so blocking does
   * not depend on a delayed site event or the ISOLATED world's URL poll.
   */
  function syncDedicatedRoute(source) {
    if (!isDedicatedSpaHost()) return false;

    const nextRouteKey = currentRouteKey();
    if (!state.routeKey) {
      state.routeKey = nextRouteKey;
      return false;
    }
    if (state.routeKey === nextRouteKey) return false;

    const previousRouteKey = state.routeKey;
    flow("route scope changed", {
      source,
      from: previousRouteKey,
      to: nextRouteKey,
      armed: state.armed,
      userStarted: state.userStarted,
      userStartedRouteKey: state.userStartedRouteKey,
    });
    resetForNavigation(`route-change:${source}`, nextRouteKey);
    return true;
  }

  function youtubeDebugFields(video) {
    if (!debug || !isYouTubeHost()) return [];
    const diagnostic = youtubeDiagnosticState(video);
    return [
      `atMs=${Math.round(nowMs())}`,
      `duration=${Number.isFinite(video.duration) ? video.duration.toFixed(2) : "unknown"}`,
      `adShowing=${diagnostic.adShowing}`,
      `controllerContent=${diagnostic.content}`,
      `assignedMatchesCurrent=${video.src && video.currentSrc ? video.src === video.currentSrc : "unknown"}`,
    ];
  }

  function traceVideoEvents(video) {
    if (!debug) return;
    if (!video || !(video instanceof HTMLVideoElement)) return;
    if (tracedVideos.has(video)) {
      return;
    }

    tracedVideos.add(video);
    const initialSource = mediaSourceDebugSnapshot(video);
    info(
      "Tracing main video events",
      `mediaId=${mediaDebugId(video)}`,
      `sourceId=${initialSource.sourceId}`,
      { src: (video.currentSrc || video.src || "").slice(0, 80) }
    );

    const events = [
      "play",
      "playing",
      "pause",
      "waiting",
      "seeking",
      "seeked",
      "loadedmetadata",
      "loadeddata",
      "canplay",
      "canplaythrough",
      "durationchange",
      "resize",
      "emptied",
      "ended",
      "stalled",
      "suspend",
      "ratechange",
    ];

    for (const evt of events) {
      video.addEventListener(
        evt,
        () => {
          const source = mediaSourceDebugSnapshot(video);
          log(
            "VIDEO:",
            evt,
            `mediaId=${mediaDebugId(video)}`,
            `sourceId=${source.sourceId}`,
            `paused=${video.paused}`,
            `readyState=${video.readyState}`,
            `size=${video.videoWidth || 0}x${video.videoHeight || 0}`,
            `layout=${mediaLayoutSize(video)}`,
            `time=${Number.isFinite(video.currentTime) ? video.currentTime.toFixed(2) : "unknown"}`,
            `networkState=${Number.isInteger(video.networkState) ? video.networkState : "unknown"}`,
            ...youtubeDebugFields(video),
            {
              paused: video.paused,
              time: Number.isFinite(video.currentTime) ? video.currentTime.toFixed(2) : video.currentTime,
              readyState: video.readyState,
              networkState: video.networkState,
              src: (video.currentSrc || video.src || "").slice(0, 80),
            }
          );
        },
        true
      );
    }
  }

  function ensureTraceLoop() {
    if (!debug) {
      if (traceIntervalId) {
        clearInterval(traceIntervalId);
        traceIntervalId = null;
      }
      return;
    }

    if (traceIntervalId) return;
    traceIntervalId = setInterval(() => {
      const v = findMainVideo();
      if (v) traceVideoEvents(v);
    }, INTERVAL_TRACE_MS);
  }

  function attachPlaybackGuard(video) {
    if (!video || !(video instanceof HTMLVideoElement)) return;
    if (guardedVideos.has(video)) return;
    guardedVideos.add(video);
    visibilityPlayback.observe(video);

    const enforcePlaybackGuard = (source, requireVisualMetadata = false) => {
      syncDedicatedRoute(source);
      const media = classifyVideoMedia(video);
      const userAllowed = isUserAllowedVideo(video);
      const pausedCarryover = isPausedYouTubeVideoCarryover(video);
      flow("VIDEO playback guard", `source=${source}`, `mediaId=${media.mediaId}`,
        `mediaKind=${media.kind}`, `mediaEvidence=${media.evidence}`, `armed=${state.armed}`,
        `userAllowed=${userAllowed}`, `pausedCarryover=${pausedCarryover}`, `isMain=${isMainVideo(video)}`);
      if (media.kind === "audio-transport") return;
      if (requireVisualMetadata && media.kind !== "visual") return;
      if (video.paused || (!state.armed && !pausedCarryover) || userAllowed) return;
      if (!pausedCarryover && !isMainVideo(video)) return;
      if (pausedCarryover && shouldAllowPausedYouTubeCarryover(video)) {
        markUserStarted(video, `${source}-after-miniplayer-gesture`);
        return;
      }
      if (consumePendingVideoIntent(video, `late-video-${source}`)) return;
      if (shouldAllowUserPlay(video)) {
        markUserStarted(video, `${source}-after-user-gesture`);
        return;
      }

      flow(`${source} guard → pausing (visual video started while armed)`);
      if (shouldHoldForStartupSettings()) startupHeldVideos.add(video);
      noteAutoplayIntervention(video, `${source}-guard`);
      state.pausedOnce = true;
      gesture.lastAutopauseAt = nowMs();
      try {
        video.pause();
        log(`${source} guard: visual video started while armed → paused`);
      } catch {}
    };

    video.addEventListener(
      "playing",
      () => enforcePlaybackGuard("playing-event"),
      true
    );

    video.addEventListener(
      "emptied",
      () => {
        if (pausedYouTubeVideoCarryover.video === video) {
          // YouTube may reuse this exact <video> during navigation and reset
          // its MediaSource. `emptied` is a lifecycle event, not user intent,
          // so it must not release an extension-owned pause for this element.
          flow("YouTube paused video carryover retained after media reset", {
            mediaId: mediaDebugId(video),
          });
        }
        noteAudioTransportReset(video, "emptied-event");
      },
      true
    );

    // A remembered audio role is provisional while metadata is absent. Revoke
    // it as soon as a replacement exposes visual dimensions, even if its only
    // `playing` event fired before those dimensions became available.
    for (const eventName of ["loadedmetadata", "resize"]) {
      video.addEventListener(
        eventName,
        () => enforcePlaybackGuard(`${eventName}-event`, true),
        true
      );
    }
  }

  function neutralizeDeclarativeAutoplay(video) {
    if (!video || !(video instanceof HTMLVideoElement)) return;
    attachPlaybackGuard(video);
    if (isKnownAudioTransportVideo(video)) return;
    if (!state.armed || !isMainVideo(video) || isUserAllowedVideo(video)) return;

    try {
      let pendingIntentConsumed = false;
      if (video.autoplay || video.hasAttribute("autoplay")) {
        if (!cfg.settingsReady) {
          startupHeldVideos.add(video);
          startupAutoplayVideos.add(video);
        }
        video.autoplay = false;
        video.removeAttribute("autoplay");
        noteAutoplayIntervention(video, "declarative-autoplay");
        pendingIntentConsumed = consumePendingVideoIntent(video, "late-video-after-play-control");
        if (pendingIntentConsumed && video.paused) schedulePendingVideoIntentFallback(video);
        log("Removed declarative autoplay", video);
      }
      if (!video.paused) {
        if (pendingIntentConsumed) return;
        if (!cfg.settingsReady) startupHeldVideos.add(video);
        noteAutoplayIntervention(video, "scan-playing-video");
        state.pausedOnce = true;
        gesture.lastAutopauseAt = nowMs();
        video.pause();
      }
    } catch {
      // ignore hostile/custom media elements
    }
  }

  function scanVideos(root) {
    if (!root) return;
    if (root instanceof HTMLVideoElement) neutralizeDeclarativeAutoplay(root);
    if (typeof root.querySelectorAll !== "function") return;
    root.querySelectorAll("video").forEach(neutralizeDeclarativeAutoplay);
  }

  const videoObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        neutralizeDeclarativeAutoplay(record.target);
        continue;
      }
      record.addedNodes.forEach(scanVideos);
    }
  });
  let videoObserverActive = false;

  function updateVideoObserver() {
    if (!state.armed) {
      if (videoObserverActive) videoObserver.disconnect();
      videoObserverActive = false;
      return;
    }
    if (videoObserverActive) return;
    videoObserver.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["autoplay"],
    });
    videoObserverActive = true;
  }

  // ---------------------------------------------------------------------------
  // Patch play()
  // ---------------------------------------------------------------------------

  function playRequestFacts(video, carryover, t) {
    const userAllowed = isUserAllowedVideo(video);
    const contentState = isYouTubeHost() && cfg.settingsReady && shouldArmForUrl()
      && (state.armed || userAllowed) ? youtubeContentState(video) : "unknown";
    const pending = contentState === "current" ? pendingYouTubePlay : null;
    if (contentState === "current") pendingYouTubePlay = null;
    const pendingAge = pending ? t - pending.at : Infinity;
    const delta = gesture.lastInPlayerAreaAt > 0 ? t - gesture.lastInPlayerAreaAt : Infinity;
    return {
      contentState, carryover, userAllowed, armed: state.armed,
      pendingSelection: !!pending && pending.routeKey === currentRouteKey()
        && pendingAge >= 0 && pendingAge <= MS_YOUTUBE_CONTROLLER_INTENT,
      carryoverAllowed: carryover && shouldAllowPausedYouTubeCarryover(video),
      recentAreaClick: (!isOtherSite() || gesture.lastVideo === video)
        && gesture.routeKey === currentRouteKey() && delta < MS_CLICK_IN_PLAYER_ALLOW_PLAY,
      userIntent: shouldAllowUserPlay(video),
    };
  }

  function tracePlayRequest(video, seq, media, source, facts, decision) {
    if (!debug) return;
    flow("play()", `seq=${seq}`, `decision=${decision}`, `mediaId=${media.mediaId}`,
      `sourceId=${source.sourceId}`, `armed=${facts.armed}`, `pausedOnce=${state.pausedOnce}`,
      `userAllowed=${facts.userAllowed}`, `pausedCarryover=${facts.carryover}`, `paused=${video.paused}`,
      `readyState=${video.readyState}`, `size=${video.videoWidth || 0}x${video.videoHeight || 0}`,
      `layout=${mediaLayoutSize(video)}`, ...youtubeDebugFields(video));
  }

  function startUserRequest(video, args, seq, decision) {
    markUserStarted(video, `${decision}#${seq}`);
    if (decision === "recent-area-click") gesture.lastInPlayerAreaAt = 0;
    prepareUserPlayback(video);
    const promise = originalPlay.apply(video, args);
    if (decision === "recent-area-click" && isTwitchHost()) scheduleTwitchUserStartRetry(video, seq, gesture.lastAnyAt);
    const reason = { "selected-controller": "selected-controller-play", "carryover-gesture": "carryover-controller-play", "user-gesture": "controller-play" }[decision];
    if (reason && isYouTubeHost()) observeYouTubeManualPlay(video, promise, reason);
    return promise;
  }

  HTMLMediaElement.prototype.play = function (...args) {
    if (!(this instanceof HTMLVideoElement)) {
      return originalPlay.apply(this, args);
    }

    // A dedicated SPA may call play() before its navigation event or the
    // ISOLATED polling fallback runs. Reconcile the route before classification:
    // classification also synchronizes media scope and would otherwise discard
    // the previous route's intervention ownership before carryover can capture it.
    syncDedicatedRoute("play");

    attachPlaybackGuard(this);
    const media = classifyVideoMedia(this);
    const source = mediaSourceDebugSnapshot(this);
    if (media.kind === "audio-transport") {
      log("play() → ALLOWED audio transport", `mediaId=${media.mediaId}`, `evidence=${media.evidence}`,
        `readyState=${media.readyState}`, `size=${media.videoWidth}x${media.videoHeight}`, `layout=${mediaLayoutSize(this)}`);
      return originalPlay.apply(this, args);
    }

    // The click fallback uses this counter to distinguish a broken/controllerless
    // player from a controller that has already tried to start its media.
    noteVideoPlayAttempt(this);

    const pausedCarryover = isPausedYouTubeVideoCarryover(this);
    if (!pausedCarryover && !isMainVideo(this)) {
      return originalPlay.apply(this, args);
    }

    state.playSeq += 1;
    const seq = state.playSeq;

    const t = nowMs();
    consumePendingVideoIntent(this, `late-video-play#${seq}`);
    const facts = playRequestFacts(this, pausedCarryover, t);
    const decision = YTAPPlaybackPolicy.playRequest(facts);
    tracePlayRequest(this, seq, media, source, facts, decision);
    if (decision === "deny-stale") {
      if (facts.userIntent) {
        const changed = pendingYouTubePlay?.at !== gesture.lastAnyAt;
        pendingYouTubePlay = { routeKey: currentRouteKey(), at: gesture.lastAnyAt };
        if (changed) flow("YouTube controller intent retained", `mediaId=${media.mediaId}`);
      }
      return Promise.reject(youtubeAutoplayDeniedError(this, "stale-content"));
    }
    if (decision === "authorized") {
      restoreStoppedSource(this);
      const promise = originalPlay.apply(this, args);
      if (debug && isYouTubeHost()) observeYouTubeManualPlay(this, promise, "authorized-controller-play", true);
      return promise;
    }

    if (["selected-controller", "carryover-gesture", "recent-area-click", "user-gesture"].includes(decision)) {
      return startUserRequest(this, args, seq, decision);
    }

    return blockVideoRequest.call(this, args, seq, media, source, decision === "deny-carryover");
  };

  function pauseBlockedVideo(video, seq) {
    try { if (!video.paused) video.pause(); }
    catch (error) { info(`#${seq} pause() threw`, error?.message || error); }
  }

  function blockVideoRequest(args, seq, media, source, pausedCarryover) {

    // YouTube may request play() for an extension-paused watch-page element
    // after leaving the watch route. Calling native play() and then pause() is
    // observably too late: it exposes transient playback to the controller.
    // A normal autoplay denial keeps controller state paused. A trusted click
    // can authorize this exact element through the carryover path.
    if (pausedCarryover) {
      noteAutoplayIntervention(this, `youtube-carryover-block#${seq}`);
      state.pausedOnce = true;
      gesture.lastAutopauseAt = nowMs();
      pauseBlockedVideo(this, seq);
      flow("play() → YOUTUBE CARRYOVER BLOCK DENIED", {
        seq,
        mediaId: media.mediaId,
        sourceId: source.sourceId,
        nativePlaySkipped: true,
      });
      log(
        "YouTube paused-video carryover blocked without native play",
        `mediaId=${media.mediaId}`,
        `sourceId=${source.sourceId}`
      );
      return Promise.reject(youtubeAutoplayDeniedError(this, "carryover"));
    }

    flow("play() → INTERCEPT", { seq });
    noteAutoplayIntervention(this, `play-intercept#${seq}`);
    state.pausedOnce = true;
    gesture.lastAutopauseAt = nowMs();
    const interceptSummary = [
      `mediaId=${media.mediaId}`,
      `media=${media.kind}`,
      `evidence=${media.evidence}`,
      `readyState=${media.readyState}`,
      `size=${media.videoWidth}x${media.videoHeight}`,
      `layout=${mediaLayoutSize(this)}`,
      `sourceId=${source.sourceId}`,
    ];
    const interceptAction = isYouTubeHost() || isTwitchHost()
      ? "block before native play()"
      : "pause()";
    if (seq <= 3) info(`#${seq} → INTERCEPTING autoplay → ${interceptAction}`, ...interceptSummary);
    else log(`#${seq} → INTERCEPTING autoplay → ${interceptAction}`, ...interceptSummary);
    log("state after intercept", { pausedOnce: state.pausedOnce, lastAutopauseAt: gesture.lastAutopauseAt });

    const blockMode = blockedPlaybackMode();
    if (blockMode === "hold") {
      flow("play() → HELD until settings are ready", { seq });
      return new Promise((resolve, reject) => {
        startupPlayRequests.push({ video: this, args, resolve, reject });
      });
    }

    // Preserve the native autoplay-denied contract so the controller prepares
    // its source and handles the first manual Play instead of assuming success.
    if (blockMode === "deny-youtube") {
      pauseBlockedVideo(this, seq);
      return Promise.reject(youtubeAutoplayDeniedError(this));
    }

    // Do not call Twitch's native media play() for an attempt we intend to
    // block. Starting and immediately pausing creates an IVS `Playing` listener
    // that survives the AbortError; enough route changes then produce
    // MaxListenersExceededWarning even when the rejection itself is consumed.
    // A resolved acknowledgement keeps the SDK out of its retry path. Genuine
    // user playback calls originalPlay directly from the gesture path.
    if (blockMode === "acknowledge-twitch") {
      pauseBlockedVideo(this, seq);
      scheduleTwitchPausedUiSync(this);
      flow("play() → TWITCH BLOCK ACKNOWLEDGED", { seq, nativePlaySkipped: true });
      return Promise.resolve();
    }

    const promise = originalPlay.apply(this, args);

    try {
      if (cfg.stopInsteadOfPause) {
        const result = mediaSources.stop(this);
        if (result === "still-active") log(`#${seq} stop-mode: video still active after src removal, falling back to pause`);
        if (result === "pause-only") log(`#${seq} stop-mode: no src yet, falling back to pause-only`);
      } else {
        this.pause();
      }
    } catch (e) {
      info(`#${seq} pause() threw`, e?.message || e);
    }

    // Keep the site's original promise chain intact where possible.
    if (promise && typeof promise.catch === "function") {
      promise.catch((e) => log(`#${seq} play() rejected`, e?.message || e));
    }

    return promise;
  }

  // ---------------------------------------------------------------------------
  // User intent signals
  // ---------------------------------------------------------------------------

  const {
    isOnPlayer, isOnPlayControl, isNonPlayControlPath, isAudioControlPath, profileForInput, profileForPlayback, youtubeContentState, youtubeDiagnosticState, genericGesturePathSummary, clickLooksLikePlaybackIntent,
    isGenericPlayControlPath, isGenericNonPlayControlPath,
    isKickPlayerFocused,
  } = YTAPPlayerDom.create({ document, isTwitchHost, isKickHost, isOtherSite, currentYouTubeVideoId });

  function debugPointerGeometry(e) {
    if (!debug || !isYouTubeHost() || !Number.isFinite(e?.clientX) || !Number.isFinite(e?.clientY)) {
      return { overVideoRect: "unknown" };
    }
    try {
      const video = document.querySelector?.("video.html5-main-video, #movie_player video, ytd-player video");
      if (!(video instanceof HTMLVideoElement)) return { overVideoRect: "unknown" };
      const rect = video.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return { overVideoRect: "unknown" };
      return {
        // Coordinates are diagnostic evidence only. YouTube player intent still
        // requires a matching composed DOM path because the masthead can overlap.
        overVideoRect:
          e.clientX >= rect.left && e.clientX <= rect.right
          && e.clientY >= rect.top && e.clientY <= rect.bottom,
      };
    } catch {
      return { overVideoRect: "unknown" };
    }
  }

  function logYouTubeUnmatchedPointer(e, path) {
    if (!debug) return;
    let focused = "unknown";
    let hitTarget = "unknown";
    let hitOnPlayer = "unknown";
    let viewportScrollbar = "unknown";
    try {
      if (typeof document.hasFocus === "function") focused = document.hasFocus();
      if (typeof document.elementFromPoint === "function") {
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        hitTarget = String(hit?.tagName || "none").toLowerCase();
        hitOnPlayer = isOnPlayer(hit ? [hit] : []);
      }
      const root = document.documentElement;
      if (Number.isFinite(root?.clientWidth) && Number.isFinite(root?.clientHeight)
        && Number.isFinite(window.innerWidth) && Number.isFinite(window.innerHeight)) {
        viewportScrollbar = (window.innerWidth > root.clientWidth && e.clientX >= root.clientWidth)
          || (window.innerHeight > root.clientHeight && e.clientY >= root.clientHeight);
      }
    } catch {
      // Diagnostic reads must not interfere with the site's input handling.
    }
    log(
      "YouTube unmatched pointer",
      `pointerSeq=${gesture.pointerSeq}`,
      `pathLength=${path.length}`,
      `button=${[0, 1, 2].includes(e.button) ? e.button : "other"}`,
      `pointerType=${["mouse", "touch", "pen"].includes(e.pointerType) ? e.pointerType : "other"}`,
      `focused=${focused}`,
      `hitTarget=${hitTarget}`,
      `hitOnPlayer=${hitOnPlayer}`,
      `viewportScrollbar=${viewportScrollbar}`
    );
  }

  function findInteractionVideo(e, path = []) {
    const pathVideo = path.find((node) => node instanceof HTMLVideoElement && !isKnownAudioTransportVideo(node));
    if (pathVideo) return pathVideo;
    if (!isOtherSite()) return findMainVideo();

    // A labelled Play control may sit outside the video rectangle. Only that
    // explicit intent may use an ancestor to find a sibling video; a page-wide
    // container holding one video does not turn ordinary links into Play.
    for (const node of isGenericPlayControlPath(path) ? path : []) {
      if (!node || node.nodeType !== 1 || typeof node.querySelectorAll !== "function") continue;
      if (node.tagName === "BODY" || node.tagName === "HTML") break;
      const candidates = Array.from(node.querySelectorAll("video")).filter((video) => {
        if (isKnownAudioTransportVideo(video)) return false;
        const rect = video.getBoundingClientRect?.();
        return !rect || (rect.width > 0 && rect.height > 0);
      });
      if (candidates.length === 1) return candidates[0];
    }

    const x = e?.clientX;
    const y = e?.clientY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      if (!isGenericPlayControlPath(path)) return null;
      const visible = Array.from(document.querySelectorAll("video")).filter((video) => {
        if (isKnownAudioTransportVideo(video)) return false;
        const rect = video.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return visible.length === 1 ? visible[0] : null;
    }

    let best = null;
    let bestArea = Infinity;
    document.querySelectorAll("video").forEach((video) => {
      if (isKnownAudioTransportVideo(video)) return;
      const rect = video.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
      const area = rect.width * rect.height;
      if (area < bestArea) {
        best = video;
        bestArea = area;
      }
    });
    return best;
  }

  function twitchPlaybackControlAction(control) {
    if (!control || control.nodeType !== 1) return "";
    const text = [
      control.getAttribute?.("aria-label"),
      control.getAttribute?.("title"),
      control.getAttribute?.("data-tooltip-text"),
      control.textContent,
    ].filter(Boolean).join(" ").toLowerCase();

    if (/pause|пауза|приостанов|pausa|pausar|pauza|duraklat|一時停止|暂停/i.test(text)) return "pause";
    if (/play|resume|воспроиз|продолж|reproduc|odtw|oynat|再生|播放/i.test(text)) return "play";
    return "";
  }

  function findTwitchPlaybackControl() {
    if (!isTwitchHost()) return null;
    const exact = document.querySelector?.("[data-a-target='player-play-pause-button']");
    if (exact && typeof exact.click === "function") return exact;

    const candidates = document.querySelectorAll?.(
      "[data-a-target='player-container'] button, .video-player button, .video-player__container button"
    );
    return Array.from(candidates || []).find((node) => twitchPlaybackControlAction(node)) || null;
  }

  function clickTwitchController(target, reason, detail = {}) {
    if (!target || typeof target.click !== "function") return false;
    try {
      flow("Twitch controller click", { reason, action: twitchPlaybackControlAction(target), ...detail });
      target.click();
      return true;
    } catch (error) {
      log("Twitch controller click failed", reason, error?.message || error);
      return false;
    }
  }

  function scheduleTwitchPausedUiSync(video) {
    if (!isTwitchHost() || !video) return;
    const routeKey = currentRouteKey();
    if (twitchControllerSyncRoutes.get(video) === routeKey) return;
    twitchControllerSyncRoutes.set(video, routeKey);
    const scheduledAt = nowMs();
    const delays = [0, 80, 200, 500];

    const attempt = (index) => {
      if (twitchControllerSyncRoutes.get(video) !== routeKey) return;
      if (video.isConnected === false || currentRouteKey() !== routeKey || !state.armed || !video.paused || isUserAllowedVideo(video)) {
        twitchControllerSyncRoutes.delete(video);
        return;
      }
      // A real gesture owns the next transition; the user-click recovery below
      // will finish it without racing an automatic controller click.
      if (gesture.lastAnyAt > scheduledAt) {
        twitchControllerSyncRoutes.delete(video);
        return;
      }

      const control = findTwitchPlaybackControl();
      if (control && twitchPlaybackControlAction(control) === "pause") {
        clickTwitchController(control, "sync-paused-ui", { routeKey, attempt: index + 1 });
        twitchControllerSyncRoutes.delete(video);
        return;
      }

      if (index + 1 >= delays.length) {
        twitchControllerSyncRoutes.delete(video);
        return;
      }
      setTimeout(() => attempt(index + 1), delays[index + 1] - delays[index]);
    };

    queueMicrotask(() => attempt(0));
  }

  function scheduleTwitchUserStartRetry(video, seq, gestureAt) {
    if (!isTwitchHost() || !video) return;
    const routeKey = currentRouteKey();
    const token = { routeKey, seq, gestureAt, pointerSeq: gesture.pointerSeq };
    twitchUserStartRetries.set(video, token);

    const attempt = (reason, finalAttempt) => {
      if (twitchUserStartRetries.get(video) !== token) return;
      if (
        video.isConnected === false ||
        currentRouteKey() !== routeKey ||
        gesture.routeKey !== routeKey ||
        gesture.lastAnyAt !== gestureAt ||
        gesture.pointerSeq !== token.pointerSeq ||
        !isUserAllowedVideo(video)
      ) {
        twitchUserStartRetries.delete(video);
        return;
      }
      if (!video.paused) {
        twitchUserStartRetries.delete(video);
        return;
      }
      if (video.readyState < 3) {
        if (finalAttempt) twitchUserStartRetries.delete(video);
        return;
      }

      twitchUserStartRetries.delete(video);
      flow("Twitch user start retry → native play", { seq, routeKey, reason, readyState: video.readyState });
      prepareUserPlayback(video);
      try {
        const promise = originalPlay.call(video);
        promise?.catch?.((error) => log("Twitch user start retry rejected", error?.message || error));
      } catch (error) {
        log("Twitch user start retry threw", error?.message || error);
      }
    };

    setTimeout(() => attempt("fast-ready", false), MS_TWITCH_USER_START_RETRY);
    setTimeout(() => attempt("player-became-ready", false), MS_TWITCH_USER_START_READY_RETRY);
    setTimeout(() => attempt("final-ready-check", true), MS_TWITCH_USER_START_FINAL_RETRY);
  }

  function recoverTwitchControllerPlayback(video, path, routeKey, gestureAt, playAttemptsBefore) {
    const pathTarget = path.find((node) => node?.nodeType === 1 && typeof node.click === "function");
    let recoveryAttempt = 0;

    const attempt = () => {
      if (video.isConnected === false || currentRouteKey() !== routeKey || gesture.routeKey !== routeKey) return;
      if (gesture.lastAnyAt !== gestureAt || !shouldArmForUrl() || !video.paused) return;
      if (getVideoPlayAttemptCount(video) !== playAttemptsBefore) return;

      const target = findTwitchPlaybackControl() || pathTarget;
      const action = twitchPlaybackControlAction(target);
      if (!clickTwitchController(target, "recover-user-playback", { routeKey, attempt: recoveryAttempt + 1 })) {
        flow("Twitch controller recovery unavailable", { routeKey });
        return;
      }

      recoveryAttempt += 1;
      // A Play action may call IVS asynchronously; never click it again and
      // accidentally turn the stream back off. Repeat only while the stale UI
      // still exposes Pause and therefore needs a second phase.
      if (action === "pause" && recoveryAttempt < 3) setTimeout(attempt, MS_TWITCH_CONTROLLER_RETRY);
    };

    attempt();
  }

  function scheduleControllerPlayFallback(video, e, path, gestureAt) {
    if (isYouTubeHost() || !shouldArmForUrl() || !video?.paused) return;
    if (!hasAutoplayIntervention(video)) {
      flow("controller fallback skipped", "extension did not block autoplay for this video");
      return;
    }
    if (!clickLooksLikePlaybackIntent(e, path, video)) {
      flow("controller fallback skipped", "no clear playback intent for recovery");
      return;
    }

    const routeKey = currentRouteKey();
    const playAttemptsBefore = getVideoPlayAttemptCount(video);
    const directVideoClick = path.includes(video);
    const delayMs = isOtherSite()
      ? MS_GENERIC_CONTROLLER_PLAY_FALLBACK
      : MS_CONTROLLER_PLAY_FALLBACK;
    flow(
      "controller fallback scheduled",
      `mediaId=${mediaDebugId(video)}`,
      `pointerSeq=${gesture.pointerSeq}`,
      `delayMs=${delayMs}`,
      { routeKey, directVideoClick, playAttemptsBefore }
    );

    setTimeout(() => {
      if (video.isConnected === false || currentRouteKey() !== routeKey || gesture.routeKey !== routeKey) return;
      if (gesture.lastAnyAt !== gestureAt || !shouldArmForUrl() || !video.paused) return;
      const playAttemptsAfter = getVideoPlayAttemptCount(video);
      if (playAttemptsAfter !== playAttemptsBefore) {
        flow("controller fallback skipped", "site controller attempted play", { playAttemptsBefore, playAttemptsAfter });
        return;
      }

      if (isTwitchHost()) {
        flow("controller fallback → Twitch controller recovery", { routeKey });
        recoverTwitchControllerPlayback(video, path, routeKey, gestureAt, playAttemptsBefore);
        return;
      }

      flow("controller fallback → start playback", `mediaId=${mediaDebugId(video)}`, `pointerSeq=${gesture.pointerSeq}`, { routeKey });
      markUserStarted(video, "controller-click-fallback");
      prepareUserPlayback(video);
      try {
        const promise = originalPlay.call(video);
        promise?.catch?.((error) => log("controller fallback play() rejected", error?.message || error));
      } catch (error) {
        log("controller fallback play() threw", error?.message || error);
      }
    }, delayMs);
  }

  function kickClickInPlayerArea(e, path) {
    const unrelatedControl = path.some((node) => {
      if (node?.nodeType !== 1) return false;
      const role = (node.getAttribute?.("role") || "").toLowerCase();
      return ["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(node.tagName)
        || ["button", "link", "checkbox", "switch", "slider", "menuitem", "tab"].includes(role);
    });
    if (isGenericNonPlayControlPath(path) || (unrelatedControl && !isGenericPlayControlPath(path))) return false;
    try {
      const rect = findMainVideo()?.getBoundingClientRect();
      if (!rect) return false;
      const x = e.clientX ?? -1;
      const y = e.clientY ?? -1;
      return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    } catch { return false; }
  }

  function isClickInPlayerArea(e, path, kind) {
    if (isNonPlayControlPath(path)) return false;
    if (isOnPlayer(path) || isOnPlayControl(path)) return true;
    const isPointerOrClick = kind === "pointerdown" || kind === "click";
    if (isYouTubeHost() && isVideoPage() && isPointerOrClick) {
      // YouTube's video rect may extend under the fixed masthead. Coordinates alone
      // cannot prove player intent: only a composed DOM path through the player can.
      flow("player gesture rejected", "outside YouTube player DOM", `kind=${kind}`);
      return false;
    }
    if (isKickHost() && isPointerOrClick) return kickClickInPlayerArea(e, path);
    if (isOtherSite() && isPointerOrClick) {
      return !!findInteractionVideo(e, path)
        && (isOnPlayer(path) || isOnPlayControl(path));
    }
    return false;
  }

  function observeYouTubeManualPlay(video, playPromise, reason, repeated = false) {
    if (!debug) {
      playPromise?.catch?.(() => {});
      return;
    }
    const startedAt = nowMs();
    const routeKey = currentRouteKey();
    if (repeated) {
      const window = youtubePlayDebugWindows.get(video);
      const age = window ? startedAt - window.at : Infinity;
      if (!window || window.routeKey !== routeKey || age < 0 || age > 5000 || window.remaining <= 0) return;
      window.remaining--;
    } else {
      youtubePlayDebugWindows.set(video, { routeKey, at: startedAt, remaining: 8 });
    }
    const pointerSeq = gesture.pointerSeq;
    const playSeq = state.playSeq;
    const sourceId = mediaSourceDebugSnapshot(video).sourceId;
    Promise.resolve(playPromise).then(
      () => {
        log(
          "YouTube manual play result",
          `reason=${reason}`,
          `pointerSeq=${pointerSeq}`,
          "outcome=resolved",
          `paused=${video.paused}`,
          `readyState=${video.readyState}`,
          `sameRoute=${currentRouteKey() === routeKey}`,
          `samePointer=${gesture.pointerSeq === pointerSeq}`,
          `mediaId=${mediaDebugId(video)}`,
          `sourceId=${sourceId}`,
          `elapsedMs=${Math.max(0, Math.round(nowMs() - startedAt))}`,
          `playSeq=${playSeq}`,
          ...youtubeDebugFields(video)
        );
      },
      (error) => {
        const errorName = ["AbortError", "InvalidStateError", "NotAllowedError", "NotSupportedError"]
          .includes(error?.name) ? error.name : "other";
        log(
          "YouTube manual play result",
          `reason=${reason}`,
          `pointerSeq=${pointerSeq}`,
          "outcome=rejected",
          `error=${errorName}`,
          `paused=${video.paused}`,
          `readyState=${video.readyState}`,
          `sameRoute=${currentRouteKey() === routeKey}`,
          `samePointer=${gesture.pointerSeq === pointerSeq}`,
          `mediaId=${mediaDebugId(video)}`,
          `sourceId=${sourceId}`,
          `elapsedMs=${Math.max(0, Math.round(nowMs() - startedAt))}`,
          `playSeq=${playSeq}`,
          ...youtubeDebugFields(video)
        );
      }
    );
  }

  function observeGesture(e, kind, path) {
    const trusted = e?.isTrusted === true;
    const nonPlayControl = kind === "pointerdown" && isNonPlayControlPath(path);
    const onPlayer = !nonPlayControl && isOnPlayer(path);
    const onPlayControl = !nonPlayControl && isOnPlayControl(path);
    const ae = document.activeElement;
    const genericVideoFocus = kind === "keydown" && isOtherSite() && ae instanceof HTMLVideoElement;
    const inPlayerArea = kind === "pointerdown" && isClickInPlayerArea(e, path, kind);
    const video = inPlayerArea ? findInteractionVideo(e, path) : genericVideoFocus ? ae : null;
    const focusOk = !ae || ae === document.body || ae === document.documentElement
      || !!ae.closest?.("#movie_player, .html5-video-player");
    const focusedVideoPlayer = !nonPlayControl && !onPlayer && isVideoPage()
      && !!ae?.closest?.("#movie_player, .html5-video-player, ytd-player");
    const intent = YTAPPlaybackPolicy.gestureIntent({
      trusted, onPlayer, onPlayControl, inPlayerArea, focusedVideoPlayer,
      keydown: kind === "keydown", playerFocus: focusOk,
      youtubeShortcut: isYouTubeHost() && isVideoPage() && [" ", "k"].includes((e.key || "").toLowerCase()),
      kickFocus: isKickHost() && isKickPlayerFocused(ae), genericVideoFocus,
      kickArea: isKickHost() && inPlayerArea,
      otherSite: isOtherSite(), hasVideo: !!video,
      delegated: inPlayerArea && profileForInput(path).inputMode === "delegate",
    });
    return { trusted, nonPlayControl, onPlayer, onPlayControl, inPlayerArea, video, genericVideoFocus, intent };
  }

  function traceGesture(e, kind, path, facts) {
    if (!debug) return;
    const { trusted, nonPlayControl, onPlayer, onPlayControl, inPlayerArea, video } = facts;
    const gesturePath = genericGesturePathSummary(path);
    const pointerGeometry = debugPointerGeometry(e);
    if (isOtherSite()) {
      log(
        "gesture classification",
        `kind=${kind}`,
        `trusted=${trusted}`,
        `target=${String(e.target?.tagName || "none").toLowerCase()}`,
        `path=${gesturePath.path}`,
        `interactive=${gesturePath.interactive}`,
        `attributes=${gesturePath.attributes}`,
        `playLike=${gesturePath.playLike}`,
        `nonPlayLike=${gesturePath.nonPlayLike}`
      );
    }
    log("gesture", `kind=${kind}`, `pointerSeq=${gesture.pointerSeq}`,
      `onPlayer=${onPlayer}`, `onPlayControl=${onPlayControl}`, `inPlayerArea=${inPlayerArea}`,
      `overVideoRect=${pointerGeometry.overVideoRect}`, `target=${String(e.target?.tagName || "none").toLowerCase()}`,
      `path=${gesturePath.path}`, `mediaId=${mediaDebugId(video)}`, `trusted=${trusted}`,
      `playLike=${gesturePath.playLike}`, `nonPlayLike=${gesturePath.nonPlayLike}`);
    if (trusted && isYouTubeHost() && kind === "pointerdown" && !nonPlayControl && !inPlayerArea && pointerGeometry.overVideoRect === true) {
      logYouTubeUnmatchedPointer(e, path);
    }
  }

  function recordGesture(e, kind) {
    syncDedicatedRoute(`gesture:${kind}`);
    const t = nowMs();
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    const facts = observeGesture(e, kind, path);
    const { intent, inPlayerArea, video } = facts;
    if (!intent.accepted) { traceGesture(e, kind, path, facts); return; }
    let youtubeNavigationVideoId = "";
    pendingYouTubePlay = null;
    visibilityPlayback.cancel();
    if (isTwitchKickHost() && isAudioControlPath(path)) releaseAudioRestoration(findInteractionVideo(e, path));
    if (kind === "pointerdown") {
      gesture.pointerSeq += 1;
      clearPendingVideoIntent("superseded by new pointerdown");
      pendingYouTubeNavigation = { videoId: "", at: 0 };
      if (isYouTubeHost() && isPrimaryUnmodifiedNavigationEvent(e, kind)) {
        youtubeNavigationVideoId = youtubeWatchTargetVideoId(path);
        if (youtubeNavigationVideoId) rememberYouTubeNavigationIntent(youtubeNavigationVideoId);
      }
    }
    gesture.lastAnyAt = t;
    gesture.routeKey = currentRouteKey();
    if (intent.player) gesture.lastPlayerAt = t;
    if (intent.playControl) gesture.lastPlayControlAt = t;
    if (facts.genericVideoFocus) gesture.lastVideo = video;
    if (inPlayerArea) {
      gesture.lastInPlayerAreaAt = intent.rememberArea ? t : 0;
      gesture.lastVideo = video;
      if (intent.pendingVideo) {
        rememberPendingVideoIntent("play control clicked before video existed");
      }
    }

    traceGesture(e, kind, path, facts);
    if (youtubeNavigationVideoId) dispatchGestureSignal({ youtubeNavigationVideoId });
  }

  window.addEventListener("pointerdown", (e) => recordGesture(e, "pointerdown"), true);
  // Keyboard activation of an anchor may produce a trusted click without a
  // pointerdown. Capture the same target-specific intent before YouTube's SPA
  // handler runs; ordinary clicks and modified/new-tab clicks are ignored.
  window.addEventListener("click", (e) => {
    if (!e || e.isTrusted !== true || !isPrimaryUnmodifiedNavigationEvent(e, "click")) return;
    if (typeof e.detail === "number" && e.detail !== 0) return;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    const youtubeNavigationVideoId = youtubeWatchTargetVideoId(path);
    if (!youtubeNavigationVideoId) return;
    rememberYouTubeNavigationIntent(youtubeNavigationVideoId);
    dispatchGestureSignal({
      ts: Date.now(),
      kind: "click",
      onPlayer: false,
      onPlayControl: false,
      youtubeNavigationVideoId,
    });
  }, true);

  // Playback controllers own their click and source preparation. The extension
  // records permission; only controllerless fallback profiles may start media.
  window.addEventListener("click", (e) => {
    if (!e || e.isTrusted !== true) return;
    syncDedicatedRoute("gesture:click");
    visibilityPlayback.cancel();
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    if (!isClickInPlayerArea(e, path, "click")) {
      pendingYouTubePlay = null;
      return;
    }
    const targetVideo = findInteractionVideo(e, path);
    const t = nowMs();
    gesture.lastPlayControlAt = t;
    gesture.lastPlayerAt = t;
    gesture.lastAnyAt = t;
    gesture.lastVideo = targetVideo;
    gesture.routeKey = currentRouteKey();
    const profile = profileForInput(path);
    if (profile.inputMode === "delegate") {
      gesture.lastInPlayerAreaAt = 0;
      log("YouTube controls: delegated click", `profile=${profile.id}`, `mediaId=${mediaDebugId(targetVideo)}`);
      return;
    }
    scheduleControllerPlayFallback(targetVideo, e, path, t);
  }, true);

  window.addEventListener(
    "keydown",
    (e) => {
      const target = e.composedPath?.()[0] || e.target;
      if ([target, document.activeElement].some((node) => node?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node?.tagName || ""))) return;
      const k = (e.key || "").toLowerCase();
      // Space activates a focused button or link; K remains a media shortcut.
      if (k === " " && isYouTubeHost() && isNonPlayControlPath(e.composedPath?.() || [target])) {
        if (e.isTrusted === true) pendingYouTubePlay = null;
        return;
      }
      if (e.isTrusted === true && isTwitchKickHost()
        && (k === "m" || ((k === "arrowup" || k === "arrowdown") && isOnPlayer(e.composedPath?.() || [])))) {
        releaseAudioRestoration(findMainVideo());
      }
      if (k === " " || k === "k") recordGesture(e, "keydown");
    },
    true
  );

  // ---------------------------------------------------------------------------
  // Commands from ISOLATED world
  // ---------------------------------------------------------------------------

  function settleStartupHeldVideos(keepBlocked) {
    const videos = Array.from(startupHeldVideos);
    startupHeldVideos.clear();
    const requests = startupPlayRequests.splice(0);
    if (keepBlocked) {
      const denyPlayback = blockedPlaybackMode() === "deny-youtube";
      for (const { video, resolve, reject } of requests) {
        if (denyPlayback) reject(youtubeAutoplayDeniedError(video));
        else resolve();
      }
      return;
    }

    // The site is outside the enabled scope. Forget the provisional autopause
    // so enabling protection later starts from a clean state.
    state.pausedOnce = false;
    gesture.lastAutopauseAt = 0;

    const requestedVideos = new Set(requests.map(({ video }) => video));

    const restoreAutoplay = (video) => {
      if (!startupAutoplayVideos.has(video)) return;
      video.autoplay = true;
      video.setAttribute("autoplay", "");
    };

    for (const request of requests) {
      const { video, args, resolve, reject } = request;
      clearAutoplayIntervention(video);
      if (!(video instanceof HTMLVideoElement) || !video.isConnected) {
        resolve();
        continue;
      }
      restoreAutoplay(video);
      originalPlay.apply(video, args).then(resolve, reject);
    }

    for (const video of videos) {
      clearAutoplayIntervention(video);
      if (!(video instanceof HTMLVideoElement) || !video.isConnected) continue;
      restoreAutoplay(video);
      if (requestedVideos.has(video) || !video.paused) continue;
      originalPlay.call(video).catch((e) => log("startup release play() rejected", e?.message || e));
    }
  }

  function preserveActivePlayback(wasReady, wasCovered) {
    if (!wasReady || wasCovered || !shouldArmForUrl()) return;
    for (const video of document.querySelectorAll("video")) {
      if (!video.paused && video.isConnected !== false && isMainVideo(video)) markUserStarted(video, "playing-before-activation");
    }
  }

  window.addEventListener("ytap-config", (ev) => {
    const detail = ev?.detail || {};
    const becameReady = !cfg.settingsReady && detail.settingsReady === true;
    const wasReady = cfg.settingsReady;
    const wasCovered = shouldArmForUrl();

    if (typeof detail.debug === "boolean") debug = detail.debug;
    if (!debug) youtubePlayDebugWindows = new WeakMap();
    if (detail.settingsReady === true) cfg.settingsReady = true;
    flow("ytap-config", `ownerSource=${debug ? pageContext.getRuntimeLocation().ownerSource : "not-collected"}`, {
      version: detail.extensionVersion,
      debug: detail.debug,
      enabled: detail.enabled,
      settingsReady: detail.settingsReady,
    });

    for (const key of YTAPSettings.mainKeys) {
      if (typeof detail[key] === "boolean") cfg[key] = detail[key];
    }
    if (!cfg.enabled || !cfg.pauseOnHidden || !cfg.resumeOnVisible || !shouldArmForUrl()) {
      visibilityPlayback.cancel();
    }
    if (!cfg.enabled || !shouldArmForUrl()) pendingYouTubePlay = null;

    // The URL poll normally delivers config after a Twitch/Kick SPA transition.
    // Reconcile here too, while play()/playing guards remain the synchronous
    // source of truth for transitions that race ahead of the poll.
    syncDedicatedRoute("config");

    preserveActivePlayback(wasReady, wasCovered);

    ensureTraceLoop();


    const shouldArm = shouldArmForUrl();

    if (!cfg.enabled) {
      setArmed(false, "config:disabled");
      if (becameReady) settleStartupHeldVideos(false);
      return;
    }

    if (!state.userStarted) {
      setArmed(shouldArm, "config:update");
    }
    if (becameReady) {
      // ytap-config is immediately followed by ytap-arm/ytap-disarm in the same
      // ISOLATED navigation task. Settle in a microtask so initial playlist and
      // allowlist decisions, which cannot be inferred from config alone, win.
      queueMicrotask(() => settleStartupHeldVideos(state.armed));
    }
  });

  window.addEventListener("ytap-arm", () => {
    flow("ytap-arm");
    if (!cfg.enabled) return;
    syncDedicatedRoute("arm-command");
    if (isUserAllowedVideo(findMainVideo())) return;
    if (isPlaylistWatch() && !cfg.applyToPlaylists) {
      manualYouTubePlaylistRouteKey = currentRouteKey();
    }
    setArmed(true, "ytap-arm");
  });

  window.addEventListener("ytap-disarm", () => {
    pendingYouTubePlay = null;
    flow("ytap-disarm");
    setArmed(false, "ytap-disarm");
  });

  window.addEventListener("ytap-resume", () => {
    flow("ytap-resume");
    state.userStarted = true;
    state.userStartedRouteKey = currentRouteKey();
    setArmed(false, "ytap-resume");

    const v = findMainVideo();
    if (!v) {
      info("ytap-resume: no video found");
      return;
    }

    // If we used "stop" mode (removed src), restore it before trying to play.
    try {
      restoreStoppedSource(v);
    } catch {}

    info("ytap-resume: attempting play()", { paused: v.paused });
    if (v.paused) {
      originalPlay.call(v).catch((e) => info("ytap-resume play() rejected", e?.message || e));
    }
  });

  // ---------------------------------------------------------------------------
  // YouTube SPA navigation
  // ---------------------------------------------------------------------------

  function onNavigateStart() {
    resetForNavigation("yt-navigate-start");
    if (debug) traceVideoEvents(findMainVideo());
  }

  window.addEventListener("yt-navigate-start", onNavigateStart);
  window.addEventListener("popstate", () => {
    if (isOtherSite()) resetMediaRouteScope(currentRouteKey(), "popstate");
  });
  window.addEventListener("hashchange", () => {
    if (isOtherSite()) syncMediaRouteScope("hashchange");
  });

  state.routeKey = currentRouteKey();
  flow("init", { url: location.href, routeKey: state.routeKey, willArm: shouldArmForUrl() });
  info("MAIN loaded", { url: location.href, routeKey: state.routeKey, willArm: shouldArmForUrl() });
  setArmed(shouldArmForUrl(), "initial-url");

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        // DOM readiness is not navigation. Recomputing shouldArmForUrl() here
        // can overwrite the final ISOLATED decision for initial playlist loads.
        syncDedicatedRoute("DOMContentLoaded");
        if (state.armed) queueMicrotask(() => scanVideos(document));
        if (debug) traceVideoEvents(findMainVideo());
      },
      { once: true }
    );
  }

  YTAPYouTubeChannel.install({ window, document, location, CustomEvent });
})();
