export function toFiniteNonNegativeInt(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return null;
  }
  return Math.round(num);
}

export function pickNumber(...candidates) {
  for (const candidate of candidates) {
    const parsed = toFiniteNonNegativeInt(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }
  return 0;
}

export function pickNullableNumber(...candidates) {
  for (const candidate of candidates) {
    const parsed = toFiniteNonNegativeInt(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

export function compareSortIndex(a, b) {
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

export function parseDisplayedCount(input) {
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

export function extractUrlEntities(entityList) {
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
      display_url: typeof item.display_url === "string" ? item.display_url : item.expanded_url || item.url
    });
  }
  return out;
}

export function normalizeUserResult(result, sortIndex = "") {
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
    profileBio.entities?.description?.urls ?? legacy.entities?.description?.urls
  );
  const websiteEntities = extractUrlEntities(
    profileBio.entities?.url?.urls ?? legacy.entities?.url?.urls
  );
  const rawWebsite = result.website?.url || legacy.url || "";
  const expandedWebsite =
    websiteEntities.find((item) => item.expanded_url)?.expanded_url || rawWebsite;

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
    description: profileBio.description ?? legacy.description ?? "",
    description_urls: descriptionUrls,
    website: expandedWebsite,
    created_at: core.created_at || legacy.created_at || "",
    followers_count: pickNumber(relationshipCounts.followers, legacy.followers_count, 0),
    following_count: pickNumber(relationshipCounts.following, legacy.friends_count, 0),
    favourites_count: pickNumber(actionCounts.favorites_count, legacy.favourites_count, 0),
    listed_count: pickNullableNumber(legacy.listed_count),
    media_count: pickNumber(tweetCounts.media_tweets, legacy.media_count, 0),
    posts_count: pickNumber(tweetCounts.tweets, legacy.statuses_count, 0),
    can_dm: Boolean(dmPermissions.can_dm ?? legacy.can_dm ?? false),
    protected: Boolean(privacy.protected ?? legacy.protected ?? false),
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

export function extractProfileSnapshot(parsedData) {
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
      (node.rest_id || node.legacy?.id_str) &&
      (node.core?.screen_name || node.legacy?.screen_name)
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

  const username = first.core?.screen_name || first.legacy?.screen_name || "";
  const userId = String(first.rest_id || first.legacy?.id_str || "");
  const followingCount = pickNullableNumber(
    first.relationship_counts?.following,
    first.legacy?.friends_count
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

export function readBottomCursorFromEntry(entry) {
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

export function readUserResultFromEntry(entry) {
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

export function extractFollowingTimelineArtifacts(parsedData) {
  const bucket = {
    userEntries: [],
    bottomCursor: null
  };

  function walk(node) {
    if (!node || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }

    if (Array.isArray(node.instructions)) {
      for (const instruction of node.instructions) {
        const entries = [];
        if (Array.isArray(instruction?.entries)) {
          entries.push(...instruction.entries);
        }
        if (instruction?.entry) {
          entries.push(instruction.entry);
        }

        const sortedEntries = entries.slice().sort((a, b) => compareSortIndex(a?.sortIndex, b?.sortIndex));

        for (const entry of sortedEntries) {
          const cursor = readBottomCursorFromEntry(entry);
          if (cursor) {
            bucket.bottomCursor = cursor;
          }

          const userEntry = readUserResultFromEntry(entry);
          if (userEntry) {
            bucket.userEntries.push(userEntry);
          }
        }
      }
    }

    for (const value of Object.values(node)) {
      walk(value);
    }
  }

  walk(parsedData);
  return bucket;
}
