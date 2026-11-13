# Privacy Policy (Disable video autoplay)

Last updated: 2026-11-13

## Summary

Disable video autoplay does not collect or sell personal data. It has no analytics or browsing-history collection. The only extension-initiated network request resolves a legacy channel URL explicitly submitted by the user, as described below.

The extension requests access to HTTP(S) pages so it can intercept video playback before site scripts start it. This processing stays inside the page and browser.

## Data the extension stores

The extension stores only user settings using Chrome's built-in storage:

- `enabled`
- `applyToYouTube`
- `applyToEmbedded`
- `applyToMobile`
- `applyToShorts`
- `applyToChannelPlayer`
- `applyToTwitch`
- `applyToKick`
- `applyToOtherSites`
- `siteLibrary`
- `siteExclusions`
- `applyToPlaylists`
- `stopInsteadOfPause`
- `ignoreMiniplayer`
- `pauseOnHidden`
- `resumeOnVisible`
- `allowlist`
- `debug`
- `uiLanguage`

If Chrome Sync is enabled in your browser, these settings may be synced by Chrome across your devices via `chrome.storage.sync`.

`siteLibrary` contains only the website hostnames that the user explicitly adds for selective autoplay blocking. The extension does not send this list anywhere.

`siteExclusions` contains hostnames where autoplay blocking is disabled, including under global coverage. Channel entries use `allowlist`; existing legacy entries are read compatibly and migrated when edited. These lists are not sent to websites or external services.

## Data the extension does not collect

The extension does not:

- collect browsing history
- collect cookies
- collect page content
- send browsing data to external servers
- use analytics or tracking

When the popup is open, the extension reads the active tab URL only to identify the current website or YouTube channel requested by the user. It does not persist or transmit that URL.

When the user submits a legacy YouTube channel URL (`/c/` or `/user/`), the popup requests that public channel page from YouTube to resolve its current handle or channel ID. This request omits cookies and the referrer. It happens only for that explicit action, not while browsing. Modern handles and channel IDs do not require a network request.

The `https://www.youtube.com/*` host permission allows this cross-origin request. The response is read as text and is not inserted into the interface or executed.

Debug logs are optional and stay in the local browser console. Before writing diagnostic values, the extension redacts page URLs, page-provided media and playlist identifiers, channel entries, and saved website rules. The user can enable or disable these logs in the popup or options page.

The page-event bridge between execution worlds exposes playback flags to page scripts. The extension version is included only while debug logging is enabled. Page scripts can also send bridge commands; this bridge is a compatibility mechanism, not a security boundary. Stored channel exceptions and website rules are not sent to the MAIN world.
