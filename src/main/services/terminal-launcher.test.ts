import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createLauncher,
  escapeAppleScript,
  parseTabHits,
  type LauncherDeps,
  type RunCommandResult
} from './terminal-launcher'

/**
 * 用脚本内容关键字路由的假 runCommand：根据传入的 osascript 脚本片段返回预设结果。
 * 把每个 step 的预设 stub 链式注册，便于不同用例组合。
 *
 * ⚠️ **维护提醒**：路由的 regex pattern 与 `terminal-launcher.ts` 中
 * `buildIsRunningScript` / `buildFindTabScript` / `buildActivateScript` /
 * `buildRevealScript` 输出的 AppleScript 文本片段强耦合。修改这些 build* 函数
 * 时（如调整脚本结构、变量名）必须同步更新本文件中对应的 regex（如
 * `/exists \(processes/`、`/repeat with w in windows/`、`/set frontmost of window/`、
 * `/to activate$/`），否则路由失败会抛 `unmatched runCommand`，测试看似"过了"
 * 但实际未覆盖目标分支。
 */
function makeRunCommand(routes: Array<{ match: RegExp; result: RunCommandResult }>): {
  fn: LauncherDeps['runCommand']
  calls: Array<{ cmd: string; args: string[] }>
} {
  const calls: Array<{ cmd: string; args: string[] }> = []
  const fn: LauncherDeps['runCommand'] = async (cmd, args) => {
    calls.push({ cmd, args })
    const joined = `${cmd} ${args.join(' ')}`
    for (const r of routes) {
      if (r.match.test(joined)) return r.result
    }
    throw new Error(`unmatched runCommand: ${joined.slice(0, 120)}`)
  }
  return { fn, calls }
}

function makeDeps(
  routes: Array<{ match: RegExp; result: RunCommandResult }>,
  platform: NodeJS.Platform = 'darwin'
): {
  deps: LauncherDeps
  clipboard: { writeText: ReturnType<typeof vi.fn> }
  audit: ReturnType<typeof vi.fn>
  calls: Array<{ cmd: string; args: string[] }>
} {
  const { fn: runCommand, calls } = makeRunCommand(routes)
  const clipboard = { writeText: vi.fn() }
  const audit = vi.fn(async () => {})
  return { deps: { runCommand, clipboard, platform, audit }, clipboard, audit, calls }
}

const OK = (stdout = '', stderr = ''): RunCommandResult => ({ code: 0, stdout, stderr })
const FAIL = (stderr = '', code = 1): RunCommandResult => ({ code, stdout: '', stderr })

describe('escapeAppleScript', () => {
  it('escapes backslash before double-quote (order matters)', () => {
    expect(escapeAppleScript('a"b\\c')).toBe('a\\"b\\\\c')
  })

  it('returns plain string unchanged', () => {
    expect(escapeAppleScript('foo-bar 123')).toBe('foo-bar 123')
  })

  it('escapes control characters \\n / \\r / \\t to their AppleScript literal forms', () => {
    expect(escapeAppleScript('a\nb')).toBe('a\\nb')
    expect(escapeAppleScript('a\rb')).toBe('a\\rb')
    expect(escapeAppleScript('a\tb')).toBe('a\\tb')
    expect(escapeAppleScript('a\nb"c\\d')).toBe('a\\nb\\"c\\\\d')
  })

  it('preserves unicode (中文) which has no special meaning in AppleScript', () => {
    expect(escapeAppleScript('中文-foo_bar')).toBe('中文-foo_bar')
  })
})

describe('parseTabHits', () => {
  it('parses windowName||tabIndex||tabCount||tabName lines, ignoring blanks', () => {
    const out = 'my-app||1||1||my-app\n⠐ Create issue||2||3||✳ Claude Code\n\n'
    expect(parseTabHits(out)).toEqual([
      { windowName: 'my-app', tabIndex: 1, tabCount: 1, tabName: 'my-app' },
      { windowName: '⠐ Create issue', tabIndex: 2, tabCount: 3, tabName: '✳ Claude Code' }
    ])
  })

  it('preserves || in tab names by rejoining trailing parts', () => {
    expect(parseTabHits('win||1||1||name||with||sep\n')).toEqual([
      { windowName: 'win', tabIndex: 1, tabCount: 1, tabName: 'name||with||sep' }
    ])
  })

  it('skips lines with non-integer tabIndex / tabCount', () => {
    expect(parseTabHits('garbage\nwin||x||1||t\nwin||1||y||t\nok||2||2||name\n')).toEqual([
      { windowName: 'ok', tabIndex: 2, tabCount: 2, tabName: 'name' }
    ])
  })
})

