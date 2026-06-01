/**
 * 「跳回终端」(terminal-launcher) 的结果类型。
 *
 * 从原始监控实现抽出时只保留 open-session 相关类型（原文件还含远程推送用的
 * ClaudeNotifyMeta，vibe-monitor 纯本地、不经远程后端，故剔除）。命名沿用旧名以
 * 减少 terminal-launcher / island-ipc 的改动面。
 */

/**
 * `openSession` 的处理模式：
 * - `navigated`：定位到匹配 tab，已把对应窗口/tab 提到最前（**只跳转，不输入任何命令**）
 * - `activated_copied`：终端已激活但未能定位 tab（多/零 tab 匹配 / 权限不足 / 无 session_name），
 *   作为退化兜底把 `claude resume <id>` 写入剪贴板，用户可手动 Cmd+V Enter 重开
 * - `launched_only`：终端原本未运行，本次仅 `open -a` 唤起
 * - `copied_only`：非 macOS 平台或 osascript 完全不可用，仅复制
 * - `no_session_id`：事件未携带 session_id，无可恢复目标
 */
export type ClaudeNotifyOpenSessionMode =
  | 'navigated'
  | 'activated_copied'
  | 'launched_only'
  | 'copied_only'
  | 'no_session_id'

export interface ClaudeNotifyOpenSessionResult {
  ok: boolean
  mode: ClaudeNotifyOpenSessionMode
  /**
   * 细分原因（仅在需要给用户更具体提示时填）。当前取值：
   * - `no-permission` —— 辅助功能授权缺失（AXRaise / keystroke 失败，-1719 / assistive access）
   * - `no-automation-permission` —— 对目标 app 的自动化授权缺失（-1743 / Not authorized to send Apple events）
   * - `no-matching-tab` —— 没有 tab 标题包含 session_name
   * - `multiple-matches` —— 多个 tab 标题命中同一 session_name
   * - `no-session-name` —— 事件未携带 session_name
   * - `tab-index-out-of-range` —— 目标 tab 在窗口内序号 > 9，Ghostty 默认 Cmd+digit 无法覆盖
   * - `inject-failed` —— inject 脚本非权限类错误
   * - `not-found` —— 通知 uuid 已被清空
   * - `launch-failed` —— `open -a` 失败（无此 app）
   */
  reason?: string
  /** navigated 时返回命中并提到最前的 tab 标题，便于渲染端展示「已跳到 <tab>」 */
  matchedTab?: string
}
