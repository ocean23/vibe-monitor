import { useEffect, useRef } from 'react'
import type { SessionState, SessionStatus, ApprovalRequest } from '../../../shared/island-types'
import { playStatusSound } from './island-sound'

/**
 * 会话状态切换为 waiting/done/error 时、以及新审批到达时播放 8-bit 音效（托盘可关）。
 * 两类触发共用同一个 `playStatusSound`：状态切换按逐会话前后态比对；新审批到达单独按
 * 队列长度增长判定（即便没有对应会话状态翻转，如同会话连续两次 PreToolUse 审批）。
 */
export function useIslandSound(
  sessions: SessionState[],
  pending: ApprovalRequest[],
  soundEnabled: boolean | undefined
): void {
  const prevStatusRef = useRef<Map<string, SessionStatus>>(new Map())
  useEffect(() => {
    const prev = prevStatusRef.current
    const next = new Map<string, SessionStatus>()
    for (const s of sessions) {
      next.set(s.sessionId, s.status)
      const was = prev.get(s.sessionId)
      if (
        was !== s.status &&
        (s.status === 'waiting' || s.status === 'done' || s.status === 'error')
      ) {
        playStatusSound(s.status, soundEnabled !== false)
      }
    }
    prevStatusRef.current = next
  }, [sessions, soundEnabled])

  const prevPendingCount = useRef(0)
  useEffect(() => {
    if (pending.length > prevPendingCount.current) {
      playStatusSound('waiting', soundEnabled !== false)
    }
    prevPendingCount.current = pending.length
  }, [pending.length, soundEnabled])
}
