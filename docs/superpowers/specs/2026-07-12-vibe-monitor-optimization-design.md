# vibe-monitor 优化设计（2026-07-12）

## 背景

灵动岛高度不对齐问题修复后（`hasNotch` 字段区分真实刘海机型 vs 校准后的 fallback 高度），
对 vibe-monitor 做了一轮全面 review（5 路并行 agent，覆盖主进程、渲染端、services 层、
测试链、构建配置），共发现 19 条问题。经过与用户逐项澄清优先级，确定本轮优化覆盖
**正确性问题（5条）+ 安全/健壮性（3条）+ 架构与可维护性（4条）** 共 12 条，暂不处理
发布/打包剩余项（Dock 图标、tools lint）和测试/工程效率项（CI、死代码、状态色变量、
依赖升级）——这些留到以后单独处理。

macOS 签名问题已在本轮之外单独处理完：项目是开源到 GitHub 的源码，不分发预编译产物，
不需要 Developer ID + 公证；已在 `package.json` 的 `build.mac` 加 `"identity": null`，
避免 electron-builder 随机捡本机 keychain 里的证书做非确定性签名。

## 已确认的问题清单（12 条，按工作块归类）

### 工作块 A：状态机类型收紧

1. `island-state.ts` 的 `applyEvent` 主链路缺少 "done/error 终态不可复活" 的守卫；
   `notificationStatus`、`markActive` 各自单独写了等价守卫，逻辑重复且不完整覆盖——
   是近三次 fix commit（AskUserQuestion 后卡等待审批 / 长思考误报空闲 / Notification
   误报等待审批）的共同根因。
2. `stopReason` 跨轮次残留：新一轮 Stop 事件若未带 `stop_reason`，会显示上一轮的过期值
   （`prev?.stopReason` 兜底逻辑导致）。
3. `error` 状态从未被真正赋值过：全仓搜索确认只在守卫代码里被引用，没有产生路径，是
   类型层面的死状态。

### 工作块 D：安全/健壮性加固

4. `island-server.ts` 本机同用户其他进程理论上可批量伪造 `/event`、`/approval` 请求
   （token 文件同用户可读，且无限流/数量上限），可能挤出真实活跃会话或做 UI 欺骗。
5. `tools/island-hooks-install.mjs` 写入的 PreToolUse hook 条目未显式设置 `timeout`
   字段，如果 Claude Code 默认超时早于 `island-hook.mjs` 自身的 65s 兜底，"绝不阻塞
   用户" 的安全网会失效。
6. `island-config.ts` 的 `patchIslandConfig` 读-改-写无锁，快速连续调用可能丢更新；
   且不接收 `audit`，写失败完全静默（`ensureIslandConfig` 有 audit，这个没有）。

### 工作块 C：渲染端重构

7. `Island.tsx` 的 `IslandRoot` 组件 253 行塞了 5 个 `useEffect`（刘海几何获取、音效、
   IPC 尺寸回传、鼠标穿透、渲染逻辑交织），难以单独理解和测试。
8. "最紧急状态" 判断逻辑在 `island-store.ts` 的 selector 和 `Island.tsx` 的
   `collapsedLabel()` 里各写了一遍，容易改一处漏一处。
9. 冷启动时黑条先按非刘海布局渲染（CSS 默认值），几十毫秒后 `notchInfo` 回传才切到
   刘海样式，造成一次可见跳动。

### 工作块 B：index.ts 完整拆分

10. `src/main/index.ts`（681 行）零单元测试覆盖，且身兼单实例锁、窗口生命周期、刘海
    JXA 检测、托盘菜单、hook 安装粘合、6 类 IPC handler 共 6 种职责。
11. 几何计算逻辑散落在 `collapsedBounds`、`setupIsland` 初始化块、`island:resize`
    handler、`scheduleReposition` 四处，各自独立计算 `ISLAND_WIDTH` 等派生尺寸。
