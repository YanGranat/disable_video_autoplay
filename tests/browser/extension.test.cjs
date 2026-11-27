/* global chrome, document, window, location, requestAnimationFrame, history, MediaRecorder, getComputedStyle, matchMedia */
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
      channel: "chromium", headless: true,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [`--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`,
        "--autoplay-policy=no-user-gesture-required", "--enable-automation"],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const cdp = await context.newCDPSession(page);
    const command = await cdp.send("Browser.getBrowserCommandLine");
    assert.ok(!command.arguments.some(arg => arg.includes("AutomationControlled")));
    const origin = `http://127.0.0.1:${server.address().port}`;

    async function prepare() {
      await worker.evaluate(() => chrome.storage.sync.set({ enabled: true, applyToOtherSites: true }));
      await page.goto(origin);
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
          let remaining = 12;
          const inspect = () => {
            const input = document.getElementById("enabled");
            if (input) {
              const slider = input.nextElementSibling;
              window.settingsFrames.push({ checked: input.checked, visible: getComputedStyle(slider).visibility,
                transform: getComputedStyle(slider, "::before").transform });
            }
            if (--remaining) requestAnimationFrame(inspect);
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

    await t.test("website rules open at their section and reuse a loaded options tab", async () => {
      await page.goto(`chrome-extension://${id}/popup.html`);
      await page.waitForFunction(() => document.documentElement.classList.contains("settings-ready"));
      const opened = context.waitForEvent("page");
      await page.locator("#manageSiteLibraryBtn").click();
      const options = await opened;
      try {
        await options.waitForFunction(() => location.hash === "#siteRules" && document.activeElement.id === "siteRules");
        await options.evaluate(() => { location.hash = ""; window.scrollTo(0, 0); });
        await page.bringToFront();
        await page.locator("#manageSiteLibraryBtn").click();
        await options.waitForFunction(() => location.hash === "#siteRules" && document.activeElement.id === "siteRules");
        assert.equal(context.pages().filter(tab => tab.url().includes("options.html")).length, 1);
      } finally { await options.close(); }
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
      await page.locator("#siteCollection summary").click();
      assert.equal(await page.locator("#siteFilter").isVisible(), false);
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
        assert.equal(await page.locator("#siteCount").textContent(), "0 site");
        for (const [site, count] of [["alpha.example", "1 site"], ["beta.example", "2 sites"]]) {
          await page.locator("#siteInput").fill(site);
          await page.locator("#siteAddBtn").click();
          await page.waitForFunction(expected => document.getElementById("siteCount").textContent === expected, count);
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
