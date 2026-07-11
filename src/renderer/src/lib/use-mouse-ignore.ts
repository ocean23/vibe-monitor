import { useEffect } from 'react'

/**
 * 点击穿透开关：仅当岛真正可交互（hover 展开或有审批）时让窗口接收鼠标；否则忽略，
 * 让 pill 两侧透明区域的点击穿透到菜单栏/下层应用（窗口侧 forward:true 仍转发 move
 * 事件，故穿透态下 pill 的 onMouseEnter 仍能触发以重新激活交互）。
 */
export function useMouseIgnore(interactive: boolean): void {
  useEffect(() => {
    window.electronAPI?.islandSetMouseIgnore?.(!interactive)
  }, [interactive])
}
