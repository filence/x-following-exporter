import { buildFilename, buildLogFilename, toCsv } from "../exporters/formatters.js";
import { prepareHtmlUsers } from "../exporters/avatars.js";
import { buildHtmlDocument, modeLabel } from "../exporters/html.js";
import { triggerDownload } from "../exporters/download.js";
import {
  clearSavedSession,
  loadSavedSession,
  saveSessionSnapshot
} from "../shared/session-store.js";

const pageSubtitle = document.getElementById("pageSubtitle");
const statusBadge = document.getElementById("statusBadge");
const countValue = document.getElementById("countValue");
const profileExpectedValue = document.getElementById("profileExpectedValue");
const profileDiffValue = document.getElementById("profileDiffValue");
const modeValue = document.getElementById("modeValue");
const seedValue = document.getElementById("seedValue");
const unavailableMeta = document.getElementById("unavailableMeta");
const unavailableValue = document.getElementById("unavailableValue");
const hintText = document.getElementById("hintText");
const errorText = document.getElementById("errorText");
const resumeBanner = document.getElementById("resumeBanner");
const resumeBannerText = document.getElementById("resumeBannerText");

const restoreBtn = document.getElementById("restoreBtn");
const discardSessionBtn = document.getElementById("discardSessionBtn");
const startBtn = document.getElementById("startBtn");
const pauseResumeBtn = document.getElementById("pauseResumeBtn");
const stopBtn = document.getElementById("stopBtn");
const refreshBtn = document.getElementById("refreshBtn");
const htmlModeSelect = document.getElementById("htmlModeSelect");
const exportHtmlBtn = document.getElementById("exportHtmlBtn");
const exportJsonBtn = document.getElementById("exportJsonBtn");
const exportCsvBtn = document.getElementById("exportCsvBtn");
const exportLogBtn = document.getElementById("exportLogBtn");

const debugStopReason = document.getElementById("debugStopReason");
const debugDirectPages = document.getElementById("debugDirectPages");
const debugStagnantRounds = document.getElementById("debugStagnantRounds");
const debugCacheSize = document.getElementById("debugCacheSize");
const debugRateLimit = document.getElementById("debugRateLimit");
const debugCursor = document.getElementById("debugCursor");
const debugEvents = document.getElementById("debugEvents");

let activeTabId = null;
let currentStatus = null;
let currentTab = null;
let startBusy = false;
let htmlExportBusy = false;
let htmlAbortController = null;
let lastSavedSignature = "";
let pendingSavedSession = null;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    throw new Error("未找到当前标签页");
  }
  return tab;
}

function isSupportedUrl(url) {
  return typeof url === "string" && /^https?:\/\/(?:[^/]+\.)?(?:x\.com|twitter\.com)\//i.test(url);
}

function isFollowingUrl(url) {
  return typeof url === "string" && /\/following(?:\/|$|\?)/.test(url);
}

