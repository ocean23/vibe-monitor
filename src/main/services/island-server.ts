import http from 'node:http'
import type { AuditFn } from '../audit-log'
import type { IslandConfig } from './island-config'
import { timingSafeTokenEqual } from './island-config'
import type { IslandState } from './island-state'
import type { ApprovalRegistry, RegisterApprovalInput } from './island-approval'
import type { IslandHookEvent, IslandHookKind, ApprovalOutcome } from '../../shared/island-types'

/** 请求体大小上限：hook payload 很小，1MB 足够且防滥用。 */
const MAX_BODY_BYTES = 1_000_000

/** 审批预览（tool_input）截断上限，防大体积 diff 撑爆 IPC / 渲染。 */
const MAX_TOOL_INPUT_CHARS = 8_000

/** /event 入库字符串字段（project/session/last_message/stop_reason）长度上限。 */
const MAX_FIELD_CHARS = 500

/**
 * 限流窗口（ms）与每窗口最大请求数：token 只挡住了「没有 token 的进程」，同机同用户下
 * 拿到 token（读 island.json）的其它进程仍可批量灌 /event、/approval——加一道频率上限
 * 兜底，超限直接 429，防止刷会话把真实活跃会话挤出内存 / UI。真实 hook 流量远低于此
 * （单会话每次工具调用一条事件），30/s 对正常使用绰绰有余。
 */
const RATE_LIMIT_WINDOW_MS = 1000
const MAX_REQUESTS_PER_WINDOW = 30

/**
 * /approval 未决队列上限：ApprovalRegistry 本身不设上限，灌入大量不裁决的假审批请求会
 * 让灵动岛堆满伪造的审批卡片（UI 欺骗）且每条占用到 60s 超时前的内存。超限直接 429，
 * 不进入 registry（不 emit request，不推送 UI）。
 */
const MAX_PENDING_APPROVALS = 20

/** 截断入库字符串字段，缺失返回 undefined（不存入 "undefined" 字面量）。 */
function clipField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const s = String(value)
  if (!s) return undefined
  return s.length > MAX_FIELD_CHARS ? s.slice(0, MAX_FIELD_CHARS) : s
}

const VALID_KINDS: ReadonlySet<string> = new Set<IslandHookKind>([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'Notification',
  'Stop',
  'SessionEnd'
])

export interface IslandServerDeps {
  config: IslandConfig
  state: IslandState
  registry: ApprovalRegistry
  audit: AuditFn
}

export interface IslandServer {
  /** 实际监听端口（便于测试用 0 随机端口后回读） */
  readonly port: number
  close: () => Promise<void>
}

/** 读取并限长 request body。 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

/** 从 `Authorization: Bearer <token>` 提取 token。 */
function extractBearer(header: string | undefined): string {
  if (!header) return ''
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m ? m[1].trim() : ''
}

/** 把任意工具入参规整为预览字符串并截断。 */
function previewToolInput(toolInput: unknown): string {
  let text: string
  if (typeof toolInput === 'string') {
    text = toolInput
  } else {
    try {
      text = JSON.stringify(toolInput, null, 2) ?? ''
    } catch {
      text = String(toolInput)
    }
  }
  if (text.length > MAX_TOOL_INPUT_CHARS) {
    return text.slice(0, MAX_TOOL_INPUT_CHARS) + '\n…(truncated)'
  }
  return text
}

/**
 * 灵动岛本地环回 HTTP server（FR-001）。
 *
 * 仅监听 `127.0.0.1`，叠加随机 token 鉴权（同机其他进程也无法伪造事件）。两个端点：
 * - `POST /event`：hook 状态上报 → `state.applyEvent`
 * - `POST /approval`：PreToolUse 审批请求 → `registry.register` 阻塞等裁决 →
 *   把结果写回响应（hook 据此输出 permissionDecision），超时 registry 返回 'ask'
 *
 * 所有路径不向调用方抛异常；解析/鉴权失败均以 HTTP 状态码 + audit 收敛。
 */
