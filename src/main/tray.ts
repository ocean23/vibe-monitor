import { app, Tray, Menu, nativeImage, dialog } from 'electron'
import { join } from 'node:path'
import { TRAY_ICON_DATA_URL } from './tray-icon'
import type { RunCommandResult } from './services/terminal-launcher'

/** 「跳回终端」可选的终端 App（托盘单选）。 */
export const TERMINAL_APPS = [
  'Ghostty',
  'iTerm',
  'Terminal',
  'Alacritty',
  'WezTerm',
  'Warp'
] as const

/** 当前生效的终端 app（默认 Ghostty），供 island openSession 跳回终端。 */
export function resolveTerminalApp(s: { terminalApp?: unknown }): string {
  const v = s.terminalApp
  const trimmed = typeof v === 'string' ? v.trim() : ''
  return trimmed || 'Ghostty'
}

export interface TraySettingsSnapshot {
  terminalApp?: unknown
  islandSoundEnabled?: unknown
  trustAll?: unknown
}

export interface TrayDeps {
  runCommand: (
    cmd: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
    timeoutMs?: number
  ) => Promise<RunCommandResult>
  getSettings: () => TraySettingsSnapshot
  saveSettingsPatch: (patch: Record<string, unknown>) => Promise<void>
  isIslandWindowVisible: () => boolean
  showIslandWindow: () => void
  hideIslandWindow: () => void
}

export interface TrayController {
  create(): void
  refresh(): void
  destroy(): void
}

/** hook 安装脚本路径：打包态从 Resources/tools 读（extraResources），dev 态从仓库 tools/ 读。 */
function installerScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tools', 'island-hooks-install.mjs')
    : join(__dirname, '../../tools/island-hooks-install.mjs')
}

/** 创建菜单栏托盘（灵动岛唯一的退出 / 设置入口）。 */
export function createTrayController(deps: TrayDeps): TrayController {
  let tray: Tray | null = null

  /**
   * 跑 hook 安装/卸载脚本，结果弹原生对话框。
   *
   * 用 Electron 自带的 Node（`process.execPath` + `ELECTRON_RUN_AS_NODE`）执行，**不依赖**
   * 系统 `node`——打包后的 .app 从 Finder 启动时 PATH 极简（常缺 node / homebrew 路径），
   * 直接 spawn('node') 会 ENOENT。写进 settings.json 的 hook 命令仍是 `node …`，那条由
   * Claude Code 在终端环境执行（PATH 正常），不受影响。
   */
  async function runHookInstaller(uninstall: boolean): Promise<void> {
    const script = installerScriptPath()
    const r = await deps.runCommand(
      process.execPath,
      uninstall ? [script, '--uninstall'] : [script],
      {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1'
      }
    )
    const ok = r.code === 0
    await dialog.showMessageBox({
      type: ok ? 'info' : 'error',
      title: 'Vibe Monitor',
      message: ok
        ? uninstall
          ? '已移除 Claude Code hooks'
          : '已注册 Claude Code hooks'
        : 'hook 操作失败',
      detail: (ok ? r.stdout : r.stderr || r.stdout).trim().slice(0, 600) || `exit ${r.code}`
    })
  }

  /** 重建托盘菜单——勾选态（终端 / 音效 / 自启 / 显隐）随当前 settings 实时刷新。 */
  function refresh(): void {
    if (!tray) return
    const s = deps.getSettings()
    const currentTerm = resolveTerminalApp(s)
    const soundOn = s.islandSoundEnabled !== false
    const trustAllOn = s.trustAll === true
    const loginOn = app.getLoginItemSettings().openAtLogin
    const visible = deps.isIslandWindowVisible()

    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: visible ? '隐藏灵动岛' : '显示灵动岛',
          click: () => {
            if (deps.isIslandWindowVisible()) deps.hideIslandWindow()
            else deps.showIslandWindow()
            refresh()
          }
        },
        { type: 'separator' },
        {
          label: '终端 App',
          submenu: TERMINAL_APPS.map((name) => ({
            label: name,
            type: 'radio' as const,
            checked: currentTerm === name,
            click: () => void deps.saveSettingsPatch({ terminalApp: name })
          }))
        },
        {
          label: '状态音效',
          type: 'checkbox',
          checked: soundOn,
          click: () => void deps.saveSettingsPatch({ islandSoundEnabled: !soundOn })
        },
        {
          label: '跳过审批',
          type: 'checkbox',
          checked: trustAllOn,
          click: () => void deps.saveSettingsPatch({ trustAll: !trustAllOn })
        },
        {
          label: '开机自启',
          type: 'checkbox',
          checked: loginOn,
          click: () => {
            app.setLoginItemSettings({ openAtLogin: !loginOn })
            refresh()
          }
        },
        { type: 'separator' },
        { label: '注册 Claude Code hooks…', click: () => void runHookInstaller(false) },
        { label: '移除 Claude Code hooks…', click: () => void runHookInstaller(true) },
        { type: 'separator' },
        { label: '退出 Vibe Monitor', click: () => app.quit() }
      ])
    )
  }

  function create(): void {
    const img = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
    img.setTemplateImage(true)
    tray = new Tray(img)
    tray.setToolTip('Vibe Monitor')
    refresh()
  }

  return {
    create,
    refresh,
    destroy: () => {
      tray?.destroy()
    }
  }
}
