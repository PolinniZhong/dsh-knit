# Git-aware Context Retrieval（Git 变更关联检索）· 最小 SDD

> **状态**：v0.25 实现中（本文件随实现一起写）。**未发版** —— 版本号仍是 `0.23.1`。
> **契约结论（第二轮 + 第三轮）**：
> ① `knit_docs` 的入参与输出 schema **一个字节都没动**（`git diff src/host/tool.js test/tool.test.mjs` 为空）；
> ② `/knit/api/recent` 的响应形状也**一个字节都没动** —— 变更关联在**第三条独立接口**
>    `GET /knit/api/changes` 上，且是**专用数据结构**。见 §三.5。
> ③ 收尾（第四轮）：`context.js` 也回到 v0.24 逐字一致 —— 那个「宿主声明却不再产出」的
>    理由码已整体删除；接口去掉了 `kind` 与绝对路径；**失败状态可辨**（见 §三.6）。
> 实现证据：`src/host/git.js`、`src/host/changes.js`、`src/host/index.js`（`withChanges`）、
> `src/host/tool.js`、`src/client/client.js`；测试 `test/git-changes.test.mjs` + `test/client.test.mjs`。

---

## 一、设计评审（先回答那五个问题）

### 1. 现在 Knit 怎么发现文件之间的关联

**一层，两个模块，四类边**（全部零 I/O，只吃读盘时已经算好的 `head` / `refs`）：

| 类型 | 边 | 怎么来的 | 有没有行号 |
|---|---|---|---|
| `references` | md → md | `links.js` 的 `extractRefsWithLines()` + `resolveRef()`（路径提及） | 有 |
| `documents` | md → 代码 | 同一条抽取，目标**显式放开**到代码（`anyExt: true`） | 有 |
| `imports` | 代码 → 代码 | `relations.js` 的 `IMPORT_RE` 逐行正则 + `resolveSpec()`（相对路径 + 扩展名补全） | 有 |
| `tests` | 测试 ↔ 被测 | `testsOf()` 的**文件名约定**，歧义（0 个或多个命中）**一律不算** | **没有**（约定不是某一行的文字） |

`buildRelationFacts(candidates)` 把候选集算成 `{ signature, incident }`：`incident` 是
`Map<rel, Array<{type, dir, other, line}>>`，**一条边同时登记到两端**（`dir:'out'` = 本项指向对方，
`dir:'in'` = 对方指向本项），`line` 永远属于**叙述方**那一侧的文件。按工作区签名缓存（`root` + 各条
`rel\0mtimeMs`）。这就是「从任意一篇出发能找到谁」的全部基础设施。

### 2. 现有关系模型够不够用？哪些是真证据、哪些只是启发式

**够用，而且不需要新建任何图。** 从变更文件 `C` 出发，`incident.get(C)` 直接给出它所有的边，
对端就是「该一起看的东西」。四类边的证据强度是**不同的**，必须区别对待：

| | 是不是真证据 | 说明 |
|---|---|---|
| `imports` | ✅ 强证据 | 逐行正则 + 路径解析。误报只有一种：字符串里长得像 import 的文本（罕见，且**只影响一条边的多寡，不会伪造一个不存在的文件**）。 |
| `references` / `documents` | ✅ 强证据 | 路径提及要能在**候选集里解析出真实文件**才算数（解析不出来就没有边）。 |
| `tests` | ⚠️ **约定型证据** | 它是**可核验的路径事实**（`foo.ts` ↔ `foo.test.ts`），不是「这两个文件有关系」的推断。歧义一律不算 ⇒ 宁可漏，不编。所以它**不给行号**。 |
| （没做的）`calls` / 符号级依赖 | ❌ 不成立 | 没有 AST / LSP / Tree-sitter 就是猜。**明确不做**（与 v0.19 的禁区同一条）。 |

**一个真实的边界**：关系只在**候选集内部**成立。文件被删掉之后它不在候选集里 ⇒ `resolveRef` /
`resolveSpec` / `testsOf` 都不再认它 ⇒「删掉 `tests/foo.test.ts`，谁在用它」会一声不响地没有答案。
本设计**专门补了这一条**（见 §二.2 的「合成候选」）。

### 3. Git 状态读哪一层最合适？能不能复用现有基础设施

**接入 `buildContextFor()`（装配层），不接入 `scan()`。** 理由：

