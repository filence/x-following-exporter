const STORAGE_PREFIX = "xfe_session_v2:";
const INDEX_KEY = "xfe_session_index_v2";
const MAX_SAVED_SESSIONS = 6;

function normalizeKey(username) {
  return String(username || "").trim().toLowerCase();
}

function sessionStorageKey(username) {
  return STORAGE_PREFIX + normalizeKey(username);
}

export async function loadSavedSession(username) {
  const key = normalizeKey(username);
  if (!key) {
    return null;
  }
  const storageKey = sessionStorageKey(key);
  const data = await chrome.storage.local.get(storageKey);
  const session = data[storageKey];
  if (!session || !Array.isArray(session.users) || session.users.length === 0) {
    return null;
  }
  return session;
}

export async function saveSessionSnapshot(snapshot) {
  const key = normalizeKey(snapshot?.pageUsername);
  if (!key || !Array.isArray(snapshot?.users) || snapshot.users.length === 0) {
    return false;
  }

  const record = {
    version: 2,
    pageUsername: snapshot.pageUsername,
    targetUserId: snapshot.targetUserId || "",
    count: snapshot.users.length,
    unavailableCount: Number(snapshot.unavailableCount || 0),
    lastCursor: snapshot.lastCursor || "",
    mode: snapshot.mode || "idle",
    done: Boolean(snapshot.done),
    profileCheck: snapshot.profileCheck || null,
    savedAt: new Date().toISOString(),
    users: snapshot.users
  };

  const { [INDEX_KEY]: existingIndex = [] } = await chrome.storage.local.get(INDEX_KEY);
  const nextIndex = [
    { username: key, savedAt: record.savedAt, count: record.count },
    ...existingIndex.filter((item) => item && item.username !== key)
  ];

  const keysToRemove = [];
  while (nextIndex.length > MAX_SAVED_SESSIONS) {
    const evicted = nextIndex.pop();
    if (evicted && evicted.username) {
      keysToRemove.push(sessionStorageKey(evicted.username));
    }
  }

  try {
    await chrome.storage.local.set({
      [sessionStorageKey(key)]: record,
      [INDEX_KEY]: nextIndex
    });
    if (keysToRemove.length) {
      await chrome.storage.local.remove(keysToRemove);
    }
    return true;
  } catch (error) {
    // Quota protection: evict oldest sessions and retry once
    if (existingIndex.length > 0) {
      const evictAll = existingIndex
        .filter((item) => item && item.username !== key)
        .map((item) => sessionStorageKey(item.username));
      if (evictAll.length) {
        await chrome.storage.local.remove(evictAll);
        await chrome.storage.local.set({
          [sessionStorageKey(key)]: record,
          [INDEX_KEY]: [{ username: key, savedAt: record.savedAt, count: record.count }]
        });
        return true;
      }
    }
    console.warn("[XFE] saveSessionSnapshot failed:", error);
    return false;
  }
}

export async function clearSavedSession(username) {
  const key = normalizeKey(username);
  if (!key) {
    return;
  }
  const { [INDEX_KEY]: existingIndex = [] } = await chrome.storage.local.get(INDEX_KEY);
  const nextIndex = existingIndex.filter((item) => item && item.username !== key);
  await chrome.storage.local.remove(sessionStorageKey(key));
  await chrome.storage.local.set({ [INDEX_KEY]: nextIndex });
}
