import {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  clipboard,
  Tray,
  Menu,
  nativeImage,
  dialog,
  globalShortcut
} from 'electron'
import { join } from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { is } from '@electron-toolkit/utils'

import { audit, setAuditRoot } from './audit-log'
import { TRAY_ICON_DATA_URL } from './tray-icon'
import { ensureIslandConfig, patchIslandConfig } from './services/island-config'
import { IslandState } from './services/island-state'
import { ApprovalRegistry } from './services/island-approval'
import { createIslandServer, type IslandServer } from './services/island-server'
import { createTranscriptWatcher, type TranscriptWatcher } from './services/transcript-watcher'
import { readAiTitle } from './services/session-title'
import { registerIslandIpc } from './ipc/island-ipc'
import { createLauncher, type RunCommandResult } from './services/terminal-launcher'
import { createEnsureSpaceAutoSwitch } from './services/space-switch'
import { SettingsService, registerSettingsIpc } from './ipc/settings-ipc'
import type { SessionState, ApprovalRequest, ApprovalDecision } from '../shared/island-types'

/** 所有运行态数据（island.json / settings.json / audit/）的单一根目录。 */
const VIBE_DIR = join(os.homedir(), '.vibe-monitor')

let islandWindow: BrowserWindow | null = null
let islandServer: IslandServer | null = null
let islandWatcher: TranscriptWatcher | null = null
let islandRegistry: ApprovalRegistry | null = null
let islandState: IslandState | null = null
let settingsService: SettingsService | null = null
let tray: Tray | null = null

/** 「跳回终端」可选的终端 App（托盘单选）。 */
const TERMINAL_APPS = ['Ghostty', 'iTerm', 'Terminal', 'Alacritty', 'WezTerm', 'Warp'] as const

// 单实例锁：固定端口 7842 决定了同机只能跑一个 Vibe Monitor。第二个实例直接退出，
// 并把已有实例的岛唤到前台——否则第二个进程会在 createIslandServer 处 EADDRINUSE，
// setupIsland 吞掉异常后半启动成「无窗口、无 server」的僵尸进程（仍占 Dock）。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    islandWindow?.show()
    islandWindow?.focus()
  })
}

/** `child_process.spawn` 的最小包装：terminal-launcher 注入点，返回 `{code, stdout, stderr}`。 */
function runCommand(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs = 8000
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, env ? { env } : {})
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (r: RunCommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    // 超时兜底：osascript 遇无响应 app / 权限弹窗可能永不退出，否则会让 island:openSession
    // 的 IPC invoke 永久 pending。到点 SIGKILL 并以 code:-1 收敛，调用方自然走降级。
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: -1, stdout, stderr: stderr + '\n[runCommand timeout]' })
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }))
    child.on('error', (err) => finish({ code: -1, stdout, stderr: stderr + String(err) }))
  })
}

/** 刘海/Dynamic Island 物理参数（macOS 12+ 通过 JXA 精确读取，否则估算）。 */
interface NotchInfo {
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
   *  46px 默认值——否则黑条比真实菜单栏高出一大截，视觉上盖进下方窗口内容（用户反馈）。 */
  height: number
}
let islandNotchInfo: NotchInfo | null = null

/** 灵动岛收起态尺寸（像素）；刘海机型在 setupIsland 里按检测结果改写，展开由渲染端请求。 */
let ISLAND_COLLAPSED_HEIGHT = 46
let ISLAND_WIDTH = 520

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
const COLLAPSED_BAR_WIDTH = 160
const BAR_OVERLAP = 28
// 左上椭圆凹肩：水平半径 BAR_SHOULDER（= 窗口左缘外延的透明预留宽），垂直半径 BAR_SHOULDER_H。
// 外扩幅度由水平半径决定，取极小值 3px → 几乎直角、只顶部一点点圆，与右上角原生刘海肩对称
// （用户多次反馈凹肩外扩偏大，10×24→7×28→最终 3×10，逐步收窄到几乎不外扩）。
const BAR_SHOULDER = 3
const BAR_SHOULDER_H = 10
/** 收起态窗口在黑条「下方」额外预留的高度（px）。给 running 小人「踩出」黑条下沿留空间——
 *  小人盒子放大到超过黑条高、底部伸出黑条外，整体显著变大。仅加窗口下沿（透明区），
 *  不动顶部 y:0 / 顶角 / 凹肩，故不影响黑条贴合刘海（见 collapsedBounds 的 height）。 */
