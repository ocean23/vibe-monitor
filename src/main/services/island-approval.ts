import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import type { AuditFn } from '../audit-log'
import type { ApprovalDecision, ApprovalOutcome, ApprovalRequest } from '../../shared/island-types'

/** 默认审批超时（FR-008）：60s 未裁决 → 回退终端原生询问（ask）。 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000

/** PreToolUse 上报的待审批输入（server 解析 HTTP body 后传入）。 */
export interface RegisterApprovalInput {
  sessionId: string
  projectName?: string
  sessionName?: string
  toolName: string
  /** 工具入参预览（server 已截断防大体积） */
  toolInput: string
}

interface PendingEntry {
  request: ApprovalRequest
  resolve: (outcome: ApprovalOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ApprovalRegistryOptions {
  audit: AuditFn
  now?: () => number
  /** 注入 setTimeout / clearTimeout，便于单测用 fake timer */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
  /** requestId 生成器注入点 */
  genId?: () => string
}

/**
 * 岛内审批的 pending 注册表（PreToolUse long-poll 回环的核心）。
 *
 * `register()` 为一次 PreToolUse 请求生成 requestId、登记一个 60s 超时的 Promise，
 * 并 emit `request`（供 IPC 推送灵动岛展开审批面板）。用户在岛内裁决时由 IPC 调
 * `resolve(requestId, decision)`，Promise 兑现，island-server 把结果写回 HTTP 响应，
 * hook 据此输出 `permissionDecision`。超时则 resolve `'ask'`，把决定权交回终端——
 * 灵动岛只是「加速器」，绝不让 Claude 会话永久卡死。
 */
export class ApprovalRegistry extends EventEmitter {
  private readonly pendingMap = new Map<string, PendingEntry>()
  private readonly audit: AuditFn
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  private readonly genId: () => string

  constructor(options: ApprovalRegistryOptions) {
    super()
    // 生产侧只挂少量监听器；上调上限给未来扩展留余量，避免误报 MaxListenersExceededWarning
    this.setMaxListeners(20)
    this.audit = options.audit
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h))
    this.genId = options.genId ?? (() => crypto.randomUUID())
  }

  /**
   * 登记一次待审批请求，返回 resolve 后的裁决（或超时 'ask'）。
   * emit `request`（ApprovalRequest）通知 IPC 层推送灵动岛。
   *
   * `onRegistered` 在生成 requestId 后**同步**回调，让调用方（island-server）拿到
   * id 以便在客户端连接中断时调 {@link cancel} 提前清理（避免 pending 悬挂到 60s）。
   */
  register(
    input: RegisterApprovalInput,
    timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS,
    onRegistered?: (requestId: string) => void
  ): Promise<ApprovalOutcome> {
    const requestId = this.genId()
    const request: ApprovalRequest = {
      requestId,
      sessionId: input.sessionId,
      projectName: input.projectName,
      sessionName: input.sessionName,
      toolName: input.toolName,
      toolInput: input.toolInput,
      requestedAt: this.now(),
      timeoutMs
    }

    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = this.setTimer(() => {
        // 超时：清理并回退终端
        this.pendingMap.delete(requestId)
        void this.audit('island.approval_timeout', { requestId, toolName: input.toolName })
        this.emit('resolved', { requestId, outcome: 'ask' as ApprovalOutcome })
        resolve('ask')
      }, timeoutMs)

      // requestId 碰撞防御：randomUUID 碰撞可忽略，但注入的 genId（测试/未来自定义）
      // 可能重复——若已存在，先清掉旧 entry 的 timer 并把旧 Promise 按 'ask' 结掉，
      // 避免旧 timer 泄漏 + 旧 Promise 永不 settle。
      const existing = this.pendingMap.get(requestId)
      if (existing) {
        this.clearTimer(existing.timer)
        existing.resolve('ask')
        void this.audit('island.approval_id_collision', { requestId })
      }
      this.pendingMap.set(requestId, { request, resolve, timer })
      onRegistered?.(requestId)
      this.emit('request', request)
    })
  }

  /**
   * 取消一个未决请求（如 hook 客户端连接中断）：按 'ask' resolve 并清理，
   * 不必等满 60s 超时。未知 id 静默忽略（幂等）。
   */
  cancel(requestId: string): void {
    const entry = this.pendingMap.get(requestId)
    if (!entry) return
    this.clearTimer(entry.timer)
    this.pendingMap.delete(requestId)
    this.emit('resolved', { requestId, outcome: 'ask' as ApprovalOutcome })
    entry.resolve('ask')
  }

  /**
   * 用户在岛内裁决：兑现对应 Promise。未知 / 已超时的 requestId 静默忽略（幂等）。
   */
  resolve(requestId: string, decision: ApprovalDecision): void {
    const entry = this.pendingMap.get(requestId)
    if (!entry) return
    this.clearTimer(entry.timer)
    this.pendingMap.delete(requestId)
    this.emit('resolved', { requestId, outcome: decision })
    entry.resolve(decision)
  }

  /** 当前所有待审批请求（IPC `island:pending` 用，覆盖灵动岛挂载晚于推送的竞态）。 */
  pending(): ApprovalRequest[] {
    return [...this.pendingMap.values()].map((e) => e.request)
  }

  /** 进程退出清理：所有未决请求按 'ask' resolve，避免 hook 永久阻塞。 */
  drain(): void {
    for (const [requestId, entry] of this.pendingMap) {
      this.clearTimer(entry.timer)
      entry.resolve('ask')
      this.emit('resolved', { requestId, outcome: 'ask' as ApprovalOutcome })
    }
    this.pendingMap.clear()
  }
}
