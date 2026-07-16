# 灵动岛 hover 展开动画平滑化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让灵动岛 hover 展开/收起的过程平滑连贯，替代当前「窗口瞬间跳变 + 内容瞬间弹出」的双重瞬变。

**Architecture:** 透明 Electron 窗口的几何变化只在「模式边界」发生且保持瞬时（展开时立刻扩到最终尺寸，收起时等可见内容收缩动画播完再收窗口）；真正看得见的展开/收起动作完全交给渲染端一个持久的 `.island-shell` 容器（宽高由 CSS transition 驱动），pill 内容与展开内容（会话面板/审批面板）常驻挂载、用 opacity+位移 crossfade，不再互相替换 DOM 子树。

**Tech Stack:** Electron (BrowserWindow/IPC) + React + 原生 CSS transition（不引入动画库）。

## Global Constraints

- 不引入新 npm 依赖（项目现状：仅 `lottie-web` / `p-limit` / `zustand`）。
- 全仓每个几何/时长常量只声明一份（重复声明是这个项目过去真实踩过的 bug 来源，见 `island-geometry.ts` 里 `NOTCH_COLLAPSED_WIDTH` 的注释）。
- 主进程 `island-window.ts` 的 `create()` / `ready-to-show` 位置校正 / `reposition()` 保持不动，不参与本次改动。
- 渲染端没有 DOM/组件级测试框架（`vitest.config.ts` 的 `environment:'node'`，`include` 只覆盖 `*.ts`，不含 `*.tsx`）；CSS/TSX 可见效果只能人工在 `pnpm dev` 里验证，主进程纯函数/IPC 部分照常写 vitest 单测。
- 设计依据：`docs/superpowers/specs/2026-07-16-island-smooth-expand-design.md`，以及用户提供的 `docs/灵动岛平滑过渡/SKILL.md`（原则来源）。

---

### Task 1: 把收起态默认尺寸常量搬到 `island-geometry.ts`

**Files:**

- Modify: `src/main/services/island-geometry.ts`
- Modify: `src/main/window/island-window.ts:17-19`（删除本地常量，改为从 geometry 导入）
- Test: `src/main/services/island-geometry.test.ts`

**Interfaces:**

- Produces: `DEFAULT_ISLAND_WIDTH: number`、`DEFAULT_ISLAND_HEIGHT: number`（从 `island-geometry.ts` 导出），供 Task 2 的 `island-ipc.ts` 使用。

这是纯搬迁（无行为变化）：`island-window.ts` 里私有的 `DEFAULT_ISLAND_WIDTH`/`DEFAULT_ISLAND_HEIGHT` 现在需要被 `island-ipc.ts` 也读到（Task 2 要用它算「非刘海机型收起态宽度」），搬到已经承载其它几何常量（`COLLAPSED_BAR_WIDTH` 等）的 `island-geometry.ts`，避免两处各写一份。

- [ ] **Step 1: 在 `island-geometry.ts` 追加导出常量**

在 `island-geometry.ts` 顶部常量区（`RUNNER_FOOT_ROOM` 之后、`NOTCH_COLLAPSED_WIDTH` 之前均可，建议紧跟 `NOTCH_COLLAPSED_WIDTH` 之后）追加：

```ts
/** 灵动岛收起态尺寸（像素）兜底默认值：JXA/启发式检测彻底失败（非 darwin）时使用，也是
 *  非刘海机型渲染端计算 shell 收起态目标宽度时的来源（见 island-ipc.ts 的 island:getNotchInfo）。
 *  原先在 island-window.ts 里私有声明，这里统一成一份，避免两处各写一遍。 */
export const DEFAULT_ISLAND_WIDTH = 520
export const DEFAULT_ISLAND_HEIGHT = 46
```

- [ ] **Step 2: 运行现有测试确认没有破坏任何东西**

Run: `pnpm vitest run src/main/services/island-geometry.test.ts`
Expected: 全部 PASS（本步骤纯新增导出，不改变任何现有函数行为）

- [ ] **Step 3: 更新 `island-window.ts` 改为导入**

