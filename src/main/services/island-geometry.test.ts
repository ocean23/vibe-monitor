import { describe, it, expect } from 'vitest'
import type { Display } from 'electron'
import {
  pickNotchDisplay,
  resolveNotchInfo,
  collapsedBounds,
  expandedX,
  localMenuBarHeight,
  COLLAPSED_BAR_WIDTH,
  BAR_SHOULDER,
  RUNNER_FOOT_ROOM,
  NOTCH_COLLAPSED_WIDTH
} from './island-geometry'

/** 构造测试用 Display：只填几何相关字段，其余字段用 `as Display` 断言掉。 */
function mkDisplay(partial: {
  id?: number
  internal?: boolean
  bounds: { x: number; y: number; width: number; height: number }
  workArea: { x: number; y: number; width: number; height: number }
}): Display {
  return {
    id: partial.id ?? 1,
    internal: partial.internal ?? false,
    bounds: partial.bounds,
    workArea: partial.workArea
  } as Display
}

describe('pickNotchDisplay', () => {
  it('prefers the internal display regardless of order', () => {
    const external = mkDisplay({
      id: 1,
      internal: false,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      workArea: { x: 0, y: 25, width: 2560, height: 1415 }
    })
    const internal = mkDisplay({
      id: 2,
      internal: true,
      bounds: { x: 2560, y: 0, width: 1512, height: 982 },
      workArea: { x: 2560, y: 38, width: 1512, height: 944 }
    })
    expect(pickNotchDisplay([external, internal])).toBe(internal)
    expect(pickNotchDisplay([internal, external])).toBe(internal)
  })

  it('falls back to the display with the tallest menu-bar reservation when none is internal', () => {
    const normal = mkDisplay({
      id: 1,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      workArea: { x: 0, y: 25, width: 2560, height: 1415 }
    })
    const notchLike = mkDisplay({
      id: 2,
      bounds: { x: 2560, y: 0, width: 1512, height: 982 },
      workArea: { x: 2560, y: 38, width: 1512, height: 944 }
    })
    expect(pickNotchDisplay([normal, notchLike])).toBe(notchLike)
  })

  it('returns the only display when there is just one', () => {
    const only = mkDisplay({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 25, width: 1920, height: 1055 }
    })
    expect(pickNotchDisplay([only])).toBe(only)
  })
})

describe('localMenuBarHeight', () => {
  it('equals workArea.y when the display sits at the global origin (single-display / notch display is primary)', () => {
    const display = mkDisplay({
      internal: true,
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      workArea: { x: 0, y: 38, width: 1512, height: 944 }
    })
    expect(localMenuBarHeight(display)).toBe(38)
  })

  it('subtracts the arrangement offset when an external display is set as primary (real repro: bounds.y=111, workArea.y=150)', () => {
    // 真实复现：外接屏设为主屏，内建屏在全局坐标系里被推离原点到 bounds.y=111；
    // workArea.y=150 里混进了这段排列偏移，局部菜单栏/刘海高其实只有 39。
    const internal = mkDisplay({
      internal: true,
      bounds: { x: -1512, y: 111, width: 1512, height: 982 },
      workArea: { x: -1512, y: 150, width: 1512, height: 944 }
    })
    expect(localMenuBarHeight(internal)).toBe(39)
  })
})

