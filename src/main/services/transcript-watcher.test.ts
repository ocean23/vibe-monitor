import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { AuditFn } from '../audit-log'
import {
  parseTranscriptLine,
  parseLastMessage,
  parseSessionId,
  chunkHasUserActivity,
  createTranscriptWatcher,
  type TranscriptWatcher
} from './transcript-watcher'
import { IslandState } from './island-state'

function jsonl(obj: unknown): string {
  return JSON.stringify(obj) + '\n'
}

function userLine(sessionId: string, text: string): string {
  return jsonl({ type: 'user', sessionId, cwd: '/x', message: { role: 'user', content: text } })
}

function assistantLine(sessionId: string, text: string): string {
  return jsonl({
    type: 'assistant',
    sessionId,
    cwd: '/x',
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })
}

/** 思考块行：有 sessionId 但无 `type:'text'` 内容（parseLastMessage 取不到，但仍是活跃信号）。 */
function thinkingLine(sessionId: string): string {
  return jsonl({
    type: 'assistant',
    sessionId,
    cwd: '/x',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'pondering…' }] }
  })
}

/** 轮询直到条件成立（fs.watch 异步），超时抛错。 */
async function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('parseTranscriptLine', () => {
  it('extracts text from string content', () => {
    expect(parseTranscriptLine(userLine('s1', 'hello'))).toEqual({ sessionId: 's1', text: 'hello' })
  })

  it('extracts text from array content (first text part)', () => {
    expect(parseTranscriptLine(assistantLine('s2', 'world'))).toEqual({
      sessionId: 's2',
      text: 'world'
    })
  })

  it('returns null for invalid json', () => {
    expect(parseTranscriptLine('not json{')).toBeNull()
  })

  it('returns null when no sessionId', () => {
    expect(parseTranscriptLine(jsonl({ message: { content: 'x' } }))).toBeNull()
  })

  it('returns null when no text content', () => {
    expect(
      parseTranscriptLine(jsonl({ sessionId: 's', message: { content: [{ type: 'tool_use' }] } }))
    ).toBeNull()
  })

  it('truncates long text', () => {
    const long = 'a'.repeat(500)
    const out = parseTranscriptLine(userLine('s', long))
    expect(out!.text.length).toBeLessThanOrEqual(201)
    expect(out!.text.endsWith('…')).toBe(true)
  })
})

describe('parseLastMessage', () => {
  it('returns the last text-bearing line in a chunk', () => {
    const chunk = userLine('s1', 'first') + assistantLine('s1', 'second') + jsonl({ x: 1 })
    expect(parseLastMessage(chunk)).toEqual({ sessionId: 's1', text: 'second' })
  })

  it('skips trailing non-text lines', () => {
    const chunk =
      assistantLine('s1', 'real') +
      jsonl({ sessionId: 's1', message: { content: [{ type: 'tool_use' }] } })
    expect(parseLastMessage(chunk)).toEqual({ sessionId: 's1', text: 'real' })
  })

  it('returns null for empty chunk', () => {
    expect(parseLastMessage('')).toBeNull()
  })
})

describe('parseSessionId', () => {
  it('extracts sessionId from a text line', () => {
    expect(parseSessionId(assistantLine('s1', 'hi'))).toBe('s1')
  })

  it('extracts sessionId from a non-text line (thinking)', () => {
    expect(parseSessionId(thinkingLine('s2'))).toBe('s2')
  })

  it('extracts sessionId from a tool_use line', () => {
    const chunk = jsonl({ sessionId: 's3', message: { content: [{ type: 'tool_use' }] } })
    expect(parseSessionId(chunk)).toBe('s3')
  })

  it('scans from the end past trailing meta lines lacking sessionId', () => {
    const chunk = assistantLine('s4', 'real') + jsonl({ type: 'mode', mode: 'x' })
    expect(parseSessionId(chunk)).toBe('s4')
  })

  it('returns null when no line carries a sessionId', () => {
    expect(parseSessionId(jsonl({ type: 'mode' }) + jsonl({ x: 1 }))).toBeNull()
    expect(parseSessionId('')).toBeNull()
  })
})

describe('chunkHasUserActivity', () => {
  it('true for a user tool_result line', () => {
    const line = jsonl({
      type: 'user',
      sessionId: 's',
      message: { role: 'user', content: [{ type: 'tool_result' }] }
    })
    expect(chunkHasUserActivity(line)).toBe(true)
  })

  it('true for a user string-content line (new prompt)', () => {
    expect(chunkHasUserActivity(userLine('s', 'hi'))).toBe(true)
  })

  it('false for assistant-only lines (thinking / text)', () => {
    expect(chunkHasUserActivity(thinkingLine('s') + assistantLine('s', 'x'))).toBe(false)
  })

  it('false for empty / meta-only chunk', () => {
    expect(chunkHasUserActivity('')).toBe(false)
    expect(chunkHasUserActivity(jsonl({ type: 'mode' }))).toBe(false)
  })
})

