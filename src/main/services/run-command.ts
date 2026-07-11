import { spawn } from 'node:child_process'
import type { RunCommandResult } from './terminal-launcher'

/**
 * `child_process.spawn` 的最小包装，多处注入点复用（terminal-launcher、hook 安装、
 * 刘海 JXA 检测），返回 `{code, stdout, stderr}`。
 */
export function runCommand(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeoutMs = 8000
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, env ? { env } : {})
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (r: RunCommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    // 超时兜底：osascript 遇无响应 app / 权限弹窗可能永不退出，否则会让调用方（如
    // island:openSession 的 IPC invoke）永久 pending。到点 SIGKILL 并以 code:-1 收敛，
    // 调用方自然走降级。
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: -1, stdout, stderr: stderr + '\n[runCommand timeout]' })
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }))
    child.on('error', (err) => finish({ code: -1, stdout, stderr: stderr + String(err) }))
  })
}
