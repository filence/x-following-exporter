import { escapeAttribute, escapeHtml, isSafeHttpUrl } from "./formatters.js";

const NON_DOMAIN_EXTENSIONS = new Set([
  "js",
  "ts",
  "jsx",
  "tsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "rs",
  "go",
  "java",
  "kt",
  "swift",
  "cpp",
  "hpp",
  "cs",
  "php",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "xml",
  "json",
  "yaml",
  "yml",
  "toml",
  "md",
  "txt",
  "csv",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "mp4",
  "mov",
  "zip",
  "pdf",
  "exe",
  "dll",
  "vue",
  "svelte",
  "rc"
]);

export function trimTrailingPunctuation(value) {
  let end = value.length;
  while (
    end > 0 &&
    /[),.;!?，。！？；：）】》」』、】【"'`]$/.test(value.slice(0, end))
  ) {
    end -= 1;
  }
  return value.slice(0, end);
}

function looksLikeCodeOrFilename(candidate) {
  if (candidate.includes("/")) {
    return false;
  }
  const parts = candidate.split(".");
  if (parts.length < 2) {
    return false;
  }
  const tld = parts[parts.length - 1].toLowerCase();
  if (NON_DOMAIN_EXTENSIONS.has(tld)) {
    return true;
  }
  // Version-like tokens such as v2.0.rc or 1.2.beta
  if (/^v?\d+$/i.test(parts[0])) {
    return true;
  }
  return false;
}

function buildEntityLookup(descriptionUrls) {
  const map = new Map();
  if (!Array.isArray(descriptionUrls)) {
    return map;
  }
  for (const item of descriptionUrls) {
    if (!item || typeof item.url !== "string") {
      continue;
    }
    map.set(item.url, {
      expanded: isSafeHttpUrl(item.expanded_url) ? item.expanded_url : item.url,
      display: item.display_url || item.expanded_url || item.url
    });
  }
  return map;
}

function renderDescriptionEntity(value, entityLookup) {
  const trimmed = trimTrailingPunctuation(value);
  const trailing = value.slice(trimmed.length);

  if (!trimmed) {
    return escapeHtml(value);
  }

  if (entityLookup.has(trimmed)) {
    const resolved = entityLookup.get(trimmed);
    if (isSafeHttpUrl(resolved.expanded)) {
      return (
        `<a href="${escapeAttribute(resolved.expanded)}" target="_blank" rel="noreferrer noopener">${escapeHtml(resolved.display)}</a>` +
        escapeHtml(trailing)
      );
    }
  }

  let href = null;
  let label = trimmed;

  if (/^https?:\/\//i.test(trimmed)) {
    href = trimmed;
  } else if (trimmed.startsWith("@")) {
    href = "https://x.com/" + encodeURIComponent(trimmed.slice(1));
  } else if (trimmed.startsWith("#")) {
    href = "https://x.com/hashtag/" + encodeURIComponent(trimmed.slice(1));
  } else if (trimmed.startsWith("$")) {
    href = "https://x.com/search?q=" + encodeURIComponent(trimmed) + "&src=cashtag_click";
  } else {
    if (looksLikeCodeOrFilename(trimmed)) {
      return escapeHtml(value);
    }
    href = "https://" + trimmed;
  }

  if (!isSafeHttpUrl(href)) {
    return escapeHtml(value);
  }

  return (
    `<a href="${escapeAttribute(href)}" target="_blank" rel="noreferrer noopener">${escapeHtml(label)}</a>` +
    escapeHtml(trailing)
  );
}

export function renderDescriptionHtml(text, descriptionUrls = []) {
  const raw = String(text || "");
  if (!raw) {
    return '<span class="muted">-</span>';
  }

  const entityLookup = buildEntityLookup(descriptionUrls);
  const entityPattern =
    /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+|(?<![@\w.])(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*)?|(?<![\w])@[A-Za-z0-9_]{1,15}|(?<![\w&])#[\p{L}\p{N}_]+|(?<![\w&])\$[A-Za-z]{1,10}(?:[._][A-Za-z]{1,2})?/gu;

  let cursor = 0;
  let html = "";

  for (const match of raw.matchAll(entityPattern)) {
    const value = match[0];
    const index = match.index ?? 0;
    html += escapeHtml(raw.slice(cursor, index));
    html += renderDescriptionEntity(value, entityLookup);
    cursor = index + value.length;
  }

  html += escapeHtml(raw.slice(cursor));
  return html;
}
