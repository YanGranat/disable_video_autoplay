const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const { runScripts, contentScripts } = require("../load_scripts.cjs");

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) {
      listener.call(this, event);
      if (event.immediatePropagationStopped) break;
    }
    return true;
  }
}

function createMediaTypes() {
  class FakeMediaElement extends FakeEventTarget {
    constructor() {
      super();
      this.paused = true;
      this.readyState = 4;
      this.currentTime = 0;
      this.currentSrc = "blob:test-stream";
      this.src = "";
      this.volume = 1;
      this.muted = false;
      this.autoplay = false;
      this.isConnected = true;
      this.playCalls = 0;
      this.pauseCalls = 0;
      this.nativePlayFailures = 0;
    }

    play() {
      this.playCalls += 1;
      if (this.nativePlayFailures > 0) {
        this.nativePlayFailures -= 1;
        this.paused = true;
        return Promise.resolve();
      }
      this.paused = false;
      return Promise.resolve();
    }

    pause() {
      this.pauseCalls += 1;
      this.paused = true;
    }
  }

  class FakeVideoElement extends FakeMediaElement {
    constructor() {
      super();
      this.nodeType = 1;
      this.tagName = "VIDEO";
      this.videoWidth = 1280;
      this.videoHeight = 720;
      this.classList = { contains: () => false };
    }

    closest() {
      return null;
    }

    matches() {
      return false;
    }

    querySelectorAll() {
      return [];
    }

    getBoundingClientRect() {
      return { left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720 };
    }

    hasAttribute(name) {
      return name === "autoplay" && this.autoplay;
    }

    removeAttribute(name) {
      if (name === "autoplay") this.autoplay = false;
      if (name === "src") this.src = "";
    }

    setAttribute(name) {
      if (name === "autoplay") this.autoplay = true;
    }
    load() { this.currentSrc = this.src; }
  }
  return { FakeMediaElement, FakeVideoElement };
}

class FakeTwitchControl {
  constructor(windowTarget, action = "pause") {
    this.windowTarget = windowTarget;
    this.action = action;
    this.nodeType = 1;
    this.tagName = "BUTTON";
    this.textContent = "";
    this.classList = { contains: () => false };
  }

  getAttribute(name) {
    if (name === "aria-label") return this.action === "pause" ? "Pause" : "Play";
    if (name === "data-a-target") return "player-play-pause-button";
    if (name === "role") return "button";
    return "";
  }

  closest(selector) {
    return selector.includes("player-container") || selector.includes("video-player") ? this : null;
  }

  matches() {
    return false;
  }

  click() {
    this.windowTarget.dispatchEvent({
      type: "click",
      isTrusted: false,
      target: this,
      clientX: 100,
      clientY: 100,
      composedPath: () => [this],
      stopImmediatePropagation() { this.immediatePropagationStopped = true; },
      preventDefault() {},
    });
  }
}

class FakeMutationObserver {
  observe() {}
  disconnect() {}
}

class FakeCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

