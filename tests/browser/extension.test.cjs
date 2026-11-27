/* global chrome, document, window, requestAnimationFrame, history, MediaRecorder, getComputedStyle, matchMedia */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { test } = require("node:test");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "../..");
const extensionRoot = path.resolve(process.env.YTAP_EXTENSION_ROOT || root);

test("installed extension preserves media and settings contracts in Chromium", { timeout: 90000 }, async (t) => {
  const scratch = path.join(root, "temporary_files");
  fs.mkdirSync(scratch, { recursive: true });
  const profile = fs.mkdtempSync(path.join(scratch, "browser-test-"));
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end('<!doctype html><title>Media fixture</title><div class="player"><video id="media" controls muted loop style="width:320px;height:180px"></video><button id="play">Play</button><button id="close">Close</button></div>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium", headless: process.env.YTAP_HEADED !== "1",
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`,
        "--autoplay-policy=no-user-gesture-required", "--enable-automation"],
    });
    const isExtensionWorker = worker => worker.url().startsWith("chrome-extension://")
      && worker.url().endsWith("/background.js");
    const worker = context.serviceWorkers().find(isExtensionWorker)
      || await context.waitForEvent("serviceworker", { predicate: isExtensionWorker });
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const cdp = await context.newCDPSession(page);
    const command = await cdp.send("Browser.getBrowserCommandLine");
    assert.ok(!command.arguments.some(arg => arg.includes("AutomationControlled")));
    const origin = `http://127.0.0.1:${server.address().port}`;

    async function prepare(url = origin) {
      await worker.evaluate(() => chrome.storage.sync.set({ enabled: true, applyToOtherSites: true }));
      await page.goto(url);
      await page.bringToFront();
      await page.evaluate(async () => {
        const video = document.getElementById("media");
        const canvas = document.createElement("canvas");
        canvas.width = 128; canvas.height = 72;
        document.body.appendChild(canvas);
        const drawing = canvas.getContext("2d");
        const stream = canvas.captureStream(0);
        const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
        const chunks = [];
        const bounded = (promise, step) => Promise.race([promise, new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Fixture timeout: ${step}`)), 5000);
        })]);
        const recorded = new Promise(resolve => { recorder.onstop = resolve; });
        const frames = new Promise(resolve => {
          recorder.ondataavailable = event => {
            chunks.push(event.data);
            if (chunks.reduce((bytes, chunk) => bytes + chunk.size, 0) > 256) resolve();
          };
        });
        let frame = 0;
        const paint = setInterval(() => {
          drawing.fillStyle = frame++ % 2 ? "#336699" : "#669933"; drawing.fillRect(0, 0, 128, 72);
          stream.getVideoTracks()[0].requestFrame();
        }, 30);
        recorder.start(100);
        await bounded(frames, "encoded frames");
        recorder.stop();
        await bounded(recorded, "recording");
        clearInterval(paint);
        stream.getTracks().forEach(track => track.stop());
        const metadata = new Promise((resolve, reject) => {
          video.addEventListener("loadedmetadata", resolve, { once: true });
          video.addEventListener("error", () => reject(new Error(`Fixture media error: ${video.error?.code} ${video.error?.message}; chunks=${chunks.map(chunk => chunk.size)}`)), { once: true });
        });
        video.preload = "auto";
        const clip = new Blob(chunks, { type: "video/webm" });
        if (clip.size < 100) throw new Error(`Fixture recording is empty: ${clip.size}`);
        video.src = URL.createObjectURL(clip);
        video.load();
        await bounded(metadata, "metadata");
        document.getElementById("play").onclick = () => video.play().catch(() => {});
      });
    }

    await t.test("autoplay stays paused and one real Play starts the same video", async () => {
      await prepare();
      await page.evaluate(() => document.getElementById("media").play().catch(() => {}));
      assert.equal(await page.locator("video").evaluate(video => video.paused), true);
      await page.locator("#close").click();
      await page.waitForTimeout(400);
      assert.equal(await page.locator("video").evaluate(video => video.paused), true);
      await page.locator("#play").click();
      await page.waitForFunction(() => !document.getElementById("media").paused);
    });

    await t.test("a MediaStream remains native and replacing it restores recorded-video blocking", async () => {
      await prepare();
      await page.evaluate(async () => {
        const video = document.getElementById("media");
        const canvas = document.createElement("canvas");
        canvas.width = 128; canvas.height = 72;
        document.body.appendChild(canvas);
        const drawing = canvas.getContext("2d");
        const paint = setInterval(() => {
          drawing.fillStyle = "#336699";
          drawing.fillRect(0, 0, 128, 72);
        }, 30);
        video.srcObject = canvas.captureStream(30);
        video.autoplay = true;
        await Promise.race([video.play(), new Promise((_, reject) => setTimeout(() => reject(new Error("Live stream did not start")), 5000))]);
        clearInterval(paint);
      });
      await page.waitForFunction(() => !document.getElementById("media").paused);
      assert.equal(await page.locator("video").evaluate(video => video.autoplay), true);
      await page.evaluate(async () => {
        const video = document.getElementById("media");
        video.srcObject.getTracks().forEach(track => track.stop());
        video.srcObject = null;
        video.pause();
        await video.play().catch(() => {});
      });
      assert.equal(await page.locator("video").evaluate(video => video.paused), true);
    });

    await t.test("a retained related frame loses playback permission after parent SPA navigation", async () => {
      await prepare();
      const source = await page.locator("video").getAttribute("src");
      const attached = page.waitForEvent("frameattached");
      await page.evaluate(() => document.body.appendChild(document.createElement("iframe")));
      const frame = await attached;
      await frame.evaluate(src => {
        document.body.innerHTML = '<video id="media" muted loop></video><button id="play">Play</button>';
        const video = document.getElementById("media");
        video.src = src;
        document.getElementById("play").onclick = () => video.play().catch(() => {});
      }, source);
      await frame.waitForFunction(() => document.getElementById("media").readyState > 0);
      const referrer = await frame.evaluate(() => document.referrer);
      await frame.evaluate(() => document.getElementById("media").play().catch(() => {}));
      assert.equal(await frame.locator("video").evaluate(video => video.paused), true);
      await frame.locator("#play").click();
      await frame.waitForFunction(() => !document.getElementById("media").paused);
      await frame.locator("video").evaluate(video => video.pause());

      for (const route of ["/next", "/"]) {
        await page.evaluate(pathname => history.pushState({}, "", pathname), route);
        assert.equal(await frame.evaluate(() => document.referrer), referrer);
        assert.equal(frame.url(), "about:blank");
        await frame.evaluate(() => document.getElementById("media").play().catch(() => {}));
        assert.equal(await frame.locator("video").evaluate(video => video.paused), true,
          "an earlier manual Play must not authorize the retained frame on another route");
      }
      await frame.locator("#play").click();
      await frame.waitForFunction(() => !document.getElementById("media").paused);
    });

    await t.test("unlabelled player-specific Play controls work without authorizing Close", async () => {
      for (const className of ["plyr__control--overlaid", "jw-icon-playback", "vjs-big-play-button"]) {
        await prepare();
        await page.evaluate(() => document.getElementById("media").play().catch(() => {}));
        await page.locator("#close").click();
        assert.equal(await page.locator("video").evaluate(video => video.paused), true);
        await page.locator("#play").evaluate((button, name) => {
          button.id = "control";
          button.className = name;
          button.textContent = "";
          button.style.cssText = "width:48px;height:32px";
        }, className);
        await page.locator("#control").click();
        await page.waitForFunction(() => !document.getElementById("media").paused);
      }
    });

    await t.test("protection activation preserves manually started playback", async () => {
      await worker.evaluate(() => chrome.storage.sync.set({ enabled: false }));
      await page.goto(origin);
      await prepare();
      await worker.evaluate(() => chrome.storage.sync.set({ enabled: false }));
      await page.locator("#play").click();
      await page.waitForFunction(() => !document.getElementById("media").paused);
      await worker.evaluate(() => chrome.storage.sync.set({ enabled: true }));
      await page.waitForTimeout(300);
      assert.equal(await page.locator("video").evaluate(video => video.paused), false);
    });

    await t.test("settings in another tab never start a paused channel video", async () => {
      await context.route("https://www.youtube.com/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html>
        <title>Channel playback fixture</title>
        <ytd-watch-flexy video-id="example"><div id="movie_player" class="html5-video-player">
          <video id="media" class="html5-main-video" controls muted loop style="width:320px;height:180px"></video>
          <button id="play" class="ytp-play-button" aria-label="Play">Play</button>
          <button id="pause" aria-label="Pause">Pause</button></div></ytd-watch-flexy>
        <script>
          document.querySelector('ytd-watch-flexy').data = {
            currentVideoEndpoint: { watchEndpoint: { videoId: 'example' } },
            contents: { twoColumnWatchNextResults: { results: { results: { contents: [
              { videoSecondaryInfoRenderer: { owner: { videoOwnerRenderer: {
                navigationEndpoint: { browseEndpoint: { canonicalBaseUrl: '/@example' } }
              } } } }
            ] } } } }
          };
          document.getElementById('movie_player').getVideoData = () => ({ video_id: 'example' });
          window.fixture = { play: 0, playing: 0, disarm: 0, config: 0 };
          for (const type of ['play', 'playing']) document.getElementById('media').addEventListener(type, () => window.fixture[type]++);
          window.addEventListener('ytap-disarm', () => window.fixture.disarm++);
          window.addEventListener('ytap-config', () => window.fixture.config++);
          document.getElementById('pause').onclick = () => document.getElementById('media').pause();
        </script>` }));
      const inspect = async expression => {
        let timer;
        try {
          const result = await Promise.race([
            cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: false }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Media inspection timed out")), 5000); }),
          ]);
          assert.equal(result.exceptionDetails, undefined);
          return result.result.value;
        } finally { clearTimeout(timer); }
      };
      const waitForUpdate = async (key, before) => {
        const end = Date.now() + 5000;
        while (await inspect(`window.fixture.${key}`) <= before) {
          assert.ok(Date.now() < end, "the updated channel decision must reach the media document");
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      };
      const snapshot = () => inspect("({ ...window.fixture, paused: document.getElementById('media').paused, time: document.getElementById('media').currentTime, hidden: document.hidden })");
      await worker.evaluate(() => chrome.storage.sync.set({ enabled: true, applyToYouTube: true, allowlist: [], pauseOnHidden: false, resumeOnVisible: false, debug: true }));
      await prepare("https://www.youtube.com/watch?v=example");
      assert.equal(await inspect("HTMLMediaElement.prototype.play.toString().includes('[native code]')"), false);
      assert.equal(await inspect("document.getElementById('media').play().then(() => 'allowed', error => error.name)"), "NotAllowedError");
      const blocked = await snapshot();
      assert.equal(blocked.paused, true);
      assert.equal(blocked.play, 0);
      const opened = context.waitForEvent("page");
      await worker.evaluate(async url => {
        const [videoTab] = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
        await chrome.tabs.create({ windowId: videoTab.windowId, url, active: true });
      }, `chrome-extension://${id}/popup.html`);
      const ui = await opened;
      try {
        await ui.goto(`chrome-extension://${id}/popup.html`);
        await ui.waitForFunction(() => document.documentElement.classList.contains("settings-ready"));
        await ui.bringToFront();
        await ui.locator("#newItem").fill("/@example");
        await ui.locator("#addBtn").click();
        await waitForUpdate("disarm", blocked.disarm);
        const afterException = await snapshot();
        const [videoTab] = await worker.evaluate(() => chrome.tabs.query({ url: "https://www.youtube.com/*" }));
        assert.equal(videoTab.active, false, "settings must be edited from a different active tab");
        assert.equal(afterException.paused, true);
        assert.equal(afterException.play, 0, "adding an exception must not issue native Play in another tab");
        assert.equal(afterException.time, blocked.time);

        await page.bringToFront();
        await page.locator("#play").click();
        await page.waitForFunction(() => !document.getElementById("media").paused);
        await page.locator("#pause").click();
        const manuallyPaused = await snapshot();
        assert.equal(manuallyPaused.paused, true);
        await inspect("window.dispatchEvent(new Event('ytap-resume'))");
        const afterLateDecision = await snapshot();
        assert.equal(afterLateDecision.paused, true);
        assert.equal(afterLateDecision.play, manuallyPaused.play, "a late channel decision must not override manual Pause");
        assert.equal(afterLateDecision.time, manuallyPaused.time);
        await ui.goto(`chrome-extension://${id}/options.html`);
        await ui.waitForFunction(() => document.documentElement.classList.contains("settings-ready"));
        await ui.bringToFront();
        await ui.locator("#applyToKick + .slider").click();
        await waitForUpdate("config", manuallyPaused.config);
        let afterRefresh = await snapshot();
        assert.equal(afterRefresh.paused, true);
        assert.equal(afterRefresh.play, manuallyPaused.play);
        assert.equal(afterRefresh.time, manuallyPaused.time);
        await ui.locator("#debug + .slider").click();
        await waitForUpdate("config", afterRefresh.config);
        afterRefresh = await snapshot();
        assert.equal(afterRefresh.paused, true);
        assert.equal(afterRefresh.play, manuallyPaused.play);
        assert.equal(afterRefresh.time, manuallyPaused.time);
      } finally {
        await ui.close();
        await context.unroute("https://www.youtube.com/**");
        await worker.evaluate(() => chrome.storage.sync.set({ allowlist: [], debug: false }));
      }
    });

    await t.test("popup and options retain keyboard focus when a rule is removed", async () => {
      await worker.evaluate(() => chrome.storage.sync.set({
        allowlist: ["/@alpha", "/@beta"], siteLibrary: ["alpha.example", "beta.example"],
      }));
      for (const [entry, list, input] of [["popup", "list", "newItem"], ["options", "siteLibraryList", "siteInput"]]) {
        await page.goto(`chrome-extension://${id}/${entry}.html`);
        const buttons = page.locator(`#${list} button`);
        await buttons.first().waitFor();
        await buttons.first().focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(listId => document.getElementById(listId).querySelectorAll("button").length === 1, list);
        // Read current DOM and focus atomically: a completed storage refresh may
        // replace the node a locator resolved in the preceding browser task.
        const focus = await page.evaluate(listId => {
          const button = document.getElementById(listId).querySelector("button");
          return { preserved: document.activeElement === button, active: document.activeElement?.tagName };
        }, list);
        assert.equal(focus.preserved, true, `${entry} focus after removal: ${focus.active}`);
        await page.keyboard.press("Enter");
        await page.waitForFunction(inputId => document.activeElement === document.getElementById(inputId), input);
      }
    });

    await t.test("saved switches are correct from their first visible frame", async () => {
      const view = await context.newPage();
      try {
        await view.addInitScript(() => {
          const read = chrome.storage.sync.get.bind(chrome.storage.sync);
          chrome.storage.sync.get = async (...args) => {
            await new Promise(resolve => setTimeout(resolve, 60));
            return read(...args);
          };
          window.settingsFrames = [];
          let remaining = 3;
          const started = performance.now();
          const inspect = () => {
            const input = document.getElementById("enabled");
            if (input) {
              const slider = input.nextElementSibling;
              window.settingsFrames.push({ checked: input.checked, visible: getComputedStyle(slider).visibility,
                transform: getComputedStyle(slider, "::before").transform });
              if (getComputedStyle(slider).visibility === "visible") remaining--;
            }
            if (remaining > 0 && performance.now() - started < 5000) requestAnimationFrame(inspect);
            else window.settingsFramesDone = true;
          };
          requestAnimationFrame(inspect);
        });
        for (const [surface, offset] of [["popup", 18], ["options", 20]]) {
          await view.goto(`chrome-extension://${id}/${surface}.html`);
          await view.waitForFunction(() => window.settingsFramesDone && document.documentElement.classList.contains("settings-ready"));
          const frames = await view.evaluate(() => window.settingsFrames.filter(frame => frame.visible === "visible"));
          assert.ok(frames.length > 0);
          assert.ok(frames.every(frame => frame.checked && frame.transform === `matrix(1, 0, 0, 1, ${offset}, 0)`));
          if (surface === "options") assert.equal(await view.locator("#debug").isDisabled(), false);
          const descriptions = await view.locator("#enabled").evaluate(input => input.getAttribute("aria-describedby").split(" ").map(id => document.getElementById(id).textContent).join(" "));
          assert.doesNotMatch(descriptions, /could not/);
          assert.equal(await view.locator(".slider").first().evaluate(slider => getComputedStyle(slider, "::before").transitionDuration), "0.2s");
        }
      } finally { await view.close(); }
    });

    await t.test("popup manages website rules without opening options", async () => {
      await worker.evaluate(() => chrome.storage.sync.set({ uiLanguage: "en", enabled: true, siteLibrary: [], siteExclusions: [] }));
      await page.goto(`chrome-extension://${id}/popup.html`);
      await page.waitForFunction(() => document.documentElement.classList.contains("settings-ready"));
      const pages = context.pages().length;
      const feedback = await page.locator(".site-feedback").evaluate(node => ({ height: node.getBoundingClientRect().height, display: getComputedStyle(node).display }));
      assert.equal(feedback.height, 0, "an empty message must not reserve a stripe");
      assert.notEqual(feedback.display, "none", "keep the live region available for later feedback");
      await page.locator("#siteInput").fill("video.example");
      await page.locator("#siteInput").press("Enter");
      const blocking = page.locator("#siteLibraryList .site-blocking");
      await blocking.waitFor({ state: "attached" });
      assert.equal(await blocking.isChecked(), true);
      await blocking.focus();
      await page.keyboard.press("Space");
      await page.waitForFunction(() => !document.querySelector(".site-blocking").checked && document.querySelector(".site-blocking").getAttribute("aria-busy") === "false");
      assert.equal(await page.locator("#siteLibraryList .site-item").count(), 1);
      assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".site-blocking")), true);
      await page.locator("#siteLibraryList button").click();
      await page.locator("#siteUndoBtn").waitFor();
      await page.locator("#siteUndoBtn").click();
      await page.locator("#siteLibraryList button").waitFor();
      assert.equal(await blocking.isChecked(), false);
      assert.equal(context.pages().length, pages);
      assert.equal(await page.locator(".setting-help, summary").count(), 0);
      assert.match(await page.locator('label[for="applyToPlaylists"]').getAttribute("title"), /select yourself/);
    });

    await t.test("site search and undo preserve an edit from another view", async () => {
      await worker.evaluate(() => chrome.storage.sync.set({ uiLanguage: "en", siteLibrary: ["alpha.example", "beta.example"] }));
      await page.goto(`chrome-extension://${id}/options.html`);
      await page.locator("#siteFilter").fill("alpha");
      await page.waitForFunction(() => document.querySelectorAll("#siteLibraryList .site-item").length === 1);
      await page.locator("#siteLibraryList button").click();
      await page.waitForFunction(() => !document.getElementById("siteUndoBtn").hidden);
      await worker.evaluate(() => chrome.storage.sync.set({ siteLibrary: ["beta.example", "gamma.example"] }));
      await page.locator("#siteUndoBtn").click();
      await page.waitForFunction(() => document.getElementById("siteUndoBtn").hidden);
      const sites = await worker.evaluate(async () => (await chrome.storage.sync.get("siteLibrary")).siteLibrary);
      assert.deepEqual(sites.sort(), ["alpha.example", "beta.example", "gamma.example"]);
      assert.equal(await page.locator("#siteFilter").inputValue(), "alpha");
      assert.equal(await page.locator('.service-footer a', { hasText: "GitHub" }).getAttribute("href"), "https://github.com/YanGranat/disable_video_autoplay");
      const groups = await page.locator("main > section").evaluateAll(nodes => nodes.map(node => node.id));
      assert.equal(groups.indexOf("platforms") + 1, groups.indexOf("siteRules"));
    });

    await t.test("French UI selection persists and updates both settings surfaces", async () => {
      await worker.evaluate(() => chrome.storage.sync.set({
        uiLanguage: "en", siteLibrary: [], siteExclusions: [], allowlist: [],
      }));
      const popup = await context.newPage();
      try {
        await popup.goto(`chrome-extension://${id}/popup.html`);
        await page.goto(`chrome-extension://${id}/options.html`);
        await page.waitForFunction(() => document.documentElement.lang === "en");
        await popup.waitForFunction(() => document.documentElement.lang === "en");
        await page.locator("#uiLanguageBtn").click();
        await page.getByRole("option", { name: "Français", exact: true }).click();
        for (const surface of [popup, page]) {
          await surface.waitForFunction(() => document.documentElement.lang === "fr");
          assert.equal(await surface.locator("#uiLanguageValue").textContent(), "Français");
          assert.equal(await surface.locator("#enabled").getAttribute("aria-label"), "Activé");
        }
        assert.equal(await popup.locator("#newItem").getAttribute("placeholder"), "/@identifiant");
        await popup.locator("#newItem").fill("not a channel");
        await popup.locator("#addBtn").click();
        await popup.waitForFunction(() => !document.getElementById("channelInputError").hidden);
        assert.equal(await popup.locator("#channelInputError").textContent(),
          "Saisissez un @identifiant YouTube ou l’URL d’une chaîne.");
        assert.equal(await page.locator("#siteEmpty").textContent(), "Aucune règle de site pour le moment.");
        for (const [site, count] of [["alpha.example", 1], ["beta.example", 2]]) {
          await page.locator("#siteInput").fill(site);
          await page.locator("#siteAddBtn").click();
          await page.waitForFunction(expected => document.querySelectorAll("#siteLibraryList .site-item").length === expected, count);
        }
        assert.equal(await page.locator("#siteLibraryList button").first().getAttribute("aria-label"),
          "Supprimer alpha.example");
        assert.equal(await worker.evaluate(async () => (await chrome.storage.sync.get("uiLanguage")).uiLanguage), "fr");
        for (const surface of [popup, page]) {
          await surface.reload();
          await surface.waitForFunction(() => document.documentElement.lang === "fr");
        }
      } finally {
        await popup.close();
        await worker.evaluate(() => chrome.storage.sync.set({ uiLanguage: "auto" }));
      }
    });

    await t.test("keyboard focus and forced-color switches remain distinguishable", async () => {
      await page.setViewportSize({ width: 360, height: 600 });
      for (const entry of ["popup", "options"]) {
        await page.goto(`chrome-extension://${id}/${entry}.html`);
        await page.waitForFunction(() => document.getElementById("enabled").checked);
        await page.locator("#uiLanguageBtn").focus();
        await page.keyboard.press("ArrowDown");
        const focus = await page.evaluate(() => {
          const style = getComputedStyle(document.activeElement);
          const root = getComputedStyle(document.documentElement);
          return { outline: style.outlineColor, accent: root.getPropertyValue("--accent").trim(), width: style.outlineWidth };
        });
        assert.equal(focus.outline, "rgb(214, 60, 87)");
        assert.equal(focus.width, "2px");
        await page.keyboard.press("Tab");
        assert.equal(await page.evaluate(() => document.activeElement.id), "enabled");
        assert.equal(await page.locator("#uiLanguageBtn").getAttribute("aria-expanded"), "false");
        await page.locator("#uiLanguageBtn").focus();
        await page.keyboard.press("ArrowDown");
        if (process.env.YTAP_SCREENSHOTS) {
          const directory = path.join(scratch, "ui-test-screenshots");
          fs.mkdirSync(directory, { recursive: true });
          await page.screenshot({ path: path.join(directory, `${entry}-focus.png`) });
        }
        await page.keyboard.press("Escape");
        await page.emulateMedia({ forcedColors: "active" });
        // Media emulation and the existing switch transition are asynchronous.
        await page.waitForFunction(() => matchMedia("(forced-colors: active)").matches
          && getComputedStyle(document.getElementById("enabled").nextElementSibling).backgroundColor
            !== getComputedStyle(document.getElementById("applyToShorts").nextElementSibling).backgroundColor);
        const colors = await page.evaluate(() => ["enabled", "applyToShorts"].map(key =>
          getComputedStyle(document.getElementById(key).nextElementSibling).backgroundColor));
        assert.notEqual(colors[0], colors[1]);
        if (process.env.YTAP_SCREENSHOTS) {
          await page.screenshot({ path: path.join(scratch, "ui-test-screenshots", `${entry}-forced-colors.png`) });
        }
        await page.emulateMedia({ forcedColors: "none" });
      }
    });
  } finally {
    await context?.close();
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(profile), scratch);
    assert.equal(fs.lstatSync(profile).isSymbolicLink(), false);
    fs.rmSync(profile, { recursive: true });
  }
});
