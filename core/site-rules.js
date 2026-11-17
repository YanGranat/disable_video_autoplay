/* global YTAPSiteContext, YTAPDomainParser */
/* exported YTAPSiteRules */
const YTAPSiteRules = (() => {
  "use strict";

  function normalizeSite(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw || raw.length > 2048 || /[\s\\]/u.test(raw)) return "";

    try {
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\*\./, "")}`;
      const url = new URL(withScheme);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";

      let host = (url.hostname || "").toLowerCase().replace(/\.$/, "");
      if (!validHostname(host)) return "";
      if (host.startsWith("www.") && validHostname(host.slice(4))) host = host.slice(4);
      return host;
    } catch {
      return "";
    }
  }

  function validHostname(host) {
    if (host === "localhost") return true;
    const parsed = YTAPDomainParser.parse(host, { allowPrivateDomains: true, extractHostname: false, validateHostname: true });
    if (parsed.isIp) return true;
    return host.length <= 253 && !!parsed.domain
      && host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  }

  function normalizeSiteLibrary(items) {
    const unique = new Set((Array.isArray(items) ? items : []).map(normalizeSite).filter(Boolean));
    return [...unique].filter((site) => {
      for (let dot = site.indexOf('.'); dot !== -1; dot = site.indexOf('.', dot + 1)) {
        if (unique.has(site.slice(dot + 1))) return false;
      }
      return true;
    }).sort();
  }

  function siteMatchesHostname(hostname, site) {
    const host = normalizeSite(hostname);
    const rule = normalizeSite(site);
    return !!host && !!rule && YTAPSiteContext.matchesHostname(host, rule);
  }

  function isDedicatedSite(hostname) {
    const host = normalizeSite(hostname);
    return YTAPSiteContext.platform(host) !== "other";
  }

  function otherSiteRule(settings, hostname) {
    const host = normalizeSite(hostname);
    if (!host || YTAPSiteContext.platform(host) !== "other") return { blocked: false, source: "unsupported", rule: "" };
    const exclusion = normalizeSiteLibrary(settings.siteExclusions).find((rule) => YTAPSiteContext.matchesHostname(host, rule));
    if (exclusion) return { blocked: false, source: "exclusion", rule: exclusion };
    const selected = normalizeSiteLibrary(settings.siteLibrary).find((rule) => YTAPSiteContext.matchesHostname(host, rule));
    if (selected) return { blocked: true, source: "library", rule: selected };
    return { blocked: settings.applyToOtherSites !== false, source: "global", rule: "" };
  }

  // A domain rule covers its subdomains. Removing an inherited exclusion must
  // explicitly identify that parent rule in the UI.
  function setSiteBlocking(settings, hostname, blocked) {
    const host = normalizeSite(hostname);
    if (!host || YTAPSiteContext.platform(host) !== "other") return null;
    const siteLibrary = normalizeSiteLibrary(settings.siteLibrary);
    const siteExclusions = normalizeSiteLibrary(settings.siteExclusions);
    if (!blocked) return {
      siteLibrary: siteLibrary.filter((rule) => rule !== host),
      siteExclusions: normalizeSiteLibrary([...siteExclusions, host]),
    };
    return {
      siteLibrary: settings.applyToOtherSites !== false ? siteLibrary : normalizeSiteLibrary([...siteLibrary, host]),
      siteExclusions: siteExclusions.filter((rule) => !YTAPSiteContext.matchesHostname(host, rule)),
    };
  }

  return Object.freeze({ normalizeSite, normalizeSiteLibrary, siteMatchesHostname, isDedicatedSite, otherSiteRule, setSiteBlocking });
})();
