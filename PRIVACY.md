# Privacy Policy (Disable video autoplay)

Last updated: 2026-11-13

## Summary

Disable video autoplay processes limited page and playback information to apply autoplay rules and recognize manual playback. This processing occurs in the browser. The extension has no developer-operated backend, analytics, advertising, or sale of user data.

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

`siteLibrary` contains only website hostnames that the user explicitly adds for selective autoplay blocking.

`siteExclusions` contains hostnames where autoplay blocking is disabled, including under global coverage. Channel entries use `allowlist`. These preferences are not sent to the developer or visited websites; Chrome may synchronize them as described above.

## Information processed in the browser

The extension uses the current page URL, video and playlist identity, player and channel metadata, playback state, and relevant pointer or keyboard actions to decide whether to block autoplay or allow a manual playback request. It also observes tab visibility when the related setting is enabled. This information is used for playback controls, not for building browsing-history records or activity profiles.

When the popup is open, the extension reads the active tab URL to identify the current website or YouTube channel. It does not save visited URLs as a history. A hostname is saved only when the user adds a website rule.

The extension does not read browser cookies or use the browser history API. Page URLs, page content, playback information, and interaction events are not sent to the developer, advertisers, or analytics services.

## Network requests

When the user submits a legacy YouTube channel URL (`/c/` or `/user/`), the popup requests that public channel page from YouTube to resolve its current handle or channel ID. This request omits cookies and the referrer. It happens only for that explicit action, not while browsing. Modern handles and channel IDs do not require a network request.

The `https://www.youtube.com/*` host permission allows this cross-origin request. The response is read as text and is not inserted into the interface or executed.

YouTube receives the requested channel address and standard network information, such as the IP address associated with the request. This lookup and Chrome's optional settings synchronization are distinct from data transmission to the developer. Playback requests made by websites remain under those websites' own privacy policies.

## Diagnostics and retention

Debug logs are optional and stay in the local browser console. Before writing diagnostic values, the extension redacts page URLs, page-provided media and playlist identifiers, channel entries, and saved website rules. The user can enable or disable these logs in the popup or options page.

Playback state is held temporarily for the current page and media lifecycle, not saved as browsing history. Preferences remain in Chrome storage until changed or removed. Website and channel rules can be deleted in the extension settings. Chrome controls the retention and deletion of synchronized settings; browser controls also determine how long console logs remain available.

Turn off Enabled in the popup to stop autoplay blocking. To stop extension page processing, disable or uninstall the extension in Chrome and reload pages where it was already active. Diagnostics are not uploaded automatically. If a user chooses to share logs or a support report, that is a separate action initiated by that user.

## Page integration

The page-event bridge between execution worlds exposes playback flags to page scripts. The extension version is included only while debug logging is enabled. Page scripts can also send bridge commands; this bridge is a compatibility mechanism, not a security boundary. Stored channel exceptions and website rules are not sent to the MAIN world.

## Limited use

The extension uses information only to provide its stated autoplay and playback-control features. Its use of information received from Google APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.
