# X Following Exporter

一个零构建依赖、本地优先的 Chrome Manifest V3 扩展（`v0.2.0`），用于完整导出 X / Twitter 账号的关注列表（`following`），支持生成适合桌面与手机端离线浏览的 HTML、JSON、CSV 与运行日志。

## 核心特性

- **常驻侧边栏（Chrome Side Panel）**：点击扩展图标直接在浏览器右侧打开侧边栏，切换标签页或点击网页区域不会中断采集或离线头像打包。
- **MV3 原生 `MAIN` 世界注入**：在 `document_start` 阶段直接注入采集桥脚本，消除动态 `<script>` 注入竞态。
- **兼容 2026-07 X User 新结构**：同时兼容移除 `user.legacy` 后的新字段（`profile_bio`、`relationship_counts`、`tweet_counts`、`action_counts`、`dm_permissions`、`privacy`、`relationship_perspectives`、`banner`、`website`）与旧版结构；按 `BigInt(sortIndex)` 降序还原关注顺序，并统计接口中的已封禁/不可用账号。
- **双引擎采集与容错**：
  - 优先拦截 `Following` GraphQL 请求种子进行结构化分页，遇 `HTTP 429` 自动按限流头倒计时冷却，遇 `HTTP 404/403` 或游标停滞时平滑降级到增强滚动补采；
  - 监听 SPA 路由切换，自动按目标账号隔离种子与数据，避免串号或推荐关注数据污染；
  - 优先从 `UserByScreenName` / `UserByRestId` 响应读取精确关注数进行核对，未命中时由后台 Service Worker 安全托管核对。
- **暂停 / 继续 & 本地断点恢复**：支持随时暂停或恢复，自动将断点快照缓存在 `chrome.storage.local`，刷新后可一键恢复续采或直接导出。
- **四格式本地导出**：
  - `轻量 HTML（在线头像）` / `完整离线 HTML（内嵌头像，支持中途取消）`：自动利用 API 实体展开简介中的 `t.co` 短链，内置关键词过滤与粘性表头；
  - `JSON`、`CSV`（UTF-8 BOM）、`运行日志 JSON`。

## 快速安装（Chrome / Edge 116+）

### 方式 1：从 Releases 下载分享包

1. 在本仓库右侧 **Releases** 下载 `x-following-exporter-share.zip` 并解压到本地文件夹；
2. 打开 `chrome://extensions/`，开启右上角「开发者模式」；
3. 点击「加载已解压的扩展程序」，选择解压后的目录即可。

### 方式 2：从源码加载

克隆仓库后，在 `chrome://extensions/` 加载仓库内的 `x-following-exporter/` 子目录即可（零构建步骤，开箱即用）。

## 仓库结构

```text
.
├── x-following-exporter/     # Chrome MV3 扩展源码（直接加载此目录）
│   ├── manifest.json
│   ├── background.js         # Service Worker：Side Panel 行为与后台核对托管
│   ├── content.js            # Isolated World 消息转发层
│   ├── page-bridge.js        # Main World 采集引擎与状态机
│   ├── sidepanel.html / .css # 侧边栏界面
│   ├── panel/panel.js        # 侧边栏主控制器
│   ├── shared/               # 2026 Schema 解析与本地断点存储
│   ├── exporters/            # HTML / CSV / JSON / 离线头像 / 安全下载模块
│   └── icons/                # 扩展图标（16/32/48/128）
├── tests/core.test.mjs       # 零依赖 Node 单元测试与 VM 沙盒回归测试
├── scripts/pack.ps1          # PowerShell 打包脚本（先跑测试再打 zip/crx）
└── assets/icon-master.png    # 图标母版
```

## 测试与打包

需要 Node 20+（零第三方依赖）：

```powershell
# 运行单元测试
node --test .\tests\core.test.mjs

# 打包发布件（PowerShell 7）
pwsh -File .\scripts\pack.ps1
```

## 隐私与免责声明

- 本扩展**纯本地运行**，不包含任何遥测、统计或远程服务器上传逻辑，仅使用浏览器当前已登录的 X 会话在本地采集并导出文件。
- 请合理控制采集频率，遵守目标平台服务条款；本工具仅供个人备份与研究使用。