function extractUsernameFromFollowingUrl(url) {
  if (typeof url !== "string") {
    return null;
  }
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/([^/]+)\/following(?:\/|$)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function setError(message) {
  if (!message) {
    errorText.hidden = true;
    errorText.textContent = "";
    return;
  }
  errorText.hidden = false;
  errorText.textContent = message;
}

function setHint(message, { force = false } = {}) {
  if ((htmlExportBusy || startBusy) && !force) {
    return;
  }
  hintText.textContent = message;
}

function shorten(value, maxLength = 34) {
  if (value == null || value === "") {
    return "-";
  }
  const text = String(value);
  return text.length > maxLength ? text.slice(0, maxLength) + "..." : text;
}

function getProfileCheckSummary(status) {
  const profileCheck = status && status.profileCheck;
  const current = Number(status && status.count ? status.count : 0);

  if (
    !profileCheck ||
    profileCheck.expectedFollowingCount === null ||
    profileCheck.expectedFollowingCount === undefined
  ) {
    const knownCount =
      status && typeof status.knownProfileCount === "number"
        ? status.knownProfileCount
        : null;
    if (knownCount !== null) {
      return {
        expectedText: String(knownCount),
        diffText: current > 0 ? formatDelta(current - knownCount).text : "-",
        diffClassName:
          current > 0 ? formatDelta(current - knownCount).className : "metric-value"
      };
    }
    return {
      expectedText: "未核对",
      diffText: "-",
      diffClassName: "metric-value"
    };
  }

  const expected = Number(profileCheck.expectedFollowingCount);
  if (!Number.isFinite(expected)) {
    return {
      expectedText: "未核对",
      diffText: "-",
      diffClassName: "metric-value"
    };
  }

  const delta = formatDelta(current - expected);
  return {
    expectedText: String(expected),
    diffText: delta.text,
    diffClassName: delta.className
  };
}

function formatDelta(delta) {
  if (delta === 0) {
    return { text: "0", className: "metric-value value-ok" };
  }
  if (delta < 0) {
    return { text: String(delta), className: "metric-value value-warn" };
  }
  return { text: "+" + String(delta), className: "metric-value value-warn" };
}

function getStatusBadgeInfo(status) {
  if (!status) {
    return { text: "待命", className: "badge" };
  }
  if (status.exportActive) {
    return {
      text: status.mode === "direct-rate-limited" ? "冷却中" : "采集中",
      className: "badge is-active"
    };
  }
  if (status.paused) {
    return { text: "已暂停", className: "badge is-paused" };
  }
  if (status.done) {
    return { text: "已完成", className: "badge is-done" };
  }
  return { text: "待命", className: "badge" };
}

function buildHintMessage(tab, status) {
  if (!tab || !tab.url || !isSupportedUrl(tab.url)) {
    return "请切换到 X (x.com) 标签页，并进入目标账号的 following 关注页。";
  }
  if (!isFollowingUrl(tab.url)) {
    return "当前不是关注页。请进入 x.com/用户名/following 后点击「开始导出」。";
  }
  if (!status) {
    return "等待页面脚本响应，若刚重载扩展请刷新一次当前 X 页面。";
  }

  if (status.mode === "direct-rate-limited" && status.rateLimit && status.rateLimit.waitingUntil) {
    const remainSec = Math.max(
      0,
      Math.ceil((Date.parse(status.rateLimit.waitingUntil) - Date.now()) / 1000)
    );
    return `触发 X 速率限制（429），正在自动冷却 ${remainSec} 秒，结束后将自动续采；也可随时暂停。`;
  }

  if (status.paused) {
    return `已暂停，当前保留 ${status.count || 0} 条记录。可随时点「继续」续采，或直接导出当前结果。`;
  }

  if (status.exportActive) {
    if (status.mode === "direct-stalled-scroll") {
      return "直连翻页受限或停滞，已自动切入增强滚动补采，请保持页面停留。";
    }
    if (status.mode === "fallback-scroll") {
      return "正在滚动补采（若需直连模式，可刷新一次 following 页面以捕获种子）。";
    }
    return "正在直连分页采集，可随时切换标签页或先暂停；侧边栏保持开启不会中断任务。";
  }

  const profileCheck = status.profileCheck;
  if (status.done && profileCheck && typeof profileCheck.expectedFollowingCount === "number") {
    const expected = profileCheck.expectedFollowingCount;
    const current = Number(status.count || 0);
    const unavailable = Number(status.unavailableCount || 0);
    const diff = expected - current;
    if (diff === 0) {
      return `采集完成：共 ${current} 条，与主页关注数 ${expected} 完全对齐。`;
    }
    if (diff > 0) {
      const unavailableHint = unavailable > 0 ? `（含 ${unavailable} 个已封禁/不可用账号）` : "";
      return `采集完成：主页 ${expected}，实采 ${current}，差 ${diff} 条${unavailableHint}。他人列表尾段空页属 X 平台限制。`;
    }
    return `采集完成：实采 ${current} 条，略多于主页缓存数 ${expected}。`;
  }

  if (status.seedCaptured) {
    return "已捕获当前账号直连种子，点击「开始导出」即可优先走直连翻页。";
  }
  return "主模式优先直连翻页，未捕获种子或遇 404/403 校验时自动切换增强滚动补采。";
}

function updateDebugPanel(status) {
  const debug = (status && status.debug) || {};
  const rateLimit = (status && status.rateLimit) || {};

  debugStopReason.textContent = debug.lastStopReason || "-";
  debugDirectPages.textContent = String(Number(debug.directPageCount || 0));
  debugStagnantRounds.textContent = String(Number(debug.stagnantRounds || 0));
  debugCacheSize.textContent = String(Number(debug.requestCacheSize || 0));
  debugCursor.textContent = shorten(debug.lastCursor, 26);
  debugCursor.title = debug.lastCursor || "";

  if (rateLimit.remaining != null) {
    debugRateLimit.textContent =
      rateLimit.limit != null
        ? `${rateLimit.remaining} / ${rateLimit.limit}`
        : String(rateLimit.remaining);
  } else {
    debugRateLimit.textContent = "-";
  }

  debugEvents.textContent =
    Array.isArray(debug.recentEvents) && debug.recentEvents.length
      ? debug.recentEvents.join("\n")
      : "-";
}

function updateButtons(tab, status) {
  const supported = Boolean(tab && isSupportedUrl(tab.url));
  const following = Boolean(tab && isFollowingUrl(tab.url));
  const hasData = Boolean(status && Number(status.count || 0) > 0);
  const hasLogs = Boolean(status && status.debug && Number(status.debug.logCount || 0) > 0);
  const exporting = Boolean(status && status.exportActive);
  const paused = Boolean(status && status.paused);

  startBtn.disabled = !supported || !following || exporting || startBusy;
  startBtn.textContent = startBusy ? "核对中..." : hasData && !exporting ? "重新采集" : "开始导出";

  pauseResumeBtn.disabled = !supported || !following || (!exporting && !paused) || startBusy;
  pauseResumeBtn.textContent = paused ? "继续" : "暂停";

  stopBtn.disabled = !supported || (!exporting && !paused);

  if (htmlExportBusy) {
    exportHtmlBtn.disabled = false;
    exportHtmlBtn.textContent = "取消导出";
    exportHtmlBtn.className = "danger";
    htmlModeSelect.disabled = true;
  } else {
    exportHtmlBtn.disabled = !supported || !hasData;
    exportHtmlBtn.textContent = "导出 HTML";
    exportHtmlBtn.className = "primary";
    htmlModeSelect.disabled = !supported || !hasData;
  }

  exportJsonBtn.disabled = !supported || !hasData;
  exportCsvBtn.disabled = !supported || !hasData;
  exportLogBtn.disabled = !supported || !hasLogs;
}

function updateResumeBanner(tab, status) {
  const username = extractUsernameFromFollowingUrl(tab && tab.url ? tab.url : "");
  const canOfferRestore =
    Boolean(username) &&
    Boolean(pendingSavedSession) &&
    pendingSavedSession.pageUsername.toLowerCase() === username.toLowerCase() &&
    !(status && (status.exportActive || Number(status.count || 0) > 0));

  if (!canOfferRestore) {
    resumeBanner.hidden = true;
    return;
  }

  const timeLabel = pendingSavedSession.savedAt
    ? new Date(pendingSavedSession.savedAt).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      })
    : "";
  resumeBannerText.textContent = `本地断点：@${pendingSavedSession.pageUsername}（${pendingSavedSession.count} 条 · ${timeLabel}）`;
  resumeBanner.hidden = false;
}