- 变更关联是「**这一份包里还该看什么**」，天然属于装配层；`scan()` 的职责是「扫描 + 排序」，
  它已经背了 6 个可选参数，不该再背一个 git。
- `buildContextFor()` 已经**同时握着三样必需的东西**：`root`、整批名次 `ranked`（全量、未切片）、
  以及它自己刚算出来的关系事实表 `facts.incident`。变更关联要用的正好就是这三样。
- 面板（`contextPayload()`）与 agent 工具（`knit_docs`）**共用同一个 `buildContextFor()`** ——
  这是项目里「面板与 agent 同一份判断」那条不变式。
  ⚠️ **但这个功能只在面板那一侧开闸**：`changes: true` 只有 HTTP 路由会传。
  工具不传 ⇒ 它的输出里连 `changes` 这个键都不存在 ⇒ **`knit_docs` 的契约不变**（§三.5）。

**复用的基础设施**：`relations.js`（四类边 + 缓存）、`context.js`（理由码注册表 + `sourceTypeOf`）、
既有的「平行区」先例（`pack.pinned` 由 `applyPinOverride` 从三层移出）、既有的行级证据弹层
（`.knit-rellist` 直接吃 `{type, dir, other, line}`）、既有的状态行与 `localStorage` 偏好族。
**新代码只有两件事**：跑一条 `git status`（`git.js`），把变更路径当种子去取边（`changes.js`）。

**新增的唯一外部依赖是 `node:child_process` 的 `spawn`**（Node 内置，不是包）。
⚠️ 这是 `src/` 里**第一个会起子进程的地方**（此前 `spawn` 只出现在不随包发布的 `tools/` 里）——
所以安全边界必须写在代码里并有守卫（见 §三）。

### 4. 怎么在不加仪表盘 / 页面 / 导航的前提下呈现

**它不挂在 Context Pack 上 —— 走独立接口**（第三轮修订）：

- `GET /knit/api/changes` → 专用结构 `{ git, links[], linksTotal, unresolved[], outOfScope[] }`
  （逐字段契约见 §三.5）。`/api/recent` 的响应**保持 v0.24 原样**，连一个键都不加。
- `items[]` 与三层条目**同形状**（`rel/title/summary/mtimeMs/kind/source/reason/provenance` + `relations`），
  于是客户端**不需要第二条渲染路径**：它就是列表里的一个新分区（key `changes`），
  **不参与 `01…0N` 编号**（与固定区、「其他相关文档」同一条规则）。
- `relations` 里装的就是那条把两篇连起来的边（起点 = 变更文件），**面板点开「为什么」看到的还是 v0.21
  那套行级证据**（类型 · 方向 · 谁 · 第几行 + 可点跳转），一个字的新 UI 都没有。
- 新增的可见像素只有**一个**：状态行里的一格 `变更 N`（默认显示 `变更`）。它的视觉**逐条复用**
  检索方式那一格（同 `--knit-chip-bg`、同 6px 圆角、同 `1px 6px`、同 11px/15px），
  开态只把字色提到主文本色（`aria-pressed="true"`）——**不换底色、不用品牌色**。
- 为什么不用别的入口：工具栏按钮（v0.23.1 刚收敛过，不加）、新页面/仪表盘（明确否决）、
  第二个搜索框（明确否决）、排序档位（那是排序不是来源）⇒ **状态行里一格二态开关**是改动最小的那个。

### 5. 关闭时怎么保证零回归

四层保证，逐层可断言：

1. **默认关**：`localStorage` 里没写过就是关（`readChangesPref()` 只在值为 `'1'` 时为真）。客户端
   不带 `changes=1` 就**不会**发这个参数。
2. **宿主默认关**：`buildContextFor()` 里 `if (options.changes !== true) return withPin` —— 提前返回，
   **不跑 git、不算关系、`pack` 的形状与 v0.24 逐字相同**（连 `changes` 这个键都不出现）。
3. **工具默认关**：`knit_docs` 的 `changes` 参数默认 `false`；不传时入参与返回值与 v0.24 逐字一致。
4. **开了也不动三层**：变更条目只进平行区；变更文件**自己不当结果**；已经在三层 / 固定区里的条目
   不会再出现在变更区（避免同一篇出现两次）。

