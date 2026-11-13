# Testing

## Automated checks

Use Node.js 24 or newer. From the project root:

```powershell
npm ci --ignore-scripts
npm run build
npm run check
```

The suite covers passive behavior on naturally paused sites, audio-only media boundaries, controller-first recovery after a real autoplay block, startup and overlapping SPA route races, target-matched playlist navigation, related frames, visibility-option scope, settings defaults across both content worlds, isolated UI setting writes and rapid toggles, UI bindings, translations, privacy settings, locales, and version consistency.

Core tests run without a browser or DOM. They cover scope decisions, exact gesture-time boundaries, immutable defaults, config projection and redaction. Media-evidence tests use an injected clock to verify route generations, one-time replacement claims and expiry. Player-profile tests cover control recognition, input ownership and blocked-playback results, including controls mounting or disappearing during startup. Media-policy tests distinguish confirmed audio from provisional replacements, check exact expiry boundaries and verify which evidence must be retained or cleared. Page-context tests keep the document referrer fixed while changing accessible parent locations, including nested related frames and inaccessible-owner fallback. Playback suites separate startup, YouTube, platform controls, media lifecycle and generic playback, with independent media prototypes for each harness. Integration tests load the actual generated content scripts named by the manifest and the scripts listed in popup/options HTML. Consistency checks fail if a bundle is stale or browser/storage dependencies leak into the core. In a real browser, verify both MAIN and ISOLATED startup; a patched `play()` alone does not prove that settings and navigation commands are reaching it.

## Before manual testing

1. Open `chrome://extensions`.
2. Reload the unpacked extension.
3. Reload every website tab used for testing. An already open tab otherwise keeps the previous content scripts.
4. Enable **Debug logs** for the test run.
5. In debug output, confirm that the plain-text version after `[YT-AP ISOLATED]` matches the extension card.

## YouTube

1. Open a watch page: the video must stay paused without a native `play`/`playing` event before user input.
2. Press Play: playback must start with one click.

   - Before Play, use settings, volume, seek and fullscreen controls. Their actions must reach YouTube without starting video or authorizing a later autoplay attempt.
   - With one channel exception, navigate from its video to a different channel's video, then Back. Each decision must use the current video's owner. Repeat current-channel detection on the mobile site, Shorts and an embedded player.
3. On a freshly opened video, press Play immediately while the player is still loading: it must not start and then bounce back to Pause; the next separate click must still pause normally.

   - Keep the pointer pressed while the player updates its overlay, then release it. The extension must not start media on pointerdown or consume the site's click; the next independent click and non-play controls must retain their normal actions.
   - Select another video and press Play before navigation completes. The previous controller content must not briefly play. Once the selected content is prepared, it must start once; repeat with slower preparation and cancel the pending Play with another action, navigation or the master switch.
4. Click another video or the YouTube logo: the paused video must not play briefly during navigation.
5. With **Pause playlist auto-next** off, manually open a playlist item and verify that it stays paused even if YouTube changes only its playlist position or tracking parameters.
6. With the same setting, verify that a real auto-next to another video plays even if you used player controls shortly before the transition.
7. Select another playlist item with the mouse and keyboard. Each manually selected video must open paused.
8. While that manually opened item is still paused, click the YouTube logo. If YouTube reuses that exact media element after navigation, it must remain paused even if the element resets; one trusted click in its player must be its first native Play and start it.

   - Close the paused miniplayer with the mouse, Enter and Space. Each action must close it without starting playback. Other non-play controls must retain their native actions without authorizing playback; Play and the video surface must still start it.
9. If YouTube instead activates a separate pre-existing miniplayer element, **Ignore miniplayer / PiP** must leave that element site-controlled without releasing the pause on the manually opened video.
10. Start another video manually, then leave its watch page. The already-playing video must continue normally in the miniplayer.
11. Enable Shorts, mobile, embedded-player, and channel-player coverage separately and verify each scope.
12. Add the current channel to the allowlist and verify that its videos are allowed.
13. Repeat from a channel's `/videos` or `/streams` tab: save the channel path without that suffix. On an unrelated website, the current-channel button must not add an exception.
14. Type Space or K into search, a comment field, and an editable text area: this must not release autoplay protection. The normal K shortcut outside text fields must still work.
15. In an embedded YouTube player with custom overlay controls, a fresh load must show an accessible Play button instead of a loading overlay, with no native `play`/`playing` before input. Press Play once, then Pause: both must reach the site's controller. Repeat on a naturally paused player and after enabling protection on an already loaded page. Revealing controls, settings, volume, captions and seeking must not start paused media.

