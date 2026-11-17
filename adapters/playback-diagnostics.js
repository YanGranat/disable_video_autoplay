/* exported YTAPPlaybackDiagnostics */
const YTAPPlaybackDiagnostics = Object.freeze({
  create({ mediaPrototype, elementPrototype, now, snapshot, context = () => ({}), emit, MutationObserver, setTimeout, clearTimeout }) {
    let active = null;
    let timer = null;
    let observer = null;
    const restores = [];
    const scripts = new Map();
    let sessionSeq = 0;

    function readContext(video) {
      try { return context(video) || {}; } catch { return {}; }
    }

    function summary(window, reason) {
      try {
        const end = readContext(window.video);
        const number = value => Number.isSafeInteger(value) && value >= 0 ? value : "unknown";
        const id = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}\\d+$`).test(value) ? value : "unknown";
        const kinds = Object.keys(window.actions).filter(key => window.actions[key] > 0);
        const routeChanged = reason === "route" ? true
          : Number.isSafeInteger(window.start.generation) && Number.isSafeInteger(end.generation)
            ? window.start.generation !== end.generation : "unknown";
        emit("YouTube playback summary", `session=p${window.seq}`, `reason=${reason}`,
          `frame=${["top", "child"].includes(window.start.frame) ? window.start.frame : "unknown"}`,
          `elapsedMs=${Math.round(now() - window.at)}`, `mediaId=${id(window.start.mediaId, "m")}`,
          `sourceStart=${id(window.start.sourceId, "s")}`, `sourceEnd=${id(end.sourceId, "s")}`,
          `starts=${window.starts}`, `playEvents=${window.playEvents}`, `playingEvents=${window.playingEvents}`, `pauseEvents=${window.pauseEvents}`,
          `sourceResets=${window.resets}`, `sourceChanges=${window.sourceChanges}`, `sourceWriteCalls=${window.writes}`,
          `playRequests=${window.requests}`, `blockedRequests=${window.blocks}`,
          `extensionActions=${kinds.reduce((total, key) => total + window.actions[key], 0)}`, `actionKinds=${kinds.join(",") || "none"}`,
          `priorBlock=${typeof window.start.priorBlock === "boolean" ? window.start.priorBlock : "unknown"}`,
          `pointerStart=${number(window.start.pointerSeq)}`, `pointerEnd=${number(end.pointerSeq)}`,
          `clickStart=${number(window.start.clickSeq)}`, `clickEnd=${number(end.clickSeq)}`,
          `keyStart=${number(window.start.keySeq)}`, `keyEnd=${number(end.keySeq)}`,
          `routeChanged=${routeChanged}`,
          `navigationAtStart=${["started", "finished"].includes(window.start.navigation) ? window.start.navigation : "unknown"}`,
          `navigationFinishes=${window.navigationFinishes}`, `navigationFinishMs=${window.navigationFinishMs ?? "unknown"}`,
          `configUpdates=${window.configUpdates}`,
          `waiting=${window.waiting}`, `stalled=${window.stalled}`, `errors=${window.errors}`,
          `tracingAvailable=${window.start.tracing === true}`, `eventsObserved=${window.events > 0}`);
      } catch {}
    }

    function reset(reason = "reset") {
      const previous = active;
      active = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      observer?.disconnect();
      observer = null;
      for (const restore of restores.splice(0).reverse()) restore();
      scripts.clear();
      if (previous && reason !== "debug-off") summary(previous, reason);
    }

    function current(video) {
      if (!active || active.video !== video) return null;
      if (now() - active.at >= 5000 || !video.isConnected) { reset(video.isConnected ? "expired" : "disconnected"); return null; }
      return active;
    }

    // Keep script locations opaque; never export URLs, function names or stacks.
    function callerSummary(stack, depth) {
      const frames = String(stack).slice(0, 4096).split("\n").slice(1, 11).map(line => {
        const match = line.match(/((?:https?|chrome-extension):\/\/[^\s()]+):(\d+):(\d+)\)?$/);
        if (!match) return null;
        try {
          const url = new URL(match[1]);
          return { script: url.protocol + "//" + url.host + url.pathname, origin: url.protocol + "//" + url.host, protocol: url.protocol, line: match[2], column: match[3] };
        } catch { return null; }
      });
      const self = frames[0];
      return frames.slice(2, 2 + depth).map(frame => {
        if (!frame) return "unknown";
        let id = scripts.get(frame.script);
        if (!id) { id = `j${scripts.size + 1}`; scripts.set(frame.script, id); }
        const owner = frame.protocol !== "chrome-extension:" ? "web"
          : self?.protocol === "chrome-extension:" && frame.origin === self.origin ? "self-extension" : "other-extension";
        return `${owner}:${id}:${frame.line}:${frame.column}`;
      }).join(">") || "unknown";
    }

    function record(video, operation, stack) {
      const window = current(video);
      if (!window || window.remaining <= 0) return;
      window.remaining--;
      try {
        // Source resets may delegate through several player layers.
        const depth = operation === "play-request" || operation === "pause" ? 3 : 8;
        emit("YouTube media operation", `operation=${operation}`, `elapsedMs=${Math.round(now() - window.at)}`,
          `caller=${stack ? callerSummary(stack, depth) : "unobserved"}`, ...snapshot(video));
        if (!window.remaining) emit("YouTube media operations capped", "limit=24");
      } catch {}
    }

    function operation(video, name) {
      try {
        const window = current(video);
        if (!window) return;
        if (["src-set", "srcObject-set", "setAttribute", "removeAttribute"].includes(name)) window.writes++;
        if (window.remaining > 0) record(video, name, new Error().stack);
      } catch {}
    }

    function replace(prototype, key, field, factory) {
      if (!prototype) return false;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (!descriptor?.configurable || typeof descriptor[field] !== "function") return false;
      const original = descriptor[field];
      const wrapped = factory(original);
      try { Object.defineProperty(prototype, key, { ...descriptor, [field]: wrapped }); }
      catch { return false; }
      restores.push(() => {
        try {
          const latest = Object.getOwnPropertyDescriptor(prototype, key);
          if (latest?.[field] === wrapped) Object.defineProperty(prototype, key, { ...latest, [field]: original });
        } catch {}
      });
      return true;
    }

    function begin(video, initialRequest) {
      reset("replaced");
      active = {
        video, at: now(), remaining: 24, seq: ++sessionSeq, start: readContext(video),
        requests: initialRequest ? 1 : 0, blocks: 0, writes: 0, events: 0,
        playEvents: 0, playingEvents: 0, pauseEvents: 0, starts: 0, resets: 0, sourceChanges: 0,
        waiting: 0, stalled: 0, errors: 0, pendingStart: false, pendingReset: false,
        navigationFinishes: 0, navigationFinishMs: null, configUpdates: 0,
        reportedRestart: false, lastSource: "", actions: { intervention: 0, source: 0, play: 0, visibility: 0 },
      };
      active.lastSource = active.start.sourceId;
      const installed = [];
      for (const key of ["load", "pause"]) {
        if (replace(mediaPrototype, key, "value", original => function (...args) {
          operation(this, key);
          return Reflect.apply(original, this, args);
        })) installed.push(key);
      }
      for (const key of ["src", "srcObject"]) {
        if (replace(mediaPrototype, key, "set", original => function (...args) {
          operation(this, `${key}-set`);
          return Reflect.apply(original, this, args);
        })) installed.push(key);
      }
      for (const key of ["setAttribute", "removeAttribute"]) {
        if (replace(elementPrototype, key, "value", original => function (...args) {
          // Do not coerce attribute names twice: custom coercion can have effects.
          if (typeof args[0] === "string" && args[0].toLowerCase() === "src") {
            operation(this, key);
          }
          return Reflect.apply(original, this, args);
        })) installed.push(key);
      }
      try {
        const window = active;
        observer = new MutationObserver(() => {
          try { if (active === window) record(video, "media-mutation", null); } catch {}
        });
        observer.observe(video, { attributes: true, attributeFilter: ["src"], childList: true, subtree: true });
        installed.push("mutations");
      } catch {}
      emit("YouTube media observation", `hooks=${installed.join(",") || "none"}`, "windowMs=5000", "limit=24", ...snapshot(video));
      const window = active;
      timer = setTimeout(() => { if (active === window) reset("expired"); }, 5000);
      timer?.unref?.();
    }

    return Object.freeze({
      begin(video, initialRequest = false) { try { begin(video, initialRequest); } catch { reset(); } },
      recordPlay(video, decision) {
        try {
          const window = current(video);
          if (!window) return;
          window.requests++;
          if (["block", "deny-stale", "deny-carryover"].includes(decision)) window.blocks++;
          operation(video, "play-request");
        } catch {}
      },
      recordAction(video, kind) {
        try {
          const window = current(video);
          if (window && Object.hasOwn(window.actions, kind)) window.actions[kind]++;
        } catch {}
      },
      recordMilestone(kind) {
        try {
          const window = active && current(active.video);
          if (!window) return;
          if (kind === "navigation-finish") {
            window.navigationFinishes++;
            window.navigationFinishMs ??= Math.round(now() - window.at);
          }
          if (kind === "config") window.configUpdates++;
        } catch {}
      },
      recordEvent(video, event, sourceId) {
        try {
          if (!["play", "playing", "pause", "emptied", "waiting", "stalled", "error", "abort"].includes(event)) return;
          const window = current(video);
          if (!window) return;
          window.events++;
          if (typeof sourceId === "string" && /^s\d+$/.test(sourceId)) {
            if (window.lastSource && window.lastSource !== sourceId) window.sourceChanges++;
            window.lastSource = sourceId;
          }
          if (event === "play") { window.playEvents++; window.pendingStart = true; }
          if (event === "pause") window.pauseEvents++;
          if (event === "emptied") { window.resets++; window.pendingReset = window.starts > 0; }
          if (event === "waiting") window.waiting++;
          if (event === "stalled") window.stalled++;
          if (event === "error") window.errors++;
          if (event === "playing") {
            window.playingEvents++;
            if (window.pendingStart || !window.starts || window.pendingReset) window.starts++;
            window.pendingStart = false;
            if (window.pendingReset && !window.reportedRestart) {
              window.reportedRestart = true;
              summary(window, "media-restarted");
            }
            window.pendingReset = false;
          }
        } catch {}
      },
      reset,
    });
  },
});
