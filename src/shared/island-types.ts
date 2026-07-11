/**
 * 灵动岛（Notch Island）跨进程共享类型。
 *
 * 主进程（island-server / island-state / island-ipc）与渲染进程（island-store /
 * Island.tsx）共用这些定义；hook 上报脚本（tools/island-hook.mjs）发送的 body
 * 也遵循 {@link IslandHookEvent} 结构。
 *
 * 设计原则：数据源为**本机 Claude Code hooks**（经 127.0.0.1 环回 HTTP 上报），
 * 不经远程后端，与任何远程推送协议刻意分离，避免本地源被远程协议字段污染。
 */

/**
 * 会话状态机的五个状态。
 * - `idle`：会话已开但未在执行（刚启动/resume、running 陈旧降级后，或空闲等待输入）——停在输入框等用户
 * - `running`：正在执行（有 prompt / 工具动作）
 * - `waiting`：等待用户**授权**（真·等待审批；如 PreToolUse 回退到终端原生询问的场景）
 * - `done`：本轮结束
 * - `error`：出错
 */
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error'

/**
 * Claude Code hook 事件类型（对齐 Claude Code 原生 hook 名）。
 * - `SessionStart`：会话启动 → idle（停在输入框，非执行态，不再误报 running）
 * - `UserPromptSubmit` / `PreToolUse`：有动作 → running
 * - `Notification`：按 message 语义分类（授权请求 → waiting，空闲等输入 → idle，其余信息通知保留原态）
 * - `Stop`：本轮结束 → done
 * - `SessionEnd`：会话结束（Ctrl+C/Ctrl+D 退出、/clear、logout 等）→ 立即从岛上移除（退出即清）
 */
export type IslandHookKind =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'Notification'
  | 'Stop'
  | 'SessionEnd'

/**
 * hook 上报到 `POST /event` 的请求体。
 * 字段名沿用 Claude Code hook 输入（snake_case），由 island-server 校验后交 state。
 */
export interface IslandHookEvent {
  kind: IslandHookKind
  /** Claude Code 会话 id（稳定标识，跳回终端 / 折叠的 key） */
  session_id: string
  /** 项目名（通常取 cwd 的 basename） */
  project_name?: string
  /** 会话标题（终端 tab 匹配用） */
  session_name?: string
  /** 最近一条消息摘要（可选；transcript-watcher 也会补） */
  last_message?: string
  /** Stop 事件的停止原因 */
  stop_reason?: string
  /** 驱动该会话的模型/Agent（当前恒为 'Claude'，未来支持其它模型时由源上报） */
  model?: string
  /** 会话所在终端（如 'Ghostty'、'Ghostty·tmux'），由 hook 读 TERM_PROGRAM/TMUX 派生 */
  terminal?: string
  /** 事件发生时间（毫秒）；缺省由 server 用接收时刻填充 */
  ts?: number
}

/** SessionState 各状态共有的字段（与 status/stopReason 无关）。 */
export interface SessionStateBase {
  sessionId: string
  projectName?: string
  sessionName?: string
  /** 最近一条消息摘要（hook last_message 或 transcript-watcher 补） */
  lastMessage?: string
  /** 最近一次状态更新时间（毫秒），用于排序与相对时间展示 */
  updatedAt: number
  /** 会话首次出现的时间（毫秒），用于展示「已持续时长」；跨事件保留不刷新 */
  startedAt?: number
  /** 驱动该会话的模型/Agent（当前恒为 'Claude'），卡片标签展示 */
  model?: string
  /** 会话所在终端（如 'Ghostty'、'Ghostty·tmux'），卡片标签展示 */
  terminal?: string
}

/**
 * 灵动岛展示的单会话状态（state.list() 的元素，经 IPC 下发渲染端）。
 *
 * 判别式联合：`stopReason` 只在 done/error 分支存在——从类型层面防止「状态已变但旧字段
 * 残留」这类问题（如 stopReason 跨轮次残留）。idle/running/waiting 三态不携带停止原因，
 * 分到同一分支（互相之间没有字段差异，拆成三个分支只会重复代码，无实际类型收益）。
 */
export type SessionState =
  | (SessionStateBase & { status: 'idle' | 'running' | 'waiting' })
  | (SessionStateBase & { status: 'done' | 'error'; stopReason?: string })

/** 岛内审批的三档裁决，对齐 Image#6 三按钮。 */
export type ApprovalDecision = 'deny' | 'allow_once' | 'bypass'

/**
 * 审批超时回退：hook 输出 `permissionDecision=ask` 交回 Claude Code 终端原生询问。
 * registry 在 60s 未裁决时 resolve 此值。
 */
export type ApprovalOutcome = ApprovalDecision | 'ask'

/**
 * 一次待审批请求（PreToolUse 触发），经 IPC 推送灵动岛展开审批面板。
 * `toolInput` 为预览原文，server 入口已做长度截断防大体积。
 */
export interface ApprovalRequest {
  /** registry 生成的唯一请求 id（裁决回传时用） */
  requestId: string
  sessionId: string
  projectName?: string
  sessionName?: string
  /** 工具名（Edit / Bash / Write ...） */
  toolName: string
  /** 工具入参预览（已截断）：Edit 含 file_path + diff 文本，Bash 含命令 */
  toolInput: string
  /** 注册时间（毫秒），渲染端据此算倒计时 */
  requestedAt: number
  /** 超时上限（毫秒），默认 60000 */
  timeoutMs: number
}
