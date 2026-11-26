const FALLBACK_REVOKE_MS = 15 * 60 * 1000;
const pendingObjectUrls = new Map();
let listenerRegistered = false;

function revokeDownloadUrl(downloadId) {
  const entry = pendingObjectUrls.get(downloadId);
  if (!entry) {
    return;
  }
  window.clearTimeout(entry.timerId);
  URL.revokeObjectURL(entry.url);
  pendingObjectUrls.delete(downloadId);
}

function ensureDownloadListener() {
  if (listenerRegistered) {
    return;
  }
  listenerRegistered = true;

  if (chrome.downloads && chrome.downloads.onChanged) {
    chrome.downloads.onChanged.addListener((delta) => {
      if (!delta || typeof delta.id !== "number") {
        return;
      }
      const nextState = delta.state && delta.state.current;
      if (nextState === "complete" || nextState === "interrupted") {
        revokeDownloadUrl(delta.id);
      }
    });
  }

  window.addEventListener("pagehide", () => {
    for (const downloadId of Array.from(pendingObjectUrls.keys())) {
      revokeDownloadUrl(downloadId);
    }
  });
}

export async function triggerDownload(blob, filename) {
  ensureDownloadListener();
  const url = URL.createObjectURL(blob);

  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs: true
    });

    if (typeof downloadId !== "number") {
      URL.revokeObjectURL(url);
      throw new Error("浏览器未创建下载任务");
    }

    const timerId = window.setTimeout(() => {
      revokeDownloadUrl(downloadId);
    }, FALLBACK_REVOKE_MS);

    pendingObjectUrls.set(downloadId, { url, timerId });
    return downloadId;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
