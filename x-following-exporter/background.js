const TEMP_TABS_KEY = "xfeTempProfileTabIds";

async function configureSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn("[XFE] setPanelBehavior failed:", error);
  }
}

async function trackTempTab(tabId) {
  const { [TEMP_TABS_KEY]: ids = [] } = await chrome.storage.session.get(TEMP_TABS_KEY);
  const next = Array.from(new Set([...ids, tabId]));
  await chrome.storage.session.set({ [TEMP_TABS_KEY]: next });
}

async function untrackTempTab(tabId) {
  const { [TEMP_TABS_KEY]: ids = [] } = await chrome.storage.session.get(TEMP_TABS_KEY);
  const next = ids.filter((id) => id !== tabId);
  await chrome.storage.session.set({ [TEMP_TABS_KEY]: next });
}

async function cleanupOrphanTempTabs() {
  const { [TEMP_TABS_KEY]: ids = [] } = await chrome.storage.session.get(TEMP_TABS_KEY);
  if (!Array.isArray(ids) || !ids.length) {
    return;
  }
  for (const tabId of ids) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Tab already closed
    }
  }
  await chrome.storage.session.set({ [TEMP_TABS_KEY]: [] });
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("主页标签页加载超时");
}

async function verifyProfileFollowingCountInBackground(username, origin = "https://x.com") {
  const cleanUsername = String(username || "").trim();
  if (!cleanUsername) {
    return {
      profileUsername: "",
      expectedFollowingCount: null,
      checkedAt: new Date().toISOString(),
      profileCheckSource: "",
      profileCheckError: "未能识别账号用户名"
    };
  }

  const safeOrigin = origin === "https://twitter.com" ? "https://twitter.com" : "https://x.com";
  const profileUrl = `${safeOrigin}/${encodeURIComponent(cleanUsername)}`;
  let backgroundTab = null;

  try {
    backgroundTab = await chrome.tabs.create({
      url: profileUrl,
      active: false
    });
    if (backgroundTab.id != null) {
      await trackTempTab(backgroundTab.id);
    }

    await waitForTabComplete(backgroundTab.id, 15000);

    let lastError = "主页关注数量尚未加载完成";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await chrome.tabs.sendMessage(backgroundTab.id, {
          action: "xfe:getProfileFollowingCount"
        });
        if (
          response &&
          response.ok &&
          response.result &&
          typeof response.result.followingCount === "number" &&
          Number.isFinite(response.result.followingCount)
        ) {
          return {
            profileUsername: response.result.username || cleanUsername,
            expectedFollowingCount: Math.round(response.result.followingCount),
            checkedAt: new Date().toISOString(),
            profileCheckSource: response.result.source || "background-profile-tab",
            profileCheckError: ""
          };
        }
        lastError = (response && response.error) || lastError;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 450));
    }

    return {
      profileUsername: cleanUsername,
      expectedFollowingCount: null,
      checkedAt: new Date().toISOString(),
      profileCheckSource: "background-profile-tab",
      profileCheckError: lastError
    };
  } catch (error) {
    return {
      profileUsername: cleanUsername,
      expectedFollowingCount: null,
      checkedAt: new Date().toISOString(),
      profileCheckSource: "background-profile-tab",
      profileCheckError: error instanceof Error ? error.message : String(error)
    };
  } finally {
    if (backgroundTab && backgroundTab.id != null) {
      try {
        await chrome.tabs.remove(backgroundTab.id);
      } catch {
        // Ignore if user closed tab manually
      }
      await untrackTempTab(backgroundTab.id);
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void configureSidePanel();
  void cleanupOrphanTempTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void configureSidePanel();
  void cleanupOrphanTempTabs();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.action !== "string") {
    return false;
  }

  if (message.action === "xfe:bgVerifyProfileCount") {
    (async () => {
      try {
        const result = await verifyProfileFollowingCountInBackground(
          message.username,
          message.origin
        );
        sendResponse({ ok: true, result });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })();
    return true;
  }

  return false;
});

void configureSidePanel();
