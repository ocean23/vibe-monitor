import { describe, it, expect, afterEach, vi } from 'vitest'
import { playStatusSound } from './island-sound'

describe('island-sound', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is a no-op when disabled (no window access)', () => {
    // 未 stub window —— disabled 分支必须在触碰 window 之前返回
    expect(() => playStatusSound('done', false)).not.toThrow()
  })

  it('is a no-op when AudioContext is unavailable', () => {
    vi.stubGlobal('window', {}) // 无 AudioContext / webkitAudioContext
    expect(() => playStatusSound('waiting', true)).not.toThrow()
    expect(() => playStatusSound('error', true)).not.toThrow()
  })

  it('synthesizes notes when AudioContext exists', () => {
    const starts: number[] = []
    const fakeOsc = () => ({
      type: '',
      frequency: { value: 0 },
      connect: vi.fn(),
      start: (t: number) => starts.push(t),
      stop: vi.fn()
    })
    const fakeGain = () => ({
      gain: {
        value: 0,
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn()
      },
      connect: vi.fn()
    })
    const fakeCtx = {
      currentTime: 0,
      state: 'running',
      destination: {},
      createOscillator: vi.fn(fakeOsc),
      createGain: vi.fn(fakeGain),
      resume: vi.fn()
    }
    // vitest 4 起，`new vi.fn(() => obj)()` 不再返回 obj；用真实构造器还原 AudioContext 语义
    // （构造函数返回对象时由 JS 规范保证 new 的结果就是该对象）
    class FakeAudioContext {
      constructor() {
        return fakeCtx as unknown as FakeAudioContext
      }
    }
    vi.stubGlobal('window', { AudioContext: FakeAudioContext } as unknown as Window &
      typeof globalThis)
    playStatusSound('done', true) // done 旋律有 3 个音
    expect(fakeCtx.createOscillator).toHaveBeenCalledTimes(3)
    expect(starts).toHaveLength(3)
  })
})
