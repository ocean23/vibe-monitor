import React, { useEffect, useMemo, useState } from 'react'
import { useIslandStore, selectMostUrgentStatus, STATUS_URGENCY } from '../store/island-store'
import { useSettingsStore } from '../store/settings-store'
import type { SessionState, SessionStatus } from '../../../shared/island-types'
import { IslandSessionCard } from '../components/IslandSessionCard'
import { IslandApprovalPanel } from '../components/IslandApprovalPanel'
import { IslandRunner } from '../components/IslandRunner'
import { useNotchInfo } from '../lib/use-notch-info'
import { useIslandSound } from '../lib/use-island-sound'
import { useIslandResize, ISLAND_SHELL_TRANSITION_MS } from '../lib/use-island-resize'
import { useMouseIgnore } from '../lib/use-mouse-ignore'

/** 排序：紧急度（waiting > error > running > done > idle）降序，同级按最近活跃倒序。 */
function sortSessions(sessions: SessionState[]): SessionState[] {
  return [...sessions].sort((a, b) => {
    const u = STATUS_URGENCY[b.status] - STATUS_URGENCY[a.status]
    return u !== 0 ? u : b.updatedAt - a.updatedAt
  })
}

/** 收起态 pill 各状态对应的文案（刘海机型省略文案，仅用状态色传达）。 */
const STATUS_LABEL_TEXT: Record<SessionStatus, string> = {
  waiting: '等待审批',
  error: '出错',
  running: 'Working…',
  done: '完成',
  idle: '空闲'
}

/**
 * 收起态最紧急状态 → pill 文案/样式。最紧急状态本身由 store 的 `selectMostUrgentStatus`
 * 统一裁决（与展开面板 `sortSessions` 共用同一份 `STATUS_URGENCY` 优先级），这里只做
 * 「状态 → 文案」的映射，不再重复判断优先级。
 */
function collapsedLabel(mostUrgent: SessionStatus | null): {
  text: string
  cls: SessionStatus | 'idle'
} {
  if (mostUrgent === null) return { text: '', cls: 'idle' }
  return { text: STATUS_LABEL_TEXT[mostUrgent], cls: mostUrgent }
}

/**
 * 灵动岛根组件（在独立置顶刘海窗口渲染，整个渲染端只有这一块）。
 *
 * 三种形态：
 * - 收起态：刘海居中 pill，展示会话数 + 最紧急状态
 * - hover 展开：聚合面板，列出所有活跃会话卡片（点击跳回终端）
 * - 审批态：收到 PreToolUse 审批请求时自动展开审批面板（优先级高于 hover）
 *
 * 刘海几何获取（useNotchInfo）、状态音效（useIslandSound）、窗口尺寸回传
 * （useIslandResize）、点击穿透（useMouseIgnore）拆成独立 hook，本组件只负责
 * 订阅 store + 组装渲染。
 */
