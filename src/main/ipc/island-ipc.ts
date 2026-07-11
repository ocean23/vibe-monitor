import type { IslandState } from '../services/island-state'
import type { ApprovalRegistry } from '../services/island-approval'
import type { LaunchOptions } from '../services/terminal-launcher'
import type { ClaudeNotifyOpenSessionResult } from '../services/claude-notify-types'
import type { ApprovalDecision, SessionState, ApprovalRequest } from '../../shared/island-types'
import type { IpcMainHandleLike } from './settings-ipc'
import type { IslandWindowController } from '../window/island-window'
import {
  BAR_OVERLAP,
  BAR_SHOULDER,
  BAR_SHOULDER_H,
  COLLAPSED_BAR_WIDTH
} from '../services/island-geometry'

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
  /** 灵动岛窗口控制器：刘海几何查询 + resize/mouseIgnore 操作的唯一入口。 */
  islandWindow: IslandWindowController
}

/**
 * 注册灵动岛 IPC handler。
 *
 * - `island:list`：当前活跃会话快照（渲染端 hydrate + 兜底刷新）
 * - `island:pending`：当前待审批请求（覆盖灵动岛挂载晚于推送的竞态）
 * - `island:decision`：用户岛内裁决 → registry.resolve（回传 hook permissionDecision）
 * - `island:openSession`：点击卡片精准跳回 Ghostty tab（复用 terminal-launcher）
 * - `island:getNotchInfo`：渲染端查询刘海几何 + 渲染所需的派生尺寸
 * - `island:resize`：渲染端请求收起 / 展开时调整窗口
 * - `island:setMouseIgnore`：点击穿透开关
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

  // 渲染端查询刘海几何 + 渲染所需的派生尺寸。
  // height（刘海实高）：收起态黑条用，确保与刘海齐平。
  // topInset（菜单栏完整预留高）：展开态面板上方透明占位用——面板要落到完整菜单栏下方
  // 而非刘海下方（刘海更矮），否则面板顶部会钻进菜单栏区域。
  ipcMain.handle('island:getNotchInfo', () => {
    const notchInfo = deps.islandWindow.getNotchInfo()
    if (!notchInfo) return null
    return {
      ...notchInfo,
      overlap: BAR_OVERLAP, // 黑条右端钻进刘海背后的像素（CSS 用作内容右 padding 让位）
      shoulder: BAR_SHOULDER, // 左上椭圆凹肩水平半径（= 左侧透明预留宽）
      shoulderH: BAR_SHOULDER_H, // 左上椭圆凹肩垂直半径（> 水平 → 更陡）
      topInset: deps.islandWindow.getNotchTopInset(), // 展开态面板上方透明占位
      barWidth: COLLAPSED_BAR_WIDTH
    }
  })

  // 渲染端请求收起 / 展开时调整窗口（始终锚定刘海所在的内建屏）：
  // - 收起（黑条）：贴刘海左侧、与刘海等高，几何由 collapsedBounds 决定（忽略传入尺寸）
  // - 展开（面板）：左缘锚定黑条左缘向右下展开，y 贴内建屏顶 + 顶部透明占位让面板落在刘海下方
  ipcMain.handle('island:resize', async (_evt, arg: unknown): Promise<void> => {
    const a = (arg ?? {}) as { expanded?: unknown; width?: unknown; height?: unknown }
    if (a.expanded !== true) {
      deps.islandWindow.collapse()
      return
    }
    const num = (v: unknown, def: number, max: number): number =>
      typeof v === 'number' && v > 0 ? Math.min(Math.round(v), max) : def
    const defaultSize = deps.islandWindow.getDefaultExpandSize()
    const w = num(a.width, defaultSize.width, 1200)
    const h = num(a.height, defaultSize.height, 900)
    deps.islandWindow.expand(w, h)
  })

  // 点击穿透开关：渲染端在「收起且未 hover、无审批」时请求 ignore=true，让刘海两侧
  // 透明区域的点击穿透到菜单栏 / 下层应用（窗口侧 forward:true 仍转发 move 事件，故穿透态
  // 下 pill 的 onMouseEnter 仍能触发以重新激活交互）。默认（未收到调用）为可交互，安全兜底。
  ipcMain.handle('island:setMouseIgnore', async (_evt, ignore: unknown): Promise<void> => {
    deps.islandWindow.setMouseIgnore(ignore === true)
  })
}
