import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import pLimit from 'p-limit'

export type Settings = Record<string, unknown>

export interface SettingsServiceOptions {
  rootDir: string
  filename?: string
}

export type SettingsChangeListener = (settings: Settings) => void

export class SettingsService extends EventEmitter {
  private readonly filePath: string
  private cache: Settings = {}
  private loaded = false
  private readonly serial = pLimit(1)

  constructor(options: SettingsServiceOptions) {
    super()
    this.filePath = path.join(options.rootDir, options.filename ?? 'settings.json')
  }

  async load(): Promise<Settings> {
    return this.serial(async () => {
      await this.loadIntoCache()
      return { ...this.cache }
    })
  }

  async save(patch: Settings): Promise<Settings> {
    return this.serial(async () => {
      await this.loadIntoCache()
      const merged: Settings = { ...this.cache, ...patch }
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      // mode 0o600：仅当前用户可读写（rename 保留 tmp 权限）。
      await fs.writeFile(tmp, JSON.stringify(merged, null, 2), { encoding: 'utf-8', mode: 0o600 })
      await fs.rename(tmp, this.filePath)
      this.cache = merged
      this.emit('change', { ...merged })
      return { ...merged }
    })
  }

  getSettings(): Settings {
    return { ...this.cache }
  }

  private async loadIntoCache(): Promise<void> {
    if (this.loaded) return
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      this.cache = parsed && typeof parsed === 'object' ? (parsed as Settings) : {}
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      this.cache = {}
    }
    this.loaded = true
  }
}

export type IpcHandler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>

export interface IpcMainHandleLike {
  handle(channel: string, listener: IpcHandler): void
}

/** 允许渲染端经 IPC 写入的设置键 + 期望类型，防止渲染端把任意/超大字段塞进 settings.json。 */
const ALLOWED_SETTING_KEYS: Record<string, 'string' | 'boolean'> = {
  terminalApp: 'string',
  islandEnabled: 'boolean',
  islandSoundEnabled: 'boolean',
  trustAll: 'boolean'
}

/** 仅保留白名单键且类型匹配的字段，其余忽略（SettingsService 本身保持通用，校验只在 IPC 边界做）。 */
function sanitizeSettingsPatch(patch: unknown): Settings {
  if (!patch || typeof patch !== 'object') return {}
  const out: Settings = {}
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const expected = ALLOWED_SETTING_KEYS[k]
    if (expected && typeof v === expected) out[k] = v
  }
  return out
}

export function registerSettingsIpc(ipcMain: IpcMainHandleLike, service: SettingsService): void {
  ipcMain.handle('settings:load', async () => service.load())
  ipcMain.handle('settings:save', async (_event, patch) =>
    service.save(sanitizeSettingsPatch(patch))
  )
}