测试钉住：`关掉时一次 git 都不问`、`没要 changes 时包里没有这个键`、`要了 changes 时三层逐字不变`。

---

## 二、数据流（第三轮定稿：两条互不干扰的接口）

```
【接口一】GET /knit/api/recent?…                 ← 形状与 v0.24 **逐字相同**
  └─ scan(root, limit, {session, sessionId, sort, kind, retrieval})
  │    └─ 扫完**记一份备忘**（`scanMemoState`：root + 时间 + 载荷，TTL 8 s，只写不读）
  └─ contextPayload(root, payload, sort, kind)
       └─ buildContextFor(root, {ranked, topic, task, total, withLinks, withRelations, control})
            ├─ buildRelationFacts(byRel)      ← 关系事实表（按候选集签名缓存）
            ├─ buildContext(…)                → 三层
            └─ applyPinOverride(…)            → 固定区
       ⇒ { mode, topic, task, primary, supporting, related, pinned?, totals }
       ⚠️ 这里**没有**任何 Git 变更关联的字段（有测试守着：`changes` / `links` / `git` 一个都不许出现）

【接口二】GET /knit/api/changes?sessionId=…&sort=relevance&limit=…        ← v0.25 新增（**没有 kind**）
  ├─ corpusForChanges(root, fallback)
  │    ├─ 备忘命中（同 root、8 s 内）⇒ **直接复用接口一那次扫描**（不再走目录树）
  │    └─ 否则自己 scan() 一次（独立调用这个接口时也能工作）
  ├─ changesPayload(root, {corpus})
  │    ├─ ① gitReader.read(root)          git.js：一条只读 git status（自身 8 s 缓存 + 并发去重）
  │    ├─ ② splitSeeds(changeSet, corpusRels) → seeds / gone / outside / seedRels
  │    ├─ ③ ghostCandidates(gone)         → head:'' 空壳（**只为当被引用的目标**，绝不当结果）
  │    ├─ ④ buildRelationFacts(corpus ± ghosts) → incident（无 gone 时命中缓存）
  │    ├─ ⑤ projectChangeRelated({seeds: seedRels, incident, itemRels, exclude: seeds})
  │    └─ ⑥ 投影成**专用结构**（起点 / 目标 / 类型 / 方向 / 行号）
  └─ ⇒ { ok, mode:'changes', git{…}, links[ {target,…, evidence[{origin,type,dir,line}]} ],
         linksTotal, unresolved[], outOfScope[] }        ← **不含任何绝对路径**

【客户端】
  开关关着 ⇒ **只发接口一**（宿主因此一个 git 进程都不 spawn）
  开关打开 ⇒ 接口一 + 接口二（同一个 `load()` 里背靠背，落在同一个 8 s 窗口）
  两边的载荷各进各的状态槽；接口二失败 ⇒ 只是这一区消失，**列表一个字都不动**
```

**成本**：一轮轮询（两个请求）= **一次工作区扫描 + 一次 `git status`**（都在 8 s 同窗内被复用）。

**「复用」是怎么被证明的**（这一段要说清因果，不能只断言两次结果相同）：
1. **前置**：`/api/recent` 先扫一次（备忘建立）→ `/api/changes` 再读一次 git（缓存建立）；
2. **缓存热**：**在扫描之后**删掉 `docs/guide.md`，再问一次 `/api/changes` ——
   它还按**旧快照**回答：`guide.md` 仍在语料里（所以仍是被关联目标），
   而这次删除**没有**变成第二条变更（说明 git 也没重读）
   —— 同时断言 `scanMemo().at` **没有变**（时间戳不变 = 这一次真的没有重扫）；
3. **缓存冷**：`resetScanMemo()` + `resetGitReaderCache()` 之后问同一份请求 ——
   删除**必须同时**出现在两处：它不再是关联目标，而且变成第二条 `deleted` 变更。

只有第 3 步也在，才能说明第 2 步的「看不见」是缓存造成的，而不是接口对文件增删无感
（这就是「守卫必须证伪一次」那条纪律在缓存上的落法）。

**关闭时两者都是 0。**

**为什么 `corpus` 必须不分档**：最值钱的两类边是跨档的 —— `documents`（md → 代码）与
`imports`／`tests`（代码 ↔ 代码）。面板的档位把语料切开（文档档只有 md），用档内语料会让这两类
证据直接消失。所以变更关联固定用「文档 + 代码」那一份（`payload.contextCorpus`）。

