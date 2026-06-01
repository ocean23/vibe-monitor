/** 审计日志单条记录（JSON Lines 每行一条，由 audit-log.ts 落盘）。 */
export interface AuditEntry {
  ts: string
  category: string
  payload: Record<string, unknown>
}
