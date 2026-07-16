# 灵动岛 hover 展开动画平滑化 — 设计文档

日期：2026-07-16

## 背景 / 问题

灵动岛的展开态不是纯 CSS 弹层，而是一个真实的透明 Electron `BrowserWindow`（`src/main/window/island-window.ts`）。目前的展开/收起流程：

1. 渲染端 `Island.tsx` 用 `{!expanded && <pill/>} {expanded && <panel/>}` 互斥条件渲染，`pill` 与 `panel` 是两个完全不同的 DOM 子树，切换时整段替换，没有任何过渡。
2. `use-island-resize.ts` 测量展开内容的 `scrollHeight`，通过 IPC 让主进程 `win.setBounds({x,y,width,height})` 一次性跳到目标尺寸——没有插值，瞬间跳变。
3. `app.css` 里 `.island-panel` 没有任何 `transition`。

结果是"窗口瞬间跳 + 内容瞬间弹出"两层瞬变叠加，用户感知为"展开过程很快、不平滑"。

## 参考

`docs/灵动岛平滑过渡/SKILL.md`（用户在另一个 SwiftUI/NSPanel 项目中验证过、体验满意的同类交互模型）。核心原则移植到本项目：

- 窗口（透明容器）与可见岛形状（内容层）是两个独立的层：**窗口几何变化只允许发生在模式边界，且必须先于可见内容的动画**，不能让两者被绑在一起同步做动画（"单一运动引擎"原则——避免原生窗口按系统节奏动、CSS 内容按另一套节奏动，两者打架）。
- 可见岛的宽/高/圆角要作为同一个"运动快照"一起插值，而不是无动画地互相替换 DOM 子树。
- 展开态内容按最终宽度常驻排版，由外层裁切/显现，不随着宽度动画重新排版。
- 不要在动画结束后才让窗口"追上"最终形状——会造成裁切/跳变。

## 目标（本次范围）

- Hover 进入：黑条 pill 平滑长大为聚合面板 panel，无跳变、无文字重排、无裁切闪烁。
- Hover 离开：面板平滑缩回黑条，动画结束后窗口才收窄，不出现空矩形残留。
- 收起态特有的"凹肩"（贴合刘海物理形状的椭圆遮罩）在展开时优雅淡出，收起时淡回，不参与宽高插值。
- 不引入新依赖（沿用项目现状：仅 lottie-web / p-limit / zustand）。
- 审批面板（`IslandApprovalPanel`，优先级高于 hover）复用同一套展开动效。

不在本次范围：收起态黑条本身跑步动画细节、多屏拓扑切换时的窗口纠偏动画（`reposition()` 保持瞬时，不涉及 hover 观感）、`create()` 首次创建窗口的瞬时定位。

## 架构调整

### 1. 主进程：窗口几何变化只在模式边界发生，且不与内容动画绑定同步（`island-window.ts` / `island-ipc.ts`）

- **展开**（hover 进入 / 出现审批）：渲染端一测到需要展开，**立刻**（无 `animate` 参数，普通瞬时 `setBounds`）把窗口扩到最终展开尺寸。此时窗口透明，扩大过程肉眼不可见，只是预先把"画布"铺好，供内容层动画在其中生长。
- **收起**（hover 离开且无审批）：渲染端先让可见 shell 用 CSS 收缩回黑条尺寸；收缩动画结束后（约 220ms，见下），才发 IPC 让窗口 `collapse()` 缩回黑条尺寸。期间窗口仍是展开态大小，但内容已经缩回黑条形状，多出的窗口区域全透明、不可见，不会露出空矩形。
- `create()`（首次创建）、`ready-to-show` 里的位置校正、`reposition()`（多屏拓扑纠偏）**不改动**——它们是瞬时纠偏场景，不是 hover 过渡的一部分。

### 2. 渲染端：持久 shell + crossfade，取代条件渲染互斥（`Island.tsx` / `app.css`）

- 新增一个持久的 `.island-shell` 容器，宽高圆角由一个 class（如 `.is-expanded`）驱动，`transition: width, height, border-radius`（220ms，统一缓动曲线）。宽高圆角三者绑定同一次 transition，保证是"一个运动快照"而不是各自独立变化。
- pill 内容与 panel 内容**同时挂载**（不再互斥条件渲染），绝对定位堆叠在 shell 内部，靠 `opacity`（+ 轻微 `translateY`/`blur`）随 `.is-expanded` 互相 crossfade。谁都不卸载，避免"内容瞬间清空再瞬间填入"的跳变。
- panel 内容始终按展开态最终宽度（640px / 审批态 560px）常驻排版，不随 shell 宽度动画重新走 reflow；shell 的 `overflow:hidden` 负责"裁切/显现"。
- 收起态 pill 左上角的凹肩伪元素（`.island-pill.notch::before`）的 `opacity` 跟随 `.is-expanded` 淡出/淡入（展开时消失——展开态已有独立的刘海占位 spacer 承担"不遮刘海"的职责），不参与宽高插值，避免两种不同拓扑形状（凹肩 pill vs. 纯圆角卡片）互相插值导致的形变怪异。

### 3. 时序耦合：一个共享常量，两处消费

- 定义一个 TS 常量（如 `ISLAND_SHELL_TRANSITION_MS = 220`），通过内联样式注入为 CSS 自定义属性（`--island-shell-ms`），CSS transition 引用该变量；渲染端"收起动画结束后才通知主进程收窗口"的定时器使用同一个常量。两处引用同一个数字来源，避免以后改动画时长时忘记同步。
- 主进程 IPC 往返（渲染端 → 主进程 `setBounds`）是同进程树内的本地调用，延迟通常在个位数毫秒级，相对 220ms 的动画可忽略不计——"先扩窗口再长内容"不需要额外的握手/等待机制。

## 已知取舍 / 边界情况

- 展开/收起的可见动画完全由 CSS 驱动，不再使用 Electron `setBounds` 的原生 `animate` 参数（该参数会引入第二套系统节奏，与内容层动画不同步，故弃用）。
- `use-mouse-ignore.ts` 的点击穿透仍然跟随 React 的 `expanded` 状态**立即**切换（不等收起动画播完）：鼠标已经移出即视为不再交互，这与真实 Dynamic Island 的响应逻辑一致，不需要额外延迟。
- `use-island-resize.ts` 中用于回传窗口尺寸的测量只读 `scrollHeight`（不受 `opacity`/`transform` 影响），因此不会与新增的 shell 动画互相干扰；但如果未来内容测量方式改为依赖 `offsetHeight`/布局盒尺寸，需要注意 shell 动画期间该尺寸应保持稳定（本次动画只动 `width/height`（shell 容器本身的目标值，非渐变过程中的中间态被读取）/`border-radius`/`opacity`，不涉及会被内容测量读到的中间态）。

## 验证方式

对照 `docs/灵动岛平滑过渡/SKILL.md` 的 Validation Checklist 精神，人工验证：

- hover 进入：黑条平滑长大为面板，无侧向跳动、无文字重排。
- hover 离开：面板平滑缩回黑条，无空矩形残留、无圆角瞬间跳变。
- 快速反复 hover 进出：动画能从当前状态直接反向，不需要等上一次动画播完。
- 审批请求到达（优先级高于 hover）：同一套动效展开审批面板。
- 收起态凹肩与展开态刘海占位衔接自然，无重叠/露白。
- 多屏 / 刘海机型与非刘海机型均验证一次。