---

## 三、安全与数据边界（写进代码，不只是写在文档里）

| 约束 | 怎么落实的 | 守卫 |
|---|---|---|
| 只读，绝不写 | 只允许两个子命令：`status`、`rev-parse --show-prefix`（`GIT_STATUS_ARGS` / `GIT_PREFIX_ARGS`） | `test/git-changes.test.mjs`：两个 argv 逐个比对 `MUTATING_VERBS`（add/commit/checkout/reset/clean/stash/push/… 共 19 个），一个都不许出现 |
| 不走 shell | `spawn('git', [args…])`，参数是数组 | 代码即证据（没有 `shell: true`，没有字符串拼接） |
| **子进程环境是白名单筛过的** | `gitEnv()`：只继承 `PATH` / locale / `HOME` / `XDG_CONFIG_HOME` / 临时目录等运行时必需品；**任何 `GIT_*` 一律不从父进程继承**（前缀规则 ⇒ git 将来新增的变量自动覆盖），然后显式盖上 `GIT_OPTIONAL_LOCKS=0` / `GIT_PAGER=cat` / `GIT_TERMINAL_PROMPT=0` | 实测（git 2.50.1，2026-10-13）：`GIT_DIR`+`GIT_WORK_TREE` ⇒ 读**另一个仓库**（本工作区的 `M a.ts` 直接消失）；`GIT_INDEX_FILE` ⇒ 索引被换（已提交文件被报成 `D`+`??`，结果混进别的仓库的文件名）；`GIT_TRACE` ⇒ 往指定路径**真的写了日志**。`test/git-changes.test.mjs` 有三条：白名单单测、**真机注入**（三个变量塞进 `process.env` 后仍只读指定工作区、不写日志、不碰外部索引）、以及**证伪**（不净化时上述行为确实发生） |
| 不读 diff、不读正文 | 只解析 `--porcelain` 的**状态位 + 路径**；`--ignored` 不开 | `GIT_STATUS_ARGS` 的守卫 |
| 不改检索结果 | 变更条目进平行区；变更文件自己不当结果；已在三层的不重复 | 三层逐字不变的断言 |
| 不把 ignored / 生成物 / 二进制拖进来 | 只对**已经在候选集里**的路径查关系；忽略文件 git 根本不报；生成物 / 不支持的后缀不在候选集 ⇒ 只进「不在检索范围」的计数 | `outOfScopeCount` 的断言（300 条变更 ⇒ 0 条结果） |
| 有界 | 2.5 s 超时、1 MiB stdout、200 条解析、30 条下发、8 条结果 | 截断与上限的断言 |
| 失败降级 | 五种 reason；`read()` 与 `withChanges()` 都不抛 | 五种降级的断言 + 「降级不许把包弄空」 |
| 不上传任何东西 | 这是**纯本地**功能：一条 git、一次内存投影，没有任何网络出口 | 与 v0.23 的语义通道完全无关 |

---

### 三.5 接口契约：**两条既有契约一个字节都不动，新能力独立成第三条接口**

三轮下来的结论是一条纪律：**新能力不能靠扩既有契约来落地**。

| 契约 | 现状 | 怎么证明 |
|---|---|---|
| `knit_docs`（agent 工具）的入参与输出 schema | **未改** | `git diff src/host/tool.js test/tool.test.mjs` **为空**（两个文件逐字等于 v0.24）；`test/git-changes.test.mjs` 里另有一条「契约守卫」逐个字段钉死 |
| `/knit/api/recent` 的响应形状 | **未改** | 同一份测试断言：顶层与 `context` 里都没有 `changes` / `links` / `git`；传旧选项（`changes:true` + `changeCorpus`）也当噪音忽略，包逐字相同 |
| `/knit/api/changes`（新） | **专用结构**，独立演化 | 它不借 Context Pack 的词汇（`provenance` / `reason` / `relations` 一律不出现），所以扩它不需要动任何既有枚举 |

**新接口的字段契约**（这是它唯一的真源，`changesPayload()` 的块注释与它一致）：