export function createIslandServer(deps: IslandServerDeps): Promise<IslandServer> {
  const { config, state, registry, audit } = deps

  // 自管活跃 socket 集合：hook 用 HTTP/1.1 keep-alive，响应发出后连接仍空闲挂着，
  // `server.close()` 会一直等到对端断开才回调。退出时需主动 destroy 这些 socket 让
  // 关闭有界（review P2-6；实测仅 server.closeAllConnections() 不足以即时切断 keep-alive）。
  const sockets = new Set<import('node:net').Socket>()

  // 固定窗口限流状态：每 RATE_LIMIT_WINDOW_MS 重置一次计数。
  let rateWindowStart = Date.now()
  let rateWindowCount = 0
  function withinRateLimit(): boolean {
    const now = Date.now()
    if (now - rateWindowStart >= RATE_LIMIT_WINDOW_MS) {
      rateWindowStart = now
      rateWindowCount = 0
    }
    rateWindowCount++
    return rateWindowCount <= MAX_REQUESTS_PER_WINDOW
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(async (err) => {
      await audit('island.server_handler_error', { error: (err as Error).message })
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' })
    })
  })

  // 显式钉死超时语义：requestTimeout=0 让 registry 的 60s 成为 /approval long-poll 的唯一
  // 时限（否则 Node 默认 requestTimeout 可能在长 poll 中途掐断阻塞请求）；headersTimeout
  // 仅约束「迟迟发不完请求头」的滥用。仅环回 + token 鉴权，慢 body 风险可接受。
  server.requestTimeout = 0
  server.headersTimeout = 10_000

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 鉴权：缺失 / 不匹配 → 401，不进入状态
    const token = extractBearer(req.headers['authorization'])
    if (!token || !timingSafeTokenEqual(token, config.token)) {
      await audit('island.auth_rejected', { url: req.url ?? '', hasToken: token.length > 0 })
      sendJson(res, 401, { ok: false, error: 'unauthorized' })
      return
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    // 限流：token 只挡住没有凭证的进程，同机拿到 token 的进程仍可能刷量——超过窗口上限
    // 一律拒绝，不区分端点（/event、/approval 共用同一个全局计数）。
    if (!withinRateLimit()) {
      await audit('island.rate_limited', { url: req.url ?? '' })
      sendJson(res, 429, { ok: false, error: 'rate limited' })
      return
    }

    const url = (req.url ?? '').split('?')[0]
    if (url === '/event') {
      await handleEvent(req, res)
      return
    }
    if (url === '/approval') {
      await handleApproval(req, res)
      return
    }
    sendJson(res, 404, { ok: false, error: 'not found' })
  }

  async function handleEvent(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid json' })
      return
    }
    const body = parsed as Record<string, unknown>
    const kind = String(body?.kind ?? '')
    const sessionId = String(body?.session_id ?? '')
    if (!VALID_KINDS.has(kind) || !sessionId) {
      await audit('island.event_invalid', { kind, hasSession: sessionId.length > 0 })
      sendJson(res, 400, { ok: false, error: 'invalid event' })
      return
    }
    const event: IslandHookEvent = {
      kind: kind as IslandHookKind,
      session_id: sessionId,
      project_name: clipField(body.project_name),
      session_name: clipField(body.session_name),
      last_message: clipField(body.last_message),
      model: clipField(body.model),
      terminal: clipField(body.terminal),
      stop_reason: clipField(body.stop_reason),
      ts: typeof body.ts === 'number' ? body.ts : undefined
    }
    state.applyEvent(event)
    sendJson(res, 200, { ok: true })
  }

  async function handleApproval(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid json' })
      return
    }
    const body = parsed as Record<string, unknown>
    const sessionId = String(body?.session_id ?? '')
    const toolName = String(body?.tool_name ?? '')
    if (!sessionId || !toolName) {
      sendJson(res, 400, { ok: false, error: 'invalid approval request' })
      return
    }
    // 未决审批队列上限：灌入大量不裁决的假请求会把灵动岛堆满伪造审批卡片，且每条占用到
    // 60s 超时前的内存——超限直接拒绝，不进 registry（不 emit request，不推送 UI）。
    if (registry.pending().length >= MAX_PENDING_APPROVALS) {
      await audit('island.approval_queue_full', { sessionId, toolName })
      sendJson(res, 429, { ok: false, error: 'approval queue full' })
      return
    }
    const input: RegisterApprovalInput = {
      sessionId,
      projectName: clipField(body.project_name),
      sessionName: clipField(body.session_name),
      toolName,
      toolInput: previewToolInput(body.tool_input)
    }
    // 客户端连接中断（hook 被杀 / Claude 退出）时，提前 cancel 对应 pending，
    // 避免 Promise 悬挂到 60s 超时、UI 卡片空挂（阻塞 #1）。
    let pendingId: string | null = null
    let settled = false
    const onAbort = (): void => {
      if (!settled && pendingId) registry.cancel(pendingId)
    }
    req.on('close', onAbort)
    try {
      // 阻塞等待用户裁决（或 registry 60s 超时 / cancel → 'ask'）
      const outcome: ApprovalOutcome = await registry.register(input, undefined, (id) => {
        pendingId = id
      })
      settled = true
      // 连接已断时不再向已关闭 socket 写入
      if (!res.writableEnded) sendJson(res, 200, { ok: true, decision: outcome })
    } finally {
      req.off('close', onAbort)
    }
  }

  return new Promise<IslandServer>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      void audit('island.server_listen_failed', { code: err.code, message: err.message })
      reject(err)
    })
    server.listen(config.port, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : config.port
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            // 先 drain registry：否则 server.close() 会等满所有 pending 审批的 60s 超时
            // 才回调（阻塞 #2）。drain 把未决请求按 'ask' 结掉，与 index.ts 的显式
            // drain 幂等（第二次 pendingMap 已空）。
            registry.drain()
            server.close(() => res())
            // 主动 destroy 所有 socket（含已发响应的 keep-alive 空闲连接），让关闭有界。
            // 延一个宏任务，给 drain 触发的响应写出留出时间，再强断（review P2-6）。
            const sweep = setTimeout(() => {
              for (const s of sockets) s.destroy()
              sockets.clear()
            }, 0)
            sweep.unref?.()
          })
      })
    })
  })
}
