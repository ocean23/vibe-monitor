import { EventEmitter } from 'node:events'
import type { AuditFn } from '../audit-log'
import type {
  IslandHookEvent,
  IslandHookKind,
  SessionState,
  SessionStatus
} from '../../shared/island-types'

/** 会话数上限：超出时驱逐最旧（按 updatedAt），防止本机进程灌爆内存。 */
const MAX_SESSIONS = 200

/**
 * running 会话陈旧阈值（ms）：超过此时长没有任何新事件即判定「已不再活跃」，降级为 idle。
 *
 * 兜底以下「Stop 永远不来」的卡死场景（会话其实停在输入框，却一直显示运行中）：
 *   - fire-and-forget 的 Stop 上报丢失（vibe-monitor 重启 / 端口忙 / 退出竞态）
 *   - 只改设置、不触发模型回合的斜杠命令（UserPromptSubmit 翻 running 后没有 Stop）
 *
 * transcript-watcher 的 {@link IslandState.updateLastMessage} 会刷新 updatedAt，故真正在
 * 产出（有 transcript 追加）的会话不会被误降；仅「长时间静默且无 Stop」才会触发。
 */
const RUNNING_STALE_MS = 3 * 60_000

/**
 * 会话过期阈值（ms）：非 running 会话超过此时长没有任何新事件 → 整条移除。
 *
 * 这是兜底回收：正常退出（Ctrl+C/Ctrl+D、/clear、logout）已由 `SessionEnd` hook 即时移除
 * （见 {@link applyEvent}）。但 `SessionEnd` 在强杀终端窗口（SIGHUP/SIGKILL）等场景不保证触发，
 * 此阈值把这类「连 SessionEnd 都没来」的被遗弃会话当垃圾回收掉，岛只留「当前活跃」。
 *
 * 排除 running：真正在执行的会话不会因静默而消失（且 running 静默 {@link RUNNING_STALE_MS}
 * 后已先降级为 idle，再走过期）。被移除后若该会话又来事件，applyEvent 会重新创建。
 */
const SESSION_EXPIRE_MS = 10 * 60_000

/** 默认扫描周期（ms）。需远小于 {@link RUNNING_STALE_MS} 才能及时降级/过期。 */
const STALE_SWEEP_INTERVAL_MS = 30_000

/**
 * hook kind → 会话状态映射（FR-002）。
 *
 * 不含 `SessionEnd`（直接把会话从岛上移除）与 `Notification`（语义繁多，需按 message 分类——
 * 见 {@link classifyNotification} / {@link IslandState.notificationStatus}）：这两类在
 * {@link IslandState.applyEvent} 里被提前拦截单独处理。故用 Partial——查不到映射的其它 kind
 * 走 applyEvent 里的 unknown_kind 兜底。
 */
const KIND_TO_STATUS: Partial<Record<IslandHookKind, SessionStatus>> = {
  // SessionStart：会话刚开/resume，停在输入框等用户——是 idle 而非 running（修复误报运行中）。
  SessionStart: 'idle',
  UserPromptSubmit: 'running',
  PreToolUse: 'running',
  Stop: 'done'
}

/** {@link classifyNotification} 的三类语义。 */
export type NotificationKind = 'permission' | 'idle' | 'other'

/**
 * 按 message 文本判定 Notification 的语义。
 *
 * Claude Code 的 `Notification` hook **并非只在「等待审批」时触发**，常见至少三类：
 *   - 工具授权请求：`"Claude needs permission to use Bash"` / `"Claude needs your permission to use X"`
 *   - 空闲等待输入：`"Claude is waiting for your input"`（输入框静默 ~60s，每轮回复后也会发）
 *   - 纯信息通知：`"Created worktree at …"` / `"Exited worktree…"` / 登录成功 / MCP elicitation 等
 *
 * 历史实现把**所有** Notification 一律映射成 `waiting`（→ 灵动岛显示「等待审批」），导致「会话
 * 并未在等待审批却显示等待审批」的误报。这里据 message 文本分类，调用方只把 `permission` 判为
 * waiting。**不依赖 payload.notification_type**——该字段文档有载但真实 stdin 常缺失，文本更可靠。
 *
 * 匹配策略（大小写不敏感，锚定句首稳定子串）：
 *   - `permission`：核心子串 `permission to use`，同时覆盖 "needs permission" 与 "needs your
 *     permission" 两种措辞，以及中英混排（如 `"等待操作确认\nClaude needs your permission to use X"`，
 *     内嵌英文核心仍可命中）。
 *   - `idle`：`waiting for your input`。
 *   - `other`：其余（含空 message / 无法识别）。
 *
 * 安全方向：识别不到一律落 `other`，宁可「少报等待审批」也绝不误报（符合容错铁律「绝不误导」）。
 */
export function classifyNotification(message: string | undefined): NotificationKind {
  if (!message) return 'other'
  if (/permission to use|needs (?:your )?permission/i.test(message)) return 'permission'
  if (/waiting for your input/i.test(message)) return 'idle'
  return 'other'
}

