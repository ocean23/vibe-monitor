import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // ── 设置（落盘 ~/.vibe-monitor/settings.json）──
  loadSettings: () =>
    ipcRenderer.invoke('settings:load') as Promise<Record<string, unknown> | null>,
  saveSettings: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke('settings:save', patch) as Promise<Record<string, unknown>>,
  /** 订阅主进程（托盘）推送的设置变更，让渲染端的音效开关等即时生效。 */
  onSettingsChanged: (cb: (settings: Record<string, unknown>) => void): (() => void) => {
    const listener = (_e: unknown, s: unknown): void => cb((s ?? {}) as Record<string, unknown>)
    ipcRenderer.on('settings:changed', listener)
    return () => ipcRenderer.removeListener('settings:changed', listener)
  },

  // ── 灵动岛（Notch Island）──
  /** 当前活跃会话快照（渲染端 hydrate + 兜底刷新）。 */
  islandList: () => ipcRenderer.invoke('island:list') as Promise<unknown[]>,
  /** 当前待审批请求（覆盖灵动岛挂载晚于推送的竞态）。 */
  islandPending: () => ipcRenderer.invoke('island:pending') as Promise<unknown[]>,
  /** 用户岛内裁决：requestId + decision(deny/allow_once/bypass)。 */
  islandDecision: (requestId: string, decision: string) =>
    ipcRenderer.invoke('island:decision', requestId, decision) as Promise<boolean>,
  /** 点击卡片精准跳回终端对应 tab（复用 terminal-launcher）。 */
  islandOpenSession: (sessionId: string) =>
    ipcRenderer.invoke('island:openSession', sessionId) as Promise<{
      ok: boolean
      mode: string
      reason?: string
      matchedTab?: string
    }>,
  /** 查询刘海几何 + 渲染派生尺寸（黑条高/底-左圆角/内容右让位 overlap/展开占位 topInset）。 */
  islandGetNotchInfo: () =>
    ipcRenderer.invoke('island:getNotchInfo') as Promise<{
      hasNotch: boolean
      width: number
      cornerRadius: number
      height: number
      overlap: number
      shoulder: number
      shoulderH: number
      topInset: number
      barWidth: number
    } | null>,
  /** 请求调整灵动岛窗口：expanded 决定「收起黑条 / 展开面板」两种几何。 */
  islandResize: (arg: { expanded?: boolean; width?: number; height?: number }) =>
    ipcRenderer.invoke('island:resize', arg) as Promise<void>,
  /** 点击穿透开关：ignore=true 时透明区域点击穿透到下层（收起态）；false 时窗口可交互。 */
  islandSetMouseIgnore: (ignore: boolean) =>
    ipcRenderer.invoke('island:setMouseIgnore', ignore) as Promise<void>,
  /** 订阅刘海几何变化推送（插拔外接屏 / 改分辨率后，渲染端据此重取 notchInfo 刷新 CSS 变量）。 */
  onIslandNotchChanged: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('island:notch-changed', listener)
    return () => ipcRenderer.removeListener('island:notch-changed', listener)
  },
  /** 订阅会话状态变更推送。 */
  onIslandUpdate: (cb: (sessions: unknown) => void): (() => void) => {
    const listener = (_e: unknown, sessions: unknown): void => cb(sessions)
    ipcRenderer.on('island:update', listener)
    return () => ipcRenderer.removeListener('island:update', listener)
  },
  /** 订阅新审批请求推送（灵动岛据此自动展开审批面板）。 */
  onIslandApproval: (cb: (req: unknown) => void): (() => void) => {
    const listener = (_e: unknown, req: unknown): void => cb(req)
    ipcRenderer.on('island:approval', listener)
    return () => ipcRenderer.removeListener('island:approval', listener)
  },
  /** 订阅审批已结案推送（用户裁决 / 超时 / drain）——据此从面板移除该请求。 */
  onIslandApprovalResolved: (cb: (requestId: string) => void): (() => void) => {
    const listener = (_e: unknown, id: unknown): void => cb(typeof id === 'string' ? id : '')
    ipcRenderer.on('island:approval-resolved', listener)
    return () => ipcRenderer.removeListener('island:approval-resolved', listener)
  }
}

export type VibeAPI = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electronAPI', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (no DOM types in preload)
  window.electronAPI = api
}
