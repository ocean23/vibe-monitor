import { describe, it, expect, beforeEach } from 'vitest'
import {
  useIslandStore,
  selectSessionCount,
  selectMostUrgentStatus,
  selectStatusCounts
} from './island-store'
import type { SessionState, ApprovalRequest } from '../../../shared/island-types'

function sess(id: string, status: SessionState['status'], updatedAt = 1000): SessionState {
  return { sessionId: id, status, updatedAt }
}

function req(id: string): ApprovalRequest {
  return {
    requestId: id,
    sessionId: 's1',
    toolName: 'Edit',
    toolInput: '{}',
    requestedAt: 1000,
    timeoutMs: 60000
  }
}

describe('island-store reducers', () => {
  beforeEach(() => {
    useIslandStore.setState({ sessions: [], pending: [], hydrated: false, subscribed: false })
  })

  it('setSessions replaces the list', () => {
    useIslandStore.getState().setSessions([sess('a', 'running')])
    expect(useIslandStore.getState().sessions).toHaveLength(1)
  })

  it('pushApproval appends and dedupes by requestId', () => {
    const s = useIslandStore.getState()
    s.pushApproval(req('r1'))
    s.pushApproval(req('r1')) // dup
    s.pushApproval(req('r2'))
    expect(useIslandStore.getState().pending.map((p) => p.requestId)).toEqual(['r1', 'r2'])
  })

  it('removeApproval drops the matching request', () => {
    const s = useIslandStore.getState()
    s.pushApproval(req('r1'))
    s.pushApproval(req('r2'))
    s.removeApproval('r1')
    expect(useIslandStore.getState().pending.map((p) => p.requestId)).toEqual(['r2'])
  })
})

describe('island-store selectors', () => {
  it('selectSessionCount counts sessions', () => {
    const state = { sessions: [sess('a', 'running'), sess('b', 'done')] } as ReturnType<
      typeof useIslandStore.getState
    >
    expect(selectSessionCount(state)).toBe(2)
  })

  it('selectMostUrgentStatus prioritizes waiting > error > running > done', () => {
    const make = (statuses: SessionState['status'][]) =>
      ({ sessions: statuses.map((s, i) => sess(`s${i}`, s)) }) as ReturnType<
        typeof useIslandStore.getState
      >
    expect(selectMostUrgentStatus(make(['running', 'done', 'waiting']))).toBe('waiting')
    expect(selectMostUrgentStatus(make(['running', 'error', 'done']))).toBe('error')
    expect(selectMostUrgentStatus(make(['running', 'done']))).toBe('running')
    expect(selectMostUrgentStatus(make(['done']))).toBe('done')
    expect(selectMostUrgentStatus(make([]))).toBeNull()
  })

  it('selectStatusCounts tallies each status', () => {
    const state = {
      sessions: [sess('a', 'running'), sess('b', 'running'), sess('c', 'waiting')]
    } as ReturnType<typeof useIslandStore.getState>
    expect(selectStatusCounts(state)).toEqual({
      idle: 0,
      running: 2,
      waiting: 1,
      done: 0,
      error: 0
    })
  })
})
