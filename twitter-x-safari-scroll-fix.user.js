// ==UserScript==
// @name         X (Twitter) Safari 時間線位置修復
// @name:en         X (Twitter) Safari timeline position fix
// @namespace    https://github.com/TW527E/Twitter-X-Safari-Scrolling-Fix
// @version      2.0.0
// @description  修復 Safari 在 100% 頁面縮放下，從推文或其他頁面返回 X 時間線後的位置跳動。
// @description:en  Fixed an issue where Safari would jump to the next position on the X timeline after returning from a tweet or other page at 100% page zoom.
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

  const VERSION = "2.0.0";
  const STORAGE_PREFIX = "x-safari-scroll-fix:v2:";
  const MAX_SNAPSHOT_AGE_MS = 6 * 60 * 60 * 1000;
  const SAVE_DEBOUNCE_MS = 100;
  const RESTORE_TIMEOUT_MS = 3_000;
  const MIN_GUARD_MS = 2_000;
  const POSITION_TOLERANCE_PX = 1;
  const PHOTO_BYPASS_MS = 1_500;
  // 此版本只服務目前這台 Retina Mac 的 Safari 100%（實測 DPR = 2）。
  // 125% 時 DPR = 2.5，會完全停用而不再嘗試換算或校正。
  const EXPECTED_100_PERCENT_DPR = 2;

  let lastUrl = location.href;
  let saveTimer = 0;
  let restoreToken = 0;
  let restoring = false;
  let suppressScrollSaveUntil = 0;
  let lastUserIntentAt = 0;
  let preferredAnchor = null;
  let photoIntentAt = 0;
  let zoomSupported = Math.abs(devicePixelRatio - EXPECTED_100_PERCENT_DPR) < 0.01;

  const debug = {
    version: VERSION,
    state: "idle",
    event: "loaded",
    route: "",
  };

  function publishDebug() {
    if (!document.documentElement) return;
    document.documentElement.dataset.xSafariScrollFixVersion = VERSION;
    document.documentElement.dataset.xSafariScrollFixState = debug.state;
    document.documentElement.dataset.xSafariScrollFixEvent = debug.event;
  }

  function setNativeRestoration(value) {
    try {
      history.scrollRestoration = value;
    } catch (_) {
      // Safari 舊版本不支援時，錨點還原仍可獨立運作。
    }
  }
  setNativeRestoration(zoomSupported ? "manual" : "auto");

  function refreshZoomMode() {
    const supported = Math.abs(devicePixelRatio - EXPECTED_100_PERCENT_DPR) < 0.01;
    if (supported === zoomSupported) return;

    zoomSupported = supported;
    restoreToken += 1;
    restoring = false;
    clearTimeout(saveTimer);
    lastUrl = location.href;
    debug.state = supported ? "idle" : "unsupported-zoom";
    debug.event = supported ? "zoom-100-enabled" : "non-100-disabled";
    setNativeRestoration(supported ? "manual" : "auto");
    publishDebug();
  }

  function toUrl(value = location.href) {
    try {
      return new URL(value, location.href);
    } catch (_) {
      return null;
    }
  }

  function routeKey(value = location.href) {
    const url = toUrl(value);
    return url ? `${url.pathname}${url.search}` : "";
  }

  function isTweetDetail(value = location.href) {
    const url = toUrl(value);
    return Boolean(url && /\/status\/\d+(?:\/|$)/.test(url.pathname));
  }

  function isPhotoDetail(value = location.href) {
    const url = toUrl(value);
    return Boolean(url && /\/status\/\d+\/photo\/\d+(?:\/|$)/.test(url.pathname));
  }

  function tweetIdFromHref(href) {
    const url = toUrl(href);
    const match = url && url.pathname.match(/\/status\/(\d+)(?:\/|$)/);
    return match ? match[1] : null;
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
    if (!(article instanceof Element) || !article.matches('[data-testid="tweet"]')) return null;
    const id = tweetIdForArticle(article);
    return id ? { id, top: article.getBoundingClientRect().top } : null;
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

  function articleForTweet(id) {
    if (!id) return null;
    for (const article of document.querySelectorAll('[data-testid="tweet"]')) {
      if (tweetIdForArticle(article) === id) return article;
    }
    return null;
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
    if (!zoomSupported || restoring || isTweetDetail() || !document.body) return;

    const key = routeKey();
    if (!key) return;

    const clickedAnchor = anchorForArticle(article);
    if (clickedAnchor) preferredAnchor = { ...clickedAnchor, expiresAt: Date.now() + 1_000 };

    const recentClicked =
      preferredAnchor && preferredAnchor.expiresAt >= Date.now() ? preferredAnchor : null;
    const anchor = clickedAnchor || recentClicked || visibleAnchor();
    const snapshot = {
      y: Math.max(0, Math.round(scrollY || pageYOffset || 0)),
      anchorId: anchor?.id || null,
      anchorTop: typeof anchor?.top === "number" ? anchor.top : null,
      savedAt: Date.now(),
    };

    if (writeJson(snapshotKey(key), snapshot)) {
      debug.route = key;
      debug.event = "snapshot-saved";
      publishDebug();
    }
  }

  function scheduleSave() {
    if (!zoomSupported || restoring || isTweetDetail() || Date.now() < suppressScrollSaveUntil) {
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => saveSnapshot(), SAVE_DEBOUNCE_MS);
  }

  function loadSnapshot(key) {
    const snapshot = readJson(snapshotKey(key));
    if (
      !snapshot ||
      typeof snapshot.y !== "number" ||
      typeof snapshot.savedAt !== "number" ||
      Date.now() - snapshot.savedAt > MAX_SNAPSHOT_AGE_MS
    ) {
      return null;
    }
    return snapshot;
  }

  function timelineReady(key) {
    if (!document.body) return false;
    if (key === "/home") {
      return Boolean(document.querySelector('[aria-label*="Home Timeline"]'));
    }
    return (
      !document.querySelector('[aria-label*="Conversation"]') &&
      Boolean(document.querySelector('[data-testid="tweet"]'))
    );
  }

  function restoreSnapshot(key) {
    if (!zoomSupported) return;
    const snapshot = loadSnapshot(key);
    if (!snapshot || snapshot.y < 1) return;

    const token = ++restoreToken;
    const startedAt = Date.now();
    const userIntentAtStart = lastUserIntentAt;
    let rawScrollTried = false;
    let stableFrames = 0;
    let corrections = 0;

    restoring = true;
    clearTimeout(saveTimer);
    debug.state = "restoring";
    debug.route = key;
    debug.event = "restore-started";
    publishDebug();

    // 保留點進推文前的原始資料，絕不以還原後的暫時狀態覆寫。
    writeJson(`${STORAGE_PREFIX}last-restore`, { key, snapshot, startedAt });

    function valid() {
      return (
        token === restoreToken &&
        routeKey() === key &&
        !isTweetDetail() &&
        lastUserIntentAt === userIntentAtStart
      );
    }

    function finish(success) {
      if (token !== restoreToken) return;
      restoring = false;
      suppressScrollSaveUntil = Date.now() + 1_000;
      debug.state = success ? "restored" : "idle";
      debug.event = success ? "restore-finished" : "restore-cancelled";
      publishDebug();
    }

    function frame() {
      if (!valid()) {
        finish(false);
        return;
      }

      const elapsed = Date.now() - startedAt;
      if (elapsed >= RESTORE_TIMEOUT_MS) {
        finish(false);
        return;
      }

      if (!timelineReady(key)) {
        requestAnimationFrame(frame);
        return;
      }

      const article = articleForTweet(snapshot.anchorId);
      if (!article) {
        // 100% 下只需一次原始位置喚醒 X 的虛擬列表；不做比例換算、探測跳轉
        // 或上下搜尋，避免非必要的畫面抖動。
        if (!rawScrollTried && elapsed >= 100) {
          rawScrollTried = true;
          scrollTo(0, snapshot.y);
          debug.event = "raw-position-restored";
          publishDebug();
        }
        requestAnimationFrame(frame);
        return;
      }

      if (typeof snapshot.anchorTop === "number") {
        const error = article.getBoundingClientRect().top - snapshot.anchorTop;
        const integerCorrection = Math.round(error);

        if (Math.abs(error) > POSITION_TOLERANCE_PX && integerCorrection !== 0) {
          // 在繪製前校正整數 CSS pixel。100% 下不需任何 zoom 比例換算。
          scrollBy(0, integerCorrection);
          corrections += 1;
          stableFrames = 0;
          debug.event = "anchor-corrected";
          publishDebug();
        } else {
          stableFrames += 1;
        }
      } else {
        stableFrames += 1;
      }

      if (elapsed >= MIN_GUARD_MS && stableFrames >= 12) {
        debug.event = corrections ? "restore-finished-corrected" : "restore-finished-native";
        finish(true);
        return;
      }
      requestAnimationFrame(frame);
    }

    requestAnimationFrame(() => requestAnimationFrame(frame));
  }

  function cancelRestore() {
    restoreToken += 1;
    restoring = false;
    clearTimeout(saveTimer);
    debug.state = "idle";
  }

  function handleLocationChange(reason) {
    const newUrl = location.href;
    if (newUrl === lastUrl) return;

    const oldUrl = lastUrl;
    lastUrl = newUrl;
    if (!zoomSupported) return;
    const oldKey = routeKey(oldUrl);
    const newKey = routeKey(newUrl);
    debug.route = newKey;
    debug.event = `navigation-${reason}`;
    publishDebug();

    // 圖片頁沿用 X/Safari 原生流程；本腳本完全不保存或還原。
    if (isPhotoDetail(newUrl)) {
      photoIntentAt = Date.now();
      cancelRestore();
      setNativeRestoration("auto");
      return;
    }

    if (isPhotoDetail(oldUrl) || (photoIntentAt && Date.now() - photoIntentAt < PHOTO_BYPASS_MS)) {
      photoIntentAt = 0;
      cancelRestore();
      requestAnimationFrame(() => requestAnimationFrame(() => setNativeRestoration("manual")));
      return;
    }

    if (!newKey || isTweetDetail(newUrl)) {
      cancelRestore();
      return;
    }

    const returningHome = newKey === "/home" && oldKey !== newKey;
    if (isTweetDetail(oldUrl) || returningHome || reason === "popstate") {
      restoreSnapshot(newKey);
    }
  }

  addEventListener(
    "pointerdown",
    (event) => {
      if (!zoomSupported) return;
      lastUserIntentAt = Date.now();
      if (event.button !== 0) return;

      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest("a[href]");
      if (link && isPhotoDetail(link.href)) {
        photoIntentAt = Date.now();
        preferredAnchor = null;
        setNativeRestoration("auto");
        return;
      }

      saveSnapshot(target?.closest('[data-testid="tweet"]') || null);
    },
    true,
  );

  addEventListener("scroll", scheduleSave, { passive: true, capture: true });
  addEventListener("pagehide", () => saveSnapshot(), true);
  addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") saveSnapshot();
    },
    true,
  );

  for (const eventName of ["wheel", "touchstart"]) {
    addEventListener(
      eventName,
      () => {
        if (!zoomSupported) return;
        lastUserIntentAt = Date.now();
        cancelRestore();
      },
      { passive: true, capture: true },
    );
  }

  addEventListener(
    "keydown",
    (event) => {
      if (!zoomSupported) return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        lastUserIntentAt = Date.now();
        cancelRestore();
      }
    },
    true,
  );

  addEventListener("popstate", () => queueMicrotask(() => handleLocationChange("popstate")), true);
  addEventListener(
    "pageshow",
    (event) => {
      if (event.persisted && !isTweetDetail() && !isPhotoDetail()) restoreSnapshot(routeKey());
    },
    true,
  );

  // Navigation API 可用時縮短 SPA 路由偵測延遲；輪詢仍作為 Safari/X 相容後備。
  try {
    window.navigation?.addEventListener("currententrychange", () =>
      queueMicrotask(() => handleLocationChange("navigation")),
    );
  } catch (_) {
    // 不支援 Navigation API。
  }

  window.setInterval(() => {
    refreshZoomMode();
    publishDebug();
    handleLocationChange("poll");

    // 圖片若在輪詢前已快速關閉，避免原生模式旗標殘留。
    if (photoIntentAt && !isPhotoDetail() && Date.now() - photoIntentAt >= PHOTO_BYPASS_MS) {
      photoIntentAt = 0;
      setNativeRestoration("manual");
    }
  }, 250);

  debug.route = routeKey();
  if (!zoomSupported) {
    debug.state = "unsupported-zoom";
    debug.event = "non-100-disabled";
  }
  publishDebug();
})();
