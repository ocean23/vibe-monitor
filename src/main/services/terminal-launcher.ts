import type {
  ClaudeNotifyOpenSessionMode,
  ClaudeNotifyOpenSessionResult
} from './claude-notify-types'
import type { AuditFn } from '../audit-log'

export interface LaunchOptions {
  /** 来自 Settings.terminalApp（如 'Ghostty' / 'iTerm' / 'Terminal'） */
  app: string
  /** Claude Code session id，非空（由 ipc 层校验） */
  sessionId: string
  /** hook 上报的 session_name；空字符串 / undefined 时跳过 tab 匹配，走 activated_copied */
  sessionName?: string
}

export type LaunchResult = ClaudeNotifyOpenSessionResult

export interface RunCommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface LauncherDeps {
  /** 注入点，便于单测 mock；包装 child_process.spawn */
  runCommand: (cmd: string, args: string[]) => Promise<RunCommandResult>
  /** Electron clipboard 的最小接口 */
  clipboard: { writeText: (text: string) => void }
  /** 通常是 `process.platform`，注入便于单测覆盖 non-darwin 分支 */
  platform: NodeJS.Platform
  audit: AuditFn
  /**
   * 可选：在 app 已运行、即将 activate / reveal 前，确保 macOS「切换应用时跳到其
   * 窗口所在 Space」开关已开启（见 {@link createEnsureSpaceAutoSwitch}）。未注入时
   * 跳过——单测无需关心此步；生产由 main 注入，使跨虚拟桌面的 Ghostty 也能被切到。
   */
  ensureSpaceAutoSwitch?: () => Promise<void>
}

/**
 * AppleScript 字符串字面量转义：先反斜杠（次序重要，避免双重转义）再双引号，
 * 最后转义控制字符 `\n` / `\r` / `\t` —— AppleScript 双引号字符串中这些字符
 * 会被解释为换行 / 回车 / 制表符（而非字面两字符），不转义可能改变脚本语义
 * 或在 lookup 阶段不命中（如 `name of t contains "foo\nbar"` 会找不到含字面
 * `\n` 的 tab 名）。
 *
 * 适用于把 sessionId / sessionName / app 名嵌入 osascript -e 的字符串。
 */