function updateView(tab, status) {
  currentTab = tab;
  currentStatus = status;

  const username = extractUsernameFromFollowingUrl(tab && tab.url ? tab.url : "");
  if (!tab || !tab.url || !isSupportedUrl(tab.url)) {
    pageSubtitle.textContent = "非 X 页面";
  } else if (username) {
    pageSubtitle.textContent = `关注页 · @${username}`;
  } else if (status && status.pageType === "followers") {
    pageSubtitle.textContent = "X 粉丝页面（暂仅支持关注页）";
  } else {
    pageSubtitle.textContent = "X 其它页面";
  }

  const badge = getStatusBadgeInfo(status);
  statusBadge.textContent = badge.text;
  statusBadge.className = badge.className;

  const profileSummary = getProfileCheckSummary(status);
  countValue.textContent = String((status && status.count) || 0);
  profileExpectedValue.textContent = profileSummary.expectedText;
  profileDiffValue.textContent = profileSummary.diffText;
  profileDiffValue.className = profileSummary.diffClassName;

  modeValue.textContent = modeLabel(status && status.mode ? status.mode : "idle");
  seedValue.textContent = status && status.seedCaptured ? "已捕获" : "未捕获";

  const unavailable = Number(status && status.unavailableCount ? status.unavailableCount : 0);
  unavailableMeta.hidden = unavailable <= 0;
  unavailableValue.textContent = String(unavailable);

  updateDebugPanel(status);
  setHint(buildHintMessage(tab, status));

  if (status && status.lastError) {
    setError(status.lastError);
  } else if (!startBusy && !htmlExportBusy) {
    setError("");
  }

  updateButtons(tab, status);
  updateResumeBanner(tab, status);
}

