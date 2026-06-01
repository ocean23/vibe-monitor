#!/usr/bin/env node
/**
 * 修改 node_modules/electron 的 Info.plist，让 dev 模式在 macOS Notification Center 显示正确的 app 名。
 * macOS 通知中心读的是 bundle 的 CFBundleName，不是 app.setName()。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const plist = 'node_modules/electron/dist/Electron.app/Contents/Info.plist'

if (!existsSync(plist)) {
  console.log('[patch-electron-plist] not on macOS or electron not installed, skip.')
  process.exit(0)
}

const set = (key, value) =>
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set ${key} ${value}`, plist])

set('CFBundleName', 'Vibe Monitor')
set('CFBundleDisplayName', 'Vibe Monitor')
set('CFBundleIdentifier', 'io.github.ocean23.vibe-monitor')

console.log(
  '[patch-electron-plist] patched Electron.app/Contents/Info.plist → Vibe Monitor / io.github.ocean23.vibe-monitor'
)
