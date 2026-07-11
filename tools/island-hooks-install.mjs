#!/usr/bin/env node
/**
 * 灵动岛 hooks 安装脚本——把 island-hook.mjs 幂等注册进 `~/.claude/settings.json`。
 *
 * 注册 6 个 hook 事件：SessionStart / UserPromptSubmit / PreToolUse / Notification / Stop / SessionEnd，
 * 每个事件加一条 `{type:'command', command:'node <abs>/island-hook.mjs'}`。SessionEnd 让会话退出即从岛上移除。
 *
 * 安全约束（issue #29 FR-002 / AC-011）：
 *   - 写入前**备份** `settings.json.vibe-monitor-bak-<ts>`
 *   - **幂等合并**：已存在指向 island-hook.mjs 的同名 command 不重复添加，跑两次数组不翻倍
 *   - **原子写入**：tmp + rename
 *
 * 用法：
 *   node tools/island-hooks-install.mjs            # 安装（含备份）
 *   node tools/island-hooks-install.mjs --dry-run  # 只打印合并结果，不落盘
 *   node tools/island-hooks-install.mjs --uninstall# 移除本工具注册的 hook
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'Notification',
  'Stop',
  'SessionEnd'
]
const HOOK_SCRIPT_MARKER = 'island-hook.mjs'
// island-hook.mjs 自身在 65s 兜底降级（见该文件注释）；这里显式写 70s 留出余量，避免
// Claude Code 用更短的默认 hook 超时提前 kill 掉 hook 进程，导致「绝不阻塞用户」的安全
// 网失效（超时字段缺失时 Claude Code 的默认值不受本工具控制）。
const HOOK_TIMEOUT_SECONDS = 70

const here = path.dirname(fileURLToPath(import.meta.url))
const hookScriptPath = path.join(here, HOOK_SCRIPT_MARKER)
const hookCommand = `node ${hookScriptPath}`

function settingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json')
}

function loadSettings(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf-8'))
  } catch (err) {
    if (err && err.code === 'ENOENT') return {}
    // 损坏的 settings 不应被本脚本静默覆盖——抛出让用户先修
    throw new Error(`无法解析 ${p}：${err.message}（请先修复或备份后删除该文件）`)
  }
}

/** 判断某事件的 hooks 组里是否已含指向 island-hook.mjs 的 command（幂等判定）。 */
function hasIslandHook(group) {
  if (!Array.isArray(group)) return false
  return group.some(
    (entry) =>
      Array.isArray(entry?.hooks) &&
      entry.hooks.some(
        (h) => typeof h?.command === 'string' && h.command.includes(HOOK_SCRIPT_MARKER)
      )
  )
}

/**
 * 纯函数：把灵动岛 hook 幂等合并进 settings 对象，返回新对象（不改原对象）。
 * 已存在的 island hook 条目会就地把 timeout 补齐/校正为 {@link HOOK_TIMEOUT_SECONDS}
 * （自愈旧安装——早期安装的条目没有这个字段），不会重复添加新条目。
 * 导出以便单测。
 */
export function mergeIslandHooks(settings, command) {
  const next = { ...settings, hooks: { ...(settings.hooks || {}) } }
  for (const event of HOOK_EVENTS) {
    const group = Array.isArray(next.hooks[event]) ? [...next.hooks[event]] : []
    if (hasIslandHook(group)) {
      next.hooks[event] = group.map((entry) => {
        if (!Array.isArray(entry?.hooks)) return entry
        const hooks = entry.hooks.map((h) =>
          typeof h?.command === 'string' && h.command.includes(HOOK_SCRIPT_MARKER)
            ? { ...h, timeout: HOOK_TIMEOUT_SECONDS }
            : h
        )
        return { ...entry, hooks }
      })
    } else {
      // matcher 空串 = 匹配全部（Claude Code 约定）。PreToolUse/PostToolUse 的 matcher 按
      // 正则匹配 tool_name，`'*'` 是非法正则（quantifier 无目标）会被跳过；用户既有 hook
      // 亦用 ''。非工具事件（UserPromptSubmit/Stop/Notification/SessionStart）忽略 matcher。
      group.push({
        matcher: '',
        hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }]
      })
      next.hooks[event] = group
    }
  }
  return next
}

/**
 * 纯函数：移除所有指向 island-hook.mjs 的 hook 条目（卸载）。导出以便单测。
 */
export function removeIslandHooks(settings) {
  if (!settings.hooks) return { ...settings }
  const next = { ...settings, hooks: { ...settings.hooks } }
  for (const event of HOOK_EVENTS) {
    const group = next.hooks[event]
    if (!Array.isArray(group)) continue
    const filtered = group
      .map((entry) => {
        if (!Array.isArray(entry?.hooks)) return entry
        const hooks = entry.hooks.filter(
          (h) => !(typeof h?.command === 'string' && h.command.includes(HOOK_SCRIPT_MARKER))
        )
        return { ...entry, hooks }
      })
      .filter((entry) => !Array.isArray(entry?.hooks) || entry.hooks.length > 0)
    if (filtered.length > 0) next.hooks[event] = filtered
    else delete next.hooks[event]
  }
  return next
}

function atomicWrite(p, obj) {
  mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8')
  renameSync(tmp, p)
}

function backup(p) {
  if (!existsSync(p)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const bak = `${p}.vibe-monitor-bak-${stamp}`
  writeFileSync(bak, readFileSync(p, 'utf-8'), 'utf-8')
  return bak
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const uninstall = args.includes('--uninstall')
  const p = settingsPath()
  const current = loadSettings(p)
  const next = uninstall ? removeIslandHooks(current) : mergeIslandHooks(current, hookCommand)

  if (dryRun) {
    console.log(`# dry-run（不写入）。目标：${p}`)
    console.log(`# hook 脚本：${hookScriptPath}`)
    console.log(JSON.stringify(next, null, 2))
    return
  }

  const bak = backup(p)
  atomicWrite(p, next)
  console.log(uninstall ? '✅ 已移除灵动岛 hooks' : '✅ 已安装灵动岛 hooks')
  console.log(`   settings: ${p}`)
  if (bak) console.log(`   备份: ${bak}`)
  console.log(`   事件: ${HOOK_EVENTS.join(', ')}`)
}

// 仅在作为入口运行时执行 main（被单测 import 时不执行）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