describe('launchToTerminal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('non-darwin platform → copied_only and writes full command to clipboard', async () => {
    const { deps, clipboard, calls } = makeDeps([], 'win32')
    const result = await createLauncher(deps)({
      app: 'Ghostty',
      sessionId: 'abc-123',
      sessionName: 'mySession'
    })
    expect(result).toEqual({ ok: true, mode: 'copied_only' })
    expect(clipboard.writeText).toHaveBeenCalledWith('claude resume abc-123')
    expect(calls).toEqual([]) // no AppleScript invoked on non-darwin
  })

  it('darwin + app not running → launched_only via `open -a`', async () => {
    const { deps, clipboard, calls } = makeDeps([
      { match: /exists \(processes/, result: OK('false') },
      { match: /^open -a Ghostty$/, result: OK() }
    ])
    const result = await createLauncher(deps)({
      app: 'Ghostty',
      sessionId: 'abc-123',
      sessionName: 'mySession'
    })
    expect(result).toEqual({ ok: true, mode: 'launched_only' })
    expect(clipboard.writeText).not.toHaveBeenCalled()
    expect(calls[1].cmd).toBe('open')
    expect(calls[1].args).toEqual(['-a', 'Ghostty'])
  })

  it('darwin + app running + single tab match (tabCount=1) → navigated, skips Cmd+digit, AXRaise window by name, NO command keystroke', async () => {
    const { deps, clipboard, calls } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      {
        match: /tell application "Ghostty".*repeat with w in windows/s,
        result: OK('my-app||1||1||my-app\n')
      },
      // reveal 脚本：System Events AXRaise 提窗；tabCount=1 不切 tab、也不键入任何命令
      {
        match: /perform action "AXRaise"/,
        result: OK()
      }
    ])
    const result = await createLauncher(deps)({
      app: 'Ghostty',
      sessionId: 'a"b',
      sessionName: 'my-app'
    })
    expect(result).toEqual({ ok: true, mode: 'navigated', matchedTab: 'my-app' })
    expect(clipboard.writeText).not.toHaveBeenCalled()
    const revealScript = calls[2].args[1]
    // 用 windowName 而非 windowIndex 寻址；走 System Events AXRaise
    expect(revealScript).toContain('tell application "Ghostty" to activate')
    expect(revealScript).toContain('tell application "System Events" to tell process "Ghostty"')
    expect(revealScript).toContain('title contains "my-app"')
    expect(revealScript).toContain('perform action "AXRaise"')
    // tabCount=1：不应出现 Cmd+digit 切 tab
    expect(revealScript).not.toMatch(/using command down/)
    // 核心诉求：绝不能往会话里键入 `claude resume`
    expect(revealScript).not.toContain('claude resume')
    expect(revealScript).not.toMatch(/key code 36/)
  })

  it('darwin + multi-tab window (tabCount>1) → navigated, prepends Cmd+<tabIndex> using command down, still NO command keystroke', async () => {
    const { deps, calls } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      {
        match: /repeat with w in windows/,
        result: OK('⠐ Create issue||2||3||✳ Claude Code\n')
      },
      {
        match: /perform action "AXRaise".*keystroke "2" using command down/s,
        result: OK()
      }
    ])
    const result = await createLauncher(deps)({
      app: 'Ghostty',
      sessionId: 'abc',
      sessionName: '✳ Claude Code'
    })
    expect(result).toEqual({ ok: true, mode: 'navigated', matchedTab: '✳ Claude Code' })
    const revealScript = calls[2].args[1]
    expect(revealScript).toContain('keystroke "2" using command down')
    expect(revealScript).toContain('title contains "⠐ Create issue"')
    // 切 tab 后到此为止，不再键入 `claude resume`
    expect(revealScript).not.toContain('claude resume')
  })

  it('darwin + 0 tab matches → activated_copied, reason=no-matching-tab', async () => {
    const { deps, clipboard } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      { match: /repeat with w in windows/, result: OK('') }, // empty hits
      { match: /to activate$/, result: OK() }
    ])
    const result = await createLauncher(deps)({
      app: 'Ghostty',
      sessionId: 'abc',
      sessionName: 'absent'
    })
    expect(result).toEqual({ ok: true, mode: 'activated_copied', reason: 'no-matching-tab' })
    expect(clipboard.writeText).toHaveBeenCalledWith('claude resume abc')
  })

  it('darwin + multiple tab matches → activated_copied, reason=multiple-matches', async () => {
    const { deps, clipboard } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      {
        match: /repeat with w in windows/,
        result: OK('win1||1||1||foo\nwin2||1||1||foo\n')
      },
      { match: /to activate$/, result: OK() }
    ])
    const result = await createLauncher(deps)({
      app: 'Ghostty',
      sessionId: 'abc',
      sessionName: 'foo'
    })
    expect(result).toEqual({ ok: true, mode: 'activated_copied', reason: 'multiple-matches' })
    expect(clipboard.writeText).toHaveBeenCalledWith('claude resume abc')
  })

  it('darwin + inject script fails with permission error → activated_copied, reason=no-permission', async () => {
    const { deps, clipboard } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      { match: /repeat with w in windows/, result: OK('win||1||1||hit\n') },
      { match: /perform action "AXRaise"/, result: FAIL('not allowed assistive access (-1719)') },
      { match: /to activate$/, result: OK() }
    ])
    const result = await createLauncher(deps)({
      app: 'Ghostty',
      sessionId: 'abc',
      sessionName: 'hit'
    })
    expect(result).toEqual({ ok: true, mode: 'activated_copied', reason: 'no-permission' })
    expect(clipboard.writeText).toHaveBeenCalledWith('claude resume abc')
  })

  it('darwin + inject script fails with non-permission error → activated_copied, reason=inject-failed + audit', async () => {
    const { deps, audit } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      { match: /repeat with w in windows/, result: OK('win||1||1||hit\n') },
      { match: /perform action "AXRaise"/, result: FAIL('something else broke') },
      { match: /to activate$/, result: OK() }
    ])
    const result = await createLauncher(deps)({
      app: 'Ghostty',
      sessionId: 'abc',
      sessionName: 'hit'
    })
    expect(result.mode).toBe('activated_copied')
    expect(result.reason).toBe('inject-failed')
    expect(audit).toHaveBeenCalledWith(
      'claude_notify.launcher_failed',
      expect.objectContaining({ step: 'inject' })
    )
  })

  it('darwin + tab_index > 9 → activated_copied, reason=tab-index-out-of-range, no inject attempt', async () => {
    const { deps, clipboard, calls } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      {
        match: /repeat with w in windows/,
        result: OK('win||10||12||tenth tab\n')
      },
      { match: /to activate$/, result: OK() }
    ])
    const result = await createLauncher(deps)({
      app: 'Ghostty',
      sessionId: 'abc',
      sessionName: 'tenth tab'
    })
    expect(result).toEqual({
      ok: true,
      mode: 'activated_copied',
      reason: 'tab-index-out-of-range'
    })
    expect(clipboard.writeText).toHaveBeenCalledWith('claude resume abc')
    // inject 脚本不应被调用
    const injectCalls = calls.filter((c) => /perform action "AXRaise"/.test(c.args[1] ?? ''))
    expect(injectCalls).toHaveLength(0)
  })

  it('darwin + empty sessionName → skips tab search → activated_copied, reason=no-session-name', async () => {
    const { deps, clipboard, calls } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      { match: /to activate$/, result: OK() }
    ])
    const result = await createLauncher(deps)({
      app: 'Ghostty',
      sessionId: 'abc',
      sessionName: ''
    })
    expect(result).toEqual({ ok: true, mode: 'activated_copied', reason: 'no-session-name' })
    expect(clipboard.writeText).toHaveBeenCalledWith('claude resume abc')
    // findTab script not invoked
    for (const c of calls) {
      if (c.cmd === 'osascript') {
        expect(c.args[1]).not.toMatch(/repeat with w in windows/)
      }
    }
  })

  it('darwin + findTab fails with -1743 (automation permission denied) → activated_copied, reason=no-automation-permission', async () => {
    const { deps, clipboard, calls } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      {
        match: /repeat with w in windows/,
        result: FAIL('execution error: Not authorized to send Apple events to Ghostty. (-1743)', 1)
      },
      { match: /to activate$/, result: OK() }
    ])
    const result = await createLauncher(deps)({
      app: 'Ghostty',
      sessionId: 'abc',
      sessionName: 'demo-project'
    })
    expect(result).toEqual({
      ok: true,
      mode: 'activated_copied',
      reason: 'no-automation-permission'
    })
    expect(clipboard.writeText).toHaveBeenCalledWith('claude resume abc')
    // inject 脚本不应被调用——findTab 已经先于 inject 判定权限缺失
    const injectCalls = calls.filter((c) => /perform action "AXRaise"/.test(c.args[1] ?? ''))
    expect(injectCalls).toHaveLength(0)
  })

  it('darwin + findTab fails with UK-spelled "Not authorised" → no-automation-permission', async () => {
    const { deps } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      {
        match: /repeat with w in windows/,
        result: FAIL('execution error: Not authorised to send Apple events to "Ghostty".', 1)
      },
      { match: /to activate$/, result: OK() }
    ])
    const result = await createLauncher(deps)({
      app: 'Ghostty',
      sessionId: 'abc',
      sessionName: 'demo-project'
    })
    expect(result.reason).toBe('no-automation-permission')
  })

  it('darwin + findTab fails with US-spelled "Not authorized" (no error code) → no-automation-permission', async () => {
    const { deps } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      {
        match: /repeat with w in windows/,
        // 假设未来 macOS 版本只输出文本不带 (-1743)，文本侧必须双拼都识别
        result: FAIL('execution error: Not authorized to send Apple events to "Ghostty".', 1)
      },
      { match: /to activate$/, result: OK() }
    ])
    const result = await createLauncher(deps)({
      app: 'Ghostty',
      sessionId: 'abc',
      sessionName: 'demo-project'
    })
    expect(result.reason).toBe('no-automation-permission')
  })

  it('darwin + findTab fails without permission keyword → keeps reason=no-matching-tab (e.g. tabs property missing)', async () => {
    const { deps, clipboard } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      {
        match: /repeat with w in windows/,
        result: FAIL('execution error: No such property "tabs"', 1)
      },
      { match: /to activate$/, result: OK() }
    ])
    const result = await createLauncher(deps)({
      app: 'Ghostty',
      sessionId: 'abc',
      sessionName: 'demo-project'
    })
    expect(result).toEqual({ ok: true, mode: 'activated_copied', reason: 'no-matching-tab' })
    expect(clipboard.writeText).toHaveBeenCalledWith('claude resume abc')
  })

  it('darwin + findTab script throws (e.g. unsupported app like Alacritty) → activated_copied', async () => {
    const { deps, clipboard } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      { match: /repeat with w in windows/, result: FAIL('No such property "tabs"', 1) },
      { match: /to activate$/, result: OK() }
    ])
    const result = await createLauncher(deps)({
      app: 'Alacritty',
      sessionId: 'abc',
      sessionName: 'foo'
    })
    expect(result).toEqual({ ok: true, mode: 'activated_copied', reason: 'no-matching-tab' })
    expect(clipboard.writeText).toHaveBeenCalledWith('claude resume abc')
  })

  it('darwin + sessionName/windowName with double-quote escapes correctly in inject script', async () => {
    const { deps, calls } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      {
        match: /repeat with w in windows/,
        // sessionName contains `a"b`; tab name also contains escape risks
        result: OK('say "hi"||1||1||say "hi"\n')
      },
      { match: /perform action "AXRaise"/, result: OK() }
    ])
    await createLauncher(deps)({ app: 'Ghostty', sessionId: 'abc', sessionName: 'say "hi"' })
    const injectScript = calls[2].args[1]
    // 双引号在 windowName 嵌入处必须是 \"
    expect(injectScript).toContain('title contains "say \\"hi\\""')
  })

  it('darwin + app not running + `open -a` fails → copied_only with launch-failed reason', async () => {
    const { deps, clipboard, audit } = makeDeps([
      { match: /exists \(processes/, result: OK('false') },
      { match: /^open -a/, result: FAIL('No such application') }
    ])
    const result = await createLauncher(deps)({
      app: 'XxxTerminal',
      sessionId: 'abc',
      sessionName: 'foo'
    })
    expect(result.mode).toBe('copied_only')
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/launch-failed/)
    expect(clipboard.writeText).toHaveBeenCalledWith('claude resume abc')
    expect(audit).not.toHaveBeenCalled() // open -a 非零退出不触发 audit（属于预期失败，已在返回值里）
  })

  it('darwin + isRunning probe throws → falls through to launch path, treats as not-running', async () => {
    let calledIsRunning = false
    const runCommand: LauncherDeps['runCommand'] = async (cmd, args) => {
      const s = `${cmd} ${args.join(' ')}`
      if (/exists \(processes/.test(s)) {
        calledIsRunning = true
        throw new Error('osascript missing')
      }
      if (/^open -a/.test(s)) return OK()
      throw new Error('unmatched: ' + s)
    }
    const deps: LauncherDeps = {
      runCommand,
      clipboard: { writeText: vi.fn() },
      platform: 'darwin',
      audit: vi.fn(async () => {})
    }
    const result = await createLauncher(deps)({
      app: 'Ghostty',
      sessionId: 'abc',
      sessionName: 'foo'
    })
    expect(calledIsRunning).toBe(true)
    expect(result).toEqual({ ok: true, mode: 'launched_only' })
  })

  it('sessionName with double-quote is escaped in findTab script', async () => {
    const { deps, calls } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      { match: /repeat with w in windows/, result: OK('') },
      { match: /to activate$/, result: OK() }
    ])
    await createLauncher(deps)({ app: 'Ghostty', sessionId: 'abc', sessionName: 'a"b' })
    const findCall = calls.find((c) => /repeat with w in windows/.test(c.args[1] ?? ''))
    expect(findCall).toBeDefined()
    expect(findCall!.args[1]).toContain('contains "a\\"b"')
  })

  it('findTab script outputs 4-field hits with || separator (windowName||idx||count||tabName)', async () => {
    const { deps, calls } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      { match: /repeat with w in windows/, result: OK('') },
      { match: /to activate$/, result: OK() }
    ])
    await createLauncher(deps)({ app: 'Ghostty', sessionId: 'abc', sessionName: 'my-app' })
    const findCall = calls.find((c) => /repeat with w in windows/.test(c.args[1] ?? ''))!
    // 验证新 findTab 脚本结构：window name、4 字段、|| 分隔
    expect(findCall.args[1]).toContain('set wName to (name of w as string)')
    expect(findCall.args[1]).toContain('count of tabs of w')
    expect(findCall.args[1]).toContain('"||"')
    // 不再使用 window 的 index 属性（这是 issue #19 的根因）
    expect(findCall.args[1]).not.toMatch(/index of w/)
  })
})

