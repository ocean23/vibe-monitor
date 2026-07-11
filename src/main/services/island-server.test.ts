import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { createIslandServer, type IslandServer } from './island-server'
import { IslandState } from './island-state'
import { ApprovalRegistry } from './island-approval'
import type { IslandConfig } from './island-config'
import type { AuditFn } from '../audit-log'

const config: IslandConfig = { port: 0, token: 'secret-token' } // port 0 → 随机端口

async function post(
  port: number,
  path: string,
  body: unknown,
  token?: string
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

describe('island-server', () => {
  let audit: Mock<AuditFn>
  let state: IslandState
  let registry: ApprovalRegistry
  let server: IslandServer

  beforeEach(async () => {
    audit = vi.fn<AuditFn>().mockResolvedValue(undefined)
    state = new IslandState({ audit, now: () => 1000 })
    registry = new ApprovalRegistry({ audit, now: () => 1000 })
    server = await createIslandServer({ config, state, registry, audit })
  })

  afterEach(async () => {
    await server.close()
    vi.restoreAllMocks()
  })

  it('binds to a port (loopback)', () => {
    expect(server.port).toBeGreaterThan(0)
  })

  it('rejects requests without a token (401)', async () => {
    const { status } = await post(server.port, '/event', { kind: 'Stop', session_id: 's1' })
    expect(status).toBe(401)
    expect(state.count()).toBe(0)
    expect(audit).toHaveBeenCalledWith('island.auth_rejected', expect.any(Object))
  })

  it('rejects requests with a wrong token (401)', async () => {
    const { status } = await post(
      server.port,
      '/event',
      { kind: 'Stop', session_id: 's1' },
      'wrong'
    )
    expect(status).toBe(401)
    expect(state.count()).toBe(0)
  })

  it('accepts /event with valid token and applies to state', async () => {
    const { status, json } = await post(
      server.port,
      '/event',
      { kind: 'PreToolUse', session_id: 's1', project_name: 'vibe-island' },
      'secret-token'
    )
    expect(status).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(state.count()).toBe(1)
    expect(state.list()[0]).toMatchObject({ sessionId: 's1', status: 'running' })
  })

  it('accepts SessionEnd and removes the session from state', async () => {
    await post(server.port, '/event', { kind: 'PreToolUse', session_id: 's1' }, 'secret-token')
    expect(state.count()).toBe(1)
    const { status, json } = await post(
      server.port,
      '/event',
      { kind: 'SessionEnd', session_id: 's1' },
      'secret-token'
    )
    expect(status).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(state.count()).toBe(0)
  })

  it('rejects invalid event kind (400) without polluting state', async () => {
    const { status } = await post(
      server.port,
      '/event',
      { kind: 'Bogus', session_id: 's1' },
      'secret-token'
    )
    expect(status).toBe(400)
    expect(state.count()).toBe(0)
  })

  it('rejects event missing session_id (400)', async () => {
    const { status } = await post(server.port, '/event', { kind: 'Stop' }, 'secret-token')
    expect(status).toBe(400)
  })

  it('/approval blocks until registry resolves, returns decision', async () => {
    registry.on('request', (req) => {
      // 模拟用户在岛内裁决
      registry.resolve(req.requestId, 'allow_once')
    })
    const { status, json } = await post(
      server.port,
      '/approval',
      { session_id: 's1', tool_name: 'Edit', tool_input: { file_path: 'a.ts' } },
      'secret-token'
    )
    expect(status).toBe(200)
    expect(json).toEqual({ ok: true, decision: 'allow_once' })
  })

  it('/approval returns "ask" when registry times out', async () => {
    registry.on('request', (req) => {
      // 不裁决，直接 drain 模拟超时回退
      registry.drain()
      void req
    })
    const { json } = await post(
      server.port,
      '/approval',
      { session_id: 's1', tool_name: 'Bash', tool_input: 'rm -rf x' },
      'secret-token'
    )
    expect(json.decision).toBe('ask')
  })

  it('returns 404 for unknown path', async () => {
    const { status } = await post(server.port, '/nope', {}, 'secret-token')
    expect(status).toBe(404)
  })

  it('returns 405 for non-POST', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/event`, {
      method: 'GET',
      headers: { authorization: 'Bearer secret-token' }
    })
    expect(res.status).toBe(405)
  })

  it('rejects requests once the per-second rate limit is exceeded (429)', async () => {
    const results = await Promise.all(
      Array.from({ length: 35 }, () =>
        post(server.port, '/event', { kind: 'PreToolUse', session_id: 's1' }, 'secret-token')
      )
    )
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(30)
    expect(statuses.some((s) => s === 429)).toBe(true)
  })

  it('rejects /approval once the pending cap is exceeded (429), without touching the registry', async () => {
    // 先堆到上限（全部不裁决，长期挂起）
    const pendingPromises = Array.from({ length: 20 }, (_, i) =>
      post(
        server.port,
        '/approval',
        { session_id: `s${i}`, tool_name: 'Bash', tool_input: 'x' },
        'secret-token'
      )
    )
    // 等这 20 个真正登记进 registry（HTTP 请求到达 + register 同步执行）
    await new Promise((r) => setTimeout(r, 50))
    expect(registry.pending().length).toBe(20)
    // 第 21 个应被立即拒绝，不进 registry
    const { status } = await post(
      server.port,
      '/approval',
      { session_id: 'over-cap', tool_name: 'Bash', tool_input: 'x' },
      'secret-token'
    )
    expect(status).toBe(429)
    expect(registry.pending().length).toBe(20)
    // 清理：drain 掉悬挂请求，避免残留计时器影响其它用例
    registry.drain()
    await Promise.all(pendingPromises)
  })

  it('clips over-long /event string fields before storing', async () => {
    const huge = 'x'.repeat(5000)
    await post(
      server.port,
      '/event',
      { kind: 'PreToolUse', session_id: 's1', project_name: huge, session_name: huge },
      'secret-token'
    )
    const s = state.list()[0]
    expect(s.projectName!.length).toBeLessThanOrEqual(500)
    expect(s.sessionName!.length).toBeLessThanOrEqual(500)
  })

  it('close() drains pending approvals without waiting for the 60s timeout', async () => {
    // 发起一个不会被裁决的 /approval；close() 应立刻让它以 ask 结掉
    const approvalPromise = post(
      server.port,
      '/approval',
      { session_id: 's1', tool_name: 'Bash', tool_input: 'sleep 999' },
      'secret-token'
    )
    // 等 registry 真正登记
    await new Promise((r) => setTimeout(r, 50))
    expect(registry.pending().length).toBe(1)
    const start = Date.now()
    await server.close()
    expect(Date.now() - start).toBeLessThan(2000) // 远小于 60s
    expect(registry.pending().length).toBe(0)
    const { json } = await approvalPromise
    expect(json.decision).toBe('ask')
    // afterEach 会再次 close()，幂等安全
  })
})