const RUNNER_FOOT_ROOM = 12

/**
 * 灵动岛锚定的「刘海所在显示器」——始终是内建屏（MacBook 本体），与谁是主屏无关。
 *
 * 外接显示器场景：用户常把外接屏设为主屏（菜单栏在外接屏），此时 `getPrimaryDisplay()`
 * 会指向外接屏，灵动岛就跑到外接屏上了。改用 `.internal`（Electron 标记内建屏）锁定本体；
 * 找不到内建屏（极少数：纯外接 / 合盖 clamshell）时退化到菜单栏预留区最高的那块（刘海屏
 * 菜单栏 ~38pt 高于普通屏 ~24pt），再退到主屏兜底。
 */
function getNotchDisplay(): Electron.Display {
  const all = screen.getAllDisplays()
  const internal = all.find((d) => d.internal)
  if (internal) return internal
  return all.reduce((best, d) => (d.workArea.y > best.workArea.y ? d : best), all[0])
}

/**
 * 使用 JXA (JavaScript for Automation) 从 macOS NSScreen 读取刘海精确宽 + 高。
 *
 * 关键：刘海高度取 `auxiliaryTopLeftArea.size.height`（菜单栏在刘海左侧的辅助区，与刘海等高），
 * **不是** Electron 的 `workArea.y`——后者是「菜单栏预留区」，本机实测 38pt，比刘海真实高度
 * 24pt 大 14pt；若用它当黑条高度，黑条会比刘海矮沿低出 14pt，无法与刘海齐平（见用户反馈）。
 *
 * auxiliaryTopLeftArea / TopRightArea 在 macOS 12+ 刘海机型可用；非刘海机型返回 nil（→ w:0），
 * 据此判定「是否刘海机型」。JXA 失败 / 超时 → 用 workArea.y 启发式兜底。
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

  let notchW = 0
  let notchH = 0
  try {
    const r = await runCommand(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', jxaScript],
      undefined,
      2000
    )
    if (r.code === 0 && r.stdout.trim()) {
      const parsed = JSON.parse(r.stdout.trim()) as { w?: number; h?: number }
      notchW = parsed.w ?? 0
      notchH = parsed.h ?? 0
    }
  } catch (_) {
    void audit('island.notch_detect_failed', {})
  }

  // JXA 明确测到刘海（辅助区存在 → 宽高都 > 0）：用实测值
  if (notchW > 0 && notchH > 0) {
    return {
      hasNotch: true,
      width: Math.round(notchW),
      cornerRadius: 10,
      height: Math.round(notchH)
    }
  }

  // 兜底：JXA 不可用 / 无刘海辅助区（如 Mac mini 外接显示器）时，用该屏 workArea.y 判定
  // 是否刘海机型（普通菜单栏 ≤ 30pt）。刘海高 ≈ 菜单栏高（实测两者基本相等：本机
  // auxArea.h=38 ≈ workArea.y=39）。
  const menuBarH = notchDisplay.workArea.y
  if (menuBarH <= 30) {
    // 非刘海机型：仍把实测菜单栏高带回去（hasNotch:false），供收起态黑条按此校准高度。
    // 之前这里直接 return null 把 menuBarH 丢弃，黑条只能退回写死的 46px 默认值，比外接
    // 显示器真实菜单栏（约 24px）高出近一倍，视觉上盖进下方窗口内容（用户反馈：灵动岛高度
    // 与浏览器窗口没对齐）。
    return { hasNotch: false, width: 0, cornerRadius: 0, height: menuBarH }
  }
  void audit('island.notch_detect_estimated', { menuBarH })
  return {
    hasNotch: true,
    width: notchDisplay.bounds.width >= 1600 ? 220 : 160,
    cornerRadius: 10,
    height: menuBarH
  }
}

/** 收起态黑条窗口左上角 + 尺寸：始终锚定刘海所在的内建屏（与主屏无关），贴刘海左侧、等高。 */
function collapsedBounds(): { x: number; y: number; width: number; height: number } {
  const disp = getNotchDisplay()
  if (islandNotchInfo?.hasNotch) {
    const { x: sx, y: sy, width: sw } = disp.bounds
    // 刘海水平居中于内建屏 → 其左缘 X。黑条主体宽 COLLAPSED_BAR_WIDTH，右缘钻进刘海背后
    // BAR_OVERLAP（盖住接缝）；左缘再外延 BAR_SHOULDER 给凹形肩 melt 的透明空间。
    // y 取内建屏的 bounds.y（多屏时内建屏原点可能非 0），使黑条贴在内建屏自身的顶端。
    const notchLeftX = sx + sw / 2 - islandNotchInfo.width / 2
    return {
      x: Math.round(notchLeftX - COLLAPSED_BAR_WIDTH - BAR_SHOULDER),
      y: sy,
      width: COLLAPSED_BAR_WIDTH + BAR_SHOULDER + BAR_OVERLAP,
      // 窗口比黑条（= 刘海高）高出 RUNNER_FOOT_ROOM：多出的部分在黑条「下方」、透明，
      // 供 running 小人踩出黑条下沿。黑条本体仍 = 刘海高，顶部贴合完全不变。
      height: islandNotchInfo.height + RUNNER_FOOT_ROOM
    }
  }
  const { x: waX, width: waWidth } = disp.workArea
  return {
    x: Math.round(waX + (waWidth - ISLAND_WIDTH) / 2),
    y: disp.bounds.y, // 非刘海屏：置于该屏顶部
    width: ISLAND_WIDTH,
    height: ISLAND_COLLAPSED_HEIGHT
  }
}

