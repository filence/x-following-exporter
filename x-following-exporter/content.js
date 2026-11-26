(function () {
  if (window.__xfeContentInjected) {
    return;
  }
  window.__xfeContentInjected = true;

  const PAGE_SOURCE = "XFE_PAGE";
  const CONTENT_SOURCE = "XFE_CONTENT";
  const COMMAND_TIMEOUT_MS = 10000;
  const pendingRequests = new Map();

  let latestStatus = {
    ready: false,
    pageType: "unknown",
    pageUsername: "",
    exportActive: false,
    paused: false,
    mode: "idle",
    count: 0,
    unavailableCount: 0,
    canUseDirect: false,
    done: false,
    seedCaptured: false,
    profileCheck: null,
    rateLimit: null,
    lastError: null,
    lastUpdatedAt: null
  };

  function getTargetOrigin() {
    return window.location.origin && window.location.origin !== "null"
      ? window.location.origin
      : "*";
  }

  function sendPageCommand(command, payload = {}) {
    return new Promise((resolve, reject) => {
      const requestId =
        "xfe_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);

      const timeoutId = window.setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error("页面桥响应超时，请刷新一次当前 X 页面后再试"));
      }, COMMAND_TIMEOUT_MS);

      pendingRequests.set(requestId, { resolve, reject, timeoutId });

      window.postMessage(
        {
          source: CONTENT_SOURCE,
          type: "command",
          requestId,
          command,
          payload
        },
        getTargetOrigin()
      );
    });
  }

  function normalizeStatus(payload) {
    latestStatus = {
      ...latestStatus,
      ...payload,
      ready: true,
      lastUpdatedAt: new Date().toISOString()
    };
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }
    if (
      window.location.origin !== "null" &&
      event.origin !== window.location.origin
    ) {
      return;
    }

    const message = event.data;
    if (!message || message.source !== PAGE_SOURCE) {
      return;
    }

    if (message.type === "response" && message.requestId) {
      const pending = pendingRequests.get(message.requestId);
      if (!pending) {
        return;
      }

      window.clearTimeout(pending.timeoutId);
      pendingRequests.delete(message.requestId);

      if (message.ok) {
        pending.resolve(message.payload);
      } else {
        pending.reject(new Error(message.error || "page bridge command failed"));
      }
      return;
    }

    if (message.type === "status") {
      normalizeStatus(message.payload || {});
      chrome.runtime
        .sendMessage({
          action: "xfe:statusPush",
          tabUrl: window.location.href,
          status: latestStatus
        })
        .catch(() => {});
    }
  });

  const ACTION_TO_COMMAND = {
    "xfe:getStatus": "getStatus",
    "xfe:getKnownProfileCount": "getKnownProfileCount",
    "xfe:startExport": "startExport",
    "xfe:pauseExport": "pauseExport",
    "xfe:resumeExport": "resumeExport",
    "xfe:stopExport": "stopExport",
    "xfe:restoreSession": "restoreSession",
    "xfe:clearSession": "clearSession",
    "xfe:getData": "getData",
    "xfe:getLogs": "getLogs",
    "xfe:getProfileFollowingCount": "getProfileFollowingCount"
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.action !== "string") {
      return false;
    }

    if (message.action === "xfe:ping") {
      sendResponse({ ok: true });
      return false;
    }

    const command = ACTION_TO_COMMAND[message.action];
    if (!command) {
      return false;
    }

    (async () => {
      try {
        const result = await sendPageCommand(command, message.payload || {});
        if (command === "getStatus") {
          normalizeStatus(result || {});
          sendResponse({ ok: true, status: latestStatus });
          return;
        }
        sendResponse({ ok: true, result });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (command === "getStatus") {
          sendResponse({
            ok: false,
            error: errorMessage,
            status: latestStatus
          });
          return;
        }
        sendResponse({ ok: false, error: errorMessage });
      }
    })();

    return true;
  });
})();
