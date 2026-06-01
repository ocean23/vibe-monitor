import { describe, it, expect, afterEach } from 'vitest'
// 被测纯函数来自 tools/ 下的 hook 脚本（ESM .mjs）。import 不触发 main()——
// 脚本用 `if (process.argv[1] === <self>)` 守卫，单测环境 argv[1] 是 vitest，不会执行。
import {
  clip,
  deriveSessionName,
  deriveLastMessage,
  deriveTerminal,
  deriveModel,
  translatePreToolUseDecision
} from '../../../tools/island-hook.mjs'

describe('island-hook clip', () => {
  it('collapses whitespace and trims', () => {
    expect(clip('  a\n\tb   c  ', 60)).toBe('a b c')
  })
  it('truncates to max with ellipsis', () => {
    expect(clip('a'.repeat(100), 10)).toBe('aaaaaaaaaa…')
  })
  it('returns undefined for non-string / empty', () => {
    expect(clip(undefined, 10)).toBeUndefined()
    expect(clip(42, 10)).toBeUndefined()
    expect(clip('   ', 10)).toBeUndefined()
  })
})

describe('island-hook derive*', () => {
  it('deriveSessionName uses prompt first line', () => {
    expect(deriveSessionName({ prompt: 'fix the bug\nmore' })).toBe('fix the bug more')
    expect(deriveSessionName({})).toBeUndefined()
  })

  it('deriveLastMessage prefers prompt, falls back to message', () => {
    expect(deriveLastMessage({ prompt: 'hello' })).toBe('hello')
    expect(deriveLastMessage({ message: 'note' })).toBe('note')
    expect(deriveLastMessage({})).toBeUndefined()
  })

  it('deriveModel defaults to Claude, passes through explicit model', () => {
    expect(deriveModel({})).toBe('Claude')
    expect(deriveModel({ model: '  ' })).toBe('Claude')
    expect(deriveModel({ model: 'gpt-x' })).toBe('gpt-x')
  })
})

describe('island-hook deriveTerminal', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  function clearTermEnv(): void {
    for (const k of [
      'TERM_PROGRAM',
      'TMUX',
      'KITTY_WINDOW_ID',
      'ALACRITTY_SOCKET',
      'ALACRITTY_WINDOW_ID',
      'WEZTERM_PANE'
    ]) {
      delete process.env[k]
    }
  }

  it('maps known TERM_PROGRAM to friendly name', () => {
    clearTermEnv()
    process.env.TERM_PROGRAM = 'ghostty'
    expect(deriveTerminal()).toBe('Ghostty')
  })

  it('appends ·tmux suffix when inside tmux', () => {
    clearTermEnv()
    process.env.TERM_PROGRAM = 'iTerm.app'
    process.env.TMUX = '/tmp/tmux-1/default,1,0'
    expect(deriveTerminal()).toBe('iTerm·tmux')
  })

  it('falls back to terminal-specific env vars', () => {
    clearTermEnv()
    process.env.WEZTERM_PANE = '0'
    expect(deriveTerminal()).toBe('WezTerm')
  })
})

describe('island-hook translatePreToolUseDecision', () => {
  it('maps island decisions to Claude Code permissionDecision', () => {
    expect(translatePreToolUseDecision('deny')).toBe('deny')
    expect(translatePreToolUseDecision('ask')).toBe('ask')
    expect(translatePreToolUseDecision('allow_once')).toBe('allow')
    expect(translatePreToolUseDecision('bypass')).toBe('allow')
    // 未知/缺失一律按最宽松的 allow 之外的安全侧？实现选择 allow（已通过岛裁决），核对契约：
    expect(translatePreToolUseDecision('whatever')).toBe('allow')
  })
})