/**
 * 创建灵动岛窗口：透明、无边框、置顶、不进任务栏。
 * macOS 刘海机型贴刘海左侧、与刘海等高连成长方形；非刘海 / 其它平台降级为屏幕顶部居中悬浮条。
 */
function createIslandWindow(): void {
  const b = collapsedBounds()

  islandWindow = new BrowserWindow({
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
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  islandWindow.setAlwaysOnTop(true, 'screen-saver')
  islandWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // macOS 在构造时会把落在菜单栏区域的 y:0 夹到菜单栏下方（普通层级窗口不准盖菜单栏）。
  // 上面把层级提到 screen-saver 后，必须重新 setBounds 才能真正把窗口顶端顶回屏幕最顶、
  // 与刘海齐平——否则黑条会卡在菜单栏下方一行（看起来像浮在壁纸上而非续接刘海）。
  islandWindow.setBounds(b)

  islandWindow.on('ready-to-show', () => {
    // 窗口完全成形后再断言一次位置，防止构造期的迟到夹取把 y 又压下去。
    islandWindow?.setBounds(collapsedBounds())
    islandWindow?.show()
  })
  islandWindow.on('closed', () => {
    islandWindow = null
  })

  // 渲染端只有灵动岛一块，无需 #island hash 路由（已废弃，直接加载根）。
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void islandWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void islandWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * 装配灵动岛：环回 HTTP server + 状态机 + 审批回环 + transcript watcher + 窗口 + IPC。
 * 任一步骤失败均 audit 后降级（不阻塞启动）。
 */
async function setupIsland(deps: {
  launcher: (
    options: import('./services/terminal-launcher').LaunchOptions
  ) => Promise<import('./services/claude-notify-types').ClaudeNotifyOpenSessionResult>
  getTerminalApp: () => string
}): Promise<void> {
  try {
    const config = await ensureIslandConfig({ audit })
    // 启动时把 settings.json 里的 trustAll 同步写入 island.json（hook 从此读取）
    const initTrustAll = settingsService?.getSettings().trustAll === true
    if (config.trustAll !== initTrustAll) {
      await patchIslandConfig({ trustAll: initTrustAll })
    }

    // 在创建窗口前检测刘海尺寸；失败时降级为顶部居中宽条模式
    islandNotchInfo = await detectNotchInfo()
    if (islandNotchInfo) {
      // 无论是否真刘海，都用实测高度校准收起态黑条高度——非刘海机型（如外接显示器）也有
      // 自己的真实菜单栏高，不能再退回写死的 46px 默认值。
      ISLAND_COLLAPSED_HEIGHT = islandNotchInfo.height
      if (islandNotchInfo.hasNotch) {
        // 收起态黑条：贴刘海左侧、与刘海等高。窗口 = 黑条宽 + 钻进刘海背后的 overlap。
        ISLAND_WIDTH = COLLAPSED_BAR_WIDTH + BAR_OVERLAP
      }
    }

    const state = new IslandState({ audit })
    islandState = state
    // 周期性把陈旧的 running 会话降级为 idle（兜底 Stop 丢失 / 斜杠命令卡死）
    state.startStaleSweep()
    const registry = new ApprovalRegistry({ audit })
    islandRegistry = registry

    // 岛内审批键盘直达：有待审批请求时注册全局快捷键，无需先点亮/聚焦灵动岛即可裁决队首请求——
    // 用户可一边盯终端一边一键放行/Bypass（FR-007 直接在岛内操作）。仅在 pending>0 期间占用，
    // 队列清空即注销，把对系统级快捷键的拦截窗口压到最小。Deny 刻意不配键（避免误触一键拒绝）。
    let approveShortcutsActive = false
    const APPROVAL_SHORTCUTS: Array<{ accel: string; decision: ApprovalDecision }> = [
      { accel: 'Control+Y', decision: 'allow_once' },
      { accel: 'Control+B', decision: 'bypass' }
    ]
    const syncApproveShortcuts = (): void => {
      const shouldActivate = registry.pending().length > 0
      if (shouldActivate === approveShortcutsActive) return
      if (shouldActivate) {
        for (const { accel, decision } of APPROVAL_SHORTCUTS) {
          const ok = globalShortcut.register(accel, () => {
            const head = registry.pending()[0]
            if (!head) return
            registry.resolve(head.requestId, decision)
            void audit('island.approval_shortcut', { requestId: head.requestId, decision })
          })
          if (!ok) void audit('island.approval_shortcut_register_failed', { accel })
        }
        approveShortcutsActive = true
      } else {
        for (const { accel } of APPROVAL_SHORTCUTS) globalShortcut.unregister(accel)
        approveShortcutsActive = false
      }
    }

    // 状态变更 / 审批请求 → 推送灵动岛窗口
    state.on('change', (sessions: SessionState[]) => {
      islandWindow?.webContents.send('island:update', sessions)
    })
    registry.on('request', (req: ApprovalRequest) => {
      islandWindow?.webContents.send('island:approval', req)
      syncApproveShortcuts()
    })
    registry.on('resolved', (payload: { requestId: string }) => {
      islandWindow?.webContents.send('island:approval-resolved', payload.requestId)
      syncApproveShortcuts()
    })

    islandServer = await createIslandServer({ config, state, registry, audit })

    const projectsDir = join(app.getPath('home'), '.claude', 'projects')
    islandWatcher = createTranscriptWatcher({ projectsDir, state, audit })

    registerIslandIpc(ipcMain, {
      state,
      registry,
      launcher: deps.launcher,
      getTerminalApp: deps.getTerminalApp,
      // 跳转匹配 needle 取会话的 Claude 自动标题（transcript 里的 ai-title）——它正是
      // Ghostty tab 名正文，比 prompt 首行可靠。点击时按 sessionId 现读 transcript。
      resolveMatchTitle: (id) => readAiTitle(projectsDir, id)
    })

    // 渲染端查询刘海几何 + 渲染所需的派生尺寸。
    // height（刘海实高，本机 24）：收起态黑条用，确保与刘海齐平。
    // topInset（菜单栏完整预留高 workArea.y，本机 38）：展开态面板上方透明占位用——面板要落到
    // 完整菜单栏下方而非刘海下方（刘海仅 24，菜单栏到 38），否则面板顶部会钻进菜单栏区域。
    ipcMain.handle('island:getNotchInfo', () => {
      if (!islandNotchInfo) return null
      const menuBarH = getNotchDisplay().workArea.y
      return {
        ...islandNotchInfo,
        overlap: BAR_OVERLAP, // 黑条右端钻进刘海背后的像素（CSS 用作内容右 padding 让位）
        shoulder: BAR_SHOULDER, // 左上椭圆凹肩水平半径（= 左侧透明预留宽）
        shoulderH: BAR_SHOULDER_H, // 左上椭圆凹肩垂直半径（> 水平 → 更陡）
        topInset: Math.max(islandNotchInfo.height, menuBarH), // 展开态面板上方透明占位
        barWidth: COLLAPSED_BAR_WIDTH
      }
    })

    // 渲染端请求收起 / 展开时调整窗口（始终锚定刘海所在的内建屏）：
    // - 收起（黑条）：贴刘海左侧、与刘海等高，几何由 collapsedBounds 决定（忽略传入尺寸）
    // - 展开（面板）：左缘锚定黑条左缘向右下展开，y 贴内建屏顶 + 顶部透明占位让面板落在刘海下方
    ipcMain.handle('island:resize', async (_evt, arg: unknown): Promise<void> => {
      if (!islandWindow) return
      const a = (arg ?? {}) as { expanded?: unknown; width?: unknown; height?: unknown }
      const num = (v: unknown, def: number, max: number): number =>
        typeof v === 'number' && v > 0 ? Math.min(Math.round(v), max) : def
      const disp = getNotchDisplay()

      if (a.expanded !== true) {
        islandWindow.setBounds(collapsedBounds())
        return
      }

      const w = num(a.width, ISLAND_WIDTH, 1200)
      const h = num(a.height, ISLAND_COLLAPSED_HEIGHT, 900)
      const { x: sx, y: sy, width: sw } = disp.bounds
      let x: number
      if (islandNotchInfo?.hasNotch) {
        // 与收起态黑条同左缘，向右下展开；右溢出则左移夹住，保证整窗在内建屏内
        const notchLeftX = sx + sw / 2 - islandNotchInfo.width / 2
        const barLeftX = Math.round(notchLeftX - COLLAPSED_BAR_WIDTH)
        x = Math.max(sx + 4, Math.min(barLeftX, sx + sw - w - 4))
      } else {
        x = Math.round(disp.workArea.x + (disp.workArea.width - w) / 2)
      }
      islandWindow.setBounds({ x, y: sy, width: w, height: h })
    })

    // 点击穿透开关：渲染端在「收起且未 hover、无审批」时请求 ignore=true，让刘海两侧
    // 透明区域的点击穿透到菜单栏 / 下层应用。forward:true 仍转发 move 事件，故穿透态下
    // pill 的 onMouseEnter 仍能触发以重新激活交互。默认（未收到调用）为可交互，安全兜底。
    ipcMain.handle('island:setMouseIgnore', async (_evt, ignore: unknown): Promise<void> => {
      islandWindow?.setIgnoreMouseEvents(ignore === true, { forward: true })
    })

    createIslandWindow()

    // 显示器拓扑变化（插拔外接屏 / 改主屏 / 分辨率变化）→ 重新检测刘海并把岛拉回内建屏。
    // 不重新检测的话：① 岛可能停留在已拔掉的屏的坐标（变成不可见）；② 内建屏分辨率/缩放
    // 变了刘海宽高会变。debounce 250ms 合并 macOS 切换拓扑时的连串事件。
    let repositionTimer: NodeJS.Timeout | null = null
    const scheduleReposition = (): void => {
      if (repositionTimer) clearTimeout(repositionTimer)
      repositionTimer = setTimeout(() => {
        repositionTimer = null
        void (async () => {
          if (!islandWindow) return
          islandNotchInfo = await detectNotchInfo()
          if (islandNotchInfo) {
            ISLAND_COLLAPSED_HEIGHT = islandNotchInfo.height
            if (islandNotchInfo.hasNotch) {
              ISLAND_WIDTH = COLLAPSED_BAR_WIDTH + BAR_SHOULDER + BAR_OVERLAP
            }
          }
          islandWindow.setBounds(collapsedBounds())
          // 几何变了 → 重新下发给渲染端刷新 CSS 变量（刘海宽高可能已变）
          islandWindow.webContents.send('island:notch-changed')
          void audit('island.repositioned', { display: getNotchDisplay().id })
        })()
      }, 250)
    }
    screen.on('display-added', scheduleReposition)
    screen.on('display-removed', scheduleReposition)
    screen.on('display-metrics-changed', scheduleReposition)
  } catch (err) {
    await audit('island.setup_failed', { error: (err as Error).message })
    // 半启动回滚：避免留下「占着 7842 端口 / staleSweep 仍在转 / 无窗口」的僵尸态
    islandState?.stopStaleSweep()
    islandWatcher?.close()
    void islandServer?.close()
  }
}

/** 当前生效的终端 app（默认 Ghostty），供 island openSession 跳回终端。 */
function resolveTerminalApp(s: { terminalApp?: unknown }): string {
  const v = s.terminalApp
  const trimmed = typeof v === 'string' ? v.trim() : ''
  return trimmed || 'Ghostty'
}

/** hook 安装脚本路径：打包态从 Resources/tools 读（extraResources），dev 态从仓库 tools/ 读。 */
function installerScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tools', 'island-hooks-install.mjs')
    : join(__dirname, '../../tools/island-hooks-install.mjs')
}

/**
 * 跑 hook 安装/卸载脚本，结果弹原生对话框。
 *
 * 用 Electron 自带的 Node（`process.execPath` + `ELECTRON_RUN_AS_NODE`）执行，**不依赖**
 * 系统 `node`——打包后的 .app 从 Finder 启动时 PATH 极简（常缺 node / homebrew 路径），
 * 直接 spawn('node') 会 ENOENT。写进 settings.json 的 hook 命令仍是 `node …`，那条由
 * Claude Code 在终端环境执行（PATH 正常），不受影响。
 */
async function runHookInstaller(uninstall: boolean): Promise<void> {
  const script = installerScriptPath()
  const r = await runCommand(process.execPath, uninstall ? [script, '--uninstall'] : [script], {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1'
  })
  const ok = r.code === 0
  await dialog.showMessageBox({
    type: ok ? 'info' : 'error',
    title: 'Vibe Monitor',
    message: ok
      ? uninstall
        ? '已移除 Claude Code hooks'
        : '已注册 Claude Code hooks'
      : 'hook 操作失败',
    detail: (ok ? r.stdout : r.stderr || r.stdout).trim().slice(0, 600) || `exit ${r.code}`
  })
}

/** 落盘设置补丁；'change' 事件会触发托盘菜单刷新 + 推送渲染端。 */
async function saveSettingsPatch(patch: Record<string, unknown>): Promise<void> {
  await settingsService?.save(patch)
}

/** 重建托盘菜单——勾选态（终端 / 音效 / 自启 / 显隐）随当前 settings 实时刷新。 */
function refreshTrayMenu(): void {
  if (!tray) return
  const s = settingsService?.getSettings() ?? {}
  const currentTerm = resolveTerminalApp(s)
  const soundOn = s.islandSoundEnabled !== false
  const trustAllOn = s.trustAll === true
  const loginOn = app.getLoginItemSettings().openAtLogin

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: islandWindow?.isVisible() ? '隐藏灵动岛' : '显示灵动岛',
        click: () => {
          if (!islandWindow) return
          if (islandWindow.isVisible()) islandWindow.hide()
          else islandWindow.show()
          refreshTrayMenu()
        }
      },
      { type: 'separator' },
      {
        label: '终端 App',
        submenu: TERMINAL_APPS.map((name) => ({
          label: name,
          type: 'radio' as const,
          checked: currentTerm === name,
          click: () => void saveSettingsPatch({ terminalApp: name })
        }))
      },
      {
        label: '状态音效',
        type: 'checkbox',
        checked: soundOn,
        click: () => void saveSettingsPatch({ islandSoundEnabled: !soundOn })
      },
      {
        label: '跳过审批',
        type: 'checkbox',
        checked: trustAllOn,
        click: () => void saveSettingsPatch({ trustAll: !trustAllOn })
      },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: loginOn,
        click: () => {
          app.setLoginItemSettings({ openAtLogin: !loginOn })
          refreshTrayMenu()
        }
      },
      { type: 'separator' },
      { label: '注册 Claude Code hooks…', click: () => void runHookInstaller(false) },
      { label: '移除 Claude Code hooks…', click: () => void runHookInstaller(true) },
      { type: 'separator' },
      { label: '退出 Vibe Monitor', click: () => app.quit() }
    ])
  )
}