在 `src/main/window/island-window.ts` 顶部 import 里加上 `DEFAULT_ISLAND_WIDTH, DEFAULT_ISLAND_HEIGHT`：

```ts
import {
  pickNotchDisplay,
  resolveNotchInfo,
  collapsedBounds,
  expandedX,
  localMenuBarHeight,
  NOTCH_COLLAPSED_WIDTH,
  DEFAULT_ISLAND_WIDTH,
  DEFAULT_ISLAND_HEIGHT,
  type NotchInfo
} from '../services/island-geometry'
```

删除文件里原本的本地声明：

```ts
/** 灵动岛收起态尺寸（像素）兜底默认值：JXA/启发式检测彻底失败（非 darwin）时使用。 */
const DEFAULT_ISLAND_WIDTH = 520
const DEFAULT_ISLAND_HEIGHT = 46
```

（其余引用 `DEFAULT_ISLAND_WIDTH`/`DEFAULT_ISLAND_HEIGHT` 的代码不用改，符号名不变。）

- [ ] **Step 4: 运行主进程全部单测确认无回归**

Run: `pnpm vitest run src/main`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/services/island-geometry.ts src/main/window/island-window.ts
git commit -m "refactor: 收起态默认尺寸常量统一到 island-geometry.ts"
```

---

### Task 2: 修正 `island:getNotchInfo` 的 `barWidth` 字段，回传 shell 收起态的完整目标宽度

**Files:**

- Modify: `src/main/ipc/island-ipc.ts:87-98`
- Test: `src/main/ipc/island-ipc.test.ts:84-103`

**Interfaces:**

- Consumes: `DEFAULT_ISLAND_WIDTH`（Task 1 产出）、`NOTCH_COLLAPSED_WIDTH`（已存在于 `island-geometry.ts`）
- Produces: `island:getNotchInfo` IPC 响应里的 `barWidth` 字段语义变为「shell 收起态目标宽度（px）：刘海机型=`NOTCH_COLLAPSED_WIDTH`，非刘海机型=`DEFAULT_ISLAND_WIDTH`」，供 Task 3 的 `use-notch-info.ts` 消费。

**背景**：这个字段目前存在但渲染端从未使用（值恒为 `COLLAPSED_BAR_WIDTH`=160，既不是黑条可见宽度也不是窗口宽度）。新架构里 `.island-shell` 需要一个「收起态目标宽度」的显式像素值来源（不能再用 `100%` 相对窗口宽度，原因见 spec），这个字段正好补上这个缺口。

- [ ] **Step 1: 修改 `island-ipc.test.ts` 里的期望值（先改测试，让它按新语义失败）**

`src/main/ipc/island-ipc.test.ts:101` 那处 `barWidth: 160` 改成 `barWidth: 191`（`notchInfo.hasNotch:true` 场景，`NOTCH_COLLAPSED_WIDTH = COLLAPSED_BAR_WIDTH(160) + BAR_SHOULDER(3) + BAR_OVERLAP(28) = 191`）：

```ts
it('merges notch info with derived geometry fields', async () => {
  islandWindow.getNotchInfo.mockReturnValue({
    hasNotch: true,
    width: 200,
    cornerRadius: 10,
    height: 38
  })
  islandWindow.getNotchTopInset.mockReturnValue(38)
  const out = (await handlers['island:getNotchInfo'](null)) as any
  expect(out).toMatchObject({
    hasNotch: true,
    width: 200,
    height: 38,
    overlap: 28,
    shoulder: 3,
    shoulderH: 10,
    topInset: 38,
    barWidth: 191
  })
})
```

再追加一个非刘海机型的用例（紧跟在上面这个 `it` 之后，仍在 `describe('island:getNotchInfo', ...)` 里）：

```ts
it('barWidth falls back to the default fallback width when hasNotch is false', async () => {
  islandWindow.getNotchInfo.mockReturnValue({
    hasNotch: false,
    width: 0,
    cornerRadius: 0,
    height: 24
  })
  islandWindow.getNotchTopInset.mockReturnValue(24)
  const out = (await handlers['island:getNotchInfo'](null)) as any
  expect(out.barWidth).toBe(520)
})
```

- [ ] **Step 2: 运行测试确认按预期失败**

Run: `pnpm vitest run src/main/ipc/island-ipc.test.ts`
Expected: FAIL（`barWidth` 实际值仍是 160，与期望的 191/520 不符）

- [ ] **Step 3: 修改 `island-ipc.ts` 实现**

顶部 import 增加 `DEFAULT_ISLAND_WIDTH`：

```ts
import {
  BAR_OVERLAP,
  BAR_SHOULDER,
  BAR_SHOULDER_H,
  COLLAPSED_BAR_WIDTH,
  NOTCH_COLLAPSED_WIDTH,
  DEFAULT_ISLAND_WIDTH
} from '../services/island-geometry'
```

（`COLLAPSED_BAR_WIDTH` 若改完后本文件不再直接使用，就从 import 里去掉——它现在只在算 `NOTCH_COLLAPSED_WIDTH` 时用到，那是 `island-geometry.ts` 内部的事。）

把 `island:getNotchInfo` handler 里的返回对象改成：

```ts
ipcMain.handle('island:getNotchInfo', () => {
  const notchInfo = deps.islandWindow.getNotchInfo()
  if (!notchInfo) return null
  return {
    ...notchInfo,
    overlap: BAR_OVERLAP, // 黑条右端钻进刘海背后的像素（CSS 用作内容右 padding 让位）
    shoulder: BAR_SHOULDER, // 左上椭圆凹肩水平半径（= 左侧透明预留宽）
    shoulderH: BAR_SHOULDER_H, // 左上椭圆凹肩垂直半径（> 水平 → 更陡）
    topInset: deps.islandWindow.getNotchTopInset(), // 展开态面板上方透明占位
    // .island-shell 收起态目标宽度（px）：刘海机型=黑条整窗宽（含凹肩+刘海背后重叠）；
    // 非刘海机型=收起态兜底宽度。渲染端用它设 --bar-width CSS 变量，让 shell 的宽度
    // 有一个不依赖「窗口当前实际宽度」的显式来源（新架构下窗口会先于可见内容瞬时改尺寸，
    // 见 use-island-resize.ts，若 shell 宽度还依赖 100% 相对窗口宽度，会跟着窗口瞬时跳变，
    // 而不是随 CSS transition 平滑变化）。
    barWidth: notchInfo.hasNotch ? NOTCH_COLLAPSED_WIDTH : DEFAULT_ISLAND_WIDTH
  }
})
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/ipc/island-ipc.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/island-ipc.ts src/main/ipc/island-ipc.test.ts
git commit -m "fix: island:getNotchInfo 的 barWidth 改为回传 shell 收起态整窗目标宽度"
```

---

### Task 3: 渲染端把 `barWidth` 注入为 `--bar-width` CSS 变量

**Files:**

- Modify: `src/renderer/src/lib/use-notch-info.ts`

**Interfaces:**

- Consumes: `NotchInfo.barWidth`（已存在于类型定义，Task 2 修正了其取值）
- Produces: CSS 自定义属性 `--bar-width`（挂在 `document.documentElement` 上），供 Task 4 的 `.island-shell` 收起态默认宽度使用。

- [ ] **Step 1: 修改 `loadNotch` 里注入 CSS 变量的部分**

```ts
const loadNotch = (): void => {
  void window.electronAPI?.islandGetNotchInfo?.().then((info) => {
    if (info) {
      const root = document.documentElement
      root.style.setProperty('--notch-h', `${info.height}px`)
      root.style.setProperty('--bar-radius', `${info.cornerRadius}px`)
      root.style.setProperty('--bar-overlap', `${info.overlap}px`)
      root.style.setProperty('--bar-shoulder', `${info.shoulder}px`)
      root.style.setProperty('--bar-shoulder-h', `${info.shoulderH}px`)
      root.style.setProperty('--notch-topinset', `${info.topInset}px`)
      root.style.setProperty('--bar-width', `${info.barWidth}px`)
    }
    setState({ info: info ?? null, loaded: true })
  })
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 无新增类型错误

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/lib/use-notch-info.ts
git commit -m "feat: 注入 --bar-width CSS 变量，供 shell 收起态宽度使用"
```

---

### Task 4: `use-island-resize.ts` 改造 —— 返回 shell 目标尺寸 + 收起延迟通知主进程

**Files:**

- Modify: `src/renderer/src/lib/use-island-resize.ts`（整体重写）

**Interfaces:**

- Produces: `useIslandResize(params): { contentRef, expandedWidth: number, expandedHeight: number }`（原先只返回 `contentRef`，Task 5 的 `Island.tsx` 要用新增的 `expandedWidth`/`expandedHeight` 设置 `.island-shell` 的行内样式）
- Produces: `ISLAND_SHELL_TRANSITION_MS = 220`（导出常量，Task 6 的 CSS 需要用同一个数字，通过行内样式 CSS 变量的方式传过去，而不是各写一份）

**背景**：详见 spec 的「架构调整」第 1/3 节。展开分支保持「立刻发 IPC」不变（窗口瞬时扩到位，肉眼不可见，只是预先铺画布）；收起分支从「立刻发 IPC」改成「等 shell 的 CSS 收缩动画播完再发」，避免窗口先于可见内容收窄。

- [ ] **Step 1: 完整替换文件内容**

```ts
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { SessionState, ApprovalRequest } from '../../../shared/island-types'
import type { NotchInfo } from './use-notch-info'

const PANEL_WIDTH = 640
const APPROVAL_WIDTH = 560

/** shell 收缩动画时长（ms）。收起时要等这段时间、CSS 收缩动画播完，才通知主进程把窗口
 *  收回黑条尺寸（见下方 effect），否则窗口会先于可见内容收窄，露出裁切。app.css 里
 *  `.island-shell` 的 transition 时长通过行内样式 `--island-shell-ms` 变量引用这同一个
 *  常量（Island.tsx 里设置），两处只有一份数字来源。 */
export const ISLAND_SHELL_TRANSITION_MS = 220

export interface UseIslandResizeParams {
  expanded: boolean
  hasApproval: boolean
  /** 仅用于触发重新测量（内容变化时尺寸可能变）；不直接读取其字段。 */
  sorted: SessionState[]
  pending: ApprovalRequest[]
  notchInfo: NotchInfo | null
}

export interface UseIslandResizeResult {
  /** 绑在承载展开态内容的 DOM 节点上（用于测 `scrollHeight`），常驻挂载，与是否可见无关。 */
  contentRef: RefObject<HTMLDivElement | null>
  /** 展开态 .island-shell 的目标宽/高（px）。渲染端只在 expanded 时把它设为行内样式，
   *  驱动 CSS transition 平滑长大/缩回；collapsed 时不设行内样式，落回 CSS 默认值
   *  （--bar-width / --notch-h）。 */
  expandedWidth: number
  expandedHeight: number
}

/**
 * 内容尺寸 → 回传主进程调整窗口，同时把「展开态目标尺寸」交给调用方设置 shell 的行内样式。
 *
 * 展开：立刻（无 animate）把窗口扩到目标尺寸——窗口透明，扩大过程不可见，只是预先把画布
 * 铺好，供 .island-shell 的 CSS 动画独立、平滑地在其中长大（不依赖原生窗口的 resize 时序）。
 *
 * 收起：先不动窗口，等 ISLAND_SHELL_TRANSITION_MS 后（shell 的收缩动画已经播完）才通知
 * 主进程把窗口收回黑条尺寸——这段时间窗口仍是展开态大小，但可见内容已经缩回黑条形状，
 * 多出的窗口区域全透明、不可见，不会露出空矩形。若期间用户重新 hover（expanded 变回
 * true），会先清掉这个还没触发的定时器，不会误收窗口。
 */
export function useIslandResize(params: UseIslandResizeParams): UseIslandResizeResult {
  const { expanded, hasApproval, sorted, pending, notchInfo } = params
  const contentRef = useRef<HTMLDivElement>(null)
  /** 上次回传主进程的窗口请求（按 收起/展开 + 尺寸 去重，跳过重复 islandResize IPC）。 */
  const lastSizeRef = useRef<{ mode: string; width: number; height: number } | null>(null)
  /** 收起态延迟通知主进程的定时器；重新 hover 时需要清掉，避免误收已经在重新展开的窗口。 */
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [target, setTarget] = useState({ width: PANEL_WIDTH, height: 48 })

  useLayoutEffect(() => {
    const api = window.electronAPI
    if (collapseTimerRef.current !== null) {
      clearTimeout(collapseTimerRef.current)
      collapseTimerRef.current = null
    }

    if (!expanded) {
      if (lastSizeRef.current?.mode === 'collapsed') return
      lastSizeRef.current = { mode: 'collapsed', width: 0, height: 0 }
      if (api?.islandResize) {
        collapseTimerRef.current = setTimeout(() => {
          collapseTimerRef.current = null
          void api.islandResize({ expanded: false })
        }, ISLAND_SHELL_TRANSITION_MS)
      }
      return
    }

    // 展开态：测量内容高度回传（含刘海占位 spacer），上限随刘海占位上浮
    const el = contentRef.current
    const width = hasApproval ? APPROVAL_WIDTH : PANEL_WIDTH
    const maxExpandH = notchInfo?.hasNotch ? 640 + notchInfo.topInset : 640
    const height = Math.max(48, Math.min(el ? Math.ceil(el.scrollHeight) : 200, maxExpandH))
    setTarget({ width, height })

    if (!api?.islandResize) return
    const last = lastSizeRef.current
    if (last && last.mode === 'expanded' && last.width === width && last.height === height) return
    lastSizeRef.current = { mode: 'expanded', width, height }
    void api.islandResize({ expanded: true, width, height })
    // sorted/pending 每次推送都是新引用，会反复触发本 effect；多数情况目标尺寸不变，
    // 故用 lastSizeRef 去重，跳过同尺寸的 IPC 回传，省掉无意义的 setBounds 抖动。
  }, [expanded, hasApproval, sorted, pending, notchInfo])

  // 卸载时清理未触发的收起定时器。
  useLayoutEffect(() => {
    return () => {
      if (collapseTimerRef.current !== null) clearTimeout(collapseTimerRef.current)
    }
  }, [])

  return { contentRef, expandedWidth: target.width, expandedHeight: target.height }
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 会看到 `Island.tsx` 里解构 `useIslandResize(...)` 只取了 `contentRef` 一项而报「其余属性未使用」——这是预期的，Task 5 会更新调用方。若 typecheck 对未使用的解构字段不报错（大概率如此，因为老代码本来就只解构了 `contentRef`），此步应直接 PASS。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/lib/use-island-resize.ts
git commit -m "feat: use-island-resize 收起态延迟通知主进程，并回传 shell 目标尺寸"
```

---

### Task 5: `app.css` —— 新增 shell/crossfade 层样式

**Files:**

- Modify: `src/renderer/src/styles/app.css`

**Interfaces:**

- Consumes: `--bar-width`（Task 3 注入）、`--notch-h`/`--bar-shoulder` 等既有变量、`--island-shell-ms`（Task 6 在 `Island.tsx` 里通过行内样式设置）
- Produces: `.island-shell` / `.island-pill-layer` / `.island-expanded-layer` / `.island-root.no-notch` 这几个新增/修改的类名，供 Task 6 的 `Island.tsx` 使用。

**说明**：`.island-pill` / `.island-panel` / `.island-approval` 自身的背景色、圆角、阴影、内边距等**完全不改**——它们各自的视觉设计维持原样，只是从「互斥条件渲染」变成「常驻挂载、由外层新增的 layer 包裹并做 opacity+位移 crossfade」。真正的尺寸动画只发生在新增的 `.island-shell` 上（宽高两个属性）。

**凹肩为什么不用单独写淡出规则**：`.island-pill.notch::before`（凹肩）是 `.island-pill` 的伪元素，而 `.island-pill` 现在整个嵌套在 `.island-pill-layer` 里。CSS 里父元素的 `opacity` 会让整个子树（含子元素的伪元素）作为一个合成层整体淡出，所以 `.island-pill-layer` 的 opacity 过渡会自动带着凹肩一起淡出/淡入，不需要给凹肩单写一条 `.is-expanded` 相关的规则。

**`use-mouse-ignore.ts` 不需要改**：点击穿透继续跟着 `expanded` 立即切换（不等收缩动画播完）——鼠标已经移出即视为不再交互，这与真实 Dynamic Island 的响应逻辑一致。

- [ ] **Step 1: 修改 `.island-root` 的 `justify-content`，新增 `.no-notch` 修饰符**

把现有的：

```css
.island-root {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  -webkit-app-region: no-drag;
  color: #e8e8ea;
  font-family: var(--font-ui);
  --island-surface: #000000;
}
```

改成：

```css
.island-root {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: flex-start;
  /* 刘海机型默认左对齐（原为 center）：新架构下窗口在 hover 触发瞬间就已瞬时扩到展开态
     最终尺寸（见 use-island-resize.ts），可见的 .island-shell 在这个已经变大的透明窗口里
     独立做宽高动画。若仍用 center，扩大后的窗口会把还很小的 shell 突然居中到窗口正中央，
     造成侧向跳动；改左对齐后 shell 才能稳定贴在窗口左缘原地长大（与刘海机型「同左缘展开」
     的既定设计一致，见 island-geometry.ts 的 expandedX 注释）。非刘海降级机型走
     .no-notch，见下方规则。 */
  justify-content: flex-start;
  -webkit-app-region: no-drag;
  color: #e8e8ea;
  font-family: var(--font-ui);
  --island-surface: #000000;
}
/* 非刘海降级机型：collapsedBounds/expandedX 两态都是「屏幕工作区居中」定位，窗口本身的
   x 会重新居中而非共享左缘。这里让 shell 在窗口内也居中，两层居中互相抵消，视觉上仍是
   「原地长大」而非侧移。 */
.island-root.no-notch {
  justify-content: center;
}
```

- [ ] **Step 2: 把 `.island-content` 替换成 `.island-shell`**

删除：

```css
.island-content {
  width: 100%;
}
```

替换为：

```css
/* 灵动岛可见形状的唯一尺寸动画来源：宽高由 JS 算出的目标值驱动（展开态走行内样式，
   收起态落回下面的 CSS 默认值），transition 时长通过行内样式变量 --island-shell-ms
   注入（与 use-island-resize.ts 的 ISLAND_SHELL_TRANSITION_MS 保持同一个数字来源）。
   overflow:hidden 让内部展开态内容（固定按最终宽度排版，见 .island-panel/.island-approval）
   在 shell 还没长大到位时被裁切/逐步显现，而不是整段溢出。 */
.island-shell {
  position: relative;
  overflow: hidden;
  width: var(--bar-width, 520px);
  height: var(--notch-h, 38px);
  transition:
    width var(--island-shell-ms, 220ms) cubic-bezier(0.32, 0.72, 0, 1),
    height var(--island-shell-ms, 220ms) cubic-bezier(0.32, 0.72, 0, 1);
}

/* pill 层与展开层：常驻挂载、绝对定位叠在一起，靠 opacity + 位移互相 crossfade——不再靠
   React 条件渲染互斥替换 DOM 子树（那样没法过渡）。谁都不卸载，谁不可见就
   pointer-events:none，避免拦截另一层的鼠标事件。 */
.island-pill-layer,
.island-expanded-layer {
  position: absolute;
  inset: 0;
  opacity: 1;
  transform: translateY(0);
  transition:
    opacity var(--island-shell-ms, 220ms) cubic-bezier(0.32, 0.72, 0, 1),
    transform var(--island-shell-ms, 220ms) cubic-bezier(0.32, 0.72, 0, 1);
}
.island-pill-layer.is-hidden,
.island-expanded-layer.is-hidden {
  opacity: 0;
  transform: translateY(-4px);
  pointer-events: none;
}
```

- [ ] **Step 3: 给展开态内容补上显式固定宽度**

`.island-panel` 和 `.island-approval` 目前没有显式 `width`，靠父容器 100% 自动撑满——新架构下父层（`.island-expanded-layer`）的宽度会跟着 shell 从小到大连续变化，若展开内容也跟着 100% 变宽，文字会在动画过程中重新排版（对应 spec 里「按最终宽度排版、由 shell 裁切显现」的要求）。

在 `.island-panel` 规则（约第 337 行）里加一行 `width`：

```css
.island-panel {
  /* 固定按最终宽度排版（= use-island-resize.ts 的 PANEL_WIDTH 640 减去左右各 8px margin），
     不随 shell 动画期间的中间宽度重排文字，由 shell 的 overflow:hidden 负责裁切/显现。
     两处数字必须保持同步。 */
  width: 624px;
  margin: 0 8px 8px;
  background: rgba(18, 18, 22, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
}
```

在 `.island-approval` 规则（约第 582 行）里同理：

```css
.island-approval {
  /* 固定按最终宽度排版（= use-island-resize.ts 的 APPROVAL_WIDTH 560 减去左右各 8px margin）。
     两处数字必须保持同步。 */
  width: 544px;
  margin: 0 8px 8px;
  background: rgba(18, 18, 22, 0.97);
  border: 1px solid rgba(245, 158, 11, 0.35);
  border-radius: 14px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
  overflow: hidden;
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
}
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/styles/app.css
git commit -m "feat: 新增 .island-shell/crossfade 层样式，驱动 hover 展开的平滑动画"
```

---

### Task 6: `Island.tsx` —— 接入 shell + 常驻 crossfade 结构

**Files:**

- Modify: `src/renderer/src/pages/Island.tsx`

**Interfaces:**

- Consumes: `useIslandResize(...)` 新返回形状（Task 4）、`.island-shell`/`.island-pill-layer`/`.island-expanded-layer`/`.island-root.no-notch`（Task 5）

- [ ] **Step 1: 替换 `useIslandResize` 调用与解构**

把：

```tsx
const contentRef = useIslandResize({ expanded, hasApproval, sorted, pending, notchInfo })
```

改成：

```tsx
const { contentRef, expandedWidth, expandedHeight } = useIslandResize({
  expanded,
  hasApproval,
  sorted,
  pending,
  notchInfo
})
```

- [ ] **Step 2: 替换整个 `return` JSX**

把从 `return (` 到函数结尾的 `)` 整段替换为：

```tsx
  return (
    <div
      className={
        'island-root' +
        (expanded ? ' expanded' : ' collapsed') +
        (notchInfo && !notchInfo.hasNotch ? ' no-notch' : '')
      }
      style={{ ['--island-shell-ms' as string]: `${ISLAND_SHELL_TRANSITION_MS}ms` }}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className="island-shell"
        style={expanded ? { width: expandedWidth, height: expandedHeight } : undefined}
      >
        {/* notchLoaded 落地前不渲染 pill：避免先按非刘海布局（CSS 默认值）渲染、IPC 结果
            到位后几十毫秒再整体跳到刘海样式的可见跳动。非刘海机型 notchLoaded 变 true 后
            notchInfo 仍是 null，走 CSS 默认值渲染，行为不变。pill 常驻挂载（不再受 expanded
            条件门控），展开时只是这一层淡出，好让它与展开层 crossfade。 */}
        {notchLoaded && (
          <div className={'island-pill-layer' + (expanded ? ' is-hidden' : '')}>
            <div
              className={'island-pill ' + (notchInfo?.hasNotch ? 'notch ' : '') + label.cls}
              onMouseEnter={() => setHovered(true)}
            >
              <span className="island-pill-status">
                {label.cls === 'running' ? (
                  <IslandRunner />
                ) : (
                  <span className="island-pill-dot" aria-hidden="true" />
                )}
                {/* 刘海黑条空间有限，省略文案标签，状态色足以传达信息 */}
                {!notchInfo?.hasNotch && label.text && (
                  <span className="island-pill-label">{label.text}</span>
                )}
              </span>
              <span className="island-pill-count">{sessions.length} sessions</span>
            </div>
          </div>
        )}

        {/* 展开层同样常驻挂载（会话面板 / 审批面板视 hasApproval 二选一渲染，谁都不因
            collapsed 而卸载），收起时整层淡出、与 pill 层 crossfade。 */}
        <div className={'island-expanded-layer' + (expanded ? '' : ' is-hidden')} ref={contentRef}>
          {/* 展开态刘海占位：顶部透明区域（高=刘海高），让面板从刘海正下方弹出 */}
          {notchInfo?.hasNotch && <div className="island-notch-spacer" aria-hidden="true" />}

          {hasApproval ? (
            <IslandApprovalPanel request={pending[0]} />
          ) : (
            <div className="island-panel" onMouseEnter={() => setHovered(true)}>
              <div className="island-panel-head">
                <span className="island-panel-title">Claude</span>
                <span className="island-panel-count">{sessions.length} sessions</span>
              </div>
              <div className="island-panel-list">
                {sorted.length === 0 ? (
                  <div className="island-panel-empty">暂无活跃会话</div>
                ) : (
                  sorted.map((s) => <IslandSessionCard key={s.sessionId} session={s} />)
                )}
              </div>
              <div className="island-panel-footer">
                <button
                  className={'island-toggle' + (trustAll ? ' on' : '')}
                  onClick={() => void saveSettings({ trustAll: !trustAll })}
                  title={trustAll ? '已跳过所有审批（点击关闭）' : '点击开启：跳过所有审批'}
                >
                  <span className="island-toggle-track">
                    <span className="island-toggle-thumb" />
                  </span>
                  <span className="island-toggle-label">跳过审批</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 引入 `ISLAND_SHELL_TRANSITION_MS`**

在文件顶部 import 区加上（放在已有的 `useIslandResize` import 那一行）：

```tsx
import { useIslandResize, ISLAND_SHELL_TRANSITION_MS } from '../lib/use-island-resize'
```

- [ ] **Step 4: 类型检查**

Run: `pnpm typecheck`
Expected: 无类型错误（注意 `style` 里用 `['--island-shell-ms' as string]` 是因为 React 的 `CSSProperties` 类型默认不包含自定义属性键，这个写法能绕过而不用整体断言成 `any`）

- [ ] **Step 5: 启动 dev 环境做第一轮人工验证**

Run: `pnpm dev`

先只验证「没有明显报错、灵动岛能正常显示收起态黑条」：

- 黑条正常贴刘海显示（或非刘海机型的居中黑条）
- 打开开发者工具看渲染进程 console，无红色报错

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/pages/Island.tsx
git commit -m "feat: Island.tsx 接入 shell + 常驻 crossfade 结构，替代 pill/panel 互斥渲染"
```

---

### Task 7: 端到端人工验证（对照 spec 的 Validation Checklist）

**Files:** 无代码改动，纯验证。

- [ ] **Step 1: 启动应用，制造至少一个活跃会话**

Run: `pnpm dev`（如需要真实会话数据，参照项目已有的启动会话方式；没有真实会话时至少能看到「暂无活跃会话」的空态面板）

- [ ] **Step 2: 逐条验证（对照设计文档的 Validation Checklist）**

- [ ] hover 进入：黑条平滑长大为面板，无侧向跳动、无文字重排
- [ ] hover 离开：面板平滑缩回黑条，无空矩形残留、无圆角瞬间跳变
- [ ] 快速反复 hover 进出（比如在黑条边缘反复划入划出）：动画能从当前状态直接反向，不需要等上一次动画播完
- [ ] 触发一次审批请求（PreToolUse hook 或项目里已有的测试审批入口）：同一套动效展开审批面板，且审批面板的琥珀色边框观感保留
- [ ] 收起态凹肩与展开态刘海占位衔接自然，无重叠、无露白
- [ ] 若有非刘海机型或外接显示器环境：同样验证一轮 hover 进出，确认 `.no-notch` 的居中锚定没有侧移

- [ ] **Step 3: 如发现问题，记录现象后回到对应 Task 修正**

不要跳过失败项直接判定完成——如果某一条验证不过，回到 Task 4/5/6 里定位具体是宽高来源、transition 时长、还是 crossfade 层的 opacity/pointer-events 出了问题，修正后重新走一遍 Step 2 的清单。

- [ ] **Step 4: 全部通过后，运行完整测试套件做最后确认**

Run: `pnpm test:run`
Expected: 全部 PASS（包含 Task 1/2 新增的用例）
