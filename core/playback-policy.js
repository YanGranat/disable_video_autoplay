/**
 * Playback decisions from plain facts. No DOM, media API, clock or side effects.
 * Callers own observation, state transitions, diagnostics and player actions.
 */
/* exported YTAPPlaybackPolicy */
const YTAPPlaybackPolicy = (() => {
  "use strict";

  // config contains normalized boolean flags from the settings model.
  // page describes the current route, including proven manual playlist intent.
  function coverage(config, page) {
    if (!config.enabled) return { armed: false, reason: "disabled" };
    if (!config.settingsReady) return { armed: true, reason: "startup" };
    if (page.platform === "other") return {
      armed: !!config.applyToOtherSites, reason: "other-site",
    };
    if (page.platform === "twitch") return {
      armed: !!config.applyToTwitch, reason: "twitch",
    };
    if (page.platform === "kick") return {
      armed: !!config.applyToKick, reason: "kick",
    };
    if (!config.applyToYouTube) return { armed: false, reason: "youtube-disabled" };
    if (page.mobile && !config.applyToMobile) return { armed: false, reason: "mobile-disabled" };
    if (page.embedded && !config.applyToEmbedded) return { armed: false, reason: "embedded-disabled" };
    if (page.playlist && !config.applyToPlaylists && !page.manualPlaylist) {
      return { armed: false, reason: "playlist-auto-next" };
    }
    const inScope = page.videoPage
      || (config.applyToChannelPlayer && page.channelPage)
      || (config.applyToEmbedded && page.embedded);
    if (!inScope) return { armed: false, reason: "outside-scope" };
    if (page.shorts && !config.applyToShorts) return { armed: false, reason: "shorts-disabled" };
    return { armed: true, reason: "youtube" };
  }

  function gestureTiming(gesture, now, recentMs) {
    const recentPlay = gesture.lastPlayControlAt > 0 && now - gesture.lastPlayControlAt < recentMs;
    const recentPlayer = gesture.lastPlayerAt > 0 && now - gesture.lastPlayerAt < recentMs;
    const playerIntentAt = Math.max(gesture.lastPlayControlAt, gesture.lastPlayerAt);
    const afterAutopause = gesture.lastAutopauseAt > 0 && playerIntentAt > gesture.lastAutopauseAt;
    return { recentPlay, recentPlayer, afterAutopause };
  }

  function gestureAfterAutopause(timing) {
    return timing.afterAutopause && (timing.recentPlay || timing.recentPlayer);
  }

  function userPlay({ sameMedia, sameRoute, pausedOnce }, timing) {
    if (!sameMedia) return { allowed: false, reason: "different-media" };
    if (!sameRoute) return { allowed: false, reason: "different-route" };
    if (pausedOnce && gestureAfterAutopause(timing)) {
      return { allowed: true, reason: "gesture-after-autopause" };
    }
    if (!pausedOnce && timing.recentPlay) {
      return { allowed: true, reason: "play-control" };
    }
    return { allowed: false, reason: "no-play-intent" };
  }

  function playRequest(facts) {
    if (facts.contentState === "stale") return "deny-stale";
    if (facts.pendingSelection) return "selected-controller";
    if (facts.carryover && facts.carryoverAllowed) return "carryover-gesture";
    if ((!facts.armed && !facts.carryover) || facts.userAllowed) return "authorized";
    if (facts.recentAreaClick) return "recent-area-click";
    if (facts.userIntent) return "user-gesture";
    return facts.carryover ? "deny-carryover" : "block";
  }

  function gestureIntent(facts) {
    if (!facts.trusted) return { accepted: false };
    const keyPlayback = facts.keydown && (facts.playerFocus || facts.youtubeShortcut || facts.kickFocus || facts.genericVideoFocus);
    return {
      accepted: true,
      player: !!(facts.onPlayer || facts.focusedVideoPlayer || facts.genericVideoFocus || facts.kickArea),
      playControl: !!(facts.onPlayControl || keyPlayback),
      rememberArea: !!(facts.inPlayerArea && !facts.delegated),
      pendingVideo: !!(facts.otherSite && facts.inPlayerArea && facts.onPlayControl && !facts.hasVideo),
    };
  }

  return Object.freeze({ coverage, gestureTiming, gestureAfterAutopause, userPlay, playRequest, gestureIntent });
})();