/** 创建菜单栏托盘（灵动岛唯一的退出 / 设置入口）。 */
function createTray(): void {
  const img = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  img.setTemplateImage(true)
  tray = new Tray(img)
  tray.setToolTip('Vibe Monitor')
  refreshTrayMenu()
}

app.whenReady().then(async () => {
  app.setName('Vibe Monitor')
  setAuditRoot(VIBE_DIR)

  settingsService = new SettingsService({ rootDir: VIBE_DIR })
  await settingsService.load()
  registerSettingsIpc(ipcMain, settingsService)

  // islandEnabled 总开关：显式 false 时不创建窗口/server 直接退出——否则主进程仍会
  // 造一个透明置顶窗口，渲染端只画空 div，留下一条看不见却拦截点击的「鼠标陷阱」。
  if (settingsService.getSettings().islandEnabled === false) {
    await audit('island.disabled_by_setting', {})
    app.quit()
    return
  }

  const launchToTerminal = createLauncher({
    runCommand,
    clipboard,
    platform: process.platform,
    audit,
    // 确保 macOS「切换应用时跳到其窗口所在 Space」开关开启，使位于其它虚拟桌面的
    // Ghostty 也能被 activate 切过去（首个进程生命周期内最多触发一次 killall Dock）。
    ensureSpaceAutoSwitch: createEnsureSpaceAutoSwitch({
      runCommand,
      platform: process.platform,
      audit
    })
  })
  const getTerminalApp = (): string => resolveTerminalApp(settingsService?.getSettings() ?? {})

  await setupIsland({ launcher: launchToTerminal, getTerminalApp })

  // settings 变更（来自托盘/渲染端）→ 推送渲染端（即时生效）+ 刷新托盘 + 同步 trustAll 到 island.json。
  settingsService.on('change', (s: Record<string, unknown>) => {
    islandWindow?.webContents.send('settings:changed', s)
    refreshTrayMenu()
    void patchIslandConfig({ trustAll: s.trustAll === true })
  })

  createTray()

  app.on('activate', () => {
    // 灵动岛被关闭后（macOS 重新激活）重建。
    if (islandWindow === null) createIslandWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  globalShortcut.unregisterAll()
  screen.removeAllListeners('display-added')
  screen.removeAllListeners('display-removed')
  screen.removeAllListeners('display-metrics-changed')
  islandState?.stopStaleSweep()
  islandRegistry?.drain()
  islandWatcher?.close()
  void islandServer?.close()
  tray?.destroy()
})
