import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useIslandStore, selectStatusCounts, STATUS_URGENCY } from '../store/island-store'
import { useSettingsStore } from '../store/settings-store'
import type { SessionState, SessionStatus } from '../../../shared/island-types'
import { IslandSessionCard } from '../components/IslandSessionCard'
import { IslandApprovalPanel } from '../components/IslandApprovalPanel'
import { IslandRunner } from '../components/IslandRunner'
import { playStatusSound } from '../lib/island-sound'

/** 非刘海机型的降级尺寸 */
const COLLAPSED_FALLBACK = { width: 520, height: 46 }
const PANEL_WIDTH = 640
const APPROVAL_WIDTH = 560

/** 排序：紧急度（waiting > error > running > done > idle）降序，同级按最近活跃倒序。 */
function sortSessions(sessions: SessionState[]): SessionState[] {
  return [...sessions].sort((a, b) => {
    const u = STATUS_URGENCY[b.status] - STATUS_URGENCY[a.status]
    return u !== 0 ? u : b.updatedAt - a.updatedAt
  })
}

/** 收起态最紧急状态 → pill 文案/样式。 */
function collapsedLabel(
  counts: Record<SessionStatus, number>,
  total: number
): {
  text: string
  cls: SessionStatus | 'idle'
} {
  if (counts.waiting > 0) return { text: '等待审批', cls: 'waiting' }
  if (counts.error > 0) return { text: '出错', cls: 'error' }
  if (counts.running > 0) return { text: 'Working…', cls: 'running' }
  if (counts.done > 0) return { text: '完成', cls: 'done' }
  if (total > 0) return { text: '空闲', cls: 'idle' }
  return { text: '', cls: 'idle' }
}

/**
 * 灵动岛根组件（在独立置顶刘海窗口渲染，整个渲染端只有这一块）。
 *
 * 三种形态：
 * - 收起态：刘海居中 pill，展示会话数 + 最紧急状态
 * - hover 展开：聚合面板，列出所有活跃会话卡片（点击跳回终端）
 * - 审批态：收到 PreToolUse 审批请求时自动展开审批面板（优先级高于 hover）
 *
 * 通过 islandResize 把内容尺寸回传主进程调整窗口；状态切换为 waiting/done/error
 * 时播放 8-bit 音效（托盘可关）。
 */
