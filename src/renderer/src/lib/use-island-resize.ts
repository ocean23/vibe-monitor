import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { SessionState, ApprovalRequest } from '../../../shared/island-types'
import type { NotchInfo } from './use-notch-info'

const PANEL_WIDTH = 640
const APPROVAL_WIDTH = 560

/** shell 收缩动画时长（ms）。收起时要等这段时间、CSS 收缩动画播完，才通知主进程把窗口
 *  收回黑条尺寸（见下方 effect），否则窗口会先于可见内容收窄，露出裁切。app.css 里
 *  `.island-shell` 的 transition 时长通过行内样式 `--island-shell-ms` 变量引用这同一个
 *  常量（Island.tsx 里设置），两处只有一份数字来源。 */
export const ISLAND_SHELL_TRANSITION_MS = 220

export interface UseIslandResizeParams {
  expanded: boolean
  hasApproval: boolean
  /** 仅用于触发重新测量（内容变化时尺寸可能变）；不直接读取其字段。 */
  sorted: SessionState[]
  pending: ApprovalRequest[]
  notchInfo: NotchInfo | null
}

export interface UseIslandResizeResult {
  /** 绑在承载展开态内容的 DOM 节点上（用于测 `scrollHeight`），常驻挂载，与是否可见无关。 */
  contentRef: RefObject<HTMLDivElement | null>
  /** 展开态 .island-shell 的目标宽/高（px）。渲染端只在 expanded 时把它设为行内样式，
   *  驱动 CSS transition 平滑长大/缩回；collapsed 时不设行内样式，落回 CSS 默认值
   *  （--bar-width / --notch-h）。 */
  expandedWidth: number
  expandedHeight: number
}

/**
 * 内容尺寸 → 回传主进程调整窗口，同时把「展开态目标尺寸」交给调用方设置 shell 的行内样式。
 *
 * 展开：立刻（无 animate）把窗口扩到目标尺寸——窗口透明，扩大过程不可见，只是预先把画布
 * 铺好，供 .island-shell 的 CSS 动画独立、平滑地在其中长大（不依赖原生窗口的 resize 时序）。
 *
 * 收起：先不动窗口，等 ISLAND_SHELL_TRANSITION_MS 后（shell 的收缩动画已经播完）才通知
 * 主进程把窗口收回黑条尺寸——这段时间窗口仍是展开态大小，但可见内容已经缩回黑条形状，
 * 多出的窗口区域全透明、不可见，不会露出空矩形。若期间用户重新 hover（expanded 变回
 * true），会先清掉这个还没触发的定时器，不会误收窗口。
 */
export function useIslandResize(params: UseIslandResizeParams): UseIslandResizeResult {
  const { expanded, hasApproval, sorted, pending, notchInfo } = params
  const contentRef = useRef<HTMLDivElement>(null)
  /** 上次回传主进程的窗口请求（按 收起/展开 + 尺寸 去重，跳过重复 islandResize IPC）。 */
  const lastSizeRef = useRef<{ mode: string; width: number; height: number } | null>(null)
  /** 收起态延迟通知主进程的定时器；重新 hover 时需要清掉，避免误收已经在重新展开的窗口。 */
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [target, setTarget] = useState({ width: PANEL_WIDTH, height: 48 })

  useLayoutEffect(() => {
    const api = window.electronAPI

    if (!expanded) {
      // 已经在收起态（mode 已是 'collapsed'）时，本次重跑必然只是 sorted/pending/notchInfo
      // 变化触发的（后台会话数据推送，收起态下也会持续发生），不是「刚从展开态切换过来」，
      // 直接返回、不触碰计时器：若在此处也无条件 clearTimeout，会把上一次已排好、尚未触发
      // 的收起定时器清掉且不重新调度（下面的 setTimeout 分支不会再执行到），导致收起 IPC
      // 永久丢失、窗口再也收不回去。计时器只应在「重新展开」时被取消，见下方 expanded 分支。
      if (lastSizeRef.current?.mode === 'collapsed') return
      lastSizeRef.current = { mode: 'collapsed', width: 0, height: 0 }
      if (api?.islandResize) {
        collapseTimerRef.current = setTimeout(() => {
          collapseTimerRef.current = null
          void api.islandResize({ expanded: false })
        }, ISLAND_SHELL_TRANSITION_MS)
      }
      return
    }

    // 展开态（含「重新 hover 打断收起」的情况）：先清掉还没触发的收起定时器，避免窗口被误收。
    if (collapseTimerRef.current !== null) {
      clearTimeout(collapseTimerRef.current)
      collapseTimerRef.current = null
    }

    // 展开态：测量内容高度回传（含刘海占位 spacer），上限随刘海占位上浮
    const el = contentRef.current
    const width = hasApproval ? APPROVAL_WIDTH : PANEL_WIDTH
    const maxExpandH = notchInfo?.hasNotch ? 640 + notchInfo.topInset : 640
    const height = Math.max(48, Math.min(el ? Math.ceil(el.scrollHeight) : 200, maxExpandH))
    setTarget({ width, height })

    if (!api?.islandResize) return
    const last = lastSizeRef.current
    if (last && last.mode === 'expanded' && last.width === width && last.height === height) return
    lastSizeRef.current = { mode: 'expanded', width, height }
    void api.islandResize({ expanded: true, width, height })
    // sorted/pending 每次推送都是新引用，会反复触发本 effect；多数情况目标尺寸不变，
    // 故用 lastSizeRef 去重，跳过同尺寸的 IPC 回传，省掉无意义的 setBounds 抖动。
  }, [expanded, hasApproval, sorted, pending, notchInfo])

  // 卸载时清理未触发的收起定时器。
  useLayoutEffect(() => {
    return () => {
      if (collapseTimerRef.current !== null) clearTimeout(collapseTimerRef.current)
    }
  }, [])

  return { contentRef, expandedWidth: target.width, expandedHeight: target.height }
}
