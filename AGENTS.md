# Knit 插件代码纪律（作用于 `knit/` 下）

> 这是**作用域层**。DSH 的指令链是「项目根 → 会话工作目录」逐层加载：agent 对 `knit/` 下的文件
> 做过一次成功的 `read` / `write` / `edit` 之后，宿主会把本文件自动追加进上下文
> （`Additional instructions from: knit/AGENTS.md`）；文件变了会替换，删了会发 `Instructions removed`。
>
> - **常驻层 = 上级 `../AGENTS.md`**：怎么干活、当前状态、禁止事项、必读顺序（每一轮都在）
> - **本层 = 动这份代码时不能碰的东西**：构建约束、颜色与几何纪律、测试写法、目录与测试分工
> - **任务层 = skill**：发布（`dsh-plugin-release`）、真机验收、插件恢复 —— 只在要做那件事时加载
> - **史料层 = `99_暂存文档/`**、`knit/CHANGELOG.md`、`Knit-决策记录.md` —— 从不注入
>
> ⚠️ **预算**：本层 ≤ 40 KiB，与常驻层（≈16 KiB）合计 ≤ 56 KiB（宿主 `maxBytes` = 65536；
> 超预算时宿主会**先整体丢弃较宽泛的文件**，也就是常驻层会先消失）。改完跑
> `node tools/agents-budget.mjs`（两层一起核；`--claims` 反查版本 / 测试数漂移，`--strict` 让余量预警致命）。

---

## 6. 硬性技术约束

违反这些会让插件直接坏掉，不是风格问题。

---

### 6.1 客户端半边没有构建步骤

`knit/src/client/client.js` 是**手写脚本**，由 `window.__ModuleLoader__.load({...})` 直接装载：

- **不要引入 JSX** —— 用 `React.createElement`
- **不要引入 tsdown / tsc / 打包器** —— 没有 build 脚本，DSH 直接读磁盘上的文件
- 加载期能 `require` 的是**基线 seed**，实测 **9 个**（2026-09-23 核）：`react`、`react/jsx-runtime`、
  `react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、
  `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
  `@deepseek-ai/dsh-client-ui-dockkit`。⚠️ **要更多就走 `dsh.client.external?: string[]`**
  （`dsh-package-manifest/lib/types/types.d.ts:70`，可含 `<pkg>/client` 这类子路径）
- **静态资源也要内联**：图标 `path` 直接写在代码里（`KNIT_ICON_PATH`），加载期读不到文件。
  源文件在 `knit/assets/` —— **改图标必须两处一起改**，`test/icon.test.mjs` 会核对两者逐字一致
