/* global YTAPSettings */
/* exported YTAPYouTubeChannel */
const YTAPYouTubeChannel = (() => {
  function desktopOwner(document, videoId) {
    const watch = document.querySelector("ytd-watch-flexy");
    if (watch?.getAttribute("video-id") !== videoId) return null;
    if (!watch.data) return { canonicalBaseUrl: watch.querySelector("ytd-video-owner-renderer a[href]")?.href };
    if (watch.data.currentVideoEndpoint?.watchEndpoint?.videoId !== videoId) return null;
    const items = watch.data.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
    return items.find((item) => item.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer
      ?.navigationEndpoint?.browseEndpoint;
  }

  function mobileOwner(document, videoId) {
    for (const node of document.querySelectorAll("ytm-slim-video-metadata-section-renderer")) {
      if (node.data?.videoId !== videoId) continue;
      return node.data.contents?.find((item) => item.slimOwnerRenderer)?.slimOwnerRenderer
        ?.navigationEndpoint?.browseEndpoint;
    }
    return null;
  }

  function shortsOwner(document, videoId) {
    for (const node of document.querySelectorAll("ytd-reel-video-renderer,ytm-reel-item-renderer")) {
      if (node.data?.command?.reelWatchEndpoint?.videoId !== videoId) continue;
      return { canonicalBaseUrl: node.querySelector("yt-reel-channel-bar-view-model a[href],ytm-reel-player-header-renderer a[href]")?.href };
    }
    return null;
  }
  function read(document, location) {
    const host = location.hostname;
    if (!/(^|\.)youtube(?:-nocookie)?\.com$/.test(host)) return null;
    const path = location.pathname;
    const videoId = path === "/watch" ? new URLSearchParams(location.search).get("v")
      : /^\/(?:shorts|embed)\/([^/]+)/.exec(path)?.[1];
    if (!videoId) return null;
    let owner;
    if (path === "/watch") owner = host.startsWith("m.") ? mobileOwner(document, videoId) : desktopOwner(document, videoId);
    else if (path.startsWith("/shorts/")) owner = shortsOwner(document, videoId);
    else owner = { canonicalBaseUrl: document.querySelector("embedded-player-video-details a.ytmVideoInfoChannelTitle[href],.ytp-title-channel a[href]")?.href };
    const channel = YTAPSettings.normalizeChannel(owner?.canonicalBaseUrl);
    const channelId = owner?.browseId ? YTAPSettings.normalizeChannel(`/channel/${owner.browseId}`) : "";
    if (!channel && !channelId) return null;
    return { videoId, channel: channel || channelId, ...(channelId ? { aliases: [channelId] } : {}) };
  }

  function install({ window, document, location, CustomEvent }) {
    window.addEventListener("ytap-channel-request", () => {
      let detail = null;
      try { detail = read(document, location); } catch {}
      window.dispatchEvent(new CustomEvent("ytap-channel-response", { detail }));
    });
  }
  return Object.freeze({ read, install });
})();
