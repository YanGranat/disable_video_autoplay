/* exported YTAPVisibilityPlayback */
const YTAPVisibilityPlayback = Object.freeze({
  install({ document, getConfig, isCovered, getScope, isMainVideo, isUserAllowedVideo, play, onAction }) {
    const manualStarts = new WeakMap();
    const pendingPauses = new Map();
    const observed = new WeakSet();
    const cancel = () => pendingPauses.clear();

    function sourceState(video) {
      return [video.src, video.currentSrc, video.srcObject,
        ...Array.from(video.querySelectorAll?.("source") || []).map((source) => source.src)];
    }

    function sameScope(record, scope) {
      return record?.routeKey === scope.routeKey && record?.generation === scope.generation;
    }

    function markManual(video, scope) {
      manualStarts.set(video, { routeKey: scope.routeKey, generation: scope.generation });
    }

    function observe(video) {
      if (observed.has(video)) return;
      observed.add(video);
      video.addEventListener("pause", () => {
        const pause = pendingPauses.get(video);
        if (pause?.expectPause) pause.expectPause = false;
        else pendingPauses.delete(video);
      }, true);
      for (const event of ["play", "emptied"]) {
        video.addEventListener(event, () => pendingPauses.delete(video), true);
      }
    }

    document.addEventListener("visibilitychange", () => {
      if (!isCovered()) {
        cancel();
        return;
      }
      const config = getConfig();
      const scope = getScope();
      if (document.hidden) {
        cancel();
        if (!config.pauseOnHidden) return;
        for (const video of document.querySelectorAll("video")) {
          if (video.paused || video.isConnected === false || !isMainVideo(video)) continue;
          if (sameScope(manualStarts.get(video), scope)) {
            pendingPauses.set(video, { ...scope, source: sourceState(video), expectPause: true });
          }
          try {
            video.pause();
            onAction("hidden → paused", video);
          } catch {
            pendingPauses.delete(video);
          }
        }
        return;
      }

      const pending = Array.from(pendingPauses);
      cancel();
      if (!config.resumeOnVisible) return;
      for (const [video, pause] of pending) {
        if (!sameScope(pause, scope) || video.isConnected === false || !video.paused
          || !isMainVideo(video) || !isUserAllowedVideo(video)) continue;
        const source = sourceState(video);
        if (source.length !== pause.source.length || source.some((value, index) => value !== pause.source[index])) continue;
        play(video).catch(() => {});
        onAction("visible → resume attempted", video);
      }
    });

    return Object.freeze({ markManual, cancel, observe });
  },
});
