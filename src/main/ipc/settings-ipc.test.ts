import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SettingsService, registerSettingsIpc, type IpcMainHandleLike } from './settings-ipc'

class FakeIpcMain implements IpcMainHandleLike {
  handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle(channel: string, listener: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener)
  }
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const fn = this.handlers.get(channel)
    if (!fn) throw new Error(`no handler for ${channel}`)
    return fn({}, ...args)
  }
}

describe('SettingsService', () => {
  let rootDir: string
  let service: SettingsService

  beforeEach(async () => {
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-test-'))
    rootDir = await fs.realpath(raw)
    service = new SettingsService({ rootDir })
  })

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true })
  })

  it('load returns {} when settings file does not exist', async () => {
    expect(await service.load()).toEqual({})
  })

  it('save merges patch with existing settings and persists', async () => {
    await service.save({ baseUrl: 'https://x' })
    const merged = await service.save({ apiKey: 'k1' })
    expect(merged).toMatchObject({ baseUrl: 'https://x', apiKey: 'k1' })
    const reloaded = new SettingsService({ rootDir })
    expect(await reloaded.load()).toMatchObject({ baseUrl: 'https://x', apiKey: 'k1' })
  })

  it('emits a change event after save with the merged value', async () => {
    const listener = vi.fn()
    service.on('change', listener)
    await service.save({ baseUrl: 'https://a' })
    await service.save({ modelId: 'gpt' })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener.mock.calls[1][0]).toMatchObject({ baseUrl: 'https://a', modelId: 'gpt' })
  })

  it('unsubscribed listener no longer receives events', async () => {
    const listener = vi.fn()
    service.on('change', listener)
    await service.save({ k: 1 })
    service.off('change', listener)
    await service.save({ k: 2 })
    expect(listener).toHaveBeenCalledOnce()
  })

  it('getSettings returns the in-memory snapshot updated by save', async () => {
    await service.load()
    await service.save({ baseUrl: 'https://x', apiKey: 'k' })
    expect(service.getSettings()).toMatchObject({ baseUrl: 'https://x', apiKey: 'k' })
  })

  it('concurrent saves do not lose data', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => service.save({ [`k${i}`]: i })))
    const out = service.getSettings()
    for (let i = 0; i < 10; i++) {
      expect(out[`k${i}`]).toBe(i)
    }
  })
})

describe('registerSettingsIpc', () => {
  let rootDir: string
  let service: SettingsService
  let ipc: FakeIpcMain

  beforeEach(async () => {
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-ipc-test-'))
    rootDir = await fs.realpath(raw)
    service = new SettingsService({ rootDir })
    ipc = new FakeIpcMain()
    registerSettingsIpc(ipc, service)
  })

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true })
  })

  it('settings:load returns the persisted state verbatim', async () => {
    await service.save({ terminalApp: 'iTerm' })
    const loaded = await ipc.invoke('settings:load')
    expect(loaded).toMatchObject({ terminalApp: 'iTerm' })
  })

  it('settings:save persists the patch and returns the merged value', async () => {
    const listener = vi.fn()
    service.on('change', listener)
    const out = (await ipc.invoke('settings:save', {
      terminalApp: 'Ghostty',
      islandSoundEnabled: false
    })) as Record<string, unknown>
    expect(out).toMatchObject({ terminalApp: 'Ghostty', islandSoundEnabled: false })
    expect(listener).toHaveBeenCalledOnce()
    expect(service.getSettings()).toMatchObject({
      terminalApp: 'Ghostty',
      islandSoundEnabled: false
    })
  })

  it('settings:save tolerates a non-object patch (returns current state)', async () => {
    await service.save({ terminalApp: 'Terminal' })
    const out = (await ipc.invoke('settings:save', null)) as Record<string, unknown>
    expect(out).toMatchObject({ terminalApp: 'Terminal' })
  })
})
