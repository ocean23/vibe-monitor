import { useEffect, useState } from 'react'

/** 主进程检测到的刘海几何（含黑条样式派生尺寸）；hasNotch=false 时仅 height 是该屏实测
 *  菜单栏高（供 fallback 黑条校准尺寸），不做贴刘海造型。 */
export interface NotchInfo {
  hasNotch: boolean
  width: number
  cornerRadius: number
  height: number
  overlap: number
  shoulder: number
  shoulderH: number
  topInset: number
  barWidth: number
}

interface NotchInfoState {
  info: NotchInfo | null
  /** IPC 首次落地前为 false——调用方应据此推迟渲染收起态 pill，避免先按 CSS 默认值
   *  （非刘海样式）渲染、几十毫秒后再跳到刘海样式的可见跳动。非刘海机型 loaded 变
   *  true 后 info 仍是 null，属正常结果（走 CSS 默认值渲染）。 */
  loaded: boolean
}

/**
 * 读取主进程检测到的刘海几何，注入 CSS 变量驱动黑条造型（`--notch-h` 等，见 app.css）；
 * 显示器拓扑变化（插拔外接屏/改分辨率）时主进程会把岛拉回内建屏并通知，这里自动重取刷新。
 */
export function useNotchInfo(): NotchInfoState {
  const [state, setState] = useState<NotchInfoState>({ info: null, loaded: false })

  useEffect(() => {
    const loadNotch = (): void => {
      void window.electronAPI?.islandGetNotchInfo?.().then((info) => {
        if (info) {
          const root = document.documentElement
          root.style.setProperty('--notch-h', `${info.height}px`)
          root.style.setProperty('--bar-radius', `${info.cornerRadius}px`)
          root.style.setProperty('--bar-overlap', `${info.overlap}px`)
          root.style.setProperty('--bar-shoulder', `${info.shoulder}px`)
          root.style.setProperty('--bar-shoulder-h', `${info.shoulderH}px`)
          root.style.setProperty('--notch-topinset', `${info.topInset}px`)
          root.style.setProperty('--bar-width', `${info.barWidth}px`)
        }
        setState({ info: info ?? null, loaded: true })
      })
    }
    loadNotch()
    const offNotch = window.electronAPI?.onIslandNotchChanged?.(loadNotch)
    return () => offNotch?.()
  }, [])

  return state
}
