import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  ensureIslandConfig,
  timingSafeTokenEqual,
  ISLAND_DEFAULT_PORT,
  ISLAND_CONFIG_FILE
} from './island-config'

describe('island-config', () => {
  let tmp: string

  beforeEach(async () => {
    const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'island-cfg-'))
    tmp = await fs.realpath(raw)
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('generates config with default port + token on first call', async () => {
    const cfg = await ensureIslandConfig({ rootDir: tmp, randomToken: () => 'tok-abc' })
    expect(cfg).toEqual({ port: ISLAND_DEFAULT_PORT, token: 'tok-abc' })

    const onDisk = JSON.parse(await fs.readFile(path.join(tmp, ISLAND_CONFIG_FILE), 'utf-8'))
    expect(onDisk).toEqual({ port: ISLAND_DEFAULT_PORT, token: 'tok-abc' })
  })

  it('writes config file with 0o600 permission', async () => {
    await ensureIslandConfig({ rootDir: tmp, randomToken: () => 'tok-perm' })
    const stat = await fs.stat(path.join(tmp, ISLAND_CONFIG_FILE))
    // 仅 owner 读写（屏蔽高位，比对低 9 位权限）
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('reuses existing config without rewriting (token stays stable)', async () => {
    const first = await ensureIslandConfig({ rootDir: tmp, randomToken: () => 'tok-first' })
    const second = await ensureIslandConfig({ rootDir: tmp, randomToken: () => 'tok-second' })
    expect(second).toEqual(first)
    expect(second.token).toBe('tok-first')
  })

  it('regenerates when existing file is corrupted', async () => {
    await fs.writeFile(path.join(tmp, ISLAND_CONFIG_FILE), 'not json{', 'utf-8')
    const cfg = await ensureIslandConfig({ rootDir: tmp, randomToken: () => 'tok-fixed' })
    expect(cfg.token).toBe('tok-fixed')
  })

  it('regenerates when existing file lacks required fields', async () => {
    await fs.writeFile(path.join(tmp, ISLAND_CONFIG_FILE), JSON.stringify({ port: 1 }), 'utf-8')
    const cfg = await ensureIslandConfig({ rootDir: tmp, randomToken: () => 'tok-recovered' })
    expect(cfg.token).toBe('tok-recovered')
  })

  describe('timingSafeTokenEqual', () => {
    it('returns true for equal tokens', () => {
      expect(timingSafeTokenEqual('abc123', 'abc123')).toBe(true)
    })

    it('returns false for different tokens of same length', () => {
      expect(timingSafeTokenEqual('abc123', 'abc999')).toBe(false)
    })

    it('returns false for different-length tokens without throwing', () => {
      expect(timingSafeTokenEqual('abc', 'abc123')).toBe(false)
      expect(timingSafeTokenEqual('', 'x')).toBe(false)
    })
  })
})
