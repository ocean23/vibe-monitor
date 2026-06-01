import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { registerIslandIpc, type IslandIpcDeps } from './island-ipc'
import { IslandState } from '../services/island-state'
import { ApprovalRegistry } from '../services/island-approval'
import type { AuditFn } from '../audit-log'

interface FakeHandlers {
  [channel: string]: (event: unknown, ...args: unknown[]) => unknown
}

function makeIpcMain(handlers: FakeHandlers) {
  return {
    handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) {
      handlers[channel] = listener
    }
  }
}

describe('island-ipc', () => {
  let handlers: FakeHandlers
  let audit: Mock<AuditFn>
  let state: IslandState
  let registry: ApprovalRegistry
  let launcher: Mock<IslandIpcDeps['launcher']>
  let getTerminalApp: Mock<IslandIpcDeps['getTerminalApp']>

  beforeEach(() => {
    handlers = {}
    audit = vi.fn<AuditFn>().mockResolvedValue(undefined)
    state = new IslandState({ audit, now: () => 1000 })
    registry = new ApprovalRegistry({ audit, now: () => 1000 })
    launcher = vi
      .fn<IslandIpcDeps['launcher']>()
      .mockResolvedValue({ ok: true, mode: 'navigated', matchedTab: 'tab' })
    getTerminalApp = vi.fn<IslandIpcDeps['getTerminalApp']>().mockReturnValue('Ghostty')
    registerIslandIpc(makeIpcMain(handlers), { state, registry, launcher, getTerminalApp })
  })

  it('registers all four channels', () => {
    expect(Object.keys(handlers).sort()).toEqual([
      'island:decision',
      'island:list',
      'island:openSession',
      'island:pending'
    ])
  })

  it('island:list returns state snapshot', async () => {
    state.applyEvent({ kind: 'PreToolUse', session_id: 's1' })
    const out = await handlers['island:list'](null)
    expect(out).toHaveLength(1)
    expect((out as any)[0].sessionId).toBe('s1')
  })

  it('island:pending returns registry pending', async () => {
    registry.register({ sessionId: 's1', toolName: 'Edit', toolInput: 'x' })
    const out = await handlers['island:pending'](null)
    expect(out).toHaveLength(1)
  })

  it('island:decision resolves the registry and returns true', async () => {
    const p = registry.register({ sessionId: 's1', toolName: 'Edit', toolInput: 'x' })
    const reqId = registry.pending()[0].requestId
    const ok = await handlers['island:decision'](null, reqId, 'allow_once')
    expect(ok).toBe(true)
    await expect(p).resolves.toBe('allow_once')
  })

  it('island:decision rejects invalid decision', async () => {
    const ok = await handlers['island:decision'](null, 'some-id', 'nonsense')
    expect(ok).toBe(false)
  })

  it('island:decision rejects empty requestId', async () => {
    const ok = await handlers['island:decision'](null, '', 'deny')
    expect(ok).toBe(false)
  })

  it('island:openSession launches with session info', async () => {
    state.applyEvent({ kind: 'PreToolUse', session_id: 's1', session_name: 'demo-tab' })
    const res = await handlers['island:openSession'](null, 's1')
    expect(launcher).toHaveBeenCalledWith({
      app: 'Ghostty',
      sessionId: 's1',
      sessionName: 'demo-tab'
    })
    expect((res as any).mode).toBe('navigated')
  })

  it('island:openSession prefers resolveMatchTitle (Claude aiTitle) over sessionName as the match needle', async () => {
    const resolveMatchTitle = vi.fn().mockResolvedValue('AI Generated Tab Title')
    const handlers2: FakeHandlers = {}
    registerIslandIpc(makeIpcMain(handlers2), {
      state,
      registry,
      launcher,
      getTerminalApp,
      resolveMatchTitle
    })
    state.applyEvent({ kind: 'PreToolUse', session_id: 's1', session_name: 'prompt-first-line' })
    await handlers2['island:openSession'](null, 's1')
    expect(resolveMatchTitle).toHaveBeenCalledWith('s1')
    expect(launcher).toHaveBeenCalledWith({
      app: 'Ghostty',
      sessionId: 's1',
      sessionName: 'AI Generated Tab Title'
    })
  })

  it('island:openSession falls back to sessionName when resolveMatchTitle yields nothing', async () => {
    const resolveMatchTitle = vi.fn().mockResolvedValue(undefined)
    const handlers2: FakeHandlers = {}
    registerIslandIpc(makeIpcMain(handlers2), {
      state,
      registry,
      launcher,
      getTerminalApp,
      resolveMatchTitle
    })
    state.applyEvent({ kind: 'PreToolUse', session_id: 's1', session_name: 'demo-tab' })
    await handlers2['island:openSession'](null, 's1')
    expect(launcher).toHaveBeenCalledWith({
      app: 'Ghostty',
      sessionId: 's1',
      sessionName: 'demo-tab'
    })
  })

  it('island:openSession returns no_session_id for empty id', async () => {
    const res = await handlers['island:openSession'](null, '')
    expect((res as any).mode).toBe('no_session_id')
    expect(launcher).not.toHaveBeenCalled()
  })

  it('island:openSession returns not-found for unknown session', async () => {
    const res = await handlers['island:openSession'](null, 'ghost')
    expect((res as any).reason).toBe('not-found')
    expect(launcher).not.toHaveBeenCalled()
  })
})
