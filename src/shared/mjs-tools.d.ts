/**
 * 为 `tools/*.mjs` 工具脚本提供最小类型声明，便于单测从 TS 侧 import 其纯函数。
 * 这些脚本是运行期工具（Node ESM），不在 tsconfig 的源码 include 内，无生成的 .d.ts。
 */
declare module '*/island-hooks-install.mjs' {
  // 返回类型用 any：settings 是任意嵌套的 hooks 配置树，单测需自由下钻（out.hooks[ev]...），
  // 精确建模 GitLab/Claude hook schema 收益不抵成本。
  export function mergeIslandHooks(settings: Record<string, unknown>, command: string): any
  export function removeIslandHooks(settings: Record<string, unknown>): any
}

declare module '*/island-hook.mjs' {
  export function clip(s: unknown, max: number): string | undefined
  export function deriveSessionName(payload: Record<string, unknown>): string | undefined
  export function deriveLastMessage(payload: Record<string, unknown>): string | undefined
  export function deriveTerminal(): string | undefined
  export function deriveModel(payload: Record<string, unknown>): string | undefined
  export function translatePreToolUseDecision(outcome: string): 'allow' | 'deny' | 'ask'
}
