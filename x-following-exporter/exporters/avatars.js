function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("头像读取失败"));
    reader.readAsDataURL(blob);
  });
}

async function fetchAvatarAsDataUrl(url, signal) {
  const response = await fetch(url, {
    method: "GET",
    cache: "force-cache",
    referrerPolicy: "no-referrer",
    signal
  });
  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }
  const blob = await response.blob();
  return blobToDataUrl(blob);
}

export async function prepareHtmlUsers(users, avatarMode, options = {}) {
  const { onProgress = null, signal = null } = options;
  const clonedUsers = users.map((user) => ({ ...user }));

  if (avatarMode !== "offline") {
    return {
      users: clonedUsers,
      avatarMeta: {
        mode: "linked",
        total: clonedUsers.filter((user) => Boolean(user.avatar_url)).length,
        embedded: 0,
        failed: 0,
        cancelled: false
      }
    };
  }

  const usersWithAvatar = clonedUsers.filter(
    (user) => typeof user.avatar_url === "string" && user.avatar_url
  );
  const total = usersWithAvatar.length;
  let completed = 0;
  let embedded = 0;
  let failed = 0;
  let nextIndex = 0;
  const concurrency = Math.min(6, total || 1);

  const report = () => {
    if (typeof onProgress === "function") {
      onProgress({ completed, total, embedded, failed });
    }
  };

  report();

  async function worker() {
    while (nextIndex < usersWithAvatar.length) {
      if (signal && signal.aborted) {
        return;
      }
      const currentIndex = nextIndex;
      nextIndex += 1;
      const user = usersWithAvatar[currentIndex];
      try {
        user.avatar_url = await fetchAvatarAsDataUrl(user.avatar_url, signal);
        embedded += 1;
      } catch (error) {
        if (signal && signal.aborted) {
          return;
        }
        failed += 1;
      }
      completed += 1;
      if (completed === total || completed % 8 === 0) {
        report();
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (signal && signal.aborted) {
    const abortError = new Error("已取消离线 HTML 导出");
    abortError.name = "AbortError";
    throw abortError;
  }

  report();

  return {
    users: clonedUsers,
    avatarMeta: {
      mode: "offline",
      total,
      embedded,
      failed,
      cancelled: false
    }
  };
}
