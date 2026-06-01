import React, { useMemo } from 'react'
import { highlightLog } from '../lib/log-highlight'

interface LogHighlightProps {
  value: string | undefined | null
}

/**
 * 把日志文本经 lh-* 规则着色后渲染为 <pre>。空值返回占位 <pre>，保持容器高度避免抖动。
 *
 * 包 React.memo + useMemo：审批面板每秒因倒计时重渲，但 value 不变时不应重跑全量正则着色。
 */
function LogHighlightInner({ value }: LogHighlightProps): React.ReactElement {
  const html = useMemo(() => (value ? highlightLog(value).html : ''), [value])
  if (!html) {
    return <pre className="log-highlight empty" aria-hidden="true" />
  }
  return <pre className="log-highlight" dangerouslySetInnerHTML={{ __html: html }} />
}

export const LogHighlight = React.memo(LogHighlightInner)