function createHarness({
  configureImmediately = true,
  enabled = true,
  applyToTwitch = true,
  applyToKick = true,
  applyToOtherSites = true,
  stopInsteadOfPause = false,
  pauseOnHidden = false,
  resumeOnVisible = false,
  hostname = "www.twitch.tv",
  pathname = "/channel-a",
  search = "",
  referrer = "",
  ownerLocation = null,
  ancestorOrigins = [],
  readyState = "complete",
  videoInitiallyPresent = true,
  nativePlayFailures = 0,
  mediaReadyState = 4,
  videoWidth = 1280,
  videoHeight = 720,
  autoplay = false,
  debug = false,
} = {}) {
  const { FakeMediaElement, FakeVideoElement } = createMediaTypes();
  const video = new FakeVideoElement();
  video.nativePlayFailures = nativePlayFailures;
  video.readyState = mediaReadyState;
  video.videoWidth = videoWidth;
  video.videoHeight = videoHeight;
  video.autoplay = autoplay;
  video.classList = { contains: (name) => name === "html5-main-video" && hostname.includes("youtube") };
  const windowTarget = new FakeEventTarget();
  windowTarget.top = windowTarget;
  windowTarget.parent = windowTarget;
  if (ownerLocation) {
    const parent = { location: ownerLocation };
    parent.parent = parent;
    windowTarget.parent = parent;
    windowTarget.top = parent;
  }
  let clockOffset = 0;
  let twitchControl = null;
  let videoPresent = videoInitiallyPresent;
  const additionalVideos = [];
  const consoleEntries = [];

  const documentTarget = new FakeEventTarget();
  documentTarget.readyState = readyState;
  Object.defineProperty(documentTarget, "referrer", { value: referrer, enumerable: true });
  documentTarget.hidden = false;
  documentTarget.pictureInPictureElement = null;
  documentTarget.body = { nodeType: 1, closest: () => null };
  documentTarget.documentElement = { nodeType: 1, closest: () => null };
  documentTarget.activeElement = documentTarget.body;
  documentTarget.querySelector = (selector) => {
    if (selector.includes("player-play-pause-button")) return twitchControl;
    return selector.includes("video") && videoPresent ? video : null;
  };
  documentTarget.querySelectorAll = (selector) => {
    if (selector === "video") return videoPresent ? [video, ...additionalVideos.map((entry) => entry.video)] : [];
    if (selector.includes("button") && twitchControl) return [twitchControl];
    return [];
  };

  const location = {
    hostname,
    pathname,
    search,
    hash: "",
    href: hostname ? `https://${hostname}${pathname}${search}` : "about:blank",
    ancestorOrigins,
  };

  const context = vm.createContext({
    console: {
      log(...args) { consoleEntries.push({ level: "log", args }); },
      info(...args) { consoleEntries.push({ level: "info", args }); },
      error(...args) { consoleEntries.push({ level: "error", args }); },
    },
    document: documentTarget,
    window: windowTarget,
    location,
    performance: { now: () => performance.now() + clockOffset },
    HTMLMediaElement: FakeMediaElement,
    HTMLVideoElement: FakeVideoElement,
    MutationObserver: FakeMutationObserver,
    CustomEvent: FakeCustomEvent,
    DOMException,
    URL,
    URLSearchParams,
    Promise,
    Set,
    WeakSet,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    setInterval(callback, delay, ...args) {
      const timer = setInterval(callback, delay, ...args);
      timer.unref?.();
      return timer;
    },
    clearInterval,
  });

  runScripts(context, contentScripts("MAIN"));

  const configure = (enabledForTwitch = applyToTwitch, enabledForKick = applyToKick) => {
    windowTarget.dispatchEvent(new FakeCustomEvent("ytap-config", {
      detail: {
        settingsReady: true,
        enabled,
        applyToTwitch: enabledForTwitch,
        applyToKick: enabledForKick,
        applyToOtherSites,
        stopInsteadOfPause,
        pauseOnHidden,
        resumeOnVisible,
        debug,
      },
    }));
  };

  if (configureImmediately) configure();

  return {
    video,
    createVideo: () => new FakeVideoElement(),
    createAudio: () => new FakeMediaElement(),
    windowTarget,
    document: documentTarget,
    location,
    consoleEntries,
    configure,
    advanceTime(ms) { clockOffset += ms; },
    setTwitchControl(control) { twitchControl = control; },
    setVideoPresent(present) { videoPresent = present; },
    addYouTubeVideo({ inMiniplayer = false } = {}) {
      const additionalVideo = new FakeVideoElement();
      additionalVideo.classList = { contains: (name) => name === "html5-main-video" && hostname.includes("youtube") };
      additionalVideo.closest = (selector) => {
        if (selector.includes("ytd-miniplayer") || selector.includes("#miniplayer")) {
          return inMiniplayer ? additionalVideo : null;
        }
        return null;
      };
      const entry = { video: additionalVideo };
      additionalVideos.push(entry);
      return entry;
    },
  };
}

function trustedPlayerPointer(video, clientY = 100) {
  return {
    type: "pointerdown",
    isTrusted: true,
    target: video,
    clientX: 100,
    clientY,
    composedPath: () => [video],
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
    preventDefault() {},
  };
}

