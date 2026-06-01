/**
 * 把文本写入系统剪贴板。
 *
 * 设计契约：永不 reject——失败统一返回 `false` 并 `console.warn`，
 * 避免在 React 事件回调里出现 unhandledRejection（[AP-005]）。
 */
export async function copyText(text: string): Promise<boolean> {
  const writeText = globalThis.navigator?.clipboard?.writeText
  if (typeof writeText !== 'function') {
    console.warn('[clipboard] navigator.clipboard.writeText unavailable')
    return false
  }
  try {
    await writeText.call(globalThis.navigator.clipboard, text)
    return true
  } catch (err) {
    console.warn('[clipboard] copy failed', err)
    return false
  }
}