describe('resolveNotchInfo', () => {
  it('uses JXA measurements when both width and height are present (real notch)', () => {
    const info = resolveNotchInfo({ w: 200.4, h: 37.6 }, 38, 1512)
    expect(info).toEqual({ hasNotch: true, width: 200, cornerRadius: 10, height: 38 })
  })

  it('returns hasNotch:false with the real menu-bar height for a non-notch display (Mac mini + external monitor)', () => {
    const info = resolveNotchInfo({ w: 0, h: 0 }, 24, 2560)
    expect(info).toEqual({ hasNotch: false, width: 0, cornerRadius: 0, height: 24 })
  })

  it('boundary: menuBarH exactly 30 is still treated as non-notch', () => {
    const info = resolveNotchInfo({ w: 0, h: 0 }, 30, 2560)
    expect(info?.hasNotch).toBe(false)
  })

  it('falls back to heuristic notch estimate when JXA fails but menu bar is tall (>30pt)', () => {
    const wide = resolveNotchInfo({ w: 0, h: 0 }, 38, 1728)
    expect(wide).toEqual({ hasNotch: true, width: 220, cornerRadius: 10, height: 38 })
    const narrow = resolveNotchInfo({ w: 0, h: 0 }, 38, 1512)
    expect(narrow).toEqual({ hasNotch: true, width: 160, cornerRadius: 10, height: 38 })
  })
})

describe('collapsedBounds', () => {
  const notchDisplay = mkDisplay({
    internal: true,
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 38, width: 1512, height: 944 }
  })

  it('docks beside the physical notch when hasNotch is true', () => {
    const notchInfo = { hasNotch: true, width: 200, cornerRadius: 10, height: 38 }
    const b = collapsedBounds(notchDisplay, notchInfo, { width: 520, height: 46 })
    expect(b.width).toBe(NOTCH_COLLAPSED_WIDTH)
    expect(b.height).toBe(38 + RUNNER_FOOT_ROOM)
    expect(b.y).toBe(0)
    // 左缘 = 刘海左缘 - 黑条宽 - 凹肩预留
    const notchLeftX = 1512 / 2 - 200 / 2
    expect(b.x).toBe(Math.round(notchLeftX - COLLAPSED_BAR_WIDTH - BAR_SHOULDER))
  })

  it('centers a fallback-sized bar at the top when hasNotch is false (e.g. Mac mini)', () => {
    const notchInfo = { hasNotch: false, width: 0, cornerRadius: 0, height: 24 }
    const external = mkDisplay({
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      workArea: { x: 0, y: 24, width: 2560, height: 1416 }
    })
    const b = collapsedBounds(external, notchInfo, { width: 520, height: 24 })
    expect(b).toEqual({ x: Math.round((2560 - 520) / 2), y: 0, width: 520, height: 24 })
  })

  it('uses the fallback size when notchInfo is entirely null (detection failed)', () => {
    const b = collapsedBounds(notchDisplay, null, { width: 520, height: 46 })
    expect(b.width).toBe(520)
    expect(b.height).toBe(46)
  })
})

describe('expandedX', () => {
  const notchDisplay = mkDisplay({
    internal: true,
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 38, width: 1512, height: 944 }
  })

  it('shares the collapsed bar left edge when hasNotch is true and there is room', () => {
    const notchInfo = { hasNotch: true, width: 200, cornerRadius: 10, height: 38 }
    const x = expandedX(notchDisplay, notchInfo, 640)
    const notchLeftX = 1512 / 2 - 200 / 2
    expect(x).toBe(Math.round(notchLeftX - COLLAPSED_BAR_WIDTH))
  })

  it('clamps to stay within the display when the panel would overflow the right edge', () => {
    const notchInfo = { hasNotch: true, width: 200, cornerRadius: 10, height: 38 }
    const x = expandedX(notchDisplay, notchInfo, 1200)
    expect(x).toBeGreaterThanOrEqual(0 + 4)
    expect(x + 1200).toBeLessThanOrEqual(1512 - 4 + 1) // 允许 Math.round 的 ±1
  })

  it('centers within the work area when hasNotch is false', () => {
    const notchInfo = { hasNotch: false, width: 0, cornerRadius: 0, height: 24 }
    const external = mkDisplay({
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      workArea: { x: 0, y: 24, width: 2560, height: 1416 }
    })
    const x = expandedX(external, notchInfo, 640)
    expect(x).toBe(Math.round((2560 - 640) / 2))
  })
})
