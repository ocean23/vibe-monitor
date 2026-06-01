import type { IslandState } from '../services/island-state'
import type { ApprovalRegistry } from '../services/island-approval'
import type { LaunchOptions } from '../services/terminal-launcher'
import type { ClaudeNotifyOpenSessionResult } from '../services/claude-notify-types'
import type { ApprovalDecision, SessionState, ApprovalRequest } from '../../shared/island-types'
import type { IpcMainHandleLike } from './settings-ipc'

const VALID_DECISIONS: ReadonlySet<string> = new Set<ApprovalDecision>([
  'deny',
  'allow_once',
  'bypass'
])

export interface IslandIpcDeps {
  state: IslandState
  registry: ApprovalRegistry
  /** terminal-launcher 实例（复用 createLauncher 返回），按 mode 决定行为 */
  launcher: (options: LaunchOptions) => Promise<ClaudeNotifyOpenSessionResult>
  /** 从 Settings 读取当前终端 app（如 'Ghostty'） */
  getTerminalApp: () => string
  /**
   * 解析会话的 Claude 自动标题（= 终端 tab 名正文），供 openSession 精准匹配 tab。
   * 可选；缺省 / 取不到时回退用 sessionName 做 needle（见 readAiTitle 注释）。
   */
  resolveMatchTitle?: (sessionId: string) => Promise<string | undefined>
}

/**
 * 注册灵动岛 IPC handler。
 *
 * - `island:list`：当前活跃会话快照（渲染端 hydrate + 兜底刷新）
 * - `island:pending`：当前待审批请求（覆盖灵动岛挂载晚于推送的竞态）
 * - `island:decision`：用户岛内裁决 → registry.resolve（回传 hook permissionDecision）
 * - `island:openSession`：点击卡片精准跳回 Ghostty tab（复用 terminal-launcher）
 */
export function registerIslandIpc(ipcMain: IpcMainHandleLike, deps: IslandIpcDeps): void {
  ipcMain.handle('island:list', async (): Promise<SessionState[]> => {
    return deps.state.list()
  })

  ipcMain.handle('island:pending', async (): Promise<ApprovalRequest[]> => {
    return deps.registry.pending()
  })

  ipcMain.handle('island:decision', async (_event, requestId, decision): Promise<boolean> => {
    const id = String(requestId ?? '')
    const d = String(decision ?? '')
    if (!id || !VALID_DECISIONS.has(d)) return false
    deps.registry.resolve(id, d as ApprovalDecision)
    return true
  })

  ipcMain.handle(
    'island:openSession',
    async (_event, sessionId): Promise<ClaudeNotifyOpenSessionResult> => {
      const id = String(sessionId ?? '')
      if (!id) return { ok: false, mode: 'no_session_id' }
      const session = deps.state.list().find((s) => s.sessionId === id)
      if (!session) return { ok: false, mode: 'no_session_id', reason: 'not-found' }
      // tab 匹配 needle 优先用 Claude 自动标题（= Ghostty tab 名正文，稳定命中）；取不到再
      // 回退 sessionName（prompt 首行，常与 tab 名不一致 → 落到 activate-only 不切 tab）。
      const matchTitle = (await deps.resolveMatchTitle?.(id)) || session.sessionName
      return deps.launcher({
        app: deps.getTerminalApp(),
        sessionId: id,
        sessionName: matchTitle
      })
    }
  )
}
