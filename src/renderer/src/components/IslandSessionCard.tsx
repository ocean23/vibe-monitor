import React, { useCallback } from 'react'
import type { SessionState, SessionStatus } from '../../../shared/island-types'
import { useIslandStore } from '../store/island-store'
import { useNow } from '../lib/use-now'

const STATUS_META: Record<SessionStatus, { icon: string; label: string; cls: string }> = {
  idle: { icon: '○', label: '空闲', cls: 'idle' },
  running: { icon: '●', label: '运行中', cls: 'running' },
  waiting: { icon: '◆', label: '等待中', cls: 'waiting' },
  done: { icon: '✓', label: '完成', cls: 'done' },
  error: { icon: '✕', label: '出错', cls: 'error' }
}

/** 相对时间（上次活跃）。纯函数，`now` 由调用方传入，便于复用共享时钟。 */
function relTime(ts: number, now: number): string {
  if (!Number.isFinite(ts)) return ''
  const delta = Math.max(0, now - ts)
  if (delta < 60_000) return '刚刚'
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m`
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))}h`
  return `${Math.floor(delta / (24 * 60 * 60_000))}d`
}

/**
 * 已持续时长（now - startedAt）→ 紧凑文案：`45s` / `12m` / `4h33m` / `2d3h`。
 * 与 relTime（上次活跃）刻意不同：这里量「会话从开始到现在多久」。`now` 由调用方传入。
 */
function fmtDuration(startedAt: number | undefined, now: number): string {
  if (startedAt === undefined || !Number.isFinite(startedAt)) return ''
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) {
    const m = min % 60
    return m ? `${hr}h${m}m` : `${hr}h`
  }
  const day = Math.floor(hr / 24)
  const h = hr % 24
  return h ? `${day}d${h}h` : `${day}d`
}

/**
 * 时间相关的叶子组件——只有它们订阅共享时钟（useNow）按秒重渲，卡片本体不订阅时钟，
 * 因而可安心 React.memo：每条 IPC 推送只重渲「真正变了的」卡片，秒级刷新也只重渲这几个
 * <span>，而非整棵卡片树。
 */
const RelTime = React.memo(function RelTime({ ts }: { ts: number }): React.ReactElement {
  const now = useNow()
  return <>{relTime(ts, now)}</>
})

const DurationTag = React.memo(function DurationTag({
  startedAt
}: {
  startedAt?: number
}): React.ReactElement | null {
  const now = useNow()
  const duration = fmtDuration(startedAt, now)
  if (!duration) return null
  return (
    <span className="island-tag dur" title={`已持续 ${duration}`}>
      <span className="island-tag-clock" aria-hidden="true">
        ◷
      </span>{' '}
      {duration}
    </span>
  )
})

interface Props {
  session: SessionState
}

/**
 * 灵动岛 hover 聚合面板中的单会话卡片（FR-005）。
 * 展示项目 / 会话 / 状态 / 最后消息 / 相对时间，以及标签行：模型 · 终端 · 已持续时长 · 状态；
 * 点击调 openSession 精准跳回 Ghostty 对应 tab（FR-006）。
 *
 * 包 React.memo：主进程 state.list() 对「未变的会话」复用同一对象引用，故一次广播里
 * 只有真正变动的卡片会重渲（其余被 memo 短路）。时间滚动交给内部叶子组件，见上。
 */
function IslandSessionCardInner({ session }: Props): React.ReactElement {
  const openSession = useIslandStore((s) => s.openSession)
  const meta = STATUS_META[session.status]

  const onClick = useCallback(() => {
    void openSession(session.sessionId)
  }, [openSession, session.sessionId])

  const model = session.model || 'Claude'
  const terminal = session.terminal || 'Ghostty'

  return (
    <button
      type="button"
      className="island-card"
      onClick={onClick}
      title="点击跳回终端会话"
      aria-label={`跳回 ${session.projectName || '未知项目'} 会话（${meta.label}）`}
    >
      <span className={'island-card-dot ' + meta.cls} aria-hidden="true">
        {meta.icon}
      </span>
      <span className="island-card-main">
        <span className="island-card-head">
          <span className="island-card-project">{session.projectName || '(未知项目)'}</span>
          {session.sessionName && (
            <span className="island-card-session">· {session.sessionName}</span>
          )}
          <span className="island-card-time">
            <RelTime ts={session.updatedAt} />
          </span>
        </span>
        <span className="island-card-msg">{session.lastMessage || meta.label}</span>
        <span className="island-card-tags">
          <span className="island-tag model">{model}</span>
          <span className="island-tag ghost">{terminal}</span>
          <DurationTag startedAt={session.startedAt} />
          <span className={'island-tag status ' + meta.cls}>{meta.label}</span>
        </span>
      </span>
      <span className="island-card-jump" aria-hidden="true">
        ↗
      </span>
    </button>
  )
}

export const IslandSessionCard = React.memo(IslandSessionCardInner)