async function refreshSavedSessionHint(tab) {
  const username = extractUsernameFromFollowingUrl(tab && tab.url ? tab.url : "");
  if (!username) {
    pendingSavedSession = null;
    return;
  }
  pendingSavedSession = await loadSavedSession(username).catch(() => null);
}

async function maybePersistCheckpoint(tab, status) {
  if (!tab || !tab.id || !status) {
    return;
  }
  const count = Number(status.count || 0);
  if (count <= 0 || !status.pageUsername) {
    return;
  }

  const bucket = Math.floor(count / 20);
  const sig = `${status.pageUsername.toLowerCase()}:${bucket}:${status.paused}:${status.done}:${status.lastCursor || ""}`;
  if (sig === lastSavedSignature) {
    return;
  }
  const shouldSave =
    status.done || status.paused || count % 20 === 0 || !lastSavedSignature.startsWith(status.pageUsername.toLowerCase() + ":");
  if (!shouldSave) {
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: "xfe:getData" });
    if (response && response.ok && response.result && response.result.users?.length) {
      await saveSessionSnapshot(response.result);
      lastSavedSignature = sig;
    }
  } catch {
    // Ignore transient tab navigation errors
  }
}

async function readStatus() {
  let tab;
  try {
    tab = await getActiveTab();
  } catch (error) {
    updateView(null, null);
    setError(error.message);
    return;
  }

  activeTabId = tab.id;
  await refreshSavedSessionHint(tab);

  if (!tab.url || !isSupportedUrl(tab.url)) {
    updateView(tab, null);
    return;
  }

  try {
    const result = await chrome.tabs.sendMessage(tab.id, { action: "xfe:getStatus" });
    if (result && result.ok && result.status) {
      updateView(tab, result.status);
      void maybePersistCheckpoint(tab, result.status);
    } else {
      updateView(tab, null);
      setError((result && result.error) || "页面脚本未响应，请刷新一次当前 X 页面。");
    }
  } catch {
    updateView(tab, null);
    setError("当前页面尚未注入扩展脚本，刷新一次页面后再试。");
  }
}

async function getExportData() {
  const tab = await getActiveTab();
  const response = await chrome.tabs.sendMessage(tab.id, { action: "xfe:getData" });
  if (!response || !response.ok || !response.result) {
    throw new Error((response && response.error) || "读取导出数据失败");
  }
  return response.result;
}

async function getLogData() {
  const tab = await getActiveTab();
  const response = await chrome.tabs.sendMessage(tab.id, { action: "xfe:getLogs" });
  if (!response || !response.ok || !response.result) {
    throw new Error((response && response.error) || "读取运行日志失败");
  }
  return response.result;
}

