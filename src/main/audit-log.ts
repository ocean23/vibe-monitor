import { promises as fs } from 'node:fs'
import path from 'node:path'
import pLimit from 'p-limit'
import type { AuditEntry } from './types'

/**
 * 跨切面审计函数签名：所有 island 服务通过依赖注入接收一个 AuditFn，
 * 运行期由主进程注入下方的 {@link audit} sink（测试注入 spy / no-op）。
 */
export type AuditFn = (category: string, payload: Record<string, unknown>) => Promise<void> | void

let auditRoot: string | null = null
const writeQueue = pLimit(1)

export function setAuditRoot(root: string): void {
  auditRoot = root
}

export function resetAuditRoot(): void {
  auditRoot = null
}

function todayLogName(now = new Date()): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}.log`
}

export async function audit(category: string, payload: Record<string, unknown>): Promise<void> {
  return writeQueue(async () => {
    if (!auditRoot) {
      throw new Error('audit root not initialized — call setAuditRoot() at app boot')
    }
    try {
      const dir = path.join(auditRoot, 'audit')
      await fs.mkdir(dir, { recursive: true })
      const filePath = path.join(dir, todayLogName())
      const entry: AuditEntry = {
        ts: new Date().toISOString(),
        category,
        payload
      }
      await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf-8')
    } catch (err) {
      // audit-exempt: audit sink 自身写盘失败已无处再上报，降级到 stderr——
      // 否则大量 `void audit(...)` 调用点会变成 unhandledRejection。
      console.error('[audit] failed to write audit entry:', (err as Error).message)
    }
  })
}