## Twitch and Kick

1. Enable the platform's dedicated switch.
2. Open a channel: autoplay must be blocked and the stopped Twitch player must show Play, not Pause.
3. Press the video or Play control once while the stream is still becoming ready: playback must start promptly without repeated visible Play/Pause toggles.
4. Repeat with an already ready stream: the site's successful first start must not receive a duplicate retry.
5. Navigate to another channel without reloading: autoplay must be blocked again.
6. Disable the dedicated switch and verify that the generic all-sites mode does not override it.
7. On Kick, close an unrelated dialog whose button covers the video. The video must remain paused, with no recovery Play. A site playback attempt during or after that click must also remain blocked; the next real video click must start normally. Repeat with a player surface and a labelled Play overlay to verify that recovery still works there.
8. In Kick's current player, press the icon-only Play button once after autoplay is blocked, then press Pause: both actions must work without an extra click or delayed restart. Test Space with the button focused. Settings and volume, including buttons without labels, must not trigger recovery playback. After navigating to another channel, autoplay must be blocked again.

## Other websites and library

1. With the all-sites mode enabled, test native `autoplay`, scripted `video.play()`, and a dynamically inserted video.
2. Verify that ordinary `<audio>` and a `<video>` with loaded audio-only metadata can play without interception.
3. Reset that audio transport through `emptied`, then let the same element expose non-zero video dimensions: playback must continue during the same route generation. A distinct visual replacement with the same intrinsic size must still be paused, and only one metadata-unknown replacement may inherit provisional evidence.
4. After a real block, press an external Play/Pause button whose compact control identifier contains `playpause`: the site-owned `play()` must succeed on the first click.
5. On a multi-video page, start one video and verify that the others remain protected.
6. On a custom player, verify that Play, Pause, settings, volume, seek, and fullscreen controls remain in sync.
7. On a site whose video is already paused without any blocked autoplay attempt, press Play and Pause several times. The site must remain the only playback owner; the extension must not log `controller fallback → start playback`.
8. On a player that has a Play button before it creates `<video>`, press Play once. The late video must start even though its declarative `autoplay` is removed.
9. On a delayed custom controller, press the center overlay: playback must start once and must not immediately return to Pause.
10. After the extension has actually blocked autoplay on a simple controllerless player, one trusted playback click must still start it through the bounded fallback.
11. Change an SPA route that reuses the same `<video>`, then return to the old route and verify that the former audio or playback role does not revive.
12. Disable the all-sites mode, add the current website to the library, then remove it again. The change must apply without reloading.
13. Verify an accessible iframe on a selected top-level site.
14. Keep an `about:blank` iframe and its video element alive during a parent SPA transition. Start the video manually, pause it, change the parent's route, then request playback without another gesture: the old permission must not carry over. Repeat after returning to the original route, and verify that a new trusted Play still works. Keep `document.referrer` unchanged; inaccessible owners use origin/referrer fallback rather than live parent route detection.
15. After blocking a video, click an ordinary link outside its player and trigger another autoplay attempt: the video must stay paused, even if it is the only video on the page.
16. After a late-created video consumes Play intent, click elsewhere or disable the extension before its recovery runs: the scheduled recovery must not start it.
17. With global coverage on, turn blocking off for the current site. Confirm that the exception also covers its subdomains and accessible embedded players, while other sites remain covered. Remove the exception and verify that coverage returns. Repeat with global coverage off and a parent-domain library rule.
18. After blocking a generic video, click cookie-consent, Close, and text overlays above it. Neither delayed recovery nor a later site-owned `play()` may use that input. A real video surface or labelled Play control must still work.
19. Start playback while protection is off, then enable the master or platform switch. Existing playback on the current route must continue; a separate generic video and a subsequent route must remain protected. Repeat after navigating and starting another video while protection is still off.

## Optional Stop mode

1. Block a video with a direct `src`, then press Play: restore that source and start playback.
2. Reuse the same element on a new route, assign another `src`, and issue repeated autoplay requests. Manual Play must restore the new source, even if `currentSrc` still names the old one after `load()`.
3. Turn off Stop mode or the master switch after a source reset. The next Play must not remain stuck without a source.
4. If the site assigns a replacement `src`, `srcObject`, or `<source>` children, leave that source under site control. Stream and child-source players must use pause-only blocking.