describe('createTranscriptWatcher', () => {
  let tmp: string
  let audit: Mock<AuditFn>
  let state: IslandState
  let watcher: TranscriptWatcher | null = null

  beforeEach(async () => {
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'tx-watch-'))
    tmp = await fs.realpath(raw)
    audit = vi.fn<AuditFn>().mockResolvedValue(undefined)
    state = new IslandState({ audit, now: () => 1000 })
  })

  afterEach(async () => {
    watcher?.close()
    watcher = null
    await fs.rm(tmp, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('updates lastMessage for an existing session on append', async () => {
    // 先有会话（hook 主导生命周期）
    state.applyEvent({ kind: 'PreToolUse', session_id: 's1' })
    const f = path.join(tmp, 's1.jsonl')
    await fs.writeFile(f, userLine('s1', 'initial'))

    watcher = createTranscriptWatcher({ projectsDir: tmp, state, audit })

    await fs.appendFile(f, assistantLine('s1', 'latest reply'))
    await waitFor(() => state.list()[0]?.lastMessage === 'latest reply')
    expect(state.list()[0].lastMessage).toBe('latest reply')
  })

  it('revives an idle session to running on a thinking-only append (no text)', async () => {
    // 长思考期被 sweepStale 误降为 idle；transcript 只追加思考行（无可显示文本）也应复活为 running
    state.applyEvent({ kind: 'SessionStart', session_id: 's1' }) // idle
    expect(state.list()[0].status).toBe('idle')
    const f = path.join(tmp, 's1.jsonl')
    await fs.writeFile(f, thinkingLine('s1'))

    watcher = createTranscriptWatcher({ projectsDir: tmp, state, audit })

    await fs.appendFile(f, thinkingLine('s1'))
    await waitFor(() => state.list()[0]?.status === 'running')
    expect(state.list()[0].status).toBe('running')
    // 无文本行 → lastMessage 不被设置（心跳只管保活/复活，不杜撰摘要）
    expect(state.list()[0].lastMessage).toBeUndefined()
  })

  it('clears waiting only on a user tool_result append (model-only append preserves waiting)', async () => {
    // 模拟 AskUserQuestion：会话置 waiting → 模型侧思考行保持 waiting → 用户回答(tool_result)转 running
    state.applyEvent({
      kind: 'Notification',
      session_id: 's1',
      last_message: 'Claude needs your permission to use AskUserQuestion'
    })
    expect(state.list()[0].status).toBe('waiting')
    const f = path.join(tmp, 's1.jsonl')
    await fs.writeFile(f, thinkingLine('s1'))

    watcher = createTranscriptWatcher({ projectsDir: tmp, state, audit })

    // 纯模型侧产出（思考块）：保持 waiting
    await fs.appendFile(f, thinkingLine('s1'))
    await new Promise((r) => setTimeout(r, 150))
    expect(state.list()[0].status).toBe('waiting')

    // 用户回答（tool_result，user 行）：解除 → running
    await fs.appendFile(
      f,
      jsonl({
        type: 'user',
        sessionId: 's1',
        message: { role: 'user', content: [{ type: 'tool_result' }] }
      })
    )
    await waitFor(() => state.list()[0]?.status === 'running')
    expect(state.list()[0].status).toBe('running')
  })

  it('does not create a session for unknown sessionId', async () => {
    watcher = createTranscriptWatcher({ projectsDir: tmp, state, audit })
    const f = path.join(tmp, 'ghost.jsonl')
    await fs.writeFile(f, assistantLine('ghost', 'orphan'))
    // 给 watcher 一点时间，确认仍为 0
    await new Promise((r) => setTimeout(r, 200))
    expect(state.count()).toBe(0)
  })

  it('isolates multiple sessions across files', async () => {
    state.applyEvent({ kind: 'PreToolUse', session_id: 'a' })
    state.applyEvent({ kind: 'PreToolUse', session_id: 'b' })
    const fa = path.join(tmp, 'a.jsonl')
    const fb = path.join(tmp, 'b.jsonl')
    await fs.writeFile(fa, userLine('a', 'seed-a'))
    await fs.writeFile(fb, userLine('b', 'seed-b'))

    watcher = createTranscriptWatcher({ projectsDir: tmp, state, audit })

    await fs.appendFile(fa, assistantLine('a', 'msg-a'))
    await fs.appendFile(fb, assistantLine('b', 'msg-b'))
    await waitFor(
      () =>
        state.list().find((s) => s.sessionId === 'a')?.lastMessage === 'msg-a' &&
        state.list().find((s) => s.sessionId === 'b')?.lastMessage === 'msg-b'
    )
    expect(state.list().find((s) => s.sessionId === 'a')?.lastMessage).toBe('msg-a')
    expect(state.list().find((s) => s.sessionId === 'b')?.lastMessage).toBe('msg-b')
  })

  it('does not throw when projectsDir does not exist (audits)', () => {
    const missing = path.join(tmp, 'nope')
    expect(() => {
      watcher = createTranscriptWatcher({ projectsDir: missing, state, audit })
    }).not.toThrow()
  })
})
