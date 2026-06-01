/**
 * Log file tokenizer — VS Code LogFileHighlighter / One Dark 风格。
 *
 * 不依赖 highlight.js：使用正则规则集依次扫描文本，找出所有命中区间，
 * 贪心左对齐合并后输出带 `lh-*` class 的 `<span>` HTML。
 *
 * 重叠解析：同起始位置取更长的匹配；左到右贪心，跳过已占用区间。
 * 规则设计顺序（同类冲突时更长匹配优先）：
 *   时间戳 > 日志级别 > Caused by / 堆栈帧 > 异常类名 > URL > UUID > IP >
 *   十六进制 > 十进制 > key（lookahead）> 双引号 / 单引号字符串
 */

export interface HighlightResult {
  html: string
  language: string
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface RuleSpec {
  src: string
  cls: string
}

/**
 * 规则源列表。每条规则的 `src` 会以 `'gm'` flag 编译。
 * `m` flag 使 `^`/`$` 匹配行首/行尾（Caused by / 堆栈帧规则依赖此行为）。
 */
const RULE_SPECS: RuleSpec[] = [
  // ── 时间戳 ─────────────────────────────────────────────────────────────
  // ISO 8601 完整格式：2024-01-15T10:30:00.123Z 或空格分隔变体
  {
    src: String.raw`\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?`,
    cls: 'lh-ts'
  },
  // 纯时间 HH:mm:ss[.SSS]（含可选 T 前缀与毫秒）
  {
    src: String.raw`\b(?:T)?\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?\b`,
    cls: 'lh-ts'
  },

  // ── 日志级别 ───────────────────────────────────────────────────────────
  { src: String.raw`\b(?:FATAL|CRITICAL|EMERGENCY)\b`, cls: 'lh-fatal' },
  { src: String.raw`\b(?:ERROR|ERR|FAILURE|FAIL)\b`, cls: 'lh-error' },
  { src: String.raw`\bWARN(?:ING)?\b`, cls: 'lh-warn' },
  { src: String.raw`\b(?:INFO|INFORMATION|NOTICE)\b`, cls: 'lh-info' },
  { src: String.raw`\bDEBUG\b`, cls: 'lh-debug' },
  { src: String.raw`\bTRACE\b`, cls: 'lh-trace' },

  // ── 异常链 & 堆栈帧 ───────────────────────────────────────────────────
  // Caused by: xxx（行首可有缩进）
  { src: String.raw`^[ \t]*Caused by:[ \t]*.+$`, cls: 'lh-caused-by' },
  // 堆栈帧整行（兼容 module/path、Unknown Source、.java:行号）
  { src: String.raw`^[ \t]*at[ \t].+$`, cls: 'lh-stack' },
  // 异常类名（可选包前缀 + Exception/Error/…）
  {
    src: String.raw`\b(?:[a-zA-Z_$][\w$]*\.)*[A-Z][\w$]*(?:Exception|Error|Throwable|Fault|Panic)\b`,
    cls: 'lh-exception'
  },

  // ── 超链接 ────────────────────────────────────────────────────────────
  { src: String.raw`https?://[^\s"'<>\[\]{}|\\^` + '`' + String.raw`]+`, cls: 'lh-url' },

  // ── UUID / GUID ───────────────────────────────────────────────────────
  {
    src: String.raw`\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b`,
    cls: 'lh-uuid'
  },

  // ── IP（优先于普通数字）────────────────────────────────────────────────
  {
    src: String.raw`\b(?:\d{1,3}\.){3}\d{1,3}\b`,
    cls: 'lh-ip'
  },

  // ── 数字 ──────────────────────────────────────────────────────────────
  { src: String.raw`\b0x[0-9a-fA-F]+\b`, cls: 'lh-num' },
  { src: String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`, cls: 'lh-num' },

  // ── key=value / key: value（仅着色 key）────────────────────────────────
  { src: String.raw`\b[a-zA-Z_][\w]*(?==)`, cls: 'lh-key' },
  { src: String.raw`\b[a-zA-Z_][\w]*(?=\s*:\s)`, cls: 'lh-key' },

  // ── 字符串字面量 ──────────────────────────────────────────────────────
  { src: String.raw`"(?:[^"\\]|\\.)*"`, cls: 'lh-str' },
  { src: String.raw`'(?:[^'\\]|\\.)*'`, cls: 'lh-str' }
]

interface TokenMatch {
  start: number
  end: number
  cls: string
}

/**
 * 预编译一次复用：避免每次 highlightLog 都为这 ~16 条规则重新 `new RegExp`。
 * 'g' flag 会跨调用保留 lastIndex，故每次扫描前在 highlightLog 内归零。
 */
const COMPILED_RULES: ReadonlyArray<{ re: RegExp; cls: string }> = RULE_SPECS.map((s) => ({
  re: new RegExp(s.src, 'gm'),
  cls: s.cls
}))

/**
 * 对日志文本做语法着色，返回含 `<span class="lh-*">` 的 HTML 字符串。
 * 空值返回 `{ html: '', language: 'log' }`，不抛错。
 */
export function highlightLog(value: string | undefined | null): HighlightResult {
  if (value === undefined || value === null || value === '') {
    return { html: '', language: 'log' }
  }

  const matches: TokenMatch[] = []
  for (const { re, cls } of COMPILED_RULES) {
    re.lastIndex = 0 // 'g' flag 跨调用保留 lastIndex，每次扫描前必须归零
    let m: RegExpExecArray | null
    while ((m = re.exec(value)) !== null) {
      const len = m[0].length
      if (len === 0) {
        re.lastIndex++
        continue
      }
      matches.push({ start: m.index, end: m.index + len, cls })
    }
  }

  // 按起始位置升序排列；同起始位置时更长的匹配（end 更大）优先
  matches.sort((a, b) => a.start - b.start || b.end - a.end)

  // 贪心左对齐合并：跳过与已接受区间重叠的匹配
  const parts: string[] = []
  let pos = 0

  for (const m of matches) {
    if (m.start < pos) continue
    if (m.start > pos) {
      parts.push(escapeHtml(value.slice(pos, m.start)))
    }
    parts.push(`<span class="${m.cls}">${escapeHtml(value.slice(m.start, m.end))}</span>`)
    pos = m.end
  }

  if (pos < value.length) {
    parts.push(escapeHtml(value.slice(pos)))
  }

  return { html: parts.join(''), language: 'log' }
}