export function IslandRoot(): React.ReactElement {
  const hydrate = useIslandStore((s) => s.hydrate)
  const subscribe = useIslandStore((s) => s.subscribe)
  const sessions = useIslandStore((s) => s.sessions)
  const pending = useIslandStore((s) => s.pending)
  const mostUrgent = useIslandStore(selectMostUrgentStatus)

  const hydrateSettings = useSettingsStore((s) => s.hydrate)
  const soundEnabled = useSettingsStore((s) => s.settings.islandSoundEnabled)
  const islandEnabled = useSettingsStore((s) => s.settings.islandEnabled)
  const trustAll = useSettingsStore((s) => s.settings.trustAll)
  const saveSettings = useSettingsStore((s) => s.save)

  const [hovered, setHovered] = useState(false)
  const { info: notchInfo, loaded: notchLoaded } = useNotchInfo()

  // 启动：加载数据 + 订阅推送 + 加载设置 + 订阅托盘设置变更
  useEffect(() => {
    void hydrate()
    void hydrateSettings()
    const unsub = subscribe()
    const offSettings = window.electronAPI?.onSettingsChanged?.((s) =>
      useSettingsStore.getState().applyExternal(s)
    )
    return () => {
      unsub()
      offSettings?.()
    }
  }, [hydrate, subscribe, hydrateSettings])

  useIslandSound(sessions, pending, soundEnabled)

  const hasApproval = pending.length > 0
  const expanded = hasApproval || hovered
  const sorted = useMemo(() => sortSessions(sessions), [sessions])

  // 「已持续时长 / 相对时间」的秒级滚动不再靠这里强制整树重渲，改由各卡片内的叶子组件
  // 订阅共享时钟（lib/use-now）自行刷新——卡片本体可安心 memo，时间又能动。
  const { contentRef, expandedWidth, expandedHeight } = useIslandResize({
    expanded,
    hasApproval,
    sorted,
    pending,
    notchInfo
  })

  useMouseIgnore(expanded)

  // islandEnabled=false：理论上主进程不会创建窗口；但若设置后未重启，渲染空内容
  if (islandEnabled === false) {
    return <div className="island-root" />
  }

  const label = collapsedLabel(mostUrgent)

  return (
    <div
      className={
        'island-root' +
        (expanded ? ' expanded' : ' collapsed') +
        (notchInfo && !notchInfo.hasNotch ? ' no-notch' : '')
      }
      style={{ ['--island-shell-ms' as string]: `${ISLAND_SHELL_TRANSITION_MS}ms` }}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className="island-shell"
        style={expanded ? { width: expandedWidth, height: expandedHeight } : undefined}
      >
        {/* notchLoaded 落地前不渲染 pill：避免先按非刘海布局（CSS 默认值）渲染、IPC 结果
            到位后几十毫秒再整体跳到刘海样式的可见跳动。非刘海机型 notchLoaded 变 true 后
            notchInfo 仍是 null，走 CSS 默认值渲染，行为不变。pill 常驻挂载（不再受 expanded
            条件门控），展开时只是这一层淡出，好让它与展开层 crossfade。 */}
        {notchLoaded && (
          <div className={'island-pill-layer' + (expanded ? ' is-hidden' : '')}>
            <div
              className={'island-pill ' + (notchInfo?.hasNotch ? 'notch ' : '') + label.cls}
              onMouseEnter={() => setHovered(true)}
            >
              <span className="island-pill-status">
                {label.cls === 'running' ? (
                  <IslandRunner />
                ) : (
                  <span className="island-pill-dot" aria-hidden="true" />
                )}
                {/* 刘海黑条空间有限，省略文案标签，状态色足以传达信息 */}
                {!notchInfo?.hasNotch && label.text && (
                  <span className="island-pill-label">{label.text}</span>
                )}
              </span>
              <span className="island-pill-count">{sessions.length} sessions</span>
            </div>
          </div>
        )}

        {/* 展开层同样常驻挂载（会话面板 / 审批面板视 hasApproval 二选一渲染，谁都不因
            collapsed 而卸载），收起时整层淡出、与 pill 层 crossfade。 */}
        <div className={'island-expanded-layer' + (expanded ? '' : ' is-hidden')} ref={contentRef}>
          {/* 展开态刘海占位：顶部透明区域（高=刘海高），让面板从刘海正下方弹出 */}
          {notchInfo?.hasNotch && <div className="island-notch-spacer" aria-hidden="true" />}

          {hasApproval ? (
            <IslandApprovalPanel request={pending[0]} />
          ) : (
            <div className="island-panel" onMouseEnter={() => setHovered(true)}>
              <div className="island-panel-head">
                <span className="island-panel-title">Claude</span>
                <span className="island-panel-count">{sessions.length} sessions</span>
              </div>
              <div className="island-panel-list">
                {sorted.length === 0 ? (
                  <div className="island-panel-empty">暂无活跃会话</div>
                ) : (
                  sorted.map((s) => <IslandSessionCard key={s.sessionId} session={s} />)
                )}
              </div>
              <div className="island-panel-footer">
                <button
                  className={'island-toggle' + (trustAll ? ' on' : '')}
                  onClick={() => void saveSettings({ trustAll: !trustAll })}
                  title={trustAll ? '已跳过所有审批（点击关闭）' : '点击开启：跳过所有审批'}
                >
                  <span className="island-toggle-track">
                    <span className="island-toggle-thumb" />
                  </span>
                  <span className="island-toggle-label">跳过审批</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
