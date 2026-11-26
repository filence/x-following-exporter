export function sanitizeFilenamePart(input) {
  return String(input || "following")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

export function buildFilename(data, ext, variant = "") {
  const username = sanitizeFilenamePart(data && data.pageUsername ? data.pageUsername : "following");
  const count = Number(data && data.count ? data.count : 0);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = variant ? "-" + sanitizeFilenamePart(variant) : "";
  return `x-following-${username}-${count}-${timestamp}${suffix}.${ext}`;
}

export function buildLogFilename(data) {
  const username = sanitizeFilenamePart(data && data.pageUsername ? data.pageUsername : "following");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logCount = Number(data && data.logCount ? data.logCount : 0);
  return `x-following-log-${username}-${logCount}-${timestamp}.json`;
}

export function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

export function isSafeHttpUrl(url) {
  if (typeof url !== "string") {
    return false;
  }
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed);
}

export function formatNumber(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("zh-CN") : "-";
}

const CSV_COLUMNS = [
  "name",
  "username",
  "user_id",
  "description",
  "website",
  "created_at",
  "followers_count",
  "following_count",
  "favourites_count",
  "listed_count",
  "media_count",
  "posts_count",
  "can_dm",
  "protected",
  "followed_by",
  "following",
  "verified",
  "verified_type",
  "blue_verified",
  "professional",
  "location",
  "avatar_url",
  "banner_url",
  "profile_url"
];

function serializeCsvCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const raw = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

export function toCsv(users) {
  if (!Array.isArray(users) || !users.length) {
    return "\uFEFF";
  }

  const extraKeys = Object.keys(users[0]).filter(
    (key) => !CSV_COLUMNS.includes(key) && key !== "description_urls" && key !== "sort_index"
  );
  const headers = [...CSV_COLUMNS, ...extraKeys];
  const lines = [headers.join(",")];

  for (const row of users) {
    const cells = headers.map((header) => serializeCsvCell(row[header]));
    lines.push(cells.join(","));
  }

  return "\uFEFF" + lines.join("\n");
}
