import { EventEmitter } from 'node:events'
import type { AuditFn } from '../audit-log'
import type {
  IslandHookEvent,
  IslandHookKind,
  SessionState,
  SessionStateBase,
  SessionStatus
} from '../../shared/island-types'

/** 会话数上限：超出时驱逐最旧（按 updatedAt），防止本机进程灌爆内存。 */
const MAX_SESSIONS = 200

/**
 * running 会话陈旧阈值（ms）：超过此时长没有任何活跃信号即判定「已不再活跃」，降级为 idle。
 *
 * 「活跃信号」有二：hook 事件（{@link IslandState.applyEvent}）与 **transcript 增量**
 * （{@link IslandState.markActive} / {@link IslandState.updateLastMessage} 刷新 updatedAt）。
 * 后者是主力——只要 Claude Code 还在往会话 transcript 追加（思考块完成、工具调用、工具结果、回复
 * 正文），markActive 就把会话保活并维持 running，故真正在干活的会话不会被误降。
 *
 * 本阈值是**最后兜底**，只在「连 transcript 都长时间无新增」时才触发，覆盖：
 *   - fire-and-forget 的 Stop 上报丢失（vibe-monitor 重启 / 端口忙 / 退出竞态）
 *   - 只改设置、不触发模型回合的斜杠命令（UserPromptSubmit 翻 running 后既无 Stop 也无 transcript 追加）
 *   - 单个连续超长思考块（max-effort 深度推理整块完成才落盘，期间 transcript 无新字节）
 *
 * 取 15min 而非更短：max-effort 单轮思考 / 单个长工具调用动辄数分钟，阈值过短会把正在干活的会话误判
 * 空闲（曾用 3min，长思考期被反复误降为 idle 显示「空闲」）。代价仅是「真丢了 Stop」的死会话多滞留
 * 一会儿，不误导。
 */
const RUNNING_STALE_MS = 15 * 60_000

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

/**
 * done/error 是终态：一旦进入，不可被后续事件/心跳复活。类型谓词——真值分支里
 * `s.stopReason` 可安全访问（已收窄到 done/error 分支）。
 */
export function isTerminalStatus(
  s: SessionState
): s is SessionState & { status: 'done' | 'error'; stopReason?: string } {
  return s.status === 'done' || s.status === 'error'
}

/**
 * 状态迁移的统一守卫——所有「候选下一状态」都要经这里：已处于终态的会话拒绝任何变更，
 * 返回原状态；否则放行候选值。
 *
 * `applyEvent` 主链路（此前是唯一遗漏这道守卫的入口——SessionStart/UserPromptSubmit/
 * PreToolUse/Stop 等静态映射事件可以直接把已结束会话拉回 running）与 `notificationStatus`
 * 的分类结果，都在这里统一收口，不再各自零散判断（近三次相关 fix 的共同根因）。
 */
