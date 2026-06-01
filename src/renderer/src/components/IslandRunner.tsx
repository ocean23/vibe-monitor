import React, { useEffect, useRef } from 'react'
import lottie from 'lottie-web'
// 路飞「原地走」矢量动画（来源：lottiefiles 社区样例，海贼王角色，仅供本工具自用，勿对外分发）。
// 画布 1920×1080 但人物只占中部一小块，故运行时自动裁切（见下）。
import runnerData from '../assets/luffy-runner.json'

/** 走→跑的提速倍率：原动画是慢走，1.6× 后步频接近小跑。 */
const RUN_SPEED = 1.6

/**
 * 收起态 running 状态的「路飞跑步小人」。
 *
 * 关键点：源动画是 1920×1080 大画布、人物原地走、居中于 x=960。直接渲染会让人物
 * 缩成一个点。这里在 DOMLoaded 后对渲染出的 <svg> 采样若干帧取 getBBox 并集，
 * 用人物实际包围盒覆盖 viewBox —— 与素材无关地把人物撑满容器，避免硬编码裁切框。
 */
export function IslandRunner(): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const anim = lottie.loadAnimation({
      container: host,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      animationData: runnerData,
      rendererSettings: { progressiveLoad: false }
    })
    anim.setSpeed(RUN_SPEED)

    // 自动裁切：等 SVG 构建完成后，按人物真实包围盒收紧 viewBox。
    const cropToFigure = (): void => {
      const svg = host.querySelector('svg')
      if (!svg) return
      try {
        const total = anim.getDuration(true) || 1
        // 采样整圈步态取并集，避免摆腿最大幅度帧的脚尖/手尖被裁掉
        const samples = 12
        let minX = Infinity
        let minY = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        for (let i = 0; i < samples; i++) {
          anim.goToAndStop((total * i) / samples, true)
          const b = svg.getBBox()
          if (b.width === 0 || b.height === 0) continue
          minX = Math.min(minX, b.x)
          minY = Math.min(minY, b.y)
          maxX = Math.max(maxX, b.x + b.width)
          maxY = Math.max(maxY, b.y + b.height)
        }
        if (Number.isFinite(minX)) {
          // 极小留白：尽量榨满盒子让路飞更大（手脚摆动极值已被上面 12 帧 bbox 并集包住，
          // pad 仅是额外安全余量，故可取小值）
          const pad = 2
          const vw = maxX - minX + pad * 2
          const vh = maxY - minY + pad * 2
          svg.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${vw} ${vh}`)
          svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
        }
      } catch {
        // getBBox 在极端情况下可能抛错；保底用原 viewBox（人物偏小但不崩）。
      } finally {
        anim.goToAndPlay(0, true)
      }
    }

    anim.addEventListener('DOMLoaded', cropToFigure)
    return () => {
      anim.removeEventListener('DOMLoaded', cropToFigure)
      anim.destroy()
    }
  }, [])

  return <div className="island-pill-runner" ref={hostRef} aria-hidden="true" />
}
