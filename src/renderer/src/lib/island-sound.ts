/**
 * 8-bit 像素风状态音效（FR-009）——用 WebAudio 合成方波，无需打包音频文件。
 *
 * 每种状态一段短旋律：
 * - waiting（等审批/输入）：上行两音「叮咚」，提示需要注意
 * - done（完成）：上行三音琶音，轻快收尾
 * - error（出错）：下行两音，低沉
 *
 * 仅在状态切换为上述三态时由 Island 调用；running 不发声（太频繁）。
 * AudioContext 懒创建；浏览器策略下可能 suspended，调用时尝试 resume，失败静默。
 */

export type SoundStatus = 'waiting' | 'done' | 'error'

interface Note {
  /** 频率 Hz */
  freq: number
  /** 起始偏移（秒） */
  at: number
  /** 时长（秒） */
  dur: number
}

const MELODIES: Record<SoundStatus, Note[]> = {
  // 叮—咚：A5 → E6
  waiting: [
    { freq: 880, at: 0, dur: 0.09 },
    { freq: 1318.5, at: 0.1, dur: 0.12 }
  ],
  // 上行琶音 C6 E6 G6
  done: [
    { freq: 1046.5, at: 0, dur: 0.08 },
    { freq: 1318.5, at: 0.09, dur: 0.08 },
    { freq: 1568, at: 0.18, dur: 0.13 }
  ],
  // 下行 G4 → C4
  error: [
    { freq: 392, at: 0, dur: 0.12 },
    { freq: 261.6, at: 0.13, dur: 0.18 }
  ]
}

let ctx: AudioContext | null = null

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!ctx) {
    try {
      ctx = new Ctor()
    } catch {
      return null
    }
  }
  return ctx
}

/**
 * 播放某状态的 8-bit 音效。`enabled=false` 时直接 no-op（Settings 开关）。
 * 任何 WebAudio 异常都被吞掉——音效是锦上添花，绝不影响主流程。
 */
export function playStatusSound(status: SoundStatus, enabled: boolean): void {
  if (!enabled) return
  const audio = getCtx()
  if (!audio) return
  // 自动播放策略下 ctx 可能挂起，尝试恢复
  if (audio.state === 'suspended') void audio.resume().catch(() => {})
  const melody = MELODIES[status]
  if (!melody) return
  try {
    const now = audio.currentTime
    const master = audio.createGain()
    master.gain.value = 0.12 // 整体音量克制，避免突兀
    master.connect(audio.destination)
    for (const note of melody) {
      const osc = audio.createOscillator()
      osc.type = 'square' // 方波 = 8-bit 质感
      osc.frequency.value = note.freq
      const g = audio.createGain()
      // 短促 attack/decay 包络，避免爆音
      const start = now + note.at
      const end = start + note.dur
      g.gain.setValueAtTime(0, start)
      g.gain.linearRampToValueAtTime(1, start + 0.005)
      g.gain.setValueAtTime(1, Math.max(start + 0.005, end - 0.02))
      g.gain.linearRampToValueAtTime(0, end)
      osc.connect(g)
      g.connect(master)
      osc.start(start)
      osc.stop(end + 0.01)
    }
  } catch {
    /* WebAudio 异常静默 */
  }
}