export function resolveTransition(
  prev: SessionState | undefined,
  candidate: SessionStatus
): SessionStatus {
  if (prev && isTerminalStatus(prev)) return prev.status
  return candidate
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
 * transcript-watcher 通过 {@link markActive} 把 transcript 增量当活跃心跳（保活、把长思考期被误降的
 * idle 复活为 running、并在用户应答后解除 waiting），并通过 {@link updateLastMessage} 补「最后消息」明细。
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
    // 等纯信息通知），只有「授权请求」才是真正的等待审批。按 message 分类出候选状态（{@link
    // notificationStatus}）；其余 kind 用静态 KIND_TO_STATUS 出候选状态。候选状态是否真的生效，
    // 统一交给下面的 {@link resolveTransition} 裁决（终态守卫）。
    const candidateStatus =
      event.kind === 'Notification'
        ? this.notificationStatus(event.last_message, prev)
        : KIND_TO_STATUS[event.kind]
    if (!candidateStatus) {
      void this.audit('island.event_unknown_kind', { kind: event.kind, sessionId })
      return
    }
    const status = resolveTransition(prev, candidateStatus)
    const now = event.ts ?? this.now()
    const base: SessionStateBase = {
      sessionId,
      // 新字段优先取事件值，缺省时保留旧值（hook 各节点携带字段不全）
      projectName: event.project_name ?? prev?.projectName,
      sessionName: event.session_name ?? prev?.sessionName,
      lastMessage: event.last_message ?? prev?.lastMessage,
      model: event.model ?? prev?.model,
      terminal: event.terminal ?? prev?.terminal,
      updatedAt: now,
      // 首次出现的时间戳，跨事件保留——「已持续时长」从这里算起，不随每次事件刷新
      startedAt: prev?.startedAt ?? now
    }
    const next: SessionState =
      status === 'done' || status === 'error'
        ? {
            ...base,
            status,
            // 本轮若真是 Stop 事件，用它携带的 stop_reason（哪怕是 undefined，也不再回退
            // 沿用上一轮的过期值——修复 stopReason 跨轮次残留）；非 Stop 事件（迟到事件被
            // resolveTransition 钉在终态）不携带理由信息，保留 prev 原值，不清空。
            stopReason:
              event.kind === 'Stop'
                ? event.stop_reason
                : prev && isTerminalStatus(prev)
                  ? prev.stopReason
                  : undefined
          }
        : { ...base, status }
    this.sessions.set(sessionId, next)
    this.evictIfNeeded()
    this.emitChange()
  }

  /**
   * 把一条 Notification 分类为候选状态——从根上消除「会话并未等待审批却显示等待审批」的误报。
   *
   * - `permission` → `waiting`：真正等待用户授权（典型为岛不可用/超时回退到终端原生询问、由终端
   *   弹出授权时）。这才是名副其实的「等待审批」。
   * - `idle` → `idle`：仅是空闲等待输入，停在输入框，**不是审批**——不再误标 waiting。
   * - `other`（worktree/登录/MCP 等信息通知，含无法识别）：**保留原状态**，绝不凭空标 waiting；
   *   首次出现且无前态时落 `idle`（信息通知意味着会话已停在输入框边上）。
   *
   * 注：候选状态是否真的生效（如已 done/error 的会话任何 Notification 都不改状态，仅
   * lastMessage/updatedAt 照常更新）由调用方经 {@link resolveTransition} 统一裁决，这里
   * 不再重复判断。`waiting` 自此只由「授权请求」产生，故灵动岛收起态「等待审批」标签语义
   * 恒为准确，无需改渲染层。
   */
  private notificationStatus(message: string | undefined, prev?: SessionState): SessionStatus {
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

  /**
   * transcript 活跃心跳：会话的 transcript 有任何新增（思考块、工具调用/结果、回复正文等）即视为
   * 「模型正在为该会话产出」——刷新 updatedAt 保活，把 idle 复活为 running，并在用户应答后解除 waiting。
   *
   * 解决两类「有任务在跑却报错状态」：
   *   1. **长思考期显示空闲**：Claude Code 在模型思考期不发任何 hook，但会持续往 transcript 追加行
   *      （多为思考/工具行，无可显示文本，故 {@link updateLastMessage} 不触发）。读到任何新增即把被
   *      {@link sweepStale} 误降的 idle 即时复活为 running（不必苦等下一个 PreToolUse，消除「响应不及时」）。
   *   2. **用户已回答却仍显示等待审批**：AskUserQuestion / 授权请求经 Notification 置 waiting；用户回答
   *      是一条 `tool_result`（user 行）而**不触发任何 hook**，下一个 PreToolUse 可能在数分钟的 max-effort
   *      思考之后才来。故据 `userActivity` 判定：有用户侧产出新行即解除 waiting → running。
   *
   * @param userActivity 本次 transcript 增量是否含「用户侧产出」的行（tool_result / 回答 / 新 prompt，
   *   由 transcript-watcher 的 chunkHasUserActivity 判定）。
   *
   * - **done / error**：直接返回不动（与 {@link notificationStatus} 同护栏）。Stop 后迟到的本轮 transcript
   *   写入（如收尾正文行经 fs.watch 略晚于 Stop hook 到达）不得把已结束会话复活为 running。
   * - **waiting + 仅模型侧产出（userActivity=false）**：保留 waiting 且**不刷新 updatedAt**。既防入场竞态
   *   （触发等待的 tool_use 行被 watcher 读到时把刚置的 waiting 误清），又把「长时间无人应答」留给
   *   {@link sweepStale} 兜底降级。真·等待期间模型本就不产出，此分支几乎只在入场竞态命中。
   * - **waiting + 用户侧产出（userActivity=true）**：→ running（用户已回答/授权，模型恢复），刷新 updatedAt。
   * - **idle / running**：→ running（idle 即时复活、running 续命），刷新 updatedAt。
   *
   * 仅作用于已存在会话（不凭空创建——生命周期由 hook 主导，同 {@link updateLastMessage}）。
   * running 同时刻重复调用幂等（不重复 emit）。
   */
  markActive(sessionId: string, userActivity = false): void {
    const id = sessionId.trim()
    if (!id) return
    const prev = this.sessions.get(id)
    if (!prev) return
    if (isTerminalStatus(prev)) return
    if (prev.status === 'waiting' && !userActivity) return
    const now = this.now()
    if (prev.status === 'running' && prev.updatedAt === now) return
    this.sessions.set(id, { ...prev, status: 'running', updatedAt: now })
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