12. `ISLAND_WIDTH` 计算公式两处不一致（真实 bug，非有意为之）：`setupIsland`
    （约345行）用 `COLLAPSED_BAR_WIDTH + BAR_OVERLAP`，`scheduleReposition`
    （约482行）用 `COLLAPSED_BAR_WIDTH + BAR_SHOULDER + BAR_OVERLAP`，漏了
    `BAR_SHOULDER`；用 `git log -p` 确认从首次提交起就是这样，是复制粘贴漂移。

## 工作块方案

### 工作块 A：状态机类型收紧

**范围**：`src/shared/island-types.ts`、`src/main/services/island-state.ts`

**方案**：

1. 把 `SessionState` 改成按 `status` 区分的判别式联合类型——字段只在对应分支出现
   （比如 `stopReason` 只存在于 `status: 'done'` 分支），从类型层面防止"状态已变但
   旧字段残留"这类问题（对应问题 2）。
2. 抽一个统一的 `applyStatusTransition(prev, next)` 纯函数，封装"done/error 是终态、
   不可被后续事件复活"的规则，返回类型安全的新 `SessionState`。
3. `applyEvent`、`notificationStatus`、`markActive` 三处全部改为调用这个函数，删除
   各自零散的守卫代码（对应问题 1）。
4. `error` 分支类型化后现场检查它目前有没有真实产生路径（对应问题 3）：如果确认没有，
   在实施时决定是"补一条真实错误上报路径"还是"从可产生的状态集合里去掉、只保留类型
   防御"，把最终决定和理由写回本文档或提交信息里。

**验证**：`island-state.test.ts` 补充乱序/迟到事件不应复活终态会话的用例；跑通现有
全部测试（含新增）。

### 工作块 D：安全/健壮性加固

**范围**：`src/main/services/island-server.ts`、`src/main/services/island-config.ts`、
`tools/island-hooks-install.mjs`

**方案**：

1. `island-server.ts` 给 `/event`、`/approval` 加简单限流（活跃会话数上限 + 每秒请求数
   上限），超限直接拒绝并 audit 记录（对应问题 4）。
2. `island-hooks-install.mjs` 安装 hook 条目时显式写 `timeout: 70`（秒），与
   `island-hook.mjs` 自身 65s 兜底对齐留出余量（对应问题 5）。
3. `island-config.ts` 给 `patchIslandConfig` 加一个简单的串行写队列（Promise 链式排队），
   避免并发读改写互相覆盖；读写失败统一走 `audit`（对应问题 6）。

**验证**：`island-server.test.ts`、`island-config.test.ts`、`island-hooks-install.test.ts`
补对应用例（限流生效、`timeout` 字段写入、并发 patch 不丢更新）。

### 工作块 C：渲染端重构

**范围**：`src/renderer/src/pages/Island.tsx`、`src/renderer/src/store/island-store.ts`

**依赖**：排在工作块 A 之后——A 改的 `SessionState` 判别式联合类型会影响这里读字段
的地方，先做 A 可以避免返工。

**方案**：

1. 拆出 4 个自定义 hook：`useNotchInfo()`（读取+订阅刘海几何、注入 CSS 变量）、
   `useIslandSound()`（状态变化音效）、`useIslandResize()`（内容尺寸回传主进程）、
   `useMouseIgnore()`（点击穿透开关），`IslandRoot` 只保留订阅 store + 组装渲染
   （对应问题 7）。
2. 统一"最紧急状态"逻辑：只保留 store 里的 selector 作为唯一实现，`Island.tsx` 的
   `collapsedLabel()` 改为只做"状态 → 文案映射"，不再重复判断优先级（对应问题 8）。
3. `useNotchInfo` 增加 loading 标记，`notchInfo` 结果落地前不渲染 pill（或用 CSS
   透明度短暂隐藏），消除冷启动时非刘海布局到刘海布局的可见跳动（对应问题 9）。

**验证**：`island-store.test.ts` 跑通；视时间补 hook 级单测；dev 模式手工确认冷启动
无跳动。

### 工作块 B：index.ts 完整拆分

