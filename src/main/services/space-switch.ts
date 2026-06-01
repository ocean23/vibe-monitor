import type { RunCommandResult } from './terminal-launcher'
import type { AuditFn } from '../audit-log'

/**
 * macOS「切换到某个应用程序时，切换到含有该应用程序已打开窗口的空间」开关，
 * 对应系统设置 → 桌面与程序坞 → 调度中心。关闭时 `tell app to activate` 不会跨
 * 虚拟桌面（Space），导致点击灵动岛卡片无法跳到位于其它桌面的 Ghostty。
 *
 * 该开关存于 `com.apple.dock` 域的 `workspaces-auto-swoosh` key；现代 macOS 默认
 * 未设置（=关闭）。开启后需 `killall Dock` 让 Dock 重新读取偏好才生效。
 */
const DOCK_DOMAIN = 'com.apple.dock'
const SWOOSH_KEY = 'workspaces-auto-swoosh'

export interface SpaceSwitchDeps {
  /** 包装 child_process.spawn，与 launcher 共用同一注入实现，便于单测 mock。 */
  runCommand: (cmd: string, args: string[]) => Promise<RunCommandResult>
  /** 通常 `process.platform`；非 darwin 直接 no-op。 */
  platform: NodeJS.Platform
  audit: AuditFn
  /** 注入点：开启后等待 Dock 重启生效的延时（ms），默认 600；测试传 0 跳过等待。 */
  settleMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 返回 `ensureSpaceAutoSwitch`：保证「切换应用时跳到其窗口所在 Space」开关已开启。
 *
 * 行为：
 * - 非 darwin → 直接标记已处理，no-op。
 * - 读 `defaults read com.apple.dock workspaces-auto-swoosh`，已是 `1/true` → no-op。
 * - 否则 `defaults write ... -bool true` + `killall Dock`，并短暂 settle 等 Dock 重启
 *   生效（否则紧接着的同一次跳转可能赶在 Dock 重读偏好前、仍不切 Space）。
 *
 * **进程内 memo**：一旦确认开启（或本进程已写入过），后续调用直接 no-op，避免每次
 * 点击卡片都 spawn `defaults`。只在「确实开启成功」或「读到已开启」时置位——写入失败
 * 不置位，下次跳转会重试。
 *
 * **幂等 & 尊重用户**：只在当前为关闭态时才写入 + killall，所以正常情况下整个生命周期
 * 最多触发一次 Dock 重启（一次性闪烁）。若用户事后手动关掉，本进程因 memo 不再强行
 * 改回；重启 app 后若用户又点跳转，才会再次开启（这正是该功能正常工作的前提）。
 */
export function createEnsureSpaceAutoSwitch(deps: SpaceSwitchDeps): () => Promise<void> {
  let handled = false
  const settleMs = deps.settleMs ?? 600
  return async function ensureSpaceAutoSwitch(): Promise<void> {
    if (handled) return
    if (deps.platform !== 'darwin') {
      handled = true
      return
    }
    try {
      const read = await deps.runCommand('defaults', ['read', DOCK_DOMAIN, SWOOSH_KEY])
      const val = read.stdout.trim()
      // key 不存在时 `defaults read` 以非零退出（stderr: does not exist）→ 走开启分支。
      if (read.code === 0 && (val === '1' || val === 'true')) {
        handled = true
        return
      }
      const write = await deps.runCommand('defaults', [
        'write',
        DOCK_DOMAIN,
        SWOOSH_KEY,
        '-bool',
        'true'
      ])
      if (write.code !== 0) {
        await deps.audit('claude_notify.space_switch_failed', {
          step: 'write',
          stderr: write.stderr.slice(0, 200)
        })
        return
      }
      await deps.runCommand('killall', ['Dock'])
      handled = true
      if (settleMs > 0) await sleep(settleMs)
      await deps.audit('claude_notify.space_switch_enabled', {})
    } catch (err) {
      await deps.audit('claude_notify.space_switch_failed', {
        step: 'ensure',
        error: (err as Error).message
      })
    }
  }
}
