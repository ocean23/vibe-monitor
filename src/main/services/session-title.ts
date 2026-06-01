import { promises as fsp } from 'node:fs'
import path from 'node:path'

/**
 * 读取 transcript 尾部的字节上限。Claude Code 把会话标题高频写进 transcript
 * （见下），尾部 512KB 足以覆盖最近一条 ai-title，避免整文件读爆大会话。
 */
const TAIL_BYTES = 512 * 1024

/**
 * 从一段（可能以半行开头）transcript 文本里取**最后一条** ai-title 的标题正文。
 *
 * Claude Code 每次刷新会话标题都会向 transcript 追加一行：
 *   {"type":"ai-title","aiTitle":"Fix rightmost navigation to Ghostty","sessionId":"..."}
 * 从后往前扫，命中第一条合法的即「最新标题」；半行 / 非 JSON 行解析失败跳过。
 */
export function parseLastAiTitle(chunk: string): string | undefined {
  const lines = chunk.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    // 先按子串粗筛，避免对每行（多为 message/tool 行）都跑一次 JSON.parse
    if (!line || !line.includes('"ai-title"')) continue
    try {
      const d = JSON.parse(line) as { type?: unknown; aiTitle?: unknown }
      if (d.type === 'ai-title' && typeof d.aiTitle === 'string') {
        const t = d.aiTitle.trim()
        if (t) return t
      }
    } catch {
      // 半行 / 非 JSON：跳过，继续往前找
    }
  }
  return undefined
}

/**
 * 取某会话的 Claude 自动标题（aiTitle）——它正是 Ghostty tab 名的正文
 * （tab 名形如 `<spinner> <aiTitle>`，如 `⠐ Fix rightmost navigation to Ghostty`）。
 *
 * **为什么用它做跳转匹配 needle**：terminal-launcher 靠「tab 名包含 needle」定位目标
 * tab；但 hook 派生的 sessionName 是 *用户 prompt 首行*，与 Claude 生成的英文标题几乎
 * 不重合（中文 prompt 更是零交集），导致匹配恒失败、只能 activate 不切 tab。改用 aiTitle
 * 后 needle 与 tab 名正文一致，`contains` 稳定命中。
 *
 * transcript 文件名即 `<sessionId>.jsonl`，散落在 `~/.claude/projects/<encoded-cwd>/` 各子目录；
 * 按 sessionId 唯一定位后读尾部取最后一条 ai-title。任意环节失败返回 undefined，
 * 调用方回退到 sessionName。
 */
export async function readAiTitle(
  projectsDir: string,
  sessionId: string
): Promise<string | undefined> {
  const id = sessionId.trim()
  if (!id) return undefined

  let filePath: string | undefined
  try {
    const subs = await fsp.readdir(projectsDir, { withFileTypes: true })
    for (const sub of subs) {
      if (!sub.isDirectory()) continue
      const candidate = path.join(projectsDir, sub.name, `${id}.jsonl`)
      try {
        await fsp.access(candidate)
        filePath = candidate
        break
      } catch {
        // 不在此 project 目录，继续找
      }
    }
  } catch {
    return undefined
  }
  if (!filePath) return undefined

  try {
    const stat = await fsp.stat(filePath)
    const start = Math.max(0, stat.size - TAIL_BYTES)
    const length = stat.size - start
    if (length <= 0) return undefined
    const fh = await fsp.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(length)
      await fh.read(buf, 0, length, start)
      return parseLastAiTitle(buf.toString('utf-8'))
    } finally {
      await fh.close()
    }
  } catch {
    return undefined
  }
}
