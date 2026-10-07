# Changelog

## 0.1.0 — 2026-10-07

首个版本：DSH 右侧栏的「邮件看板」tab。

**宿主半侧**（`lib/index.js`）

- 读 dsh-email 的设置行，按「显式候选 → 形状识别」两级查找（兼容 `tool-email` 与 `dsh-email`
  两种 ns，并带脱敏回退链），再用 dsh-email 公开导出的
  `resolveEmailSettings` / `toEmailConfig` / `EmailPool` 取每个账号的未读信封
  —— 等价于 `email_list{unreadOnly:true}`，但不经过模型。
- 同源只读路由 `/_dsh/dsh-email-board/state`：`Sec-Fetch-Site` 非 `same-origin`/`none` → 403，
  非 GET → 405；`?force=1` 绕过短路缓存（`cacheMs`）；同一时刻只跑一轮 IMAP（单飞）。

**客户端半侧**（`lib/client.js`）

- 注册右侧栏 tab 类型 `email-board` 与正文槽位 `sidebar.right.pane.tab`，带开始页入口胶囊。
- 按账号分组的卡片列表：发件人（名字/地址、多人折叠）、主题、相对时间、附件与星标标记，
  账号筛选 chips、截断提示、错误与空状态；**只手动刷新，无定时轮询**。

**自检**

- `pnpm test`：迷你 React 跑客户端注册与渲染，零依赖，使用随仓库的虚构样本。
- `pnpm test:host`：真实 IMAP，解析账号 → 取未读 → 路由响应；`--fixture` 把真机响应写到
  `test/fixture-state.local.json`（git 忽略）。