```
{ ok: true, mode: 'changes',                    // **不带 root / hostRoot**：绝对路径不外发
  git: { available: boolean,            // false ⇒ 下面四个字段仍是齐全的（降级不是缺字段）
         reason: string|null,           // not-a-repo | git-missing | timeout | output-too-large
                                        // | failed-fatal | not-relevance-order
         filesTotal: number,            // 解析后的**全量**条数（截断时也如实）
         truncated: boolean,
         files: [ { rel, kinds: string[],   // staged | unstaged | untracked | deleted | added
                                            // | renamed | copied | unmerged
                    origRel?: string } ] },// 重命名 / 复制时的原路径
  links: [ { target: string,            // **关联目标**（工作区相对路径）
             kind: string,              // 目标自身的分类（客户端不看扩展名）
             source: string,            // doc | impl | test | …
             title, summary, mtimeMs,
             evidence: [ { origin: string,  // **变更起点**：牵出这条关联的那个被改过的文件
                           type: string,    // **关系类型**：references | imports | tests | documents
                           dir: 'in'|'out', // 方向，**相对目标**而言
                           line: number|null } ],  // **真实存在时**才给整数；`tests` 恒为 null
             evidenceTotal: number,     // 截断前的证据条数
             types: string[] } ],
  linksTotal: number,                   // 截断前的关联目标总数
  unresolved: string[],                 // 在语料里、却一条证据都没有的变更文件
  outOfScope: string[] }                // 不在本档语料里的变更文件（**与 unresolved 不重复计**）
```

**请求参数只有三个**：`sessionId`、`sort`、`limit`。
⚠️ **没有 `kind`**（第四轮删掉）：变更关联固定用「文档 + 代码」那份不分档语料，而
`collectDocs()` 的结果与档位无关（档位只切 `/api/recent` 的 `docs` 那一栏）——
所以 `kind` 在这里**没有任何语义**。留着它比没有它更糟：一个「看着像能过滤、实际什么都不做」
的参数会让人以为结果不完整。有一条测试正面钉住这件事：`?kind=media` 与不带参数**逐字同结果**。

三个刻意的设计决定：

1. **`line` 用 `null` 而不是省略**。专用结构里「这里没有行号」本身是信息：`tests` 那一类是
   **文件名约定**，不落在任何一行上；省略这个键会让「没有」和「忘了给」长得一样。
2. **`dir` 是必需的第五个字段**（用户点名的四件之外）。没有它，「`src/foo.ts` 与 `docs/guide.md`
   之间的 `documents` 边」读起来分不清谁提到谁。它与 v0.21 行级证据里的 `dir` **逐字同源**，
   所以客户端映射回既有弹层时不需要第二条渲染路径。
3. **`unresolved` 与 `outOfScope` 互斥**：`unresolved` 只说「查过了、没有」，语料之外的只进
   `outOfScope`（它仍然**当种子**用，只是不该被说成「查了没查到」）。两个计数重复算同一篇会让
   面板把那句话说重一倍。这条是写完当场被测试抓到的。

**第四轮清掉的那笔技术债**：`explainContext()` 里那个 `changeRelated` 理由码已经**整体删除**
（连同 `REASON_ORDER` 的表项与两个语言的 `why.changeRelated`），`context.js` 因此回到 v0.24
**逐字一致**。做法是用户建议的那条更清楚的归属：**变更行不再贴理由码** ——
「为什么在这一区」由**区标题 + 提示句**回答（「变更关联 / 由未提交的改动牵出来的」），
每一行的**具体依据**在证据弹层里（类型 + 起点 + 行号）。行级渲染本来就不给没有 `reason`
的条目出那一行，所以这一步零新增渲染路径。

**若将来要让 agent 也拿到这一区**（本轮**不做**）：

| 方案 | 要改什么 | 兼容性影响 | 评价 |
|---|---|---|---|
| A. 给 `knit_docs` 加参数与输出 | 参数 +1、输出 +1、两个枚举各 +1、渲染 +1 节 | 纯增量，但等于永久扩了工具契约 | ⏸ 必须单独一轮、并明说是契约扩展 |
| **B. 新开一个工具**（如 `knit_changes`），直接吃 `/api/changes` 的同一份结构 | 新增一个 `ToolDefinition` | `knit_docs` 与 `/api/recent` 都一字不动 | ✅ 若要做，首选 |
| C. 什么都不做 | 0 | 0 | ✅ **本轮就是这条** |

### 三.6 失败状态：**「没结果」与「读不到」必须长得不一样**（第四轮收尾）

