/* global YTAPSiteContext */
/* exported YTAPPageContext */
const YTAPPageContext = Object.freeze({
  create({ location, document, window }) {
    function locationFacts(value) {
      const hostname = (value.hostname || "").toLowerCase();
      return hostname ? {
        hostname, pathname: value.pathname || "/", search: value.search || "", hash: value.hash || "",
      } : null;
    }

    function liveOwnerLocation() {
      const visited = new Set([window]);
      let owner = window;
      try {
        while (owner.parent && !visited.has(owner.parent)) {
          owner = owner.parent;
          visited.add(owner);
          try {
            const facts = locationFacts(owner.location);
            if (facts) return facts;
          } catch {}
        }
      } catch {}
      return null;
    }

    function getRuntimeLocation() {
      const ownHostname = (location.hostname || "").toLowerCase();
      const own = {
        hostname: ownHostname, pathname: location.pathname || "/",
        search: location.search || "", hash: location.hash || "",
        ownerSource: ownHostname ? "document" : "unresolved",
      };
      if (ownHostname) return own;

      // A retained related frame keeps its initial referrer across parent SPA
      // navigation. Read an accessible owner on demand; opaque frames can only
      // fall back to their creation-time referrer or inherited origin.
      const liveOwner = liveOwnerLocation();
      if (liveOwner) return { ...liveOwner, ownerSource: "ancestor" };
      try {
        const referrer = new URL(document.referrer || "");
        if (referrer.hostname) return {
          hostname: referrer.hostname.toLowerCase(), pathname: referrer.pathname || "/",
          search: referrer.search || "", hash: referrer.hash || "",
          ownerSource: "referrer",
        };
      } catch {}
      try {
        const origins = location.ancestorOrigins;
        if (origins && origins.length > 0) {
          const parent = new URL(origins[0]);
          if (parent.hostname) return { hostname: parent.hostname.toLowerCase(), pathname: "/", search: "", hash: "", ownerSource: "origin" };
        }
      } catch {}
      return own;
    }

    const getRuntimeHostname = () => getRuntimeLocation().hostname;
    const platform = () => YTAPSiteContext.platform(getRuntimeHostname());
    const isYouTubeHost = () => platform() === "youtube";
    const isTwitchHost = () => platform() === "twitch";
    const isKickHost = () => platform() === "kick";
    const isTwitchKickHost = () => isTwitchHost() || isKickHost();
    const isOtherSite = () => platform() === "other";
    const isDedicatedSpaHost = () => platform() !== "other";
    const isMobileHost = () => getRuntimeHostname() === "m.youtube.com";
    const isWatchPage = () => location.pathname === "/watch";
    const isShortsPage = () => location.pathname.startsWith("/shorts/");
    const isEmbedPage = () => (location.pathname || "").startsWith("/embed/") || (location.pathname || "").startsWith("/v/");
    const isVideoPage = () => isWatchPage() || isShortsPage();
    const isChannelPage = () => ["/@", "/channel/", "/c/", "/user/"].some((prefix) => (location.pathname || "").startsWith(prefix));

    function isPlaylistWatch() {
      if (!isWatchPage()) return false;
      try { return new URLSearchParams(location.search || "").has("list"); }
      catch { return (location.search || "").includes("list="); }
    }

    function isEmbeddedContext() {
      let embedded;
      try { embedded = window.top !== window; }
      catch { embedded = true; }
      return embedded || isEmbedPage() || getRuntimeHostname() === "www.youtube-nocookie.com";
    }

    function getSiteScopeHostname() {
      try {
        const origins = location.ancestorOrigins;
        if (origins && origins.length > 0) {
          const topHostname = new URL(origins[origins.length - 1]).hostname;
          if (topHostname) return topHostname;
        }
      } catch {}
      return location.hostname;
    }

    function currentRouteKey() {
      const owner = getRuntimeLocation();
      const ownerPlatform = YTAPSiteContext.platform(owner.hostname);
      const base = owner.hostname + owner.pathname;
      if (ownerPlatform === "youtube" && owner.pathname === "/watch") return owner.hostname + YTAPSiteContext.watchIdentity(owner.pathname, owner.search);
      if (ownerPlatform !== "other") return base;
      return base + owner.search + owner.hash;
    }

    function currentNavKey() {
      // Dedupe document navigation separately from inherited media ownership.
      if (isYouTubeHost() && isWatchPage()) return YTAPSiteContext.watchIdentity(location.pathname, location.search);
      return location.pathname + location.search;
    }

    function currentYouTubeVideoId() {
      if (!isYouTubeHost() || !isWatchPage()) return "";
      try { return new URLSearchParams(getRuntimeLocation().search).get("v") || ""; }
      catch { return ""; }
    }

    function currentDocumentVideoId() {
      if (!isYouTubeHost() || !isWatchPage()) return "";
      try { return new URLSearchParams(location.search || "").get("v") || ""; }
      catch { return ""; }
    }

    function coverageFacts(manualPlaylist) {
      return {
        platform: platform(), mobile: isMobileHost(), embedded: isEmbeddedContext(),
        playlist: isPlaylistWatch(), manualPlaylist, videoPage: isVideoPage(),
        channelPage: isChannelPage(), shorts: isShortsPage(),
      };
    }

    return Object.freeze({
      getRuntimeLocation, getRuntimeHostname, getSiteScopeHostname,
      isYouTubeHost, isTwitchHost, isKickHost, isTwitchKickHost, isOtherSite, isDedicatedSpaHost,
      isMobileHost, isWatchPage, isShortsPage, isEmbedPage, isVideoPage, isChannelPage,
      isPlaylistWatch, isEmbeddedContext, currentRouteKey, currentNavKey, currentYouTubeVideoId, currentDocumentVideoId,
      coverageFacts,
    });
  },
});
