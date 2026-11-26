(function () {
  if (window.__xfePageBridgeInjected) {
    return;
  }
  window.__xfePageBridgeInjected = true;

  const PAGE_SOURCE = "XFE_PAGE";
  const CONTENT_SOURCE = "XFE_CONTENT";
  const nativeFetch = window.fetch.bind(window);
  const NativeXHR = window.XMLHttpRequest;
  const MAX_DIRECT_PAGES = 1000;
  const MAX_RATE_LIMIT_AUTO_WAIT_MS = 180000;
  const MAX_CONSECUTIVE_429 = 3;

  function getTargetOrigin() {
    return window.location.origin && window.location.origin !== "null"
      ? window.location.origin
      : "*";
  }

  function createDebugState() {
    return {
      lastSource: "",
      lastRelevantUrl: "",
      lastAddedCount: 0,
      lastAddedUsername: "",
      lastAddedUserId: "",
      lastBottomCursor: "",
      lastDirectCursor: "",
      lastNextCursor: "",
      lastStopReason: "",
      directPageCount: 0,
      stagnantRounds: 0,
      requestCacheSize: 0,
      forceScrollMode: false,
      unavailableCount: 0,
      logCount: 0,
      recentEvents: []
    };
  }

  function createIdleProfileCheck() {
    return {
      status: "idle",
      username: "",
      expectedFollowingCount: null,
      checkedAt: "",
      source: "",
      error: ""
    };
  }

  function createRateLimitState() {
    return {
      remaining: null,
      limit: null,
      resetAt: null,
      waitingUntil: null
    };
  }

  const state = {
    sessionUsername: "",
    targetUsername: "",
    targetUserId: "",
    exportActive: false,
    paused: false,
    mode: "idle",
    count: 0,
    unavailableCount: 0,
    done: false,
    canUseDirect: false,
    seedCaptured: false,
    lastError: null,
    lastCursor: null,
    directLoopRunning: false,
    scrollTimer: null,
    scrollMode: "fallback-scroll",
    noChangeCount: 0,
    lastHeight: 0,
    lastScrollUserCount: 0,
    users: [],
    usersByKey: new Map(),
    unavailableEntryIds: new Set(),
    seenCursors: new Set(),
    requestCache: [],
    followingSeed: null,
    forceScrollMode: false,
    knownProfilesByUsername: new Map(),
    profileCheck: createIdleProfileCheck(),
    rateLimit: createRateLimitState(),
    waitAbortController: null,
    debug: createDebugState(),
    runLogs: []
  };

  function toFiniteNonNegativeInt(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    const num = Number(value);
    if (!Number.isFinite(num) || num < 0) {
      return null;
    }
    return Math.round(num);
  }

  function pickNumber(...candidates) {
    for (const candidate of candidates) {
      const parsed = toFiniteNonNegativeInt(candidate);
      if (parsed !== null) {
        return parsed;
      }
    }
    return 0;
  }

  function pickNullableNumber(...candidates) {
    for (const candidate of candidates) {
      const parsed = toFiniteNonNegativeInt(candidate);
      if (parsed !== null) {
        return parsed;
      }
    }
    return null;
  }

  function compareSortIndex(a, b) {
    if (!a || !b) {
      return 0;
    }
    try {
      const ai = BigInt(String(a));
      const bi = BigInt(String(b));
      if (bi > ai) return 1;
      if (bi < ai) return -1;
      return 0;
    } catch {
      return String(b).localeCompare(String(a));
    }
  }

  function pushDebugEvent(message, level = "info") {
    const isoTime = new Date().toISOString();
    const localTime = new Date(isoTime).toLocaleTimeString("zh-CN", { hour12: false });
    const entry = {
      at: isoTime,
      localTime,
      level,
      message,
      mode: state.mode,
      count: state.users.length,
      unavailableCount: state.unavailableCount,
      cursor: state.lastCursor || "",
      stopReason: state.debug.lastStopReason || ""
    };
    state.runLogs.push(entry);
    if (state.runLogs.length > 2000) {
      state.runLogs.shift();
    }
    state.debug.logCount = state.runLogs.length;
    state.debug.recentEvents.unshift("[" + localTime + "] " + message);
    if (state.debug.recentEvents.length > 12) {
      state.debug.recentEvents.length = 12;
    }
  }

  function setStopReason(reason) {
    state.debug.lastStopReason = reason || "";
  }

  function getPageType() {
    const path = window.location.pathname;
    if (/\/following(?:\/|$)/.test(path)) {
      return "following";
    }
    if (/\/followers(?:\/|$)/.test(path)) {
      return "followers";
    }
    return "other";
  }

  function getCurrentUsername() {
    const match = window.location.pathname.match(/^\/([^/]+)\/following(?:\/|$)/);
    return match ? match[1] : null;
  }

  function getCurrentUsernameLower() {
    const username = getCurrentUsername();
    return username ? username.toLowerCase() : "";
  }

  function getProfilePageUsername() {
    const match = window.location.pathname.match(/^\/([^/?#]+)\/?$/);
    if (!match) {
      return null;
    }
    const reserved = new Set([
      "home",
      "explore",
      "notifications",
      "messages",
      "bookmarks",
      "lists",
      "settings",
      "search",
      "compose",
      "i"
    ]);
    return reserved.has(match[1].toLowerCase()) ? null : match[1];
  }

  function isFollowingPage() {
    return getPageType() === "following";
  }

  function abortActiveWait() {
    if (state.waitAbortController) {
      state.waitAbortController.abort();
      state.waitAbortController = null;
    }
    state.rateLimit.waitingUntil = null;
  }

  function stopFallbackScroll() {
    if (state.scrollTimer) {
      window.clearTimeout(state.scrollTimer);
      state.scrollTimer = null;
    }
  }

  function clearAccountSessionState(reason) {
    stopFallbackScroll();
    abortActiveWait();
    state.exportActive = false;
    state.paused = false;
    state.mode = "idle";
    state.done = false;
    state.canUseDirect = false;
    state.seedCaptured = false;
    state.lastError = null;
    state.lastCursor = null;
    state.users = [];
    state.usersByKey = new Map();
    state.unavailableEntryIds = new Set();
    state.unavailableCount = 0;
    state.count = 0;
    state.seenCursors = new Set();
    state.requestCache = [];
    state.followingSeed = null;
    state.forceScrollMode = false;
    state.targetUserId = "";
    state.profileCheck = createIdleProfileCheck();
    state.rateLimit = createRateLimitState();
    state.debug = createDebugState();
    state.runLogs = [];
    if (reason) {
      pushDebugEvent(reason);
    }
  }

  function syncRouteContext() {
    const currentUsername = getCurrentUsername();
    const currentLower = currentUsername ? currentUsername.toLowerCase() : "";

    if (!currentLower) {
      return;
    }

    if (state.sessionUsername && state.sessionUsername !== currentLower) {
      clearAccountSessionState(
        "检测到切换目标账号 @" + currentUsername + "，已重置采集会话与种子"
      );
      state.sessionUsername = currentLower;
      state.targetUsername = currentUsername;
      const known = state.knownProfilesByUsername.get(currentLower);
      if (known && known.userId) {
        state.targetUserId = known.userId;
      }
      postStatus();
      return;
    }

    if (!state.sessionUsername) {
      state.sessionUsername = currentLower;
      state.targetUsername = currentUsername;
      const known = state.knownProfilesByUsername.get(currentLower);
      if (known && known.userId) {
        state.targetUserId = known.userId;
      }
    }
  }

  function getDebugSnapshot() {
    return {
      ...state.debug,
      lastCursor: state.lastCursor || "",
      requestCacheSize: state.requestCache.length,
      forceScrollMode: state.forceScrollMode,
      unavailableCount: state.unavailableCount,
      logCount: state.runLogs.length
    };
  }

  function buildStatusPayload(extra = {}) {
    const currentUsername = getCurrentUsername() || state.targetUsername || "";
    const knownProfile = currentUsername
      ? state.knownProfilesByUsername.get(currentUsername.toLowerCase()) || null
      : null;

    return {
      ready: true,
      pageType: getPageType(),
      pageUsername: currentUsername,
      targetUserId: state.targetUserId || (knownProfile ? knownProfile.userId : ""),
      exportActive: state.exportActive,
      paused: state.paused,
      mode: state.mode,
      count: state.users.length,
      unavailableCount: state.unavailableCount,
      canUseDirect: state.canUseDirect,
      done: state.done,
      seedCaptured: state.seedCaptured,
      lastCursor: state.lastCursor || "",
      knownProfileCount: knownProfile ? knownProfile.followingCount : null,
      profileCheck: { ...state.profileCheck },
      rateLimit: { ...state.rateLimit },
      lastError: state.lastError,
      debug: getDebugSnapshot(),
      ...extra
    };
  }

  function postStatus(extra = {}) {
    window.postMessage(
      {
        source: PAGE_SOURCE,
        type: "status",
        payload: buildStatusPayload(extra)
      },
      getTargetOrigin()
    );
  }

  function postResponse(requestId, ok, payload, error) {
    window.postMessage(
      {
        source: PAGE_SOURCE,
        type: "response",
        requestId,
        ok,
        payload,
        error
      },
      getTargetOrigin()
    );
  }

  function jitterDelay(minMs, maxMs) {
    const span = Math.max(0, maxMs - minMs);
    const ms = minMs + Math.floor(Math.random() * (span + 1));
    return waitInterruptible(ms, false);
  }

  function waitInterruptible(ms, publishCountdown = false) {
    abortActiveWait();
    const controller = new AbortController();
    state.waitAbortController = controller;
    const targetEnd = Date.now() + ms;
    if (publishCountdown) {
      state.rateLimit.waitingUntil = new Date(targetEnd).toISOString();
      postStatus();
    }

    return new Promise((resolve) => {
      let tickId = null;
      const cleanup = () => {
        if (tickId) {
          window.clearInterval(tickId);
          tickId = null;
        }
        if (state.waitAbortController === controller) {
          state.waitAbortController = null;
        }
        if (publishCountdown) {
          state.rateLimit.waitingUntil = null;
        }
      };

      const timeoutId = window.setTimeout(() => {
        cleanup();
        resolve(true);
      }, ms);

      if (publishCountdown) {
        tickId = window.setInterval(() => {
          postStatus();
        }, 1000);
      }

      controller.signal.addEventListener(
        "abort",
        () => {
          window.clearTimeout(timeoutId);
          cleanup();
          resolve(false);
        },
        { once: true }
      );
    });
  }

  function parseDisplayedCount(input) {
    const text = String(input || "")
      .replace(/\s+/g, " ")
      .trim();
    const match = text.match(/([\d.,]+)\s*([KMB]|万|亿)?/i);
    if (!match) {
      return null;
    }

    const rawNumber = match[1].replace(/,/g, "");
    const base = Number(rawNumber);
    if (!Number.isFinite(base)) {
      return null;
    }

    const unit = (match[2] || "").toUpperCase();
    const multipliers = {
      K: 1e3,
      M: 1e6,
      B: 1e9,
      "万": 1e4,
      "亿": 1e8
    };
    const multiplier = multipliers[unit] || 1;
    return Math.round(base * multiplier);
  }

  function getKnownProfileCount() {
    syncRouteContext();
    const username = getCurrentUsername() || getProfilePageUsername();
    if (!username) {
      return null;
    }
    const known = state.knownProfilesByUsername.get(username.toLowerCase());
    if (!known || known.followingCount === null) {
      return null;
    }
    return {
      username: known.username,
      userId: known.userId,
      followingCount: known.followingCount,
      source: "graphql-profile"
    };
  }

  function getProfileFollowingCount() {
    const username = getProfilePageUsername();
    if (!username) {
      throw new Error("当前不是账号主页");
    }

    const known = state.knownProfilesByUsername.get(username.toLowerCase());
    if (known && known.followingCount !== null) {
      return {
        username: known.username,
        userId: known.userId,
        followingCount: known.followingCount,
        source: "graphql-profile"
      };
    }

    const expectedPathLower = ("/" + username + "/following").toLowerCase();
    const anchors = Array.from(document.querySelectorAll('a[href*="/following"]'));
    for (const anchor of anchors) {
      let pathname = "";
      try {
        pathname = new URL(anchor.href, window.location.origin).pathname;
      } catch {
        pathname = "";
      }

      if (pathname.toLowerCase() !== expectedPathLower) {
        continue;
      }

      const count = parseDisplayedCount(
        anchor.textContent || anchor.getAttribute("aria-label") || ""
      );
      if (Number.isFinite(count)) {
        return {
          username,
          followingCount: count,
          source: "profile-link"
        };
      }
    }

    throw new Error("主页关注数量尚未加载完成");
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function normalizeHeaders(input, init) {
    const headers = {};

    function absorb(value) {
      if (!value) {
        return;
      }

      if (value instanceof Headers) {
        for (const [key, headerValue] of value.entries()) {
          headers[key.toLowerCase()] = headerValue;
        }
        return;
      }

      if (Array.isArray(value)) {
        for (const entry of value) {
          if (Array.isArray(entry) && entry.length >= 2) {
            headers[String(entry[0]).toLowerCase()] = String(entry[1]);
          }
        }
        return;
      }

      if (typeof value === "object") {
        for (const [key, headerValue] of Object.entries(value)) {
          headers[key.toLowerCase()] = String(headerValue);
        }
      }
    }

    try {
      if (input instanceof Request) {
        absorb(input.headers);
      }
    } catch {
      // Ignore Request header access failure
    }

    absorb(init && init.headers);
    return headers;
  }

  function buildRequestHeaders(rawHeaders) {
    const allowed = [
      "authorization",
      "x-csrf-token",
      "x-twitter-active-user",
      "x-twitter-auth-type",
      "x-client-transaction-id",
      "x-client-uuid",
      "x-twitter-client-language",
      "accept"
    ];

    const headers = {};
    for (const key of allowed) {
      if (rawHeaders && rawHeaders[key]) {
        headers[key] = rawHeaders[key];
      }
    }

    if (!headers.accept) {
      headers.accept = "application/json, text/plain, */*";
    }

    return headers;
  }

  function isFollowingEndpoint(url) {
    return typeof url === "string" && /\/i\/api\/graphql\/[^/]+\/Following(?:\?|$)/.test(url);
  }

  function isUserProfileEndpoint(url) {
    return (
      typeof url === "string" &&
      /\/i\/api\/graphql\/[^/]+\/(?:UserByScreenName|UserByRestId)(?:\?|$)/.test(url)
    );
  }

  function extractFollowingUserIdFromUrl(url) {
    try {
      const parsed = new URL(url, window.location.origin);
      const variables = safeJsonParse(parsed.searchParams.get("variables") || "{}") || {};
      return variables.userId ? String(variables.userId) : "";
    } catch {
      return "";
    }
  }

  function extractProfileSnapshot(parsedData) {
    const candidates = [];

    function walk(node, depth = 0) {
      if (!node || typeof node !== "object" || depth > 8) {
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) {
          walk(item, depth + 1);
        }
        return;
      }
      if (
        node.__typename === "User" &&
        (node.rest_id || (node.legacy && node.legacy.id_str)) &&
        ((node.core && node.core.screen_name) || (node.legacy && node.legacy.screen_name))
      ) {
        candidates.push(node);
        return;
      }
      for (const value of Object.values(node)) {
        walk(value, depth + 1);
      }
    }

    walk(parsedData);
    const first = candidates[0];
    if (!first) {
      return null;
    }

    const username =
      (first.core && first.core.screen_name) ||
      (first.legacy && first.legacy.screen_name) ||
      "";
    const userId = String(first.rest_id || (first.legacy && first.legacy.id_str) || "");
    const followingCount = pickNullableNumber(
      first.relationship_counts && first.relationship_counts.following,
      first.legacy && first.legacy.friends_count
    );

    if (!username) {
      return null;
    }

    return {
      username,
      usernameLower: username.toLowerCase(),
      userId,
      followingCount
    };
  }

  function rememberKnownProfile(snapshot) {
    if (!snapshot || !snapshot.usernameLower) {
      return;
    }
    state.knownProfilesByUsername.set(snapshot.usernameLower, snapshot);
    if (state.knownProfilesByUsername.size > 50) {
      const oldestKey = state.knownProfilesByUsername.keys().next().value;
      if (oldestKey) {
        state.knownProfilesByUsername.delete(oldestKey);
      }
    }

    const currentLower = getCurrentUsernameLower();
    if (currentLower && snapshot.usernameLower === currentLower) {
      if (snapshot.userId) {
        state.targetUserId = snapshot.userId;
      }
      postStatus();
    }
  }

  function isFollowingUrlForCurrentTarget(url) {
    syncRouteContext();
    if (!isFollowingPage()) {
      return false;
    }
    const urlUserId = extractFollowingUserIdFromUrl(url);
    const currentLower = getCurrentUsernameLower();
    const known = currentLower ? state.knownProfilesByUsername.get(currentLower) : null;
    const expectedUserId = state.targetUserId || (known ? known.userId : "");
    if (expectedUserId && urlUserId && expectedUserId !== urlUserId) {
      return false;
    }
    return true;
  }

  function captureSeed(url, headers) {
    if (!isFollowingEndpoint(url) || !isFollowingUrlForCurrentTarget(url)) {
      return;
    }

    try {
      const parsed = new URL(url, window.location.origin);
      const pathParts = parsed.pathname.split("/").filter(Boolean);
      const queryId = pathParts[pathParts.length - 2];
      const operationName = pathParts[pathParts.length - 1];
      const variables = safeJsonParse(parsed.searchParams.get("variables") || "{}") || {};
      const features = safeJsonParse(parsed.searchParams.get("features") || "{}") || {};
      const fieldToggles = safeJsonParse(parsed.searchParams.get("fieldToggles") || "");
      const targetUserId = variables.userId ? String(variables.userId) : "";
      const capturedForUsername = getCurrentUsernameLower();

      state.followingSeed = {
        origin: parsed.origin,
        queryId,
        operationName,
        variables,
        features,
        fieldToggles,
        headers,
        targetUserId,
        capturedForUsername
      };
      if (targetUserId) {
        state.targetUserId = targetUserId;
      }
      state.seedCaptured = true;
      state.canUseDirect = true;
      pushDebugEvent("已捕获 Following 种子 (userId=" + (targetUserId || "unknown") + ")");
      postStatus();
    } catch (error) {
      state.lastError = "seed_parse_failed: " + error.message;
      setStopReason("seed_parse_failed");
      pushDebugEvent("种子解析失败: " + error.message, "error");
      postStatus();
    }
  }

  function rememberPayload(url, parsedData, targetUserId) {
    state.requestCache.push({
      url,
      parsedData,
      targetUserId: targetUserId || "",
      usernameLower: getCurrentUsernameLower()
    });
    if (state.requestCache.length > 20) {
      state.requestCache.shift();
    }
    state.debug.requestCacheSize = state.requestCache.length;
  }

  function extractUrlEntities(entityList) {
    if (!Array.isArray(entityList)) {
      return [];
    }
    const out = [];
    for (const item of entityList) {
      if (!item || typeof item !== "object" || typeof item.url !== "string") {
        continue;
      }
      out.push({
        url: item.url,
        expanded_url: typeof item.expanded_url === "string" ? item.expanded_url : item.url,
        display_url:
          typeof item.display_url === "string"
            ? item.display_url
            : item.expanded_url || item.url
      });
    }
    return out;
  }

  function toUserRecord(result, sortIndex = "") {
    if (!result || typeof result !== "object") {
      return null;
    }

    if (result.__typename === "UserUnavailable") {
      return {
        __unavailable: true,
        reason: String(result.reason || result.message || "unavailable")
      };
    }

    const legacy = result.legacy || {};
    const core = result.core || {};
    const verification = result.verification || {};
    const profileBio = result.profile_bio || {};
    const relationshipCounts = result.relationship_counts || {};
    const tweetCounts = result.tweet_counts || {};
    const actionCounts = result.action_counts || {};
    const dmPermissions = result.dm_permissions || {};
    const privacy = result.privacy || {};
    const perspectives = result.relationship_perspectives || {};

    const username = core.screen_name || legacy.screen_name;
    const userId = result.rest_id || legacy.id_str || null;

    if (!username) {
      return null;
    }

    const descriptionUrls = extractUrlEntities(
      (profileBio.entities &&
        profileBio.entities.description &&
        profileBio.entities.description.urls) ||
        (legacy.entities && legacy.entities.description && legacy.entities.description.urls)
    );
    const websiteEntities = extractUrlEntities(
      (profileBio.entities && profileBio.entities.url && profileBio.entities.url.urls) ||
        (legacy.entities && legacy.entities.url && legacy.entities.url.urls)
    );
    const rawWebsite = (result.website && result.website.url) || legacy.url || "";
    const expandedWebsite =
      (websiteEntities.find((item) => item.expanded_url) || {}).expanded_url || rawWebsite;

    const followedBy =
      typeof perspectives.followed_by === "boolean"
        ? perspectives.followed_by
        : typeof legacy.followed_by === "boolean"
          ? legacy.followed_by
          : null;

    const following =
      typeof perspectives.following === "boolean"
        ? perspectives.following
        : typeof legacy.following === "boolean"
          ? legacy.following
          : null;

    return {
      name: core.name || legacy.name || "",
      username,
      user_id: userId,
      description:
        profileBio.description !== undefined
          ? profileBio.description
          : legacy.description || "",
      description_urls: descriptionUrls,
      website: expandedWebsite,
      created_at: core.created_at || legacy.created_at || "",
      followers_count: pickNumber(relationshipCounts.followers, legacy.followers_count, 0),
      following_count: pickNumber(relationshipCounts.following, legacy.friends_count, 0),
      favourites_count: pickNumber(actionCounts.favorites_count, legacy.favourites_count, 0),
      listed_count: pickNullableNumber(legacy.listed_count),
      media_count: pickNumber(tweetCounts.media_tweets, legacy.media_count, 0),
      posts_count: pickNumber(tweetCounts.tweets, legacy.statuses_count, 0),
      can_dm: Boolean(
        dmPermissions.can_dm !== undefined ? dmPermissions.can_dm : legacy.can_dm
      ),
      protected: Boolean(privacy.protected !== undefined ? privacy.protected : legacy.protected),
      followed_by: followedBy,
      following,
      verified: Boolean(verification.verified === true || legacy.verified === true),
      verified_type: verification.verified_type || legacy.verified_type || "",
      blue_verified: Boolean(result.is_blue_verified === true),
      professional: Boolean(result.professional && result.professional.rest_id),
      location: (result.location && result.location.location) || legacy.location || "",
      avatar_url:
        (result.avatar && result.avatar.image_url) || legacy.profile_image_url_https || "",
      banner_url:
        (result.banner && result.banner.image_url) || legacy.profile_banner_url || "",
      profile_url: "https://x.com/" + username,
      sort_index: sortIndex ? String(sortIndex) : ""
    };
  }

  function upsertUserEntries(userEntries) {
    let added = 0;
    let unavailableAdded = 0;
    let lastRecord = null;

    for (const item of userEntries) {
      const record = toUserRecord(item.result, item.sortIndex);
      if (!record) {
        continue;
      }

      if (record.__unavailable) {
        const entryKey = item.entryId || "unavailable:" + state.unavailableEntryIds.size;
        if (!state.unavailableEntryIds.has(entryKey)) {
          state.unavailableEntryIds.add(entryKey);
          unavailableAdded += 1;
        }
        continue;
      }

      const key = record.user_id || record.username.toLowerCase();
      if (!key || state.usersByKey.has(key)) {
        continue;
      }

      state.usersByKey.set(key, record);
      state.users.push(record);
      added += 1;
      lastRecord = record;
    }

    state.count = state.users.length;
    state.unavailableCount = state.unavailableEntryIds.size;
    state.debug.unavailableCount = state.unavailableCount;

    if (added > 0 && lastRecord) {
      state.debug.lastAddedCount = added;
      state.debug.lastAddedUsername = lastRecord.username || "";
      state.debug.lastAddedUserId = lastRecord.user_id || "";
    }

    return {
      added,
      unavailableAdded,
      lastRecord
    };
  }

  function readBottomCursorFromEntry(entry) {
    if (!entry || typeof entry !== "object") {
      return null;
    }

    if (
      typeof entry.entryId === "string" &&
      entry.entryId.includes("cursor-bottom") &&
      entry.content &&
      typeof entry.content.value === "string"
    ) {
      return entry.content.value;
    }

    if (
      entry.content &&
      entry.content.entryType === "TimelineTimelineCursor" &&
      entry.content.cursorType === "Bottom" &&
      typeof entry.content.value === "string"
    ) {
      return entry.content.value;
    }

    return null;
  }

  function readUserEntryFromEntry(entry) {
    if (!entry || typeof entry !== "object") {
      return null;
    }

    if (
      typeof entry.entryId === "string" &&
      entry.entryId.startsWith("user-") &&
      entry.content &&
      entry.content.itemContent &&
      entry.content.itemContent.user_results &&
      entry.content.itemContent.user_results.result
    ) {
      return {
        entryId: entry.entryId,
        sortIndex: entry.sortIndex || "",
        result: entry.content.itemContent.user_results.result
      };
    }

    return null;
  }

  function extractTimelineArtifacts(node, bucket) {
    if (!node || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        extractTimelineArtifacts(item, bucket);
      }
      return;
    }

    if (Array.isArray(node.instructions)) {
      for (const instruction of node.instructions) {
        const entries = [];
        if (Array.isArray(instruction && instruction.entries)) {
          entries.push(...instruction.entries);
        }
        if (instruction && instruction.entry) {
          entries.push(instruction.entry);
        }

        const sortedEntries = entries
          .slice()
          .sort((a, b) => compareSortIndex(a && a.sortIndex, b && b.sortIndex));

        for (const entry of sortedEntries) {
          const cursor = readBottomCursorFromEntry(entry);
          if (cursor) {
            bucket.bottomCursor = cursor;
          }

          const userEntry = readUserEntryFromEntry(entry);
          if (userEntry) {
            bucket.userEntries.push(userEntry);
          }
        }
      }
    }

    for (const value of Object.values(node)) {
      extractTimelineArtifacts(value, bucket);
    }
  }

  function handleCapturedPayload(url, parsedData, options = {}) {
    const { cache = true, recordUsers = true } = options;
    const targetUserId = extractFollowingUserIdFromUrl(url) || state.targetUserId;
    if (cache) {
      rememberPayload(url, parsedData, targetUserId);
    }
    if (!recordUsers) {
      return { added: 0, unavailableAdded: 0, bottomCursor: null };
    }

    const bucket = {
      userEntries: [],
      bottomCursor: null
    };
    extractTimelineArtifacts(parsedData, bucket);

    const upsertResult = upsertUserEntries(bucket.userEntries);
    const added = upsertResult.added;
    state.debug.lastSource = url || "";
    state.debug.lastRelevantUrl = url || "";
    if (bucket.bottomCursor) {
      state.lastCursor = bucket.bottomCursor;
      state.debug.lastBottomCursor = bucket.bottomCursor;
    }

    if (added > 0 || upsertResult.unavailableAdded > 0 || bucket.bottomCursor) {
      if (added > 0) {
        const addedLabel = upsertResult.lastRecord
          ? " @" + upsertResult.lastRecord.username
          : "";
        pushDebugEvent("采到 " + added + " 条" + addedLabel);
      }
      if (upsertResult.unavailableAdded > 0) {
        pushDebugEvent(
          "跳过 " + upsertResult.unavailableAdded + " 条已封禁/不可用账号",
          "warn"
        );
      }
      if (bucket.bottomCursor) {
        pushDebugEvent("更新 cursor");
      }
      postStatus();
    }

    return {
      added,
      unavailableAdded: upsertResult.unavailableAdded,
      bottomCursor: bucket.bottomCursor
    };
  }

  function processInterceptedJson(url, headers, parsedData) {
    if (isUserProfileEndpoint(url)) {
      const snapshot = extractProfileSnapshot(parsedData);
      if (snapshot) {
        rememberKnownProfile(snapshot);
      }
      return;
    }

    if (!isFollowingEndpoint(url)) {
      return;
    }

    if (!isFollowingUrlForCurrentTarget(url)) {
      pushDebugEvent("忽略非当前目标账号的 Following 响应", "warn");
      return;
    }

    captureSeed(url, headers);
    const shouldRecord = state.exportActive && !state.paused;
    handleCapturedPayload(url, parsedData, {
      cache: true,
      recordUsers: shouldRecord
    });

    if (
      state.exportActive &&
      !state.paused &&
      state.canUseDirect &&
      !state.directLoopRunning &&
      !state.forceScrollMode
    ) {
      void startDirectLoop({ resume: state.users.length > 0 && Boolean(state.lastCursor) });
    }
  }

  async function interceptFetchResult(input, init, response) {
    try {
      const url = typeof input === "string" ? input : input && input.url ? input.url : "";
      if (!isFollowingEndpoint(url) && !isUserProfileEndpoint(url)) {
        return;
      }

      const cloned = response.clone();
      const contentType = cloned.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        return;
      }

      const headers = normalizeHeaders(input, init);
      const text = await cloned.text();
      const parsedData = safeJsonParse(text);
      if (!parsedData) {
        return;
      }

      processInterceptedJson(url, headers, parsedData);
    } catch (error) {
      state.lastError = "intercept_fetch_failed: " + error.message;
      postStatus();
    }
  }

  function interceptXhrResult(xhr) {
    try {
      const url = typeof xhr.__xfeUrl === "string" ? xhr.__xfeUrl : "";
      if (!isFollowingEndpoint(url) && !isUserProfileEndpoint(url)) {
        return;
      }

      const contentType = xhr.getResponseHeader("content-type") || "";
      if (!contentType.includes("application/json")) {
        return;
      }

      let text = "";
      if (xhr.responseType === "" || xhr.responseType === "text") {
        text = xhr.responseText;
      } else if (xhr.responseType === "json" && xhr.response) {
        text = JSON.stringify(xhr.response);
      }

      const parsedData = safeJsonParse(text);
      if (!parsedData) {
        return;
      }

      processInterceptedJson(url, xhr.__xfeHeaders || {}, parsedData);
    } catch (error) {
      state.lastError = "intercept_xhr_failed: " + error.message;
      postStatus();
    }
  }

  window.fetch = new Proxy(window.fetch, {
    apply(target, thisArg, args) {
      return target.apply(thisArg, args).then((response) => {
        void interceptFetchResult(args[0], args[1], response);
        return response;
      });
    }
  });

  window.XMLHttpRequest = new Proxy(NativeXHR, {
    construct(target, args) {
      const xhr = new target(...args);
      const originalOpen = xhr.open;
      const originalSetRequestHeader = xhr.setRequestHeader;
      const originalSend = xhr.send;

      xhr.__xfeHeaders = {};

      xhr.open = function (method, url) {
        xhr.__xfeMethod = method;
        xhr.__xfeUrl = url;
        return originalOpen.apply(this, arguments);
      };

      xhr.setRequestHeader = function (header, value) {
        xhr.__xfeHeaders[String(header).toLowerCase()] = String(value);
        return originalSetRequestHeader.apply(this, arguments);
      };

      xhr.send = function () {
        this.addEventListener(
          "load",
          function () {
            interceptXhrResult(xhr);
          },
          { once: true }
        );
        return originalSend.apply(this, arguments);
      };

      return xhr;
    }
  });

  // SPA navigation hooks so switching target accounts cleanly isolates state
  if (window.history) {
    const origPushState = window.history.pushState;
    const origReplaceState = window.history.replaceState;
    window.history.pushState = function () {
      const result = origPushState.apply(this, arguments);
      syncRouteContext();
      return result;
    };
    window.history.replaceState = function () {
      const result = origReplaceState.apply(this, arguments);
      syncRouteContext();
      return result;
    };
  }
  window.addEventListener("popstate", () => {
    syncRouteContext();
  });

  function startFallbackScroll(modeOverride = "fallback-scroll") {
    stopFallbackScroll();
    state.scrollMode = modeOverride;
    state.mode = modeOverride;
    state.noChangeCount = 0;
    state.lastHeight = document.body ? document.body.scrollHeight : 0;
    state.lastScrollUserCount = state.users.length;
    pushDebugEvent(
      modeOverride === "direct-stalled-scroll"
        ? "直连降级，进入增强滚动补采"
        : "进入增强滚动补采"
    );
    postStatus();

    const scheduleTick = () => {
      const delayMs = 2200 + Math.floor(Math.random() * 600);
      state.scrollTimer = window.setTimeout(() => {
        if (!state.exportActive || state.paused) {
          stopFallbackScroll();
          return;
        }

        if (document.body) {
          window.scrollTo(0, document.body.scrollHeight);
          const currentHeight = document.body.scrollHeight;
          const currentUserCount = state.users.length;

          if (
            currentHeight === state.lastHeight &&
            currentUserCount === state.lastScrollUserCount
          ) {
            state.noChangeCount += 1;
          } else {
            state.noChangeCount = 0;
          }
          state.lastHeight = currentHeight;
          state.lastScrollUserCount = currentUserCount;
          state.debug.stagnantRounds = state.noChangeCount;
        }

        if (
          !state.forceScrollMode &&
          state.canUseDirect &&
          !state.directLoopRunning
        ) {
          stopFallbackScroll();
          void startDirectLoop({ resume: state.users.length > 0 && Boolean(state.lastCursor) });
          return;
        }

        if (state.noChangeCount >= 8) {
          state.exportActive = false;
          state.paused = false;
          state.done = true;
          state.mode = "fallback-complete";
          setStopReason("fallback_no_change_8");
          pushDebugEvent("滚动补采结束: 页面高度与采集数连续 8 轮未变化");
          stopFallbackScroll();
          postStatus();
          return;
        }

        postStatus();
        scheduleTick();
      }, delayMs);
    };

    scheduleTick();
  }

  function updateRateLimitFromHeaders(headers) {
    if (!headers || typeof headers.get !== "function") {
      return;
    }
    const remaining = toFiniteNonNegativeInt(headers.get("x-rate-limit-remaining"));
    const limit = toFiniteNonNegativeInt(headers.get("x-rate-limit-limit"));
    const resetSec = toFiniteNonNegativeInt(headers.get("x-rate-limit-reset"));

    if (remaining !== null) {
      state.rateLimit.remaining = remaining;
    }
    if (limit !== null) {
      state.rateLimit.limit = limit;
    }
    if (resetSec !== null) {
      state.rateLimit.resetAt = new Date(resetSec * 1000).toISOString();
    }
  }

  async function fetchFollowingPage(cursor, retryWithoutTransactionId) {
    if (!state.followingSeed) {
      throw Object.assign(new Error("missing following seed"), { status: 0 });
    }

    const seed = state.followingSeed;
    const variables = { ...seed.variables };
    if (cursor) {
      variables.cursor = cursor;
    } else {
      delete variables.cursor;
    }

    const endpoint =
      seed.origin + "/i/api/graphql/" + seed.queryId + "/" + seed.operationName;
    const params = new URLSearchParams();
    params.set("variables", JSON.stringify(variables));
    params.set("features", JSON.stringify(seed.features || {}));
    if (seed.fieldToggles && Object.keys(seed.fieldToggles).length > 0) {
      params.set("fieldToggles", JSON.stringify(seed.fieldToggles));
    }

    const headers = buildRequestHeaders(seed.headers || {});
    if (retryWithoutTransactionId) {
      delete headers["x-client-transaction-id"];
    }

    const response = await nativeFetch(endpoint + "?" + params.toString(), {
      method: "GET",
      credentials: "include",
      headers
    });

    updateRateLimitFromHeaders(response.headers);

    if (!response.ok) {
      const error = new Error("HTTP " + response.status);
      error.status = response.status;
      error.resetAtMs = state.rateLimit.resetAt ? Date.parse(state.rateLimit.resetAt) : null;
      throw error;
    }

    const text = await response.text();
    const parsed = safeJsonParse(text);
    if (!parsed) {
      const error = new Error("HTTP 200 empty_or_invalid_json");
      error.status = 404;
      throw error;
    }
    return parsed;
  }

  async function fetchFollowingPageWithRetry(cursor) {
    try {
      return await fetchFollowingPage(cursor, false);
    } catch (error) {
      if (error && (error.status === 400 || error.status === 401)) {
        return fetchFollowingPage(cursor, true);
      }
      throw error;
    }
  }

  function replayMatchingCache() {
    const currentLower = getCurrentUsernameLower();
    let replayed = 0;
    for (const cached of state.requestCache) {
      if (cached.usernameLower && currentLower && cached.usernameLower !== currentLower) {
        continue;
      }
      if (state.targetUserId && cached.targetUserId && cached.targetUserId !== state.targetUserId) {
        continue;
      }
      handleCapturedPayload(cached.url, cached.parsedData, {
        cache: false,
        recordUsers: true
      });
      replayed += 1;
    }
    return replayed;
  }

  async function handleRateLimit429(error, consecutive429Count) {
    if (consecutive429Count > MAX_CONSECUTIVE_429) {
      state.paused = true;
      state.exportActive = false;
      state.mode = "direct-paused";
      state.lastError = "连续触发 429 速率限制，已自动暂停并保留当前进度";
      setStopReason("rate_limit_paused");
      pushDebugEvent("连续 429 限流，自动暂停保留进度", "warn");
      postStatus();
      return false;
    }

    const now = Date.now();
    let waitMs = 30000;
    if (error && Number.isFinite(error.resetAtMs) && error.resetAtMs > now) {
      waitMs = error.resetAtMs - now + 2000;
    }

    if (waitMs > MAX_RATE_LIMIT_AUTO_WAIT_MS) {
      const waitSec = Math.ceil(waitMs / 1000);
      state.paused = true;
      state.exportActive = false;
      state.mode = "direct-paused";
      state.lastError = "触发 429 限流（需等待约 " + waitSec + " 秒），已自动暂停，可稍后点继续";
      setStopReason("rate_limit_wait_too_long");
      pushDebugEvent("429 冷却过长 (" + waitSec + "s)，已自动暂停", "warn");
      postStatus();
      return false;
    }

    waitMs = Math.max(10000, waitMs);
    const waitSec = Math.ceil(waitMs / 1000);
    state.mode = "direct-rate-limited";
    pushDebugEvent("触发 429 限流，自动冷却 " + waitSec + " 秒后重试", "warn");
    postStatus();

    const completed = await waitInterruptible(waitMs, true);
    if (!completed || !state.exportActive || state.paused) {
      return false;
    }
    state.mode = "direct";
    postStatus();
    return true;
  }

  async function startDirectLoop(options = {}) {
    const { resume = false } = options;
    if (state.directLoopRunning || !state.exportActive || state.paused || !state.canUseDirect) {
      return;
    }

    state.directLoopRunning = true;
    state.mode = "direct";
    state.done = false;
    state.lastError = null;
    setStopReason("");
    if (!resume) {
      state.debug.directPageCount = 0;
      state.seenCursors = new Set();
    }
    state.debug.stagnantRounds = 0;
    pushDebugEvent(resume ? "从断点继续直连翻页" : "进入直连翻页");
    postStatus();

    let cursor = resume ? state.lastCursor : null;
    let stagnantRounds = 0;
    let pageCount = resume ? state.debug.directPageCount : 0;
    let consecutive429 = 0;
    let shouldContinueWithScroll = false;

    try {
      if (!cursor) {
        state.mode = "direct-fetching-first-page";
        postStatus();

        let firstPageData = null;
        while (state.exportActive && !state.paused) {
          try {
            firstPageData = await fetchFollowingPageWithRetry(null);
            consecutive429 = 0;
            break;
          } catch (error) {
            if (error && error.status === 429) {
              consecutive429 += 1;
              const canRetry = await handleRateLimit429(error, consecutive429);
              if (!canRetry) {
                return;
              }
              continue;
            }
            if (error && (error.status === 404 || error.status === 403)) {
              shouldContinueWithScroll = true;
              setStopReason("direct_blocked_http_" + error.status);
              pushDebugEvent(
                "直连首页返回 HTTP " +
                  error.status +
                  "（可能受 x-client-transaction-id 校验拦截），自动切入滚动补采",
                "warn"
              );
              replayMatchingCache();
              break;
            }
            throw error;
          }
        }

        if (!state.exportActive || state.paused) {
          return;
        }

        if (!shouldContinueWithScroll && firstPageData) {
          handleCapturedPayload("direct-fetch:first-page", firstPageData, {
            cache: false,
            recordUsers: true
          });
          cursor = state.lastCursor;
          pageCount += 1;
          state.debug.directPageCount = pageCount;
          if (!cursor) {
            shouldContinueWithScroll = true;
            setStopReason("first_page_missing_cursor");
          }
        }
      }

      while (
        !shouldContinueWithScroll &&
        state.exportActive &&
        !state.paused &&
        cursor &&
        pageCount < MAX_DIRECT_PAGES
      ) {
        if (state.seenCursors.has(cursor)) {
          shouldContinueWithScroll = true;
          setStopReason("cursor_repeated");
          break;
        }
        state.seenCursors.add(cursor);
        state.debug.lastDirectCursor = cursor;

        const isLowRemaining =
          state.rateLimit.remaining !== null && state.rateLimit.remaining <= 5;
        const waited = isLowRemaining
          ? await jitterDelay(3000, 4500)
          : await jitterDelay(1200, 1800);
        if (!waited || !state.exportActive || state.paused) {
          return;
        }

        let parsedData = null;
        while (state.exportActive && !state.paused) {
          try {
            parsedData = await fetchFollowingPageWithRetry(cursor);
            consecutive429 = 0;
            break;
          } catch (error) {
            if (error && error.status === 429) {
              consecutive429 += 1;
              const canRetry = await handleRateLimit429(error, consecutive429);
              if (!canRetry) {
                return;
              }
              continue;
            }
            if (error && (error.status === 404 || error.status === 403)) {
              shouldContinueWithScroll = true;
              setStopReason("direct_blocked_http_" + error.status);
              pushDebugEvent(
                "直连翻页返回 HTTP " +
                  error.status +
                  "（可能受交易签名/权限限制），切换至滚动补采",
                "warn"
              );
              break;
            }
            throw error;
          }
        }

        if (!state.exportActive || state.paused) {
          return;
        }
        if (shouldContinueWithScroll || !parsedData) {
          break;
        }

        const beforeCount = state.users.length;
        const previousCursor = cursor;
        handleCapturedPayload("direct-fetch", parsedData, {
          cache: false,
          recordUsers: true
        });
        const nextCursor = state.lastCursor;
        const afterCount = state.users.length;
        pageCount += 1;
        state.debug.directPageCount = pageCount;
        state.debug.lastNextCursor = nextCursor || "";

        if (!nextCursor) {
          shouldContinueWithScroll = true;
          setStopReason("next_cursor_missing");
          break;
        }

        if (nextCursor === previousCursor || state.seenCursors.has(nextCursor)) {
          stagnantRounds += 1;
          state.debug.stagnantRounds = stagnantRounds;
          setStopReason(
            nextCursor === previousCursor ? "cursor_unchanged" : "next_cursor_repeated"
          );
        } else if (afterCount === beforeCount) {
          stagnantRounds += 1;
          state.debug.stagnantRounds = stagnantRounds;
          setStopReason("page_without_new_users");
        } else {
          stagnantRounds = 0;
          state.debug.stagnantRounds = 0;
        }

        if (stagnantRounds >= 3) {
          shouldContinueWithScroll = true;
          setStopReason("stagnant_rounds_reached");
          break;
        }

        cursor = nextCursor;
      }

      if (!state.exportActive || state.paused) {
        return;
      }

      if (shouldContinueWithScroll) {
        state.forceScrollMode = true;
        pushDebugEvent("直连停滞或受限，切入滚动补采收尾");
        startFallbackScroll("direct-stalled-scroll");
        return;
      }

      state.done = true;
      state.exportActive = false;
      state.paused = false;
      state.mode = "direct-complete";
      setStopReason("direct_complete");
      pushDebugEvent("直连翻页完成");
      postStatus();
    } catch (error) {
      state.exportActive = false;
      state.paused = false;
      state.lastError = "direct_fetch_failed: " + error.message;
      state.mode = "direct-error";
      setStopReason("direct_fetch_failed");
      pushDebugEvent("直连翻页报错: " + error.message, "error");
      postStatus();
    } finally {
      state.directLoopRunning = false;
      if (state.exportActive && !state.paused && !state.done && !state.canUseDirect) {
        startFallbackScroll("fallback-scroll");
      }
    }
  }

  async function startExport(options = {}) {
    syncRouteContext();
    if (!isFollowingPage()) {
      throw new Error("请先打开 X 的 following 页面");
    }

    stopFallbackScroll();
    abortActiveWait();

    const currentUsername = getCurrentUsername() || "";
    const currentLower = currentUsername.toLowerCase();

    // Ensure seed actually belongs to the active target account
    if (
      state.followingSeed &&
      state.followingSeed.capturedForUsername &&
      state.followingSeed.capturedForUsername !== currentLower
    ) {
      state.followingSeed = null;
      state.seedCaptured = false;
      state.canUseDirect = false;
    }

    state.sessionUsername = currentLower;
    state.targetUsername = currentUsername;
    state.exportActive = true;
    state.paused = false;
    state.mode = "starting";
    state.done = false;
    state.lastError = null;
    state.lastCursor = null;
    state.users = [];
    state.usersByKey = new Map();
    state.unavailableEntryIds = new Set();
    state.unavailableCount = 0;
    state.count = 0;
    state.seenCursors = new Set();
    state.forceScrollMode = false;
    state.rateLimit = createRateLimitState();
    state.debug = createDebugState();
    state.runLogs = [];

    const expectedCount = toFiniteNonNegativeInt(options.expectedFollowingCount);
    state.profileCheck = {
      status: expectedCount !== null ? "checked" : "idle",
      username: typeof options.profileUsername === "string" ? options.profileUsername : currentUsername,
      expectedFollowingCount: expectedCount,
      checkedAt: options.checkedAt || "",
      source: options.profileCheckSource || "",
      error: options.profileCheckError || ""
    };

    pushDebugEvent("开始新的导出会话 (@" + currentUsername + ")");
    if (expectedCount !== null) {
      pushDebugEvent(
        "已核对主页关注数: " +
          String(expectedCount) +
          (state.profileCheck.source ? " (" + state.profileCheck.source + ")" : "")
      );
    } else if (state.profileCheck.error) {
      pushDebugEvent("主页关注数核对未成功: " + state.profileCheck.error, "warn");
    }

    if (state.canUseDirect) {
      pushDebugEvent(
        "已捕获直连种子，跳过 " + state.requestCache.length + " 条缓存重放，直接从首页拉取"
      );
    } else {
      const replayed = replayMatchingCache();
      pushDebugEvent("未捕获直连种子，已重放 " + replayed + " 条匹配缓存，进入滚动补采");
    }

    postStatus();

    if (state.canUseDirect) {
      void startDirectLoop({ resume: false });
      return {
        mode: "direct",
        seedCaptured: true
      };
    }

    startFallbackScroll("fallback-scroll");
    return {
      mode: "fallback-scroll",
      seedCaptured: state.seedCaptured
    };
  }

  function pauseExport() {
    if (!state.exportActive || state.paused) {
      return {
        paused: state.paused,
        count: state.users.length,
        mode: state.mode
      };
    }
    state.paused = true;
    state.exportActive = false;
    stopFallbackScroll();
    abortActiveWait();
    setStopReason("manual_pause");
    state.mode = state.mode.startsWith("direct") ? "direct-paused" : "fallback-paused";
    pushDebugEvent("已手动暂停采集（可随时继续）");
    postStatus();
    return {
      paused: true,
      count: state.users.length,
      mode: state.mode
    };
  }

  function resumeExport() {
    syncRouteContext();
    if (!isFollowingPage()) {
      throw new Error("请先打开 X 的 following 页面");
    }
    if (state.exportActive && !state.paused) {
      return {
        mode: state.mode,
        count: state.users.length
      };
    }

    state.exportActive = true;
    state.paused = false;
    state.done = false;
    state.lastError = null;
    pushDebugEvent("继续采集（当前已有 " + state.users.length + " 条）");
    postStatus();

    if (state.canUseDirect && !state.forceScrollMode) {
      void startDirectLoop({ resume: true });
      return {
        mode: "direct",
        count: state.users.length
      };
    }

    startFallbackScroll(
      state.forceScrollMode ? "direct-stalled-scroll" : "fallback-scroll"
    );
    return {
      mode: state.mode,
      count: state.users.length
    };
  }

  function stopExport() {
    state.exportActive = false;
    state.paused = false;
    state.done = true;
    stopFallbackScroll();
    abortActiveWait();
    setStopReason("manual_stop");
    pushDebugEvent("手动停止导出");
    if (state.mode.startsWith("direct")) {
      state.mode = "direct-stopped";
    } else if (state.mode.startsWith("fallback")) {
      state.mode = "fallback-stopped";
    } else {
      state.mode = "stopped";
    }
    postStatus();
    return {
      count: state.users.length,
      mode: state.mode
    };
  }

  function restoreSession(snapshot = {}) {
    syncRouteContext();
    if (!isFollowingPage()) {
      throw new Error("请先进入对应账号的 following 页面再恢复断点");
    }

    const currentUsername = getCurrentUsername() || "";
    const snapUsername = String(snapshot.pageUsername || "").trim();
    if (
      snapUsername &&
      currentUsername &&
      snapUsername.toLowerCase() !== currentUsername.toLowerCase()
    ) {
      throw new Error("断点快照属于 @" + snapUsername + "，与当前页面 @" + currentUsername + " 不一致");
    }

    stopFallbackScroll();
    abortActiveWait();
    state.exportActive = false;
    state.sessionUsername = currentUsername.toLowerCase();
    state.targetUsername = currentUsername;
    if (snapshot.targetUserId) {
      state.targetUserId = String(snapshot.targetUserId);
    }

    state.users = [];
    state.usersByKey = new Map();
    const list = Array.isArray(snapshot.users) ? snapshot.users : [];
    for (const user of list) {
      if (!user || !user.username) {
        continue;
      }
      const key = user.user_id || String(user.username).toLowerCase();
      if (state.usersByKey.has(key)) {
        continue;
      }
      state.usersByKey.set(key, user);
      state.users.push(user);
    }

    state.count = state.users.length;
    state.unavailableCount = toFiniteNonNegativeInt(snapshot.unavailableCount) || 0;
    state.lastCursor = snapshot.lastCursor ? String(snapshot.lastCursor) : null;
    state.seenCursors = new Set();
    state.done = Boolean(snapshot.done);
    state.paused = !state.done;
    state.mode = state.done ? "restored-complete" : "restored-paused";
    state.lastError = null;
    if (snapshot.profileCheck && typeof snapshot.profileCheck === "object") {
      const expected = toFiniteNonNegativeInt(snapshot.profileCheck.expectedFollowingCount);
      state.profileCheck = {
        status: expected !== null ? "checked" : "idle",
        username: snapshot.profileCheck.username || currentUsername,
        expectedFollowingCount: expected,
        checkedAt: snapshot.profileCheck.checkedAt || "",
        source: snapshot.profileCheck.source || "restored",
        error: snapshot.profileCheck.error || ""
      };
    }

    pushDebugEvent(
      "已恢复本地断点：" +
        state.users.length +
        " 条" +
        (state.lastCursor ? "（含续采游标）" : "")
    );
    postStatus();
    return {
      count: state.users.length,
      done: state.done,
      paused: state.paused,
      hasCursor: Boolean(state.lastCursor)
    };
  }

  function clearSession() {
    clearAccountSessionState("已清空当前会话缓存");
    syncRouteContext();
    postStatus();
    return { ok: true };
  }

  function getData() {
    syncRouteContext();
    return {
      pageType: getPageType(),
      pageUsername: getCurrentUsername() || state.targetUsername || "",
      targetUserId: state.targetUserId || "",
      count: state.users.length,
      unavailableCount: state.unavailableCount,
      lastCursor: state.lastCursor || "",
      done: state.done,
      exportedAt: new Date().toISOString(),
      mode: state.mode,
      canUseDirect: state.canUseDirect,
      profileCheck: { ...state.profileCheck },
      debug: getDebugSnapshot(),
      users: state.users.slice()
    };
  }

  function getLogs() {
    syncRouteContext();
    return {
      pageType: getPageType(),
      pageUsername: getCurrentUsername() || state.targetUsername || "",
      count: state.users.length,
      unavailableCount: state.unavailableCount,
      logCount: state.runLogs.length,
      exportedAt: new Date().toISOString(),
      mode: state.mode,
      canUseDirect: state.canUseDirect,
      profileCheck: { ...state.profileCheck },
      rateLimit: { ...state.rateLimit },
      debug: getDebugSnapshot(),
      logs: state.runLogs.slice()
    };
  }

  function getStatus() {
    syncRouteContext();
    return buildStatusPayload();
  }

  window.addEventListener("message", async (event) => {
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
    if (!message || message.source !== CONTENT_SOURCE || message.type !== "command") {
      return;
    }

    const { requestId, command } = message;
    try {
      let payload;
      if (command === "getStatus") {
        payload = getStatus();
      } else if (command === "getKnownProfileCount") {
        payload = getKnownProfileCount();
      } else if (command === "startExport") {
        payload = await startExport(message.payload || {});
      } else if (command === "pauseExport") {
        payload = pauseExport();
      } else if (command === "resumeExport") {
        payload = resumeExport();
      } else if (command === "stopExport") {
        payload = stopExport();
      } else if (command === "restoreSession") {
        payload = restoreSession(message.payload || {});
      } else if (command === "clearSession") {
        payload = clearSession();
      } else if (command === "getData") {
        payload = getData();
      } else if (command === "getLogs") {
        payload = getLogs();
      } else if (command === "getProfileFollowingCount") {
        payload = getProfileFollowingCount();
      } else {
        throw new Error("unknown command: " + command);
      }

      postResponse(requestId, true, payload);
    } catch (error) {
      postResponse(requestId, false, null, error.message);
    }
  });

  syncRouteContext();
  postStatus();
})();