**范围**：`src/main/index.ts` 及新增模块

**方案**：

1. 新建 `src/main/services/island-geometry.ts`：把 `collapsedBounds`、
   `getNotchDisplay` 选屏逻辑、`detectNotchInfo` 的 JXA 结果解析、
   `ISLAND_WIDTH`/`ISLAND_COLLAPSED_HEIGHT` 计算全部改成不依赖模块级可变状态的纯函数
   （接收当前 `NotchInfo` 返回几何结果），统一掉问题 12 的公式不一致。
2. 新建 `src/main/window/island-window.ts`：`BrowserWindow` 创建、resize、
   mouseIgnore、reposition 相关逻辑，内部调用 `island-geometry.ts` 的纯函数。
3. 新建 `src/main/tray.ts`：托盘菜单相关逻辑（若目前内联在 index.ts）。
4. 原本内联在 index.ts 的 `island:getNotchInfo`/`island:resize`/`island:setMouseIgnore`
   三个 IPC handler 一并挪进 `island-ipc.ts`，让 IPC 面收口到一个文件。
5. `index.ts` 只保留 `app.whenReady` 装配、单实例锁、各模块的组装调用（对应问题 10、11）。

**验证**：给 `island-geometry.ts` 补单测（不依赖 Electron，直接测各分支，包括
`hasNotch` true/false）；其余文件继续跑现有 `island-ipc.test.ts` 等；整体跑
typecheck + lint + test。这个改动面最大，建议单独一次提交，不和其他工作块混在一次
diff 里，便于回溯。

## 实施顺序

**D → A → C → B**

- D 最小最独立，风险最低，先做建立信心。
- A 价值最高（是三次历史 bug 的共同根因），改动集中在两个文件。
- C 依赖 A 的类型变化，排在 A 之后避免返工。
- B 改动面最大、和其他三块相对独立，放最后单独验证。

## 本轮不处理（记录以备将来）

- 三、发布/打包剩余项：纯托盘应用未隐藏 Dock 图标；`tools/*.mjs` 脱离 eslint/tsc 检查。
- 五、测试与工程效率：无 CI（pre-commit 不跑 tsc/vitest）；`Island.tsx` 死代码
  `COLLAPSED_FALLBACK`；状态色三处硬编码 hex 未提取 CSS 变量；TypeScript/eslint/vite
  依赖落后一个大版本。

## 实际执行方式（偏离 writing-plans 标准流程，记录原因）

写完本文档后，原计划是转入 `writing-plans` 生成详细任务清单，再由用户选择
subagent-driven 或 inline 方式执行。但工作块 A 涉及判别式联合类型这种需要真实
TypeScript 编译器验证的设计决策（`stopReason` 在联合类型分支间的访问收窄等），
为了确保写进计划里的代码不是臆造的伪代码，直接在真实代码里做了一版实现并跑通
typecheck/lint/test。工作块 A 验证完毕后，用户明确选择"直接提交，继续用同样方式
做 D/C/B"，即放弃预先写详细 plan 文档、改为每个工作块"直接实现 → 验证
（typecheck+lint+test，工作块 B 额外做了 dev 模式真机冒烟测试）→ 提交"的方式
逐块推进。

四个工作块均已完成并提交：

- `01caade` fix: 非刘海机型灵动岛黑条高度校准（本轮优化之前的原始 bug 修复，见对话开头）
- `ab579f6` fix: 工作块 A（状态机终态守卫统一）
- `c1c121a` fix: 工作块 D（安全/健壮性加固）
- `8590311` refactor: 工作块 C（渲染端重构）
- `30501de` refactor: 工作块 B（index.ts 拆分）

工作块 B 验证过程中，用户实际截图发现了两个本文档未预见的连带问题（黑条高度从
写死值改为按实机菜单栏高度动态计算后，`.island-pill-runner` 图标固定尺寸与黑条
不成比例、整体偏下），已一并修在 `30501de` 里，属于本轮优化触发的真实回归，不是
计划外加戏。
