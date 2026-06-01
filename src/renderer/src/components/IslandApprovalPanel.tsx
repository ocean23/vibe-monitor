import React, { useMemo } from 'react'
import type { ApprovalRequest } from '../../../shared/island-types'
import { useIslandStore } from '../store/island-store'
import { useNow } from '../lib/use-now'
import { LogHighlight } from './LogHighlight'
import { CopyableField } from './CopyableField'

interface Props {
  request: ApprovalRequest
}

/** 尝试把 toolInput（通常是 JSON 文本）解析出友好的副标题。 */
function deriveSubtitle(toolName: string, toolInput: string): string {
  try {
    const obj = JSON.parse(toolInput) as Record<string, unknown>
    if (typeof obj.file_path === 'string') return obj.file_path
    if (typeof obj.path === 'string') return obj.path
    if (typeof obj.command === 'string') return obj.command.split('\n')[0]
  } catch {
    // toolInput 非 JSON（纯命令字符串）→ 取首行
    return toolInput.split('\n')[0]
  }
  return toolName
}

/**
 * 岛内审批面板（FR-007 / AC-003 / AC-004）。
 *
 * 灵动岛收到 PreToolUse 审批请求时自动展开本面板：展示工具名 + 完整预览
 * （Edit 文件路径 + diff / Bash 完整命令），底部三按钮 Deny / Allow Once / Bypass。
 * 顶部倒计时反映 hook 侧 60s 阻塞上限——超时后主进程会推送 resolved 移除本请求
 * （hook 输出 permissionDecision=ask 回退终端）。
 */
export function IslandApprovalPanel({ request }: Props): React.ReactElement {
  const decide = useIslandStore((s) => s.decide)
  // 倒计时改用共享时钟（lib/use-now）按秒推导，不再单独起一个 setInterval。
  const now = useNow()
  const remaining = Math.max(0, Math.ceil((request.requestedAt + request.timeoutMs - now) / 1000))

  const subtitle = useMemo(
    () => deriveSubtitle(request.toolName, request.toolInput),
    [request.toolName, request.toolInput]
  )

  const pct = Math.max(0, Math.min(100, (remaining / (request.timeoutMs / 1000)) * 100))

  return (
    <div className="island-approval">
      <div className="island-approval-head">
        <span className="island-approval-tool">⚠ {request.toolName}</span>
        {(request.projectName || request.sessionName) && (
          <span className="island-approval-ctx">
            {request.projectName}
            {request.sessionName ? ` · ${request.sessionName}` : ''}
          </span>
        )}
        <span className="island-approval-countdown" title="超时后回退终端原生询问">
          {remaining}s
        </span>
      </div>

      <div className="island-approval-subtitle">{subtitle}</div>

      <div className="island-approval-preview">
        <CopyableField value={request.toolInput}>
          <LogHighlight value={request.toolInput} />
        </CopyableField>
      </div>

      <div className="island-approval-countdown-bar" aria-hidden="true">
        <span className="island-approval-countdown-fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="island-approval-actions">
        <button
          type="button"
          className="island-btn deny"
          onClick={() => void decide(request.requestId, 'deny')}
        >
          Deny
        </button>
        <button
          type="button"
          className="island-btn allow"
          onClick={() => void decide(request.requestId, 'allow_once')}
          title="或按 ⌃Y 直接放行（无需聚焦灵动岛）"
        >
          Allow Once
          <kbd className="island-btn-kbd" aria-hidden="true">
            ⌃Y
          </kbd>
        </button>
        <button
          type="button"
          className="island-btn bypass"
          onClick={() => void decide(request.requestId, 'bypass')}
          title="本会话后续同类工具不再询问（或按 ⌃B，无需聚焦灵动岛）"
        >
          Bypass
          <kbd className="island-btn-kbd" aria-hidden="true">
            ⌃B
          </kbd>
        </button>
      </div>
    </div>
  )
}