## UI and diagnostics

1. Check popup and options in English and Russian.
2. Toggle **Pause playlist auto-next** in the popup, open the options page, and verify that the same state appears there. Repeat in the opposite direction.

   - Keep both windows open, change different switches in each, then reopen them: both changes must remain saved.
   - Toggle the same switch twice quickly: its final visible state must match its saved state.
   - Rapidly turn the master switch off and back on: the current-site summary must match the final switch, even if active-tab replies arrive out of order (covered by the automated UI test).
   - On a generic website, turn off the master switch: the current-site status must say autoplay blocking is off even if the site is in the library.
   - Add different websites or channels from two open extension windows at once: both additions must remain saved. Repeat after a failed save to ensure it does not block later edits.

3. Navigate the language dropdown and all switches by keyboard.
4. With **Debug logs** enabled, filter the page console by `YT-AP` and confirm that normal traces appear as log/info messages rather than errors. Copied MAIN lines must expose stable internal `mediaId` and `sourceId` values, intrinsic `size`, rendered `layout`, playlist-decision booleans, and sanitized gesture fields (`path`, `interactive`, attribute names, and classification booleans) without URLs, raw media sources, page-provided media identifiers, channel entries, saved website rules, page-provided labels, or attribute values.
5. Copy the Console without expanding objects. A YouTube pointer attempt must retain `pointerSeq`, player/path/geometry classification and `mediaId`; its manual native Play result must retain resolved/rejected outcome, paused/readiness state, matching route/pointer booleans, and safe error category when applicable.

   - YouTube playback and source events must retain `atMs`, `duration`, `adShowing`, `controllerContent` and `assignedMatchesCurrent` as plain text. Unknown values must remain unknown. Native Play outcomes include the matching request's `playSeq`; at most eight additional calls initiated within five seconds of a manual start have their outcomes observed. Debug logging must not retry playback or modify its source.

6. A root-only gesture must retain `path=html` or `path=body>html`, not `path=none`. An unmatched pointer over a YouTube video's bounds must also retain path length, button/type, window focus, hit-target classification, and viewport-scrollbar status. Neither that pointer nor the diagnostic hit test may release autoplay protection; the next genuine player click must still start playback normally.
7. Simulate a rejected settings write: show a translated error, reload saved checkbox values, retain unsaved input, and keep add/remove controls usable. A successful retry must hide the error.

   - Enter an invalid channel value, then correct it to an @handle or channel URL. The error must appear beside the retained input and clear after correction. Check Unicode handles as well.
   - Restart the background worker with the master switch off. Its toolbar icon must return to the disabled appearance without another toggle.
8. Geometry not measured for that platform must show `overVideoRect=unknown`, not `false`. Recovery scheduling and execution must retain `mediaId` and `pointerSeq` in plain text, and the input summary must retain `playLike`/`nonPlayLike` without exposing labels.
9. Replace a temporary status message before it expires: the previous timer must not clear the new message or another status area. Popup messages last 3500 ms and options messages last 4000 ms. Free-form channel input must stay redacted in popup logs even without a recognized channel-path prefix.
10. Click the text label of each switch. With the master off, dependent controls must be disabled and dimmed without losing their values. Language and debug controls remain available. Keep two settings windows open: flag, list, and language changes must appear without reopening either window or clearing drafts.
11. Reject malformed domains, bare public suffixes (`com`, `co.uk`), and private suffixes (`github.io`); accept valid domains, IDNs, IP addresses, and localhost. Reject overlong channel handles without stretching the popup. Resolve a legacy channel URL, then retry with the network unavailable: show a translated error and keep the input. Read an unavailable current channel: show a useful recovery instruction, not the raw browser error.
12. With Debug off, `ytap-config` must not contain `extensionVersion`. Ordinary gestures must not emit `ytap-gesture`; a trusted primary YouTube watch-link activation must still provide target-specific navigation intent.

## Optional visibility behavior

1. On a covered site, enable **Pause when tab is hidden** and **Resume when tab is focused**, start a video manually, then switch away and back. It must pause and resume once.
2. Turn off the master switch or the dedicated Twitch/Kick switch for that site. Switching tabs must no longer pause or resume its video.
3. Pause manually before hiding the tab. Returning must leave the video paused, with or without **Pause when tab is hidden** enabled.
4. Repeat with multiple videos, a channel exception, and a source or route change while hidden. Resume only the same manually started video actually paused by the extension; do not resume replaced or automatically started media.
