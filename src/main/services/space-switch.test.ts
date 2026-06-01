import { describe, it, expect, vi } from 'vitest'
import { createEnsureSpaceAutoSwitch, type SpaceSwitchDeps } from './space-switch'
import type { RunCommandResult } from './terminal-launcher'

const OK = (stdout = '', stderr = ''): RunCommandResult => ({ code: 0, stdout, stderr })
const FAIL = (stderr = '', code = 1): RunCommandResult => ({ code, stdout: '', stderr })

function makeDeps(
  routes: Array<{ match: RegExp; result: RunCommandResult }>,
  platform: NodeJS.Platform = 'darwin'
): {
  deps: SpaceSwitchDeps
  audit: ReturnType<typeof vi.fn>
  calls: Array<{ cmd: string; args: string[] }>
} {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const runCommand: SpaceSwitchDeps['runCommand'] = async (cmd, args) => {
    calls.push({ cmd, args })
    const joined = `${cmd} ${args.join(' ')}`
    for (const r of routes) if (r.match.test(joined)) return r.result
    throw new Error(`unmatched runCommand: ${joined}`)
  }
  const audit = vi.fn(async () => {})
  // settleMs:0 → 开启分支不真正 sleep，保持测试同步快速
  return { deps: { runCommand, platform, audit, settleMs: 0 }, audit, calls }
}

describe('createEnsureSpaceAutoSwitch', () => {
  it('non-darwin → no-op, runs no command', async () => {
    const { deps, calls } = makeDeps([], 'win32')
    await createEnsureSpaceAutoSwitch(deps)()
    expect(calls).toEqual([])
  })

  it('setting already on (read returns "1") → no write, no killall', async () => {
    const { deps, calls } = makeDeps([{ match: /^defaults read/, result: OK('1') }])
    await createEnsureSpaceAutoSwitch(deps)()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      cmd: 'defaults',
      args: ['read', 'com.apple.dock', 'workspaces-auto-swoosh']
    })
  })

  it('setting off (key missing → read non-zero) → writes true + killall Dock + audits enabled', async () => {
    const { deps, calls, audit } = makeDeps([
      { match: /^defaults read/, result: FAIL('does not exist') },
      { match: /^defaults write/, result: OK() },
      { match: /^killall Dock/, result: OK() }
    ])
    await createEnsureSpaceAutoSwitch(deps)()
    expect(calls.map((c) => `${c.cmd} ${c.args.join(' ')}`)).toEqual([
      'defaults read com.apple.dock workspaces-auto-swoosh',
      'defaults write com.apple.dock workspaces-auto-swoosh -bool true',
      'killall Dock'
    ])
    expect(audit).toHaveBeenCalledWith('claude_notify.space_switch_enabled', {})
  })

  it('setting off (read returns "0") → writes true + killall', async () => {
    const { deps, calls } = makeDeps([
      { match: /^defaults read/, result: OK('0') },
      { match: /^defaults write/, result: OK() },
      { match: /^killall Dock/, result: OK() }
    ])
    await createEnsureSpaceAutoSwitch(deps)()
    expect(calls.some((c) => c.cmd === 'killall')).toBe(true)
  })

  it('process-level memo: once enabled, subsequent calls are no-ops', async () => {
    const { deps, calls } = makeDeps([
      { match: /^defaults read/, result: FAIL('does not exist') },
      { match: /^defaults write/, result: OK() },
      { match: /^killall Dock/, result: OK() }
    ])
    const ensure = createEnsureSpaceAutoSwitch(deps)
    await ensure()
    const afterFirst = calls.length
    await ensure()
    await ensure()
    expect(calls.length).toBe(afterFirst) // 不再 spawn 任何命令
  })

  it('write fails → does NOT set memo (retries next time) + audits failure, no killall', async () => {
    const { deps, calls, audit } = makeDeps([
      { match: /^defaults read/, result: FAIL('does not exist') },
      { match: /^defaults write/, result: FAIL('permission denied') }
    ])
    const ensure = createEnsureSpaceAutoSwitch(deps)
    await ensure()
    expect(calls.some((c) => c.cmd === 'killall')).toBe(false)
    expect(audit).toHaveBeenCalledWith(
      'claude_notify.space_switch_failed',
      expect.objectContaining({ step: 'write' })
    )
    // memo 未置位 → 第二次仍会重试（再次 read）
    const before = calls.length
    await ensure()
    expect(calls.length).toBeGreaterThan(before)
  })

  it('runCommand throws → swallowed + audited, no throw to caller', async () => {
    const audit = vi.fn(async () => {})
    const deps: SpaceSwitchDeps = {
      runCommand: async () => {
        throw new Error('spawn ENOENT')
      },
      platform: 'darwin',
      audit,
      settleMs: 0
    }
    await expect(createEnsureSpaceAutoSwitch(deps)()).resolves.toBeUndefined()
    expect(audit).toHaveBeenCalledWith(
      'claude_notify.space_switch_failed',
      expect.objectContaining({ step: 'ensure' })
    )
  })
})
