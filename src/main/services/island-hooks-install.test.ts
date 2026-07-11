import { describe, it, expect } from 'vitest'
// 被测纯函数来自 tools/ 下的安装脚本（ESM .mjs），仅 import 纯逻辑，不触发 main()
import { mergeIslandHooks, removeIslandHooks } from '../../../tools/island-hooks-install.mjs'

const CMD = 'node /abs/tools/island-hook.mjs'
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'Notification',
  'Stop',
  'SessionEnd'
]

describe('island-hooks-install merge logic', () => {
  it('registers all 6 hook events into empty settings', () => {
    const out = mergeIslandHooks({}, CMD)
    for (const ev of EVENTS) {
      expect(out.hooks[ev]).toHaveLength(1)
      expect(out.hooks[ev][0].hooks[0].command).toBe(CMD)
    }
  })

  it('writes an explicit 70s timeout on every new hook entry', () => {
    const out = mergeIslandHooks({}, CMD)
    for (const ev of EVENTS) {
      expect(out.hooks[ev][0].hooks[0].timeout).toBe(70)
    }
  })

  it('self-heals a pre-existing island entry that lacks a timeout (old install)', () => {
    const oldInstall = {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: CMD }] }]
      }
    }
    const out = mergeIslandHooks(oldInstall, CMD)
    // 就地补齐 timeout，且不重复添加条目
    expect(out.hooks.PreToolUse).toHaveLength(1)
    expect(out.hooks.PreToolUse[0].hooks[0].timeout).toBe(70)
  })

  it('is idempotent — running twice does not duplicate entries', () => {
    const once = mergeIslandHooks({}, CMD)
    const twice = mergeIslandHooks(once, CMD)
    for (const ev of EVENTS) {
      expect(twice.hooks[ev]).toHaveLength(1)
    }
  })

  it('preserves the user existing unrelated hooks', () => {
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other.mjs' }] }]
      },
      otherSetting: true
    }
    const out = mergeIslandHooks(existing, CMD)
    // 原有 other.mjs 保留，island 追加 → PreToolUse 有 2 条
    expect(out.hooks.PreToolUse).toHaveLength(2)
    expect(out.hooks.PreToolUse[0].hooks[0].command).toBe('node other.mjs')
    expect(out.otherSetting).toBe(true)
  })

  it('does not mutate the input settings object', () => {
    const input = { hooks: {} }
    const out = mergeIslandHooks(input, CMD)
    expect(input.hooks).toEqual({})
    expect(out).not.toBe(input)
  })

  it('removeIslandHooks strips only island entries, keeps others', () => {
    const withBoth = mergeIslandHooks(
      {
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other.mjs' }] }]
        }
      },
      CMD
    )
    const removed = removeIslandHooks(withBoth)
    // island 条目移除，other.mjs 保留
    expect(removed.hooks.PreToolUse).toHaveLength(1)
    expect(removed.hooks.PreToolUse[0].hooks[0].command).toBe('node other.mjs')
    // 纯 island 的事件被整体删除
    expect(removed.hooks.SessionStart).toBeUndefined()
  })

  it('removeIslandHooks is safe on settings without hooks', () => {
    expect(() => removeIslandHooks({})).not.toThrow()
  })
})