原来那版有一个实打实的缺口：独立接口请求失败时，那一格显示成**关着**的样子（写「变更」），
用户读到的结论是「没有变更」—— 而事实是「我们没问到」。三种状态现在各有各的可见信号：

| 状态 | 状态行那一格 | 列表里 | 悬停（`title`） |
|---|---|---|---|
| 功能关着 | `变更` | 没有这一区 | 「按 Git 变更查找…（点一下打开）」 |
| 读到了、**没有未提交的变更** | `变更 0` | **不出这一区**（干净树不该有噪音） | 「0 个变更文件 · 0 条关联证据…」 |
| 读到了、有变更但**一条关联都没有** | `变更 N` | 出**区头 + 提示句**：「N 个变更文件，没有找到关联证据」 | 同上 |
| 读到了、有关联 | `变更 N` | 区头 + 若干行 | 同上 |
| **读不到**（git 不可用 / 超时 / 不是仓库 / 接口请求失败） | `变更 —` | 没有这一区 | 「读不到 Git 变更状态：<原因>」 |

两条纪律：
1. **`null` 只表示「功能没开」**，绝不用它表示失败 —— 失败有自己的形状（`{failed:true, reason}`），
   经 `changeStatusOf()` 归一成 `read:false` + 原因码。原因码有七种，其中 `request` 是
   **客户端自己的**（接口请求本身失败），与宿主那六种分开，免得都写成「原因未知」。
2. **读不到不是一条列表内容**，所以它的提示留在状态行那一格；列表里那一段最小的提示
   （区头 + 一句「没有找到关联证据」）只用于「有变更、但确实没有关联」这一种。

无论哪种状态，**普通列表与 Context Pack 一个字节都不许坏**（有测试逐个状态复核）。

---

## 四、风险与已知取舍

| 风险 | 现状 | 取舍 / 缓解 |
|---|---|---|
| `git status` 在巨型仓库上慢 | 2.5 s 超时 + 8 秒缓存 + `-uall` 的输出上限 | 超时 ⇒ 如实回 `timeout` 并降级；**不会**卡住列表（装配层在 git 之后仍照常出三层） |
| `-uall` 在未跟踪大目录上输出爆炸 | 1 MiB 上限 + kill | 超限 ⇒ `output-too-large`，如实说 |
| 变更文件很多时结果被 imports 淹没 | 实测：19 个变更文件 ⇒ `relatedTotal=38`，前 8 条由类型优先级（references > imports > tests > documents，沿用 `relations.js`）选出 | **已知取舍**：没有为变更场景另立排序策略（那会变成第二套排序）。要按「与哪个变更文件相关」分组是后续可选方向 |
| `gone` 路径的合成候选可能让 `testsOf` 从「唯一」变成「歧义」 | 合成候选只加**变更清单里**的路径 | 宁可漏（歧义 ⇒ 不算），与既有纪律一致 |
| 面板档位与「文档+代码」语料不一致 | 变更区用不分档语料渲染 | 该区**不参与编号**，也不受档位过滤（只受搜索框过滤）—— 这是有意的：变更关联不是「这一档的检索结果」 |
| **这个功能到底值不值** | 已经有量尺：`docs/evaluations/git-change-value.md`（六仓库 / 82 个回放提交 / 499 条关联目标；那条「双语孪生漏改」被它抓到过一次） | ⚠️ 量尺量的是「**当时漏改、后来被补上**」这个**事后事实**，**不等于**「提醒了就能省下返工」；要后者只能做**前向实验**，协议与工具都在那份报告里 |
| `spawn` 是 `src/` 里第一个子进程 | argv 白名单 + 上限 | **建议**：市场 `capabilities` 里的 `shell` 标签现在**运行期也成立**了（此前只由 `tools/` 的一个开发脚本触发），发版时应当在市场文案里如实说明「跑一条只读的 `git status`」 |
| ⚠️ **`git status` 自己被配置牵着写盘 / 起进程**（固定 argv 挡不住这一层） | `GIT_GLOBAL_ARGS` = `--no-optional-locks --no-pager -c core.fsmonitor=false` + 环境 `GIT_OPTIONAL_LOCKS=0` / `GIT_PAGER=cat` / `GIT_TERMINAL_PROMPT=0` | **实测（git 2.50.1 / Apple Git-155，2026-10-13）**：① 300 文件 + `core.untrackedCache=true` + stat 缓存全过期时，裸 `status` **3/3 次重写了 `.git/index`**，带开关 **0/3 次**；② `core.fsmonitor` 指向外部钩子时裸 `status` **让假钩子跑了 1 次**，带 `-c core.fsmonitor=false` **0 次**；③ `core.fsmonitor=true` 时裸 `status` **拉起了 builtin 守护进程**（`.git/fsmonitor--daemon` + `.ipc` 落盘），带覆盖**不出现**。真机回归用例见 `test/git-changes.test.mjs` 的"fsmonitor 钩子不会被拉起" |