export interface IslandStateOptions {
  audit: AuditFn
  /** 注入时钟，便于单测断言 updatedAt */
  now?: () => number
  /** running 陈旧降级阈值（ms），默认 {@link RUNNING_STALE_MS}；测试可注入小值 */
  staleMs?: number
  /** 非 running 会话过期移除阈值（ms），默认 {@link SESSION_EXPIRE_MS}；测试可注入小值 */
  expireMs?: number
}

/**
 * 灵动岛会话状态机（主进程，纯内存）。
 *
 * 持有 `Map<sessionId, SessionState>`，按 hook 事件流转状态：
 * `SessionStart → idle`、`UserPromptSubmit/PreToolUse → running`、`Stop → done`，
 * `Notification` 按 message 语义分类（仅授权请求 → waiting，空闲等输入 → idle，其余信息通知保留原态，
 * 见 {@link notificationStatus}），而 `SessionEnd → 立即移除`（退出即清，不走过期阈值）。另有 {@link sweepStale}
 * 定时维护：把长时间无事件的 running 兜底降级为 idle（防止 Stop 丢失 / 斜杠命令导致永久卡在运行中），
 * 并把更久没动的非 running 会话整条移除（GC 掉连 SessionEnd 都没来的遗弃会话）。
 * transcript-watcher 通过 {@link updateLastMessage} 补「最后消息」明细。
 *
 * 每次变更 emit `change`（载荷为最新 `list()`），index.ts 订阅后 IPC 推送灵动岛窗口。
 * 不做持久化——灵动岛展示的是「当前活跃会话」，历史回溯仍走 claude-notify-store。
 */
