import { useEffect, useState } from 'react'

/**
 * 共享 1s 时钟。所有「相对时间 / 已持续时长 / 审批倒计时」组件订阅同一个 ticker：
 * 全应用只跑一个 `setInterval`（有订阅者才启动、订阅清零即停），并保证各处秒级刷新
 * 相位一致（同一 tick 同时触发，避免多个独立定时器的相位抖动）。
 *
 * 取代此前散落的多个独立 1s `setInterval`（Island 的 forceTick + 审批面板倒计时 + 各卡片）。
 */
const subscribers = new Set<(now: number) => void>()
let ticker: ReturnType<typeof setInterval> | null = null

function startTicker(): void {
  if (ticker || subscribers.size === 0) return
  ticker = setInterval(() => {
    const now = Date.now()
    for (const fn of subscribers) fn(now)
  }, 1000)
}

function stopTickerIfIdle(): void {
  if (ticker && subscribers.size === 0) {
    clearInterval(ticker)
    ticker = null
  }
}

/**
 * 订阅共享时钟，返回每秒更新一次的 `Date.now()`。
 * @param active 为 false 时不订阅（如灵动岛收起态停表），返回一个不再更新的快照值。
 */
export function useNow(active = true): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    // 进入时立即对齐一次，避免「挂载 → 首个 tick」之间短暂显示陈旧值
    setNow(Date.now())
    const fn = (n: number): void => setNow(n)
    subscribers.add(fn)
    startTicker()
    return () => {
      subscribers.delete(fn)
      stopTickerIfIdle()
    }
  }, [active])
  return now
}
