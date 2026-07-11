import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { SessionState, ApprovalRequest } from '../../../shared/island-types'
import type { NotchInfo } from './use-notch-info'

const PANEL_WIDTH = 640
const APPROVAL_WIDTH = 560

export interface UseIslandResizeParams {
  expanded: boolean
  hasApproval: boolean
  /** 仅用于触发重新测量（内容变化时尺寸可能变）；不直接读取其字段。 */
  sorted: SessionState[]
  pending: ApprovalRequest[]
  notchInfo: NotchInfo | null
}

/**
 * 内容尺寸 → 回传主进程调整窗口（收起态几何由主进程的 collapsedBounds 决定，只发
 * expanded:false；展开态测量内容高度回传，上限随刘海占位上浮）。
 *
 * 返回 contentRef，调用方需绑在承载内容的 DOM 节点上（用于测 `scrollHeight`）。
 */
export function useIslandResize(params: UseIslandResizeParams): RefObject<HTMLDivElement | null> {
  const { expanded, hasApproval, sorted, pending, notchInfo } = params
  const contentRef = useRef<HTMLDivElement>(null)
  /** 上次回传主进程的窗口请求（按 收起/展开 + 尺寸 去重，跳过重复 islandResize IPC）。 */
  const lastSizeRef = useRef<{ mode: string; width: number; height: number } | null>(null)

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
    const maxExpandH = notchInfo?.hasNotch ? 640 + notchInfo.topInset : 640
    const height = Math.max(48, Math.min(el ? Math.ceil(el.scrollHeight) : 200, maxExpandH))
    const last = lastSizeRef.current
    if (last && last.mode === 'expanded' && last.width === width && last.height === height) return
    lastSizeRef.current = { mode: 'expanded', width, height }
    void api.islandResize({ expanded: true, width, height })
    // sorted/pending 每次推送都是新引用，会反复触发本 effect；多数情况目标尺寸不变，
    // 故用 lastSizeRef 去重，跳过同尺寸的 IPC 回传，省掉无意义的 setBounds 抖动。
  }, [expanded, hasApproval, sorted, pending, notchInfo])

  return contentRef
}
