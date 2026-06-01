import React, { useCallback, useRef, useState, useEffect } from 'react'
import { copyText } from '../lib/clipboard'

interface CopyableFieldProps {
  value: string | undefined | null
  children: React.ReactNode
}

/**
 * 包装一个长字段，悬停时在右上角显示复制按钮。
 * 点击后调用 navigator.clipboard.writeText，800ms 内回到默认态。
 */
export function CopyableField({ value, children }: CopyableFieldProps): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    }
  }, [])

  const onClick = useCallback(() => {
    // 显式 .catch 收敛失败，避免 unhandledRejection（[AP-005]）
    copyText(value ?? '')
      .then((ok) => {
        if (!ok) return
        setCopied(true)
        if (timerRef.current !== null) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCopied(false), 800)
      })
      .catch(() => {
        /* copyText 内部已 warn，这里仅兜底，永不冒泡 */
      })
  }, [value])

  return (
    <div className="copyable-field" data-state={copied ? 'copied' : 'idle'}>
      <button
        type="button"
        className="copyable-field-btn"
        onClick={onClick}
        title={copied ? '已复制' : '复制到剪贴板'}
        aria-label={copied ? '已复制' : '复制到剪贴板'}
      >
        {copied ? '✓' : '⧉'}
      </button>
      {children}
    </div>
  )
}
