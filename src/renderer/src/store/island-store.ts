import { create } from 'zustand'
import type {
  SessionState,
  SessionStatus,
  ApprovalRequest,
  ApprovalDecision
} from '../../../shared/island-types'

/** 状态紧急度排序：waiting（等审批/输入）最紧急 > error > running > done > idle。 */
export const STATUS_URGENCY: Record<SessionStatus, number> = {
  waiting: 4,
  error: 3,
  running: 2,
  done: 1,
  idle: 0
}

interface IslandState {
  sessions: SessionState[]
  /** 待审批队列（FIFO，最早的在前；UI 一次展示队首一个）。 */
  pending: ApprovalRequest[]
  hydrated: boolean
  subscribed: boolean
  hydrate: () => Promise<void>
  subscribe: () => () => void
  /** 用户岛内裁决队首请求：回传主进程并从队列移除。 */
  decide: (requestId: string, decision: ApprovalDecision) => Promise<void>
  /** 点击卡片精准跳回终端。 */
  openSession: (sessionId: string) => Promise<void>
  setSessions: (sessions: SessionState[]) => void
  pushApproval: (req: ApprovalRequest) => void
  removeApproval: (requestId: string) => void
}

/**
 * 订阅引用计数（模块级）：支持多消费者 + StrictMode 双挂载。每个 subscribe() 都返回
 * 一个「只生效一次、正确递减」的 cleanup——首个订阅者真正注册 IPC 监听器，末个退订时
 * 才解绑。取代旧的「已订阅就返回 no-op cleanup」契约（后者一旦出现第二个挂载点，监听器
 * 会注册却谁都解绑不掉）。
 */
let islandSubscriberCount = 0
let islandOffFns: Array<() => void> = []

export const useIslandStore = create<IslandState>((set, get) => ({
  sessions: [],
  pending: [],
  hydrated: false,
  subscribed: false,

  hydrate: async () => {
    if (get().hydrated) return
    const api = window.electronAPI
    if (!api?.islandList) {
      set({ hydrated: true })
      return
    }
    try {
      const [sessions, pending] = await Promise.all([
        api.islandList(),
        api.islandPending ? api.islandPending() : Promise.resolve([])
      ])
      set({
        sessions: (sessions ?? []) as SessionState[],
        pending: (pending ?? []) as ApprovalRequest[],
        hydrated: true
      })
    } catch (err) {
      console.error('[island] hydrate failed', err)
      set({ hydrated: true })
    }
  },

  subscribe: () => {
    const api = window.electronAPI
    // 引用计数 +1；仅首个订阅者真正注册 IPC 监听器
    islandSubscriberCount++
    if (islandSubscriberCount === 1) {
      islandOffFns = api?.onIslandUpdate
        ? [
            api.onIslandUpdate((sessions) => get().setSessions(sessions)),
            api.onIslandApproval?.((req) => get().pushApproval(req)) ?? (() => {}),
            api.onIslandApprovalResolved?.((id) => get().removeApproval(id)) ?? (() => {})
          ]
        : []
      set({ subscribed: true })
    }
    // 幂等 cleanup：同一个 cleanup 多次调用只递减一次，避免误减他人的计数
    let active = true
    return () => {
      if (!active) return
      active = false
      islandSubscriberCount--
      if (islandSubscriberCount === 0) {
        for (const off of islandOffFns) off()
        islandOffFns = []
        set({ subscribed: false })
      }
    }
  },

  decide: async (requestId, decision) => {
    const api = window.electronAPI
    // 乐观移除：无论主进程结果如何都从队列拿掉（resolved 推送会兜底）
    get().removeApproval(requestId)
    if (api?.islandDecision) await api.islandDecision(requestId, decision).catch(() => {})
  },

  openSession: async (sessionId) => {
    const api = window.electronAPI
    if (api?.islandOpenSession) await api.islandOpenSession(sessionId).catch(() => {})
  },

  setSessions: (sessions) => set({ sessions }),
  pushApproval: (req) =>
    set((s) =>
      s.pending.some((p) => p.requestId === req.requestId) ? s : { pending: [...s.pending, req] }
    ),
  removeApproval: (requestId) =>
    set((s) => ({ pending: s.pending.filter((p) => p.requestId !== requestId) }))
}))

/** 收起态展示用：会话总数。 */
export function selectSessionCount(s: IslandState): number {
  return s.sessions.length
}

/** 最紧急状态（无会话时返回 null）。 */
export function selectMostUrgentStatus(s: IslandState): SessionStatus | null {
  let best: SessionStatus | null = null
  for (const sess of s.sessions) {
    if (best === null || STATUS_URGENCY[sess.status] > STATUS_URGENCY[best]) best = sess.status
  }
  return best
}

/** 各状态计数（收起态小圆点用）。 */
export function selectStatusCounts(s: IslandState): Record<SessionStatus, number> {
  const counts: Record<SessionStatus, number> = {
    idle: 0,
    running: 0,
    waiting: 0,
    done: 0,
    error: 0
  }
  for (const sess of s.sessions) counts[sess.status]++
  return counts
}
