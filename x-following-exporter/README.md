# X Following Exporter

一个零构建依赖、本地优先的 Chrome Manifest V3 扩展，用于完整导出 X / Twitter 账号的关注列表（`following`），并生成适合桌面与手机端离线留档浏览的 HTML / JSON / CSV 文件。

## 当前版本与核心能力（v0.2.0）

- **常驻侧边栏（Chrome Side Panel）**：点击扩展图标直接在浏览器右侧打开侧边栏，切换页面或点击网页区域不会关闭面板，长耗时采集与离线头像打包不再中断。
- **MV3 原生 `MAIN` 世界注入**：通过 `manifest.json` 在 `document_start` 直接注入 `page-bridge.js`，避免动态 `<script>` 标签异步注入竞态。
- **适配 2026-07 X 用户新 Schema**：同时兼容 X 移除 `user.legacy` 后的新字段（`profile_bio`、`relationship_counts`、`tweet_counts`、`action_counts`、`dm_permissions`、`privacy`、`relationship_perspectives`、`banner`、`website`）及旧版 `legacy` 结构；按 `BigInt(sortIndex)` 降序还原顺序，并统计接口中已封禁/不可用账号（`UserUnavailable`）。
- **防串号与白名单过滤**：监听 SPA 路由切换，跨账号自动隔离种子与采集池；仅解析当前目标账号的 `Following` 接口，杜绝侧边栏推荐关注等无关响应污染结果。
- **精确主页关注数核对**：优先直接从拦截的 `UserByScreenName` / `UserByRestId` 接口读取精确关注数（零额外标签页）；未命中时由后台 Service Worker 安全托管打开/关闭主页页签核对。
- **抗限流与断点续采**：
  - 感知 `x-rate-limit-*` 响应头并加入随机请求抖动；
  - 遇 `HTTP 429` 自动按重置时间倒计时冷却重试，超长冷却自动暂停；
  - 遇 `HTTP 404` / `403`（如 `x-client-transaction-id` 校验或权限受限）自动降级为增强滚动补采（双指标监控页面高度与新增人数）；
  - 支持随时**暂停 / 继续**，并自动将断点快照存入 `chrome.storage.local`，刷新后可一键恢复续采或导出。
- **四格式导出**：
  - `轻量 HTML（在线头像）` / `完整离线 HTML（内嵌头像，支持中途取消）`：简介自动用 API 实体展开 `t.co` 短链，支持关键词搜索与粘性表头；
  - `JSON`、`CSV`（UTF-8 BOM）、`运行日志 JSON`。

## 目录结构

```text
x-following-exporter/
  manifest.json            # MV3 清单（Chrome 116+，world: MAIN + sidePanel + storage）
  background.js            # 轻量 Service Worker：侧栏行为与后台核对防孤儿标签页
  content.js               # Isolated World 消息中转层
  page-bridge.js           # Main World 采集引擎与状态机
  sidepanel.html           # 侧边栏控制台页面
  sidepanel.css            # 响应式侧边栏样式
  panel/
    panel.js               # 侧边栏主控制器（实时状态订阅 + 断点自动保存）
  shared/
    user-schema.js         # 2026 新旧用户 Schema 解析、sortIndex 排序与数量解析
    session-store.js       # chrome.storage.local 本地断点存储（最多保留 6 个账号）
  exporters/
    formatters.js          # 文件名清洗、转义、CSV/数字格式化
    description.js         # 简介实体与 t.co 链接展开渲染
    avatars.js             # 离线头像 6 并发拉取（支持 AbortController 取消）
    html.js                # 离线 HTML 生成器
    download.js            # 安全下载器（监听 chrome.downloads.onChanged 回收 Blob URL）
  icons/                   # 扩展图标资源（16/32/48/128）
```

> 外层目录的 `tests/core.test.mjs` 为零依赖 Node 单元测试套件，位于扩展加载目录之外以保持扩展本体纯净。

## 安装与使用

### 加载已解压扩展（Chrome / Edge 116+）

1. 打开 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `x-following-exporter` 目录

### 基本使用流程

1. 打开任意 X 账号的关注页，例如 `https://x.com/<用户名>/following`
2. 点击浏览器工具栏扩展图标，在右侧打开 **X Following Exporter** 侧边栏
3. 若页面刚打开过扩展重载，先刷新一次该 X 页面以捕获直连种子
4. 点击「开始导出」；过程中可随时点击「暂停 / 继续」或「停止」
5. 采集完成后选择格式导出（手机离线查看建议选「完整离线 HTML（内嵌头像）」）

## 本地自动化测试

在项目外层目录（`x-following-exporter/` 的上一级）运行（需 Node 20+）：

```powershell
node --test .\tests\core.test.mjs
```

## 导出字段说明

导出结构包含以下字段：

- 基础信息：`name`、`username`、`user_id`、`description`、`description_urls`、`website`、`location`、`created_at`、`profile_url`
- 统计计数：`followers_count`、`following_count`、`posts_count`、`media_count`、`favourites_count`、`listed_count`（新接口无此字段时为 `null`）
- 关系与认证：`followed_by`（互关）、`following`、`protected`（锁推）、`can_dm`、`verified`、`verified_type`（`Business` / `Government` 等）、`blue_verified`、`professional`
- 媒体与排序：`avatar_url`、`banner_url`、`sort_index`

## 已知边界

- 对他人关注列表，X 尾段可能持续返回空页或受接口签名（`x-client-transaction-id`）校验限制；此时直连会自动切换至增强滚动补采，但无法突破当前登录账号在 X 网页端可见的数据上限。
- 扩展根目录内**切勿**放置以下划线 `_` 开头的文件夹（如 `_archive`），Chrome 会拒绝加载。
