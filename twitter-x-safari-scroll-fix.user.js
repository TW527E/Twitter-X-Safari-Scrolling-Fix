// ==UserScript==
// @name         X (Twitter) Safari 時間線位置修復
// @name:en         X (Twitter) Safari timeline position fix
// @namespace    https://github.com/TW527E/Twitter-X-Safari-Scrolling-Fix
// @version      2.3.7
// @description  修復 Safari 從推文或其他頁面返回 X 時間線後的位置跳動，支援非 100% 頁面縮放。
// @description:en  Fixed Safari timeline jumps after returning from a post or another page, including non-100% page zoom.
// @author       TW527E
// @homepageURL  https://greasyfork.org/zh-TW/scripts/588900-x-twitter-safari-時間線位置修復
// @supportURL   https://greasyfork.org/zh-TW/scripts/588900-x-twitter-safari-時間線位置修復/feedback
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @sandbox      DOM
// @license      MIT
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = GM_info.script.version;
  const STORAGE_PREFIX = "x-safari-scroll-fix:v4:";
  const MAX_SNAPSHOT_AGE_MS = 6 * 60 * 60 * 1000;
  const SAVE_DEBOUNCE_MS = 100;
  const RESTORE_TIMEOUT_MS = 6_000;
  const RESTORE_SETTLE_MS = 200;
  const MIN_GUARD_MS = 2_000;
  // Keep watching briefly after the first stable frame. X can finish media,
  // formula, or virtual-list layout after Safari has restored the route.
  const POST_RESTORE_GUARD_MS = 2_000;
  const POST_RESTORE_SAVE_SUPPRESS_MS = 2_000;
  const PAINT_NUDGE_PX = 1;
  const MIN_POSITION_TOLERANCE_PX = 0.25;
  // Safari's Retina baseline on the target Mac is DPR 2 at 100% page zoom.
  // Page zoom raises DPR (2.5 at 125%). DOMRect and scroll deltas stay 1:1 in
  // CSS px, but the scroll position snaps to steps of 1 / zoomScale CSS px.
  const REFERENCE_DEVICE_PIXEL_RATIO = 2;
  const MAX_STALLED_ERROR_PX = 2;
  const STALLED_CORRECTION_FRAMES = 6;
  const POSITION_PROGRESS_EPSILON_PX = 0.05;
  const QUANTIZED_HISTORY_FRAMES = 6;
  const QUANTIZED_POSITION_SPAN_PX = 2.5;
  const METRICS_EPSILON = 0.001;
  const PHOTO_BYPASS_MS = 1_500;
  const RAW_SCROLL_RETRY_MS = [100, 300, 700, 1_200, 2_000, 3_200, 4_600];
  const DEBUG_LOG_LIMIT = 80;

  let lastUrl = location.href;
  let saveTimer = 0;
  let restoreToken = 0;
  let restoring = false;
  let suppressScrollSaveUntil = 0;
  let preferredAnchor = null;
  let photoIntentAt = 0;
  let snapshotProtected = false;
  let trackedDetailRoute = "";
  let trackedDetailMarker = null;
  let trackedDetailTweets = new Set();
  let timelineMarkerBeforeDetail = null;
  let lastDebugSignature = "";

  const debug = {
    version: VERSION,
    state: "idle",
    event: "loaded",
    route: "",
  };

  function publishDebug() {
    if (!document.documentElement) return;
    const payload = {
      version: VERSION,
      state: debug.state,
      event: debug.event,
      route: debug.route,
      restoring,
      snapshotProtected,
      metrics: {
        dpr: devicePixelRatio,
        viewportScale: visualViewport?.scale ?? 1,
        width: innerWidth,
        height: innerHeight,
      },
      details: debug.details || null,
    };
    document.documentElement.dataset.xSafariScrollFixVersion = VERSION;
    document.documentElement.dataset.xSafariScrollFixState = debug.state;
    document.documentElement.dataset.xSafariScrollFixEvent = debug.event;
    document.documentElement.dataset.xSafariScrollFixDpr = String(devicePixelRatio);
    document.documentElement.dataset.xSafariScrollFixDebug = JSON.stringify(payload);

    // dataset 會隨頁面狀態消失；只在內容改變時保存一份短 ring buffer，
    // 下次可直接從 Safari session state 判斷卡在哪個 restore 階段。
    const signature = JSON.stringify(payload);
    if (signature !== lastDebugSignature) {
      lastDebugSignature = signature;
      const log = readJson(`${STORAGE_PREFIX}debug-log`);
      const entries = Array.isArray(log) ? log.slice(-(DEBUG_LOG_LIMIT - 1)) : [];
      entries.push({ at: Date.now(), ...payload });
      writeJson(`${STORAGE_PREFIX}debug-log`, entries);
    }
  }

  history.scrollRestoration = "manual";

  function pageZoomScale() {
    return devicePixelRatio / REFERENCE_DEVICE_PIXEL_RATIO;
  }

  function positionTolerance() {
    const zoomScale = pageZoomScale();
    // 非 100% 縮放時 scrollY 只能整數移動，錨點每格位移 1 / zoomScale CSS px
    // （125% 為 0.8px）。容許一整格加上 DOMRect 量化餘裕，否則會在相鄰兩格間來回校正而抖動。
    if (Math.abs(zoomScale - 1) > METRICS_EPSILON) return 1 / zoomScale + 0.05;
    return Math.max(MIN_POSITION_TOLERANCE_PX, 1 / devicePixelRatio);
  }

  function currentScrollY() {
    return Math.max(0, scrollY);
  }

  function forcePaintPulse() {
    // Safari can update scrollY/DOMRect without repainting X's composited
    // timeline layer after a zoomed programmatic scroll. A one-pixel round trip
    // invalidates that layer while preserving the final document position.
    if (Math.abs(pageZoomScale() - 1) <= METRICS_EPSILON) return false;

    const y = currentScrollY();
    const maxY = Math.max(
      0,
      Number(document.scrollingElement?.scrollHeight || 0) - Number(innerHeight || 0),
    );
    let nudge = 0;
    if (y + PAINT_NUDGE_PX <= maxY) nudge = PAINT_NUDGE_PX;
    else if (y >= PAINT_NUDGE_PX) nudge = -PAINT_NUDGE_PX;

    if (nudge) scrollTo(0, y + nudge);
    scrollTo(0, y);
    void document.documentElement?.offsetHeight;
    void document.body?.offsetHeight;
    return true;
  }

  function applyAnchorCorrection(error) {
    const zoomScale = pageZoomScale();
    // 縮放時捲動與 DOMRect 是 1:1，只是位置會吸附到 1 / zoomScale 的格點。多要半格，
    // 讓 Safari 的量化落在最近的格點；乘上 zoomScale 會在大位移時多捲 15–25% 而來回振盪。
    const correction =
      Math.abs(zoomScale - 1) > METRICS_EPSILON
        ? error + Math.sign(error) / (2 * zoomScale)
        : error;
    const beforeY = currentScrollY();
    scrollBy(0, correction);
    let afterY = currentScrollY();
    let fallback = false;

    // Safari can quantize a small scrollBy step to zero at non-100% zoom.
    // First request the exact target with scrollTo; if that target is also
    // quantized away, move one layout pixel farther to select the next bucket.
    if (
      Math.abs(afterY - beforeY) <= METRICS_EPSILON &&
      Math.abs(correction) > METRICS_EPSILON
    ) {
      fallback = true;
      scrollTo(0, beforeY + correction);
      afterY = currentScrollY();
      if (Math.abs(afterY - beforeY) <= METRICS_EPSILON) {
        scrollTo(0, beforeY + correction + Math.sign(correction));
        afterY = currentScrollY();
      }
    }

    return { zoomScale, correction, beforeY, afterY, fallback };
  }

  function hasQuantizedResidual(history) {
    if (!Array.isArray(history) || history.length < QUANTIZED_HISTORY_FRAMES) {
      return false;
    }

    const recent = history.slice(-QUANTIZED_HISTORY_FRAMES);
    if (
      recent.some(
        (entry) =>
          !Number.isFinite(entry?.error) ||
          !Number.isFinite(entry?.top) ||
          !Number.isFinite(entry?.y) ||
          Math.abs(entry.error) > MAX_STALLED_ERROR_PX,
      )
    ) {
      return false;
    }

    const ys = recent.map((entry) => entry.y);
    const tops = recent.map((entry) => entry.top);
    const ySpan = Math.max(...ys) - Math.min(...ys);
    const topSpan = Math.max(...tops) - Math.min(...tops);
    return ySpan <= QUANTIZED_POSITION_SPAN_PX && topSpan <= QUANTIZED_POSITION_SPAN_PX;
  }

  function toUrl(value = location.href) {
    return new URL(value, location.href);
  }

  function routeKey(value = location.href) {
    const url = toUrl(value);
    // X 偶爾會替首頁附加暫時性 query；它們不應建立另一份捲動快照。
    return url.pathname === "/home" ? "/home" : `${url.pathname}${url.search}`;
  }

  function isHomeRoute(value = location.href) {
    return toUrl(value).pathname === "/home";
  }

  function isTweetDetail(value = location.href) {
    return /\/status\/\d+(?:\/|$)/.test(toUrl(value).pathname);
  }

  function isPhotoDetail(value = location.href) {
    return /\/status\/\d+\/photo\/\d+(?:\/|$)/.test(toUrl(value).pathname);
  }

  function tweetIdFromHref(href) {
    return toUrl(href).pathname.match(/\/status\/(\d+)(?:\/|$)/)?.[1] ?? null;
  }

  function tweetIdForArticle(article) {
    const timestampLink = article.querySelector("time")?.closest("a[href]");
    const timestampId = timestampLink && tweetIdFromHref(timestampLink.href);
    if (timestampId) return timestampId;

    for (const link of article.querySelectorAll('a[href*="/status/"]')) {
      const id = tweetIdFromHref(link.href);
      if (id) return id;
    }
    return null;
  }

  function anchorForArticle(article) {
    if (!article) return null;
    const id = tweetIdForArticle(article);
    return id ? { id, top: article.getBoundingClientRect().top } : null;
  }

  function isRenderedElement(element) {
    if (!element || element.isConnected === false) return false;
    if (element.closest?.('[aria-hidden="true"], [hidden], [inert]')) return false;
    if (typeof element.getBoundingClientRect !== "function") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function visibleAnchor() {
    let best = null;
    let bestScore = Infinity;

    for (const article of document.querySelectorAll('[data-testid="tweet"]')) {
      const rect = article.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= innerHeight) continue;

      const id = tweetIdForArticle(article);
      if (!id) continue;

      // 選擇最接近視窗上緣、且至少有一部分可見的推文。
      const score = rect.top >= 0 ? rect.top : Math.abs(rect.top) + innerHeight;
      if (score < bestScore) {
        bestScore = score;
        best = { id, top: rect.top };
      }
    }
    return best;
  }

  function articleForTweet(id, excludedArticles = null, targetTop = null) {
    if (!id) return null;
    let best = null;
    let bestScore = Infinity;
    for (const article of document.querySelectorAll('[data-testid="tweet"]')) {
      if (excludedArticles?.has(article)) continue;
      if (!isRenderedElement(article)) continue;
      if (tweetIdForArticle(article) !== id) continue;
      const rect = article.getBoundingClientRect();

      const score = Number.isFinite(targetTop) ? Math.abs(rect.top - targetTop) : 0;
      if (score < bestScore) {
        best = article;
        bestScore = score;
      }
    }
    return best;
  }

  function trackDetailDom(routeValue = location.href) {
    if (!isTweetDetail(routeValue) || isPhotoDetail(routeValue)) return;

    const detailRoute = routeKey(routeValue);
    if (detailRoute !== trackedDetailRoute) {
      trackedDetailRoute = detailRoute;
      trackedDetailMarker = null;
      trackedDetailTweets = new Set();
    }

    const marker = document.querySelector(
      '[data-testid="primaryColumn"] [data-testid="app-bar-back"]',
    );
    if (!marker) return;
    // Profile 等時間線也可能有 app-bar-back。若 React 重用同一個按鈕節點，
    // 至少要等來源時間線的 tabs 消失，才可把它視為 detail shell。
    if (
      marker === timelineMarkerBeforeDetail &&
      document.querySelector('[data-testid="primaryColumn"] [role="tablist"]')
    ) {
      return;
    }

    trackedDetailMarker = marker;
    const detailTweetId = tweetIdFromHref(routeValue);
    for (const article of document.querySelectorAll(
      '[data-testid="primaryColumn"] [data-testid="tweet"]',
    )) {
      if (!detailTweetId || tweetIdForArticle(article) !== detailTweetId) continue;
      if (!isRenderedElement(article)) continue;
      trackedDetailTweets.add(article);
    }
  }

  function rememberTimelineMarker() {
    if (isTweetDetail()) return;
    timelineMarkerBeforeDetail = document.querySelector(
      '[data-testid="primaryColumn"] [data-testid="app-bar-back"]',
    );
  }

  let detailObserverInstalled = false;
  function installDetailObserver() {
    if (detailObserverInstalled || !document.documentElement || typeof MutationObserver !== "function") {
      return;
    }
    detailObserverInstalled = true;
    const observer = new MutationObserver(() => {
      if (isTweetDetail()) trackDetailDom();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function readJson(key) {
    try {
      const value = sessionStorage.getItem(key);
      return value ? JSON.parse(value) : null;
    } catch (_) {
      return null;
    }
  }

  function writeJson(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function snapshotKey(key) {
    return `${STORAGE_PREFIX}${key}`;
  }

  function saveSnapshot(article = null) {
    if (snapshotProtected || restoring || isTweetDetail() || !document.body) return;

    const key = routeKey();

    const clickedAnchor = anchorForArticle(article);
    if (clickedAnchor) preferredAnchor = { ...clickedAnchor, expiresAt: Date.now() + 1_000 };

    const anchor =
      (preferredAnchor?.expiresAt >= Date.now() && preferredAnchor) || visibleAnchor();
    const snapshot = {
      // scrollY 與 DOMRect 都是 CSS pixel；保留小數，避免 125% 等比例的量化誤差。
      y: currentScrollY(),
      anchorId: anchor?.id || null,
      anchorTop: Number.isFinite(anchor?.top) ? anchor.top : null,
      dpr: devicePixelRatio,
      savedAt: Date.now(),
    };

    if (writeJson(snapshotKey(key), snapshot)) {
      debug.route = key;
      debug.event = "snapshot-saved";
      debug.details = {
        y: snapshot.y,
        anchorId: snapshot.anchorId,
        anchorTop: snapshot.anchorTop,
      };
      publishDebug();
    }
  }

  function scheduleSave() {
    if (
      snapshotProtected ||
      restoring ||
      isTweetDetail() ||
      Date.now() < suppressScrollSaveUntil
    ) {
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => saveSnapshot(), SAVE_DEBOUNCE_MS);
  }

  function loadSnapshot(key) {
    const snapshot = readJson(snapshotKey(key));
    if (
      !snapshot ||
      !Number.isFinite(snapshot.y) ||
      !Number.isFinite(snapshot.savedAt) ||
      Date.now() - snapshot.savedAt > MAX_SNAPSHOT_AGE_MS
    ) {
      return null;
    }
    return snapshot;
  }

  function timelineReadiness(
    key,
    candidateArticle,
    detailMarker,
    detailArticles,
    targetShellReady,
  ) {
    if (!document.body) return { ready: false, reason: "document-body-missing" };
    // 只追蹤「先前 status 畫面」的返回按鈕，而不是任意 app-bar-back；
    // Profile 等正常時間線本來就可能有自己的返回按鈕。
    let staleDetailArticleMounted = false;
    for (const article of detailArticles || []) {
      if (article.isConnected) {
        staleDetailArticleMounted = true;
        break;
      }
    }
    const staleDetailMarkerMounted = Boolean(detailMarker?.isConnected);

    // X 目前的 Home link 沒有 aria-current。Home 的可靠語言無關訊號是
    // primaryColumn 內的 For you / Following tablist；它出現後即允許 raw scroll。
    if (isHomeRoute(key)) {
      if (targetShellReady) return { ready: true, reason: "home-tablist-ready" };
      return {
        ready: false,
        reason: staleDetailMarkerMounted || staleDetailArticleMounted
          ? "stale-detail-mounted"
          : "home-tablist-missing",
      };
    }

    if (targetShellReady || candidateArticle) {
      return { ready: true, reason: targetShellReady ? "timeline-tablist-ready" : "anchor-ready" };
    }
    if (staleDetailMarkerMounted || staleDetailArticleMounted) {
      return { ready: false, reason: "stale-detail-mounted" };
    }
    return { ready: true, reason: "route-ready" };
  }

  function restoreSnapshot(key, returningFromDetail = false) {
    const snapshot = loadSnapshot(key);
    if (!snapshot) return;

    const token = ++restoreToken;
    const startedAt = Date.now();
    const staleDetailMarker = returningFromDetail ? trackedDetailMarker : null;
    const staleDetailTweets = returningFromDetail ? trackedDetailTweets : null;
    let rawScrollAttempts = 0;
    let stableFrames = 0;
    let corrections = 0;
    let stalledCorrectionFrames = 0;
    let lastCorrection = null;
    let paintPulseIssued = false;
    let postGuardUntil = 0;
    let postGuardFinishEvent = "restore-finished";
    let postGuardCorrections = 0;
    let postGuardStalledFrames = 0;
    let postGuardLastCorrection = null;
    const correctionHistory = [];
    const postGuardHistory = [];

    restoring = true;
    snapshotProtected = true;
    clearTimeout(saveTimer);
    debug.state = "restoring";
    debug.route = key;
    debug.event = "restore-started";
    debug.details = {
      y: snapshot.y,
      anchorId: snapshot.anchorId,
      anchorTop: snapshot.anchorTop,
      targetTop: snapshot.anchorTop,
    };
    publishDebug();

    function valid() {
      return token === restoreToken && routeKey() === key && !isTweetDetail();
    }

    function finalize(success, event) {
      if (token !== restoreToken) return;
      restoring = false;
      // A failed restore must keep the last known-good snapshot protected from
      // Safari's follow-up scroll/pagehide events. A successful restore only
      // needs the normal short save suppression window.
      snapshotProtected = !success;
      suppressScrollSaveUntil = success
        ? Date.now() + POST_RESTORE_SAVE_SUPPRESS_MS
        : Date.now();
      debug.state = success ? "restored" : "idle";
      debug.event = event;
      debug.details = {
        ...debug.details,
        success,
        rawScrollAttempts,
        corrections,
        postGuardCorrections,
        y: currentScrollY(),
        anchorId: snapshot.anchorId,
      };
      publishDebug();
    }

    function postGuardFrame() {
      if (token !== restoreToken) return;
      if (!valid()) {
        finalize(false, "restore-cancelled");
        return;
      }

      const elapsed = Date.now() - startedAt;
      // The post-restore guard is also used when the main loop settled a
      // quantized residual at its timeout. Its own deadline, rather than the
      // main restore deadline, controls when the late-layout watch ends.
      if (Date.now() >= postGuardUntil) {
        finalize(true, postGuardFinishEvent);
        return;
      }

      const targetShellReady = isRenderedElement(
        document.querySelector('[data-testid="primaryColumn"] [role="tablist"]'),
      );
      const excludedArticles = targetShellReady ? null : staleDetailTweets;
      const article = articleForTweet(snapshot.anchorId, excludedArticles, snapshot.anchorTop);

      if (!article) {
        requestAnimationFrame(postGuardFrame);
        return;
      }

      if (Number.isFinite(snapshot.anchorTop)) {
        const currentTop = article.getBoundingClientRect().top;
        const targetTop = Number(snapshot.anchorTop);
        const error = currentTop - targetTop;
        const tolerance = positionTolerance();
        postGuardHistory.push({ top: currentTop, error, y: currentScrollY() });
        if (postGuardHistory.length > QUANTIZED_HISTORY_FRAMES) postGuardHistory.shift();
        const quantizedResidual = hasQuantizedResidual(postGuardHistory);

        if (quantizedResidual) {
          postGuardStalledFrames += 1;
          postGuardLastCorrection = null;
          if (debug.event !== "anchor-post-guard-quantized-stable") {
            debug.event = "anchor-post-guard-quantized-stable";
            debug.details = {
              currentTop,
              targetTop,
              error,
              tolerance,
              y: currentScrollY(),
              postGuardCorrections,
              postGuardStalledFrames,
              zoomScale: pageZoomScale(),
            };
            publishDebug();
          }
        } else if (Number.isFinite(error) && Math.abs(error) > tolerance) {
          const previous = postGuardLastCorrection;
          const sameArticle = previous?.article === article;
          const errorImprovement = sameArticle
            ? Math.abs(previous.error) - Math.abs(error)
            : Infinity;
          const topMovement = sameArticle ? Math.abs(currentTop - previous.currentTop) : Infinity;
          const yMovement = sameArticle ? Math.abs(currentScrollY() - previous.y) : Infinity;

          if (
            sameArticle &&
            errorImprovement <= POSITION_PROGRESS_EPSILON_PX &&
            topMovement <= POSITION_PROGRESS_EPSILON_PX &&
            yMovement <= POSITION_PROGRESS_EPSILON_PX
          ) {
            postGuardStalledFrames += 1;
          } else {
            postGuardStalledFrames = 0;
          }

          if (
            postGuardStalledFrames >= STALLED_CORRECTION_FRAMES &&
            Math.abs(error) <= MAX_STALLED_ERROR_PX
          ) {
            if (debug.event !== "anchor-post-guard-quantized-stable") {
              debug.event = "anchor-post-guard-quantized-stable";
              debug.details = {
                currentTop,
                targetTop,
                error,
                tolerance,
                y: currentScrollY(),
                postGuardCorrections,
                postGuardStalledFrames,
                zoomScale: pageZoomScale(),
              };
              publishDebug();
            }
          } else {
            const correctionResult = applyAnchorCorrection(error);
            postGuardCorrections += 1;
            postGuardLastCorrection = {
              article,
              currentTop,
              error,
              y: correctionResult.afterY,
              correction: correctionResult.correction,
            };
            debug.event = "anchor-corrected-post-guard";
            debug.details = {
              currentTop,
              targetTop,
              error,
              correction: correctionResult.correction,
              tolerance,
              y: correctionResult.afterY,
              postGuardCorrections,
              zoomScale: correctionResult.zoomScale,
              fallback: correctionResult.fallback,
            };
            publishDebug();
          }
        } else {
          postGuardStalledFrames = 0;
          postGuardLastCorrection = null;
        }
      }

      requestAnimationFrame(postGuardFrame);
    }

    function finish(success, event = success ? "restore-finished" : "restore-cancelled") {
      if (token !== restoreToken) return;
      if (!success) {
        finalize(false, event);
        return;
      }

      postGuardUntil = Date.now() + POST_RESTORE_GUARD_MS;
      postGuardFinishEvent = event;
      const paintPulse = forcePaintPulse();
      debug.event = "restore-post-layout-guard";
      debug.details = {
        ...debug.details,
        postGuardUntil,
        paintPulse,
      };
      publishDebug();
      requestAnimationFrame(postGuardFrame);
    }

    function retryRawPosition(elapsed, reason) {
      const retryAt = RAW_SCROLL_RETRY_MS[rawScrollAttempts];
      if (typeof retryAt !== "number" || elapsed < retryAt) return false;

      rawScrollAttempts += 1;
      const attempt = rawScrollAttempts;
      const beforeY = currentScrollY();
      const scrollHeight = document.scrollingElement?.scrollHeight || 0;
      scrollTo(0, snapshot.y);
      debug.event = "raw-position-retried";
      debug.details = {
        reason,
        attempt,
        requestedY: snapshot.y,
        beforeY,
        actualY: currentScrollY(),
        maxY: Math.max(0, scrollHeight - innerHeight),
        scrollHeight,
      };
      publishDebug();
      requestAnimationFrame(() => {
        if (token !== restoreToken) return;
        debug.event = "raw-position-next-frame";
        debug.details = {
          reason,
          attempt,
          requestedY: snapshot.y,
          nextFrameY: currentScrollY(),
          scrollHeight: document.scrollingElement?.scrollHeight || 0,
        };
        publishDebug();
      });
      return true;
    }

    function frame() {
      if (!valid()) {
        finish(false);
        return;
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed >= RESTORE_TIMEOUT_MS) {
        const timeoutShellReady = isRenderedElement(
          document.querySelector('[data-testid="primaryColumn"] [role="tablist"]'),
        );
        const timeoutArticle = articleForTweet(
          snapshot.anchorId,
          timeoutShellReady ? null : staleDetailTweets,
          snapshot.anchorTop,
        );
        const timeoutTop = timeoutArticle?.getBoundingClientRect?.().top;
        const timeoutError = Number.isFinite(timeoutTop) && Number.isFinite(snapshot.anchorTop)
          ? timeoutTop - Number(snapshot.anchorTop)
          : null;
        debug.details = {
          rawScrollAttempts,
          corrections,
          y: currentScrollY(),
          anchorId: snapshot.anchorId,
          anchorFound: Boolean(timeoutArticle),
          timeoutTop: Number.isFinite(timeoutTop) ? timeoutTop : null,
          timeoutError,
        };
        if (Number.isFinite(timeoutError) && Math.abs(timeoutError) <= MAX_STALLED_ERROR_PX) {
          finish(true, "restore-finished-quantized");
        } else {
          finish(false, "restore-timeout");
        }
        return;
      }

      if (elapsed < RESTORE_SETTLE_MS) {
        stableFrames = 0;
        requestAnimationFrame(frame);
        return;
      }

      const targetShellReady = isRenderedElement(
        document.querySelector('[data-testid="primaryColumn"] [role="tablist"]'),
      );
      // target shell 掛載後 React 可能把同一 article node 從 detail 重用回 timeline；
      // 此時改用當下的可見性與目標 top 選候選，不能永久依 DOM identity 排除。
      const excludedArticles = targetShellReady ? null : staleDetailTweets;
      const article = articleForTweet(snapshot.anchorId, excludedArticles, snapshot.anchorTop);
      const readiness = timelineReadiness(
        key,
        article,
        staleDetailMarker,
        staleDetailTweets,
        targetShellReady,
      );
      if (!readiness.ready) {
        stableFrames = 0;
        stalledCorrectionFrames = 0;
        lastCorrection = null;
        if (debug.event !== "waiting-for-timeline" || debug.details?.reason !== readiness.reason) {
          debug.event = "waiting-for-timeline";
          debug.details = {
            reason: readiness.reason,
            elapsed,
            anchorId: snapshot.anchorId,
          };
          publishDebug();
        }
        // readiness 只保護 anchor 校正；raw scroll 必須照退避執行，避免任何
        // X selector 變動再次造成整段還原 0 次動作。
        retryRawPosition(elapsed, readiness.reason);
        requestAnimationFrame(frame);
        return;
      }

      if (!article) {
        stableFrames = 0;
        stalledCorrectionFrames = 0;
        lastCorrection = null;
        // 第一次嘗試時虛擬列表可能還沒有足夠高度，因此採有限次退避重試。
        retryRawPosition(elapsed, "anchor-missing");
        requestAnimationFrame(frame);
        return;
      }
      // 錨點出現過後，快照的 scrollY 已經過時；之後再 raw scroll 只會和 X 的重新排版互相拉扯。
      rawScrollAttempts = RAW_SCROLL_RETRY_MS.length;

      if (!paintPulseIssued && Math.abs(pageZoomScale() - 1) > METRICS_EPSILON) {
        paintPulseIssued = true;
        const paintPulse = forcePaintPulse();
        debug.event = "restore-paint-pulse";
        debug.details = {
          anchorId: snapshot.anchorId,
          y: currentScrollY(),
          paintPulse,
        };
        publishDebug();
      }

      if (Number.isFinite(snapshot.anchorTop)) {
        const currentTop = article.getBoundingClientRect().top;
        const targetTop = Number(snapshot.anchorTop);
        const error = currentTop - targetTop;
        const tolerance = positionTolerance();
        correctionHistory.push({ top: currentTop, error, y: currentScrollY() });
        if (correctionHistory.length > QUANTIZED_HISTORY_FRAMES) correctionHistory.shift();
        const quantizedResidual = hasQuantizedResidual(correctionHistory);

        if (quantizedResidual) {
          stableFrames += 1;
          stalledCorrectionFrames = STALLED_CORRECTION_FRAMES;
          lastCorrection = null;
          debug.event = "anchor-quantized-oscillation";
          debug.details = {
            currentTop,
            targetTop,
            error,
            tolerance,
            y: currentScrollY(),
            corrections,
            stalledCorrectionFrames,
            zoomScale: pageZoomScale(),
          };
          publishDebug();
        } else if (Number.isFinite(targetTop) && Number.isFinite(error) && Math.abs(error) > tolerance) {
          const currentY = currentScrollY();
          const previous = lastCorrection;
          const sameArticle = previous?.article === article;
          const errorImprovement = sameArticle ? Math.abs(previous.error) - Math.abs(error) : Infinity;
          const topMovement = sameArticle ? Math.abs(currentTop - previous.currentTop) : Infinity;
          const yMovement = sameArticle ? Math.abs(currentY - previous.y) : Infinity;

          if (
            sameArticle &&
            errorImprovement <= POSITION_PROGRESS_EPSILON_PX &&
            topMovement <= POSITION_PROGRESS_EPSILON_PX &&
            yMovement <= POSITION_PROGRESS_EPSILON_PX
          ) {
            stalledCorrectionFrames += 1;
          } else {
            stalledCorrectionFrames = 0;
          }

          // At non-100% zoom Safari can quantize the final scroll step. Do not
          // keep issuing a fractional correction forever once both the anchor
          // and document position have stopped moving within a small residual.
          if (
            stalledCorrectionFrames >= STALLED_CORRECTION_FRAMES &&
            Math.abs(error) <= MAX_STALLED_ERROR_PX
          ) {
            stableFrames += 1;
            debug.event = "anchor-quantized-stable";
            debug.details = {
              currentTop,
              targetTop,
              error,
              tolerance,
              y: currentY,
              corrections,
              stalledCorrectionFrames,
              zoomScale: pageZoomScale(),
            };
            publishDebug();
          } else {
            // applyAnchorCorrection rounds to Safari's zoomed scroll grid and
            // falls back to a direct scrollTo when the delta quantizes to zero.
            const correctionResult = applyAnchorCorrection(error);
            corrections += 1;
            stableFrames = 0;
            lastCorrection = {
              article,
              currentTop,
              error,
              y: correctionResult.afterY,
              correction: correctionResult.correction,
            };
            debug.event = "anchor-corrected";
            debug.details = {
              currentTop,
              targetTop,
              error,
              correction: correctionResult.correction,
              tolerance,
              y: correctionResult.afterY,
              corrections,
              zoomScale: correctionResult.zoomScale,
              fallback: correctionResult.fallback,
            };
            publishDebug();
          }
        } else {
          stableFrames += 1;
          stalledCorrectionFrames = 0;
          lastCorrection = null;
        }
      } else {
        stableFrames += 1;
        stalledCorrectionFrames = 0;
        lastCorrection = null;
      }

      if (elapsed >= MIN_GUARD_MS && stableFrames >= 12) {
        finish(
          true,
          corrections ? "restore-finished-corrected" : "restore-finished-native",
        );
        return;
      }
      requestAnimationFrame(frame);
    }

    requestAnimationFrame(() => requestAnimationFrame(frame));
  }

  function cancelRestore(reason = "cancelled") {
    const wasRestoring = restoring;
    restoreToken += 1;
    restoring = false;
    clearTimeout(saveTimer);
    debug.state = "idle";
    // User-driven scrolling starts a new position and may save it normally;
    // a non-primary pointer is not a scroll intent and must preserve the good
    // snapshot for the next navigation.
    snapshotProtected = reason === "non-primary-pointer";
    if (wasRestoring) {
      debug.event = `restore-cancelled-${reason}`;
      debug.details = { reason, y: currentScrollY() };
      publishDebug();
    }
  }

  function handleLocationChange(reason) {
    const newUrl = location.href;
    if (newUrl === lastUrl) return;

    const oldUrl = lastUrl;
    lastUrl = newUrl;
    const oldKey = routeKey(oldUrl);
    const newKey = routeKey(newUrl);
    debug.route = newKey;
    debug.event = `navigation-${reason}`;
    publishDebug();

    // 圖片頁沿用 X/Safari 原生流程；本腳本完全不保存或還原。
    if (isPhotoDetail(newUrl)) {
      photoIntentAt = Date.now();
      cancelRestore("photo-opened");
      history.scrollRestoration = "auto";
      return;
    }

    if (isPhotoDetail(oldUrl) || (photoIntentAt && Date.now() - photoIntentAt < PHOTO_BYPASS_MS)) {
      photoIntentAt = 0;
      cancelRestore("photo-closed");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => (history.scrollRestoration = "manual")),
      );
      return;
    }

    if (isTweetDetail(newUrl)) {
      cancelRestore("left-timeline");
      return;
    }

    const returningFromDetail = isTweetDetail(oldUrl);
    const returningHome = isHomeRoute(newUrl) && oldKey !== newKey;
    if (returningFromDetail || returningHome || reason === "popstate") {
      restoreSnapshot(newKey, returningFromDetail);
    }
  }

  addEventListener(
    "pointerdown",
    (event) => {
      rememberTimelineMarker();
      if (event.button !== 0) {
        // 右鍵或中鍵不代表使用者接受目前的程式性位置，保留正確快照。
        cancelRestore("non-primary-pointer");
        return;
      }

      // 使用者可能在兩秒 guard 期間立刻點入另一篇；先結束舊還原，
      // 才能同步保存這次真正要離開的位置與新錨點。
      cancelRestore("pointerdown");
      snapshotProtected = false;

      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest("a[href]");
      if (link && isPhotoDetail(link.href)) {
        photoIntentAt = Date.now();
        preferredAnchor = null;
        snapshotProtected = true;
        history.scrollRestoration = "auto";
        return;
      }

      saveSnapshot(target?.closest('[data-testid="tweet"]') || null);
    },
    true,
  );

  addEventListener("scroll", scheduleSave, { passive: true, capture: true });
  installDetailObserver();
  addEventListener("DOMContentLoaded", installDetailObserver, true);
  addEventListener("pagehide", () => saveSnapshot(), true);
  addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") saveSnapshot();
    },
    true,
  );

  addEventListener(
    "wheel",
    (event) => {
      // Safari 的觸控板返回手勢也是 wheel，但以水平 deltaX 為主，不能取消還原。
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      snapshotProtected = false;
      cancelRestore("wheel");
    },
    { passive: true, capture: true },
  );

  addEventListener(
    "touchstart",
    () => {
      snapshotProtected = false;
      cancelRestore("touchstart");
    },
    { passive: true, capture: true },
  );

  addEventListener(
    "keydown",
    (event) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        snapshotProtected = false;
        cancelRestore("keyboard");
      }
    },
    true,
  );

  addEventListener(
    "popstate",
    () => queueMicrotask(() => handleLocationChange("popstate")),
    true,
  );
  addEventListener(
    "pageshow",
    (event) => {
      if (event.persisted && !isTweetDetail() && !isPhotoDetail()) restoreSnapshot(routeKey());
    },
    true,
  );

  // Navigation API 可用時縮短 SPA 路由偵測延遲；輪詢仍作為 Safari/X 相容後備。
  window.navigation?.addEventListener("currententrychange", () =>
    queueMicrotask(() => handleLocationChange("navigation")),
  );

  window.setInterval(() => {
    trackDetailDom();
    rememberTimelineMarker();
    publishDebug();
    handleLocationChange("poll");

    // 圖片若在輪詢前已快速關閉，避免原生模式旗標殘留。
    if (photoIntentAt && !isPhotoDetail() && Date.now() - photoIntentAt >= PHOTO_BYPASS_MS) {
      photoIntentAt = 0;
      history.scrollRestoration = "manual";
    }
  }, 250);

  debug.route = routeKey();
  publishDebug();
})();
