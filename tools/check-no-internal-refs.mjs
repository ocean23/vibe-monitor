#!/usr/bin/env node
/**
 * pre-commit 守卫：阻止内部代号 / 内网 URL 溜进这个**公开镜像仓**
 * （github.com/ocean23/vibe-monitor）。
 *
 * 仅扫描本次「暂存的新增行」（git diff --cached），命中即阻断提交并列出位置——
 * 不动历史、不碰未改动内容。以下内部引用不得出现在公开仓：
 *   - 内网 GitLab 域名：gitlab.yc.com
 *   - 内部代号：hades / lucifer / monitor-claude
 *   - 内部 appId：com.saint.*（公开版应为 io.github.ocean23.*）
 *
 * 本脚本自身含上述模式（作为检测规则），扫描时会跳过自己。
 * 误报时可临时 `git commit --no-verify` 跳过（请谨慎确认确非泄露）。
 *
 * 仅依赖 Node 内置模块，可由 `node tools/check-no-internal-refs.mjs` 直接运行。
 */
import { execSync } from 'node:child_process'

/** 本脚本相对仓库根的路径——扫描时跳过，避免「检测规则」自身触发拦截。 */
const SELF = 'tools/check-no-internal-refs.mjs'

/** [正则, 人类可读说明]——任一命中即视为内部引用泄露。 */
const RULES = [
  [/gitlab\.yc\.com/i, '内网 GitLab 域名 gitlab.yc.com'],
  [/\bhades\b/i, '内部代号 hades'],
  [/\blucifer\b/i, '内部代号 lucifer'],
  [/\bmonitor-claude\b/i, '内部代号 monitor-claude'],
  [/com\.saint\b/i, '内部 appId com.saint.*（公开版应为 io.github.ocean23.*）']
]

/** 取暂存区相对 HEAD 的新增/改名/修改 diff（-U0：只含变更行，无上下文）。 */
function stagedDiff() {
  try {
    return execSync('git diff --cached -U0 --diff-filter=ACM', {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024
    })
  } catch {
    return ''
  }
}

function main() {
  const diff = stagedDiff()
  let file = ''
  let lineNo = 0
  const hits = []

  for (const raw of diff.split('\n')) {
    // 新文件块头：+++ b/<path>
    if (raw.startsWith('+++ b/')) {
      file = raw.slice('+++ b/'.length)
      continue
    }
    // hunk 头：@@ -a,b +c,d @@ → 取新增起始行号
    if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw)
      lineNo = m ? Number.parseInt(m[1], 10) : 0
      continue
    }
    // 新增行（排除文件头 +++）
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      if (file && file !== SELF) {
        const text = raw.slice(1)
        for (const [re, label] of RULES) {
          if (re.test(text)) {
            hits.push({ file, lineNo, label, text: text.trim().slice(0, 120) })
          }
        }
      }
      lineNo += 1
    }
  }

  if (hits.length === 0) return

  console.error('\n❌ 提交被阻断：检测到内部引用（公开镜像仓不得包含内部代号 / 内网 URL）\n')
  for (const h of hits) {
    console.error(`  ${h.file}:${h.lineNo}  [${h.label}]`)
    console.error(`    + ${h.text}`)
  }
  console.error(
    '\n请移除上述内容后再提交；若确认为误报，可临时 `git commit --no-verify` 跳过（谨慎）。\n'
  )
  process.exit(1)
}

main()
