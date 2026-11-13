/**
 * Player recognition and compatibility profiles. No playback permissions,
 * timers or media actions. Host predicates include related-frame ownership.
 */
/* exported YTAPPlayerDom */
const YTAPPlayerDom = Object.freeze({
  create({ document, isTwitchHost, isKickHost, isOtherSite, currentYouTubeVideoId = () => "" }) {
    const YOUTUBE_PLAYER_SELECTORS = ["#movie_player", ".html5-video-player", "ytd-player"];
    const YOUTUBE_CUSTOM_CONTROLS = ["ytm-custom-control", "ytm-watch-player-controls"];
    const YOUTUBE_CUSTOM_CONTAINER = YOUTUBE_CUSTOM_CONTROLS.join(", ");
    const TWITCH_PLAYER_SELECTORS = [
      "[data-a-target='player-container']",
      ".video-player",
      ".video-player__container",
      ".player-overlay",
      ".player-root",
    ];
    const KICK_PLAYER_SELECTORS = [
      "#injected-embedded-channel-player-video",
      ".video-player",
      ".player-container",
      ".player-root",
      ".player",
      "[data-testid='player']",
      "[data-test='player']",
      "[data-a-target='player-container']",
    ];
    const KICK_PLAYER_CONTAINER = KICK_PLAYER_SELECTORS.join(", ");

    // Recognition, blocked-play result and input ownership describe one player
    // contract. Keep them together when introducing another controller variant.
    const profiles = Object.freeze({
      youtubeClassic: Object.freeze({
        id: "youtube-classic", blockedPlay: "deny-youtube", inputMode: "delegate",
        isOnPlayer: (path) => isInPlayer(path, YOUTUBE_PLAYER_SELECTORS),
        isOnPlayControl: isClassicYouTubePlayControl,
        isNonPlayControl: isClassicYouTubeNonPlayControl,
      }),
      youtubeCustom: Object.freeze({
        id: "youtube-custom", blockedPlay: "deny-youtube", inputMode: "delegate",
        isOnPlayer: isCustomYouTubePlayControl, isOnPlayControl: isCustomYouTubePlayControl,
        isNonPlayControl: (path) => !isCustomYouTubePlayControl(path),
      }),
      twitch: Object.freeze({
        id: "twitch", blockedPlay: "acknowledge-twitch", inputMode: "fallback",
        isOnPlayer: (path) => isInPlayer(path, TWITCH_PLAYER_SELECTORS),
        isOnPlayControl: isTwitchPlayControl,
      }),
      kick: Object.freeze({
        id: "kick", blockedPlay: "native-pause", inputMode: "fallback",
        isOnPlayer: (path) => isInPlayer(path, KICK_PLAYER_SELECTORS),
        isOnPlayControl: isKickPlayControl,
      }),
      generic: Object.freeze({
        id: "generic", blockedPlay: "native-pause", inputMode: "fallback",
        isOnPlayer: isGenericPlaybackSurface,
        isOnPlayControl: isGenericPlayControlPath,
      }),
    });

    function platformProfile() {
      if (isTwitchHost()) return profiles.twitch;
      if (isKickHost()) return profiles.kick;
      if (isOtherSite()) return profiles.generic;
      return profiles.youtubeClassic;
    }

    function profileForInput(path) {
      const profile = platformProfile();
      return profile === profiles.youtubeClassic && isYouTubeCustomControlPath(path)
        ? profiles.youtubeCustom : profile;
    }

    // Query live DOM, not a cached startup flag: controls can mount after play()
    // was held for settings. Input uses its exact path, not unrelated controls.
    function profileForPlayback() {
      const profile = platformProfile();
      return profile === profiles.youtubeClassic && document.querySelector(YOUTUBE_CUSTOM_CONTAINER)
        ? profiles.youtubeCustom : profile;
    }

    function youtubeContentState(video) {
      if (isOtherSite() || isTwitchHost() || isKickHost()) return "unknown";
      const expected = currentYouTubeVideoId();
      if (!expected) return "unknown";
      try {
        // Read only the controller owning this element. Missing metadata is not
        // evidence of stale content, and ad playback remains controller-owned.
        const player = video.closest?.("#movie_player");
        if (!player || player.classList?.contains("ad-showing")) return "unknown";
        const actual = player.getVideoData?.()?.video_id;
        if (typeof actual !== "string" || !actual) return "unknown";
        return actual === expected ? "current" : "stale";
      } catch {
        return "unknown";
      }
    }

    function youtubeDiagnosticState(video) {
      let adShowing = "unknown";
      if (isOtherSite() || isTwitchHost() || isKickHost()) return { adShowing, content: "unknown" };
      try {
        const player = video.closest?.("#movie_player");
        if (player?.classList?.contains) {
          const value = player.classList.contains("ad-showing");
          if (typeof value === "boolean") adShowing = value;
        }
      } catch {}
      return { adShowing, content: youtubeContentState(video) };
    }

    function nodeMatches(n, selectors) {
      if (!n || n.nodeType !== 1 || !n.matches) return false;
      return selectors.some((sel) => {
        try {
          return n.matches(sel);
        } catch {
          return false;
        }
      });
    }

    function isOnPlayer(path) {
      return profileForInput(path).isOnPlayer(path);
    }

    function isInPlayer(path, selectors) {
      const containerSelector = selectors.join(",");
      return path.some(
        (n) =>
          n &&
          n.nodeType === 1 &&
          (n.tagName === "VIDEO" ||
            nodeMatches(n, selectors) ||
            n.closest?.(containerSelector))
      );
    }

    function isOnPlayControl(path) {
      return profileForInput(path).isOnPlayControl(path);
    }

    function isNonPlayControlPath(path) {
      const profile = profileForInput(path);
      return profile.isNonPlayControl
        ? profile.isNonPlayControl(path)
        : isGenericNonPlayControlPath(path);
    }

    function isClassicYouTubeNonPlayControl(path) {
      if (isClassicYouTubePlayControl(path)) return false;
      const controls = [".ytp-chrome-bottom", ".ytp-chrome-top", ".ytp-popup", ".ytp-settings-menu"];
      // Standalone controls, including miniplayer actions, need not be inside
      // the chrome bars. Only explicit Play controls may take over their input.
      return path.some((node) => node?.nodeType === 1
        && (["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(node.tagName)
          || node.getAttribute?.("role") === "button"
          || (node.tagName === "A" && node.getAttribute?.("href") != null)
          || nodeMatches(node, controls) || node.closest?.(controls.join(", "))));
    }

    function isTwitchPlayControl(path) {
      return path.some((n) => {
        if (!n || n.nodeType !== 1) return false;
        const isButton =
          n.tagName === "BUTTON" ||
          n.getAttribute?.("role") === "button" ||
          n.classList?.contains("player-controls__control");
        if (!isButton) return false;

        const tgt = (n.getAttribute?.("data-a-target") || "").toLowerCase();
        const aria = (n.getAttribute?.("aria-label") || "").toLowerCase();
        const looksLikePlay =
          tgt.includes("play") ||
          tgt.includes("pause") ||
          aria.includes("play") ||
          aria.includes("pause");
        if (!looksLikePlay) return false;

        return !!n.closest?.("[data-a-target='player-container'], .video-player, .video-player__container, .player-root");
      });
    }

    function isKickPlayControl(path) {
      return path.some((n) => {
        if (!n || n.nodeType !== 1) return false;
        const isButton = n.tagName === "BUTTON" || n.getAttribute?.("role") === "button";
        if (!isButton) return false;
        const aria = (n.getAttribute?.("aria-label") || "").toLowerCase();
        const dataTest = (n.getAttribute?.("data-test") || "").toLowerCase();
        const dataTarget = (n.getAttribute?.("data-a-target") || "").toLowerCase();
        const title = (n.getAttribute?.("title") || "").toLowerCase();
        const looksLikePlay =
          aria.includes("play") ||
          aria.includes("pause") ||
          title.includes("play") ||
          title.includes("pause") ||
          dataTest.includes("play") ||
          dataTest.includes("pause") ||
          dataTarget.includes("play") ||
          dataTarget.includes("pause");
        if (!looksLikePlay) return false;
        return !!n.closest?.(KICK_PLAYER_CONTAINER);
      });
    }

    function isCustomYouTubePlayControl(path) {
      // YouTube's custom overlay is a sibling of #movie_player. Only its exact
      // playback buttons express Play intent; revealing controls or opening
      // settings must remain under the site's controller without starting media.
      return isYouTubeCustomControlPath(path) && path.some((node) => node?.nodeType === 1
        && (node.classList?.contains("player-control-play-pause-icon")
          || node.classList?.contains("ytmCuedOverlayPlayButton")));
    }

    function isClassicYouTubePlayControl(path) {
      return path.some(
        (n) =>
          n &&
          n.nodeType === 1 &&
          (n.classList?.contains("ytp-play-button") ||
            n.classList?.contains("ytp-large-play-button") ||
            n.getAttribute?.("aria-keyshortcuts") === "k")
      );
    }

    function isYouTubeCustomControlPath(path) {
      return path.some((node) => node?.nodeType === 1
        && (nodeMatches(node, YOUTUBE_CUSTOM_CONTROLS)
          || node.closest?.(YOUTUBE_CUSTOM_CONTAINER)));
    }

    function genericGesturePathSummary(path) {
      const elements = path
        .slice(0, 6)
        .filter((node) => node && node.nodeType === 1);
      const interactive = elements.find((node) => {
        const role = (node.getAttribute?.("role") || "").toLowerCase();
        return node.tagName === "BUTTON" || role === "button";
      }) || null;
      const attributes = interactive
        ? ["aria-label", "title", "data-action", "data-testid", "data-test"]
          .filter((name) => interactive.hasAttribute?.(name) || !!interactive.getAttribute?.(name))
        : [];
      const rawRole = (interactive?.getAttribute?.("role") || "").toLowerCase();
      const safeRoles = new Set(["button", "checkbox", "menuitem", "radio", "slider", "switch", "tab"]);
      const role = !rawRole ? "native" : safeRoles.has(rawRole) ? rawRole : "other";
      return {
        path: elements.map((node) => String(node.tagName || "element").toLowerCase()).join(">") || "none",
        interactive: interactive ? `${String(interactive.tagName).toLowerCase()}:${role}` : "none",
        attributes: attributes.join(",") || "none",
        playLike: isGenericPlayControlPath(path),
        nonPlayLike: isGenericNonPlayControlPath(path),
      };
    }

    function clickLooksLikePlaybackIntent(e, path, video) {
      if (!video || isGenericNonPlayControlPath(path)) return false;
      if (isKickHost() && !isOnPlayControl(path) && !isGenericPlayControlPath(path)) {
        // Kick uses icon-only buttons for both Play and other controls. Recognizing
        // their player permits site-owned Play, but does not justify our own retry.
        const unknownButton = path.some((node) => node?.nodeType === 1
          && (node.tagName === "BUTTON" || node.getAttribute?.("role") === "button"));
        if (unknownButton) return false;
      }
      if (!isOtherSite() || isGenericPlayControlPath(path)) return true;
      if (!isGenericPlaybackSurface(path)) return false;

      const x = e?.clientX;
      const y = e?.clientY;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      const rect = video.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;

      // A geometry-only click near the bottom is probably seek/volume/settings.
      // Explicitly labelled Play controls remain valid there through the branch above.
      const controlsHeight = Math.min(64, Math.max(28, rect.height * 0.16));
      return y < rect.bottom - controlsHeight;
    }

    function isGenericPlaybackSurface(path) {
      const target = path.find(node => node?.nodeType === 1);
      if (!target || target.isContentEditable) return false;
      if (target.tagName === "VIDEO") return true;
      const role = target.getAttribute?.("role") || "";
      if (target.tagName !== "DIV" || (role && role !== "presentation" && role !== "none")
        || target.textContent?.trim()) return false;
      // An empty controller surface can toggle playback; arbitrary text and
      // controls overlapping the video do not acquire that action by geometry.
      return typeof target.className === "string" && target.className.split(/\s+/).includes("player-overlay");
    }

    function genericControlText(node) {
      if (!node || node.nodeType !== 1) return "";
      const values = [
        node.getAttribute?.("aria-label"),
        node.getAttribute?.("title"),
        node.getAttribute?.("data-action"),
        node.getAttribute?.("data-testid"),
        node.getAttribute?.("data-test"),
        node.id,
        typeof node.className === "string" ? node.className : "",
      ];
      return values.filter(Boolean).join(" ").toLowerCase();
    }

    function isAudioControlPath(path) {
      return path.slice(0, 6).some((node) => /mute|volume/i.test(genericControlText(node)));
    }

    function isGenericPlayControlPath(path) {
      for (let index = 0; index < path.length && index < 6; index += 1) {
        const node = path[index];
        if (node?.tagName === "BODY" || node?.tagName === "HTML") break;
        const text = genericControlText(node);
        if (!text) continue;
        const role = (node.getAttribute?.("role") || "").toLowerCase();
        const closeToTargetOrInteractive = index <= 2 || node.tagName === "BUTTON" || role === "button";
        if (!closeToTargetOrInteractive) continue;
        if (/(^|[\s_-])(badge|store|download)([\s_-]|$)/i.test(text)) continue;
        const looksLikePlay = /(^|[\s_-])(playpause|playpausetoggle|toggleplay|togglepause|play|pause|resume|replay)([\s_-]|$)/i.test(text)
          || /(^|[\s_-])(?:start|watch)[\s_-]+(?:video|movie|stream|playback)([\s_-]|$)/i.test(text)
          || text.includes("воспроиз")
          || text.includes("смотреть")
          || text.includes("пауза");
        if (looksLikePlay) return true;
      }
      return false;
    }

    function isGenericNonPlayControlPath(path) {
      for (let index = 0; index < path.length && index < 6; index += 1) {
        const node = path[index];
        if (!node || node.nodeType !== 1) continue;
        if (node.tagName === "BODY" || node.tagName === "HTML") break;
        if (["INPUT", "SELECT", "TEXTAREA"].includes(node.tagName)) return true;
        if (node.tagName === "A") {
          const href = (node.getAttribute?.("href") || "").trim();
          if (href && !href.startsWith("#") && !/^javascript:/i.test(href)) return true;
        }
        const role = (node.getAttribute?.("role") || "").toLowerCase();
        if (["slider", "menuitem", "checkbox", "switch", "link"].includes(role)) return true;
        const text = genericControlText(node);
        const closeToTargetOrInteractive = index <= 2 || node.tagName === "BUTTON" || !!role;
        if (!closeToTargetOrInteractive) continue;
        const looksLikeNonPlay = /(^|[\s_-])(volume|mute|unmute|settings|gear|quality|subtitle|caption|fullscreen|pip|seek|progress|timeline|scrub|speed|rate)([\s_-]|$)/i.test(text)
          || ["громк", "настрой", "качеств", "субтитр", "полный экран"].some((label) => text.includes(label));
        if (looksLikeNonPlay) return true;
      }
      return false;
    }

    return Object.freeze({
      isOnPlayer, isOnPlayControl, isNonPlayControlPath, isAudioControlPath, profileForInput, profileForPlayback, youtubeContentState, youtubeDiagnosticState, genericGesturePathSummary, clickLooksLikePlaybackIntent,
      isGenericPlayControlPath, isGenericNonPlayControlPath,
      isKickPlayerFocused: (node) => !!node?.closest?.(KICK_PLAYER_CONTAINER),
    });
  },
});
