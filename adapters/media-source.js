/* exported YTAPMediaSource */
const YTAPMediaSource = Object.freeze({
  create() {
    const resets = new WeakMap();

    function restore(video) {
      const reset = resets.get(video);
      if (!reset?.stopped) return false;
      let restored = false;
      // currentSrc may still identify the removed resource after load(). Only
      // a source newly supplied by the page supersedes our outstanding reset.
      if (!video.srcObject && !video.src && !video.querySelector?.("source") && reset.src) {
        video.src = reset.src;
        video.load();
        restored = true;
      }
      resets.delete(video);
      return restored;
    }

    function stop(video) {
      const reset = resets.get(video) || { stopped: false, src: "" };
      const canResetSource = !video.srcObject && !video.querySelector?.("source");
      const selectedSource = canResetSource ? (video.src || "") : "";
      if (selectedSource || !reset.stopped || !canResetSource) reset.src = selectedSource;
      resets.set(video, reset);
      video.pause();
      try { video.preload = "none"; } catch {}
      if (reset.src) {
        try { video.removeAttribute("src"); } catch {}
        try { video.load(); } catch {}
        reset.stopped = true;
        if (!video.paused && video.readyState > 0) {
          video.pause();
          return "still-active";
        }
        return "reset";
      }
      video.pause();
      return "pause-only";
    }

    return Object.freeze({ stop, restore });
  },
});
