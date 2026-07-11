import { app, ipcMain, screen, clipboard, globalShortcut } from 'electron'
import { join } from 'node:path'
import os from 'node:os'

import { audit, setAuditRoot } from './audit-log'
import { runCommand } from './services/run-command'
import { ensureIslandConfig, patchIslandConfig } from './services/island-config'
import { IslandState } from './services/island-state'
import { ApprovalRegistry } from './services/island-approval'
import { createIslandServer, type IslandServer } from './services/island-server'
import { createTranscriptWatcher, type TranscriptWatcher } from './services/transcript-watcher'
import { readAiTitle } from './services/session-title'
import { registerIslandIpc } from './ipc/island-ipc'
import { createIslandWindowController, type IslandWindowController } from './window/island-window'
import { createTrayController, resolveTerminalApp, type TrayController } from './tray'
import { createLauncher } from './services/terminal-launcher'
import { createEnsureSpaceAutoSwitch } from './services/space-switch'
import { SettingsService, registerSettingsIpc } from './ipc/settings-ipc'
import type { SessionState, ApprovalRequest, ApprovalDecision } from '../shared/island-types'

/** 所有运行态数据（island.json / settings.json / audit/）的单一根目录。 */
const VIBE_DIR = join(os.homedir(), '.vibe-monitor')

let islandWindow: IslandWindowController | null = null
let islandServer: IslandServer | null = null
let islandWatcher: TranscriptWatcher | null = null
let islandRegistry: ApprovalRegistry | null = null
let islandState: IslandState | null = null
let settingsService: SettingsService | null = null
let tray: TrayController | null = null

// 单实例锁：固定端口 7842 决定了同机只能跑一个 Vibe Monitor。第二个实例直接退出，
// 并把已有实例的岛唤到前台——否则第二个进程会在 createIslandServer 处 EADDRINUSE，
// setupIsland 吞掉异常后半启动成「无窗口、无 server」的僵尸进程（仍占 Dock）。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    islandWindow?.getWindow()?.show()
    islandWindow?.getWindow()?.focus()
  })
}

/** 落盘设置补丁；'change' 事件会触发托盘菜单刷新 + 推送渲染端。 */
async function saveSettingsPatch(patch: Record<string, unknown>): Promise<void> {
  await settingsService?.save(patch)
}

/**
 * 装配灵动岛：环回 HTTP server + 状态机 + 审批回环 + transcript watcher + 窗口 + IPC。
 * 任一步骤失败均 audit 后降级（不阻塞启动）。
 */