export function escapeAppleScript(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

/** "应用是否在运行" 检测脚本：通过 System Events 查 process 是否存在。 */
function buildIsRunningScript(app: string): string {
  const esc = escapeAppleScript(app)
  return `tell application "System Events" to (exists (processes whose name is "${esc}"))`
}

/**
 * 列出该 app 所有 window 的所有 tab，过滤 name 包含 needle 的。
 * 输出 `windowName||tabIndex||tabCount||tabName` 每行一条；不支持 tab 模型的 app 会在 tell 块内抛错，由调用方 catch 后走降级。
 *
 * **为何用 windowName 而非 windowIndex**：Ghostty 的 window class 是 `«Gwnd»`，
 * 不支持 `index of window`（实测 `-1700`）；但所有终端 app 的 window 都有 name。
 * 后续 AXRaise 步骤用 System Events 按 `title contains "<windowName>"` 定位窗口。
 *
 * `tabCount` 用于 inject 阶段判断是否需要 Cmd+digit 切 tab（=1 时跳过）。
 */
function buildFindTabScript(app: string, needle: string): string {
  const escApp = escapeAppleScript(app)
  const escNeedle = escapeAppleScript(needle)
  return `tell application "${escApp}"
set hits to ""
repeat with w in windows
  set wName to (name of w as string)
  set tCount to count of tabs of w
  set tIdx to 0
  repeat with t in tabs of w
    set tIdx to tIdx + 1
    if (name of t as string) contains "${escNeedle}" then
      set hits to hits & wName & "||" & (tIdx as string) & "||" & (tCount as string) & "||" & (name of t as string) & "\n"
    end if
  end repeat
end repeat
return hits
end tell`
}

/** 仅激活该 app，不切 tab、不 keystroke。 */
function buildActivateScript(app: string): string {
  const esc = escapeAppleScript(app)
  return `tell application "${esc}" to activate`
}

/**
 * 把指定 window/tab 提到最前（**只跳转、不注入任何命令**）。
 *
 * vibe-monitor 监控的是本机**活着的** Claude 会话——目标 tab 里 Claude 正在运行，
 * 点击卡片只需把那个窗口/tab 切到最前给用户看；**绝不能**再 keystroke `claude resume`，
 * 否则会把这串命令直接打进正在运行的会话输入框里（用户实测困扰）。故本脚本只做
 * 「提窗 + 切 tab」两步，不再有第三步键入。
 *
 * **为何走 System Events 而非 app 自己的 AppleScript dictionary**（issue #19 实证）：
 * - Ghostty 的 AppleScript dictionary 是**只读**的——`set frontmost of window` /
 *   `set selected of tab` / `select <tab>` 全部报 `-10006` Access not allowed
 * - 但 macOS 通用 Accessibility API（`tell System Events to tell process "<app>"`）
 *   不受此限制：`perform action "AXRaise" of window` 可以把目标窗口提到最前
 * - 切 tab 用 `keystroke "<idx>" using command down` 触发 app 的默认 Cmd+digit
 *   绑定（Ghostty / iTerm 默认绑定 Cmd+1~9 切 tab）
 *
 * **为何「先 AXRaise 目标窗口、再 activate」（顺序关键，跨 Space 跳转的核心）**：
 * `AXRaise` 只在窗口服务器内重排、**不切虚拟桌面**；真正把用户带到目标窗口所在
 * Space 的是 `activate` —— 但仅当 macOS「切换应用时跳到其窗口所在 Space」开关
 * （`workspaces-auto-swoosh`，由 {@link createEnsureSpaceAutoSwitch} 确保开启）打开时
 * 才生效。开启后 `activate` 会跳到 app **最前窗口**所在的 Space；故必须先 AXRaise 把
 * **目标**窗口提为最前，再 activate，swoosh 才会落到目标窗口（而非碰巧最近用过的
 * 另一个 Ghostty 窗口）所在的桌面。反过来「先 activate 再 AXRaise」在多窗口跨多桌面
 * 时会先跳错桌面、再 AXRaise 又无法拉回，停在错误 Space。
 *
 * 因此本脚本顺序为：
 * 1. System Events AXRaise 目标窗口（按 windowName 定位）
 * 2. `tell application <app> to activate`（swoosh 把当前桌面切到目标窗口所在 Space）
 * 3. （仅当 tabCount > 1）在 Ghostty 进程内发 `keystroke "<tabIndex>" using command down`
 *    切 tab；`delay 0.5` 让 Space 切换动画落定（动画通常需 0.3~0.4s），且 keystroke
 *    通过 `tell process` 定向发给 Ghostty 而非全局 frontmost，避免动画未完成时打到
 *    错误窗口
 *
 * **兼容性**：
 * - Ghostty / iTerm / iTerm2 / Terminal.app —— System Events AXRaise + Cmd+digit 都可用
 * - 不支持 tab 模型的 app（Alacritty / Warp / WezTerm）—— findTab 阶段已经走降级，
 *   本脚本不会被调用到
 *
 * **需要 macOS 辅助功能权限**（AXRaise + Cmd+digit keystroke 共用同一授权），失败时
 * 调用方走降级（剪贴板 + 仅激活）。
 */
function buildRevealScript(
  app: string,
  windowName: string,
  tabIndex: number,
  tabCount: number
): string {
  const escApp = escapeAppleScript(app)
  const escWin = escapeAppleScript(windowName)
  const switchTab =
    tabCount > 1
      ? `
delay 0.5
tell application "System Events" to tell process "${escApp}"
  keystroke "${tabIndex}" using command down
end tell`
      : ''
  return `tell application "System Events" to tell process "${escApp}"
  set targetWindows to (every window whose title contains "${escWin}")
  if (count of targetWindows) is 0 then error "no-matching-system-event-window"
  perform action "AXRaise" of (item 1 of targetWindows)
end tell
delay 0.1
tell application "${escApp}" to activate${switchTab}`
}

/**
 * 解析 findTab 脚本输出：每行 `windowName||tabIndex||tabCount||tabName`（`||` 分隔，
 * 避免 tab 标题中包含 `|` 导致歧义），空行忽略，tabIndex/tabCount 非整数行跳过。
 */
export interface TabHit {
  windowName: string
  tabIndex: number
  tabCount: number
  tabName: string
}
export function parseTabHits(stdout: string): TabHit[] {
  const hits: TabHit[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split('||')
    if (parts.length < 4) continue
    const tIdx = Number.parseInt(parts[1], 10)
    const tCount = Number.parseInt(parts[2], 10)
    if (!Number.isFinite(tIdx) || !Number.isFinite(tCount)) continue
    hits.push({
      windowName: parts[0],
      tabIndex: tIdx,
      tabCount: tCount,
      tabName: parts.slice(3).join('||')
    })
  }
  return hits
}

/**
 * stderr 含此关键字视为 macOS **辅助功能**权限未授予（AXRaise / keystroke 失败）。
 *
 * 与 {@link isAutomationPermissionError} 区分：辅助功能 = `tell System Events` 系列
 * 调用所需授权；自动化 = `tell application "<other-app>"` 系列调用所需授权。两套 TCC
 * 授权在系统设置里分属「辅助功能」与「自动化」面板，需独立勾选。
 */
function isPermissionError(stderr: string): boolean {
  // macOS osascript 在拒绝时常见短语：`(-1719)` `not allowed assistive access`
  // 注：-1743 不再共用本判定——见 isAutomationPermissionError
  return /not allowed|-1719|assistive access/i.test(stderr)
}

/**
 * stderr 含此关键字视为 vibe-monitor 缺少对**目标 app 的自动化**授权。
 *
 * 触发场景：`tell application "Ghostty" to ...` 在 vibe-monitor→Ghostty 这对 TCC 未授权时
 * 返回 `-1743 Not authorized to send Apple events`（或 UK 拼法 `Not authorised`）。findTab
 * 脚本的失败语义可能是「app 不支持 tab 模型（如 Alacritty）」或「自动化未授权」，前者
 * 走原 `no-matching-tab` 降级、后者走独立 `no-automation-permission` 通道，便于渲染
 * 端给精确指引（系统设置 → 隐私与安全性 → 自动化 → Vibe Monitor → 勾选 \<terminalApp\>）。
 */
export function isAutomationPermissionError(stderr: string): boolean {
  // [sz] 覆盖 UK "authorised" + US "authorized" 双拼；issue #21 review P2-1：原写法
  // `authoris(e|ed)` 漏掉了 US "authorized"（含 z）。-1743 错误码兜底，但若未来 macOS
  // 版本只输出文本不带 error code，单走文本判定时双拼必须都命中。
  return /-1743|Not authori[sz]ed to send Apple events/i.test(stderr)
}

function buildCommandText(sessionId: string): string {
  return `claude resume ${sessionId}`
}

/**
 * 创建一个 `launchToTerminal` 函数，把"启动 / 找 tab / 注入 / 降级"编排封装起来。
 *
 * 设计原则：
 * - 主流程 `try` 链不向调用方抛异常；任何子步骤失败都通过 audit 留痕并走预定降级路径
 * - 非 macOS 平台直接降级到 copied_only，AppleScript 路径完全不执行
 * - 多匹配 / 零匹配 / 无 sessionName / 无权限 → 统一走 activated_copied，reason 字段细分
 */
export function createLauncher(
  deps: LauncherDeps
): (options: LaunchOptions) => Promise<LaunchResult> {
  return async function launchToTerminal(options: LaunchOptions): Promise<LaunchResult> {
    const { app, sessionId, sessionName } = options
    const commandText = buildCommandText(sessionId)

    if (deps.platform !== 'darwin') {
      deps.clipboard.writeText(commandText)
      return { ok: true, mode: 'copied_only' }
    }

    let running = false
    try {
      const probe = await deps.runCommand('osascript', ['-e', buildIsRunningScript(app)])
      running = probe.code === 0 && probe.stdout.trim() === 'true'
    } catch (err) {
      await deps.audit('claude_notify.launcher_failed', {
        step: 'isRunning',
        error: (err as Error).message
      })
    }

    if (!running) {
      try {
        const r = await deps.runCommand('open', ['-a', app])
        if (r.code !== 0) {
          deps.clipboard.writeText(commandText)
          return {
            ok: false,
            mode: 'copied_only',
            reason: 'launch-failed: ' + r.stderr.trim().slice(0, 200)
          }
        }
        return { ok: true, mode: 'launched_only' }
      } catch (err) {
        await deps.audit('claude_notify.launcher_failed', {
          step: 'open',
          error: (err as Error).message
        })
        deps.clipboard.writeText(commandText)
        return { ok: false, mode: 'copied_only', reason: 'launch-failed' }
      }
    }

    // app 已在运行 → 此后所有路径（reveal 或仅 activate 的降级）都可能需要跨虚拟桌面，
    // 先确保「切换应用时跳到其窗口所在 Space」开关已开启，否则别的桌面的 Ghostty 切不过去。
    await deps.ensureSpaceAutoSwitch?.()

    const fallbackToActivated = async (reason: string): Promise<LaunchResult> => {
      deps.clipboard.writeText(commandText)
      try {
        const r = await deps.runCommand('osascript', ['-e', buildActivateScript(app)])
        if (r.code !== 0) {
          await deps.audit('claude_notify.launcher_failed', {
            step: 'activate',
            stderr: r.stderr.slice(0, 200)
          })
        }
      } catch (err) {
        await deps.audit('claude_notify.launcher_failed', {
          step: 'activate',
          error: (err as Error).message
        })
      }
      return { ok: true, mode: 'activated_copied', reason }
    }

    const needle = (sessionName ?? '').trim()
    if (!needle) {
      return fallbackToActivated('no-session-name')
    }

    let hits: TabHit[] = []
    try {
      const find = await deps.runCommand('osascript', ['-e', buildFindTabScript(app, needle)])
      if (find.code !== 0) {
        // 优先识别「vibe-monitor→app 自动化授权缺失」（-1743）——必须区别于「app 不支持 tab 模型」
        // 等其它失败，否则用户被误导去改 tab 标题（issue #21 根因）。
        if (isAutomationPermissionError(find.stderr)) {
          return fallbackToActivated('no-automation-permission')
        }
        // 其余失败（如 Alacritty 无 tabs 属性、脚本语义错误）—— 视作未匹配，走降级。
        return fallbackToActivated('no-matching-tab')
      }
      hits = parseTabHits(find.stdout)
    } catch (err) {
      await deps.audit('claude_notify.launcher_failed', {
        step: 'findTab',
        error: (err as Error).message
      })
      return fallbackToActivated('no-matching-tab')
    }

    if (hits.length === 0) return fallbackToActivated('no-matching-tab')
    if (hits.length > 1) return fallbackToActivated('multiple-matches')

    const hit = hits[0]
    // Ghostty / iTerm 默认 Cmd+digit 只覆盖 1~9；tab_index >= 10 时无快捷键可切，
    // 降级让用户手动 Cmd+V Enter（reason 区分以便渲染端给精准提示）。
    if (hit.tabCount > 1 && hit.tabIndex > 9) {
      return fallbackToActivated('tab-index-out-of-range')
    }
    try {
      const inj = await deps.runCommand('osascript', [
        '-e',
        buildRevealScript(app, hit.windowName, hit.tabIndex, hit.tabCount)
      ])
      if (inj.code === 0) {
        return { ok: true, mode: 'navigated', matchedTab: hit.tabName }
      }
      if (isPermissionError(inj.stderr)) {
        return fallbackToActivated('no-permission')
      }
      await deps.audit('claude_notify.launcher_failed', {
        step: 'inject',
        stderr: inj.stderr.slice(0, 200)
      })
      return fallbackToActivated('inject-failed')
    } catch (err) {
      await deps.audit('claude_notify.launcher_failed', {
        step: 'inject',
        error: (err as Error).message
      })
      return fallbackToActivated('inject-failed')
    }
  }
}

/** 默认导出 mode 枚举值，便于其他模块做穷举。 */
export const OPEN_SESSION_MODES: readonly ClaudeNotifyOpenSessionMode[] = [
  'navigated',
  'activated_copied',
  'launched_only',
  'copied_only',
  'no_session_id'
] as const
