/**
 * 全局 electronAPI 类型声明
 * 由 src/main/preload.ts 通过 contextBridge 暴露。
 */
export {}

import type { AppSettings } from '../store/settings-store'
import type { SessionState, ApprovalRequest, ApprovalDecision } from '../../../shared/island-types'

export type { SessionState, ApprovalRequest, ApprovalDecision }

/** island:openSession invoke 返回结构（与 src/main/services/claude-notify-types.ts 对齐）。 */
export interface OpenSessionResult {
  ok: boolean
  mode: string
  reason?: string
  matchedTab?: string
}

declare global {
  interface Window {
    electronAPI?: {
      loadSettings: () => Promise<Partial<AppSettings> | null>
      saveSettings: (patch: Partial<AppSettings>) => Promise<Partial<AppSettings>>
      onSettingsChanged: (cb: (settings: Partial<AppSettings>) => void) => () => void
      // ── 灵动岛 ──
      islandGetNotchInfo: () => Promise<{
        hasNotch: boolean
        width: number
        cornerRadius: number
        height: number
        overlap: number
        shoulder: number
        shoulderH: number
        topInset: number
        barWidth: number
      } | null>
      islandList: () => Promise<SessionState[]>
      islandPending: () => Promise<ApprovalRequest[]>
      islandDecision: (requestId: string, decision: ApprovalDecision) => Promise<boolean>
      islandOpenSession: (sessionId: string) => Promise<OpenSessionResult>
      islandResize: (arg: { expanded?: boolean; width?: number; height?: number }) => Promise<void>
      islandSetMouseIgnore: (ignore: boolean) => Promise<void>
      onIslandNotchChanged: (cb: () => void) => () => void
      onIslandUpdate: (cb: (sessions: SessionState[]) => void) => () => void
      onIslandApproval: (cb: (req: ApprovalRequest) => void) => () => void
      onIslandApprovalResolved: (cb: (requestId: string) => void) => () => void
    }
  }
}
