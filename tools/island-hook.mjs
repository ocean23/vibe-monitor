#!/usr/bin/env node
/**
 * 灵动岛 hook 上报脚本（被 Claude Code hooks 调用）。
 *
 * Claude Code 在 SessionStart / UserPromptSubmit / PreToolUse / Notification / Stop / SessionEnd
 * 各节点把一个 JSON payload 写到本脚本 stdin（含 session_id / cwd / hook_event_name /
 * permission_mode 等公共字段）。SessionEnd 经普通事件路径上报，服务端据此把会话从岛上移除。本脚本：
 *   1. 读 `~/.vibe-monitor/island.json` 拿 Vibe Monitor 环回端口 + token
 *   2. 普通事件 → `POST /event`（fire-and-forget，状态上报）
 *   3. PreToolUse → 按 permission_mode 分流：
 *      - bypassPermissions / acceptEdits → 直接放行（仅 fire-and-forget 上报 running，不阻塞、不弹审批）
 *      - default / plan / (字段缺失) → `POST /approval` 阻塞读响应，把岛内裁决翻译成
 *        `hookSpecificOutput.permissionDecision`（allow_once/bypass→allow、deny→deny、ask→ask）
 *
 * 容错铁律：Vibe Monitor 未运行 / 连接失败 / 超时 → PreToolUse 输出 `permissionDecision: "ask"`
 * 交回终端原生询问，**绝不阻塞或卡死 Claude 会话**；其它事件静默退出 0。
 *
 * 仅依赖 Node 内置模块（node:http / node:fs），可由 `node tools/island-hook.mjs` 直接运行。
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

/** 审批请求 hook 侧的兜底超时（略大于服务端 60s，避免双方同时计时打架）。 */
const HOOK_REQUEST_TIMEOUT_MS = 65_000

/** 响应体上限：服务端响应很小，64KB 足够；超限即断开并退化为兜底，绝不在 hook 侧累积内存。 */
const MAX_RESPONSE_BYTES = 64 * 1024

/** 会话标题 / 最后消息的截断上限（与服务端 clipField 500 一致量级，hook 侧先截一道）。 */
const TITLE_MAX = 60
const MSG_MAX = 200

function readStdin() {
  try {
    return readFileSync(0, 'utf-8')
  } catch {
    return ''
  }
}

function loadConfig() {
  try {
    const p = path.join(os.homedir(), '.vibe-monitor', 'island.json')
    const cfg = JSON.parse(readFileSync(p, 'utf-8'))
    if (cfg && typeof cfg.port === 'number' && typeof cfg.token === 'string') return cfg
  } catch {
    /* Vibe Monitor 未运行 / 未初始化 → null，调用方降级 */
  }
  return null
}

function postJson(cfg, route, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload), 'utf-8')
    let settled = false
    let hardTimer
    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      fn(arg)
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port: cfg.port,
        path: route,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': data.length,
          authorization: `Bearer ${cfg.token}`
        },
        timeout: timeoutMs
      },
      (res) => {
        let body = ''
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('response too large'))
            finish(resolve, {})
            return
          }
          body += c
        })
        res.on('end', () => {
          try {
            finish(resolve, JSON.parse(body))
          } catch {
            finish(resolve, {})
          }
        })
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', (err) => finish(reject, err))
    // 硬超时兜底：http 的 socket `timeout` 只在连接空闲时触发，TCP 半开 / 内核 accept
    // 队列异常等场景不一定按时触发。独立计时器到点强制 destroy，坐实「绝不卡死 Claude」。
    hardTimer = setTimeout(() => {
      req.destroy(new Error('hard-timeout'))
      finish(reject, new Error('hard-timeout'))
    }, timeoutMs + 1000)
    hardTimer.unref?.()
    req.write(data)
    req.end()
  })
}

/** 截断到 max 字符（保留首行，去多余空白）。 */
function clip(s, max) {
  if (typeof s !== 'string') return undefined
  const firstLine = s.replace(/\s+/g, ' ').trim()
  if (!firstLine) return undefined
  return firstLine.length > max ? firstLine.slice(0, max) + '…' : firstLine
}

/**
 * 派生会话标题：Claude Code hook 不提供会话名，只有 session_id（UUID）。
 * UserPromptSubmit 用本轮 prompt 首行作标题（贴合 Vibe Island「项目·prompt」观感）；
 * 其它事件无 prompt → 返回 undefined，由服务端状态机保留上一次的标题。
 */
function deriveSessionName(payload) {
  if (typeof payload.prompt === 'string') return clip(payload.prompt, TITLE_MAX)
  return undefined
}

/** 派生「最后一条消息」摘要：UserPromptSubmit 用 prompt，Notification 用 message。 */
function deriveLastMessage(payload) {
  if (typeof payload.prompt === 'string') return clip(payload.prompt, MSG_MAX)
  if (typeof payload.message === 'string') return clip(payload.message, MSG_MAX)
  return undefined
}

/** TERM_PROGRAM → 友好终端名（覆盖主流终端，其它原样回显）。 */
const TERM_PROGRAM_NAMES = {
  ghostty: 'Ghostty',
  'iTerm.app': 'iTerm',
  Apple_Terminal: 'Terminal',
  vscode: 'VS Code',
  WezTerm: 'WezTerm',
  Hyper: 'Hyper',
  Tabby: 'Tabby',
  rio: 'Rio'
}

