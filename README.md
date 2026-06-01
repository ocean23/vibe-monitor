# Vibe Monitor（灵动岛）

**本地 Claude Code 会话监控 + 岛内审批** —— 一个常驻屏幕顶部刘海区的「灵动岛」，实时显示本机所有 Claude Code 会话状态（运行 / 等待 / 完成 / 出错），并能直接在岛内对工具调用做授权裁决，点击卡片精准跳回对应终端 tab。

> **纯本地工具**：数据源是本机 Claude Code hooks → `127.0.0.1` 环回 HTTP，零网络出口，不依赖任何后端服务。

## 工作原理

```
Claude Code ──hooks──> island-hook.mjs ──HTTP 127.0.0.1:7842──> Vibe Monitor（Electron 主进程）
  SessionStart                                                    ├─ island-server  环回 HTTP + token 鉴权
  UserPromptSubmit                                                ├─ island-state   会话状态机
  PreToolUse (阻塞审批) <──── permissionDecision ────────────────┤─ approval        审批回环（60s 超时兜底）
  Notification                                                    ├─ transcript-watcher  读 ~/.claude/projects
  Stop                                                            └─ island window  透明置顶刘海窗口
```

- **状态上报**：SessionStart / UserPromptSubmit / Notification / Stop 走 `POST /event`，fire-and-forget。
- **岛内审批**：`PreToolUse` 在 `default/plan` 模式下 `POST /approval` **阻塞**等待岛内裁决，把结果翻译成 Claude Code 的 `permissionDecision`（allow / deny / ask）。`bypassPermissions/acceptEdits` 直接放行不打扰。
- **容错铁律**：Vibe Monitor 未运行 / 超时 → hook 输出 `ask` 交回终端原生询问，**绝不卡死 Claude 会话**。

## 安装与运行

```bash
pnpm install          # 安装依赖（postinstall 会顺带 patch electron 的 bundle 名）
pnpm dev              # electron-vite 热重载开发
pnpm build            # 产物到 out/
pnpm dist             # electron-builder 打包到 release/
```

### 注册 Claude Code hooks

让本机的 `claude` 把事件上报给 Vibe Monitor：

- **App 内**：菜单栏托盘图标 → 「注册 Claude Code hooks…」（打包后的 `.dmg` 也走这条，hook 脚本随 `extraResources` 打进 `Contents/Resources/tools/`）。
- **命令行**（从源码跑时）：

```bash
pnpm install-hooks      # 幂等写入 ~/.claude/settings.json（写前自动备份）
pnpm uninstall-hooks    # 移除本工具注册的 hook
node tools/island-hooks-install.mjs --dry-run   # 只打印合并结果，不落盘
```

注册 6 个事件：`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `Notification` / `Stop` / `SessionEnd`，每个事件追加一条 `node <abs>/island-hook.mjs`。其中 `SessionEnd` 让会话退出（Ctrl+C/Ctrl+D、`/clear`、logout）即从灵动岛移除。

> ✅ `PreToolUse` 的授权裁决在本机完成，所有数据不出本机（零网络出口），无远程 / 手机推送链路。

## 首次设置 &「0 sessions」排查

新机器从零跑通需要三步——**`pnpm dev` 只起 app + server，装好后是一条空岛（0 sessions）；真正让会话数据进来的是「注册 hook」这一步**：

```bash
pnpm install            # 1. 装依赖
pnpm dev                # 2. 起 app：自动写 ~/.vibe-monitor/island.json（端口 7842 + token）并起 server
pnpm install-hooks      # 3. 注册 hook（或点菜单栏托盘「注册 Claude Code hooks…」）
#                          ↑ 最容易漏的一步。装完后须【新开一个 claude 会话】才生效
```

> ⚠️ hook 配置在 Claude Code **启动时**读取——已经在跑的会话不会重载，注册后必须重开 `claude` 才会上报；当前正在跑的旧会话不出现在岛上属正常。

### 还是 0 sessions？按这三步自查

| 自查              | 命令                                              | 期望                                                    |
| ----------------- | ------------------------------------------------- | ------------------------------------------------------- |
| ① hook 是否注册   | `grep -c island-hook.mjs ~/.claude/settings.json` | `6`（6 个事件）；为 `0` → 没装，跑 `pnpm install-hooks` |
| ② server 是否在跑 | `lsof -nP -iTCP:7842 -sTCP:LISTEN`                | 有 Electron 进程 LISTEN；否则 app 没起，`pnpm dev`      |
| ③ 是否重开了会话  | ——                                                | 注册 hook 后开的**新** `claude` 才会出现，旧会话不算    |

### 跨机器易踩的坑

| 坑                             | 说明                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **别拷别人的 `settings.json`** | hook 命令写的是**本机绝对路径** `node <abs>/island-hook.mjs`（见上节）。拷到路径不同的机器会指向不存在的文件 → hook 静默失败。每台机器都要**各自**跑一次 `pnpm install-hooks` / 托盘按钮。 |
| **`node` 要在终端 PATH 里**    | hook 命令是裸 `node …`，由 Claude Code 在终端环境执行。用 nvm/fnm 时确认跑 `claude` 的 shell `which node` 有结果，否则 hook 静默 no-op（设计上绝不卡死 Claude）。                          |
| **app 要常驻**                 | `pnpm dev` 窗口关了 server 就没了 → 退回 0 sessions。长期用建议 `pnpm dist` 打包 + 托盘勾「开机自启」。                                                                                    |
| **仅 macOS**                   | transcript 增量监听（`fs.watch recursive`）、刘海检测、跳回终端（osascript/JXA）均为 macOS 专属。                                                                                          |

## 运行态数据

全部落在 `~/.vibe-monitor/`：

| 文件               | 用途                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| `island.json`      | 环回端口（固定 7842）+ token，hook 据此鉴权连接                                   |
| `settings.json`    | `terminalApp`（跳回终端用，默认 Ghostty）/ `islandEnabled` / `islandSoundEnabled` |
| `audit/<date>.log` | 跨切面审计（JSON Lines，按日轮转）                                                |

## 菜单栏托盘

灵动岛本身是无边框置顶窗口，所有控制集中在**菜单栏托盘图标**：

- 显示 / 隐藏灵动岛
- **终端 App**（单选，跳回终端用，默认 Ghostty）
- **状态音效** 开关（即时推送渲染端生效）
- **开机自启**
- 注册 / 移除 Claude Code hooks
- 退出

`terminalApp` / `islandSoundEnabled` / `islandEnabled` 也可直接改 `~/.vibe-monitor/settings.json`。

## 退出

托盘菜单「退出 Vibe Monitor」或 **⌘Q**——退出时会优雅关闭环回 server、停止 watcher、清空审批队列、销毁托盘。单实例锁保证同机只跑一个实例（再次启动会唤回已有的岛）。

## 开发

| 任务     | 命令                                        |
| -------- | ------------------------------------------- |
| 类型检查 | `pnpm typecheck`（双 tsconfig：node + web） |
| 单元测试 | `pnpm test:run`（vitest，node 环境）        |
| 覆盖率   | `pnpm test:coverage`                        |
| Lint     | `pnpm lint`                                 |
| Format   | `pnpm format`                               |

源码结构：`src/main` 主进程 / `src/renderer` React / `src/shared` 共享类型 / `tools` hook 脚本。
