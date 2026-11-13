/* global YTAPSettings */
/* exported YTAPChannelInput */
const YTAPChannelInput = (() => {
  function fromHtml(html) {
    // Read data as text; do not create a document that could load subresources.
    for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
      const match = script[1].match(/^(?:var\s+)?ytInitialData\s*=\s*(\{[\s\S]*\});?\s*$/);
      if (!match) continue;
      try {
        const data = JSON.parse(match[1]);
        const vanity = YTAPSettings.normalizeChannel(data.metadata?.channelMetadataRenderer?.vanityChannelUrl);
        if (vanity.startsWith("/@")) return vanity;
      } catch { /* A canonical link remains sufficient for a channel ID. */ }
    }
    for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
      if (!/\brel\s*=\s*(["'])canonical\1/i.test(tag[0])) continue;
      const href = tag[0].match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
      const key = YTAPSettings.normalizeChannel(href);
      if (/^\/(?:@|channel\/)/.test(key)) return key;
    }
    return "";
  }

  async function resolve(value) {
    const key = YTAPSettings.normalizeChannel(value);
    if (!/^\/(?:c|user)\//.test(key)) return key;
    // Resolve only an explicitly submitted channel URL, without browser cookies.
    const response = await fetch(`https://www.youtube.com${key}`, {
      credentials: "omit", referrerPolicy: "no-referrer", redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok || !YTAPSettings.normalizeChannel(response.url)) throw new Error("channel-unavailable");
    const html = await response.text();
    if (html.length > 5_000_000) throw new Error("channel-response-too-large");
    const result = fromHtml(html);
    if (!result) throw new Error("channel-unavailable");
    return result;
  }
  return Object.freeze({ resolve, fromHtml });
})();
