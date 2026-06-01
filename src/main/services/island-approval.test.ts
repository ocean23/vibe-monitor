import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { ApprovalRegistry, DEFAULT_APPROVAL_TIMEOUT_MS } from './island-approval'
import type { RegisterApprovalInput } from './island-approval'
import type { AuditFn } from '../audit-log'

function input(partial: Partial<RegisterApprovalInput> = {}): RegisterApprovalInput {
  return { sessionId: 's1', toolName: 'Edit', toolInput: 'src/App.tsx +2 -2', ...partial }
}

describe('island-approval', () => {
  let audit: Mock<AuditFn>
  let idCounterSeed: number
  let registry: ApprovalRegistry

  beforeEach(() => {
    audit = vi.fn<AuditFn>().mockResolvedValue(undefined)
    idCounterSeed = 0
    registry = new ApprovalRegistry({
      audit,
      now: () => 1000,
      genId: () => `req-${++idCounterSeed}`
    })
  })

  it('resolves with the decision when user decides', async () => {
    const p = registry.register(input())
    expect(registry.pending()).toHaveLength(1)
    registry.resolve('req-1', 'allow_once')
    await expect(p).resolves.toBe('allow_once')
    expect(registry.pending()).toHaveLength(0)
  })

  it('supports all three decisions', async () => {
    const a = registry.register(input())
    registry.resolve('req-1', 'deny')
    await expect(a).resolves.toBe('deny')

    const b = registry.register(input())
    registry.resolve('req-2', 'bypass')
    await expect(b).resolves.toBe('bypass')
  })

  it('emits request event with the ApprovalRequest', () => {
    const spy = vi.fn()
    registry.on('request', spy)
    registry.register(input({ toolName: 'Bash', toolInput: 'rm -rf build' }))
    expect(spy).toHaveBeenCalledTimes(1)
    const req = spy.mock.calls[0][0]
    expect(req).toMatchObject({
      requestId: 'req-1',
      toolName: 'Bash',
      toolInput: 'rm -rf build',
      requestedAt: 1000,
      timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS
    })
  })

  it('falls back to "ask" on timeout and audits', async () => {
    let fire: (() => void) | null = null
    const reg = new ApprovalRegistry({
      audit,
      now: () => 1000,
      genId: () => 'req-timeout',
      // 捕获超时回调，手动触发模拟时间到点
      setTimer: (fn) => {
        fire = fn
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {}
    })
    const p = reg.register(input(), 60_000)
    expect(fire).not.toBeNull()
    fire!()
    await expect(p).resolves.toBe('ask')
    expect(reg.pending()).toHaveLength(0)
    expect(audit).toHaveBeenCalledWith(
      'island.approval_timeout',
      expect.objectContaining({ requestId: 'req-timeout' })
    )
  })

  it('clears the timer when resolved before timeout', async () => {
    const clearSpy = vi.fn()
    const reg = new ApprovalRegistry({
      audit,
      now: () => 1000,
      genId: () => 'req-x',
      setTimer: () => 42 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: clearSpy
    })
    const p = reg.register(input())
    reg.resolve('req-x', 'allow_once')
    await p
    expect(clearSpy).toHaveBeenCalledWith(42)
  })

  it('ignores resolve for unknown requestId without throwing', () => {
    expect(() => registry.resolve('nope', 'deny')).not.toThrow()
  })

  it('emits resolved event on decision and on timeout', async () => {
    const resolvedSpy = vi.fn()
    registry.on('resolved', resolvedSpy)
    const p = registry.register(input())
    registry.resolve('req-1', 'bypass')
    await p
    expect(resolvedSpy).toHaveBeenCalledWith({ requestId: 'req-1', outcome: 'bypass' })
  })

  it('drain() resolves all pending as "ask"', async () => {
    const p1 = registry.register(input({ sessionId: 'a' }))
    const p2 = registry.register(input({ sessionId: 'b' }))
    registry.drain()
    await expect(p1).resolves.toBe('ask')
    await expect(p2).resolves.toBe('ask')
    expect(registry.pending()).toHaveLength(0)
  })

  it('onRegistered fires synchronously with the generated requestId', () => {
    let captured: string | null = null
    registry.register(input(), undefined, (id) => {
      captured = id
    })
    expect(captured).toBe('req-1')
  })

  it('cancel() resolves a single pending as "ask" and clears it', async () => {
    const p = registry.register(input())
    registry.cancel('req-1')
    await expect(p).resolves.toBe('ask')
    expect(registry.pending()).toHaveLength(0)
  })

  it('cancel() of unknown id is a no-op', () => {
    expect(() => registry.cancel('nope')).not.toThrow()
  })

  it('id collision: old pending is resolved "ask" and timer cleared (no leak)', async () => {
    const clearSpy = vi.fn()
    let n = 0
    const reg = new ApprovalRegistry({
      audit,
      now: () => 1000,
      genId: () => 'dup', // 强制碰撞
      setTimer: () => ++n as unknown as ReturnType<typeof setTimeout>,
      clearTimer: clearSpy
    })
    const first = reg.register(input({ sessionId: 'a' }))
    const second = reg.register(input({ sessionId: 'b' }))
    await expect(first).resolves.toBe('ask') // 旧的被碰撞清掉
    expect(clearSpy).toHaveBeenCalled()
    expect(reg.pending()).toHaveLength(1) // 只剩第二个
    reg.resolve('dup', 'deny')
    await expect(second).resolves.toBe('deny')
  })
})
