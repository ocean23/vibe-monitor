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

/** 灵动岛窗口控制器的测试替身：全部方法用 vi.fn()，默认返回值覆盖最常见场景。
 *  不显式标注返回类型——保留 vi.fn() 的 Mock 类型，便于测试里改写返回值/断言调用。 */
function makeFakeIslandWindow() {
  return {
    getWindow: vi.fn().mockReturnValue(null),
    getNotchInfo: vi.fn().mockReturnValue(null),
    getNotchTopInset: vi.fn().mockReturnValue(38),
    detect: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    collapse: vi.fn(),
    expand: vi.fn(),
    getDefaultExpandSize: vi.fn().mockReturnValue({ width: 520, height: 46 }),
    setMouseIgnore: vi.fn(),
    reposition: vi.fn().mockResolvedValue(undefined),
    send: vi.fn()
  }
}

describe('island-ipc', () => {
  let handlers: FakeHandlers
  let audit: Mock<AuditFn>
  let state: IslandState
  let registry: ApprovalRegistry
  let launcher: Mock<IslandIpcDeps['launcher']>
  let getTerminalApp: Mock<IslandIpcDeps['getTerminalApp']>
  let islandWindow: ReturnType<typeof makeFakeIslandWindow>

  beforeEach(() => {
    handlers = {}
    audit = vi.fn<AuditFn>().mockResolvedValue(undefined)
    state = new IslandState({ audit, now: () => 1000 })
    registry = new ApprovalRegistry({ audit, now: () => 1000 })
    launcher = vi
      .fn<IslandIpcDeps['launcher']>()
      .mockResolvedValue({ ok: true, mode: 'navigated', matchedTab: 'tab' })
    getTerminalApp = vi.fn<IslandIpcDeps['getTerminalApp']>().mockReturnValue('Ghostty')
    islandWindow = makeFakeIslandWindow()
    registerIslandIpc(makeIpcMain(handlers), {
      state,
      registry,
      launcher,
      getTerminalApp,
      islandWindow
    })
  })

  it('registers all seven channels', () => {
    expect(Object.keys(handlers).sort()).toEqual([
      'island:decision',
      'island:getNotchInfo',
      'island:list',
      'island:openSession',
      'island:pending',
      'island:resize',
      'island:setMouseIgnore'
    ])
  })

  describe('island:getNotchInfo', () => {
    it('returns null when the window controller has no notch info', async () => {
      islandWindow.getNotchInfo.mockReturnValue(null)
      const out = await handlers['island:getNotchInfo'](null)
      expect(out).toBeNull()
    })

    it('merges notch info with derived geometry fields', async () => {
      islandWindow.getNotchInfo.mockReturnValue({
        hasNotch: true,
        width: 200,
        cornerRadius: 10,
        height: 38
      })
      islandWindow.getNotchTopInset.mockReturnValue(38)
      const out = (await handlers['island:getNotchInfo'](null)) as any
      expect(out).toMatchObject({
        hasNotch: true,
        width: 200,
        height: 38,
        overlap: 28,
        shoulder: 3,
        shoulderH: 10,
        topInset: 38,
        barWidth: 191
      })
    })

    it('barWidth falls back to the default fallback width when hasNotch is false', async () => {
      islandWindow.getNotchInfo.mockReturnValue({
        hasNotch: false,
        width: 0,
        cornerRadius: 0,
        height: 24
      })
      islandWindow.getNotchTopInset.mockReturnValue(24)
      const out = (await handlers['island:getNotchInfo'](null)) as any
      expect(out.barWidth).toBe(520)
    })
  })

  describe('island:resize', () => {
    it('collapses when expanded is not true', async () => {
      await handlers['island:resize'](null, { expanded: false })
      expect(islandWindow.collapse).toHaveBeenCalledOnce()
      expect(islandWindow.expand).not.toHaveBeenCalled()
    })

    it('expands with the requested size, clamped to the 1200/900 ceiling', async () => {
      await handlers['island:resize'](null, { expanded: true, width: 5000, height: 5000 })
      expect(islandWindow.expand).toHaveBeenCalledWith(1200, 900)
    })

    it('falls back to the controller default size when width/height are omitted', async () => {
      islandWindow.getDefaultExpandSize.mockReturnValue({ width: 191, height: 38 })
      await handlers['island:resize'](null, { expanded: true })
      expect(islandWindow.expand).toHaveBeenCalledWith(191, 38)
    })
  })

  describe('island:setMouseIgnore', () => {
    it('forwards the boolean to the window controller', async () => {
      await handlers['island:setMouseIgnore'](null, true)
      expect(islandWindow.setMouseIgnore).toHaveBeenCalledWith(true)
      await handlers['island:setMouseIgnore'](null, 'not-a-boolean')
      expect(islandWindow.setMouseIgnore).toHaveBeenLastCalledWith(false)
    })
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
      resolveMatchTitle,
      islandWindow
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
      resolveMatchTitle,
      islandWindow
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