/**
 * 派生会话所在终端名（如 'Ghostty'、'Ghostty·tmux'）。
 * hook 是 Claude Code 的子进程，继承其环境变量：优先看 TERM_PROGRAM，
 * 再用各终端的私有变量兜底；身处 tmux（TMUX 非空）时追加 `·tmux` 后缀。
 */
function deriveTerminal() {
  const tp = process.env.TERM_PROGRAM || ''
  let name = TERM_PROGRAM_NAMES[tp] || tp || undefined
  if (!name) {
    if (process.env.KITTY_WINDOW_ID) name = 'kitty'
    else if (process.env.ALACRITTY_SOCKET || process.env.ALACRITTY_WINDOW_ID) name = 'Alacritty'
    else if (process.env.WEZTERM_PANE) name = 'WezTerm'
  }
  if (process.env.TMUX) name = name ? `${name}·tmux` : 'tmux'
  return name
}

/**
 * 派生驱动会话的模型名。当前数据源恒为 Claude Code → 'Claude'；
 * 若未来 hook payload 带 model 字段（其它模型/Agent），原样透传，保持前向兼容。
 */
function deriveModel(payload) {
  if (typeof payload.model === 'string' && payload.model.trim())
    return clip(payload.model, TITLE_MAX)
  return 'Claude'
}

/**
 * 把岛内裁决（allow_once / bypass / deny / ask）翻译为 Claude Code 的 permissionDecision。
 * 纯函数，便于单测：allow_once/bypass/未知 → allow，deny → deny，ask → ask。
 */
function translatePreToolUseDecision(outcome) {
  return outcome === 'deny' ? 'deny' : outcome === 'ask' ? 'ask' : 'allow'
}

/** PreToolUse 输出：把岛内裁决翻译为 Claude Code permissionDecision 并写 stdout。 */
function emitPreToolUseDecision(outcome) {
  const decision = translatePreToolUseDecision(outcome)
  const reason =
    decision === 'allow'
      ? 'Approved in Vibe Island'
      : decision === 'deny'
        ? 'Denied in Vibe Island'
        : 'Island unavailable/timeout — defer to terminal'
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason
      }
    })
  )
}

async function main() {
  const raw = readStdin()
  let payload = {}
  try {
    payload = raw ? JSON.parse(raw) : {}
  } catch {
    payload = {}
  }

  const kind = payload.hook_event_name || process.env.CLAUDE_HOOK_EVENT_NAME || ''
  const sessionId = payload.session_id || ''
  const cwd = payload.cwd || process.cwd()
  const projectName = cwd ? path.basename(cwd) : undefined
  const sessionName = deriveSessionName(payload)
  const lastMessage = deriveLastMessage(payload)
  const terminal = deriveTerminal()
  const model = deriveModel(payload)
  // permission_mode 较新版本才有；缺失时按 'default' 处理（走审批，最安全的功能默认）。
  const permissionMode = payload.permission_mode || 'default'

  const cfg = loadConfig()

  // PreToolUse：按权限模式分流
  if (kind === 'PreToolUse') {
    // bypassPermissions / acceptEdits：用户已选择免询问，岛不打扰——直接放行，
    // 仅 fire-and-forget 上报一条 running 状态（让岛在这类会话里也能显示活跃）。
    if (permissionMode === 'bypassPermissions' || permissionMode === 'acceptEdits') {
      if (cfg) {
        try {
          await postJson(
            cfg,
            '/event',
            {
              kind,
              session_id: sessionId,
              project_name: projectName,
              model,
              terminal,
              ts: Date.now()
            },
            3_000
          )
        } catch {
          /* 忽略 */
        }
      }
      emitPreToolUseDecision('allow')
      return
    }
    // default / plan：走岛内审批阻塞回环
    if (!cfg) {
      emitPreToolUseDecision('ask') // Vibe Monitor 不在 → 交回终端
      return
    }
    try {
      const res = await postJson(
        cfg,
        '/approval',
        {
          session_id: sessionId,
          project_name: projectName,
          session_name: sessionName,
          tool_name: payload.tool_name || '',
          tool_input: payload.tool_input
        },
        HOOK_REQUEST_TIMEOUT_MS
      )
      emitPreToolUseDecision(res?.decision || 'ask')
    } catch {
      emitPreToolUseDecision('ask')
    }
    return
  }

  // 其它事件：fire-and-forget 状态上报；失败静默
  if (cfg && kind) {
    try {
      await postJson(
        cfg,
        '/event',
        {
          kind,
          session_id: sessionId,
          project_name: projectName,
          session_name: sessionName,
          last_message: lastMessage,
          model,
          terminal,
          stop_reason: payload.stop_reason,
          ts: Date.now()
        },
        3_000
      )
    } catch {
      /* Vibe Monitor 不在 / 网络问题 → 忽略，不影响 Claude */
    }
  }
}

// 仅在作为入口直接运行时执行 main（被单测 import 时不执行，便于测试纯函数）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    () => process.exit(0) // 任何意外都不得让 Claude hook 失败
  )
}

// 导出纯函数供单测（不触发 main）。
export {
  clip,
  deriveSessionName,
  deriveLastMessage,
  deriveTerminal,
  deriveModel,
  translatePreToolUseDecision
}