async function setupIsland(deps: {
  launcher: (
    options: import('./services/terminal-launcher').LaunchOptions
  ) => Promise<import('./services/claude-notify-types').ClaudeNotifyOpenSessionResult>
  getTerminalApp: () => string
}): Promise<void> {
  try {
    const config = await ensureIslandConfig({ audit })
    // 启动时把 settings.json 里的 trustAll 同步写入 island.json（hook 从此读取）
    const initTrustAll = settingsService?.getSettings().trustAll === true
    if (config.trustAll !== initTrustAll) {
      await patchIslandConfig({ trustAll: initTrustAll }, { audit })
    }

    const window = createIslandWindowController({
      audit,
      preloadPath: join(__dirname, '../preload/index.js'),
      rendererFilePath: join(__dirname, '../renderer/index.html'),
      runOsascript: (script) =>
        runCommand('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], undefined, 2000)
    })
    islandWindow = window
    // 在创建窗口前检测刘海尺寸；失败时降级为顶部居中宽条模式
    await window.detect()

    const state = new IslandState({ audit })
    islandState = state
    // 周期性把陈旧的 running 会话降级为 idle（兜底 Stop 丢失 / 斜杠命令卡死）
    state.startStaleSweep()
    const registry = new ApprovalRegistry({ audit })
    islandRegistry = registry

    // 岛内审批键盘直达：有待审批请求时注册全局快捷键，无需先点亮/聚焦灵动岛即可裁决队首请求——
    // 用户可一边盯终端一边一键放行/Bypass（FR-007 直接在岛内操作）。仅在 pending>0 期间占用，
    // 队列清空即注销，把对系统级快捷键的拦截窗口压到最小。Deny 刻意不配键（避免误触一键拒绝）。
    let approveShortcutsActive = false
    const APPROVAL_SHORTCUTS: Array<{ accel: string; decision: ApprovalDecision }> = [
      { accel: 'Control+Y', decision: 'allow_once' },
      { accel: 'Control+B', decision: 'bypass' }
    ]
    const syncApproveShortcuts = (): void => {
      const shouldActivate = registry.pending().length > 0
      if (shouldActivate === approveShortcutsActive) return
      if (shouldActivate) {
        for (const { accel, decision } of APPROVAL_SHORTCUTS) {
          const ok = globalShortcut.register(accel, () => {
            const head = registry.pending()[0]
            if (!head) return
            registry.resolve(head.requestId, decision)
            void audit('island.approval_shortcut', { requestId: head.requestId, decision })
          })
          if (!ok) void audit('island.approval_shortcut_register_failed', { accel })
        }
        approveShortcutsActive = true
      } else {
        for (const { accel } of APPROVAL_SHORTCUTS) globalShortcut.unregister(accel)
        approveShortcutsActive = false
      }
    }

    // 状态变更 / 审批请求 → 推送灵动岛窗口
    state.on('change', (sessions: SessionState[]) => {
      window.send('island:update', sessions)
    })
    registry.on('request', (req: ApprovalRequest) => {
      window.send('island:approval', req)
      syncApproveShortcuts()
    })
    registry.on('resolved', (payload: { requestId: string }) => {
      window.send('island:approval-resolved', payload.requestId)
      syncApproveShortcuts()
    })

    islandServer = await createIslandServer({ config, state, registry, audit })

    const projectsDir = join(app.getPath('home'), '.claude', 'projects')
    islandWatcher = createTranscriptWatcher({ projectsDir, state, audit })

    registerIslandIpc(ipcMain, {
      state,
      registry,
      launcher: deps.launcher,
      getTerminalApp: deps.getTerminalApp,
      // 跳转匹配 needle 取会话的 Claude 自动标题（transcript 里的 ai-title）——它正是
      // Ghostty tab 名正文，比 prompt 首行可靠。点击时按 sessionId 现读 transcript。
      resolveMatchTitle: (id) => readAiTitle(projectsDir, id),
      islandWindow: window
    })

    window.create()

    // 显示器拓扑变化（插拔外接屏 / 改主屏 / 分辨率变化）→ 重新检测刘海并把岛拉回内建屏。
    // 不重新检测的话：① 岛可能停留在已拔掉的屏的坐标（变成不可见）；② 内建屏分辨率/缩放
    // 变了刘海宽高会变。debounce 250ms 合并 macOS 切换拓扑时的连串事件。
    let repositionTimer: NodeJS.Timeout | null = null
    const scheduleReposition = (): void => {
      if (repositionTimer) clearTimeout(repositionTimer)
      repositionTimer = setTimeout(() => {
        repositionTimer = null
        void window.reposition()
      }, 250)
    }
    screen.on('display-added', scheduleReposition)
    screen.on('display-removed', scheduleReposition)
    screen.on('display-metrics-changed', scheduleReposition)
  } catch (err) {
    await audit('island.setup_failed', { error: (err as Error).message })
    // 半启动回滚：避免留下「占着 7842 端口 / staleSweep 仍在转 / 无窗口」的僵尸态
    islandState?.stopStaleSweep()
    islandWatcher?.close()
    void islandServer?.close()
  }
}

app.whenReady().then(async () => {
  app.setName('Vibe Monitor')
  setAuditRoot(VIBE_DIR)

  settingsService = new SettingsService({ rootDir: VIBE_DIR })
  await settingsService.load()
  registerSettingsIpc(ipcMain, settingsService)

  // islandEnabled 总开关：显式 false 时不创建窗口/server 直接退出——否则主进程仍会
  // 造一个透明置顶窗口，渲染端只画空 div，留下一条看不见却拦截点击的「鼠标陷阱」。
  if (settingsService.getSettings().islandEnabled === false) {
    await audit('island.disabled_by_setting', {})
    app.quit()
    return
  }

  const launchToTerminal = createLauncher({
    runCommand,
    clipboard,
    platform: process.platform,
    audit,
    // 确保 macOS「切换应用时跳到其窗口所在 Space」开关开启，使位于其它虚拟桌面的
    // Ghostty 也能被 activate 切过去（首个进程生命周期内最多触发一次 killall Dock）。
    ensureSpaceAutoSwitch: createEnsureSpaceAutoSwitch({
      runCommand,
      platform: process.platform,
      audit
    })
  })
  const getTerminalApp = (): string => resolveTerminalApp(settingsService?.getSettings() ?? {})

  await setupIsland({ launcher: launchToTerminal, getTerminalApp })

  // settings 变更（来自托盘/渲染端）→ 推送渲染端（即时生效）+ 刷新托盘 + 同步 trustAll 到 island.json。
  settingsService.on('change', (s: Record<string, unknown>) => {
    islandWindow?.send('settings:changed', s)
    tray?.refresh()
    void patchIslandConfig({ trustAll: s.trustAll === true }, { audit })
  })

  tray = createTrayController({
    runCommand,
    getSettings: () => settingsService?.getSettings() ?? {},
    saveSettingsPatch,
    isIslandWindowVisible: () => islandWindow?.getWindow()?.isVisible() ?? false,
    showIslandWindow: () => islandWindow?.getWindow()?.show(),
    hideIslandWindow: () => islandWindow?.getWindow()?.hide()
  })
  tray.create()

  app.on('activate', () => {
    // 灵动岛被关闭后（macOS 重新激活）重建。
    if (!islandWindow?.getWindow()) islandWindow?.create()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  globalShortcut.unregisterAll()
  screen.removeAllListeners('display-added')
  screen.removeAllListeners('display-removed')
  screen.removeAllListeners('display-metrics-changed')
  islandState?.stopStaleSweep()
  islandRegistry?.drain()
  islandWatcher?.close()
  void islandServer?.close()
  tray?.destroy()
})
