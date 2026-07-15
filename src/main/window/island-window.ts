import { BrowserWindow, screen, type Display } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { AuditFn } from '../audit-log'
import type { RunCommandResult } from '../services/terminal-launcher'
import {
  pickNotchDisplay,
  resolveNotchInfo,
  collapsedBounds,
  expandedX,
  localMenuBarHeight,
  NOTCH_COLLAPSED_WIDTH,
  type NotchInfo
} from '../services/island-geometry'

export type { NotchInfo } from '../services/island-geometry'

/** 灵动岛收起态尺寸（像素）兜底默认值：JXA/启发式检测彻底失败（非 darwin）时使用。 */
const DEFAULT_ISLAND_WIDTH = 520
const DEFAULT_ISLAND_HEIGHT = 46

export interface IslandWindowDeps {
  audit: AuditFn
  preloadPath: string
  rendererFilePath: string
  /** 注入 osascript 调用（复用 index.ts 装配的 runCommand，便于单测替换）。 */
  runOsascript: (script: string) => Promise<RunCommandResult>
}

export interface IslandWindowController {
  getWindow(): BrowserWindow | null
  getNotchInfo(): NotchInfo | null
  /** 展开态面板上方透明占位高（= 完整菜单栏高，实时重取——多屏切换后可能变）。 */
  getNotchTopInset(): number
  /** 初次刘海检测（setupIsland 启动时调用一次，需在 create() 之前）。 */
  detect(): Promise<void>
  /** 创建收起态黑条窗口（复用当前已检测的 notchInfo，不重新检测）。 */
  create(): void
  /** 收起窗口，几何由 collapsedBounds 决定（忽略传入尺寸）。 */
  collapse(): void
  /** 展开窗口到指定尺寸，x 由刘海/非刘海机型分别定位。 */
  expand(width: number, height: number): void
  /** 展开态默认宽/高（渲染端未显式传值时的兜底）。 */
  getDefaultExpandSize(): { width: number; height: number }
  setMouseIgnore(ignore: boolean): void
  /** 显示器拓扑变化：重新检测 + 把窗口拉回刘海所在屏 + 通知渲染端刷新 CSS 变量。 */
  reposition(): Promise<void>
  /** 主进程 → 渲染端 IPC 推送（webContents.send 的安全包装，窗口不存在时静默跳过）。 */
  send(channel: string, ...args: unknown[]): void
}

/**
 * 灵动岛窗口控制器：透明、无边框、置顶、不进任务栏的收起态黑条 + 展开态面板。
 * macOS 刘海机型贴刘海左侧、与刘海等高连成长方形；非刘海 / 其它平台降级为屏幕顶部
 * 居中悬浮条。窗口几何计算全部委托给 `services/island-geometry.ts` 的纯函数。
 */