describe('launchToTerminal + ensureSpaceAutoSwitch (cross-Space 跳转)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('app running → ensureSpaceAutoSwitch 在 reveal 之前被调用一次', async () => {
    const order: string[] = []
    const { deps } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      { match: /repeat with w in windows/, result: OK('win||1||1||hit\n') },
      { match: /perform action "AXRaise"/, result: OK() }
    ])
    const baseRun = deps.runCommand
    deps.runCommand = async (cmd, args) => {
      if (/perform action "AXRaise"/.test(args[1] ?? '')) order.push('reveal')
      return baseRun(cmd, args)
    }
    deps.ensureSpaceAutoSwitch = vi.fn(async () => {
      order.push('ensure')
    })
    const r = await createLauncher(deps)({ app: 'Ghostty', sessionId: 'abc', sessionName: 'hit' })
    expect(r.mode).toBe('navigated')
    expect(deps.ensureSpaceAutoSwitch).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['ensure', 'reveal']) // 先确保开关、再 reveal
  })

  it('app 未运行 → 不调用 ensureSpaceAutoSwitch（直接 open -a 启动）', async () => {
    const { deps } = makeDeps([
      { match: /exists \(processes/, result: OK('false') },
      { match: /^open -a Ghostty$/, result: OK() }
    ])
    deps.ensureSpaceAutoSwitch = vi.fn(async () => {})
    const r = await createLauncher(deps)({ app: 'Ghostty', sessionId: 'abc', sessionName: 'hit' })
    expect(r).toEqual({ ok: true, mode: 'launched_only' })
    expect(deps.ensureSpaceAutoSwitch).not.toHaveBeenCalled()
  })

  it('reveal 脚本顺序：AXRaise 目标窗口在 activate 之前（跨 Space 的关键顺序）', async () => {
    const { deps, calls } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      { match: /repeat with w in windows/, result: OK('win||1||1||hit\n') },
      { match: /perform action "AXRaise"/, result: OK() }
    ])
    await createLauncher(deps)({ app: 'Ghostty', sessionId: 'abc', sessionName: 'hit' })
    const reveal = calls.find((c) => /perform action "AXRaise"/.test(c.args[1] ?? ''))!.args[1]
    expect(reveal.indexOf('perform action "AXRaise"')).toBeLessThan(reveal.indexOf('to activate'))
  })

  it('ensureSpaceAutoSwitch 未注入时不报错（向后兼容，走原流程）', async () => {
    const { deps } = makeDeps([
      { match: /exists \(processes/, result: OK('true') },
      { match: /repeat with w in windows/, result: OK('win||1||1||hit\n') },
      { match: /perform action "AXRaise"/, result: OK() }
    ])
    // 不设置 deps.ensureSpaceAutoSwitch
    const r = await createLauncher(deps)({ app: 'Ghostty', sessionId: 'abc', sessionName: 'hit' })
    expect(r.mode).toBe('navigated')
  })
})