export function IslandRoot(): React.ReactElement {
  const hydrate = useIslandStore((s) => s.hydrate)
  const subscribe = useIslandStore((s) => s.subscribe)
  const sessions = useIslandStore((s) => s.sessions)
  const pending = useIslandStore((s) => s.pending)
  // useShallow：selectStatusCounts 每次返回新对象，不做浅比较的话每条 IPC 推送都会让
  // 整个置顶岛重渲（即便计数没变）。浅比较后仅在某个状态计数真正变化时才触发重渲。
  const counts = useIslandStore(useShallow(selectStatusCounts))

  const hydrateSettings = useSettingsStore((s) => s.hydrate)
  const soundEnabled = useSettingsStore((s) => s.settings.islandSoundEnabled)
  const islandEnabled = useSettingsStore((s) => s.settings.islandEnabled)
  const trustAll = useSettingsStore((s) => s.settings.trustAll)
  const saveSettings = useSettingsStore((s) => s.save)

  const [hovered, setHovered] = useState(false)
  /** 主进程检测到的刘海几何（含黑条样式派生尺寸）；null=非刘海机型。 */
  const [notchInfo, setNotchInfo] = useState<{
    width: number
    cornerRadius: number
    height: number
    overlap: number
    shoulder: number
    shoulderH: number
    topInset: number
    barWidth: number
  } | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  /** 上次回传主进程的窗口请求（按 收起/展开 + 尺寸 去重，跳过重复 islandResize IPC）。 */
  const lastSizeRef = useRef<{ mode: string; width: number; height: number } | null>(null)

  // 启动：加载数据 + 订阅推送 + 加载设置 + 订阅托盘设置变更 + 读取刘海参数
  useEffect(() => {
    void hydrate()
    void hydrateSettings()
    const unsub = subscribe()
    const offSettings = window.electronAPI?.onSettingsChanged?.((s) =>
      useSettingsStore.getState().applyExternal(s)
    )
    // 读取主进程检测到的刘海几何，注入 CSS 变量，让黑条与刘海等高、底-左圆角、连成长方形。
    // --notch-h：黑条高(=刘海高)；--bar-radius：黑条底-左凸圆角；--bar-overlap：右端钻进
    // 刘海背后的像素（内容右 padding 让位）；--notch-topinset：展开态面板上方透明占位。
    const loadNotch = (): void => {
      void window.electronAPI?.islandGetNotchInfo?.().then((info) => {
        if (!info) return
        setNotchInfo(info)
        const root = document.documentElement
        root.style.setProperty('--notch-h', `${info.height}px`)
        root.style.setProperty('--bar-radius', `${info.cornerRadius}px`)
        root.style.setProperty('--bar-overlap', `${info.overlap}px`)
        root.style.setProperty('--bar-shoulder', `${info.shoulder}px`)
        root.style.setProperty('--bar-shoulder-h', `${info.shoulderH}px`)
        root.style.setProperty('--notch-topinset', `${info.topInset}px`)
      })
    }
    loadNotch()
    // 显示器拓扑变化（插拔外接屏 / 改分辨率）→ 主进程已把岛拉回内建屏，渲染端重取几何刷新 CSS
    const offNotch = window.electronAPI?.onIslandNotchChanged?.(loadNotch)
    return () => {
      unsub()
      offSettings?.()
      offNotch?.()
    }
  }, [hydrate, subscribe, hydrateSettings])

  // 音效：会话状态切换为 waiting/done/error 时播放；记录上一次每会话状态
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

  // 新审批到达：播放 waiting 音效（即便没有对应会话状态翻转）
  const prevPendingCount = useRef(0)
  useEffect(() => {
    if (pending.length > prevPendingCount.current) {
      playStatusSound('waiting', soundEnabled !== false)
    }
    prevPendingCount.current = pending.length
  }, [pending.length, soundEnabled])

  const hasApproval = pending.length > 0
  const expanded = hasApproval || hovered
  const sorted = useMemo(() => sortSessions(sessions), [sessions])

  // 「已持续时长 / 相对时间」的秒级滚动不再靠这里强制整树重渲，改由各卡片内的叶子组件
  // 订阅共享时钟（lib/use-now）自行刷新——卡片本体可安心 memo，时间又能动。

  // 内容尺寸 → 回传主进程调整窗口（审批/面板用测量高度，收起态用固定尺寸）。
  // sorted/pending 每次推送都是新引用，会反复触发本 effect；多数情况目标尺寸不变，
  // 故用 lastSizeRef 去重，跳过同尺寸的 IPC 回传，省掉无意义的 setBounds 抖动。
  useLayoutEffect(() => {
    const api = window.electronAPI
    if (!api?.islandResize) return
    // 收起态：几何由主进程的 collapsedBounds 决定（黑条贴刘海左侧），渲染端只发 expanded:false
    if (!expanded) {
      if (lastSizeRef.current?.mode === 'collapsed') return
      lastSizeRef.current = { mode: 'collapsed', width: 0, height: 0 }
      void api.islandResize({ expanded: false })
      return
    }
    // 展开态：测量内容高度回传（含刘海占位 spacer），上限随刘海占位上浮
    const el = contentRef.current
    const width = hasApproval ? APPROVAL_WIDTH : PANEL_WIDTH
    const maxExpandH = notchInfo ? 640 + notchInfo.topInset : 640
    const height = Math.max(48, Math.min(el ? Math.ceil(el.scrollHeight) : 200, maxExpandH))
    const last = lastSizeRef.current
    if (last && last.mode === 'expanded' && last.width === width && last.height === height) return
    lastSizeRef.current = { mode: 'expanded', width, height }
    void api.islandResize({ expanded: true, width, height })
  }, [expanded, hasApproval, sorted, pending, notchInfo])

  // 点击穿透：仅当岛真正可交互（hover 展开 或 有审批）时让窗口接收鼠标；否则忽略，
  // 让 pill 两侧透明区域的点击穿透到菜单栏 / 下层应用（窗口侧 forward:true 仍转发
  // move 事件，故穿透态下 pill 的 onMouseEnter 仍能触发以重新激活交互）。
  useEffect(() => {
    window.electronAPI?.islandSetMouseIgnore?.(!(hasApproval || hovered))
  }, [hasApproval, hovered])

  // islandEnabled=false：理论上主进程不会创建窗口；但若设置后未重启，渲染空内容
  if (islandEnabled === false) {
    return <div className="island-root" />
  }

  const label = collapsedLabel(counts, sessions.length)

  return (
    <div
      className={'island-root' + (expanded ? ' expanded' : ' collapsed')}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="island-content" ref={contentRef}>
        {!expanded && (
          <div
            className={'island-pill ' + (notchInfo ? 'notch ' : '') + label.cls}
            onMouseEnter={() => setHovered(true)}
          >
            <span className="island-pill-status">
              {label.cls === 'running' ? (
                <IslandRunner />
              ) : (
                <span className="island-pill-dot" aria-hidden="true" />
              )}
              {/* 刘海黑条空间有限，省略文案标签，状态色足以传达信息 */}
              {!notchInfo && label.text && <span className="island-pill-label">{label.text}</span>}
            </span>
            <span className="island-pill-count">{sessions.length} sessions</span>
          </div>
        )}

        {/* 展开态刘海占位：顶部透明区域（高=刘海高），让面板从刘海正下方弹出 */}
        {expanded && notchInfo && <div className="island-notch-spacer" aria-hidden="true" />}

        {expanded && hasApproval && <IslandApprovalPanel request={pending[0]} />}

        {expanded && !hasApproval && (
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
  )
}