export function createIslandWindowController(deps: IslandWindowDeps): IslandWindowController {
  let win: BrowserWindow | null = null
  let notchInfo: NotchInfo | null = null

  function getNotchDisplay(): Display {
    return pickNotchDisplay(screen.getAllDisplays())
  }

  /**
   * 使用 JXA (JavaScript for Automation) 从 macOS NSScreen 读取刘海精确宽 + 高。
   *
   * 关键：刘海高度取 `auxiliaryTopLeftArea.size.height`（菜单栏在刘海左侧的辅助区，与刘海
   * 等高），**不是** Electron 的 `workArea.y`——后者是「菜单栏预留区」，比刘海真实高度大，
   * 若用它当黑条高度，黑条会比刘海矮沿低出一截，无法与刘海齐平（见用户反馈）。
   *
   * auxiliaryTopLeftArea / TopRightArea 在 macOS 12+ 刘海机型可用；非刘海机型返回 nil
   * （→ w:0），据此判定「是否刘海机型」。JXA 失败 / 超时 → 用 workArea.y 启发式兜底
   * （解析逻辑见 {@link resolveNotchInfo}）。
   */
  async function detectNotchInfo(): Promise<NotchInfo | null> {
    if (process.platform !== 'darwin') return null
    // 用刘海所在的内建屏（而非主屏）——外接屏设为主屏时 mainScreen 指向外接屏，没有刘海。
    const notchDisplay = getNotchDisplay()

    // JXA：遍历所有 NSScreen，挑出「有刘海辅助区」的那块（即内建屏），读其刘海宽高。
    // 不用 mainScreen——外接屏为主屏时 mainScreen 是外接屏，auxiliaryArea 为 nil。
    const jxaScript =
      'ObjC.import("AppKit");' +
      'try{' +
      'var ss=$.NSScreen.screens;var out={w:0,h:0};' +
      'for(var i=0;i<ss.count;i++){' +
      'var s=ss.objectAtIndex(i);' +
      'var l=s.auxiliaryTopLeftArea;var r=s.auxiliaryTopRightArea;' +
      'if(l&&r){out={w:s.frame.size.width-l.size.width-r.size.width,h:l.size.height};break;}' +
      '}' +
      'JSON.stringify(out)' +
      '}catch(e){JSON.stringify({w:0,h:0})}'

    let jxa = { w: 0, h: 0 }
    try {
      const r = await deps.runOsascript(jxaScript)
      if (r.code === 0 && r.stdout.trim()) {
        const parsed = JSON.parse(r.stdout.trim()) as { w?: number; h?: number }
        jxa = { w: parsed.w ?? 0, h: parsed.h ?? 0 }
      }
    } catch (_) {
      void deps.audit('island.notch_detect_failed', {})
    }

    // 局部菜单栏高，不能直接用 workArea.y——外接屏设为主屏时内建屏在全局坐标系里会被推离
    // 原点，workArea.y 会把这段排列偏移也算进去（见 localMenuBarHeight 注释，真实复现过）。
    const menuBarH = localMenuBarHeight(notchDisplay)
    const info = resolveNotchInfo(jxa, menuBarH, notchDisplay.bounds.width)
    // JXA 未测到（jxa.w/h 均为 0）但启发式判定为刘海机型：走的是估算分支，留痕。
    if (!(jxa.w > 0 && jxa.h > 0) && info?.hasNotch) {
      void deps.audit('island.notch_detect_estimated', { menuBarH })
    }
    return info
  }

  function effectiveCollapsedFallback(): { width: number; height: number } {
    return { width: DEFAULT_ISLAND_WIDTH, height: notchInfo?.height ?? DEFAULT_ISLAND_HEIGHT }
  }

  function currentBounds(): { x: number; y: number; width: number; height: number } {
    return collapsedBounds(getNotchDisplay(), notchInfo, effectiveCollapsedFallback())
  }

  function create(): void {
    const b = currentBounds()
    // 留痕实际应用的窗口尺寸 + 当时的刘海检测结果，排查「黑条高度/内容对不齐」类问题时
    // 不需要再临时加日志——直接对比这条与下面 detect() 的 island.notch_detected 即可。
    void deps.audit('island.window_create_bounds', { bounds: b, notchInfo })

    win = new BrowserWindow({
      width: b.width,
      height: b.height,
      x: b.x,
      y: b.y,
      // 黑条很矮，放开最小尺寸限制，防止 macOS 把窗口拔高到默认最小高度
      minWidth: 1,
      minHeight: 1,
      // 关键：关闭 macOS 的 constrainFrameRect 夹取——否则 y:0 的窗口会被强制下移到菜单栏
      // 下方（实测 y:0 → y:39），黑条就浮在壁纸上而非贴屏幕顶与刘海齐平。开启后窗口可
      // 自由定位到刘海所在的屏幕最顶端（这是唯一能真正顶到 y:0 的开关，窗口层级无法做到）。
      enableLargerThanScreen: true,
      // 关键：macOS 默认给窗口套 ~12pt 圆角矩形遮罩，会把黑条「左上/右上」两角削圆，圆角
      // 缺口露出蓝色壁纸（截图实测：顶角黑色从 y=0 的 x=926 渐扩到 y=40 的 x=946，正是这层
      // 系统圆角在削）。关掉它，顶角才是真正的直角、黑色齐顶贴满，与刘海顶角无缝。
      roundedCorners: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // macOS 在构造时会把落在菜单栏区域的 y:0 夹到菜单栏下方（普通层级窗口不准盖菜单栏）。
    // 上面把层级提到 screen-saver 后，必须重新 setBounds 才能真正把窗口顶端顶回屏幕最顶、
    // 与刘海齐平——否则黑条会卡在菜单栏下方一行（看起来像浮在壁纸上而非续接刘海）。
    win.setBounds(b)

    win.on('ready-to-show', () => {
      // 窗口完全成形后再断言一次位置，防止构造期的迟到夹取把 y 又压下去。
      win?.setBounds(currentBounds())
      win?.show()
    })
    win.on('closed', () => {
      win = null
    })

    // 渲染端只有灵动岛一块，无需 #island hash 路由（已废弃，直接加载根）。
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      void win.loadFile(deps.rendererFilePath)
    }
  }

  return {
    getWindow: () => win,
    getNotchInfo: () => notchInfo,
    getNotchTopInset: () => Math.max(notchInfo?.height ?? 0, localMenuBarHeight(getNotchDisplay())),

    detect: async () => {
      notchInfo = await detectNotchInfo()
      // 每次检测结果都留痕（启动一次 + 显示器拓扑变化时的 reposition 各一次），不必再为
      // 排查特定机型的尺寸问题临时加日志。
      void deps.audit('island.notch_detected', { notchInfo })
    },

    create,

    collapse: () => {
      win?.setBounds(currentBounds())
    },

    expand: (width, height) => {
      if (!win) return
      const disp = getNotchDisplay()
      const x = expandedX(disp, notchInfo, width)
      win.setBounds({ x, y: disp.bounds.y, width, height })
    },

    getDefaultExpandSize: () => ({
      width: notchInfo?.hasNotch ? NOTCH_COLLAPSED_WIDTH : DEFAULT_ISLAND_WIDTH,
      height: notchInfo?.height ?? DEFAULT_ISLAND_HEIGHT
    }),

    setMouseIgnore: (ignore) => {
      win?.setIgnoreMouseEvents(ignore, { forward: true })
    },

    reposition: async () => {
      notchInfo = await detectNotchInfo()
      win?.setBounds(currentBounds())
      // 几何变了 → 重新下发给渲染端刷新 CSS 变量（刘海宽高可能已变）
      win?.webContents.send('island:notch-changed')
      void deps.audit('island.repositioned', { display: getNotchDisplay().id })
    },

    send: (channel, ...args) => {
      win?.webContents.send(channel, ...args)
    }
  }
}
