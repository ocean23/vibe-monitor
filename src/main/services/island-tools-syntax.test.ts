import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

/**
 * `tools/*.mjs` 是运行期脚本，不进 tsc / vite / vitest 编译——曾发生 island-hook.mjs
 * 顶部 import 三重重复（SyntaxError）却通过 typecheck/build/test，直到 Claude Code
 * 实际调用 hook 才崩、灵动岛 0 sessions（issue #29 调试）。本测试用 `node --check`
 * 对每个工具脚本做语法守卫，杜绝这类「门禁绿但运行时崩」回归。
 */
const TOOLS = ['island-hook.mjs', 'island-hooks-install.mjs']

describe('tools/*.mjs syntax', () => {
  const toolsDir = path.resolve(__dirname, '../../../tools')
  for (const f of TOOLS) {
    it(`${f} parses without syntax error`, () => {
      const abs = path.join(toolsDir, f)
      // node --check 仅做语法解析，不执行；语法错误时非 0 退出 → execFileSync 抛错
      expect(() => execFileSync('node', ['--check', abs], { stdio: 'pipe' })).not.toThrow()
    })
  }
})