- ⚠️ **整个 CSS 在一个模板串里（`const CSS = \`…\`），注释里不能出现反引号** —— 一个反引号就会
  把模板提前截断，客户端半边整个加载失败（踩过四回，`node --check` 看不出来）

---

### 6.2 图标配色是硬要求

`.knit-icon { color: var(--dsw-alias-label-primary, #0f1115) }` —— **一条规则管两个主题**（令牌自己随主题切），
**不要写死 `#000` / `#fff`，也不要让它继承父级文本色**。
⚠️ 2026-10-07 改过：原来写死「浅色纯黑 / 暗色纯白」，用户指出暗色的 `#fff` 比 DSH 自己的主文本色
`#f9fafb` 还亮（原话「看得有点犯晕」）⇒ 改成一律跟随官方主文本色令牌。`test/icon.test.mjs` 现在反过来守
「不许出现 `.knit-icon{color:#000|#fff}`」「不许有 `body[data-ds-dark-theme] .knit-icon` 覆盖规则」。
样式表由 `KnitGlyph` 自己保证注入。**四个位置必须都用 `KnitGlyph`**：tab 芯片标题、guide 入口胶囊、
better-sidebar tab、会话头部入口按钮。`test/icon.test.mjs` 断言源码里不再出现 🧶。

**界面文案里也不要放表情装饰。**（用户删过两次。）
2026-09-30 起「排序依据那一行」**整行都没了**：`topic.relevance` / `topic.relevancePlain` /
`topic.needsConversation` / `topic.time` 四个键已从两种语言删掉。
`test/i18n.test.mjs` 扫描 `ZH` / `EN` 词典，出现表情符号区（U+1F300–U+1FAFF）就红（只放行 `→` 这类排版符号）；
组件里的 `🆕`（两分钟内改动过的新文档）是**有意保留**的标记，不在词典里，不受该守卫影响。
> 趋势：**凡是「装饰性」的表情，用户都要删。** 加之前先问「它承担信息吗」。

---

### 6.3 颜色：不许硬编码，不许 color-mix，变量必须先定义

品牌强调色只有一个来源，定义在 `.knit-root` 上：
`--knit-accent` → `--dsw-alias-brand-primary-new-colorprimary-new-color`（浅 `#4176e6` / 暗 `#5686fe`）。
**不要硬编码 `rgba(…)`**（客户端测试在源码上守卫 `rgba(124,108,240` / `rgba(79,140,255`）；半透明就用
DSH 已带 alpha 的令牌。**变量必须先定义再用**：`var(--knit-x)` 没写 fallback 而 `--knit-x` 未定义，
这条声明**整体作废、界面静默少一块样式**（漏改引用把 `.knit-doc.active` 填充弄丢过一次）。

| 状态 | 用什么 |
|---|---|
| **选中态**：排序切换、列表行 | `--knit-active-bg`（降档自 DSH 的 `-bg-active`），**灰底** |
| **选中态**：类型切换 | 下划线式页签：深色文字 + `border-bottom:2px solid` 深色下划线，**不用灰底** |
| **悬停**：列表行、各按钮 | `--knit-hover-bg`（降档自 `-bg-hover`） |
| **键盘焦点**：媒体卡片 | 中性描边 `--dsw-alias-border-l4` + 中性环 |
| **正在预览**：文档行 | **只有中性灰底 `--knit-active-bg`，没有描边**（2026-09-30 起） |
| **正在预览**：媒体卡片 | `--knit-accent` 描边（**没改，别顺手「统一」掉**） |
| 聚焦圈、拖拽条悬停、分区「查看全部」 | `--knit-accent` |
| **预览面板底色** | `--dsw-alias-bg-base`（浅 `#fff` / 深 `#151517`）—— 恒为纯阅读底色 |

**灰底一律从 DSH 官方交互令牌按固定比例推**（`--dsw-alias-interactive-bg-hover` 浅 `#2631480f`=5.88% /
暗 `#ffffff14`=7.84%；`-bg-active` 浅 `#2631481a`=10.20% / 暗 `#ffffff24`=14.12%）：`--knit-hover-bg` = ×0.36、
`--knit-active-bg`（行选中）= ×0.54、`--knit-chip-bg`（命中段胶囊）**= ×0.81，是三档里最高的一档**。
**暗色三档各再低约 10%**（`.028 / .076 / .114` vs 浅色 `.024 / .061 / .092`），2026-10-07 用户裁决
（「暗色高亮太白、看得犯晕」）。🔴 **不要自己拍一个 alpha**：那条 `.13`（纯白 13%）就是自造的，
用户一眼看出比官方 active 还亮。守卫钉住 `chip > active` 且 `chip <` 官方 active 的千分比。

**列表行「正在预览」无描边（2026-09-30 用户裁决）**：连 `.5px solid transparent` 的占位边框都去掉了，
几何用 `padding:10.5px 11.5px` 补回。依据：「**用灰阶建立层级，而不是用颜色建立层级**」。
⚠️ 浅色主题下 `bg-layer-1/2/3` **全是 `#fff`**，不要用它们做分层。

`test/client.test.mjs` 的源码级守卫还盯着四条：「**类型切换是下划线式页签**：选中态既不含
`--knit-accent`、也不再退回 `background:var(--knit-active-bg)`」；「**列表行选中不许有描边** ——
`.knit-doc.active` 里不含 `border`、填充是 `--knit-active-bg`」；「媒体网格用 CSS 变量收列数」；
「`var(--knit-*)` 无 fallback 者必须有定义」。

---

### 6.4 「右栏 / Context Pack 面板」—— 🔴 **已整体删除，不要再实现一遍**

v0.14 的双栏（左＝列表，右＝「当前任务上下文」说明栏）**当天就被用户否掉**。**Context Pack 是数据层的
结构**（主要 / 辅助 / 相关 + 每条为什么），**不是一张要单独显示出来的 UI 卡片** —— 凡是「把同一份上下文
再讲一遍」的界面（独立面板 / 证据卡 / 命中计数区）一律否掉：与左侧分组重复、视觉价值有限、容易做成
AI Dashboard（与「安静、开发者工具、高信息密度、可信」相反）。
⇒ **要提高宽面板利用率，改的是单列排版（§7.1），不是加一栏。**
仍成立的两条纪律：① **界面几何状态不落盘**（`readPref / writePref` 只给排序 / 类型 / 预览高度这类语义
偏好用；守卫 `!source.includes('dsh-knit:pack')` 仍在）；② `role="separator"` 会覆盖 `<button>` 的可聚焦
语义，可拖拽分隔条必须显式 `tabIndex: 0`。⚠️ `.knit-pack` 这个类名已不存在，旧注释指向它的说法都要改掉。

---

### 6.5 宿主半边改了必须重启 DSH

实测**不热加载**。判断当前跑的是不是新代码：

```sh
curl -s "http://127.0.0.1:3080/knit/api/raw?rel=nope.png"
# {"ok":false,"code":"knit/not-found"} = 新代码在跑
# 空 body 的 404                          = 旧代码还在跑
```

**客户端半边改完硬刷新浏览器即可**（`Cmd + Shift + R`），不用重启。

---

### 6.6 双宿主必须共用同一个面板

`KnitBody` 被两个宿主共用，只在「怎么开新标签页」上用适配器分叉：
官方右侧栏 → `tab.actions.openResource`（必须从 `useTabInfo()` 拿，**不是** props）；
better-sidebar → `ctx.betterSidebar.openTab`。两边都是**可选依赖**（`ctx.inject` 子 fiber），缺一个不影响另一个。
⚠️ descriptor 必须带 `hidden: true`：v0.24.1 起它把自己的 tab 镜像成官方类型并顺带挂一条 guide 条目，
不写就会在「开始」页出现两行同名入口。

---

### 6.7 零模型、零网络出口

相关性排序是纯本地字符串运算。**不要为了「更准」引入 embedding / LLM 调用** —— 「纯本地」
是这个产品对外的承诺，也是它相对竞品的差异点之一。

---

### 6.8 文案一律走 i18n，宿主只返回错误码

- 客户端：所有文案进 `ZH` / `EN` 词典，用 `t('key', params)` 取
- 宿主：失败时返回 `{ ok: false, code: 'knit/xxx' }`，**不返回文案**；客户端用 `HOST_ERROR_KEY` 查表翻译

理由：宿主与 UI 语言解耦，加语言只动客户端词典。`test/i18n.test.mjs` 守三件事：两边键集一致、
占位符一一对应、宿主每个用户可见码都有翻译。**加新文案的流程**：`ZH` 和 `EN` 同时加同名键 → `t()` 取 → 跑测试。

---

### 6.9 宿主接口的安全边界

`/knit/api/doc` 与 `/knit/api/raw` 是**按路径读文件**的接口，两条都必须守住：

- 路径解析后必须落在会话工作区内（越界一律拒绝）
- `/knit/api/raw` 额外叠一层**扩展名白名单**（图片 + 视频，上限见 `MAX_IMAGE_BYTES` / `MAX_VIDEO_BYTES`），
  视频走 HTTP Range（206）
- 只允许 GET、只允许回环地址
- **响应头分两类，别混着记**：回 **JSON** 的路由（`/api/recent`、`/api/doc`、`/api/links`）走 `sendJson` ——
  `nosniff` + `no-store`、**不带 CSP**（从不回文件字节）；回**文件字节**的 `/api/raw` 走 `sendMedia` ——
  `nosniff` + `default-src 'none'; sandbox`（图片/视频可能是 SVG，那层 CSP 用来废掉它的脚本与外链）

**新增任何读文件的路由，必须照抄这两条防护。** `/knit/api/links` 是按这个落地的：**它不接受路径**，
只接受工作区内的**相对路径 `rel`**，且拿去在**已扫出来的文档集合**里查表 ——
越界 / 绝对路径 / 不存在的 `rel` 一律 `404 knit/not-found`（有 e2e 用例守着）。

---

### 6.10 宿主半边**不要 import `@deepseek-ai/*`**

Knit 被 `link:` 挂进 profile，真实路径在 profile 的 `node_modules` **之外** —— 裸 Node 解析不到
（实测 `ERR_MODULE_NOT_FOUND`）。本机另外两个 `link:` 开发插件同样是**零依赖、从不 import DSH 的包**。
所以要用官方服务（`ctx.tools.register`、`ctx.settings` 之类）时：**通过 `ctx` 拿服务，而不是 import 包**；
`ctx.inject([...], cb)` 会给到服务实例，不需要它的类型或辅助函数。
**已有真实案例**：v0.7 的 `knit_docs` 需要 `defineTool`（来自 `@deepseek-ai/dsh-tools`），
于是**手写 `ToolDefinition`**（`src/host/tool.js`），schema 已与真实编译器产物逐字比对通过。
> 客户端半边另一套规则（§6.1）：那边的 `require` 由 `window.__ModuleLoader__` 接管，可以 require 官方 UI 包。

---

### 6.11 使用反馈层（v0.16）的硬约束

这一层只回答一件事：「交出去的那份 Context Pack，agent 后来真的读了吗」。它**不新增采集通道**。

1. **默认关，闸门在调用方**：只有面板头部的「使用情况」开关（轮询带 `usage=1`）与 `knit_docs` 的
   `audit: true` 两条开闸路径。⚠️ 闸门 = 订阅回调第一行（`index.js` 的 `onSessionEvent` 里 `isAudited`
   不过就 `return`）与工具里的 `auditRequested`；`feedback.js` 的 `ingestEvents`/`noteSnapshot`
   **自己不检查 `isAudited`**。
2. **读证据唯一来源 = `ctx.on('session/event', …, { global: true })`**（`apply(ctx)` 顶部注册、单事件入库）。
   🔴 `session.snapshotEvents()` 已被 DSH 标 deprecated（`dsh-session/README.md:62`「new production calls
   are prohibited」）—— **不许新增生产调用**；`rankByRelevance` 那处是检索输入（existing logic）。
   ✅ **唯一例外（v0.17 验收修订）**：闸门打开那一刻 `backfillFeedback()` 回填一次本会话已有事件
   （一会话一次、同一 tick、零 I/O），否则「未读」是没证据的断言。⚠️ **顺序是机制**：先
   `noteSnapshot(store, sid, pack)`（**不传 `at`**）**再** `ingestEvents()`，反了会把补记的读冻成包外
   （回填的读按**已知最早的那份包**归因）。
   ⚠️ 不传 `{ global: true }` 收不到 agent 作用域的会话事件。**一个代价**：fork 继承的父会话读**不算进来**（seed 不派发）。
3. **不落盘、不发请求**：状态全在内存（`createStore()`），进程重启即失。
4. **五个上限**：`MAX_SESSIONS 24`（LRU）、`MAX_READS_PER_SESSION 200`、`MAX_SNAPSHOTS_PER_SESSION 20`、
   `MAX_DELTAS_PER_SESSION 50`、`MAX_PENDING_CALLS 64`。⚠️ `churn.snapshots`/`deltas` 是 `changes`
   的**别名**（`changes = epochs - 1`），不是 `state.deltas.length`（累计计数器不会被上限截断）。
5. **归因在读那一刻结算并冻结**（v0.16 核心）：`recordRead()` → `snapshotAt(state.snapshots, read.seq)`
   （取 `seq <= read.seq` 的最后一帧）→ `attributeRead()` → 冻进 `firstRead`/`lastRead`。**禁止**出报告时
   再拿最新快照重判（v0.15 的 split-brain：`usageFrom()` 重算 ⇒ 历史被现在改口）；`reads[].tier`/`rank`/
   `outside` 也一律是**首读**的归因。没有快照 ⇒ `tier = null`、`inside = false` 且计入 `outside`。
6. **一份快照 = 一个 Epoch**（签名 = `task` + 三层 `tier:rank:rel`；同签名只推 `seq`/`at`，不新建）；
   `usage.epochs[]` 与快照栈同生共死，**只给内部 / 离线回放**，不上工具输出。
7. **两个事实字段**：`continuedReadAfterExit`（读在包外、更早某份快照里有它）、`reEntry`（读在包内、
   更早有过、中间断过）。**只许记事实**，不许写成「Agent 不认可新上下文」。
8. **面板/接口里 `usage` 先算、快照后记** —— 顺序反了会把「本次读」记到「本次刚交的包」上（回填路径相反，见第 2 条）。
9. **审计坏了不能带坏主路径**：`feedback.js` 每个入口、订阅回调、宿主侧每个调用点、客户端每次渲染都
   必须降级成「空」，不许抛错（有测试钉住畸形事件 / 未记账会话时接口照常 200）。
10. **界面上只许出现计数**：分数 / 百分比 / 置信度 / 评分条一律不许（有守卫；`getAuditSummary` 只吐
    一条 `Usage since the last pack: …`；v0.16 只多一句「当前上下文 · Epoch N」）。
11. **「包外」要拆成两笔**（只在离线量尺里）：`missed`（索引里有、没进包）与 `outOfScope`（如 `.js`）——
    不拆开时 `outside` 恒高，读起来像「Context Pack 没用」（`tools/context-feedback-eval.mjs` 的 `scopeFor`）。

⚠️ **写工具的块注释时别写 glob**：`~/.dsh/sessions/**/…` 或 `sessions/*/*/` 里的 `*/` 会**提前闭合块注释**，
报 `SyntaxError: Unexpected identifier 'scan'`。写成 `<工作区>/<会话>/`。

---

### 6.12 新增测试文件必须自己挂进 `scripts.test`

`knit/package.json` 的 `scripts.test` 是**逐文件枚举**的。新增测试文件后**必须把它加到那一行**，
否则 `npm test` **静默跳过**它，而 §1 的「全绿」数字也就不再代表全部。

---

### 6.13 客户端几何与 effect 依赖的两条硬规则（2026-10-04 交互审）

**① FLIP / 动效要「谁换了位置」时，只能用布局坐标**（`rowLayoutPoint()` 先取 `offsetTop` / `offsetLeft`）。
`getBoundingClientRect()` 是**视口坐标**：容器滚动、容器自己变高变矮（预览面板一开一合、「使用情况」长高一行）、
行上的 `.knit-doc:hover{transform:translateX(-2px)}`（2px 是死区 `MOTION_MOVE_EPS=0.5` 的**四倍**）
都会被算成位移 ⇒ 一屏行乱飘。拿不到 `offset*` 时才退回视口矩形并减掉容器矩形、补 `scrollLeft/scrollTop`。
⚠️ 前提是**所有行的 `offsetParent` 相同**（`.knit-tier` 不带 `position`）—— 改布局时别打破它。

**② effect 的依赖里不许出现轮询刷出来的数组**（`state.docs` 就是每 5 秒一个新数组）。
那会把「刷新到了数据」当成「用户动了光标」：光标默认在第一行，用户往下滚过之后每 5 秒被拽回去一次。
要响应数据就用 ref 或在回调里读。

---

### 6.14 Usage Lens 的四条硬约束（v0.18，2026-10-05）

**① 只有 `.knit-list` 一个滚动容器**（`.knit-usage` / `.knit-lens*` 里不许 `overflow-y:auto`）；面板矮于
`COMPACT_PANEL_PX = 420` 时降级成摘要 + Coverage + 最近读取。
**② 能派生就不要存储**：Coverage / 包外排序 / Delta 分组是纯函数（`coverageOf` / `groupOutsideDocs` /
`groupDelta`），数据只来自 `usage.lifecycle / recentRead / outsideDocs / latestDelta` 与 `context` 三层 ——
不许为 UI 新增 store / 采集 / 持久化 / 事件系统 / 宿主字段。
**③ 状态与文字必须同时在**：四态（`○ ● △ ↻`）不许**只**用颜色或一个点表达，不许红绿 / 徽章底色（生命周期不是风险等级）；
点它只做「解释 + 定位」，不许改 Context Pack。**收起 Lens ≠ 关掉统计**（关掉才一个统计 DOM 都不产生）。
**④ 不许因 5 秒轮询播放动画**（Lens 不整体闪、`○→●` 不重播、包外不整体重进）；`prefers-reduced-motion` 下无动画但终态照常出现。

---

---

## 7. 产品现状与不能动的纪律

---

### 7.1 列表行结构（2026-09-29 用户拍板，最后一版）

- **永远单列**。用户原话：「文档列表最多一个就行，现在一行两个有点太多了」。
  🔴 **多列那套是「整体删除」不是「关掉」**：`docLayoutFor`、`DOC_TRACK_PX`、`DOC_GRID_MAX_COLS`、
  `DOC_SUMMARY_MIN_PX`、`.knit-multicol*`、`.no-sum` **全都不存在**了，测试反过来守「它真的没了」
  （`knit/test/client.test.mjs`：`__test` 里四个标识符必须是 `undefined` + CSS 守卫）。
  ⚠️ **不要加回多列**；要提升宽面板利用率，该做的是让**单列更舒展**。
- **序号在最左边独立成一列**：两列 grid（`grid-template-columns:22px minmax(0,1fr)`；`.knit-doc` 是
  `column-gap:8px`、`align-items:start`），第一列＝序号，第二列＝`.knit-body` 装的其余全部数据。
  **四件不能动的事**：① `.knit-body` 位置写死 `grid-column:2`（靠 grid 自动排布时，没有序号的行
  正文会**掉进第一列**，与有条目的行左边缘对不齐，有测试盯着）；② `.knit-body` 的 `min-width:0` 不能省
  （grid 单元格默认按 min-content 撑，长标题会把行撑宽、省略号失效）；③ 那一列是**固定 22px 轨道**；
  ④ **没号的行不再整格空着**（2026-10-01）—— 这一屏里有号时渲染一个中性标记
  `.knit-gapmark`（`·`，`aria-hidden`），整屏没号（时间序 / 平铺列表）时一个都不渲染
  （刺眼的是**混着**，不是「没有」）。
- **编号跨三档连续 `01…0N`，不按档重排**（2026-10-01 用户复述确认）：三层是**同一个包的一条阅读顺序**
  「先看 / 辅助 / 背景」，不是三个各自排名的清单。序号在**当前可见列表**（已过滤 + 已截断的
  `visibleDocs`）上重算 —— 过滤时它就是「当前列表第 N 篇」；「其他相关文档」那一档不编号。
  ⚠️ `.knit-num` 与 `.knit-gapmark` **共用同一条 CSS 选择器**，所以下面这条纪律一次覆盖两者。
- **序号与标题第一行垂直居中**：靠 `line-height:19.6px`（＝ `.knit-title` 的 `14px × 1.4`）与标题行盒等高。
  **改标题字号或行高必须同步改它**（`test/client.test.mjs` 同时钉住这两个数字）。
- **行一＝Primary 点（`.knit-dot`）+ 标题（`.knit-title`）+ 相对时间（`.knit-time`，靠右）同一行**，
  摘要（`.knit-sum`）再往下。⚠️ 时间靠右**不是**靠 `margin`：靠标题 `flex:1 1 auto` + `min-width:0`
  把它挤到行尾，两条都不能删。标题**必须在** `.knit-row1` 里、且在时间前面（有测试）。
- **列表行里没有路径**（2026-09-29 用户要求：点开详情已经有了，重复）。删掉的是 `.knit-meta`
  **节点本身**（**不是 `display:none`**）。⚠️ 测试别写 `!/.knit-meta[^{]*\{[^}]*display:none/` ——
  类名不存在时它会**空转通过**；要写 `!code.includes('knit-meta')`（在剥掉注释的源码上判断）。
  ⚠️ 定位不走可见路径：`data-knit-rel` 仍在每一行上（键盘 / 预览映射靠它）。
- **行的静止态没有底色**（2026-09-29 暗色主题要求）：`.knit-doc` 静止态 `background:transparent`。
  ⚠️ 以前写 `bg-layer-1` —— 浅色下它和 `bg-base` 都是 `#fff`（看不出问题），**暗色下比底色亮一档**，
  每行都像浮起来的小卡片。hover 与 `.active` **各有自己的令牌，不许跟着改成透明**。
- **摘要任何情况下都不许 `display:none`**（有 CSS 守卫），字段一个不少（中间那版「多列只剩标题 + 时间」被用户否过）。
- ⚠️ **容器类名不能含 `knit-doc`**：`byClass` 是**子串**匹配，第一版叫 `knit-doc-grid`，
  容器被当成一个文档行，34 条测试当场红。

---

### 7.2 三档类型 / 媒体网格 / 键盘

- **「文档 / 代码 / 媒体 / 全部」四档切换**（偏好记 localStorage，默认文档；v0.19 加「代码」档）。类型选中态是**下划线式页签**
  （v0.14 起）—— **与列表行选中态（灰底、无描边）故意不一样**，别去「统一」。
  文档档选中**不要加品牌色/绿色描边**（用户原话：「选中的时候不用加绿色、蓝色的描边，
  就跟下面列表一样，选中填充背景灰就可以」）。
- **媒体网格**：方形缩略图，**格子基准固定 104px、与条目数无关**；列数由 CSS
  `repeat(auto-fill,minmax(104px,1fr))` 连续数出来（面板拖宽约 120px 多一列）。
  实测：320px→2 列 / 632px→5 列 / 900px→7 列 / 1200px→10 列。
  **纵向有多少行铺多少行**：网格**不设 maxHeight、也不自己滚**，滚动统一交给 `.knit-list`。
  ⚠️ **`mediaLayoutFor` 只接受 `width` 一个参数，且不返回 `maxHeight`** —— 这是走过三遍的坑：
  格宽跟着**条目数**走就把列数锁死；封顶高度按「两行」算死必然截断第三行。
  ⚠️ 轨道下限 104px 与 `1fr` **都不能省**；JS 的列数算术必须与 CSS 的 auto-fill **含 gap 同源**
  （`floor((可用宽 + gap) / (104 + gap))`）；宽度要从**网格自身可用宽度**算（扣列表内边距 16 **和**
  网格内边距 24）；`height:var(--knit-media-cell)` 与 `aspect-ratio:1/1` 同时写（变量缺失时不塌成 0 高）。
  视频取首帧当海报 + 播放三角 + 时长角标。
- **键盘**：`↑↓` 移动即预览 / `Enter` 切换 / `Esc` 收起；媒体档 `←→` 按屏幕位置跨行、`Home`/`End` 到首尾。
  ⚠️ **文档档（含「全部」档的文档区）永远单列，`←→` 没有空间含义** —— 一律传 `1`、不拦
  （以前误传 `docLayout.columns`）。导航算术在纯函数 `nextIndexFor` 里（真实列数要 `ResizeObserver` 量）。
- **「全部」档**：上下两个分区 —— 文档最多 4 条（超出给「查看全部 →」）；媒体**不截断**，只给计数。

---

### 7.3 排序 / Context Pack / agent 工具 / 使用反馈

- **排序按对话相关性**（v0.6 起 **BM25 + IDF + 长度归一化**，纯本地）/ 按修改时间，一键切换。
  算法与实测见 `knit/README.md`「相关」是怎么算出来的；引擎 `src/host/relevance.js`。
  **不做相关度可视化**：先后做过「百分比数字」和「紫色长条」，**都被实测否掉**
  （排序本身就是答案，名次即相关度；数字会被误读成绝对概率，长条要求用户先理解「这是跟别人比的」）。
  `test/client.test.mjs` 有回归用例：**分数高低不得改变任何一行的渲染**。
- **v0.14 起 `knit_docs` 返回三层 Context Pack 而不是平铺列表**（`src/host/context.js`；人类面板与
  agent 共用同一份判断）：相关模式下按 主要 / 辅助 / 相关 +「其他相关文档」分组，提示语分别是
  先看 / 辅助 / 背景。每条的「为什么」只写**确定性的事实**，不写分数/百分比/星级。
- **agent 工具 `knit_docs`（v0.7）**：只读、不返回分数、不返回正文；结果头部同时给**总数**
  （`Top 5 of 23 …`）与**排名口径**（`ranked by IDF-weighted relevance … not a keyword count or
  filename match`）。实现在 `src/host/tool.js`，**手写 `ToolDefinition`，不 import `@deepseek-ai/dsh-tools`**（§6.10）。
- **使用反馈（v0.16）**：默认关的「使用情况」开关 + `knit_docs` 的 `audit: true`，把「先看的那篇读没读 /
  辅助层 read÷total / 读了几次 / 包外几篇 / 上下文换过几次」摊成**一行事实**，行首多一个累计的
  「当前上下文 · Epoch N」。归因**读时冻结**，之后换多少份上下文都不会改口。见 §6.11。

---

### 7.4 阅读与预览

- 单击列表行下方**就地预览**、再点收起；**双击仍能开新标签页**（`onOpenTab` 没删）。
- **预览面板底色恒为纯阅读底色**（`bg-base`：浅 `#fff` / 深 `#151517`）—— 一展开就是白的，
  不随滚动变、也不随换篇变。v0.10 那套「先灰、滚过 >4px 才变白」的机制
  **已整体删除**（`READING_SCROLL_PX` / `readingDocs` / `.knit-preview.reading` 都不存在了），**不要再加回来**。⚠️ 分层不靠底色，靠**顶部圆角 + 向上柔影 + 更强的上边界**这三件仍在的东西；
  也别写死 `#fff`（暗色下会白得刺眼）。
- ⚠️ **预览面板的高度在打开期间是固定的**（`style.height` = 拖出来的比例），**不许改回 `maxHeight`**
  （2026-10-04 交互审）：`maxHeight` 让高度由**内容**决定 ——「加载中」→正文、预览里换一篇都会让
  面板一伸一缩，列表跟着抖（用户原话「我一点它就跳，我一点它就很跳，闪的很快」）。固定高度之后
  **长文在正文区里滚、短文档下方留白** —— 留白是买「点一下不跳」的价。
  `test/tier1.test.mjs` 钉住 `style.height === '46%'` 且 `maxHeight === undefined`。
- **预览头**：38px 高、`border-l3`、**放路径**（**目录不上屏，收敛成一个 `…/` 占位** + 文件名 primary，
  **不放标题** —— 同一个词会出现三遍），右上角 **`[网页预览] [本地打开] [全屏] [✕]`**（网页预览仅 `.html`），四者在 38px 里上下居中。
  拖拽把手是**绝对定位的窄条**（不占布局高度）。路径**可点**：在系统文件管理器中打开这篇文档并**选中它**（`action:'reveal'`）。
  ⚠️ **完整相对路径在它的 `title` 里**（2026-10-01 用户要求「前面那一串都用三个点点点表示」，把宽度让给文件名）；
  ⚠️ **不要试图做「选择用哪个本机应用打开」**：官方 `open-in-app` 只认**目录**，应用表是编译期开发工具清单
  （没有 Typora / Obsidian）；要做就得自己写应用目录 + 一条**启动本机进程**的宿主路由 —— 新的风险等级。
- **代码预览走 DSH 官方语法高亮器**（2026-10-07 用户要求，**推翻 v0.19「不做高亮」**）：
  `require('@deepseek-ai/dsh-client-ui-primitives')` 的 `useCodeHighlighter(language)` —— 客户端本来就在
  require 这个包（§6.1），**零新依赖、零新 specifier**；语言**只用宿主分类层给的 `preview.language`**
  （客户端不许自己看扩展名）。颜色**只吃官方的 `var(--shiki-*)`**（浅/暗两套由官方主题给，不许自造配色 ——
  `--shiki-foreground` 就是 `.knit-code-src` 原本的 `--dsw-alias-label-primary`）。token span **平铺**进同一个
  `<pre>`（**不包逐行元素**，否则 `pre.scrollHeight / 行数` 的行高几何会变，命中横带会错位）。
  ⚠️ **只给命中段那一带上色**（2026-10-07 用户第二次裁决）：窗口 = 命中段前后各 `CODE_HL_PAD = 60` 行，
  硬上限 `CODE_HL_MAX_LINES = 800`（命中段本身可能几百行）；**没有命中段就一个 token 都不上色**，其余行
  保持默认正文色（浅色黑 / 暗色白，跟随主题令牌）。窗口之上 / 之下的行各是**一个**纯文本节点。
  代价明说：窗口从半截注释 / 字符串中间开始时缺上下文，那一段可能**错色**（命中横带仍精确标出行）。
  **必须限制窗口**：官方高亮器同步跑，实测 170–560 ms / 千行，整篇 4000 行首开 2.5–5.5 s（4× 节流）。
  宿主没导出这个 hook（旧版 DSH）或返回行数对不上 ⇒ **静默回落纯文本**。
  被否决的四条：自造配色、`setTimeout(0)` 让出首帧（实测更慢）、整篇 / 前 N 行前缀着色（用户嫌慢）、
  按锚点放宽（着色行数变成命中段位置的函数）。
- 相对路径图片真渲染、可拖高度、全屏、原生 Markdown。
- 滚动条**不自己画**：继承 DSH 主题的全局滚动条（8px + `--dsh-scrollbar-thumb`），正文区把变量提到 l2
  （与官方文档预览同档）。
- **无障碍（P0）**：列表是标准 `listbox`/`option` 语义，`aria-activedescendant` 指向光标项，
  预览项 `aria-selected="true"`；网格容器 `role="presentation"`（option 必须是 listbox 直接子级）。
  ⚠️ 文档行**故意不给键盘焦点描边**（焦点靠「移动即预览」表达）；曾为多列网格补过的
  `.knit-multicol .knit-doc.cursor` 中性环**随多列一起删了**。

---

### 7.5 入口 / 语言 / 图标 / 双宿主

- **入口**：会话头部右侧（`conversation.session.header.utilities`）一个 Knit 图标按钮 ——
  **悬停弹只读浮层偷看，点击才进右边栏**；浮层是自己画的，不碰框架（不会推开布局）。
  浮层上限 `PEEK_LIMIT = 5`，请求 `/knit/api/recent?sessionId=…&limit=5&sort=<相关/最新>`，
  `sort` 跟面板偏好（默认「相关」= 当前 Context Pack 前 5 条）。
  ⚠️ 会话 id 走**座位 props 的 `sessionId`**，不要读 `sessions.list` 快照的 `current`（§8）。
  ⚠️ **浮层只有「头 + 列表」两层**：列表下面那条横线与「点击打开面板」页脚 2026-10-01 已删除
  （用户：「我觉得都可以删掉，有点多余了」），`peek.openPanel` 两个文案键也一并删了 —— 别再画回来。
- 点头部那行工作区路径 → 用系统文件管理器打开项目文件夹（`remote.session.openWorkspacePath`）。
- 语言：中英双语，跟随 DSH 语言实时切换（`ctx.locale`，命名空间 `knit`）。
- 图标：mono SVG（跟随官方主文本色令牌，**不写死纯黑 / 纯白**）—— **四个位置统一**（见 §6.2）。
- 双宿主：DSH 自带右侧栏 + `dsh-better-sidebar`（可选）。

---

### 7.6 明确没做的

接管 `.md` 资源路由（用户明确否决，要保留官方产物卡）；产物卡「更多」菜单加项（官方没留座位，见 §8）；
编辑 / 大纲 TOC / 多工作区（第三梯队，见规划文档）。

---

---

## 8. 踩过的坑（结论速查；完整取证见 `99_暂存文档/AGENTS-坑的取证-2026-10-07.md`）

| 坑 | 结论（照做即可） |
|---|---|
| `React.memo` 是对象不是函数 | 只能判空，不能 `typeof === 'function'`；**假件照契约写**（字段先去 `node_modules/@deepseek-ai/*/lib/types/**/*.d.ts` 核） |
| 测试脚手架 | 用 `byExactClass`（`byClass` 是子串匹配）；先 `render` 登记 effect 再 `flush`；harness 从不给 `ref` ⇒ 只能守**代码形状** |
| 官方座位 | 座位是 **70 个**：用 `cordis_inspect` 查，**别翻 `.d.ts` 去数**；`conversation.chat.turnTail` 是 `list` ⇒ 新 `id` 是纯追加 |
| 即时信号 | 用户点一下就期待有反应的操作，**不许经过任何轮询/批处理**（改订阅制） |
| `byClass` 子串匹配 | 新 class 名不要是已有 class 名的前缀（`knit-entry-wrap` 踩过） |
| 媒体网格 | 列数**只由宽度决定**；纵向**不许封顶**（算两行装三行 = 第三行只显示一点点） |
| 测试不许依赖目录布局 | 样本一律向 `test/fixture.mjs` 要（`os.tmpdir()` + `utimes` 定死 mtime），断言里不出现 `knit/` 前缀 |
| 改 DSH 的观感 | 先看官方怎么写的：**删掉自己的规则**（滚动条）；分层**别用 `bg-layer-*`**；能派生的状态别用额外 `state` + `effect` |
| 验收失败先怀疑测例 | v0.11 四轮都不是功能坏了：触发条件与收益条件错开 ⇒ **别把机制通过说成价值被证实** |
| `curl` 验 `/knit/api/*` | `sessionId` 必须是**还开着**的会话；先看 `returns.root` 对不对，不对后面数字都别信 |
| 守卫必须证伪一次 | 写完守卫**把 bug 放回去试一次**；没跑到那条分支的守卫是一盏空转的绿灯 |
| 「列表自己跳」 | 几何用**布局坐标**（`offsetTop`）；effect 依赖里**不许出现轮询刷出来的数组** |

---

### 9.3 测试文件分工

| 文件 | 覆盖 |
|---|---|
| `test/host.test.mjs` | 解析、越界防护、相关性引擎、会话事件提取、**符号链接工作区的 canonical `hostRoot` / `path`**（DSH 只认 realpath） |
| `test/host-http.test.mjs` | 真回环端口的 HTTP 端到端：`/raw` 200、**Range 206**、安全响应头、白名单与越界、`/links` 入/出度与不泄漏内部字段 |
| `test/links.test.mjs` | **链接解析层**：三种引用写法、反引号遮蔽、锚点剥离、`a.md.bak` 不被误咬、**无 `[[wikilink]]`**、歧义同名 ⇒ `null`、入/出度互逆、缓存不重读、`linksOf` 的 404 / 排序 / 上限 |
| `test/client.test.mjs` | 双宿主注册、排序、渲染、降级、适配层、颜色 / 类名 / 样式守卫、v0.19 预览 UI 守卫、**v0.20 命中段 / 语法高亮守卫**（细则见 §7.4） |
| `test/tier1.test.mjs` | 相对路径图片、高度与全屏、键盘导航、过滤 |
| `test/entry.test.mjs` | 入口按钮、宿主解析、list 语义 |
| `test/i18n.test.mjs` | 中英双语、占位符、错误码翻译、词典键对齐、无表情符号 |
| `test/icon.test.mjs` | 图标渲染、尺寸、**配色跟随官方主文本色令牌（不写死 `#000` / `#fff`）**、与 assets 源文件一致、四处统一 |
| `test/path.test.mjs` | 点工作区路径开文件夹、**点预览头路径在文件管理器中显示并选中**、**打开 / 定位一律用 canonical 路径**（界面仍显示会话原本那条） |
| `test/peek.test.mjs` | 悬停浮层：延迟显示/收起、点击开面板、**不等列表即时响应**、会话 id 取座位 props |
| `test/eval.test.mjs` + `test/eval/` | **排序质量回归**：21 个用例，断言新引擎显著优于冻结的 v0.5.2 基线。⚠️ `eval/legacy.mjs` 是冻结基线，**不要删** |
| `test/label.test.mjs` | **话题标签可读性**：真词必须出现 + 旧碎片必须不出现；标签词必须是输入的子串 |
| `test/tool.test.mjs` | **agent 工具 `knit_docs`**：注册/注销、两条 `inject` 互不依赖、schema 形状、用对话 vs 用 query 排序、无会话报错、`limit` 边界、不泄漏内部字段、渲染格式、**v0.20 片段行与 R2 预算 / 镜像常量守卫**、**需求 §15 跨面集成守卫（同一条任务下工具侧与面板载荷逐条一致）** |
| `test/harness.mjs` | 最小 React / window / fetch 替身（**改它要格外小心，见 §8**） |
| `test/fixture.mjs` | **样本工作区工厂**（`os.tmpdir()` + `utimes` 定死 mtime）。**新增依赖目录布局的测试时，样本一律从这里要**（§8） |
| `test/document-lifecycle.test.mjs` | **v0.17 文档生命周期**：`backfillFeedback()` 的回填顺序（见 §6.11 第 2 条）、首读归因冻结、`churn.epochs` 与快照栈同生共死 |
| `test/classification.test.mjs` | **v0.19 文件分类层**：17 个支持后缀 / 13 个不支持 / `.map`·min·generated·lock → generated / 后缀知识只许活在分类层 |
| `test/code-context.test.mjs` | **v0.19 Code Context 链路**：代码字段权重、理由码、混合包、引用图、read evidence、四态生命周期、Epoch、噪声路径 |
| `test/deep-context.test.mjs` + `test/deep-eval.test.mjs` + `test/deep-scale.test.mjs` | **v0.20 片段层**：需求 §21 的 12 个用例 + 媒体反例、四指标（DeepHitRate / PassageHit@1 / PassageRecall / LongDocNoiseRate）、R1 规模门槛（1000 文件 ≤ 1.5 s）、R2 载荷预算（面板 ≤16 KB / 工具 ≤1.4×）。**语料工厂在 `test/deep-corpus.mjs`（必须随包发布；`tools/deep-benchmark.mjs` 只是 CLI 外壳）** |
| `test/relations.test.mjs` + `test/control.test.mjs` | **v0.21 关系层**：imports 逐行正则与行号、相对路径解析与扩展名补全、tests 命名约定（唯一才认、无行号）、`references`/`documents` 与反向 `in` 边、截断顺序、四条端到端；**控制层**：固定/排除互斥与幂等、固定移出三层且来源=manual、排除先于检索、持久化只写差量、无 storage 降级 |
| `test/index-store.test.mjs` + `test/index-incremental.test.mjs` | **v0.22 增量索引**：持久层 16 项（键含 root 指纹、`per-record` 键形状、`mtime+size` 筛子 + `headHash` 复核、版本 / 指纹不符或无存储 ⇒ 空 Map + `reason` 不抛、遗留键**有界清理**（≤32））与端到端 15 项（重启后复用、改一个只重读 1 篇、增删改名不留过期项、同 `mtime+size` 的改写被抽验抓住、相关序不装载索引） |

---

---

## 10. 目录结构（`knit/` 内部；工作区那一层见常驻层 `../AGENTS.md` §10）

```
knit/                            ← 插件本体（**路径不能动**，见文末）
├── package.json                 dsh.bundle.patch + dsh.client + scripts.test（**逐文件枚举**）
├── cordis.patch.yml             挂进 plugin tree 的 insert 行
├── assets/                      图标源文件（path 已内联进 client.js）
├── src/host/                    index.js + relevance.js + links.js + passage.js（v0.20 片段层）+ relations.js + control.js
│                                + index-store.js（v0.22 索引持久层）+ context.js + tool.js + feedback.js + classification.js（v0.19 分类层）
├── src/client/client.js         浏览器半边（无构建）
├── tools/                       **不进 npm 包**的开发工具：real-machine-check / scale-benchmark /
│                                preview-ranking（§8）/ market-recheck / context-feedback-eval（§6.11）/
│                                deep-benchmark / **agents-budget（指令文件预算闸门）** /
│                                **clean-room-test（打包后解包自测闸门）** 等
├── SECURITY.md                  ← **安全对照表**（每条 ✅ 指向一个真实检查）
└── test/                        728 项，分工见 §9.3
```

> ⚠️ **`knit/` 的路径不能改。** 它被 `link:` 到 DSH profile 的**绝对路径**：
> `"dsh-knit": "link:/Users/zhongwentuo/DeepSeek Harness Native/08_Knit/knit"`。
> 改名或移动会让安装失效，必须重新 `dsh plugin add`。其他目录随便整理。

---
