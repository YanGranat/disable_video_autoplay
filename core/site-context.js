/* exported YTAPSiteContext */
const YTAPSiteContext = (() => {
  function matchesHostname(host, domain) {
    return host === domain || host.endsWith(`.${domain}`);
  }
  function platform(host) {
    if (matchesHostname(host, "youtube.com") || matchesHostname(host, "youtube-nocookie.com")) return "youtube";
    if (matchesHostname(host, "twitch.tv")) return "twitch";
    if (matchesHostname(host, "kick.com")) return "kick";
    return "other";
  }
  function watchIdentity(pathname, search) {
    try {
      const params = new URLSearchParams(search || "");
      return `${pathname}?v=${params.get("v") || ""}&list=${params.get("list") || ""}`;
    } catch {
      return pathname + search;
    }
  }
  return Object.freeze({ matchesHostname, platform, watchIdentity });
})();
