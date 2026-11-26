import {
  escapeAttribute,
  escapeHtml,
  formatNumber,
  isSafeHttpUrl
} from "./formatters.js";
import { renderDescriptionHtml } from "./description.js";

export function modeLabel(mode) {
  const labels = {
    idle: "待命",
    starting: "准备中",
    direct: "直连翻页",
    "direct-fetching-first-page": "直连首页",
    "direct-rate-limited": "限流冷却中",
    "direct-paused": "直连已暂停",
    "direct-stalled-scroll": "直连降级滚动补采",
    "direct-complete": "直连完成",
    "direct-error": "直连报错",
    "direct-stopped": "直连已停止",
    "fallback-scroll": "滚动补采",
    "fallback-paused": "滚动已暂停",
    "fallback-complete": "滚动补采完成",
    "fallback-stopped": "滚动补采已停止",
    "restored-paused": "已恢复断点（可继续）",
    "restored-complete": "已恢复历史完成态",
    stopped: "已停止"
  };
  return labels[mode] || mode || "待命";
}

function buildSearchText(user) {
  return [
    user.name,
    user.username,
    user.user_id,
    user.location,
    user.description,
    user.website,
    user.profile_url,
    user.created_at
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function buildStats(users) {
  const stats = {
    total: users.length,
    mutual: 0,
    blueVerified: 0,
    protectedCount: 0,
    professional: 0
  };

  for (const user of users) {
    if (user.followed_by === true) {
      stats.mutual += 1;
    }
    if (user.blue_verified) {
      stats.blueVerified += 1;
    }
    if (user.protected) {
      stats.protectedCount += 1;
    }
    if (user.professional) {
      stats.professional += 1;
    }
  }

  return stats;
}

export function buildExportSummary(data, stats) {
  const debug = data && data.debug ? data.debug : {};
  const profileCheck = data && data.profileCheck ? data.profileCheck : null;
  const directPages = Number(debug.directPageCount || 0);
  const unavailableCount = Number(data && data.unavailableCount ? data.unavailableCount : 0);
  const total = formatNumber(stats.total || 0);
  const modeText = modeLabel(data && data.mode ? data.mode : "idle");
  const stopReason = debug.lastStopReason ? "；结束原因：" + debug.lastStopReason : "";

  let unavailableSummary = "";
  if (unavailableCount > 0) {
    unavailableSummary = "；接口中另有 " + formatNumber(unavailableCount) + " 个已封禁/不可用账号";
  }

  let profileGapSummary = "";
  if (profileCheck && profileCheck.expectedFollowingCount != null) {
    const expected = Number(profileCheck.expectedFollowingCount);
    const current = Number(stats.total || 0);
    if (Number.isFinite(expected) && expected > current) {
      profileGapSummary =
        "；主页核对关注数 " +
        formatNumber(expected) +
        "，当前导出 " +
        formatNumber(current) +
        "（差值 " +
        formatNumber(expected - current) +
        "，可能包含已封禁账号或 X 尾段返回空页）";
    }
  }

  const avatarMeta = data && data.htmlExportMeta ? data.htmlExportMeta : null;
  let avatarSummary = "";
  if (avatarMeta && avatarMeta.mode === "offline") {
    avatarSummary =
      "；头像已内嵌 " +
      formatNumber(avatarMeta.embedded || 0) +
      "/" +
      formatNumber(avatarMeta.total || 0) +
      " 张";
    if (Number(avatarMeta.failed || 0) > 0) {
      avatarSummary += "，另有 " + formatNumber(avatarMeta.failed) + " 张保留在线链接";
    }
  } else if (avatarMeta && avatarMeta.mode === "linked") {
    avatarSummary = "；头像使用在线链接";
  }

  if (directPages > 0 && debug.forceScrollMode) {
    return `本次共导出 ${total} 条，主体通过直连翻页抓取，末尾自动切换滚动补采；最终状态：${modeText}${stopReason}${unavailableSummary}${profileGapSummary}${avatarSummary}`;
  }
  if (directPages > 0) {
    return `本次共导出 ${total} 条，通过直连翻页完成；最终状态：${modeText}${stopReason}${unavailableSummary}${profileGapSummary}${avatarSummary}`;
  }
  return `本次共导出 ${total} 条，通过页面滚动补采完成；最终状态：${modeText}${stopReason}${unavailableSummary}${profileGapSummary}${avatarSummary}`;
}

function renderBadges(user) {
  const badges = [];
  if (user.followed_by === true) {
    badges.push('<span class="pill pill-teal">互关</span>');
  }
  if (user.protected) {
    badges.push('<span class="pill pill-slate">锁推</span>');
  }
  if (user.verified_type === "Business") {
    badges.push('<span class="pill pill-gold">金标</span>');
  } else if (user.verified_type === "Government") {
    badges.push('<span class="pill pill-slate">灰标</span>');
  } else if (user.blue_verified) {
    badges.push('<span class="pill pill-blue">蓝标</span>');
  } else if (user.verified) {
    badges.push('<span class="pill">认证</span>');
  }
  if (user.professional) {
    badges.push('<span class="pill pill-gold">专业</span>');
  }
  return badges.length ? badges.join("") : '<span class="muted">-</span>';
}

export function buildHtmlDocument(data) {
  const users = Array.isArray(data && data.users) ? data.users : [];
  const stats = buildStats(users);
  const username = escapeHtml((data && data.pageUsername) || "following");
  const mode = escapeHtml(modeLabel((data && data.mode) || "idle"));
  const exportedAt = escapeHtml((data && data.exportedAt) || new Date().toISOString());
  const total = formatNumber(users.length);
  const mutual = formatNumber(stats.mutual);
  const blueVerified = formatNumber(stats.blueVerified);
  const protectedCount = formatNumber(stats.protectedCount);
  const summary = escapeHtml(buildExportSummary(data, stats));
  const avatarMeta = data && data.htmlExportMeta ? data.htmlExportMeta : null;
  const avatarMode =
    avatarMeta && avatarMeta.mode === "offline"
      ? "完整离线（头像已内嵌）"
      : "轻量模式（头像在线加载）";
  let avatarDetail = "";

  if (avatarMeta && avatarMeta.mode === "offline") {
    avatarDetail =
      "；已内嵌 " +
      formatNumber(avatarMeta.embedded || 0) +
      "/" +
      formatNumber(avatarMeta.total || 0) +
      " 张";
    if (Number(avatarMeta.failed || 0) > 0) {
      avatarDetail += "，失败 " + formatNumber(avatarMeta.failed) + " 张";
    }
  }

  const rows = users
    .map((user, index) => {
      const rawUsername = String(user.username || "");
      const rawAvatarUrl = String(user.avatar_url || "");
      const rawProfileUrl = isSafeHttpUrl(user.profile_url)
        ? user.profile_url
        : rawUsername
          ? "https://x.com/" + encodeURIComponent(rawUsername)
          : "";
      const rawWebsite = isSafeHttpUrl(user.website) ? user.website : "";

      const nameHtml = escapeHtml(user.name || "");
      const usernameHtml = escapeHtml(rawUsername);
      const userIdHtml = escapeHtml(user.user_id || "");
      const locationHtml = escapeHtml(user.location || "");
      const descriptionHtml = renderDescriptionHtml(
        user.description || "",
        user.description_urls || []
      );
      const createdAtHtml = escapeHtml(user.created_at || "");
      const badgesHtml = renderBadges(user);
      const searchAttr = escapeAttribute(buildSearchText(user));

      const websiteHtml = rawWebsite
        ? `<div class="website"><a href="${escapeAttribute(rawWebsite)}" target="_blank" rel="noreferrer noopener">${escapeHtml(rawWebsite.replace(/^https?:\/\//i, ""))}</a></div>`
        : "";

      const isSafeAvatar =
        isSafeHttpUrl(rawAvatarUrl) || rawAvatarUrl.startsWith("data:image/");
      const avatarHtml = isSafeAvatar
        ? `<img class="avatar" src="${escapeAttribute(rawAvatarUrl)}" alt="@${escapeAttribute(rawUsername)}" width="44" height="44" loading="lazy" referrerpolicy="no-referrer">`
        : '<div class="avatar avatar-fallback" aria-hidden="true">?</div>';

      return `<tr data-search="${searchAttr}">
<td>${index + 1}</td>
<td>${avatarHtml}</td>
<td>
  <div class="name-cell">
    <strong>${nameHtml || "(无显示名)"}</strong>
    <div>${
      rawProfileUrl
        ? `<a href="${escapeAttribute(rawProfileUrl)}" target="_blank" rel="noreferrer noopener">@${usernameHtml || "-"}</a>`
        : `@${usernameHtml || "-"}`
    }</div>
    ${websiteHtml}
  </div>
</td>
<td><code>${userIdHtml || "-"}</code></td>
<td>${badgesHtml}</td>
<td>${formatNumber(user.followers_count)}</td>
<td>${formatNumber(user.following_count)}</td>
<td>${locationHtml || '<span class="muted">-</span>'}</td>
<td class="desc">${descriptionHtml}</td>
<td>${createdAtHtml || '<span class="muted">-</span>'}</td>
</tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>X 关注列表离线页 - @${username}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7fb;
      --card: #ffffff;
      --text: #172033;
      --muted: #5f6b85;
      --line: #dbe1ee;
      --accent: #0f766e;
      --accent-soft: #dff6f3;
      --blue: #2563eb;
      --blue-soft: #dbeafe;
      --gold: #a16207;
      --gold-soft: #fef3c7;
      --slate: #475569;
      --slate-soft: #e2e8f0;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: linear-gradient(180deg, #f3f7ff 0%, var(--bg) 100%);
      color: var(--text);
    }
    .wrap {
      max-width: 1480px;
      margin: 0 auto;
      padding: 28px 20px 44px;
    }
    .hero {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 22px;
      box-shadow: 0 10px 32px rgba(23, 32, 51, 0.06);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 26px;
    }
    .meta {
      color: var(--muted);
      line-height: 1.7;
      font-size: 14px;
    }
    .summary-box {
      margin-top: 14px;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #f8fafc;
      line-height: 1.65;
      font-size: 14px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-top: 16px;
    }
    .stat {
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #f8fafc;
    }
    .stat-label {
      color: var(--muted);
      font-size: 13px;
    }
    .stat-value {
      margin-top: 4px;
      font-size: 22px;
      font-weight: 700;
    }
    .controls {
      margin: 18px 0 14px;
    }
    input[type="search"] {
      width: 100%;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 12px;
      font-size: 15px;
      background: #fff;
    }
    .table-card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 10px 32px rgba(23, 32, 51, 0.06);
    }
    .table-wrap {
      overflow: auto;
      max-inline-size: 100%;
      max-block-size: min(76vh, 920px);
    }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      min-width: 1220px;
    }
    thead {
      position: sticky;
      inset-block-start: 0;
      z-index: 1;
    }
    th, td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th {
      background: #f8fafc;
      font-size: 14px;
      white-space: nowrap;
    }
    tbody tr:hover {
      background: #fbfdff;
    }
    code {
      font-family: Consolas, monospace;
      font-size: 13px;
    }
    a {
      color: #0b57d0;
      text-decoration: none;
      overflow-wrap: anywhere;
    }
    a:hover {
      text-decoration: underline;
    }
    .avatar {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      object-fit: cover;
      display: block;
      background: #eef2ff;
    }
    .avatar-fallback {
      display: grid;
      place-items: center;
      color: var(--muted);
      font-weight: 700;
    }
    .name-cell {
      min-width: 180px;
    }
    .website {
      margin-top: 3px;
      font-size: 12px;
    }
    .desc {
      min-width: 300px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .pill {
      display: inline-block;
      margin: 0 5px 5px 0;
      padding: 3px 9px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
    }
    .pill-teal {
      background: var(--accent-soft);
      color: var(--accent);
    }
    .pill-blue {
      background: var(--blue-soft);
      color: var(--blue);
    }
    .pill-gold {
      background: var(--gold-soft);
      color: var(--gold);
    }
    .pill-slate {
      background: var(--slate-soft);
      color: var(--slate);
    }
    .muted {
      color: var(--muted);
    }
    .footer {
      margin-top: 12px;
      color: var(--muted);
      font-size: 13px;
    }
    .hidden {
      display: none;
    }
    @media (max-width: 960px) {
      .stats {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (max-width: 720px) {
      .wrap {
        padding: 18px 12px 30px;
      }
      .stats {
        grid-template-columns: 1fr;
      }
      th, td {
        padding: 10px 8px;
        font-size: 14px;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <h1 id="table-heading">X 关注列表离线页 · @${username}</h1>
      <div class="meta">
        <div>导出时间：<code>${exportedAt}</code> · 导出模式：<code>${mode}</code></div>
        <div>头像模式：<code>${escapeHtml(avatarMode + avatarDetail)}</code></div>
      </div>
      <div class="summary-box">${summary}</div>
      <div class="stats">
        <div class="stat">
          <div class="stat-label">已导出账号</div>
          <div class="stat-value">${total}</div>
        </div>
        <div class="stat">
          <div class="stat-label">互关账号</div>
          <div class="stat-value">${mutual}</div>
        </div>
        <div class="stat">
          <div class="stat-label">蓝标认证</div>
          <div class="stat-value">${blueVerified}</div>
        </div>
        <div class="stat">
          <div class="stat-label">锁推账号</div>
          <div class="stat-value">${protectedCount}</div>
        </div>
      </div>
    </section>

    <div class="controls">
      <input id="search" type="search" aria-label="过滤关注列表" placeholder="按昵称、用户名、ID、地区、网站、简介关键词过滤...">
    </div>

    <section class="table-card">
      <div class="table-wrap" tabindex="0" role="region" aria-labelledby="table-heading">
        <table>
          <thead>
            <tr>
              <th style="width: 68px;">序号</th>
              <th style="width: 68px;">头像</th>
              <th style="width: 220px;">账号</th>
              <th style="width: 160px;">用户 ID</th>
              <th style="width: 170px;">标记</th>
              <th style="width: 105px;">粉丝</th>
              <th style="width: 105px;">关注</th>
              <th style="width: 170px;">地区</th>
              <th>简介</th>
              <th style="width: 210px;">注册时间</th>
            </tr>
          </thead>
          <tbody id="rows">
${rows}
          </tbody>
        </table>
      </div>
    </section>

    <div class="footer" id="count">当前显示 ${total} / ${total} 条</div>
  </div>

  <script>
    const search = document.getElementById("search");
    const rows = Array.from(document.querySelectorAll("#rows tr"));
    const count = document.getElementById("count");
    const total = ${users.length};

    function update() {
      const keyword = search.value.trim().toLowerCase();
      let visible = 0;
      for (const row of rows) {
        const hit = !keyword || (row.dataset.search || "").includes(keyword);
        row.classList.toggle("hidden", !hit);
        if (hit) {
          visible += 1;
        }
      }
      count.textContent = "当前显示 " + visible + " / " + total + " 条";
    }

    search.addEventListener("input", update);
  </script>
</body>
</html>`;
}
