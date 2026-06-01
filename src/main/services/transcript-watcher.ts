import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { AuditFn } from '../audit-log'
import type { IslandState } from './island-state'

/** 单条 transcript 文本截断上限（灵动岛只显示摘要）。 */
const MAX_MESSAGE_CHARS = 200

/** 单次增量读取上限，防异常大文件一次性读爆内存。 */
const MAX_READ_CHUNK = 2_000_000

export interface ParsedTranscriptLine {
  sessionId: string
  /** 最近一条消息文本摘要（已截断） */
  text: string
}

/**
 * 解析一行 transcript JSONL，提取 sessionId + 文本摘要。
 *
 * Claude Code transcript 每行是一个 JSON 对象，`message.content` 可能是字符串或
 * `{type:'text', text}` 片段数组。只关心 user/assistant 文本；工具调用 / 其它类型
 * 返回 null（由调用方跳过，继续向前找最近一条有文本的行）。
 */
export function parseTranscriptLine(line: string): ParsedTranscriptLine | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let d: Record<string, unknown>
  try {
    d = JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    return null
  }
  const sessionId = typeof d.sessionId === 'string' ? d.sessionId : ''
  if (!sessionId) return null
  const message = d.message as { content?: unknown } | undefined
  if (!message || typeof message !== 'object') return null
  const content = message.content
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
        text = String((part as { text?: unknown }).text ?? '')
        break
      }
    }
  }
  text = text.trim()
  if (!text) return null
  if (text.length > MAX_MESSAGE_CHARS) text = text.slice(0, MAX_MESSAGE_CHARS) + '…'
  return { sessionId, text }
}

/**
 * 从一段（可能含多行）transcript 文本中，取**最后一条**可解析出文本的消息。
 * 用于增量块解析：从后往前找第一条 user/assistant 文本行。
 */
export function parseLastMessage(chunk: string): ParsedTranscriptLine | null {
  const lines = chunk.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseTranscriptLine(lines[i])
    if (parsed) return parsed
  }
  return null
}

export interface TranscriptWatcherDeps {
  /** 监听根目录，默认 `~/.claude/projects` */
  projectsDir: string
  state: IslandState
  audit: AuditFn
}

export interface TranscriptWatcher {
  close: () => void
}

/**
 * 监听 `~/.claude/projects/**` 下的 `*.jsonl` transcript 增量，补「最后一条消息」（FR-003）。
 *
 * hooks 只在关键节点触发、拿不到持续「运行中」明细；transcript 是 Claude Code 实时
 * 追加的会话流，watch 其增量即可补足最后消息。用 Node 原生 `fs.watch(recursive)`，
 * **不引入 chokidar**——本仓运行时零依赖（见 plan 决策记录）。
 *
 * 按文件维护读取 offset，每次变化只读追加部分并解析最后一条文本行，调
 * `state.updateLastMessage`（仅更新已存在会话，不凭空创建——会话生命周期由 hook 主导）。
 */
export function createTranscriptWatcher(deps: TranscriptWatcherDeps): TranscriptWatcher {
  const { projectsDir, state, audit } = deps
  /** file → 已读字节 offset */
  const offsets = new Map<string, number>()
  /** 正在处理的文件（per-file 锁）：fs.watch 高频回调时同文件并发进入会重复读旧 offset。 */
  const inFlight = new Set<string>()
  /**
   * 处理期间又来事件的文件：标记「待补跑」。处理结束后若被标记则再跑一趟，
   * 确保「会话收尾那次写入」不会因为恰好撞上 inFlight 而被永久丢弃——否则此后
   * 再无 watch 事件兜底，灵动岛会停在过期的 lastMessage。
   */
  const pending = new Set<string>()
  let watcher: fs.FSWatcher | null = null

  async function handleFileChange(filePath: string): Promise<void> {
    if (!filePath.endsWith('.jsonl')) return
    // per-file 串行：同一文件正在处理时只标记 pending 后返回（offset 处理结束才更新，
    // 并发进入会重复读旧 offset）。处理结束后由下方 while 补跑被标记的文件。
    if (inFlight.has(filePath)) {
      pending.add(filePath)
      return
    }
    inFlight.add(filePath)
    try {
      await processFile(filePath)
      // 处理期间若有新事件被标记，补跑直到无新增（processFile 读到 EOF 时 length<=0
      // 立即返回，幂等，多跑一趟成本极低）。
      while (pending.delete(filePath)) {
        await processFile(filePath)
      }
    } finally {
      inFlight.delete(filePath)
      pending.delete(filePath)
    }
  }

  async function processFile(filePath: string): Promise<void> {
    let stat: fs.Stats
    try {
      stat = await fsp.stat(filePath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        offsets.delete(filePath)
        return
      }
      await audit('island.transcript_stat_failed', { error: (err as Error).message })
      return
    }
    if (!stat.isFile()) return

    const prevOffset = offsets.get(filePath) ?? 0
    // 文件被截断 / 轮转（变小）→ 从头读
    const start = stat.size < prevOffset ? 0 : prevOffset
    const length = Math.min(stat.size - start, MAX_READ_CHUNK)
    if (length <= 0) {
      offsets.set(filePath, stat.size)
      return
    }

    let chunk: string
    try {
      const fh = await fsp.open(filePath, 'r')
      try {
        const buf = Buffer.alloc(length)
        await fh.read(buf, 0, length, start)
        chunk = buf.toString('utf-8')
      } finally {
        await fh.close()
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        await audit('island.transcript_read_failed', { error: (err as Error).message })
      }
      return
    }
    offsets.set(filePath, stat.size)

    const parsed = parseLastMessage(chunk)
    if (parsed) {
      state.updateLastMessage(parsed.sessionId, parsed.text)
    }
  }

  try {
    // 注意：`recursive: true` 仅 macOS / Windows 支持（Node 文档明确）；Linux 上不报错
    // 但收不到子目录事件。本功能 MVP 仅 macOS，跨平台扩展时需改用逐目录 watch 或 chokidar。
    watcher = fs.watch(projectsDir, { recursive: true }, (_eventType, filename) => {
      if (!filename) return
      const filePath = path.join(projectsDir, filename.toString())
      void handleFileChange(filePath)
    })
    watcher.on('error', (err) => {
      void audit('island.transcript_watch_error', { error: (err as Error).message })
    })
  } catch (err) {
    // 目录不存在等：审计后降级为「无 watcher」，灵动岛仍可靠 hook 事件工作
    void audit('island.transcript_watch_failed', { error: (err as Error).message })
  }

  return {
    close: () => {
      watcher?.close()
      watcher = null
    }
  }
}