async function resolveProfileCheckBeforeStart(tab) {
  const username = extractUsernameFromFollowingUrl(tab.url || "");
  if (!username) {
    return {
      profileUsername: "",
      expectedFollowingCount: null,
      checkedAt: new Date().toISOString(),
      profileCheckSource: "",
      profileCheckError: "未能识别账号用户名"
    };
  }

  // 1. Prefer exact count intercepted via UserByScreenName / UserByRestId (zero extra tab)
  try {
    const knownRes = await chrome.tabs.sendMessage(tab.id, {
      action: "xfe:getKnownProfileCount"
    });
    if (
      knownRes &&
      knownRes.ok &&
      knownRes.result &&
      typeof knownRes.result.followingCount === "number" &&
      Number.isFinite(knownRes.result.followingCount)
    ) {
      return {
        profileUsername: knownRes.result.username || username,
        expectedFollowingCount: Math.round(knownRes.result.followingCount),
        checkedAt: new Date().toISOString(),
        profileCheckSource: knownRes.result.source || "graphql-profile",
        profileCheckError: ""
      };
    }
  } catch {
    // Fallback to background tab verification
  }

  // 2. Fallback: delegate background profile tab lifecycle to Service Worker so it never leaks orphan tabs
  setHint("未命中接口缓存，正由后台安全打开主页核对关注数（完成后自动关闭）...", { force: true });
  let origin = "https://x.com";
  try {
    origin = new URL(tab.url).origin;
  } catch {
    origin = "https://x.com";
  }

  const bgRes = await chrome.runtime.sendMessage({
    action: "xfe:bgVerifyProfileCount",
    username,
    origin
  });

  if (bgRes && bgRes.ok && bgRes.result) {
    return bgRes.result;
  }

  return {
    profileUsername: username,
    expectedFollowingCount: null,
    checkedAt: new Date().toISOString(),
    profileCheckSource: "background-profile-tab",
    profileCheckError: (bgRes && bgRes.error) || "后台主页核对失败"
  };
}

startBtn.addEventListener("click", async () => {
  setError("");
  startBusy = true;
  updateButtons(currentTab, currentStatus);
  try {
    const tab = await getActiveTab();
    if (!isFollowingUrl(tab.url || "")) {
      throw new Error("请先进入目标账号的 following 页面，例如 x.com/用户名/following。");
    }

    setHint("正在核对主页关注数...", { force: true });
    const profileCheck = await resolveProfileCheckBeforeStart(tab);

    if (profileCheck.expectedFollowingCount !== null) {
      setHint(
        `已核对关注数 ${profileCheck.expectedFollowingCount}（${profileCheck.profileCheckSource}），开始采集...`,
        { force: true }
      );
    } else {
      setHint(
        `主页核对未命中（${profileCheck.profileCheckError || "未知原因"}），已直接启动采集...`,
        { force: true }
      );
    }

    const response = await chrome.tabs.sendMessage(tab.id, {
      action: "xfe:startExport",
      payload: profileCheck
    });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "启动导出失败");
    }
    lastSavedSignature = "";
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    startBusy = false;
    await readStatus();
  }
});

pauseResumeBtn.addEventListener("click", async () => {
  setError("");
  try {
    const tab = await getActiveTab();
    const isPaused = Boolean(currentStatus && currentStatus.paused);
    const action = isPaused ? "xfe:resumeExport" : "xfe:pauseExport";
    const response = await chrome.tabs.sendMessage(tab.id, { action });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "操作失败");
    }
    await readStatus();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
});

stopBtn.addEventListener("click", async () => {
  setError("");
  try {
    const tab = await getActiveTab();
    const response = await chrome.tabs.sendMessage(tab.id, { action: "xfe:stopExport" });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "停止导出失败");
    }
    await readStatus();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
});

restoreBtn.addEventListener("click", async () => {
  setError("");
  try {
    if (!pendingSavedSession) {
      throw new Error("未找到可恢复的本地断点");
    }
    const tab = await getActiveTab();
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: "xfe:restoreSession",
      payload: pendingSavedSession
    });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "恢复断点失败");
    }
    await readStatus();
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
});