// Chrome's normal Copy all keeps primitive arguments but collapses expandable
// console objects; diagnostic assertions use that flattened representation.
function copiedConsoleText(entries) {
  return entries
    .map((entry) => entry.args.map((value) => value !== null && typeof value === "object" ? "Object" : String(value)).join(" "))
    .join("\n");
}

function trustedPlayerClick(video, clientY = 100) {
  return {
    type: "click",
    isTrusted: true,
    target: video,
    clientX: 100,
    clientY,
    composedPath: () => [video],
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
    preventDefault() {},
  };
}

function trustedOverlayEvent(type, overlay, clientY = 100) {
  return {
    type,
    isTrusted: true,
    target: overlay,
    clientX: 100,
    clientY,
    composedPath: () => [overlay],
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
    preventDefault() {},
  };
}

function fakePlayerOverlay() {
  return {
    nodeType: 1,
    tagName: "DIV",
    id: "",
    className: "player-overlay",
    getAttribute: () => "",
    matches: () => false,
    closest: () => null,
    querySelectorAll: () => [],
  };
}

function fakePlayControl() {
  return {
    nodeType: 1,
    tagName: "A",
    id: "",
    className: "play_button",
    getAttribute: () => "",
    matches: () => false,
    closest: () => null,
    querySelectorAll: () => [],
  };
}

function fakeCompactPlayPauseControl() {
  const button = {
    nodeType: 1,
    tagName: "BUTTON",
    id: "",
    className: "",
    getAttribute(name) {
      if (name === "role") return "custom-control-role";
      if (name === "data-testid") return "media-control-playpause";
      return "";
    },
    matches: () => false,
    closest: () => null,
    querySelectorAll: () => [],
  };
  const icon = {
    nodeType: 1,
    tagName: "svg",
    id: "",
    className: "",
    getAttribute: () => "",
    matches: () => false,
    closest: () => null,
    querySelectorAll: () => [],
  };
  return { button, icon };
}

function trustedExternalControlEvent(type, target, path) {
  return {
    type,
    isTrusted: true,
    target,
    clientX: 1500,
    clientY: 900,
    composedPath: () => path,
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
    preventDefault() {},
  };
}

function trustedControlEvent(type, control) {
  return {
    type,
    isTrusted: true,
    target: control,
    clientX: 100,
    clientY: 100,
    composedPath: () => [control],
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
    preventDefault() {},
  };
}

function fakeYoutubeWatchLink(videoId, playlistId = "PL1") {
  const href = `https://www.youtube.com/watch?v=${videoId}&list=${playlistId}`;
  return {
    nodeType: 1,
    tagName: "A",
    href,
    id: "",
    className: "",
    getAttribute(name) { return name === "href" ? href : ""; },
    matches: () => false,
    closest: () => null,
    querySelectorAll: () => [],
  };
}

function trustedYoutubeNavigationPointer(link) {
  return {
    type: "pointerdown",
    isTrusted: true,
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: link,
    clientX: 100,
    clientY: 100,
    composedPath: () => [link],
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
    preventDefault() {},
  };
}

function trustedYoutubeNavigationClick(link) {
  return {
    type: "click",
    isTrusted: true,
    detail: 0,
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: link,
    clientX: 100,
    clientY: 100,
    composedPath: () => [link],
    stopImmediatePropagation() { this.immediatePropagationStopped = true; },
    preventDefault() {},
  };
}

// Controllers consume expected autoplay denials. Promise-contract tests call
// play() directly and assert its rejection separately.
function requestPlayback(video) {
  return video.play().catch(error => {
    if (error?.name !== "NotAllowedError") throw error;
  });
}

module.exports = { createHarness, requestPlayback, FakeCustomEvent, FakeTwitchControl, trustedPlayerPointer, trustedPlayerClick, trustedOverlayEvent, fakePlayerOverlay, fakePlayControl, copiedConsoleText, fakeCompactPlayPauseControl, trustedExternalControlEvent, trustedControlEvent, fakeYoutubeWatchLink, trustedYoutubeNavigationPointer, trustedYoutubeNavigationClick };
