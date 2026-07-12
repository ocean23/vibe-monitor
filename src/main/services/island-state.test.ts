import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest'
import { IslandState, classifyNotification } from './island-state'
import type { IslandHookEvent } from '../../shared/island-types'
import type { AuditFn } from '../audit-log'

function evt(partial: Partial<IslandHookEvent> & Pick<IslandHookEvent, 'kind'>): IslandHookEvent {
  return { session_id: 's1', ...partial }
}

/** 真·授权请求的 Notification message（取自 Claude Code 实测），分类为 permission → waiting。 */
const PERM_MSG = 'Claude needs permission to use Bash'

describe('island-state', () => {
  let audit: Mock<AuditFn>
  let clock: number
  let state: IslandState

  beforeEach(() => {
    audit = vi.fn<AuditFn>().mockResolvedValue(undefined)
    clock = 1000
    state = new IslandState({ audit, now: () => clock })
  })

  describe('status mapping', () => {
    it('SessionStart → idle (停在输入框，非执行态)', () => {
      state.applyEvent(evt({ kind: 'SessionStart' }))
      expect(state.list()[0].status).toBe('idle')
    })

    it('UserPromptSubmit → running', () => {
      state.applyEvent(evt({ kind: 'UserPromptSubmit' }))
      expect(state.list()[0].status).toBe('running')
    })

    it('PreToolUse → running', () => {
      state.applyEvent(evt({ kind: 'PreToolUse' }))
      expect(state.list()[0].status).toBe('running')
    })

    it('Notification(授权请求) → waiting（真·等待审批）', () => {
      state.applyEvent(evt({ kind: 'Notification', last_message: PERM_MSG }))
      expect(state.list()[0].status).toBe('waiting')
    })

    it('Notification(needs your permission 变体) → waiting', () => {
      state.applyEvent(
        evt({ kind: 'Notification', last_message: 'Claude needs your permission to use Update' })
      )
      expect(state.list()[0].status).toBe('waiting')
    })

    it('Notification(空闲等待输入) → idle，而非误报 waiting', () => {
      state.applyEvent(
        evt({ kind: 'Notification', last_message: 'Claude is waiting for your input' })
      )
      expect(state.list()[0].status).toBe('idle')
    })

    it('Notification(worktree 信息通知) 不凭空标 waiting：无前态落 idle', () => {
      state.applyEvent(
        evt({ kind: 'Notification', last_message: 'Created worktree at /tmp/wt on branch x' })
      )
      expect(state.list()[0].status).toBe('idle')
    })

    it('Notification(信息通知) 保留 running 前态（绝不把执行中会话翻成 waiting/idle）', () => {
      state.applyEvent(evt({ kind: 'UserPromptSubmit' })) // running
      state.applyEvent(
        evt({ kind: 'Notification', last_message: 'Exited worktree. Your work is preserved.' })
      )
      expect(state.list()[0].status).toBe('running')
    })

    it('Notification(空 message) 归 other：无前态落 idle，不误报 waiting', () => {
      state.applyEvent(evt({ kind: 'Notification' }))
      expect(state.list()[0].status).toBe('idle')
    })

    it('Stop → done (carries stop_reason)', () => {
      state.applyEvent(evt({ kind: 'Stop', stop_reason: 'end_turn' }))
      const s = state.list()[0]
      expect(s.status).toBe('done')
      if (s.status !== 'done') throw new Error('unreachable')
      expect(s.stopReason).toBe('end_turn')
    })

    it('Notification after Stop keeps done (防止任务完成通知把会话拉回 waiting)', () => {
      // Stop 先到 → done；随后 Claude Code 发桌面通知触发 Notification → 不应退回 waiting
      state.applyEvent(evt({ kind: 'Stop' }))
      expect(state.list()[0].status).toBe('done')
      // 即便是「授权请求」措辞的通知，已 done 的会话也不被拉回 waiting（done/error 护栏）
      state.applyEvent(evt({ kind: 'Notification', last_message: PERM_MSG }))
      expect(state.list()[0].status).toBe('done')
    })

    it('Notification after error keeps error (同理)', () => {
      state.applyEvent(evt({ kind: 'Stop', stop_reason: 'error' }))
      // 手动设为 error 状态（暂无 error 专用 hook，直接写内部字段验证保护逻辑）
      const s = state.list()[0]
      Object.assign(s, { status: 'error' })
      ;(state as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', {
        ...state.list()[0],
        status: 'error'
      })
      state.applyEvent(evt({ kind: 'Notification' }))
      expect(state.list()[0].status).toBe('error')
    })

    it('PreToolUse after Stop does not revive the session (静态映射事件此前唯一遗漏终态守卫的入口)', () => {
      state.applyEvent(evt({ kind: 'Stop' }))
      expect(state.list()[0].status).toBe('done')
      // 迟到的 PreToolUse（如子进程收尾时序竞态）不得把已结束会话拉回 running
      state.applyEvent(evt({ kind: 'PreToolUse' }))
      expect(state.list()[0].status).toBe('done')
    })

    it('UserPromptSubmit after Stop DOES revive the session (新一轮用户输入，非迟到事件)', () => {
      // Stop 是「本轮结束」而非「会话结束」——同一 session_id 在一次 Claude Code 交互式会话里
      // 会反复经历 Stop → 用户再发消息 → Stop → ...。UserPromptSubmit 是用户明确发起的新动作，
      // 不可能是上一轮的迟到噪声，必须无条件解除终态锁，否则卡片从第二轮起永久卡在「完成」。
      state.applyEvent(evt({ kind: 'Stop' }))
      expect(state.list()[0].status).toBe('done')
      state.applyEvent(evt({ kind: 'UserPromptSubmit' }))
      expect(state.list()[0].status).toBe('running')
    })

    it('SessionStart after Stop does not revive the session', () => {
      state.applyEvent(evt({ kind: 'Stop' }))
      state.applyEvent(evt({ kind: 'SessionStart' }))
      expect(state.list()[0].status).toBe('done')
    })

    it('a fresh Stop without stop_reason does not fall back to the previous round’s reason (跨轮次残留)', () => {
      state.applyEvent(evt({ kind: 'Stop', stop_reason: 'end_turn' }))
      // 同一 session_id 复用（如 resume）→ 新一轮 UserPromptSubmit 之后再次 Stop，这次没带 reason
      state.applyEvent(evt({ kind: 'SessionStart' }))
      state.applyEvent(evt({ kind: 'Stop' }))
      const s = state.list()[0]
      expect(s.status).toBe('done')
      if (s.status !== 'done') throw new Error('unreachable')
      expect(s.stopReason).toBeUndefined()
    })

    it('a stray non-Stop event after done preserves the prior stop_reason (不被迟到事件清空)', () => {
      state.applyEvent(evt({ kind: 'Stop', stop_reason: 'end_turn' }))
      state.applyEvent(evt({ kind: 'PreToolUse' })) // 迟到事件被守卫拦下，status 仍是 done
      const s = state.list()[0]
      expect(s.status).toBe('done')
      if (s.status !== 'done') throw new Error('unreachable')
      expect(s.stopReason).toBe('end_turn')
    })
  })

  describe('SessionEnd (退出即清)', () => {
    it('removes an existing session immediately and emits change', () => {
      state.applyEvent(evt({ kind: 'UserPromptSubmit' })) // running
      const spy = vi.fn()
      state.on('change', spy)
      state.applyEvent(evt({ kind: 'SessionEnd' }))
      expect(state.count()).toBe(0)
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('removes regardless of running state (does not need stale downgrade first)', () => {
      state.applyEvent(evt({ kind: 'PreToolUse' })) // running
      expect(state.list()[0].status).toBe('running')
      state.applyEvent(evt({ kind: 'SessionEnd' }))
      expect(state.count()).toBe(0)
    })

    it('is a silent no-op for an unknown session (no change emitted)', () => {
      const spy = vi.fn()
      state.on('change', spy)
      state.applyEvent({ kind: 'SessionEnd', session_id: 'ghost' })
      expect(spy).not.toHaveBeenCalled()
      expect(state.count()).toBe(0)
    })

    it('drops SessionEnd without session_id and audits (no removal path entered)', () => {
      state.applyEvent({ kind: 'SessionEnd', session_id: '' })
      expect(audit).toHaveBeenCalledWith('island.event_missing_session', { kind: 'SessionEnd' })
    })

    it('re-creates the session if an event arrives after SessionEnd', () => {
      state.applyEvent(evt({ kind: 'UserPromptSubmit' }))
      state.applyEvent(evt({ kind: 'SessionEnd' }))
      expect(state.count()).toBe(0)
      state.applyEvent(evt({ kind: 'SessionStart' })) // 同 id 复用（如 resume）→ 重新创建
      expect(state.count()).toBe(1)
      expect(state.list()[0].status).toBe('idle')
    })

    it('only removes the matching session, leaving others intact', () => {
      state.applyEvent({ kind: 'PreToolUse', session_id: 'a' })
      state.applyEvent({ kind: 'Notification', session_id: 'b' })
      state.applyEvent({ kind: 'SessionEnd', session_id: 'a' })
      expect(state.count()).toBe(1)
      expect(state.list()[0].sessionId).toBe('b')
    })
  })

  it('drops events without session_id and audits', () => {
    state.applyEvent({ kind: 'PreToolUse', session_id: '' })
    expect(state.count()).toBe(0)
    expect(audit).toHaveBeenCalledWith('island.event_missing_session', { kind: 'PreToolUse' })
  })

  it('merges fields across events, keeping prior values when absent', () => {
    state.applyEvent(
      evt({ kind: 'SessionStart', project_name: 'vibe-island', session_name: 'demo' })
    )
    state.applyEvent(evt({ kind: 'PreToolUse' })) // 不带 project/session
    const s = state.list()[0]
    expect(s.projectName).toBe('vibe-island')
    expect(s.sessionName).toBe('demo')
    expect(s.status).toBe('running')
  })

  it('isolates multiple sessions', () => {
    state.applyEvent({ kind: 'PreToolUse', session_id: 'a', project_name: 'pa' })
    state.applyEvent({
      kind: 'Notification',
      session_id: 'b',
      project_name: 'pb',
      last_message: PERM_MSG
    })
    expect(state.count()).toBe(2)
    const a = state.list().find((s) => s.sessionId === 'a')
    const b = state.list().find((s) => s.sessionId === 'b')
    expect(a?.status).toBe('running')
    expect(b?.status).toBe('waiting')
  })

  it('lists sessions by updatedAt desc', () => {
    clock = 100
    state.applyEvent({ kind: 'PreToolUse', session_id: 'old' })
    clock = 200
    state.applyEvent({ kind: 'PreToolUse', session_id: 'new' })
    expect(state.list().map((s) => s.sessionId)).toEqual(['new', 'old'])
  })

  it('uses event.ts when provided, else clock', () => {
    state.applyEvent(evt({ kind: 'PreToolUse', ts: 555 }))
    expect(state.list()[0].updatedAt).toBe(555)
    clock = 777
    state.applyEvent({ kind: 'PreToolUse', session_id: 's2' })
    expect(state.list().find((s) => s.sessionId === 's2')?.updatedAt).toBe(777)
  })

  describe('updateLastMessage', () => {
    it('updates lastMessage only for existing session', () => {
      state.applyEvent(evt({ kind: 'PreToolUse' }))
      state.updateLastMessage('s1', 'hello world')
      expect(state.list()[0].lastMessage).toBe('hello world')
    })

    it('ignores unknown session (does not create one)', () => {
      state.updateLastMessage('ghost', 'x')
      expect(state.count()).toBe(0)
    })

    it('no-op when message unchanged (no extra change event)', () => {
      state.applyEvent(evt({ kind: 'PreToolUse', last_message: 'same' }))
      const changeSpy = vi.fn()
      state.on('change', changeSpy)
      state.updateLastMessage('s1', 'same')
      expect(changeSpy).not.toHaveBeenCalled()
    })
  })

  describe('markActive (transcript 活跃心跳)', () => {
    it('revives idle → running and refreshes updatedAt（消除长思考期误报空闲）', () => {
      clock = 1000
      state.applyEvent(evt({ kind: 'SessionStart' })) // idle @1000
      clock = 5000
      state.markActive('s1')
      const s = state.list()[0]
      expect(s.status).toBe('running')
      expect(s.updatedAt).toBe(5000)
    })

    it('keeps running and refreshes updatedAt（续命）', () => {
      clock = 1000
      state.applyEvent(evt({ kind: 'PreToolUse' })) // running @1000
      clock = 5000
      state.markActive('s1')
      expect(state.list()[0].status).toBe('running')
      expect(state.list()[0].updatedAt).toBe(5000)
    })

    it('does not revive done; leaves updatedAt（Stop 后迟到的 transcript 写入不复活）', () => {
      clock = 1000
      state.applyEvent(evt({ kind: 'Stop' })) // done @1000
      clock = 5000
      state.markActive('s1')
      const s = state.list()[0]
      expect(s.status).toBe('done')
      expect(s.updatedAt).toBe(1000)
    })

    it('preserves waiting on model-only activity, NOT refreshing updatedAt（留 sweepStale 兜底）', () => {
      clock = 1000
      state.applyEvent(evt({ kind: 'Notification', last_message: PERM_MSG })) // waiting @1000
      clock = 5000
      state.markActive('s1') // userActivity 默认 false：思考/正文/tool_use 等模型侧产出
      const s = state.list()[0]
      expect(s.status).toBe('waiting')
      expect(s.updatedAt).toBe(1000) // 未刷新
    })

    it('clears waiting → running on user activity（用户已回答/授权，模型恢复）', () => {
      clock = 1000
      state.applyEvent(evt({ kind: 'Notification', last_message: PERM_MSG })) // waiting @1000
      clock = 5000
      state.markActive('s1', true) // tool_result / 回答 → 用户侧产出
      const s = state.list()[0]
      expect(s.status).toBe('running')
      expect(s.updatedAt).toBe(5000)
    })

    it('AskUserQuestion 全流程：待答期保持 waiting，用户回答后即时转 running', () => {
      // 模型抛出问题 → Notification 置 waiting
      clock = 1000
      state.applyEvent(evt({ kind: 'Notification', last_message: PERM_MSG })) // waiting
      // 触发问题的 tool_use 行被 watcher 读到（模型侧，userActivity=false）：不得误清 waiting（入场竞态防护）
      clock = 1010
      state.markActive('s1', false)
      expect(state.list()[0].status).toBe('waiting')
      // 待答期模型静默；即便很久也保持 waiting（updatedAt 不被模型侧刷新）
      expect(state.list()[0].updatedAt).toBe(1000)
      // 用户回答（tool_result，userActivity=true）：即时转 running（不必等 8 分钟思考后的 PreToolUse）
      clock = 180_000
      state.markActive('s1', true)
      expect(state.list()[0].status).toBe('running')
      expect(state.list()[0].updatedAt).toBe(180_000)
    })

    it('ignores unknown session (does not create one)', () => {
      state.markActive('ghost')
      expect(state.count()).toBe(0)
    })

    it('idempotent at same tick on a running session (no extra change)', () => {
      clock = 1000
      state.applyEvent(evt({ kind: 'PreToolUse' })) // running @1000
      const spy = vi.fn()
      state.on('change', spy)
      state.markActive('s1') // 同 tick、同态 → 无变更
      expect(spy).not.toHaveBeenCalled()
      expect(state.list()[0].status).toBe('running')
    })

    it('emits change on revive', () => {
      clock = 1000
      state.applyEvent(evt({ kind: 'SessionStart' })) // idle
      const spy = vi.fn()
      state.on('change', spy)
      clock = 2000
      state.markActive('s1')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(state.list()[0].status).toBe('running')
    })

    it('spares a long-silent running session from stale downgrade', () => {
      const stale = new IslandState({ audit, now: () => clock, staleMs: 1000 })
      clock = 1000
      stale.applyEvent(evt({ kind: 'PreToolUse' })) // running @1000
      clock = 1900
      stale.markActive('s1') // transcript 心跳刷新到 1900
      clock = 1900 + 500 // 距上次活跃仅 500ms < staleMs
      stale.sweepStale()
      expect(stale.list()[0].status).toBe('running')
    })
  })

  describe('change events', () => {
    it('emits change on applyEvent with latest list', () => {
      const spy = vi.fn()
      state.on('change', spy)
      state.applyEvent(evt({ kind: 'PreToolUse' }))
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0]).toHaveLength(1)
    })

    it('emits change on remove', () => {
      state.applyEvent(evt({ kind: 'PreToolUse' }))
      const spy = vi.fn()
      state.on('change', spy)
      state.remove('s1')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(state.count()).toBe(0)
    })

    it('remove of unknown session emits nothing', () => {
      const spy = vi.fn()
      state.on('change', spy)
      state.remove('ghost')
      expect(spy).not.toHaveBeenCalled()
    })
  })

  describe('sweepStale (running 陈旧降级)', () => {
    let stale: IslandState

    beforeEach(() => {
      // staleMs=1000：clock 推进超过 1000ms 即陈旧
      stale = new IslandState({ audit, now: () => clock, staleMs: 1000 })
    })

    it('downgrades a stale running session to idle and emits change', () => {
      clock = 1000
      stale.applyEvent(evt({ kind: 'PreToolUse' })) // running @1000
      const spy = vi.fn()
      stale.on('change', spy)
      clock = 1000 + 1001 // 超过 staleMs
      stale.sweepStale()
      expect(stale.list()[0].status).toBe('idle')
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('does not touch a fresh running session (no change emitted)', () => {
      clock = 1000
      stale.applyEvent(evt({ kind: 'PreToolUse' }))
      const spy = vi.fn()
      stale.on('change', spy)
      clock = 1000 + 500 // 未到 staleMs
      stale.sweepStale()
      expect(stale.list()[0].status).toBe('running')
      expect(spy).not.toHaveBeenCalled()
    })

    it('downgrades running and waiting (leaves done/idle untouched)', () => {
      clock = 1000
      stale.applyEvent({ kind: 'Notification', session_id: 'w', last_message: PERM_MSG }) // waiting
      stale.applyEvent({ kind: 'Stop', session_id: 'd' }) // done
      stale.applyEvent({ kind: 'SessionStart', session_id: 'i' }) // idle
      clock = 1000 + 5000
      stale.sweepStale()
      const by = (id: string): string | undefined =>
        stale.list().find((s) => s.sessionId === id)?.status
      // waiting 与 running 同等处理：陈旧后降级为 idle（不直接删除）
      expect(by('w')).toBe('idle')
      expect(by('d')).toBe('done')
      expect(by('i')).toBe('idle')
    })

    it('keeps updatedAt unchanged on downgrade (idempotent on re-sweep)', () => {
      clock = 1000
      stale.applyEvent(evt({ kind: 'PreToolUse' })) // updatedAt=1000
      clock = 1000 + 2000
      stale.sweepStale()
      expect(stale.list()[0].updatedAt).toBe(1000) // 不被刷新
      const spy = vi.fn()
      stale.on('change', spy)
      stale.sweepStale() // 二次扫描：已是 idle，无变更
      expect(spy).not.toHaveBeenCalled()
    })

    it('updateLastMessage refreshes updatedAt, sparing an active session', () => {
      clock = 1000
      stale.applyEvent(evt({ kind: 'PreToolUse' })) // running @1000
      clock = 1000 + 800
      stale.updateLastMessage('s1', 'still producing') // 刷新 updatedAt=1800
      clock = 1800 + 500 // 距上次活动仅 500ms < staleMs
      stale.sweepStale()
      expect(stale.list()[0].status).toBe('running')
    })
  })

  describe('sweepStale (过期移除遗弃会话)', () => {
    let gc: IslandState

    beforeEach(() => {
      // staleMs=1000（running→idle）、expireMs=5000（非 running 过期移除）
      gc = new IslandState({ audit, now: () => clock, staleMs: 1000, expireMs: 5000 })
    })

    it('removes a non-running session older than expireMs and emits change', () => {
      clock = 1000
      gc.applyEvent({ kind: 'Stop', session_id: 'd' }) // done @1000
      const spy = vi.fn()
      gc.on('change', spy)
      clock = 1000 + 5001
      gc.sweepStale()
      expect(gc.count()).toBe(0)
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('keeps a non-running session still within expireMs', () => {
      clock = 1000
      gc.applyEvent({ kind: 'Notification', session_id: 'w', last_message: PERM_MSG }) // waiting @1000
      clock = 1000 + 3000 // < expireMs
      gc.sweepStale()
      expect(gc.count()).toBe(1)
    })

    it('never removes a running session past expireMs (downgrades to idle first, removes next sweep)', () => {
      clock = 1000
      gc.applyEvent(evt({ kind: 'PreToolUse' })) // running @1000
      clock = 1000 + 6000 // > expireMs 且 > staleMs
      gc.sweepStale()
      expect(gc.count()).toBe(1) // 本趟只降级、不删除
      expect(gc.list()[0].status).toBe('idle')
      gc.sweepStale() // 已是 idle 且仍 > expireMs → 过期移除
      expect(gc.count()).toBe(0)
    })

    it('expires idle / done alike; waiting first downgrades to idle, then expires next sweep', () => {
      clock = 1000
      gc.applyEvent({ kind: 'SessionStart', session_id: 'i' }) // idle
      gc.applyEvent({ kind: 'Stop', session_id: 'd' }) // done
      gc.applyEvent({ kind: 'Notification', session_id: 'w', last_message: PERM_MSG }) // waiting
      clock = 1000 + 6000
      gc.sweepStale() // idle/done 直接过期删除；waiting 先降级为 idle
      expect(gc.count()).toBe(1) // 仅剩被降级的 'w'（现 idle）
      expect(gc.list()[0].sessionId).toBe('w')
      gc.sweepStale() // 'w' 现在是 idle 且超过 expireMs → 移除
      expect(gc.count()).toBe(0)
    })

    it('re-creates a session if an event arrives after expiry', () => {
      clock = 1000
      gc.applyEvent({ kind: 'Stop', session_id: 's1' })
      clock = 1000 + 6000
      gc.sweepStale()
      expect(gc.count()).toBe(0)
      gc.applyEvent(evt({ kind: 'UserPromptSubmit' })) // s1 再次出现
      expect(gc.count()).toBe(1)
      expect(gc.list()[0].status).toBe('running')
    })
  })

  describe('eviction (memory bound)', () => {
    it('caps sessions at 200, evicting the oldest by updatedAt', () => {
      for (let i = 0; i < 205; i++) {
        clock = 1000 + i
        state.applyEvent({ kind: 'PreToolUse', session_id: `s${i}` })
      }
      expect(state.count()).toBe(200)
      // 最旧的 s0..s4 应被驱逐，最新的保留
      const ids = new Set(state.list().map((s) => s.sessionId))
      expect(ids.has('s0')).toBe(false)
      expect(ids.has('s4')).toBe(false)
      expect(ids.has('s204')).toBe(true)
    })
  })
})

describe('classifyNotification', () => {
  // 取自 Claude Code 实测 message（含同一仓 ~/.claude 出现的两种授权措辞）
  it('授权请求 → permission（两种措辞 + 中英混排都命中）', () => {
    expect(classifyNotification('Claude needs permission to use Bash')).toBe('permission')
    expect(classifyNotification('Claude needs your permission to use Update')).toBe('permission')
    expect(classifyNotification('等待操作确认\nClaude needs your permission to use Update')).toBe(
      'permission'
    )
  })

  it('空闲等待输入 → idle', () => {
    expect(classifyNotification('Claude is waiting for your input')).toBe('idle')
  })

  it('worktree / 信息类通知 → other', () => {
    expect(
      classifyNotification(
        'Created worktree at /Users/x/.claude/worktrees/foo on branch worktree-foo. The session is now working in the worktree.'
      )
    ).toBe('other')
    expect(
      classifyNotification(
        'Exited worktree. Your work is preserved at /Users/x/.claude/worktrees/foo'
      )
    ).toBe('other')
  })

  it('空 / undefined → other（安全方向：识别不到绝不报 waiting）', () => {
    expect(classifyNotification(undefined)).toBe('other')
    expect(classifyNotification('')).toBe('other')
    expect(classifyNotification('Some unrelated notification')).toBe('other')
  })
})