discardSessionBtn.addEventListener("click", async () => {
  setError("");
  try {
    const username = extractUsernameFromFollowingUrl(currentTab && currentTab.url ? currentTab.url : "");
    if (username) {
      await clearSavedSession(username);
    }
    pendingSavedSession = null;
    updateResumeBanner(currentTab, currentStatus);
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
});

refreshBtn.addEventListener("click", () => {
  void readStatus();
});

exportJsonBtn.addEventListener("click", async () => {
  setError("");
  try {
    const data = await getExportData();
    if (!Array.isArray(data.users) || data.users.length === 0) {
      throw new Error("当前没有可导出的数据");
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json;charset=utf-8"
    });
    await triggerDownload(blob, buildFilename(data, "json"));
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
});

exportCsvBtn.addEventListener("click", async () => {
  setError("");
  try {
    const data = await getExportData();
    if (!Array.isArray(data.users) || data.users.length === 0) {
      throw new Error("当前没有可导出的数据");
    }
    const blob = new Blob([toCsv(data.users)], {
      type: "text/csv;charset=utf-8"
    });
    await triggerDownload(blob, buildFilename(data, "csv"));
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
});

exportHtmlBtn.addEventListener("click", async () => {
  if (htmlExportBusy) {
    if (htmlAbortController) {
      htmlAbortController.abort();
    }
    return;
  }

  setError("");
  htmlExportBusy = true;
  htmlAbortController = new AbortController();
  updateButtons(currentTab, currentStatus);

  try {
    const data = await getExportData();
    if (!Array.isArray(data.users) || data.users.length === 0) {
      throw new Error("当前没有可导出的数据");
    }

    const avatarMode = htmlModeSelect.value === "offline" ? "offline" : "linked";
    const htmlData = await prepareHtmlUsers(data.users, avatarMode, {
      signal: htmlAbortController.signal,
      onProgress: ({ completed, total, failed }) => {
        setHint(
          `正在打包离线 HTML，内嵌头像 ${completed}/${total}${failed > 0 ? `（失败 ${failed}）` : ""}，可点「取消导出」中止。`,
          { force: true }
        );
      }
    });

    const payload = {
      ...data,
      users: htmlData.users,
      htmlExportMeta: htmlData.avatarMeta
    };
    const blob = new Blob([buildHtmlDocument(payload)], {
      type: "text/html;charset=utf-8"
    });
    await triggerDownload(
      blob,
      buildFilename(data, "html", avatarMode === "offline" ? "offline" : "linked")
    );
    setHint("HTML 文件已提交保存对话框。", { force: true });
  } catch (error) {
    if (error && error.name === "AbortError") {
      setHint("已取消离线 HTML 导出。", { force: true });
    } else {
      setError(error instanceof Error ? error.message : String(error));
    }
  } finally {
    htmlExportBusy = false;
    htmlAbortController = null;
    await readStatus();
  }
});

exportLogBtn.addEventListener("click", async () => {
  setError("");
  try {
    const data = await getLogData();
    if (!Array.isArray(data.logs) || data.logs.length === 0) {
      throw new Error("当前没有可导出的运行日志");
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json;charset=utf-8"
    });
    await triggerDownload(blob, buildLogFilename(data));
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  }
});

// Real-time status push from content script (only accept pushes from active tab)
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.action !== "xfe:statusPush" || !message.status) {
    return;
  }
  if (!sender || !sender.tab || sender.tab.id !== activeTabId) {
    return;
  }
  updateView(sender.tab, message.status);
  void maybePersistCheckpoint(sender.tab, message.status);
});

chrome.tabs.onActivated.addListener(() => {
  void readStatus();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeTabId && (changeInfo.url || changeInfo.status === "complete")) {
    void readStatus();
  }
});

void readStatus();
window.setInterval(() => {
  if (!startBusy && !htmlExportBusy) {
    void readStatus();
  }
}, 2500);
