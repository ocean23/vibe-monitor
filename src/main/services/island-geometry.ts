import type { Display } from 'electron'

/**
 * 刘海/Dynamic Island 物理参数（macOS 12+ 通过 JXA 精确读取，否则估算）。
 */
export interface NotchInfo {
  /** true=真实物理刘海（贴刘海左侧、连成长方形）；false=无刘海机型，仅借这份结构体
   *  回传该屏实测菜单栏高，供收起态黑条校准高度（不做贴刘海的黑条造型）。 */
  hasNotch: boolean
  /** 刘海宽（pt）= 屏宽 - 左右菜单栏辅助区宽；非刘海机型无意义，恒为 0 */
  width: number
  /** 黑条底-左外圆角（pt） */
  cornerRadius: number
  /** 刘海高（pt）= 左侧菜单栏辅助区高 / safeAreaInsets.top —— 黑条用这个高度即与刘海齐平。
   *  实测 = 菜单栏高（本机 16" MBP 为 38pt，约等于 Electron workArea.y=39）。
   *  非刘海机型：直接是该屏实测菜单栏高（如外接显示器 ~24pt），黑条按此收起，不再用写死的
   *  默认值——否则黑条比真实菜单栏高出一大截，视觉上盖进下方窗口内容（用户反馈）。 */
  height: number
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 刘海机型黑条几何（目标：刘海左侧、与刘海等高、连成一条长方形）：
 * - COLLAPSED_BAR_WIDTH：黑条可见内容宽（落在刘海左侧的菜单栏空隙里）
 * - BAR_OVERLAP：黑条右端钻进刘海背后的像素数。取较大值（28）让黑条右缘深入刘海实体下方，
 *   越过刘海自身的底角圆角 + 吸收刘海宽度/居中的估算误差——否则右缘只差几像素没插进刘海，
 *   就会在右上露出菜单栏亮边（白缝）、右下与刘海间留缺口（用户反馈 #2 #3）。
 * - BAR_SHOULDER：左下「凹形肩（concave）」半径，也是窗口在黑条左侧额外预留的透明宽度
 *   （供凹肩向左外延 melt 到壁纸）。仿原生刘海底-肩：竖直壁→底部向左外扩平滑过渡（用户选定）。
 *   凹肩 melt 到的是黑条「下方」的壁纸（本就是壁纸），故不会像顶部外凹那样露出本不该有的缝。
 * 黑条形状：顶边平齐屏幕顶（纯黑不挖顶角，顶角直角贴屏幕黑边框）；左下凹形肩；右缘直角插进
 * 刘海背后。黑条高 = 刘海高，顶端贴屏幕顶 (y:0)，与刘海上下沿对齐 → 一条长方形。
 */
export const COLLAPSED_BAR_WIDTH = 160
export const BAR_OVERLAP = 28
// 左上椭圆凹肩：水平半径 BAR_SHOULDER（= 窗口左缘外延的透明预留宽），垂直半径 BAR_SHOULDER_H。
// 外扩幅度由水平半径决定，取极小值 3px → 几乎直角、只顶部一点点圆，与右上角原生刘海肩对称
// （用户多次反馈凹肩外扩偏大，10×24→7×28→最终 3×10，逐步收窄到几乎不外扩）。
export const BAR_SHOULDER = 3
export const BAR_SHOULDER_H = 10
/** 收起态窗口在黑条「下方」额外预留的高度（px）。给 running 小人「踩出」黑条下沿留空间——
 *  小人盒子放大到超过黑条高、底部伸出黑条外，整体显著变大。仅加窗口下沿（透明区），
 *  不动顶部 y:0 / 顶角 / 凹肩，故不影响黑条贴合刘海（见 collapsedBounds 的 height）。 */
export const RUNNER_FOOT_ROOM = 12

/**
 * 刘海机型收起态黑条宽（含钻进刘海背后的 overlap + 左缘凹肩预留）。此前这条公式在
 * setupIsland 与 scheduleReposition 两处各写一遍，曾漏掉 BAR_SHOULDER 导致两处结果
 * 不一致（真实 bug，从首次提交起就存在）；现在统一到这一个常量，全仓只有一份。
 */
export const NOTCH_COLLAPSED_WIDTH = COLLAPSED_BAR_WIDTH + BAR_SHOULDER + BAR_OVERLAP

/**
 * 灵动岛锚定的「刘海所在显示器」——始终是内建屏（MacBook 本体），与谁是主屏无关。
 *
 * 外接显示器场景：用户常把外接屏设为主屏（菜单栏在外接屏），此时 `getPrimaryDisplay()`
 * 会指向外接屏，灵动岛就跑到外接屏上了。改用 `.internal`（Electron 标记内建屏）锁定本体；
 * 找不到内建屏（极少数：纯外接 / 合盖 clamshell）时退化到菜单栏预留区最高的那块（刘海屏
 * 菜单栏 ~38pt 高于普通屏 ~24pt），再退到主屏兜底。
 */
export function pickNotchDisplay(displays: Display[]): Display {
  const internal = displays.find((d) => d.internal)
  if (internal) return internal
  return displays.reduce((best, d) => (d.workArea.y > best.workArea.y ? d : best), displays[0])
}

/**
 * 该屏「局部」菜单栏/刘海预留高度，与显示器在全局虚拟桌面坐标系中的排列位置无关。
 *
 * `workArea.y` 是全局坐标（原点由当前主屏 + 多屏排列方式决定），只有该屏 `bounds.y === 0`
 * （排在全局原点）时才恰好等于「局部菜单栏高」。一旦把外接屏设为主屏（菜单栏显示在外接屏
 * 上），内建屏在全局坐标里就会被推离原点，此时 `bounds.y` 本身就是几十/上百像素的排列偏
 * 移——直接把 `workArea.y` 当局部高度用，会把这段偏移也一并算进刘海/菜单栏高度。
 *
 * 真实复现（用户反馈：外接显示器场景灵动岛变成远超正常尺寸的黑色方块）：内建屏
 * `bounds.y=111`、`workArea.y=150`，真实局部高只有 39，此前代码直接用 150 当刘海高，
 * 黑条与 CSS `--notch-h` 随之暴涨到 150px。用 `workArea.y - bounds.y` 才是与全局排列
 * 无关的局部值。
 */
export function localMenuBarHeight(display: Display): number {
  return display.workArea.y - display.bounds.y
}

/**
 * 把 JXA 实测结果 + 局部菜单栏高启发式解析为最终的 NotchInfo（纯函数，覆盖刘海机型 /
 * 无刘海外接显示器 / JXA 失败兜底三条分支，测试不需要真的跑 osascript）。
 *
 * @param jxa JXA 脚本读到的 {宽, 高}；均为 0 表示未测到刘海辅助区（非刘海机型或 JXA 失败）
 * @param menuBarH 兜底：该屏局部菜单栏预留高（见 {@link localMenuBarHeight}，调用方不可
 *   直接传 `workArea.y`——多屏且该屏不在全局原点时会把排列偏移也算进去）
 * @param displayWidthPt 兜底估算刘海宽度用：该屏物理宽度（pt）
 */
export function resolveNotchInfo(
  jxa: { w: number; h: number },
  menuBarH: number,
  displayWidthPt: number
): NotchInfo | null {
  // JXA 明确测到刘海（辅助区存在 → 宽高都 > 0）：用实测值
  if (jxa.w > 0 && jxa.h > 0) {
    return {
      hasNotch: true,
      width: Math.round(jxa.w),
      cornerRadius: 10,
      height: Math.round(jxa.h)
    }
  }
  // 兜底：JXA 不可用 / 无刘海辅助区（如 Mac mini 外接显示器）时，用该屏 workArea.y 判定
  // 是否刘海机型（普通菜单栏 ≤ 30pt）。刘海高 ≈ 菜单栏高（实测两者基本相等：本机
  // auxArea.h=38 ≈ workArea.y=39）。
  if (menuBarH <= 30) {
    // 非刘海机型：仍把实测菜单栏高带回去（hasNotch:false），供收起态黑条按此校准高度。
    return { hasNotch: false, width: 0, cornerRadius: 0, height: menuBarH }
  }
  return {
    hasNotch: true,
    width: displayWidthPt >= 1600 ? 220 : 160,
    cornerRadius: 10,
    height: menuBarH
  }
}

/** 收起态黑条窗口左上角 + 尺寸：始终锚定刘海所在的内建屏（与主屏无关），贴刘海左侧、等高。 */
export function collapsedBounds(
  display: Display,
  notchInfo: NotchInfo | null,
  fallback: { width: number; height: number }
): WindowBounds {
  if (notchInfo?.hasNotch) {
    const { x: sx, y: sy, width: sw } = display.bounds
    // 刘海水平居中于内建屏 → 其左缘 X。黑条主体宽 COLLAPSED_BAR_WIDTH，右缘钻进刘海背后
    // BAR_OVERLAP（盖住接缝）；左缘再外延 BAR_SHOULDER 给凹形肩 melt 的透明空间。
    // y 取内建屏的 bounds.y（多屏时内建屏原点可能非 0），使黑条贴在内建屏自身的顶端。
    const notchLeftX = sx + sw / 2 - notchInfo.width / 2
    return {
      x: Math.round(notchLeftX - COLLAPSED_BAR_WIDTH - BAR_SHOULDER),
      y: sy,
      width: NOTCH_COLLAPSED_WIDTH,
      // 窗口比黑条（= 刘海高）高出 RUNNER_FOOT_ROOM：多出的部分在黑条「下方」、透明，
      // 供 running 小人踩出黑条下沿。黑条本体仍 = 刘海高，顶部贴合完全不变。
      height: notchInfo.height + RUNNER_FOOT_ROOM
    }
  }
  const { x: waX, width: waWidth } = display.workArea
  return {
    x: Math.round(waX + (waWidth - fallback.width) / 2),
    y: display.bounds.y, // 非刘海屏：置于该屏顶部
    width: fallback.width,
    height: fallback.height
  }
}

/**
 * 展开态面板左缘 x 坐标：刘海机型与收起态黑条同左缘向右下展开（右溢出则左移夹住，保证
 * 整窗在内建屏内）；非刘海机型居中于该屏工作区。
 */
export function expandedX(
  display: Display,
  notchInfo: NotchInfo | null,
  panelWidth: number
): number {
  if (notchInfo?.hasNotch) {
    const { x: sx, width: sw } = display.bounds
    const notchLeftX = sx + sw / 2 - notchInfo.width / 2
    const barLeftX = Math.round(notchLeftX - COLLAPSED_BAR_WIDTH)
    return Math.max(sx + 4, Math.min(barLeftX, sx + sw - panelWidth - 4))
  }
  return Math.round(display.workArea.x + (display.workArea.width - panelWidth) / 2)
}
