# dsh-email-board

DSH 的**邮件看板**：把 [dsh-email](https://www.npmjs.com/package/dsh-email) 各账号的未读邮件按账号汇总成卡片列表，
展示在 Web 界面**右侧栏**的「邮件看板」tab 里。卡片显示发件人、主题与时间。

> **Unread-mail board for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**
> It collects unread mail from every `dsh-email` account into a per-account card list
> (sender / subject / time) rendered as a custom tab in the DSH right sidebar —
> read-only, manual refresh, and no model round-trip (it reuses dsh-email's own IMAP pool).

- **只读**：不会标记已读、不会删除、不会发信。
- **不经过模型、不调用工具**：宿主侧取的就是 `email_list` 的实现
  （`EmailPool.list(..., unreadOnly: true)`），所以刷新不消耗 token，也不会在会话里留下痕迹。
- **手动刷新**：打开 tab 拉一次，之后只有点右上角「刷新」才会重新读邮箱；宿主侧还有一层
  短路缓存（`cacheMs`），连点也不会把 IMAP 打爆。

## 安装

先确认 [dsh-email](https://www.npmjs.com/package/dsh-email) 已启用并配好账号（看板读它的设置）。

克隆本仓库，然后在 DSH 的「插件」页安装这个目录（安装框接受绝对路径）：

```
<克隆下来的 dsh-email-board 目录绝对路径>
```

安装器会执行 `pnpm add <路径>` 并把 `dsh-email-board` 追加到 profile 的 `dsh.profile.bundles`。
**重启 DSH** 之后，右侧栏开始页里就有「邮件看板」入口了。

手动安装等价于：

```powershell
cd $env:DSH_PROFILE_DIR            # 例如 C:\Users\<你>\.dsh\profiles\desktop
pnpm add file:<dsh-email-board 绝对路径>
# 然后把 "dsh-email-board" 追加到 package.json 的 dsh.profile.bundles 里
```

<details>
<summary>开发这个插件时踩过的两个坑（想改源码的话建议先看）</summary>

**1. `file:` 是快照，不是活链接。** `pnpm add file:<目录>` 会把文件**拷贝**进
`node_modules\dsh-email-board`（真实目录），之后你在源码目录里的改动**永远不会**进宿主进程，
重启多少次都一样。要在源码目录里持续开发，就把依赖写成 `link:<绝对路径>`（等价于手工建
junction），让 profile 读活文件：

```powershell
# package.json: "dsh-email-board": "link:C:/.../dsh-email-board"
New-Item -ItemType Junction -Path "$env:DSH_PROFILE_DIR\node_modules\dsh-email-board" `
  -Target "C:\...\dsh-email-board"
```

**2. 改代码一定要重启 DSH。** 宿主进程里的插件模块 import 一次就缓存住了；改 profile 配置
（bundle 列表、patch 层）只会重载配置树，**不会**让宿主重新 import 模块。桌面版 base 组合包
以 `hmr.root: []` 启用 HMR，等于关掉了模块文件监听，所以也没有代码热重载可指望。

</details>

## 打开看板

1. 打开右侧栏（会话 header 右上角的展开按钮，或快捷键）。
2. 在开始页里点「邮件看板」入口胶囊 —— tab 就此打开，之后跟着会话布局一起保存。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖插件的默认行：

```yaml
- id: email-board
  name: dsh-email-board
  config:
    accounts: []          # 空数组 = dsh-email 里配置的全部账号
    folder: ""            # 空 = 各账号自己的 inboxFolder
    perAccountLimit: 20   # 每个账号最多取多少封未读信封（1-100）
    cacheMs: 20000        # 宿主侧结果缓存，毫秒（连点刷新时的短路窗口）
    timeoutMs: 25000      # 单账号 IMAP 超时，毫秒
```

`accounts` 里的名字必须和 dsh-email 设置里的账号名一致；填了不存在的名字不会让整块看板失败，
只会让那个账号的位置显示一条错误。

## 实现

| 半侧 | 文件 | 职责 |
|---|---|---|
| 宿主 | [`lib/index.js`](lib/index.js) | 读 dsh-email 的设置行 → 用它公开导出的 `resolveEmailSettings` / `toEmailConfig` / `EmailPool` 取每个账号的未读信封 → 挂在同源只读路由 `/_dsh/dsh-email-board/state` |
| 客户端 | [`lib/client.js`](lib/client.js) | 注册右侧栏 tab 类型 `email-board` 与正文槽位 `sidebar.right.pane.tab`，按需读路由并渲染卡片 |

设计上的两个要点：

- **不复制 dsh-email 的内部实现**，只用它 `package.json` 里公开导出的 API，所以它升级内部结构
  不会连带打断看板。插件被链接进 profile 时，`dsh-email` 的解析会退回 profile 的 `node_modules`
  （见 `profileDirCandidates`）。
- **设置行按「显式候选 → 形状识别」两级查找**：`settings.describe()` 的 `ns` 用的是 profile
  **条目 id**（通常是 `tool-email`），不一定等于 dsh-email 自己注册的命名空间，写死名字必然踩空。

只读路由带同源判定：`Sec-Fetch-Site` 不是 `same-origin`/`none` 一律 403，非 GET 一律 405 ——
未读邮件的标题和发件人是隐私，不该被任意网页一次 GET 读走。

## 自检

```powershell
pnpm check                # node --check lib/index.js && lib/client.js
pnpm test                 # 迷你 React 跑一遍客户端注册 + 渲染（用随仓库的虚构样本，零依赖）
pnpm test:host            # 真实 IMAP：解析账号 → 取未读 → 路由响应（需要本机 profile 与 dsh-email）
node test/offline-route.mjs --fixture   # 把真机响应写到 test/fixture-state.local.json
```

`test/render-board.mjs` 优先读 `test/fixture-state.local.json`，没有就用随仓库发布的
**虚构样本** `test/fixture-state.json`；`*.local.json` 在 `.gitignore` 里，真实邮件数据
不会被误提交。

## 已知限制

- 只统计各账号 `inboxFolder`（或 `folder` 指定的那一个）里的未读，不遍历全部文件夹。
- 单个账号未读超过 `perAccountLimit` 时只显示最新若干封，并在分组里标注「只显示最新 N 封」。
- 卡片只读，想看正文仍然用会话里的 `email_read`。
- 没有定时轮询（刻意留到界面稳定后再加，客户端补一个 `setInterval` 即可）。

## 版本

- **v0.1.0**（2026-10-07）：首个版本 —— 手动刷新的右侧栏看板。完整说明见 [CHANGELOG.md](CHANGELOG.md)。
- 路线：界面稳定后再加自动更新（定时轮询）；卡片交互（标记已读 / 打开正文）待定。

## License

[MIT](LICENSE)
