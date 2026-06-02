import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import type { AuditFn } from '../audit-log'

/** 灵动岛环回 HTTP 端口（固定）。同机其他进程伪造事件由 token 拦截。 */
export const ISLAND_DEFAULT_PORT = 7842

/** 配置落盘文件名（位于 `~/.vibe-monitor/`）。 */
export const ISLAND_CONFIG_FILE = 'island.json'

export interface IslandConfig {
  /** 环回端口 */
  port: number
  /** 随机鉴权 token（hook 请求须携带 `Authorization: Bearer <token>`） */
  token: string
  /** 跳过所有 PreToolUse 审批，等同于 --dangerously-skip-permissions 的岛内镜像 */
  trustAll?: boolean
}

export interface EnsureIslandConfigOptions {
  /** 配置根目录，默认 `~/.vibe-monitor`；测试注入临时目录 */
  rootDir?: string
  /** token 生成器注入点，便于单测断言固定值 */
  randomToken?: () => string
  audit?: AuditFn
}

function defaultRandomToken(): string {
  return crypto.randomBytes(24).toString('hex')
}

function isValidConfig(value: unknown): value is IslandConfig {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.port === 'number' &&
    Number.isInteger(v.port) &&
    v.port > 0 &&
    typeof v.token === 'string' &&
    v.token.length > 0
  )
}

/**
 * 确保 `~/.vibe-monitor/island.json` 存在并返回 {port, token}。
 *
 * - 文件存在且合法 → 直接复用（不重写，token 稳定，hook 端缓存有效）
 * - 文件缺失 / 损坏 → 生成新 token + 默认端口，原子写入（tmp + rename，mode 0o600）
 *
 * mode 0o600：token 是同机鉴权凭证，仅当前用户可读写。
 */
export async function ensureIslandConfig(
  options: EnsureIslandConfigOptions = {}
): Promise<IslandConfig> {
  const rootDir = options.rootDir ?? path.join(os.homedir(), '.vibe-monitor')
  const randomToken = options.randomToken ?? defaultRandomToken
  const filePath = path.join(rootDir, ISLAND_CONFIG_FILE)

  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (isValidConfig(parsed)) {
      const cfg: IslandConfig = { port: parsed.port, token: parsed.token }
      if ((parsed as Record<string, unknown>).trustAll === true) cfg.trustAll = true
      return cfg
    }
    // 文件存在但内容损坏：重新生成（下方写入覆盖）
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // 非 ENOENT（如权限错误）：审计后继续尝试生成，避免灵动岛因配置读不出而完全不可用
      await options.audit?.('island.config_read_failed', {
        error: (err as Error).message
      })
    }
  }

  const config: IslandConfig = { port: ISLAND_DEFAULT_PORT, token: randomToken() }
  await fs.mkdir(rootDir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto
    .randomBytes(4)
    .toString('hex')}.tmp`
  try {
    await fs.writeFile(tmp, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 })
    await fs.rename(tmp, filePath)
  } finally {
    // audit-exempt: tmp 清理 best-effort（rename 成功后 tmp 已不存在）
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
  return config
}

/**
 * 原子更新 `~/.vibe-monitor/island.json` 中的指定字段（如 trustAll），
 * 其余字段保持不变。文件不存在或解析失败时静默忽略（ensureIslandConfig 会在启动时处理）。
 */
export async function patchIslandConfig(
  patch: Partial<IslandConfig>,
  options: { rootDir?: string } = {}
): Promise<void> {
  const rootDir = options.rootDir ?? path.join(os.homedir(), '.vibe-monitor')
  const filePath = path.join(rootDir, ISLAND_CONFIG_FILE)
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const existing = JSON.parse(raw) as Record<string, unknown>
    const merged = { ...existing, ...patch }
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(merged, null, 2), { encoding: 'utf-8', mode: 0o600 })
    await fs.rename(tmp, filePath)
  } catch {
    /* 文件不存在 / 格式异常：忽略，不影响正常启动 */
  }
}

/**
 * 常量时间比对两个 token，长度不等直接返回 false（不抛错）。
 *
 * 直接 `a === b` 会因短路比较泄露前缀匹配长度（计时侧信道）；用
 * `crypto.timingSafeEqual` 比对等长 Buffer。长度本身不敏感（随机 token 定长），
 * 故长度不等时提前返回安全。
 */
export function timingSafeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8')
  const bufB = Buffer.from(b, 'utf-8')
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}