---

## 五、验收标准

1. 五态可识别：暂存 / 未暂存 / 未跟踪 / 删除 / 重命名（`MM` 这类同时成立的**给集合，不压成一个标签**）。
2. 五种降级各有各的 reason，且**任何一条都不抛**；降级时包照旧完整。
3. 四类证据都能从变更文件找出目标，且每条都写明**起点 / 类型 / 方向 / 行号（真的有才给）**。
4. 没有证据的变更文件如实进 `unresolved`，**不硬凑**。
5. **关闭时**：包里没有 `changes` 键、三层逐字不变、一次 git 都不问。
6. **打开时**：只多一个平行区，三层 / 固定区 / 编号一个字节都不动。
7. 变更文件**自己**不出现在变更关联区；已在三层的不重复出现。
8. 上限生效：变更清单、结果条数、每条证据条数各自有界。
9. 安全守卫：两个 argv 里没有任何写动词；`--ignored` 不开。
10. 真机：真的 `git init` 一个临时仓库，五种状态都能解析出来；非仓库目录回 `not-a-repo`。
11. **独立验收案例**（受控夹具，不是脏工作区）：只改 `src/foo.ts` ⇒ 精确找到 `test/foo.test.ts`（tests）、
    `src/bar.ts`（imports）、`docs/guide.md`（documents）；**结果集合精确等于这三条**；
    四个干扰项一个都不进；每条证据的起点 / 类型 / 行号都能回到原文那一行核对
    （`tests` 那一类**没有行号**，不许编）；三层与关闭时逐字相同。
12. **安全（真机）**：`core.fsmonitor` 指向外部钩子时，我们的读取**不会执行它**。
13. **契约**：`knit_docs` 的入参集合、输出 `required`、`provenance` 与 `reason.code` 的枚举全部未变；
    `/knit/api/recent` 的响应形状也未变（顶层与 `context` 里都没有变更字段）。
14. **接口隔离（真端口）**：`/api/changes` 返回夹具里那三条关联（起点 / 类型 / 行号逐条对得上），
    干扰项一个不进；`/api/recent` 在同一个工作区上完全不受影响；时间序如实回 `not-relevance-order`。
15. **复用**：同窗内两条接口**共用一次扫描与一次 git**（窗口内删掉一个文件，两边都还看不见；
    清掉备忘后立刻反映）——**不重复走目录树、不重复 spawn**。

---

## 六、明确**不支持**的（写在这里，以免被当成缺陷）

- **不读 diff、不读补丁**：只有「哪些文件变了、怎么变的（状态）」，没有「变了什么」。
  所以「这个改动破坏了哪个测试」这类问题**答不了**。
- **不做符号级依赖**（AST / LSP / Tree-sitter / call graph）：只有 import 语句、路径提及、文件名约定。
  动态引用（`require(variable)`）、重导出、跨语言依赖都**看不到**。
- **不做 Git 历史**：只看**未提交**的工作树状态；不看 `HEAD~1..HEAD`、不看某个 commit、不看分支差异。
- **不做 staged 之外的层级区分**：暂存 / 未暂存只体现在 `kinds` 里（如实报告），**不影响**关联计算
  —— 两类都算「变更」。
- **不做跨工作区**：一次只问当前工作区根（`git` 的 `--show-prefix` 之外的路径直接丢弃）。
- **不自动把变更文件放进上下文**：它们**不出现在任何一层**，也不进变更关联区（它们是种子，不是结果）。
- **不做 UI 分组细化**：变更区是一个平铺列表，不按「哪个变更文件」再分组（见 §四的取舍）。
- **不持久化**：变更状态每次现问（8 秒缓存），不落盘、不增量、不做历史。
