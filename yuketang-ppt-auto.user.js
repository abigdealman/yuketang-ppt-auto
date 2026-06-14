// ==UserScript==
// @name         雨课堂 PPT 自动阅读助手
// @namespace    codex-yuketang-ppt-auto
// @version      0.2.21
// @description  自动按顺序打开雨课堂 PPT，并等待每页从未读变为已读后再继续。
// @match        https://www.yuketang.cn/*
// @exclude      https://www.yuketang.cn/ai-workspace/*
// @updateURL    https://gh-proxy.com/https://raw.githubusercontent.com/abigdealman/yuketang-ppt-auto/main/yuketang-ppt-auto.user.js?v=0.2.21
// @downloadURL  https://gh-proxy.com/https://raw.githubusercontent.com/abigdealman/yuketang-ppt-auto/main/yuketang-ppt-auto.user.js?v=0.2.21
// @run-at       document-idle
// @connect      gh-proxy.com
// @connect      raw.githubusercontent.com
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
  "use strict";

  const STORE_KEY = "codex:yuketang:ppt-auto";
  const UI_STORE_KEY = `${STORE_KEY}:ui`;
  const SCRIPT_VERSION = "0.2.21";
  const UPDATE_URL = "https://gh-proxy.com/https://raw.githubusercontent.com/abigdealman/yuketang-ppt-auto/main/yuketang-ppt-auto.user.js?v=0.2.21";
  const CONFIG = {
    tickMs: 900,
    updateCheckIntervalMs: 5 * 60 * 1000,
    updateSnoozeMs: 10 * 60 * 1000,
    pageConfirmTimeoutMs: 25000,
    pageExtraWaitMs: 10000,
    clickSettleMs: 450,
    confirmPollMs: 250,
    pageGapMs: 250,
    questionGapMs: 650,
    openCoursewareWaitMs: 4500,
    returnWaitMs: 3500,
    readFailRefreshMax: 2,
    readerEmptyRefreshMax: 1,
    returnStuckRefreshMs: 30000,
    returnRetryClickMs: 10000,
    returnRefreshMax: 3,
    unreadReturnPromptContinueMax: 1,
    unreadReturnPromptExitMax: 3,
    listLoadStuckRefreshMs: 30000,
    listLoadRefreshMax: 2,
    studentLogStuckRefreshMs: 30000,
    studentLogRefreshMax: 2,
    refreshDelayMs: 600,
    detailIdleRefreshMs: 30000,
    detailIdleRefreshMax: 2,
    runLockTtlMs: 5000,
  };

  let busy = false;
  let panelStatus;
  let updateCheckBusy = false;
  let detailWaitKey = "";
  let detailWaitCount = 0;
  const INSTANCE_ID = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const skippedUnreadPages = new Set();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (text) => (text || "").replace(/\s+/g, " ").trim();
  const now = () => new Date().toLocaleTimeString();

  function queueTick(delayMs = 0) {
    window.setTimeout(() => void tick(), delayMs);
  }

  function loadUiState() {
    try {
      return JSON.parse(localStorage.getItem(UI_STORE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveUiState(patch) {
    const next = { ...loadUiState(), ...patch };
    localStorage.setItem(UI_STORE_KEY, JSON.stringify(next));
    return next;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveState(patch) {
    const next = { ...loadState(), ...patch };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
      // Keep the cross-frame DOM state below even if sandbox storage is unavailable.
    }
    writeSharedState(patch);
    return next;
  }

  function isRunning() {
    const sharedRunning = readSharedRunning();
    if (sharedRunning === false) return false;
    return loadState().running === true || sharedRunning === true;
  }

  function lockRootElement() {
    try {
      return window.top?.document?.documentElement || document.documentElement;
    } catch {
      return document.documentElement;
    }
  }

  function writeSharedState(patch) {
    const root = lockRootElement();
    if (!root) return;

    if (Object.prototype.hasOwnProperty.call(patch, "status")) {
      root.setAttribute("data-codex-ykt-ppt-auto-status", String(patch.status || ""));
      root.setAttribute("data-codex-ykt-ppt-auto-status-at", String(Date.now()));
      root.setAttribute("data-codex-ykt-ppt-auto-version", SCRIPT_VERSION);
    }

    if (Object.prototype.hasOwnProperty.call(patch, "running")) {
      root.setAttribute("data-codex-ykt-ppt-auto-running", patch.running === true ? "true" : "false");
      root.setAttribute("data-codex-ykt-ppt-auto-running-at", String(Date.now()));
      root.setAttribute("data-codex-ykt-ppt-auto-version", SCRIPT_VERSION);
    }
  }

  function readSharedStatus() {
    return lockRootElement()?.getAttribute("data-codex-ykt-ppt-auto-status") || "";
  }

  function readSharedRunning() {
    const value = lockRootElement()?.getAttribute("data-codex-ykt-ppt-auto-running");
    if (value === "true") return true;
    if (value === "false") return false;
    return null;
  }

  function syncPanelStatus() {
    if (!panelStatus) return;
    const status = readSharedStatus() || loadState().status || "待开始";
    panelStatus.textContent = status;
  }

  function ownsDomRunLock(nowMs) {
    const root = lockRootElement();
    if (!root) return true;

    const raw = root.getAttribute("data-codex-ykt-ppt-auto-run-lock") || "";
    const [owner, expiresAt] = raw.split("|");
    if (owner && owner !== INSTANCE_ID && Number(expiresAt || 0) > nowMs) {
      return false;
    }

    root.setAttribute("data-codex-ykt-ppt-auto-run-lock", `${INSTANCE_ID}|${nowMs + CONFIG.runLockTtlMs}`);
    root.setAttribute("data-codex-ykt-ppt-auto-version", SCRIPT_VERSION);
    return true;
  }

  function ownsRunLock() {
    const state = loadState();
    const lock = state.runLock || {};
    const nowMs = Date.now();
    if (!ownsDomRunLock(nowMs)) return false;

    if (lock.owner && lock.owner !== INSTANCE_ID && Number(lock.expiresAt || 0) > nowMs) {
      return false;
    }

    saveState({
      runLock: {
        owner: INSTANCE_ID,
        expiresAt: nowMs + CONFIG.runLockTtlMs,
      },
    });
    return true;
  }

  function refreshPage(reason) {
    saveState({ lastRefreshAt: Date.now(), lastRefreshReason: reason });
    setStatus(`${reason}，自动刷新页面恢复。`);
    window.setTimeout(() => {
      try {
        if (window.top && window.top !== window) {
          window.top.location.reload();
        } else {
          location.reload();
        }
      } catch {
        location.reload();
      }
    }, CONFIG.refreshDelayMs);
  }

  function requestAutoRefresh(key, reason, maxAttempts) {
    const state = loadState();
    const recovery = { ...(state.refreshRecovery || {}) };
    const entry = recovery[key] || { attempts: 0 };
    if (entry.attempts >= maxAttempts) return false;

    const attempts = entry.attempts + 1;
    recovery[key] = { attempts, lastAt: Date.now(), reason };
    saveState({ refreshRecovery: recovery });
    refreshPage(`${reason}（第 ${attempts}/${maxAttempts} 次）`);
    return true;
  }

  function clearRefreshRecovery(key) {
    const recovery = { ...(loadState().refreshRecovery || {}) };
    if (!(key in recovery)) return;
    delete recovery[key];
    saveState({ refreshRecovery: recovery });
  }

  function activityKey(title) {
    return clean(title).replace(/\s+/g, " ");
  }

  function handledActivities() {
    return new Set((loadState().handledActivities || []).map(activityKey));
  }

  function deferredActivities() {
    return new Set((loadState().deferredActivities || []).map(activityKey));
  }

  function currentActivityIsDeferred() {
    const title = currentActivityTitle();
    return title ? deferredActivities().has(title) : false;
  }

  function currentActivityTitle() {
    const bodyText = textOf(document.body);
    const match = bodyText.match(/返回\s+(.+?)\s+发布时间\s*[:：]/);
    return activityKey(match?.[1] || loadState().lastActivity || "");
  }

  function markActivityHandled(reason, options = {}) {
    const title = currentActivityTitle();
    if (!title) return false;
    const nextHandled = handledActivities();
    nextHandled.add(title);
    const patch = { handledActivities: [...nextHandled], lastHandledReason: reason };
    if (options.defer) {
      const nextDeferred = deferredActivities();
      nextDeferred.add(title);
      patch.deferredActivities = [...nextDeferred];
    }
    saveState(patch);
    setStatus(`${title} 本轮已处理${reason ? `：${reason}` : ""}，返回列表。`);
    return true;
  }

  function setStatus(text) {
    const message = `[${now()}] ${text}`;
    saveState({ status: message });
    if (panelStatus) panelStatus.textContent = message;
    console.log("[YKT PPT Auto]", message);
  }

  function versionParts(version) {
    return String(version || "")
      .split(/[^\d]+/)
      .filter(Boolean)
      .map((part) => Number(part) || 0);
  }

  function compareVersions(left, right) {
    const a = versionParts(left);
    const b = versionParts(right);
    const maxLength = Math.max(a.length, b.length);
    for (let i = 0; i < maxLength; i += 1) {
      const diff = (a[i] || 0) - (b[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  function parseScriptVersion(source) {
    const match = String(source || "").match(/^\s*\/\/\s*@version\s+([^\s]+)/m);
    return match ? match[1].trim() : "";
  }

  function cacheBustedUrl(url) {
    return `${url}${url.includes("?") ? "&" : "?"}_ykt_update=${Date.now()}`;
  }

  function requestText(url) {
    return new Promise((resolve, reject) => {
      const finalUrl = cacheBustedUrl(url);

      const handleResponse = (response) => {
        if (response.status >= 200 && response.status < 300) {
          resolve(response.responseText || response.response || "");
          return;
        }
        reject(new Error(`HTTP ${response.status}`));
      };

      const requestOptions = {
        method: "GET",
        url: finalUrl,
        timeout: 15000,
        onload: handleResponse,
        onerror: () => reject(new Error("网络请求失败")),
        ontimeout: () => reject(new Error("更新检查超时")),
      };

      try {
        if (typeof GM_xmlhttpRequest === "function") {
          GM_xmlhttpRequest(requestOptions);
          return;
        }

        if (typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function") {
          GM.xmlHttpRequest({
            method: "GET",
            url: finalUrl,
            timeout: 15000,
          }).then(handleResponse, () => reject(new Error("网络请求失败")));
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }

      fetch(finalUrl, { cache: "no-store" })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.text();
        })
        .then(resolve, reject);
    });
  }

  function appendFloatingNode(node) {
    (document.documentElement || document.body || document).append(node);
  }

  function openUpdateUrl() {
    const installUrl = cacheBustedUrl(UPDATE_URL);
    try {
      const tab = window.open(installUrl, "_blank");
      if (tab) {
        try {
          tab.opener = null;
        } catch {
          // Cross-origin WindowProxy can reject opener changes in some browsers.
        }
        return;
      }
    } catch {
      // Fall back to same-tab navigation below.
    }
    window.location.href = installUrl;
  }

  function hideUpdateNotice() {
    document.getElementById("codex-ykt-update-notice")?.remove();
  }

  function showUpdateNotice(version, options = {}) {
    if (window.top !== window) return;
    const state = loadState();
    const snoozeUntil = Number(state.updateSnoozeUntil || 0);
    if (
      !options.force &&
      state.availableUpdateVersion === version &&
      snoozeUntil > Date.now()
    ) {
      return;
    }

    hideUpdateNotice();
    const notice = document.createElement("div");
    notice.id = "codex-ykt-update-notice";
    notice.style.cssText = [
      "position:fixed",
      "right:16px",
      "top:16px",
      "z-index:2147483647",
      "width:min(320px,calc(100vw - 32px))",
      "padding:12px",
      "background:#0f172a",
      "color:#f8fafc",
      "font-size:13px",
      "line-height:1.45",
      "border-radius:8px",
      "box-shadow:0 12px 32px rgba(0,0,0,.28)",
      "font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "box-sizing:border-box",
    ].join(";");

    const title = document.createElement("div");
    title.textContent = "脚本有新版";
    title.style.cssText = "font-weight:700;margin-bottom:4px;";

    const body = document.createElement("div");
    body.textContent = `发现 v${version}，当前 v${SCRIPT_VERSION}。`;
    body.style.cssText = "color:#cbd5e1;margin-bottom:10px;";

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;";

    const makeNoticeButton = (label, bg) => {
      const button = document.createElement("button");
      button.textContent = label;
      button.style.cssText = [
        "flex:1",
        "border:0",
        "border-radius:6px",
        "padding:7px 8px",
        "cursor:pointer",
        `background:${bg}`,
        "color:white",
        "font-weight:600",
      ].join(";");
      return button;
    };

    const openButton = makeNoticeButton("打开更新", "#2563eb");
    openButton.addEventListener("click", () => {
      openUpdateUrl();
    });

    const laterButton = makeNoticeButton("稍后", "#475569");
    laterButton.addEventListener("click", () => {
      saveState({ updateSnoozeUntil: Date.now() + CONFIG.updateSnoozeMs });
      hideUpdateNotice();
    });

    actions.append(openButton, laterButton);
    notice.append(title, body, actions);
    appendFloatingNode(notice);
  }

  async function checkForScriptUpdate(options = {}) {
    if (window.top !== window || updateCheckBusy) return;

    const force = options.force === true;
    const state = loadState();
    const lastCheckAt = Number(state.lastUpdateCheckAt || 0);
    if (!force && Date.now() - lastCheckAt < CONFIG.updateCheckIntervalMs) {
      if (
        state.availableUpdateVersion &&
        compareVersions(state.availableUpdateVersion, SCRIPT_VERSION) > 0
      ) {
        showUpdateNotice(state.availableUpdateVersion);
      }
      return;
    }

    updateCheckBusy = true;
    saveState({ lastUpdateCheckAt: Date.now() });

    try {
      const source = await requestText(UPDATE_URL);
      const remoteVersion = parseScriptVersion(source);
      if (!remoteVersion) throw new Error("没有读到远端版本号");

      if (compareVersions(remoteVersion, SCRIPT_VERSION) > 0) {
        const previousAvailableVersion = state.availableUpdateVersion || "";
        saveState({
          availableUpdateVersion: remoteVersion,
          updateSnoozeUntil:
            previousAvailableVersion === remoteVersion ? state.updateSnoozeUntil || 0 : 0,
          lastUpdateCheckError: "",
        });
        showUpdateNotice(remoteVersion, { force });
        if (force) setStatus(`发现新版 v${remoteVersion}，请点更新提示里的“打开更新”。`);
        return;
      }

      saveState({
        availableUpdateVersion: "",
        updateSnoozeUntil: 0,
        lastUpdateCheckError: "",
      });
      hideUpdateNotice();
      if (force) setStatus(`当前已是最新版 v${SCRIPT_VERSION}。`);
    } catch (error) {
      saveState({ lastUpdateCheckError: error?.message || String(error) });
      if (force) setStatus(`更新检查失败：${error?.message || error}`);
    } finally {
      updateCheckBusy = false;
    }
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || 1) > 0 &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function isCurrentFrameVisible() {
    if (window.top === window) return true;
    try {
      const frame = window.frameElement;
      if (!frame) return true;
      const style = window.top.getComputedStyle(frame);
      const rect = frame.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0 &&
        rect.width > 0 &&
        rect.height > 0;
    } catch {
      return true;
    }
  }

  function textOf(el) {
    return clean(el?.innerText || el?.textContent || "");
  }

  function isScoredActivityText(text) {
    const normalized = clean(text);
    return /得分\s*[:：]?\s*\d+/.test(normalized) || /\d+\s*得分/.test(normalized);
  }

  function isExerciseActivityText(text) {
    return /线上测验|线上练习|实验练习题|练习题|测验|试卷|考试|作业|问卷|讨论|直播|签到|视频/.test(clean(text));
  }

  function shouldSkipActivityText(text) {
    const normalized = clean(text);
    return isScoredActivityText(normalized) ||
      isExerciseActivityText(normalized);
  }

  function findTextElement(text, options = {}) {
    const { exact = true, root = document.body } = options;
    const candidates = [...root.querySelectorAll("button, a, span, p, div")]
      .filter(isVisible)
      .filter((el) => {
        const value = textOf(el);
        return exact ? value === text : value.includes(text);
      });
    return candidates.sort((a, b) => textOf(a).length - textOf(b).length)[0] || null;
  }

  function fireClick(el) {
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "center" });
    const eventWindow = el.ownerDocument?.defaultView || window;
    const MouseEventCtor = eventWindow.MouseEvent || MouseEvent;
    let dispatched = false;
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      try {
        el.dispatchEvent(new MouseEventCtor(type, {
          bubbles: true,
          cancelable: true,
          view: eventWindow,
        }));
        dispatched = true;
      } catch {
        try {
          el.dispatchEvent(new MouseEventCtor(type, {
            bubbles: true,
            cancelable: true,
          }));
          dispatched = true;
        } catch {
          // Try the next event type, then fall back to native click if needed.
        }
      }
    }
    if (!dispatched && typeof el.click === "function") {
      try {
        el.click();
        return true;
      } catch {
        // Synthetic mouse events above are the primary path.
      }
    }
    return dispatched;
  }

  function unreadReturnDialog() {
    const dialogs = [
      ...document.querySelectorAll(".prepareDialog, .el-message-box, .el-dialog, [role='dialog']"),
    ].filter(isVisible);

    return dialogs.find((dialog) => {
      const text = textOf(dialog);
      return text.includes("继续观看") &&
        text.includes("未观看") &&
        (text.includes("没有好好学习") || text.includes("以下页面"));
    }) || null;
  }

  function unreadReturnDialogPages(dialog) {
    const text = textOf(dialog).split("退出")[0] || "";
    return [...text.matchAll(/\d+/g)]
      .map((match) => Number(match[0]))
      .filter((page) => Number.isFinite(page) && page > 0);
  }

  function unreadReturnPromptKey(dialog) {
    const pages = unreadReturnDialogPages(dialog);
    const pagePart = pages.length ? pages.join(",") : textOf(dialog).slice(0, 120);
    return `${location.pathname}|${currentActivityTitle()}|${pagePart}`;
  }

  function shouldExitUnreadReturnDialog() {
    const lastReason = String(loadState().lastHandledReason || "");
    const skippedCount = skippedPageCountInCurrentActivity();
    const readableUnreadCount = getUnreadFlags().length;
    const skippedQuestionReason = /题目页|习题页/.test(lastReason);

    return currentActivityIsDeferred() &&
      readableUnreadCount === 0 &&
      (skippedCount > 0 || skippedQuestionReason);
  }

  function clickDialogAction(dialog, label) {
    const target = findTextElement(label, { exact: true, root: dialog });
    const clickTarget = target?.closest?.("button, a, [role='button']") || target;
    return fireClick(clickTarget);
  }

  async function handleUnreadReturnDialog() {
    const dialog = unreadReturnDialog();
    if (!dialog) return false;

    const pages = unreadReturnDialogPages(dialog);
    const pageLabel = pages.length ? `（${pages.join("、")}）` : "";
    const promptKey = unreadReturnPromptKey(dialog);
    const previousPrompt = loadState().unreadReturnPrompt || {};
    const promptCount = previousPrompt.key === promptKey
      ? Number(previousPrompt.count || 0) + 1
      : 1;

    saveState({
      unreadReturnPrompt: {
        key: promptKey,
        count: promptCount,
        pages,
        at: Date.now(),
      },
    });

    if (shouldExitUnreadReturnDialog()) {
      if (promptCount > CONFIG.unreadReturnPromptExitMax) {
        saveState({ running: false, returningFromCards: null, detailIdle: null });
        setStatus(`未观看提示${pageLabel}已多次尝试退出仍未消失，已暂停，避免退出死循环。`);
        return true;
      }

      beginReturnRecovery();
      const clicked = clickDialogAction(dialog, "退出");
      if (!clicked) {
        saveState({ running: false, returningFromCards: null });
        setStatus("检测到未观看页面提示，且剩余页已判定为题目页，但未能自动点击退出，已暂停，请手动处理。");
        return true;
      }

      setStatus(`未观看提示${pageLabel}对应已跳过题目页，已点击退出并返回列表，避免反复进入。`);
      await sleep(CONFIG.returnWaitMs);
      queueTick(300);
      return true;
    }

    if (promptCount > CONFIG.unreadReturnPromptContinueMax) {
      saveState({ running: false, returningFromCards: null, detailIdle: null });
      setStatus(`未观看提示${pageLabel}重复出现，已暂停，避免继续观看/返回死循环；请手动确认这些页是否为题目页或网络未记录。`);
      return true;
    }

    saveState({ returningFromCards: null, detailIdle: null });
    const clicked = clickDialogAction(dialog, "继续观看");
    if (!clicked) {
      saveState({ running: false });
      setStatus("检测到未观看页面提示，但未能自动点击继续观看，已暂停，请手动处理。");
      return true;
    }

    setStatus(`检测到未观看页面提示${pageLabel}，已继续观看并恢复处理未读页。`);
    await sleep(1200);
    queueTick(300);
    return true;
  }

  function createPanel() {
    if (window.top !== window) return;

    document.getElementById("codex-ykt-ppt-panel")?.remove();
    document.getElementById("codex-ykt-ppt-ball")?.remove();

    const defaultPanelWidth = 260;
    const defaultPanelHeight = 172;
    const minPanelWidth = 230;
    const minPanelHeight = 150;

    const savedPosition = () => {
      const ui = loadUiState();
      return ui.position || (ui.collapsed ? ui.ball || ui.panel : ui.panel || ui.ball) || null;
    };

    const saveSharedPosition = (position) => {
      saveUiState({ position, panel: undefined, ball: undefined });
    };

    const placeFloating = (el, saved, fallbackX, fallbackY) => {
      const width = el.offsetWidth || 56;
      const height = el.offsetHeight || 56;
      const maxX = Math.max(8, window.innerWidth - width - 8);
      const maxY = Math.max(8, window.innerHeight - height - 8);
      const x = clamp(Number.isFinite(saved?.x) ? saved.x : fallbackX, 8, maxX);
      const y = clamp(Number.isFinite(saved?.y) ? saved.y : fallbackY, 8, maxY);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.right = "auto";
      return { x, y };
    };

    const applyPanelSize = (savedSize = {}) => {
      const maxWidth = Math.max(minPanelWidth, window.innerWidth - 16);
      const maxHeight = Math.max(minPanelHeight, window.innerHeight - 16);
      const width = clamp(
        Number.isFinite(savedSize?.width) ? savedSize.width : defaultPanelWidth,
        minPanelWidth,
        maxWidth,
      );
      const height = clamp(
        Number.isFinite(savedSize?.height) ? savedSize.height : defaultPanelHeight,
        minPanelHeight,
        maxHeight,
      );
      panel.style.width = `${Math.round(width)}px`;
      panel.style.height = `${Math.round(height)}px`;
      return { width: Math.round(width), height: Math.round(height) };
    };

    const panelSize = () => ({
      width: Math.round(panel.offsetWidth || defaultPanelWidth),
      height: Math.round(panel.offsetHeight || defaultPanelHeight),
    });

    const positionOf = (el) => {
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left), y: Math.round(rect.top) };
    };

    const makeDraggable = (el, handle, onSave) => {
      let dragging = false;
      let moved = false;
      let startX = 0;
      let startY = 0;
      let startLeft = 0;
      let startTop = 0;

      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest("button") && event.target !== handle) return;

        const rect = el.getBoundingClientRect();
        dragging = true;
        moved = false;
        startX = event.clientX;
        startY = event.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        handle.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      });

      handle.addEventListener("pointermove", (event) => {
        if (!dragging) return;
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        const maxX = Math.max(8, window.innerWidth - el.offsetWidth - 8);
        const maxY = Math.max(8, window.innerHeight - el.offsetHeight - 8);
        el.style.left = `${clamp(startLeft + dx, 8, maxX)}px`;
        el.style.top = `${clamp(startTop + dy, 8, maxY)}px`;
      });

      handle.addEventListener("pointerup", (event) => {
        if (!dragging) return;
        dragging = false;
        handle.releasePointerCapture?.(event.pointerId);
        if (moved) {
          el.dataset.lastDraggedAt = String(Date.now());
          onSave(positionOf(el));
        }
      });
    };

    const panel = document.createElement("div");
    panel.id = "codex-ykt-ppt-panel";
    panel.dataset.scriptVersion = SCRIPT_VERSION;
    panel.style.cssText = [
      "position:fixed",
      "left:0",
      "top:0",
      "z-index:2147483647",
      "width:260px",
      "height:172px",
      "padding:10px",
      "background:#111827",
      "color:#f9fafb",
      "font-size:13px",
      "line-height:1.45",
      "border-radius:8px",
      "box-shadow:0 8px 24px rgba(0,0,0,.25)",
      "font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      "box-sizing:border-box",
      "resize:both",
      "overflow:auto",
      `min-width:${minPanelWidth}px`,
      `min-height:${minPanelHeight}px`,
      "max-width:calc(100vw - 16px)",
      "max-height:calc(100vh - 16px)",
    ].join(";");

    const header = document.createElement("div");
    header.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:8px",
      "margin-bottom:8px",
      "cursor:move",
      "user-select:none",
    ].join(";");

    const title = document.createElement("div");
    title.textContent = `雨课堂 PPT 自动阅读 v${SCRIPT_VERSION}`;
    title.style.cssText = "font-weight:700;flex:1;";

    const collapseButton = document.createElement("button");
    collapseButton.textContent = "收起";
    collapseButton.style.cssText = [
      "border:0",
      "border-radius:6px",
      "padding:4px 7px",
      "cursor:pointer",
      "background:#374151",
      "color:#f9fafb",
      "font-size:12px",
    ].join(";");

    header.append(title, collapseButton);

    panelStatus = document.createElement("div");
    panelStatus.textContent = loadState().status || "待开始";
    panelStatus.style.cssText = [
      "min-height:38px",
      "max-height:72px",
      "padding:8px",
      "background:#1f2937",
      "border-radius:6px",
      "word-break:break-word",
      "overflow:auto",
      "margin-bottom:8px",
    ].join(";");

    const controls = document.createElement("div");
    controls.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";

    const makeButton = (label, bg, handler) => {
      const button = document.createElement("button");
      button.textContent = label;
      button.style.cssText = [
        "flex:1",
        "border:0",
        "border-radius:6px",
        "padding:7px 8px",
        "cursor:pointer",
        "min-width:62px",
        `background:${bg}`,
        "color:white",
        "font-weight:600",
        "white-space:nowrap",
      ].join(";");
      button.addEventListener("click", handler);
      return button;
    };

    controls.append(
      makeButton("开始", "#16a34a", () => {
        saveState({
          running: true,
          runLock: null,
          returningFromCards: null,
          detailIdle: null,
          listLoading: null,
          studentLogLoading: null,
          unreadReturnPrompt: null,
          refreshRecovery: {},
          handledActivities: [],
          deferredActivities: [],
        });
        setStatus("已开始。");
        void tick();
      }),
      makeButton("暂停", "#ca8a04", () => {
        saveState({ running: false });
        setStatus("已暂停。");
      }),
      makeButton("更新", "#2563eb", () => {
        saveState({ lastUpdateCheckAt: 0, updateSnoozeUntil: 0 });
        setStatus("正在检查脚本更新。");
        void checkForScriptUpdate({ force: true });
      }),
      makeButton("停止", "#dc2626", () => {
        localStorage.removeItem(STORE_KEY);
        writeSharedState({ running: false });
        setStatus("已停止并清空状态。");
      }),
    );

    const hint = document.createElement("div");
    hint.textContent = "拖动标题栏移动；右下角调大小；有得分的练习/测验会跳过。";
    hint.style.cssText = "margin-top:8px;color:#cbd5e1;font-size:12px;";

    const ball = document.createElement("button");
    ball.id = "codex-ykt-ppt-ball";
    ball.dataset.scriptVersion = SCRIPT_VERSION;
    ball.textContent = "雨";
    ball.title = "雨课堂 PPT 自动阅读";
    ball.style.cssText = [
      "position:fixed",
      "left:0",
      "top:0",
      "z-index:2147483647",
      "width:46px",
      "height:46px",
      "border:0",
      "border-radius:999px",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "cursor:pointer",
      "background:rgba(17,24,39,.68)",
      "color:#f9fafb",
      "font-size:18px",
      "font-weight:800",
      "box-shadow:0 8px 20px rgba(0,0,0,.22)",
      "backdrop-filter:blur(8px)",
      "opacity:.72",
      "transition:opacity .15s ease, transform .15s ease",
    ].join(";");
    ball.addEventListener("mouseenter", () => {
      ball.style.opacity = ".96";
      ball.style.transform = "scale(1.04)";
    });
    ball.addEventListener("mouseleave", () => {
      ball.style.opacity = ".72";
      ball.style.transform = "scale(1)";
    });

    const setCollapsed = (collapsed, syncFromVisible = true) => {
      if (syncFromVisible) {
        const source = collapsed ? panel : ball;
        saveSharedPosition(positionOf(source));
      }
      saveUiState({ collapsed });
      panel.style.display = collapsed ? "none" : "block";
      ball.style.display = collapsed ? "flex" : "none";
      if (collapsed) {
        const position = placeFloating(ball, savedPosition(), window.innerWidth - 64, 140);
        saveSharedPosition(position);
      } else {
        const ui = loadUiState();
        const size = applyPanelSize(ui.size);
        const position = placeFloating(panel, savedPosition(), window.innerWidth - size.width - 34, 86);
        saveUiState({ position, size, panel: undefined, ball: undefined });
      }
    };

    collapseButton.addEventListener("click", () => setCollapsed(true));
    ball.addEventListener("click", () => {
      if (Date.now() - Number(ball.dataset.lastDraggedAt || 0) < 250) return;
      setCollapsed(false);
    });

    makeDraggable(panel, header, saveSharedPosition);
    makeDraggable(ball, ball, saveSharedPosition);

    panel.append(header, panelStatus, controls, hint);
    appendFloatingNode(panel);
    appendFloatingNode(ball);

    const ui = loadUiState();
    const initialSize = applyPanelSize(ui.size);
    placeFloating(panel, savedPosition(), window.innerWidth - initialSize.width - 34, 86);
    placeFloating(ball, savedPosition(), window.innerWidth - 64, 140);
    setCollapsed(ui.collapsed === true, false);

    let resizeSaveTimer = 0;
    const rememberPanelGeometry = () => {
      if (panel.style.display === "none") return;
      window.clearTimeout(resizeSaveTimer);
      resizeSaveTimer = window.setTimeout(() => {
        const size = panelSize();
        const position = placeFloating(panel, positionOf(panel), window.innerWidth - size.width - 34, 86);
        saveUiState({ position, size, panel: undefined, ball: undefined });
      }, 120);
    };

    if (window.ResizeObserver) {
      new ResizeObserver(rememberPanelGeometry).observe(panel);
    }

    window.addEventListener("resize", () => {
      const latest = loadUiState();
      const size = latest.collapsed ? latest.size : applyPanelSize(latest.size);
      if (latest.collapsed) {
        saveSharedPosition(placeFloating(ball, savedPosition(), window.innerWidth - 64, 140));
      } else {
        const position = placeFloating(panel, savedPosition(), window.innerWidth - (size?.width || defaultPanelWidth) - 34, 86);
        saveUiState({ position, size: panelSize(), panel: undefined, ball: undefined });
      }
    });
  }

  function progressFromText(text) {
    const matches = [...clean(text).matchAll(/学习进度\s*[:：]\s*(\d+)\s*\/\s*(\d+)/g)];
    if (!matches.length) return null;
    const last = matches[matches.length - 1];
    return {
      done: Number(last[1]),
      total: Number(last[2]),
      raw: `${last[1]}/${last[2]}`,
    };
  }

  function getReaderRoot() {
    return document.querySelector(".basePPTDialog") ||
      document.querySelector(".basePPT__component--inline") ||
      document.querySelector(".basePPTMain.basePPTInline") ||
      document.querySelector(".studentCoursewarePPT__component") ||
      [...document.querySelectorAll(".el-dialog")].find((el) => textOf(el).includes("大纲 共")) ||
      null;
  }

  function getReaderProgress() {
    const root = getReaderRoot();
    return progressFromText(root ? textOf(root) : textOf(document.body));
  }

  function getRawUnreadFlags() {
    const root = getReaderRoot() || document;
    return [...root.querySelectorAll("span.flag.noRead")]
      .filter((el) => textOf(el) === "未读");
  }

  function getUnreadFlags() {
    return getRawUnreadFlags()
      .filter((el) => !skippedUnreadPages.has(slideKeyFromFlag(el)));
  }

  function slideLabelFromFlag(flag) {
    const slide = flag.closest(".swiper-slide") || flag.closest(".container") || flag.parentElement;
    return clean(slide?.innerText || flag.innerText || "未知页");
  }

  function slideKeyFromFlag(flag) {
    const label = slideLabelFromFlag(flag);
    const page = label.match(/^\d+/)?.[0] || label;
    return `${location.pathname}:${page}`;
  }

  function hasSkippedPageInCurrentActivity() {
    const prefix = `${location.pathname}:`;
    return [...skippedUnreadPages].some((key) => key.startsWith(prefix));
  }

  function skippedPageCountInCurrentActivity() {
    const prefix = `${location.pathname}:`;
    return [...skippedUnreadPages].filter((key) => key.startsWith(prefix)).length;
  }

  function activeSlideText() {
    const root = getReaderRoot() || document;
    const slides = [...root.querySelectorAll(".swiper-slide-active")]
      .filter((el) => !el.classList.contains("swiper-no-swiping"));
    return slides.map(textOf).join(" ");
  }

  function isQuestionPageOpen() {
    return /作答|主观题|单选题|多选题|判断题|填空题/.test(activeSlideText());
  }

  async function waitForReadConfirmed(beforeProgress, beforeUnreadCount, beforeFlag) {
    const started = Date.now();
    while (Date.now() - started < CONFIG.pageConfirmTimeoutMs) {
      if (!isRunning()) return false;

      const progress = getReaderProgress();
      const unreadCount = getUnreadFlags().length;
      const flagGone = beforeFlag && !document.body.contains(beforeFlag);
      const progressUp = progress && beforeProgress && progress.done > beforeProgress.done;
      const unreadDown = unreadCount < beforeUnreadCount;

      if (flagGone || progressUp || unreadDown) return true;
      await sleep(CONFIG.confirmPollMs);
    }
    return false;
  }

  async function processReader() {
    const root = getReaderRoot();
    if (!root) return false;

    const progress = getReaderProgress();
    const unreadFlags = getUnreadFlags();
    if (progress && progress.done >= progress.total) {
      clearRefreshRecovery(`reader-empty:${location.pathname}`);
      markActivityHandled(progress ? `已完成 (${progress.raw})` : "已完成");
      await leaveCardsPage();
      return true;
    }

    if (!unreadFlags.length) {
      if (!progress) {
        setStatus("等待课件阅读器加载页状态。");
        await sleep(1500);
        return true;
      }

      const remainingPages = Math.max(0, progress.total - progress.done);
      const skippedPages = skippedPageCountInCurrentActivity();
      if (progress.done < progress.total && hasSkippedPageInCurrentActivity() && remainingPages <= skippedPages) {
        clearRefreshRecovery(`reader-empty:${location.pathname}`);
        markActivityHandled(`剩余 ${remainingPages} 页为已跳过题目页 (${progress.raw})`, { defer: true });
        await leaveCardsPage();
        return true;
      }

      if (requestAutoRefresh(
        `reader-empty:${location.pathname}`,
        `阅读器未发现可读未读页，但进度仍为 ${progress.raw}，已跳过题目页 ${skippedPages} 个`,
        CONFIG.readerEmptyRefreshMax,
      )) {
        return true;
      }

      saveState({ running: false });
      setStatus(`未发现可阅读的未读页，但进度仍为 ${progress.raw}，剩余 ${remainingPages} 页大于已跳过题目页 ${skippedPages} 个，已暂停，避免误判结束。`);
      return true;
    }

    const flag = unreadFlags[0];
    const label = slideLabelFromFlag(flag);
    const clickTarget = flag.closest(".container") || flag.closest(".swiper-slide") || flag;
    const beforeUnreadCount = unreadFlags.length;
    const beforeProgress = progress;
    const readRecoveryKey = `read:${slideKeyFromFlag(flag)}`;

    setStatus(`阅读 ${label}，剩余未读 ${beforeUnreadCount} 页。`);
    fireClick(clickTarget);
    await sleep(CONFIG.clickSettleMs);

    if (isQuestionPageOpen()) {
      skippedUnreadPages.add(slideKeyFromFlag(flag));
      clearRefreshRecovery(readRecoveryKey);
      setStatus(`${label} 是习题页，按要求跳过。`);
      await sleep(CONFIG.questionGapMs);
      queueTick();
      return true;
    }

    let ok = await waitForReadConfirmed(beforeProgress, beforeUnreadCount, flag);
    if (!ok) {
      setStatus(`${label} 未确认已读，延长等待。`);
      await sleep(CONFIG.pageExtraWaitMs);
      ok = await waitForReadConfirmed(beforeProgress, beforeUnreadCount, flag);
    }

    if (!ok) {
      if (isQuestionPageOpen()) {
        skippedUnreadPages.add(slideKeyFromFlag(flag));
        clearRefreshRecovery(readRecoveryKey);
        setStatus(`${label} 仍未变已读，但识别为习题页，跳过。`);
      } else {
        if (requestAutoRefresh(
          readRecoveryKey,
          `${label} 长时间未转为已读，可能是网络卡住`,
          CONFIG.readFailRefreshMax,
        )) {
          return true;
        }
        saveState({ running: false });
        setStatus(`${label} 刷新重试后仍未变已读，已暂停，避免跳过普通未读页。`);
      }
      return true;
    }

    clearRefreshRecovery(readRecoveryKey);
    const after = getReaderProgress();
    setStatus(`${label} 已确认${after ? `，进度 ${after.raw}` : ""}。`);
    await sleep(CONFIG.pageGapMs);
    queueTick();
    return true;
  }

  async function openCoursewareIfNeeded() {
    if (getReaderRoot()) return true;

    const button = findTextElement("查看课件", { exact: true });
    if (button) {
      setStatus("打开课件阅读器。");
      saveState({ detailIdle: null });
      fireClick(button);
      await sleep(CONFIG.openCoursewareWaitMs);
      return true;
    }

    if (location.pathname.includes("/studentCards/")) {
      const bodyText = textOf(document.body);
      if (shouldSkipActivityText(bodyText)) {
        if (!markActivityHandled("练习/测验或已有得分，跳过", { defer: true })) {
          setStatus("检测到练习/测验或已有得分，返回列表。");
        }
        await leaveCardsPage();
        return true;
      }

      if (detailWaitKey !== location.href) {
        detailWaitKey = location.href;
        detailWaitCount = 0;
      }

      if (/正在加载/.test(bodyText) || (/课件PPT|查看课件|学习进度/.test(bodyText) && detailWaitCount < 5)) {
        detailWaitCount += 1;
        setStatus("等待课件详情页加载“查看课件”。");
        await sleep(2500);
        return true;
      }

      const progress = progressFromText(textOf(document.body));
      if (progress && progress.done >= progress.total) {
        markActivityHandled(`详情页已完成 (${progress.raw})`);
        setStatus(`详情页已完成 (${progress.raw})，返回列表。`);
        await leaveCardsPage();
        return true;
      }
      if (!markActivityHandled("非 PPT 或无课件入口，跳过", { defer: true })) {
        setStatus("未找到“查看课件”，可能不是 PPT，返回列表。");
      }
      await leaveCardsPage();
      return true;
    }

    return false;
  }

  function isStudyContentLocation() {
    return location.pathname.includes("/studentLog/") || location.pathname.includes("/studycontent");
  }

  function isAutomationFrame() {
    return window.top === window || location.pathname.includes("/studycontent");
  }

  function clearReturnRecoveryIfArrived() {
    if (!loadState().returningFromCards || !isStudyContentLocation()) return;
    saveState({ returningFromCards: null, detailIdle: null, unreadReturnPrompt: null });
  }

  function beginReturnRecovery() {
    const nowMs = Date.now();
    const current = loadState().returningFromCards;
    const samePage = current?.fromUrl === location.href;
    saveState({
      returningFromCards: {
        fromUrl: location.href,
        startedAt: samePage ? current.startedAt || nowMs : nowMs,
        refreshes: samePage ? current.refreshes || 0 : 0,
        lastClickAt: nowMs,
      },
    });
  }

  async function handleReturnRecovery() {
    const returning = loadState().returningFromCards;
    if (!returning) return false;

    if (await handleUnreadReturnDialog()) return true;

    if (isStudyContentLocation()) {
      saveState({ returningFromCards: null });
      return false;
    }

    if (!location.pathname.includes("/studentCards/")) return false;

    const nowMs = Date.now();
    const elapsed = nowMs - (returning.startedAt || nowMs);
    if (elapsed >= CONFIG.returnStuckRefreshMs) {
      const refreshes = Number(returning.refreshes || 0);
      if (refreshes >= CONFIG.returnRefreshMax) {
        saveState({ running: false, returningFromCards: null });
        setStatus("返回学习内容多次自动刷新仍失败，已暂停，请手动刷新或返回列表。");
        return true;
      }

      saveState({
        returningFromCards: {
          ...returning,
          startedAt: nowMs,
          refreshes: refreshes + 1,
          lastClickAt: 0,
        },
      });
      refreshPage(`返回学习内容卡住超过 ${Math.round(CONFIG.returnStuckRefreshMs / 1000)} 秒`);
      return true;
    }

    if (nowMs - Number(returning.lastClickAt || 0) >= CONFIG.returnRetryClickMs) {
      setStatus("返回学习内容未完成，重试返回。");
      await leaveCardsPage();
      return true;
    }

    setStatus(`正在返回学习内容，已等待 ${Math.ceil(elapsed / 1000)} 秒。`);
    await sleep(1500);
    return true;
  }

  function clearListLoadingRecovery() {
    if (loadState().listLoading) {
      saveState({ listLoading: null });
    }
  }

  function hasStudyContentIframe() {
    return studyContentIframes().length > 0;
  }

  function studyContentIframes() {
    return [...document.querySelectorAll("iframe")]
      .filter((frame) => frame.classList.contains("tab-pane-content-iframe") || frame.src.includes("/studycontent"));
  }

  function hasVisibleStudyContentIframe() {
    return studyContentIframes().some(isVisible);
  }

  function clearStudentLogLoadingRecovery() {
    if (loadState().studentLogLoading) {
      saveState({ studentLogLoading: null });
    }
  }

  async function waitForStudentLogLoading(reason) {
    const nowMs = Date.now();
    const current = loadState().studentLogLoading || { startedAt: nowMs, refreshes: 0 };
    if (!loadState().studentLogLoading) {
      saveState({ studentLogLoading: current });
    }

    const elapsed = nowMs - (current.startedAt || nowMs);
    if (elapsed >= CONFIG.studentLogStuckRefreshMs) {
      const refreshes = Number(current.refreshes || 0);
      if (refreshes >= CONFIG.studentLogRefreshMax) {
        saveState({ running: false, studentLogLoading: null });
        setStatus("学习内容主页面多次自动刷新仍未加载 iframe，已暂停，请手动刷新页面。");
        return true;
      }

      saveState({
        studentLogLoading: {
          startedAt: nowMs,
          refreshes: refreshes + 1,
        },
      });
      refreshPage(`学习内容主页面加载卡住超过 ${Math.round(CONFIG.studentLogStuckRefreshMs / 1000)} 秒`);
      return true;
    }

    setStatus(`${reason}，已等待 ${Math.ceil(elapsed / 1000)} 秒。`);
    await sleep(2500);
    return true;
  }

  async function handleDetailIdleRecovery() {
    if (!location.pathname.includes("/studentCards/") || getReaderRoot()) return false;

    const state = loadState();
    const current = state.detailIdle || { url: location.href, startedAt: Date.now(), refreshes: 0 };
    const samePage = current.url === location.href;
    const detailIdle = samePage ? current : { url: location.href, startedAt: Date.now(), refreshes: 0 };
    if (!state.detailIdle || !samePage) {
      saveState({ detailIdle });
      return false;
    }

    const elapsed = Date.now() - Number(detailIdle.startedAt || Date.now());
    if (elapsed < CONFIG.detailIdleRefreshMs) return false;

    const refreshes = Number(detailIdle.refreshes || 0);
    if (refreshes >= CONFIG.detailIdleRefreshMax) {
      saveState({ running: false, detailIdle: null });
      setStatus("详情页长时间未进入阅读器，多次自动刷新仍失败，已暂停。");
      return true;
    }

    saveState({
      detailIdle: {
        url: location.href,
        startedAt: Date.now(),
        refreshes: refreshes + 1,
      },
    });
    refreshPage(`详情页停留超过 ${Math.round(CONFIG.detailIdleRefreshMs / 1000)} 秒仍未进入阅读器`);
    return true;
  }

  async function waitForStudyContentListLoading() {
    const nowMs = Date.now();
    const current = loadState().listLoading || { startedAt: nowMs, refreshes: 0 };
    if (!loadState().listLoading) {
      saveState({ listLoading: current });
    }

    const elapsed = nowMs - (current.startedAt || nowMs);
    if (elapsed >= CONFIG.listLoadStuckRefreshMs) {
      const refreshes = Number(current.refreshes || 0);
      if (refreshes >= CONFIG.listLoadRefreshMax) {
        saveState({ running: false, listLoading: null });
        setStatus("学习内容列表多次自动刷新仍未加载，已暂停，请手动刷新页面。");
        return true;
      }

      saveState({
        listLoading: {
          startedAt: nowMs,
          refreshes: refreshes + 1,
        },
      });
      refreshPage(`学习内容列表加载卡住超过 ${Math.round(CONFIG.listLoadStuckRefreshMs / 1000)} 秒`);
      return true;
    }

    setStatus(`等待学习内容列表加载，已等待 ${Math.ceil(elapsed / 1000)} 秒。`);
    await sleep(2500);
    return true;
  }

  async function leaveCardsPage() {
    beginReturnRecovery();

    const dialogClose = document.querySelector(".basePPTDialog .el-dialog__headerbtn");
    if (dialogClose) {
      fireClick(dialogClose);
      await sleep(800);
    }

    const returnButton = findTextElement("返回", { exact: true });
    if (returnButton) {
      fireClick(returnButton);
    } else {
      history.back();
    }
    await sleep(900);
    if (await handleUnreadReturnDialog()) return;
    await sleep(CONFIG.returnWaitMs);
  }

  function activityRowFromStatus(statusEl) {
    let node = statusEl;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      const text = textOf(node);
      const title = titleFromRowText(text);
      if (
        hasUnfinishedStatus(text) &&
        text.length < 500 &&
        title
      ) {
        return node;
      }
    }
    return null;
  }

  function titleFromRowText(text) {
    const normalized = clean(text);
    const byDeadline = normalized.match(/^(.+?)\s+请在\d{4}-\d{2}-\d{2}/);
    if (byDeadline?.[1]) return activityKey(byDeadline[1]);

    const byExam = normalized.match(/^(.+?)\s+考核截止时间/);
    if (byExam?.[1]) return activityKey(byExam[1]);

    return "";
  }

  function titleFromRow(row) {
    return titleFromRowText(row.innerText || "") || clean(row.innerText).slice(0, 60);
  }

  function rowProgressFromText(text) {
    const match = clean(text).match(/进行中\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)/);
    if (!match) return null;
    const done = Number(match[1]);
    const total = Number(match[2]);
    return {
      done,
      total,
      remaining: Math.max(0, total - done),
      raw: `${done}/${total}`,
    };
  }

  function hasUnfinishedStatus(text) {
    return /(未开始|进行中\s*\(\s*\d+\s*\/\s*\d+\s*\))/.test(clean(text));
  }

  function shouldSkipHandledRow(row) {
    const title = activityKey(titleFromRow(row));
    return handledActivities().has(title) || deferredActivities().has(title);
  }

  function unfinishedActivityRows() {
    return [...document.querySelectorAll(".leaf-detail")]
      .filter(isVisible)
      .filter((row) => {
        const rowText = textOf(row);
        return hasUnfinishedStatus(rowText) &&
          titleFromRowText(rowText) &&
          !shouldSkipActivityText(rowText);
      });
  }

  function findNextActivityRow() {
    for (const row of unfinishedActivityRows()) {
      if (shouldSkipHandledRow(row)) continue;
      return row;
    }

    const statuses = [...document.querySelectorAll(".item")]
      .filter(isVisible)
      .filter((el) => hasUnfinishedStatus(textOf(el)));

    for (const status of statuses) {
      const row = activityRowFromStatus(status);
      if (!row) continue;
      const rowText = textOf(row);
      if (shouldSkipActivityText(rowText)) continue;
      if (shouldSkipHandledRow(row)) continue;
      return row;
    }
    return null;
  }

  async function processStudyContentList() {
    if (!isCurrentFrameVisible()) {
      return true;
    }

    clearStudentLogLoadingRecovery();
    const allItems = [...document.querySelectorAll(".item")].filter(isVisible);
    const row = findNextActivityRow();
    if (!row) {
      const bodyText = textOf(document.body);
      if (!allItems.length || /正在加载/.test(bodyText)) {
        return waitForStudyContentListLoading();
      }

      clearListLoadingRecovery();
      saveState({ returningFromCards: null, detailIdle: null });
      const unfinishedRows = unfinishedActivityRows()
        .filter((candidate) => !shouldSkipHandledRow(candidate));
      if (unfinishedRows.length) {
        const titles = unfinishedRows
          .slice(0, 5)
          .map((candidate) => titleFromRow(candidate))
          .join("；");
        saveState({ running: false });
        setStatus(`仍检测到 ${unfinishedRows.length} 个未完成 PPT，但未能定位可打开行，已暂停：${titles}`);
        return true;
      }

      saveState({ running: false });
      const skippedCount = [...document.querySelectorAll(".leaf-detail")]
        .filter(isVisible)
        .filter((el) => shouldSkipActivityText(textOf(el))).length;
      setStatus(`列表已加载，但未找到未完成 PPT，任务结束${skippedCount ? `；已跳过 ${skippedCount} 个练习/测验/非 PPT 活动` : ""}。`);
      return true;
    }

    clearListLoadingRecovery();
    saveState({ returningFromCards: null, detailIdle: null });
    const title = titleFromRow(row);
    saveState({ lastActivity: title });
    setStatus(`打开活动：${title}`);
    fireClick(row);
    await sleep(4500);
    return true;
  }

  async function ensureStudyContentTab() {
    if (!location.pathname.includes("/studentLog/")) return false;

    if (hasVisibleStudyContentIframe()) {
      clearStudentLogLoadingRecovery();
      setStatus("学习内容框架已加载，等待列表处理。");
      await sleep(1500);
      return true;
    }

    const contentTab = findTextElement("学习内容", { exact: true });
    if (contentTab) {
      fireClick(contentTab);
      return waitForStudentLogLoading("切到学习内容后等待列表框架加载");
    } else if (hasStudyContentIframe()) {
      return waitForStudentLogLoading("学习内容框架存在但未显示，等待切换或刷新恢复");
    } else {
      return waitForStudentLogLoading("等待学习内容页加载");
    }
  }

  async function tick() {
    if (busy || !isRunning()) return;
    if (!isAutomationFrame()) return;

    if (window.top === window && location.pathname.includes("/studentLog/")) {
      if (hasVisibleStudyContentIframe()) {
        clearStudentLogLoadingRecovery();
        syncPanelStatus();
        return;
      }

      busy = true;
      try {
        if (await ensureStudyContentTab()) return;
      } catch (error) {
        saveState({ running: false });
        setStatus(`出错并暂停：${error?.message || error}`);
        console.error(error);
      } finally {
        busy = false;
      }
      return;
    }

    if (!ownsRunLock()) return;
    busy = true;

    try {
      if (await handleUnreadReturnDialog()) return;

      clearReturnRecoveryIfArrived();

      if (await handleReturnRecovery()) return;
      if (await handleDetailIdleRecovery()) return;

      if (getReaderRoot()) {
        if (loadState().detailIdle) saveState({ detailIdle: null });
        if (await processReader()) return;
      }

      if (location.pathname.includes("/studentCards/")) {
        if (await openCoursewareIfNeeded()) return;
      }

      if (location.pathname.includes("/studycontent")) {
        if (await processStudyContentList()) return;
      }

      if (await ensureStudyContentTab()) return;

      setStatus("当前页面不是雨课堂学习内容或课件页，等待中。");
    } catch (error) {
      saveState({ running: false });
      setStatus(`出错并暂停：${error?.message || error}`);
      console.error(error);
    } finally {
      busy = false;
    }
  }

  if (!isAutomationFrame()) return;

  createPanel();

  if (panelStatus) {
    syncPanelStatus();
  }

  window.setTimeout(() => {
    void checkForScriptUpdate();
  }, 2000);

  setInterval(() => {
    void checkForScriptUpdate();
  }, CONFIG.updateCheckIntervalMs);

  setInterval(() => {
    syncPanelStatus();
    void tick();
  }, CONFIG.tickMs);

  if (isRunning()) {
    void tick();
  }
})();