export class IslandState extends EventEmitter {
  private readonly sessions = new Map<string, SessionState>()
  private readonly audit: AuditFn
  private readonly now: () => number
  private readonly staleMs: number
  private readonly expireMs: number
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: IslandStateOptions) {
    super()
    // 生产侧只挂少量监听器；上调上限给未来扩展留余量，避免误报 MaxListenersExceededWarning
    this.setMaxListeners(20)
    this.audit = options.audit
    this.now = options.now ?? Date.now
    this.staleMs = options.staleMs ?? RUNNING_STALE_MS
    this.expireMs = options.expireMs ?? SESSION_EXPIRE_MS
  }

  /**
   * 应用一条 hook 事件，更新对应会话状态并 emit change。
   * 缺 session_id 的事件被丢弃（审计后忽略），避免污染状态表。
   */
  applyEvent(event: IslandHookEvent): void {
    const sessionId = (event.session_id ?? '').trim()
    if (!sessionId) {
      void this.audit('island.event_missing_session', { kind: event.kind })
      return
    }
    // SessionEnd：会话结束（Ctrl+C/Ctrl+D 退出、/clear、logout 等）→ 立即移除卡片，不再等
    // sweepStale 的过期阈值，做到「退出即清」。reason 不影响处理：任何 SessionEnd 都意味着该
    // session_id 已结束；若之后又来事件（如 resume 复用同 id），下方逻辑会重新创建（与过期后重现一致）。
    if (event.kind === 'SessionEnd') {
      this.remove(sessionId)
      return
    }
    const prev = this.sessions.get(sessionId)
    // Notification 不走静态映射：其触发原因繁多（工具授权请求 / 空闲等输入 / worktree·登录·MCP
    // 等纯信息通知），只有「授权请求」才是真正的等待审批。按 message 分类裁决（{@link
    // notificationStatus}，内含 done/error 护栏）；其余 kind 用静态 KIND_TO_STATUS。
    const status =
      event.kind === 'Notification'
        ? this.notificationStatus(event.last_message, prev)
        : KIND_TO_STATUS[event.kind]
    if (!status) {
      void this.audit('island.event_unknown_kind', { kind: event.kind, sessionId })
      return
    }
    const now = event.ts ?? this.now()
    const next: SessionState = {
      sessionId,
      // 新字段优先取事件值，缺省时保留旧值（hook 各节点携带字段不全）
      projectName: event.project_name ?? prev?.projectName,
      sessionName: event.session_name ?? prev?.sessionName,
      status,
      lastMessage: event.last_message ?? prev?.lastMessage,
      model: event.model ?? prev?.model,
      terminal: event.terminal ?? prev?.terminal,
      updatedAt: now,
      // 首次出现的时间戳，跨事件保留——「已持续时长」从这里算起，不随每次事件刷新
      startedAt: prev?.startedAt ?? now,
      stopReason: event.kind === 'Stop' ? (event.stop_reason ?? prev?.stopReason) : prev?.stopReason
    }
    this.sessions.set(sessionId, next)
    this.evictIfNeeded()
    this.emitChange()
  }

  /**
   * 把一条 Notification 裁决为会话状态——从根上消除「会话并未等待审批却显示等待审批」的误报。
   *
   * - **已 done/error 的会话**：任何 Notification 都不改状态。任务完成桌面通知 / worktree 信息
   *   等常在 `Stop` 之后到达，不能把已结束会话拉回 waiting/idle（lastMessage/updatedAt 仍照常更新）。
   * - `permission` → `waiting`：真正等待用户授权（典型为岛不可用/超时回退到终端原生询问、由终端
   *   弹出授权时）。这才是名副其实的「等待审批」。
   * - `idle` → `idle`：仅是空闲等待输入，停在输入框，**不是审批**——不再误标 waiting。
   * - `other`（worktree/登录/MCP 等信息通知，含无法识别）：**保留原状态**，绝不凭空标 waiting；
   *   首次出现且无前态时落 `idle`（信息通知意味着会话已停在输入框边上）。
   *
   * 注：`waiting` 自此只由「授权请求」产生，故灵动岛收起态「等待审批」标签语义恒为准确，无需改渲染层。
   */
  private notificationStatus(message: string | undefined, prev?: SessionState): SessionStatus {
    if (prev?.status === 'done' || prev?.status === 'error') return prev.status
    switch (classifyNotification(message)) {
      case 'permission':
        return 'waiting'
      case 'idle':
        return 'idle'
      default:
        return prev?.status ?? 'idle'
    }
  }

  /** 超过 MAX_SESSIONS 时驱逐最旧会话（按 updatedAt 升序），保留最近活跃的。 */
  private evictIfNeeded(): void {
    if (this.sessions.size <= MAX_SESSIONS) return
    const sorted = [...this.sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt)
    const dropCount = this.sessions.size - MAX_SESSIONS
    for (let i = 0; i < dropCount; i++) {
      this.sessions.delete(sorted[i].sessionId)
    }
  }

  /**
   * transcript-watcher 增量解析到的「最后一条消息」补丁。
   * 仅更新已存在会话的 lastMessage（不凭空创建会话——会话生命周期由 hook 事件主导）。
   */
  updateLastMessage(sessionId: string, lastMessage: string): void {
    const id = sessionId.trim()
    if (!id) return
    const prev = this.sessions.get(id)
    if (!prev) return
    if (prev.lastMessage === lastMessage) return
    this.sessions.set(id, { ...prev, lastMessage, updatedAt: this.now() })
    this.emitChange()
  }

  /** 移除一个会话（如终端关闭后清理），emit change。 */
  remove(sessionId: string): void {
    if (this.sessions.delete(sessionId.trim())) {
      this.emitChange()
    }
  }

  /**
   * 一趟扫描做两件事（仅当有改动才 emit 一次 change）：
   *
   * 1. **过期移除**：非 running 会话距上次事件超过 {@link expireMs} → 整条删除。正常退出已由
   *    `SessionEnd` 即时移除；这里兜底「连 SessionEnd 都没来」的会话（强杀终端 SIGHUP/SIGKILL 等），否则会永久滞留。
   * 2. **陈旧降级**：running 会话距上次事件超过 {@link staleMs} → 降级为 idle（兜底 dropped
   *    Stop / 不触发模型回合的斜杠命令导致永久卡在运行中）。
   *
   * running 不参与过期移除：执行中的会话不因静默而消失；它静默够久会先在此被降级为 idle，
   * 下一趟再按 idle 走过期。**降级不刷新 updatedAt**：保留原时间戳让相对时间反映「上次真正
   * 活跃」，也保证再次扫描不反复触发（status 已非 running）。
   */
  sweepStale(): void {
    const now = this.now()
    const staleCutoff = now - this.staleMs
    const expireCutoff = now - this.expireMs
    let changed = false
    for (const [id, s] of this.sessions) {
      // running 和 waiting 都视为「活跃」：长时间无事件则降级为 idle（兜底 Stop 丢失
      // 或 Notification 发出后会话实际已结束但 Stop 未到达等场景）。
      const isActive = s.status === 'running' || s.status === 'waiting'
      if (!isActive) {
        // 删除当前迭代项在 Map 的 for...of 中是安全的（不会跳过后续项）
        if (s.updatedAt <= expireCutoff) {
          this.sessions.delete(id)
          changed = true
        }
        continue
      }
      if (s.updatedAt <= staleCutoff) {
        this.sessions.set(id, { ...s, status: 'idle' })
        changed = true
      }
    }
    if (changed) this.emitChange()
  }

  /**
   * 启动周期性陈旧扫描（生产侧由 index.ts 调用一次）。定时器 unref，不阻止进程退出；
   * 重复调用幂等。测试不需调用——直接调 {@link sweepStale} 配合注入时钟断言即可。
   */
  startStaleSweep(intervalMs: number = STALE_SWEEP_INTERVAL_MS): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweepStale(), intervalMs)
    this.sweepTimer.unref?.()
  }

  /** 停止陈旧扫描（应用退出清理）。 */
  stopStaleSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  /** 当前所有会话，按 updatedAt 倒序（最近活跃在前）。 */
  list(): SessionState[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 会话总数（收起态展示 `N sessions`）。 */
  count(): number {
    return this.sessions.size
  }

  private emitChange(): void {
    this.emit('change', this.list())
  }
}
