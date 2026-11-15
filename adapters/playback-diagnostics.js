/* exported YTAPPlaybackDiagnostics */
const YTAPPlaybackDiagnostics = Object.freeze({
  create({ mediaPrototype, elementPrototype, now, snapshot, emit, MutationObserver, setTimeout, clearTimeout }) {
    let active = null;
    let timer = null;
    let observer = null;
    const restores = [];
    const scripts = new Map();

    function reset() {
      active = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      observer?.disconnect();
      observer = null;
      for (const restore of restores.splice(0).reverse()) restore();
      scripts.clear();
    }

    function current(video) {
      if (!active || active.video !== video) return null;
      if (now() - active.at >= 5000 || !video.isConnected) { reset(); return null; }
      return active;
    }

    // Keep script locations opaque; never export URLs, function names or stacks.
    function callerSummary(stack) {
      const frames = String(stack).slice(0, 4096).split("\n").slice(1, 8).map(line => {
        const match = line.match(/((?:https?|chrome-extension):\/\/[^\s()]+):(\d+):(\d+)\)?$/);
        if (!match) return null;
        try {
          const url = new URL(match[1]);
          return { script: url.protocol + "//" + url.host + url.pathname, origin: url.protocol + "//" + url.host, protocol: url.protocol, line: match[2], column: match[3] };
        } catch { return null; }
      });
      const self = frames[0];
      return frames.slice(2, 5).map(frame => {
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
        emit("YouTube media operation", `operation=${operation}`, `elapsedMs=${Math.round(now() - window.at)}`,
          `caller=${stack ? callerSummary(stack) : "unobserved"}`, ...snapshot(video));
        if (!window.remaining) emit("YouTube media operations capped", "limit=24");
      } catch {}
    }

    function operation(video, name) {
      try {
        if (current(video)?.remaining > 0) record(video, name, new Error().stack);
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

    function begin(video) {
      reset();
      active = { video, at: now(), remaining: 24 };
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
      timer = setTimeout(() => { if (active === window) reset(); }, 5000);
      timer?.unref?.();
    }

    return Object.freeze({
      begin(video) { try { begin(video); } catch { reset(); } },
      recordPlay(video) { operation(video, "play-request"); },
      reset,
    });
  },
});
