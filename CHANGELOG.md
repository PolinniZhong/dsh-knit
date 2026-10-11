# Changelog

本项目的重要变更都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.22.0] - 2026-10-10

> **Incremental Context Index** —— 让**未变化的文件在进程重启后复用已有索引**，变化的文件
> **只重建它自己**，索引坏了 / 存储不在 / 版本不对时**明着退回全量扫描**，而不是悄悄交付
> 一份陈旧的 Context Pack。索引**只在那条检索真的用不着正文时才被查**（修法 ②）——
> 要正文的路径（相关检索）走的就是 v0.21 那条路，一个字都不多付。
> 旧格式的**遗留记录会被有界地清掉**（清理补丁），不会永远留在盘上白付装载成本。
> 这是**内部能力，不是用户可见功能**：UI 一行没改，没有索引面板、没有命中率、没有 Epoch。
> 硬约束照旧：**零模型 / 零网络 / 零新依赖 / 无构建步骤**（`node:crypto` 是内置模块）。

### 一句话结论（先审计，再动手）

Phase 0 审计推翻了这个版本号原本的卖点：**「未变化的文件不重读」v0.20/v0.21 早就做到了**
（进程内 `cache` 按 `mtime + size` 命中，暖扫的 `readFile` 恒为 0）。真正的缺口只有四个：
**跨进程重启要全量重读**、**`mtime + size` 是唯一的一致性证据**、**没有对账**、**没有降级叙事**。
所以这一版只补这四件事 —— 稳定模块（`relevance.js` 的 BM25 语义、`control.js`、关系投影）
一行未改，见 `01_ Knit PRD/Knit-v0.22-Phase0-审计.md`。

### 变化

- **新增 `src/host/index-store.js`**：索引的持久层，走 DSH 自己的 `ctx.storage` KV facet
  （与 `control.js` 同一个后端、**各开各的单元** `knit_index`）。
  · 布局 `per-record`（**不是** `single`）：改一个文件只碰一个键，而不是重写整份索引；
  · 键 = `rootHashOf(root) + base64url(rel)`（`per-record` 的键必须是 `[a-zA-Z0-9_-]+`）；
    **root 必须进键** —— 只用 `rel` 的话两个项目里的同名文件会抢同一个键互相覆盖（写测试时
    抓到的真实故障）；值里也带 `root`，读的一侧再过滤一遍；
  · 记录 = `{root, rel, mtimeMs, size, headHash, title, summary, refs}`，
    **`body` 永远不进索引**（正文一旦持久化，「同 mtime 同 size 的编辑」就会被静默交付成旧内容）；
    `refs` 是**抽取后的**引用 / 导入列表（`{md, any, imports}`，`md` 与 `any` 分开存 ——
    `extractRefsWithLines()` 有每篇 500 条的截断，用一套近似另一套会在超限文件上改变目标集合，
    破坏第 7 条验收）。**原文首部不进索引**：它只为关系投影服务，而关系投影要的只是这份列表；
  · `INDEX_VERSION = 3` + `compatibleVersions: [1, 2]`：v1 记录缺 `headHash`、v2 记录存的是
    `head` 而不是 `refs`，两者都读得进来、都过不了 `refsShapeOk()` 这一关，
    于是当「没有可用记录」处理、下一轮重建 —— 迁移不需要任何专用代码；
  · `canonicalRoot()` 在**进出两侧**都做 `realpathSync`：`/var/...` 与 `/private/var/...`
    是同一个目录的两个字符串，只靠调用方守纪律就会「索引时灵时不灵且不报错」（也真的踩到了）；
  · 任何失败（没有存储 / unit 开不起来 / `malformed-medium` / 版本不符）⇒ 空 Map + 一个
    `reason`，**绝不抛进检索路径**；`persisted` 只在读成功或写成功后才是 true。
- **`src/host/index.js` 的取数路径重写**：`readDoc()` / `readCode()` 这对「先查缓存再决定读不读」
  的包装函数被删掉（留两份判定只会漂移），唯一读取路径是 `readDocFromDisk()` / `readCodeFromDisk()`。
  每条候选现在走三选一：① 进程内 `cache` 命中（**单独计数**，这是 v0.20 就有的能力，不许算进
  这一版的成绩）→ ② 索引记录可复用（`mtime + size` 当快速筛子，`headHash` 是可复核的第二证据）
  → ③ 整读 + 重解析 + 重算指纹。复用出来的条目 `body === ''`、`bodyReady: false`。
- **有界对账（没有 watcher）**：每轮抽验 `INDEX_VERIFY_PER_PASS = 8` 条复用项，按**游标轮转**
  取样（不是每轮都核同一批），逐条读**头部**算指纹比对；对不上就重读该文件、就地改正并写回。
  这是「`mtime`/`size` 不得作为可靠内容一致性的唯一证据」的落实方式 —— 不是每次扫都重读一遍
  （那等于没省），而是**读到的那一份永远能被指纹复核**。删除项也按同一个游标分批清理，
  否则「1000 个文件全删掉」会变成一次 O(N) 写风暴。
- **修法 ②（2026-10-10）：索引只在那条路真的用不着正文时才查。** `collectDocs()` 现在接受
  `{index: false}`；相关检索那条路（`scan()` 里 `mode === 'relevance'`）显式传它，于是
  **不装载、不对账、不写回**索引 —— 因为 BM25 的 `df` / `avgdl` 都是正文的函数，那些记录
  反正会被立刻整读补回正文，唯一净效果是**多付一次索引装载**（每条记录一个文件 open + read
  + `JSON.parse`，实测 600 条约 60–75 ms，且这个成本与记录里的载荷大小**几乎无关**）。
  低层 API 不替调用方做这个决定：不传 `options.index` 仍然查索引（工具、测试、基准的语料阶段
  就是这样）。这一轮没查索引时读数记 `skipped: true` / `reason: 'index-skipped'`，
  与「这个进程没有存储」的 `no-storage` **分开报**，否则两种 0 混成一个数就没法排查了。
- **目录级 memo**：同一轮扫描里目录的 `readdir` 结果按**目录自身 mtime** 复用；
  新增/删除/重命名会更新父目录 mtime，而**改动已有文件不会**（APFS 实测），
  所以每个候选文件仍然**逐条重新 `stat`** —— memo 只省 `readdir`，不省变更检测。
- **`hydrateBodies()` 必须跑在 `rankByRelevance()` 之前**：复用路径上没有正文，而 BM25 的
  `avgdl` 与 `df` 都是正文的函数；顺序错了，「索引开 / 关」两份 Context Pack 就对不上。
  这是正确性问题，不是优化顺序。
- **实测（`node tools/index-benchmark.mjs`，合成语料、mtime 固定）**：语料阶段（`collectDocs`）
  的整读次数在**重启后**从 `100 / 500 / 600 / 700 / 700`（N=100…10000）降到 **8** 条
  （= 抽验预算，与规模无关），读入量从 `25 / 126 / 154 / 183 / 183 KiB` 降到 **1.9 KiB**；
  改一个文件只重读 **1** 篇；新增/删除/重命名后索引项同步增删且不返回过期结果；
  「索引开 / 关」两份 Context Pack 的指纹逐字相同（`parity-on = parity-off`）。
  三次重复的中位数与计数型读数逐次一致（`c.read` 冷 `100/500/600/700/700`、暖恒 `8`、
  `touch` 恒 `9`；parity 指纹 **12/12 次**完全相同），不是「碰巧一致」。
- **最终同口径实测（12 次重复取中位数；N=1000、每篇另加 8 KiB 填充 ⇒ 600 个文件 / 13.45 MiB，平均 22.4 KiB/篇）**：
  两条检索序要分开说，因为它们**走的路不一样**。
  · **相关序（面板默认，要正文）—— 生产形状下没有回归**：`--shape scan`（一次检索 = 新进程
    首次取数）warm **259.4 ms** vs `nostorage`（等价 v0.21）**242.6 ms**，而计数**逐项相同**
    （`readFiles` 600 / 读入 13453 KiB / `readdir` 21 / 复用 0）—— 因为这条路上索引**根本没被查**
    （`index-skipped`）。差距在噪声内，且路径就是同一条。
  · **时间序 / 无关键词（不吃正文）—— 这才是这一版真正省下来的地方**：同形状 warm **106.0 ms**
    vs `nostorage` **216.2 ms**（**2.04×**），整读 **8** 次 vs **600** 次、读入 **179 KiB** vs
    **13453 KiB**（**约 75×** 更少），复用 600 条、其中 8 条按指纹抽验过。
  ⚠️ 报告里必须写明的一件事：**旧的历史形状（`--shape collect`，先单独跑一次 `collectDocs`
  再跑检索）会给出误导性的读数** —— 那个形状下同一份语料被取两遍，于是 warm 的账会拆成
  「语料阶段 93.2ms（省了）+ 检索 219.3ms（补正文）」而 `nostorage` 是「214.7 + 47.6」，
  两列相加看起来仍慢 1.19×。那**不是生产行为**：真实的一轮相关检索没有那个预热的
  `collectDocs`。1.31× 那条旧结论来自这个形状，修法 ② 之后它已经不成立。
  取舍、复现命令与逐条读数见 `01_ Knit PRD/Knit-v0.22-实现与基准报告.md`，
- **清理补丁（2026-10-10，真机复验之后；裁决 F）**：真机 `~/.dsh/storages/knit_index/files`
  里查出 **164 条记录，键全部是旧格式**（`base64url(rel)`，没有 root 指纹），其中 **152 条是存
  16 KiB 原文首部的 v2 记录**（共 **1.7 MiB**，平均 10.7 KiB/条）。它们对**任何**工作区都不可用
  （`refsShapeOk()` 判不过 ⇒ 每轮重建），但本版的写入路径只写
  `rootHashOf(root) + base64url(rel)` ⇒ **永远覆盖不到这些键**。`compatibleVersions: [1, 2]`
  本意是「读得进来、下一轮重建」，代价却是**永久残留**：`loadAll()` 每次都要为它们付钱，
  而装载成本正比于**记录条数**（600 条小记录 60 ms ≈ 600 条肥记录 75 ms）。修法：
  `read()` 用 `keyFitsRecord(key, row)`（键必须是 `recordKey()` 的形状**且** 16 位之后解回来
  **逐字等于这条记录自己的 `rel`** —— 只查 hex 前缀不够，`relToKey()` 的字符集本身就含 `a-f`/`0-9`）
  把不合规的键收进清理队列，`write()` 在**本轮本来就要写盘时**顺手删，上界
  **`INDEX_CLEAN_PER_WRITE = 32` 条/次**（与对账的 `INDEX_VERIFY_PER_PASS = 8` 同一条纪律：
  不许为了维护索引把一次检索拖长）。删除幂等 ⇒ 不需要事务，中途失败下一轮接着删；真实工作区
  164 条 ⇒ **6 轮写盘内清完**。同源的键一律放行（包括**别的 root 的合法记录**），实测真机 164 条里
  同源 **0** 条 ⇒ 清理对象与活记录零重叠。**证伪**：把 `unit.deleteRecord()` 那行换成 `void key`
  ⇒ 新增的 2 项恰好变红（`pass 14 / fail 2`），恢复后 16/16。
  ⚠️ 一处如实记录的小浪费：其中 12 条键不合规而内容仍可用（`refs` 在、mtime+size+headHash 相符），
  它们在**同一轮里先被复用、再被删掉**，下一轮多付 12 次读盘重建 —— 正确性不受影响（内容可重新推导），
  一次性、只发生在迁移期。
  决策见 `Knit-决策记录.md` 的裁决 A / A′ / D / E / F。
- **测试**：`npm test` **697 → 728 项**，新增 `test/index-store.test.mjs`（持久层 16 项：键/指纹/
  隔离/降级/**清理与上界**）与 `test/index-incremental.test.mjs`（端到端：§6 七条验收逐条可证伪，
  含两条**证伪用例** —— ① 把抽验预算设成 0，同 `mtime` 同 `size` 的改写必然漏掉；
  ② 相关序必须 `skipped: true` 且不装载索引，时间序必须真的复用）。
  两个文件都已挂进 `package.json` 的 `scripts.test` 显式清单。

### 刻意不做

- **不做索引状态 Dashboard**、不新增任何 UI 区块、不改列表与工具栏；
- 不把内部索引 revision 暴露成第二种用户可见的 Epoch；
- **不引入 `fs.watch`**：`recursive` 跨平台语义不一致、丢事件是必然（`git checkout` / 分支切换 /
  批量操作 / 外部编辑），它只能加速不能当权威 —— 权威是每轮的有界对账。这条明确记为「未做」；
- 不引入 SQLite / 常驻服务 / 新依赖，不建立云端索引，不改变 Context Pack 排名算法与关系语义；
- 不为「让索引看起来有用」而在要正文的路径上查索引：那一条路按需查询，宁可这一次完全不碰它；
- **未发布**：`package.json` 版本已到 `0.22.0`，但**没有 `npm publish`、没有打 tag**。

## [0.21.0] - 2026-10-08

> **Relations & Context Control** —— **原 v0.21 与 原 v0.22 合并成一个版本**（用户 2026-10-08 拍板：
> 两件事在实现上是同一条链路上的前后两环，分两版只会让「关系」先当摆设）。这一版回答两个问题：
> **「这一篇为什么在这里？」** 与 **「我自己想留住 / 挡掉的那几篇呢？」**
> —— 前者给**有行号、能 grep 回原文**的关系证据（引用 / 导入 / 测试 / 文档），后者给**固定与排除**，
> 而且真的活过重启。
> 硬约束一条没松：**零模型 / 零网络 / 零新依赖 / 无构建步骤**。
> 两条边界是刻意的：关系**是投影，不是第二个排序阶段**（`rankByRelevance()` 一行未改）；
> 不做调用图 / 依赖图 / 符号索引（没有 AST / LSP / Tree-sitter），Git provenance 推迟
> （每文件一次 `git log` 在 1000 文件规模上是秒级到十秒级，与 R1 门槛冲突）。

### 变化

- **新增 `src/host/relations.js`（零 I/O 的纯逻辑）**。只做四类**有证据**的关系，
  数组顺序即截断优先级：`references`（Markdown 里引用了另一篇 Markdown）、
  `documents`（Markdown 里写到了某个代码路径）、`imports`（代码里的 `import … from` / `require(…)`，
  **逐行正则**，含行号）、`tests`（文件名约定上的测试与被测方，**唯一不带行号的一类** ——
  证据是文件名这条可核验的路径事实，不是某一行文字，所以如实不给行号，而不是编一个）。
  导出 `MAX_RELATIONS_PER_ITEM = 3` / `MAX_TOOL_RELATIONS_PER_ITEM = 2` / `RELATION_TYPES` /
  `importsOf` / `resolveSpec` / `testsOf` / `buildRelationFacts` / `relationsOf` / `resetRelationCache`。
  每条边**两端各登记一次**，`line` 属于**提及所在的那个文件**（`dir: 'in'` 时行号读的是对方那一篇）。
  同一 `(type, dir, other)` 去重取最小行号；对端**不在本批候选集**里就不产生边（不硬凑）。
- **`src/host/links.js` 三处修改**：① 新增 `extractRefsWithLines()`（与 `extractRefs` **同一套正则、
  同一套顺序**，只多给行号；`extractRefs` 现在是它 `.map()` 的结果，一处真源）；② 引用目标放开到
  「已索引的文件」（`{anyExt: true}`），**源仍然只有 Markdown** ——
  `test/code-context.test.mjs` 里那条「代码只能被指向、不能当源」的守卫原意一个字没改；
  ③ **修掉一个既有缺陷**：引用图缓存的签名原本只是「篇数 + 最大 mtime + 是否截断」，
  **不含候选集身份**，同一进程里连跑两个候选数相同、最大 mtime 落在同一文件的 query 会**串图**
  （实测复现，第二个 query 的关系全落空）。现在签名是逐篇 `rel\u0000mtimeMs` 排序后的精确键，
  不用哈希（碰撞会让关系静默错配），`test/links.test.mjs` 有回归用例。
- **`src/host/context.js`：`provenance` 三值**（`retrieval` / `relation` / `manual`）。
  ⚠️ 字段名**不叫 `source`** —— `source` 从 v0.14 起指的是**文件角色**
  （`impl` / `test` / `config` / `design` / `doc`），两者同时出现在一条记录上，不能混。
  三条既有断言（`test/context.test.mjs` / `test/context-eval.test.mjs` / `test/code-context.test.mjs`）
  已按新键加强。包内条目还会带 `relations`（最多 3 条）与 `relationsTotal`（真实总数）；
  **没有关系、也没被截断时这两个键根本不出现**（空数组是纯噪音，9 条要白花一百多字节）。
- **`src/host/index.js`**：`buildContextFor()` 组装完包后投影关系，并多一个
  `withRelations: false` 开关 —— 它唯一的用途是让「关系不改变任何一层的成员与顺序」这条
  可以被**同一次调用**直接证伪（`test/relations.test.mjs` 的端到端守卫就这么写的）。
  新路由 **`POST /knit/api/control`**（`{action, rel}`，四个动作 `pin` / `unpin` / `exclude` / `restore`）
  是**唯一的写通道**；排除在检索之前生效（`stats.controlSkipped`），固定是排名的下游
  （`applyPinOverride()`：从三层移出、进 `pinned` 区、`provenance: 'manual'`，**零新 I/O**）。
  `/api/recent` 另外回报 `control = {pinned, excluded, skipped, persisted}`，
  其中每个被排除项带 `exists`（「这篇现在还在工作区里吗」——「恢复」按钮只在它真可能回来时给）。
- **新增 `src/host/control.js`（纯逻辑 + 可选持久化，不 import 任何官方包）**。
  `ctx.storage` 拿得到就用 `kv` 落盘（`unit: knit_control`，表 `pinned` / `excluded`，
  `layout: 'single'`、键 = `` `${root}\u0000${rel}` ``，按工作区隔离），拿不到就退化成内存态。
  写路径**只写差量**，且**串行**。
  - 两条真机缺陷在这一版修掉（都是**先取证再改**）：① 插件被重复加载时，每次加载都会新建一份
    登记表，而存储单元「一个进程只有一个活句柄」，于是被模块级变量留下的**最后一个**实例恰好是
    打不开存储的那个 ⇒ 共享那份登记表挂在**后端对象**上（`Symbol.for('dsh-knit.control')`），
    同一进程里的后续加载直接复用；② `persisted` 原本在拿到 `kv` 的那一刻就报 `true`
    （报的是**能力**，不是**结果**），现在**证据到之前一律 `false`**：读成功、或这一次写真的成功，
    才转 `true`；写失败在**同一次响应**里就说出来。面板因此可以诚实地写「本会话有效（未持久化）」。
- **`src/host/tool.js`：`knit_docs` 每个条目最多 2 条关系**（`relations` / `relationsTotal` 进 schema，
  `provenance` 进 `required`），渲染成一行 `relations: references ← docs/x.md:12; imports → src/y.js:3`
  （`←` = 对方提到本条目，`→` = 本条目提到对方；`tests` 不带行号）。**只给事实，不写理由文案** ——
  理由由既有的 `Why:` 行承担。被固定的条目出现在 `pinned` 分区且 `provenance: manual`；
  被排除的条目**完全不出现**。
- **面板（`src/client/client.js`）**：相关模式的每一行有一个**弱化的来源词**（`检索` / `关系` / `用户固定`，
  只有这三个词，没有分数没有百分比）；**2026-10-09 布局改造**：标题行只留「序号 · 标记 · 标题 · 时间」，
  来源词与 `固定` / `排除` 一起搬到**证据行右端**，顺序 `固定 → 排除 → 检索`，**默认 `visibility:hidden`**
  （鼠标悬停该项 / 键盘光标 / 焦点进入才显形 —— 用 `visibility` 而不是 `opacity:0`，隐藏时**真的退出键盘焦点序**，
  且不占额外高度、不引起横向跳动），证据文本留在左边、过长可截断而操作永不被挤掉；
  **没有命中段也没有理由的条目仍留一条只含右侧操作的空行**（不写占位文字）；三个入口都是纯文字按钮、无图标；
  **同日按体验反馈**：三个入口的字号提到与命中段同级（10px → 11px；行高仍由证据行决定，不增高），
  悬停热区左右各加 4px（用等量负外边距把宽度收回 ⇒ 行的宽度与词间距都不变）；
  **同日工具栏重排（2026-10-09 第二条规格）**：`相关 / 最新`（排序）｜一根浅灰竖线｜
  `文档 / 代码 / 媒体 / 全部`（类型）｜搜索框靠最右且宽度自适应 —— 类型组从独立一行搬进工具栏
  （`.knit-types` 不再自带左右内边距），`.knit-filter` 用 `flex:1 1 180px` + `max-width:240px`
  + `min-width:0`（常规面板 180–240px、封顶后靠 `margin-left:auto` 贴右、面板窄了先缩它），
  两组都是 `flex:none` ⇒ **前面的按钮永不被挤**；六个选项彼此独立（切类型不动排序与搜索词，反之亦然）；
  「为什么」展开**行级证据**（最多 3 条，
  每条 = 类型标签 + 对方文件 + 第 N 行 + 打开，点开就地预览到那一行；超过 3 条如实写「共 N 条关系」）；
  被排除项消失并在上方留一行弱化说明 + 「恢复」；头部一条**检索状态摘要** ——
  **单行、三组、竖线分隔**：`收集 N · 排除 N · 候选 N | BM25 词法检索 · 关系 N 条 · 固定 N | 入包 N`
  （工作区候选 → 检索与调整 → 最终结果；组内中点、组间一根细竖线，**一个箭头都没有** —— 原来那串
  `↓` / `→` 把一条**已经完成**的管线画成了流程图，2026-10-09 用户裁定删除；那个没有名字的光数字
  「→ N」现在叫「候选 N」）。**每一格都是已经发生的事实**，口径逐格钉在守卫里；
  没有图标 / 胶囊 / 色块 / 装饰边框，也**不承担任何交互**（它只负责展示信息）。
  **同日第三条反馈（2026-10-09）**：这一行**紧贴工具栏**、**位置不随开关变** —— 观察层（「使用情况」）
  从摘要上面挪到它的下面，渲染顺序固定为 工具栏 → 状态摘要 → 排除说明 → 通知 → 观察层 → 列表
  （守卫钉着「开关前后摘要的位置一模一样」）。
  **同日第四条反馈（2026-10-09）**：头部那格计数**只留阿拉伯数字**（`9` / 过滤时 `3 / 79`）——
  量词本来随档位变（文档「篇」/ 代码「个代码文件」/ 媒体「个媒体」/ 混排「项」），
  同一位置换个档就换一种中文 ⇒ 整句降级到 `title`（悬停仍读得到「9 个代码文件」），
  `count` / `count.code…` 八条词条照旧在用。
  **同日第五条反馈（2026-10-09）**：点开「检索」长出来的行级证据原来是**压在下一行上面**的 ——
  DocRow 的入场补间用 `fill:'both'`，播完之后**仍然**按入场那一刻量到的高度钉着这一行
  （`el.style.height=''` 清不掉补间效果），于是证据不把下面的行挤下去、而是溢出到它上面；
  现在收尾统一走 `settleEnterAnim(el, anim)`：先 `cancel()` 注销补间、再清那两行内联样式。
  守卫 = `test/client.test.mjs` 的「行级证据是向下延展」那条（替身没有 DOM ⇒ 喂纯对象 + 钉住调用点）。
  **固定不是排序干预**：固定区不编号，三层 `01…0N` 的编号一个都不变。
- **打包修复（即 v0.20.1 的内容，已在本版树里）**：语料工厂搬进 `test/deep-corpus.mjs`，
  `tools/deep-benchmark.mjs` 变成 CLI 外壳 —— 因为 `tools/` **不在 `package.json` 的 `files` 白名单**里，
  registry 上那份 tarball 里 `npm test` 是 638 pass / 1 fail（3 条 R1 规模门槛用例）。
  **不变式保住了：`tools/` 仍然不进包**。新增 **`tools/clean-room-test.mjs`**：真打 `npm pack` →
  解包到临时目录 → 断言 `package/tools/` 只有白名单那两个文件 → 在解包目录里跑 `npm test` ⇒
  非全绿就非零退出。它是**发版前**闸门（v0.20.0 的清单只在发完之后查，太晚）。
  ⚠️ 它必须带 `--cache`，否则会撞 `~/.npm/_cacache/tmp` 的权限（那个目录属于 root）。

### 实测

- `cd knit && npm test` → **697/697**（28 个测试文件；v0.20.0 的 641 条**一条未删、未放宽、未 skip**，
  v0.21 净增 56 条：关系 / 控制 / 跨面 + 布局与动效收尾守卫）。
- `node tools/clean-room-test.mjs` → `dsh-knit-0.21.0.tgz` · 56 个文件 · 解包目录 **697 pass / 0 fail** ⇒ exit 0
  （版本号改成 `0.21.0` 当天复跑；改名之前那次是 `dsh-knit-0.20.0.tgz`，文件数与结论相同）。
- 关系投影的载荷（按 `{type, dir, other, line}` 四字段序列化）：**≈252 B/项**
  （两组真实任务各 9 项、合计 4539 B 关系投影）；面板总载荷实测 **7857 B / 9 项**（门槛 16000 B）。
- 真机（`curl` 打运行中的 DSH，工作区 `08_Knit`）：三层逐条 `provenance: retrieval` 且
  `relations` 恰好 3 条（`relationsTotal` 实测 11 / 7 / 24 / 22 / 33 / 66 / 12 / 18 / 8，截断说明里的数字是真的）；
  固定 `README.md` ⇒ 包里多出 `pinned` 分区、`provenance: manual`、原层里消失；
  排除 `03_发布/真机验收清单.md` ⇒ `skipped: 1`、被排除项**不出现**、`excluded[].exists: true`；
  **重启 DSH 后读回**：`persisted: true`，介质 `~/.dsh/storages/knit_control.json`（475 B，按工作区隔离）。
- `src/host/tool.js` 与面板**同源**：同一条任务下，面板每项关系的前 2 条与工具侧逐字相同
  （`test/tool.test.mjs` 的跨面守卫，把工具里的截断拿掉即变红）。

> ✅ **2026-10-09 已发布**：轻量 tag `v0.21.0` = 发布提交 `af7a9a39995d080381217e7f84121f17e15445d5`；npm `latest = 0.21.0`、`gitHead` = 同一个提交、共 **18 个**版本；registry 真包 **56 文件 / 637 155 B tarball / 1 870 085 B 解包 / shasum `a536984cfd908c8f1a3b117f1e4c0062e1d619a6`**；OIDC 可信发布 + provenance（`/slsa.dev/provenance/v1`，workflow run `37875191973`，19 s）；GitHub Release 正文取自本节（前置「更新后必须重启 DSH」与「新增写动作 `POST /knit/api/control`」两条），`publishedAt 2026-10-09T02:39:05Z`。
> **解包净室自测 697/0**（v0.20.0 那条 `tools/` 包装缺陷不复现；判据 = 真 `npm pack` 产物解包后跑 `npm test`）。
>
> ⚠️ **这一行不在已发布的 tarball 里** —— 它在 publish 成功之后才写进来（下次 `npm view` 看到的是这份仓库里的文件）。

## [0.20.0] - 2026-10-07

> **Deep Context Retrieval**。核心体验从「任务 → 相关文件」升级为
> 「**任务 → 相关文件 → 相关内容片段**」—— Find the file. Then find the part that matters.
> 在这之前，每一篇只有**正文前 2500 字**参与打分，所以「那一段在 5000 字之后」就等于
> 「搜不到」，而 `knit_docs` 只能诚实地告诉模型「用 grep 去更深处找」。
> 关键约束：**没有 embedding / 向量库 / LLM / 网络请求 / AST / LSP / Tree-sitter /
> 代码知识图谱、没有第二个栏位、没有 Dashboard、没有新的 preview framework。**
> 文件仍然是 Context Pack 的**基本实体** —— 这不是把 Knit 改成一个纯片段搜索工具。

### 变化

- **取消「每篇只看前 2500 字」**（删掉 `HAYSTACK_CHARS`）。文档与代码的 `body` / `hayBody`
  现在都是**整篇**转小写，上限仍是单文件 `MAX_BODY_BYTES = 256 KB`。
  一个容易忽略的事实：宿主**本来就把整篇读进内存**（`readFile` 之后才 `subarray`），
  所以这一版新增的磁盘 I/O 约等于 0，代价是幂等副本的内存（约 2× 正文，见「已知限制」）。
- **新增 `src/host/passage.js`（零依赖、纯字符串、无 AST）**。切分是**结构优先 + 长度兜底**：
  Markdown 按 H1/H2/H3 / 段落 / 代码块，代码按 `function` `class` `const` `let` `var`
  `interface` `type` `export` `import` 声明起点与大括号块；行号与字符偏移量由构造过程保证
  （不是事后 `indexOf` 猜的）。导出 `chunkText()` / `snippetOf()` / `passageMatchesFor()` /
  `windowTf()` / `passageTfOf()` 与 `PASSAGE_WINDOW = 24` / `PASSAGE_MAX_PER_FILE = 2` /
  `SNIPPET_CHARS = 200` / `PASSAGE_MAX_CHARS = 1200`。
- **文件排序与片段排序分开**（需求 §8）。既有 `rankByRelevance()` 一行未改：先按文件排名，
  再在每篇内部挑片段（命中词种数优先、其次窗口字频、最后行号升序），每篇最多 2 段、
  段与段不重叠；「20 个低价值片段堆高分」这条被 `PASSAGE_MAX_PER_FILE` 与窗口内字频同时挡住。
- **长文件污染不再因为全文检索复活**（需求 §9）。`context.js` 的 `isDocHit` 闸门改用
  **片段窗口内的字频**（`windowTf`，默认窗口 = `PASSAGE_MAX_CHARS`）而不是整篇字频 ——
  否则 29000 字的 CHANGELOG 会对**每一个**任务都满足「这一篇在讲它」而挤进每条任务的 Supporting。
  没有片段数据时（老宿主、`test/context*/fixture.mjs` 的合成记录）逐字退回 v0.19 的整篇口径，
  因此 `test/eval.test.mjs` 与 `test/context-eval.test.mjs` 的基线**一条都没改**。
- **`knit_docs` 给出「文件 + 理由 + 最相关片段 + 行号」**（需求 §15/§11）。每项可选带
  `matches: [{startLine, endLine, startOffset, endOffset, terms, snippet}]`；渲染成
  `match: lines 147–163 — …`。**只渲染一段**：R2 实测两段 = v0.19 的 1.71×，超过实现说明
  定的 1.4×，按那条规则砍到一段（同一语料 1.04×，最坏语料 1.36×）。诚实性文案改成
  「Every document and code file was searched in full (files over 256 KB are indexed only up
  to that size); images and videos have no searchable text.」—— 不再提 `2500 characters`
  和 `use grep`。顺带拿掉 v0.19 里「每返回一条就 `readDocument()` 读一遍整篇」的 I/O。
- **面板多一行 metadata：「命中段 147–163」**（需求 §12 + 2026-10-07 用户裁决）。它是一个
  **长得像文字的 button**（无图标、**无描边** —— 选中 / 聚焦都不画环，键盘焦点靠与 hover
  同款的下划线；**有一个灰底**：`--knit-chip-bg` + 6px 圆角（胶囊感）、1px 6px 内边距，两个主题各一套值，
  比行选中那档深一点，免得它在被选中的行里消失），点它走**既有**的就地预览。**点整行也一样**：行点击与
  「点那行字」都带上篇内第一段命中（用户原话「我在点击这个文档或者是代码块的时候，就进入一个
  预览，那能不能直接定位到这几段呢？这样的交互非常丝滑」）。代码文件会定位到命中行，命中区域画
  一条中性灰横带（`.knit-code-hit`，`position:absolute` + `pointer-events:none` + **`opacity:.5`**
  —— 用户要求「背景太深了，再减少一半」；不写死颜色、用 `--knit-active-bg` 回落），滚动用的仍是
  既有那一个 `.knit-preview-body`。文案从「命中片段」缩到**「命中段」**（EN `Passage:`），并且与
  v0.14 的「直接命中」**合成同一条 metadata 行**（`.knit-subrow`：命中段在左、中间一条 1px 中性
  竖线、理由在右）—— 于是这一版**没有让每一行变高**。没有分数、没有百分比、没有置信度、
  没有「AI 分析」—— 只展示可验证的行号区间。**2026-10-07 用户裁决（标点）**：中文去掉全角冒号
  （`命中段 147–163 ｜ 直接命中 knit · border`）—— 全角冒号占一个整字宽 + 强制停顿，而这一行是两个
  标签并排；整族 6 个理由标签一起改，否则标点会随理由类型跳。**冒号只在引出列表时保留**，**英文保留
  ASCII 冒号**（半个字宽，且 `direct match knit` 读起来像在说 match 这个词）。
- **Markdown 预览也跳到命中段**（2026-10-07 用户裁决：「文档这边也参考代码块一样，选中文档以后进入详情，
  要指定到段落」）。`.md` 没有行号 ⇒ 不走行锚点，走**文本锚点**：从片段原文的 `[startOffset, endOffset)`
  里按行取 1–4 根「针」（长度 ≥12、≤40；去掉行首 `#` / `>` / 列表符，`[文字](地址)` 只留文字，
  `*` / `~` / 反引号去掉，**下划线只在成对强调处删**以保住 `snake_case`，空白折叠），再把渲染后的
  文本节点接成一根带下标映射的串去 `indexOf`，找到就滚 `.knit-preview-body` 并给那一块一次 1.2s 的淡底
  （`.knit-md-body .knit-doc-hit`，与 Coverage 那层同一档灰、同一个 `FLASH_MS`）；**找不到就什么都不做**
  （宁可不动，也不假装动了 —— 需求 §26）。两处都是真机实测后才对的：① DSH 的**行内 `code` 是
  `inline-block`** —— 不把它算作行内，淡底会画在那一小片片上，所以 `DOC_INLINE_DISPLAY` 里补上
  `inline-block / inline-flex / inline-grid / ruby`，落到所在的段落 / 列表项；② 同一根针在长文档里出现
  几十次是常态，`docPickOffset()` 先**独特的那根针优先**、同档再按 `startOffset / 全文长度` 挑
  **离锚点最近的那一次**（否则 `indexOf` 永远跳去全篇最早那次 —— 实测 CHANGELOG 就跳去了第 11 行的
  同名行内 code 而不是第 36 行）。渲染仍是 DSH 的 `MarkdownText`（`DocPane` 只包一层，**不自己渲染
  Markdown**）；正文走**显式 `body` prop** 而不是 children（测试替身展开函数组件时只传 props）。
- **修一处在真机截图上发现的缺陷：Context Pack 的三层行不显示「命中片段」**（2026-10-07 验收时发现）。
  宿主给三层条目的投影只有 `rel / title / summary / mtimeMs / kind / source / reason` 七个键
  （`context.js`），**没有 `matches`** —— 于是 Primary / Supporting / Related 这九行（恰恰是最该给
  片段的那几行）一条片段行都没渲染，只有「其他相关文档」区（取自 `docs`）有。修法是客户端按 `rel`
  从 `visibleDocs` 取回 `matches`（`docs` 里本来就有这份数据 ⇒ **载荷零增长**；没有改成让宿主补键，
  因为面板载荷已经吃掉 16 KB 预算的大部分）。新增守卫
  `test/client.test.mjs`「v0.20 命中片段：三层（Primary/Supporting/Related）的行也要有片段行」——
  把修法拿掉即变红（`README 在三层里，也必须有片段行`）。


- **暗色模式：把列表里最高那一档的白降下来，并全部改回 DSH 官方令牌**（2026-10-07 用户：
  「暗色模式下高亮那个色值是不是纯白色……太亮了，就是太白了，看得有点犯晕」）。属实：命中段的底
  原本是**纯白 13%**（`--knit-chip-bg`），是三档里最高的一档，而且那个 13% 是我们自己拍的数 ——
  DSH 官方的 `--dsw-alias-interactive-bg-active` 在暗色下只有 `#ffffff24` = 14.12%（值取自
  `dsh-client-ui-theme/lib/client.js`）。现在三档一律「官方透明度 × 固定比例」，且**暗色三个比例
  比浅色各低 10%**：hover `7.84%×0.36`、active `14.12%×0.54`、chip `14.12%×0.81`（浅色比例是
  `0.41` / `0.60` / `0.90`，暗色这组 = 浅色 ×0.9；**浅色的三个值一个字没动**）。顺手修掉两处「自己造一套」：
  ① 代码里有 6 处引用 `--dsw-alias-text-primary/secondary/tertiary` —— **DSH 全库零定义**（逐文件核实），
  等于一直在静默失效：`color` 取到 unset ⇒ 命中段那一格的 hover 变色其实从来没生效过；已全部改回
  官方 `--dsw-alias-label-primary/secondary/tertiary`，并补上官方浅色值作 fallback。
  ② 图标原来写死 `#000` / `#fff`：暗色的 `#fff` 比 DSH 自己的主文本色 `#f9fafb` 还亮，现在走
  `--dsw-alias-label-primary`（令牌自己随主题切，那条 `body[data-ds-dark-theme] .knit-icon` 覆盖规则
  因此删掉）。守卫：`test/client.test.mjs` 的灰底用例改成断言三档 + 「命中段必须比行选中更深」
  + 「不得亮过官方 active 14.12%」+「不许出现 `--dsw-alias-text-`」；`test/icon.test.mjs` 改成断言
  官方令牌 + 不许再写死黑白。**测试数不变（635）**，是替换断言而不是加用例。

- **代码预览：语法高亮（2026-10-07 用户新增需求）**。用户原话：「我们现在在暗色模式下它是白色，
  对于一个阅读代码的用户来说，它的可读性太低了；那在浅色模式下它也是一种黑色……你看这块要怎么治理一下？」
  治理方式**不是自己配色**，而是**接 DSH 官方那一套**：
  ① 复用客户端**本来就在 require** 的 `@deepseek-ai/dsh-client-ui-primitives` 里的
  `useCodeHighlighter(language)`（与 `MarkdownText` 同一个包 ⇒ **零新依赖、零新 specifier**）；
  ② 语言标识**只认宿主分类层**给的 `language`（`classifyFile()` 的结论）—— 客户端自己不建第二张后缀表；
  ③ 颜色**只来自 `--shiki-*`**（定义在 `dsh-client-ui-theme`：`--shiki-token-keyword` 浅 `#d6336c` /
  暗 `#faa2c1`、`comment` `#868e96` / `#adb5bd`、`string` `#2f9e44` / `#69db7c`……）⇒ 深浅两个主题
  各自吃到官方调色板，不必为任何一个主题写死色值（这正是上面那条暗色治理的反面教材）；
  ④ 拿不到高亮器（旧版 DSH / 包缺失）时**静默回落纯文本**，不报错、不空白。
  **性能**：官方高亮器是同步的 shiki JS 引擎，真机实测约 170–560 ms / 千行 —— 4000 行的文件
  （v0.19.1 基线 117 ms 打开）要 **1.3–2.2 s**，回车点开会白等一秒多。当天先收到「只上色前
  800 行」，用户仍反馈「加载还是有点慢」，于是**再收一次**（用户原话：「要不代码模块我们换一个方案，
  就是命中段才有颜色，不命中的段就不用上颜色，还是用原来的，浅色模式下用黑色，暗色模式下用白色
  就可以了。我觉得这样可能就简单了。因为我刚刚去看了一下，加载还是有点慢，800 行也是很慢」）：
  上色范围 = **命中段前后各 `CODE_HL_PAD = 60` 行**，硬上限 `CODE_HL_MAX_LINES = 800`
  （命中段本身可能几百行）；**没有命中段（载荷里没有 `matches`）就一个 token 都不上色**，其余行
  保持默认正文色（浅色黑 / 暗色白，跟随主题令牌）；窗口之上 / 之下的行各是**一个**纯文本节点
  （截断的是颜色，不是内容）。真机实测（同一浏览器会话连开 8 篇）：`client.js`（4000 行）
  **1496 → 424 ms**、`client.test.mjs`（4000 行）**2226 → 193 ms**，8 篇合计约 **5.9 s → 1.3 s**。
  ⚠️ 已知代价：窗口从半截注释 / 字符串中间开始时缺分词上下文，那一段可能**错色**（命中横带仍精确
  标出行）。⚠️ 试过并**否决**「用
  `useEffect` + `setTimeout(0)` 让出一帧、颜色随后补」：真机反而更慢（首个文本 3605 ms、颜色 3614 ms，
  基线是同步版 1458 ms）—— `setTimeout(0)` 的回调在下一次绘制**之前**就跑掉了，纯文本那一帧从未
  真正画出来，还多付了一次「文本节点 → 19782 个 span」的替换提交。
  **渲染形状**：正文仍是**一个** `<pre>`，行间只隔一个 `'
'` 文本节点、**不包逐行元素** ——
  行锚点（v0.20 §13）靠 `pre.scrollHeight / 行数` 量行高，逐行元素会把这个几何改掉；
  窗口之外的头 / 尾也各是**一个**纯文本节点。高亮器返回的行数与正文对不上时一律退回纯文本
  （宁可没颜色，也不能让颜色落在错误的代码上）。`useMemo` 记忆化，滚动 / 悬停 / 5 s 轮询的重渲染不重算。
  测试 **+4（635 → 639）**：`test/client.test.mjs` 新增「逐 token 上色、颜色只来自 `--shiki-*`」
  「宿主没导出高亮器时回落纯文本」「只给命中段前后各 60 行上色、窗口被 `CODE_HL_MAX_LINES` 截住」
  「没有命中段就一个 token 都不上色」；`test/harness.mjs` 的假高亮器同时记录收到的**语言**与**正文**。
  真机实测（Playwright，浅/暗两主题）：颜色集合 = `--shiki-token-keyword/-comment/-string/-constant/
  -function/-punctuation` + `--shiki-foreground`；命中横带几何、锚点滚动、横向滚动都没被 token 化破坏。

- **交互性能治理（2026-10-07，用户报「点击选中文档 / 代码都很卡、切换标签也卡顿」）**。先测后改：
  宿主**不慢**（`/api/recent` 59–104 ms、`/api/context` 58 ms；R1 规模基准 1000 文件 cold 157 ms /
  warm 21 ms，两条门槛都 PASS），慢在客户端四处：① **语法高亮每次重付**（`CodePane` 的 `useMemo`
  只活在挂载期，切换类型档会卸载预览）⇒ 加**按文件缓存**（`CODE_HL_CACHE`，LRU 8 篇，键 =
  `rel` + 窗口范围）；② **FLIP 每次提交把整屏行全量量一遍**（`applyRowFlips` 的 `settled` 判据只看
  视图签名）⇒ 加**行签名短路**（`rowSig` = 窗口尺寸 + 每行 `rel` / `tierKey` / `matches` 数 / mtime，
  签名不变就复用上次的布局点、一行都不量）；③ **每 5 s 轮询无条件 `setState` 一个新对象** ⇒
  载荷签名与上次相同就**返回同一个 state 对象**（真 React 靠 `Object.is` 跳过整棵子树重渲染），
  时间戳也改成渲染时刻取钟、不再为它重建 state；④ 行高 layout effect **先量后判** ⇒ 改成不补间就
  提前返回（「别白量」：一屏挂着上万个 token span 时白量一次 ≈ 0.25 s @4× 节流）。
  **改前 / 改后**（4× CPU 节流 + Retina，同一套脚本）：切换类型档阻塞 **118 → 0–69 ms**、
  点文档行阻塞 **415 → 172 ms**、同一篇代码关掉再开阻塞 **1390 → 261 ms**（CDP Profiler 里
  `findNextMatchSync` = shiki 分词**从热点中消失**）、点代码行首开仍重（**2728 → 2217 ms**，剩下的是
  第一次冷分词，第二次起走缓存）。测试 **+2（639 → 641）**：「同一篇代码收起再打开不再重新分词
  （按文件缓存）」「载荷一字没变时，轮询不再落状态」—— 两条都**放过一次 bug**：把缓存 / 去重绕过
  立刻变红（`actual 17 vs 11` / `actual 2 vs 1`）。⚠️ `test/harness.mjs` 的 `reset()` 补了
  `timers.clear()` 与 `stateWrites()`：轮询链会自己续命、替身又从不跑 effect cleanup，上一个用例的
  链会污染下一个用例的 hook 槽位（`v0.18 Coverage flash` 那条用例因此补了一次 `await harness.flush()`，
  断言一个字没改）。

### 测试

- `npm test`：**641 / 641 通过**（v0.19.1 是 588；26 个测试文件）。
- **新增 `test/deep-context.test.mjs`（17 条）**：需求 §21 点名的 12 个用例逐条对应 + §17 的
  媒体反例 + `windowTf` 单元 + 长归档分层集成 + **R2 面板预算**（≤24 篇带片段、每篇 ≤2 段、
  片段 ≤`SNIPPET_CHARS`+8、载荷增量 ≤ 实测上界 16 KB / 每篇 700 B）。
- **新增 `test/deep-eval.test.mjs`（4 条）** 与 `test/eval/deep.mjs`（四指标的唯一定义处）。
- **新增 `test/deep-scale.test.mjs`（3 条）**：1000 文件规模的硬门槛与确定性。
- `test/client.test.mjs` **+17**（127 → 144）：命中片段的渲染与点击、代码行锚点几何、样式纪律、i18n 键、
  「媒体卡片即使被塞上 `matches` 也不渲染」，以及两条 2026-10-07 的裁决守卫：
  **三层行也要有片段行**（`README 在三层里，也必须有片段行` —— 把客户端的 `withHits` 拿掉即红）、
  **两条 metadata 合成一条**（`.knit-subrow` 存在、命中段在「正文命中」之前、有且只有一条 1px 竖线）、
  **点整行带锚点**（行为断言 + `previewFor(doc, firstMatchOf(doc))` 源码守卫 —— 测试替身没有真实
  布局，横带量不到行高，所以这条按 `AGENTS.md` §8.2 走「守代码形状 + 人眼」）。样式守卫同时钉住
  `outline:none`（不再有白描边）、横带 `opacity:.5`、竖线是 1px 且不是虚线 / 渐变。
  其中 **6 条是 Markdown 文本锚点**：归一化口径（`snake_case` 不许被当成强调）、取针（跳太短的行 /
  去重 / 上限 / 越界不许闭眼切）、`docPickOffset`（重复的针按位置比例挑、独特的针优先、空正文返回 -1）、
  `DocPane` 只包一层且没有 DOM 时不抛、接线守卫（`ratio` 一路传下去、`inline-block` 必须算行内）、
  样式纪律（`transition` 在基础选择器上、时长 == `FLASH_MS`、不画边框）。
- `test/tool.test.mjs` +3：R2 预算守卫、镜像常量守卫（工具说的 256 KB 必须等于宿主真读的
  `MAX_BODY_BYTES`，工具的 `SNIPPET_CHARS` 必须等于评分侧的）、**跨面集成守卫**（需求 §15：
  同一条任务下 `knit_docs` 的 `matches` 行号必须与面板载荷 `docs[].matches` 逐条一致 ——
  两侧各有自己的补偿路径〔面板靠客户端按 `rel` 取回、工具靠 `tool.js` 的 `matchesByRel`〕，
  单面测试**各自都是绿的**，只有这条能抓住它们漂移）。
- **v0.19 的既有基线一条没改**（需求 §22）：`test/eval.test.mjs` 与
  `test/context-eval.test.mjs` 的断言、夹具与阈值全部原样通过。

### 改动量

- **26 个功能文件 = 20 改 + 6 新增**（另有 2 个不进包的开发文件：`tools/agents-budget.mjs`、`knit/AGENTS.md`；
  发布提交合计 **33 处改动 = 25 改 + 8 新增** —— 多出来的 5 处是仓库侧的演示资产：`docs/README.md`
  与重拍的四张图 `docs/screenshot.png` / `screenshot-media.png` / `screenshot-all.png` / `demo-reorder.gif`）。
  仓库根就是 `knit/`；`git diff --shortstat` = `25 files changed, 2507 insertions(+), 218 deletions(-)`，
  不含 8 个新文件。
  > 2026-10-08 仓库侧又补了两轮**不进包**的改动：① **指令上下文治理**（`tools/agents-budget.mjs` 加
  > `--claims` / `--strict` / 每层 sha256 指纹，常驻层改成触发词路由并净减 302 B，裁决记在
  > `Knit-决策记录.md`）；② 按 v0.20 界面**重拍四张演示图**（`docs/` 不在 `files` 白名单里，它们只出现在
  > GitHub README 与市场详情页上）。两轮都**没动插件代码**（tarball 只因本节这几行文档改动而略变，
  > 打包数字见下）。
- **新增 6 个**：`src/host/passage.js`、`test/deep-context.test.mjs`、`test/deep-eval.test.mjs`、
  `test/deep-scale.test.mjs`、`test/eval/deep.mjs`、`tools/deep-benchmark.mjs`。
- `npm pack --dry-run`：**51 文件 / 557.0 kB 打包 / 1.66 MB 解包**（v0.19.1 是 46 文件 / 483.4 kB）。
  ⚠️ **shasum 故意不写在这一节里**：这份 CHANGELOG 本身就在 tarball 里，写自己的 shasum 会自指
  （改一次就变一次）。**发布前那一刻的 shasum 记在 `03_发布/发布清单-v0.20.0.md`**（仓库外）。

### 基准

- **Deep Context Eval（需求 §23 的四个指标，`node -e "…runDeepEval()"`）**：
  `DeepHitRate = 1.000`（v0.19 口径 **0.167**）、`PassageHit@1 = 1.000`、
  `PassageRecall = 1.000`、`LongDocumentNoiseRate = 0.000`。5 条深度用例（词只在 2500 字之后、
  尾部、一处两命中、代码函数附近、heading 附近）全部 `✔ 第 1 名`，长归档在 6 条用例里
  **一次都没进 Primary/Supporting**。
- **R1 规模（`node tools/deep-benchmark.mjs`）**：100 文件 cold 63 ms；500 文件 164 ms；
  1000 文件（进池 400 文档 + 100 代码）**157 ms**；真实工作区 1100 文件
  （进池 400 + 300）**384 ms**。门槛 `1500 ms` / `1200 ms`，余量约 10× / 3×。
- **R2 预算（实测）**：面板载荷 24 篇带片段时 `+14760` 字节（每篇 615 B，片段最长 202 字符 ——
  需求 §16 要的是更精准而不是更大，所以这条钉了自动守卫）；`knit_docs` 渲染文本
  1.04×（真机压力语料）～1.36×（最坏语料），均在 1.4× 以内。
- **§29 Step 8 真实验证**（真实工作区 `08_Knit`，非合成样本）：`knit/CHANGELOG.md`
  第 907 行的唯一词（正是那句「Matches come from the first 2500 characters…」）与
  `knit/src/host/context.js` 第 133 行的唯一词，两者都**不在前 2500 字内** ——
  v0.20 都能命中并给出覆盖该行的片段（名次 5/126 与 10/126）。

### 已知限制

- **Markdown 预览靠文本锚点跳段，不是行号**：`.md` 的「命中段」点击（以及直接点整行）会滚到**那一块**
  （片段首行那根「针」落在哪个渲染块上）并闪一次底 —— 但它指的是一段**文本**，不是源文件第 N 行；
  针在渲染结果里找不到时只打开、不滚动（宁可不动，也不指错）。代码文件才是精确到行的锚点。
- **单文件 256 KB 上限**：超过的部分不索引（输出里如实说明）。
- **媒体没有可检索正文**，不做 OCR、不调视觉模型（需求 §17）。
- **内存**：`body`（原文）与 `hayBody`（小写副本）现在都是整篇，每条约占 2× 正文；
  缓存淘汰仍按 `bodyBytes` 计一份（已知偏差，未改）。
- **多词查询下，什么话题都提一句的长归档在文件级仍可能排在聚焦短文前面**：
  `isDocHit` 管的是**分层**，不管文件名次。

### 没有实现（刻意）

Context Provenance、Context Graph UI、Pin-Lock、Context Bundle、Multi-Harness、MCP Server、
Doubao Adapter、Semantic Search、Embedding、Session Memory、AI Summary、新 Dashboard、
embedding / 向量数据库 / LLM / 网络 / LSP / Tree-sitter / AST 依赖图 / 语义模型 / 知识图谱，
以及把 Knit 做成 IDE / Code Intelligence / Language Server。

### 三问（每版必答，需求 §16）

1. **用户现在多获得了什么能力**：点开任何一篇（无论多长）都能直接看到**命中在哪几行**，并且
   预览会**滚到那一段** —— 代码精确到行、Markdown 落到那一块。此前长文档里「第 5000 字之后」
   等于不存在：列表只给文件名，预览从头开始，用户得自己在整篇里找。
2. **Agent 的 Context Consumption 多获得了什么能力**：**知道「文件内部哪里相关」**。
   `knit_docs` 每条多一行 `match: lines 147–163 — …`（原文片段 + 行号），模型不必为定位再 `grep`
   或整篇读一遍；诚实性文案也随之改成「全文都搜过了」（不再说「只看前 2500 字，更深的用 grep」）。
3. **明确没有做**：见上一节「没有实现（刻意）」。这一版**刻意不做**的四条最容易被误加的：
   语义/向量检索（留 v0.24）、把片段当排序基本实体（文件仍是基本实体）、第二套预览框架、
   在任何界面上显示分数 / 百分比 / 命中计数。已知边界另见「已知限制」。

### 升级注意

- **宿主不热加载** ⇒ 升级后要重启 DSH 才会生效（客户端 bundle 随页面刷新）。

> ✅ **2026-10-08 已发布**：轻量 tag `v0.20.0` = 发布提交 `2be278486299c721daa21ee127fd26bbe21af284`；npm `latest = 0.20.0`、`gitHead` = 同一个提交、共 **17 个**版本；registry 真包 **51 文件 / 565 078 B tarball / 1 662 961 B 解包 / shasum `7be584a08529379dba7d255028d59a2853624094`**；OIDC 可信发布 + provenance（workflow run `37730146187`，22 s）；GitHub Release 正文取自本节（前置「更新后必须重启 DSH」与「已知问题」两条），`publishedAt 2026-10-08T05:08:35Z`。
> ⚠️ 本地 `npm pack --dry-run` 报 51 文件 / 557.0 kB / shasum `deb8bfe6…` —— **本地字节与 registry 历来对不上**（v0.18 / v0.19.x 都这样），差的只是 tar/gzip 框架元数据，解包后清单与内容逐字一致。
> ⚠️ **发布后才发现的一条包装缺陷**：`test/deep-scale.test.mjs` 从 `../tools/deep-benchmark.mjs` 取语料工厂，而 `tools/` 不随包发布 ⇒ **解包目录里 `npm test` = 638 pass / 1 fail**（`ERR_MODULE_NOT_FOUND`）。**插件本体不受影响**（`src/` 不引用 `tools/`）。仓库完整套件仍是 641/641；已在 **v0.20.1** 修（把语料工厂搬进 `test/`）。
> ⚠️ **这一行不在已发布的 tarball 里** —— 它在 publish 成功之后才写进来（下次 `npm view` 看到的是这份仓库里的文件）。

## [0.19.1] - 2026-10-07

> **定位重构（只改对外叙事，一行代码没动）**。产品已经从 v0.12 时代的「更聪明的最近文件列表」
> 长成了 **Workspace Context Retrieval**：当前任务 → 工作区检索 → 主要 / 辅助 / 相关 →
> Context Pack → Agent 读取 → 读取证据 → 工作区变化 → 重新读取。v0.19.1 把 README、
> 仓库 About 与市场条目文案统一到这条主线上，并把「怎么排序」（BM25 / IDF）
> 从卖点降级成证据。

### 变化

- **`README.md` / `README.en.md` 第一屏整体换掉**。定位句升级为
  *Task-aware workspace context retrieval and lifecycle tracking for AI coding agents.*
  （面向 AI Coding Agent 的任务感知工作区上下文检索与生命周期追踪），并给出
  Find → Organize → Track 的主线图。原来开头的「Agent 一天产出 20 篇文档，你找不到刚才那篇」
  降级成 `## 为什么需要它` 里的一句引文。
- **「这不就是个最近文件列表吗？」不再是「是的，但…」**。改成
  `## 「最近文件列表」和「代码浏览器」都不是它`，用一张五行对照表（范围 / 排序 / 输出 /
  给谁 / 之后）说明区别，不再替读者接受「最近文件」这个框架。
- **BM25 降级为证据**。原「「相关」是怎么算出来的」改成
  `## 检索是怎么算的（实现细节，不是产品定义）`，正文前加一句「这一节是证据，不是卖点」。
- **章节重排**：两份 README 的章节顺序现在一一对应；英文版原先嵌在
  "Did it actually get used?" 里的 `### v0.19: code as context (Code Context)`
  提升成独立的 `## Code as context (v0.19)`。
- **`package.json`**：`description` 换成同时讲 retrieval 与 lifecycle tracking 的一版；
  keywords 24 → 27（新增 `workspace-context` / `context-retrieval` / `context-lifecycle`）。
- **无代码变更**：`src/`、`test/`、`tools/` 一行没动，测试仍是 588 项全绿。

> ✅ **2026-10-07 已发布**：轻量 tag `v0.19.1` = 发布提交 `8dbbdef80c0d4d691b2724225ee6c4ec93aa6c34`；npm `latest = 0.19.1`、`gitHead` = 同一个提交、共 **16 个**版本；registry 真包 **46 文件 / 490 417 B 打包 / 1 452 990 B 解包 / shasum `a69ed85eb065335fda6a3e6cf91dfb346b76b71a`**；OIDC 可信发布 + provenance（`/slsa.dev/provenance/v1`）；GitHub Release 正文取自本节（27 行 / 2020 字节），`publishedAt 2026-10-07T04:49:46Z`。
> ⚠️ 本地 `npm pack --dry-run` 报 46 文件 / 483.4 kB / shasum `5bfd69b0…` —— **本地字节与 registry 历来对不上**（v0.18 / v0.19.0 都这样），差的只是 tar/gzip 框架元数据，解包后清单与内容逐字一致。
> ⚠️ **这一行不在已发布的 tarball 里** —— 它在 publish 成功之后才写进来（下次 `npm view` 看到的是这份仓库里的文件）。

## [0.19.0] - 2026-10-07

> **Code Context**。产品概念从「Markdown / 图片 / 视频」变成「**文档 / 代码 / 媒体**」——
> 这不是给后缀表加几行，而是让 Knit 把 AI Coding 任务**当前真正需要的那几个源码文件**
> 纳入同一条 Context Retrieval 链路。
> 关键约束：**没有第二条检索链路、没有第二套生命周期、没有第二个 Context Store、
> 没有 AST / LSP / embedding / 模型调用 / 网络请求、没有把 Knit 变成代码浏览器或 IDE。**
> 主线数据流一个字没改：当前任务 → Workspace Retrieval → Document + Code Candidates →
> Primary / Supporting / Related → Context Pack → Agent Read → Read Evidence →
> File Changed → Lifecycle → Context Epoch / Delta → Usage Lens。

### 变化

- **新增独立的文件分类层 `src/host/classification.js`**。在这之前，扩展名判定是
  `src/host/index.js` 里一个返回 `''|'md'|'image'|'video'` 的 `kindOfName()`，散在扫描、
  预览、UI 各处。现在只有一个入口：`classifyFile(name)` →
  `{kind, language, previewable, searchable, contextual, generated, sourceMap}`，
  扫描 / 检索 / 预览 / UI **全部消费它的产物**，没有一处再自己看扩展名
  （有一条架构守卫：`src/host/index.js` 与 `src/client/client.js` 里不许出现
  `'.ts'` `'.py'` `'.map'` `'.min.js'` 这类后缀字面量）。
- **第一批支持 17 个代码后缀**：`.js .mjs .cjs .ts .tsx .jsx .py .json .html .htm
  .css .scss .yaml .yml .sh .bash .zsh`。内部统一 `{kind:'code', language:'…'}`。
  **刻意不支持** `.go .rs .java .kt .c .cpp .h .hpp .cs .php .rb .swift .sql` ——
  范围越小，「代码上下文到底有没有用」这个结论越可信。
- **代码复用 Markdown 的 BM25，只换字段口径**。代码没有 Markdown 的 title/summary/body，
  所以宿主按 `filename`（**带扩展名**，`plugin-loader.js` 与 `plugin.json` 的差别就在这儿）
  → `title` 字段、`目录`（保留结尾斜杠）→ `summary` 字段、`正文前 8 KB` → `body` 字段填充，
  于是 `relevance.js` 里既有的 `FIELD_WEIGHTS = {title:4, summary:2, body:1}`
  **一行未改**就是需求要的 filename×4 / path×2 / content×1。排序器、语料过滤、
  门槛规则全是同一个。
- **`.map` / generated / noise 一律不进上下文**：`*.map`、`*.min.js`、`*.min.css`、
  `*.bundle.js`、`*.generated.js`、`*.gen.js`、`*.lock`（含 `package-lock.json`）→
  `{kind:'generated', searchable:false, contextual:false}`。它们不参与检索、不进 Context Pack、
  不进 Usage Lens、不进代码列表、不进 BM25 语料 —— 但**仍然可以预览**（用户主动从
  DSH 原生文件树点开时不拦）：**Context eligibility ≠ File system visibility**。
- **有边界的扫描**：新增 `MAX_CODE = 300`（Markdown 仍是 400）、代码正文只读前 8 KB
  （`CODE_HEAD_BYTES = 8*1024`，没有无界读取）。目录元信息 → 扩展名分类 → 候选准入 →
  有界内容读取，顺序不变。数字是**量出来的**：真实项目根（`08_Knit`）59 文档 + 54 代码，
  上限根本碰不到；而一个 1300+ 目录的大树正好在这里截住（400 文档 + 300 代码 + 400 媒体）。
- **代码预览就地展开，不新增交互**：复用面板下方那块现有预览区。行号 gutter + 等宽正文、
  横向滚动只在正文列（纵向滚动仍归 `.knit-preview-body`，**没有第二个纵向滚动容器**）、
  复制、`打开文件`、同一个 `Source map` 轻量入口（只在同名 `.map` 存在时出现）。
  超过 4000 行只渲染前 4000 行并明说被截断。**没有**语法高亮 / 折叠 / 多标签 / mini-map /
  git diff / symbol outline —— 也没有引入 Monaco 或 CodeMirror。
- **UI 类型档从三档变四档**：`文档 / 代码 / 媒体 / 全部`。代码档**仍然受当前任务检索支配**，
  不是「项目代码文件树」：任务说「改 Skill loader 支持新 frontmatter」，这一档就该是
  `skill-loader.ts` 在前，而不是 `src/` 下全部代码。没有第二层语言分类 UI；
  代码行只多一个很弱的语言徽章（`TS` / `PY` …），文档行不挂（整列都是 MD，是纯噪声）。
  「全部」档变成三区：文档区（≤4）→ 代码区（≤4）→ 媒体网格。
- **代码的理由码**：`filenameMatch`（文件名命中，与 Markdown 的 `titleMatch` 同级）与
  `pathMatch`（目录命中，与 `summaryMatch` 同级）。`why.filenameMatch` / `why.pathMatch`
  中英各一条；**没有**新增第 8 个条目字段 —— `{rel,title,summary,mtimeMs,kind,source,reason}`
  与 v0.18 逐字相同，代码只是让 `kind` 多了一个取值。
- **生命周期 / Read Evidence / Epoch / Delta / Usage Lens 一行未改**。代码被读之后走的是
  完全同一套归因：读的时候在哪一层就冻结在哪一层，历史证据不许因后来的 BM25 变化而重算；
  四态（未读 / 已读 / 读后已更新 / 修改后已重新读取）也是同一套；Epoch 是同一份；
  UI 上多出来的叫法一个都没有（仍然只叫「上下文变化」）。
- **预览头那条路径改成「在文件管理器里定位到这个文件」**。原文案是「用系统默认应用打开这篇文档」，
  与页脚那个「本地打开」按钮**做的是同一件事** —— 一个东西两个入口，还偏要悬停才知道。
  现在两者分工清楚：**路径点开它所在的文件夹、并且已经选中这个文件**
  （`openWorkspacePath({ path, action: 'reveal' })`，macOS 走 `open -R`、Windows 走
  `explorer /select,`，正是 Chrome「在文件夹中显示」那个手感 —— 不用在文件夹里自己再找一遍），
  **「本地打开」点开文件本身**（不带 `action`，走默认应用）。文案随之换成
  `preview.reveal`（中「在文件管理器中显示并选中这个文件」/ 英 `Show this file in your file manager (and select it)`）。
  ⚠️ 送过去的是**文件本身的绝对路径**而不是所在目录 —— reveal 一个目录会变成
  「在上级目录里选中这个文件夹」，不是用户要的。Linux 的 `xdg-open` 没有「选中」这个概念，
  那边只有打开目录（平台差异，不是少做一步）。
- **修：开着「使用情况」点全屏，预览没铺满**。全屏的隐藏名单写于 v0.12，当时面板里只有
  「头部 / 排序条 / 类型档 / 列表 / 预览」这几块，所以只藏了前四块；v0.18 在列表**上方**
  加了 Context Usage Lens（`.knit-usage`），谁也没回头去补那份名单 —— 于是开着「使用情况」
  再点全屏，Lens 仍以 `flex:none` 的自然高度占掉面板上方约三分之一，预览被挤在下面，
  看起来就像「全屏没生效」。补 `.knit-root.fullscreen .knit-usage{display:none}` 一块即可，
  预览那条 `flex:1 1 auto` 本来就在等它让位。
  守卫放在 `test/client.test.mjs`：全屏隐藏名单必须覆盖 `.knit-head` / `.knit-bar` /
  `.knit-types` / `.knit-usage` / `.knit-list`，并跟真的渲染出来的全屏树对一次账 ——
  以后谁再往列表上方加块，这条会响。
- **HTML 多了「网页预览」**。加了代码支持之后，`.html` 点开看到的是**源码**；
  可 HTML 想看的恰恰是它渲染出来的样子。DSH 其实**自带**这个渲染器
  （`dsh-client-ui-sidebar-documentpreview` 注册了 `["html","htm"]`，默认静态档：
  DOMPurify 清洗过的文档塞进一个**不给任何 sandbox 权限**的 iframe，CSP 摆在最前挡脚本 /
  外部资源 / 连接 / 表单 / 嵌套框架，内联 `<style>` 与 `data:` 图片保留），而 Knit 双击一行
  本来就走 `actions.openResource` → 官方文档预览 —— 通路早就在，缺的只是一个入口。
  所以预览头给 `.html` / `.htm` 加一个「网页预览」按钮，走的就是双击那条**同一个**
  `openResource` 通道：**没有新开第二条打开路径、没有 iframe、没有把 DSH 的渲染器搬进面板**，
  Knit 的零网络出口承诺一个字不用改。
  这不算「把删掉的功能加回来」：v0.10 撤掉「新标签页」按钮的理由是「就地预览已经能看到内容，
  重复度高」—— 那条前提对 HTML 不成立（就地给源码、官方给页面），是纠正而不是回退；
  其余代码类型一个都不给这个按钮。
- **修掉「工作区是符号链接时，点路径一律报 `Path has no verified Host path`」**（发布前发现的真实 bug）：
  在 `DSH_Skill_Trace`（→ `10_DSH_Skill_Trace` 的符号链接）这类工作区里，点预览头路径 /
  「本地打开」/ 点顶部工作区路径**全部失败**，而在真实目录（`08_Knit`）里没事。
  根因不在 Knit，在 DSH 的校验方式：`dsh-api-session-controller` 的 `verifyDesktopPath()`
  把路径送进 `ctx.fs`，要求
  `processPath(await resolve(processPathFromHostPath(p))) === p`，而 `dsh-fs-local` 的
  targetKey 落的是 **`realpath()`** —— 也就是说**含未展开符号链接的路径一定过不了**。
  ⇒ Knit 这一侧自己先展开：宿主新增 `hostPathOf()`，下发的 `hostRoot`（工作区根）与
  每条记录的 `path`（文件本身）都已是 canonical 形态；客户端**打开 / 定位一律用它们**，
  `root` 只留给界面显示（用户看到的是自己选的那条路径）。
  `scan()` 内部也改成从 canonical 根走一遍，所以 `rel` 一字不变 ——
  检索 / Context Pack / 生命周期 / Usage Lens 的输入完全没动。
- **文档同步**：`knit/README.md` 补上代码档与「网页预览」两处说明、测试数刷成 588；
  **`knit/README.en.md` 这次也补了一节 v0.19**（它同样进 npm 包 —— 英文 README 停在 v0.18，
  包内文档就自相矛盾了）；`knit/SECURITY.md` 属性表加一行「`/knit/api/doc` 只放行文本类产物」；
  `package.json` 的 keywords 去掉了重复的 `code-context`。

### 一处刻意的收窄（引用图）

引用图（`md` 文件之间互相指路的那些边）的**源永远是 Markdown**：代码文件不再进图的
`list`。理由是不能给代码开一条靠「注释里恰好写了一句 `docs/X.md`」就进 Supporting 的
后门 —— 那条路不打分。反过来，**文档点名一个代码文件**（设计文档里写了 `src/x.js`）仍然
和文档指文档一样会被尊重：那不是特例，是同一条规则。
（代码作为「被指向的一方」能进 Supporting，正是需求 §18 要的混合竞争。）

### 为什么不需要改 DSH 核心 / 新增 model tool / 新增 Store

- **不改 DSH**：DSH 的文件访问走宿主已有的 `ctx.fs` 缝；预览走面板里已有的那块预览区。
  代码与文档走的是同一个资源身份、同一个读取接口 —— 没有自造 OS 路径、没有
  `window.open(local file)`、没有 fork DSH 的 preview 实现（代码预览一共就 4 条 CSS 规则）。
- **不新增 model tool**：`knit_docs` 工具本身没变，只是它现在能把代码算进同一个 Context Pack。
  工具描述从「Markdown 文档」改成「文档与代码文件」，理由很直接：语料里已经有 `.ts` 了，
  再说「Markdown documents」就是对模型说假话。
- **不新增 Store**：没有 `codeStore` / `codeContextStore` / `codeRetrievalStore` /
  `workspaceArtifactStore`。代码只是一个多出来的 `artifact.kind`，通过既有状态投影出 UI。
- **不新建 benchmark framework**：V0.19 的前后对比直接扩在 `test/eval/fixture.mjs` 里 ——
  同一个 `runEval`，同一个 `rankByRelevance`，只把语料换成「Markdown only」与
  「Markdown + Code」两臂。

### 测试
- `npm test`：**588 / 588 通过**（v0.18 是 532）。v0.18 的 532 条**一条没删、一条没放宽**；
  中间有 12 条 v0.18 断言因为契约变化而**同步**（不是降级）：
  `readDocument` 的「拒绝非 Markdown」拆成「拒绝不可预览的类型」+「v0.19 起代码可读并带分类结论」；
  类型档从 3 个按钮改成 4 个；`knit_docs` 的文案与两处总数（样本工作区里的 `package.json`
  现在是一个合法代码候选 —— 那个 `3 → 4` 本身就是「代码真的进了同一个检索池」的证据）。
- 新增 **`test/classification.test.mjs`（12 条）**：17 个支持后缀的 language 映射、
  13 个不支持后缀、`.map`/min/generated/lock、锁文件与生成产物的**反例**
  （`minify.js` / `bundle.js` / `tsconfig.json` 仍是代码）、判定顺序是契约、
  以及「后缀知识只许活在分类层」的架构守卫。
- 新增 **`test/code-context.test.mjs`（25 条）**：代码穿过整条链路之后还对不对 ——
  字段权重的三档可观测、代码进 Primary 的理由码是 `filenameMatch`、
  只命中目录走 `pathMatch`、混合包里文档与代码公平竞争、条目投影与 v0.18 逐字相同、
  引用图代码只能当靶不能当源、代码 read evidence 与包外读取、历史归因冻结、
  代码四态生命周期、Epoch 的进入 / 离开 / 换层 / delta、七条噪声路径一条不进候选。
- `test/eval.test.mjs` 新增 **6 条 v0.19 基准守卫**（见下）。
- **发布前补的 3 条符号链接守卫**（`585 → 588`）：`test/host.test.mjs` 造一条指向样本工作区的
  符号链接当 `root`，断言「下发的 `hostRoot` / 每条 `path` 都满足 `realpath(p) === p`」
  （这**就是** DSH 的判据）+「换成符号链接后 `rel` 集合一字不差」；
  `test/path.test.mjs` 两条客户端守卫，分别覆盖「宿主给了 canonical `path`」与
  「老宿主只有 `hostRoot`」时，reveal / 本地打开 / 打开工作区目录**都用 canonical 路径**，
  而界面显示的仍是会话原本那条。写完全部做过**证伪**（把修复回滚，3 条如实变红）。
- `test/client.test.mjs` 新增 **9 条 v0.19 UI 守卫**：代码档请求 `kind=code` 且代码行带语言徽章、
  文档行一个徽章都不加（整列都是 MD，挂 MD 是纯噪声）、点代码行就地出行号 + 正文且**不落到
  Markdown 渲染**（夹具正文故意以 `#` 开头 —— 走错分支它就会变成标题）、同名 `.map` 才给
  「Source map」入口且列表里始终没有 `.map` 那一行、「全部」档三区（文档 / 代码 / 媒体）
  各自限流、Usage Lens 里的代码路径照常显示（仍是只有事实、没有分数）、
  全屏隐藏名单必须覆盖列表上方每一块（含 `.knit-usage`）、**「网页预览」只有 HTML 出场
  且走的是双击那条 `openResource` 通道（正文读到之前按钮就已在场 —— 否则头会长高一下）**，
  以及一条样式守卫（横向滚动只归正文列，语言徽章无底色无边框无圆角，DSH 令牌必须带回落值）。

### 基准（V0.19 前后对比）

同一个排序器、同一批用例，**唯一变量是语料里有没有代码**：

| 指标 | Markdown only | Markdown + Code |
| --- | --- | --- |
| Document Recall (top-1) | 100% | **100%** |
| Document MRR | 1.000 | **1.000** |
| Code Recall (top-1) | 0% | **100%** |
| Code MRR | 0.000 | **1.000** |

- **Overall MRR（文档 + 代码一起量：21 条文档用例 + 3 条代码用例）= 1.000**，top-1 100%。
  语料规模：Markdown only 16 条 → Markdown + Code 24 条（**只多 8 条代码**）。
- **Noise Rate = 0%** —— 7 条生成 / 噪声路径（`node_modules/foo.js`、`dist/app.js`、
  `coverage/report.js`、`app.min.js`、`bundle.generated.js`、`app.js.map`、`package-lock.json`）
  在真实扫描与评测语料里都是 0 条进入。
- 对照臂：同样三条代码用例放在**只有文档**的语料里 top-1 是 0% —— 所以「加了代码之后答对了」
  不是碰巧。混合场景（Case C）里那篇讲分层的设计文档仍排在第 3 名，**没有被代码挤没**。
- ⚠️ 说清楚这份基准**不是难度竞赛**：三条代码用例的检索意图都很清晰，两臂都接近满分。
  它的作用是**回归钉** —— 谁把代码候选、噪声过滤、字段权重或 corpus cap 改坏了，这里会红。
  `node knit/tools/scale-benchmark.mjs` 会把这张表连同原有 20/60/180/540 规模基准一起打印。
- 真机工作区量到的数（`08_Knit`，扫描 4 ms）：59 文档 + **54 代码** + 6 媒体，
  0 generated / 10 ignored，语料 59 → 113。一个 1300+ 目录的大树（55 ms）：
  400 文档截断 + 300 代码（243 条被 cap 挡下）+ 400 媒体，语料 400 → 700 ——
  `MAX_CODE = 300` 在这里正好起到「别让代码把原有 Markdown 上下文挤出去」的作用。

> ✅ **2026-10-07 已发布**：`v0.19.0` = 轻量 tag = npm `gitHead` = `22ab1346f1b8e145ae0940490af13bca02d9ab08`
> · npm `latest = 0.19.0` · **46 文件 / 486.8 kB 打包 / 1.4 MB 解包** / shasum `7f67559d005fcf19405a96ab459d7aac6515a99f`。
> （本地 `npm pack --dry-run` 报的是 479.8 kB / `291a9150…`；两个 tarball 的**文件清单与解包内容逐字一致**，
> 差的只是 tar/gzip 框架元数据 —— 与 v0.17 / v0.18 同一现象。）由 **npm 可信发布（Trusted Publisher / OIDC）**
> 经 GitHub Actions 发出（带 provenance，`predicateType` = `https://slsa.dev/provenance/v1`），不设 `NODE_AUTH_TOKEN`。
> GitHub Release 正文直接切自本节（184 行 / 16 858 字节），没有另写一份。
> ⚠️ **这一行是发布之后补的，所以它不在已发布的 tarball 里** —— 包内那份 CHANGELOG 读到上一段为止
> （节首刻意写成发布前后都成立的说法，所以包内那份不自相矛盾）。逐条核对见 `03_发布/发布清单-v0.19.0.md` §四。

## [0.18.0] - 2026-10-06

> ✅ **2026-10-06 已发布**：`v0.18.0` = 轻量 tag = npm `gitHead` = `170ee8f` · npm `latest = 0.18.0`
> · **43 文件 / 428.7 kB 打包 / 1.3 MB 解包** / shasum `457e7842dda936fcadf671d3d490b7ea28de5629`。
> （本地 `npm pack --dry-run` 报的是 422.4 kB / `92a4ce9e…`；两个 tarball 的**文件清单与解包内容逐字一致**，
> 差的只是 tar/gzip 框架元数据 —— 与 v0.17 同一现象。）由 **npm 可信发布（Trusted Publisher / OIDC）**
> 经 GitHub Actions 发出（带 provenance），不设 `NODE_AUTH_TOKEN`。
> 纯客户端重构：宿主（`src/host/*`）**一行未改**，v0.17 的 517 条测试照旧通过。
> ℹ️ v0.16 / v0.17 的坑是「包内这份 CHANGELOG 的对应行还写着 🚧 尚未发布」；**本版节首写成发布前后都成立
> 的说法**，包内那份读起来不自相矛盾。改这一行的提交仍在 publish 之后，**同一版本号不能再发一次**。
> tag / `gitHead` / `dist-tags` / 解包自测的逐条结果见 `03_发布/发布清单-v0.18.0.md` §四。

**Context Usage Lens（依据 2026-10-05 用户给的 V0.18 规格）**：
v0.17 的「使用情况」是一行统计文字 + 三块折叠列表 —— 信息都在，但**读不出结构**：
哪一层读得多、最近读的是哪一篇、包外那二十篇里哪几篇被反复读、这次变化是进是出。
这一版把它重做成文档列表**上方**的一块轻量观察层 —— 不是弹窗、不是新页面、不是 Dashboard：

```
使用情况                                     Epoch 5 ˄
335 次读取 · 29 篇包外 · 上下文变化 1 次
当前上下文
  主要  1 / 1         辅助  2 / 3         相关  0 / 5
  ●                   ● ○                 ○ ○ ○ ○ ○
最近读取   docs/eval.md                    12分钟前  ›
上下文外读取                                     20  ›
上下文变化                                 最近一次  ›
```

展开包外 / 变化那两行之后（菜单式，`›` 变 `⌃`）：

```
上下文外读取                                     20  ⌃
  01  docs/old-plan.md                  ×3  已读
  02  docs/test-case.md                 ×1  已读
  还有 10 篇
上下文变化                                 最近一次  ⌃
  进入
  + docs/algo.md
  换层
  ↔ docs/eval.md · 辅助 → 相关
```

**没有分数、没有百分比、没有进度条、没有图表、没有新 Store、没有新采集**：
数据全部来自 v0.17 已有的 `usage.lifecycle / recentRead / outsideDocs / latestDelta` 与
`context` 的三层 rels，Coverage 是**派生**出来的（`coverageOf`）。

### 变化
- 新增 **Context Coverage**：主要 / 辅助 / 相关三层各给「状态点 + `已读数 / 本层总数`」，
  点某一层 → 滚到那一层并**短暂高亮**（`data-knit-tier` + `.flash`，1200ms 自己收掉）。
  Primary 不存在时整列不显示（**不画 `0 / 0` 的假层**）；没有进度条、没有百分比。
- 文档行新增**行内生命周期 glyph**：未读 `○` / 已读 `●` / 读后已更新 `△` / 修改后已重新读取 `↻`
  （形态在「UI 迭代」一节里改成 **6px 真圆点**，只有 `↻` 还是字符；四态靠 `data-mark` 区分）。
  glyph 与原来那行文字**同时**存在（glyph 说状态，文字说次数 `×3`）。glyph 是真 `button`，
  带 `title` / `aria-label`，点它＝打开 / 选中这一篇（**已经打开则保持原预览**）。
  统计**关掉**时这一格退回 v0.17 的 Primary 黑点 —— 与 v0.17 逐字一致。
- 最近读取从「一行文字」改成**一行可点的事实**（`文件名 · 相对时间 ›`），点它直接打开该篇，
  点的那一下**不敲宿主**（走已有的 `requestPreview`）。语义仍是「**最近一次成功 read**」，
  没有改成「正在阅读 / Agent 正在查看」。
- 上下文外读取改成可浏览集合：默认最多 10 篇 + 「还有 N 篇」，每行是可点对象并带生命周期；
  排序改成 **`count DESC`**（同次数再按 `lastReadAt` / `seq`）—— 这是**事实排序**，不是相关度评分。
  ⚠️ 宿主给的顺序是「首次读的先后」（`outsideDocsOf` 按 `seq` 升序），所以排序发生在客户端纯函数
  `groupOutsideDocs` 里，宿主不改。
- 上下文变化：默认只给一条菜单行（`上下文变化　最近一次 ›`，UI 迭代后条数不再写在按钮上），
  展开后按 **进入 / 离开 / 换层** 分三组，
  每组最多 5 条（沿用 v0.17 规则）。
- 顺手修掉一个潜在 bug：`moved` 的**真实载荷是 `{tier, rank}`**（v0.17 新增的宿主形状），
  v0.17 的渲染直接把它当层名用 —— 真机上会渲染出空层名（`↔ x.md ·  →`）。现在两种载荷都认。
- Lens 自己可以展开 / 收起（`.knit-lens-head`，`aria-expanded`）。
  **收起 ≠ 关掉统计**：收起只收起细节，标题 / Epoch / 摘要仍在；关掉才一个统计 DOM 都不产生。
- 面板矮（< `COMPACT_PANEL_PX` = 420px）时降级：不铺变化摘要，其余照旧。
  滚动**仍然只交给 `.knit-list`** —— Lens 自己不滚动、**没有第二个滚动容器**。
- 新增纯函数 `coverageOf` / `groupOutsideDocs` / `groupDelta` / `lifeStatusOf`（能派生就不存储）。
- 验收取证时（2026-10-05）拿**真实会话载荷**跑了一次渲染，抓到三处「同一份事实讲两遍 /
  讲不齐」，在发布前修掉 —— 都不是新功能，是这一版自己的渲染问题：
  - 上下文变化**展开**后，折叠时那三行摘要 + 「还有 N 条」还在，后面又接了一遍分组明细
    （同一批进出/换层条目出现两次）。现在展开就只渲染分组那一份（`deltaOpen ? null : …`）。
  - 包外读取的行里次数说了两遍：`.knit-out-count` 已经是 `×71`，生命周期又用短次数说了一遍
    → 真机渲染成 `client.js ×71 ×71`。新增 `lifeWord()`：**次数已经在同一行时只用状态词**
    （`… ×71 已读`），次数是这一档的排序键，必须留着；文档行的 `● ×3` 不受影响。
  - 反过来的一处**讲不齐**：`任务上下文已更新` 只进了折叠摘要，展开后不见了 ——
    可是当时按钮上的数字（`上下文变化 · N`）算上了它，于是「说 6 条、只列 5 行」。
    现在展开时它也照常列一行（它在摘要里本来就是最后一条）。
- 顺手补了两条**英文渲染**守卫：v0.18 之前那条「英文整棵树里一个汉字都没有」用的是
  没有 `usage` 的语料 ⇒ **Lens 整块没进渲染树**，几十条新文案（含 `title` / `aria-label`）
  其实不在覆盖里。现在英文下把 Lens 真的打开、把两块折叠集合也点开再查一遍（空态另有一条）。
- 发布前又拿同一份真实载荷做了一次**不变式对账**（14 条：摘要 / Epoch / Coverage / 展开行数与唯一性 /
  折叠尾巴 / 包外计数 / 四态同屏 / 无百分比与评分 / 不自己滚动）⇒ **14/14 通过**，
  并把它里最通用的一条（**展开后列出的行 + 每条组内尾巴里的数字，必须等于载荷算出的总数**）立成了守卫，
  这样上面那处「讲不齐」不会再从别的分支回来。
- 变化按钮上不再写条数（`上下文变化 · N` → `上下文变化　最近一次 ›`），账目改由
  **展开后的行 + 尾巴**承担 —— 这样「说 N 条」与「列了几行」不可能再不一致。

### v0.18 UI 迭代（2026-10-06）

> 依据：用户给的 `02_方案与 Demo/dsh-knit V0.18 UI 重构开发提示词.md` + 同名 Demo HTML。
> 只动客户端外观（`src/client/client.js` 的 CSS / JSX / i18n 与对应测试），宿主一行未改；
> 功能、数据来源、DOM 的**语义**都不变 —— 这是把 v0.18 的 Lens 从「能用」改到「好看」。

- **字体尺度收成一套**：15（Usage 标题）/ 14（文档标题、Tabs）/ 13（Segmented、过滤框、
  「当前上下文」分节标题）/ 12（摘要行、Coverage 层名与数字、最近读取）/ 11（生命周期、时间、
  包外与变化的行）—— 不再有 10.5px / 11.5px 这类半档。
- **控件尺寸与描边**：`使用情况` / `刷新` 24px→**28px**（radius 8px）；Segmented 与过滤框
  22px / 24px → **28px**、radius 10px、字号 13px —— 原来那两个「迷你胶囊」是这一版最显眼的审美缺口。
  Segmented 内部只保留控件自己的边框；Tab 下划线仍是 2px。
  （提示词文档写的是 36px；2026-10-06 用户看了真机后定成 28px：「太高了，不需要这么高」。）
  这两个控件的**描边色改用 `--dsw-alias-border-l3`** —— 与 DSH 主区「对话」页签下面那条横线
  （官方 header 的 `border-bottom`，浅色 `rgba(0,0,0,.12)`）同一档；原来的 `l4` 重一档，
  摆在页签下面像两个输入框把内容框住了（2026-10-06 用户要求「跟那条横一样」）。
  描边**粗细也跟那条横对齐：0.5px**（官方那条本身就是 `.5px`；2026-10-06 用户第二轮要求
  「描边色值修改成 0.5px」）。色对上了粗细没对上，高分屏上会比旁边那条横粗一倍 —— 三处
  （Segmented 外框、内部竖线、过滤框）一起 0.5px，有守卫不许只改其中一处。
- **类型页签文案「图片与视频」→「媒体」**（2026-10-06 用户定；英文 `Images & video` → `Media`）：
  同一档的计数本来就是 `{n} 个媒体` / `{n} media`，页签是唯一的例外；「多媒体」暗示音频，
  而这一档只扫图片与视频；含义由空态兜住（`list.emptyMedia` = 这个工作区里还没有图片或视频。）。
  一个 i18n 键 `kind.media` 同时供页签与「全部」档的分区标题 ⇒ 改一处即两处，有守卫钉着。
- **状态点统一成 6px 真圆**：Coverage 的空心 / 实心点与文档行左侧的生命周期点
  **同一套 token、同一个直径**（未读 = 透明 + 1px `label-caption` 边框，已读 = 同色填充，
  读后已更新 = 实心 + 内圈，修改后已重新读取 = `↻` 字符）。没有任何绿 / 红 / 黄 / 蓝。
  （文档写 9px，2026-10-06 用户定成 6px；守卫改为**比对两处直径**，不再各写各的。）
- **两处折叠集合改成菜单行**：`上下文外读取　　20　›` 与 `上下文变化　　最近一次　›`
  （label 左、数量 / 说明右、`›` 展开变 `⌃`），行高 38px、hover 只改背景、无位移；
  包外明细每行带 `01` / `02` 序号。**条数不再写在变化按钮上**（见上）。
- **定位手感**：点 Coverage 某层 → 平滑滚到**视口中部**（`block: 'center'`），高亮 **1200ms**
  （原 900ms → 650ms → 2026-10-06 用户看真机后定成 1200ms）；`prefers-reduced-motion: reduce`
  下改为瞬时滚动、所有新过渡 `none`。⚠️ `FLASH_MS` 与 `.knit-tier{transition:background 1.2s}`
  **必须同一个数**（有守卫；只改一个不会报错，只会看见「高亮已取消、背景还在慢慢褪」的错帧）。
- **窄侧栏不撑破**：Coverage 三列改成 `minmax(0, …)` 轨道，层名超长时省略号截断。
- **没做**（提示词文档明确禁止或与既有设计冲突）：没有卡片化、没有阴影、没有上浮 / 缩放 /
  连续脉冲、没有新滚动容器、没有新增数据、没有新模型或网络请求。
- **与 Demo 不一致的三处，按提示词文档办**：① Demo 给 Coverage 组画了淡底 + 1px 边框 +
  hover `translateY(-1px)`，文档要求「默认不要 border、hover 最多很淡背景、不许 translate」；
  ② Demo 有可见的「未读 / N 篇已读」帮助行，文档要求那句只给读屏（现在只在 `aria-label` 里）；
  ③ Demo 的 Usage 块有全宽 `border-bottom`，文档要求 Usage 内部不画全宽线。三处都听文档。

### 测试
- `npm test`：**532 / 532 通过**（v0.17 是 517）。新增 15 条 v0.18 守卫：
  Coverage 三层数值与「点它定位到那一层」、Primary 缺席不画假层、Lens 收起、空使用情况、
  小高度面板的降级判据、点状态点 / 包外行不直接请求列表、轮询不重播动画、
  样式（语义 token / 自己不滚动 / `prefers-reduced-motion`）、纯函数层、
  以及英文 Lens（打开态 / 空态）里没有汉字（文字 + 属性）。
- 一条**账目**守卫（刻意给 8 条换层以跨过组内上限）：载荷算出的总数必须等于
  「展开后列出的行数 + 每条组内尾巴里写的数字」—— 证伪过（把那一行改回 `false && …` 会有 3 条变红）。
- 宿主侧一行未改：v0.17 的 517 条全部照旧通过。

## [0.17.0] - 2026-10-03

> ✅ **2026-10-05 已发布**：`v0.17.0` = 轻量 tag = npm `gitHead` = `4d0c74e` · npm `latest = 0.17.0`
> · **43 文件 / 394.6 kB 打包 / 1.2 MB 解包** / shasum `33bf6faac4de75170e2378ff9096dd4cdb1da81a`。
> 由 **npm 可信发布（Trusted Publisher / OIDC）** 经 GitHub Actions 发出（带 provenance），不再用 token。
> ⚠️ **包内这份 CHANGELOG 里对应的那两行仍写着「🚧 尚未发布」** —— 本次改它的提交在 publish 之后，
> **同一版本号不能再发一次**（与 v0.16 同一个坑）。

**Document Lifecycle（依据 `01_ Knit PRD/Knit-PRD-SDD-v0.17-Document-Lifecycle.md`）**：
前面几版回答的是「Knit 推荐了什么 → Agent 有没有读 → 读落在哪一层」；
这一版接着回答**一篇文档读完之后，现在处于什么状态**。
只做四件事：文档状态、最近读取、包外读取的明细、最近一次 Context Delta。
检索侧一行没改（BM25 / IDF / 关键词抽取 / 长度归一化 / freshness / 分层 / Context Pack 装配规则一个字没动），
**没有分数、没有百分比、没有进度条、没有时间线、没有新面板、没有第二份存储**。

### 新增：四个事实状态

| 状态（数据层） | 界面文案 | 判据 |
|---|---|---|
| `unread` | 未读 | 本会话没有一次成功 `read` |
| `read` | 已读 / 已读 ×N | 有过成功 `read`，且最后一次成功读取之后文件版本标记没变 |
| `updated_after_read` | 读后已更新 | 最后一次成功读取之后，文件的 `mtimeMs` 变过 |
| `reread_after_update` | 修改后已重新读取 | 变过之后又成功读过一次；再变一次就退回上一档 |

判据复用现有工作区扫描拿到的 `mtimeMs`：`src/host/index.js` 里的 `mtimeOf(root, rel)` 做一次 `statSync`，
在 `tool/call` 那一刻把结果交给 `ingestEvents(..., { stat })`，`feedback.js` 自己不碰 I/O。
**不引入内容哈希、不扫描全文、不新增索引、不落盘。**

事实就是事实，不做推断：状态只说「文件在上次成功读取之后变过 / 变过之后又读过」，
不写「Agent 还不知道最新版」「Agent 没看到你的修改」这类话（测试里钉死了这些词不出现）。
`grep` / `glob` / `bash` 不算 `read`；失败的 `read` 不算；拿不到当前 `mtimeMs` 或没记过
`lastReadMtimeMs` 时**不下结论**（宁可停在 `read`）；文件只是被重新扫描过，不等于被重新读过。

### 新增：最近读取 / 包外明细 / 最近一次变化

- **最近读取：`<rel>` · <相对时间>** —— 最近一次**成功 `read`** 对应的文件，按事件 `seq` 判定「谁最近」，
  墙钟只负责显示相对时间；它落在 Context Pack 之外也照实显示。
  **不叫「正在阅读」**：Knit 无法证明 Agent 此刻还在读这篇。
- **上下文外读取 · N 篇**（可展开）—— 原来只有一个数字，现在点得开、看得到是哪几篇，
  每行给 `rel` 和该篇的状态。只表达「这篇不在当前 Context Pack，但 Agent 确实成功读过它」；
  不写「Knit 漏掉了 / 推荐错了」，也不做漏召回率、命中率、Context 质量。
- **上下文刚刚变化**（只展示**最近一次** Delta）—— `+` 进入 / `-` 离开 / `↔` 换层（层名用短名），
  折叠时最多三行，展开按「进入 / 离开 / 换层」分组；`taskChanged` 只说一句「任务上下文已更新」。
  不产出时间线，也不做事件浏览器。

### 数据层：扩现有 store，不加第二套

`src/host/feedback.js` 新增三个纯函数（`lifecycleOf(entry, mtimeMs)` / `latestReadOf(reads)` /
`outsideDocsOf(reads, items)`），`recordRead()` 每篇多冻三个标量
（`lastReadMtimeMs` / `prevReadMtimeMs` / `rereadAfterChange`）；
`usageFrom(state, { mtimes })` 的返回值**顶层**多四个字段
（`lifecycle` / `recentRead` / `outsideDocs` / `latestDelta`），v0.16 的 `stats` 15 个键一个没动。
`/api/recent?usage=1` 用工作区扫描的全量列表（未截断）算 `mtimeMs`，
只回传当前文档列表 + 包外文档的状态行，每篇三字段（`status` / `count` / `lastReadAt`）。

历史归因继续冻结：`tier` / `rank` / `inside` / `epochId` 仍是**读发生时**那一份 Context 的结算值，
不会因为「现在」换了包而改口（v0.16 的行为原样保留）。

`knit_docs` 工具的**输出没有变**：它仍然只负责「找上下文」，不输出生命周期报告
（工具描述与工具结果都要吃模型上下文，这一版的主要消费者是人）。

### 修订（真机验收）：闸门开晚也要说真话

验收时暴露一个来回：先让 Agent 读了一篇文档、**之后**才打开使用情况开关 —— 那两次读发生在订阅
回调开始按会话早退之前，事件根本没进过内存，于是面板把一篇**确实已经读过**的文档显示成「未读」。
那不是解析错误，是**没有证据**：闸门打开之前，Knit 一条读都没看见，却对「未读」下了断言。

修订：闸门打开的那一刻，宿主**回填一次**本会话已有的事件（`src/host/index.js` 的
`backfillFeedback()`，由 `activateFeedback()` 在面板与工具两条开闸路径上调用；一个会话只回填一次、
只在当前这一 tick，零 I/O、零网络、零模型）。**顺序是这个机制的组成部分**：先把手上那份 Context Pack
`noteSnapshot()` 记下、**再**喂事件 —— `recordRead()` 在事件入库那一刻就把归因冻结，先喂事件的话，
补记的读会在「一份快照都还没有」的状态下被判成包外，而「这篇不在当时的上下文里」是一句我们并不知道
真假的话（§6）。回填那次不传 `at`，于是这份「会话开头」快照的 `at` 仍是 0，第一次 `usage.at` 的语义
（还没有上一份包）不变。`session.snapshotEvents()` 的 deprecated 提示仍然有效：这是**闸门打开那一刻的
唯一例外**。

已知不精确，写在明面上：回填的读按**我们已知最早的那份包**归因，更早的包 Knit 无从得知。

### 界面

- 文档行在标题与时间之间多一个弱化状态文字，只在**使用情况打开 + 分层视图**里出现；
  标题仍是视觉主体，状态不用红绿、不加重、不给分。
- 使用情况那一行下面多三块极轻的东西：最近读取、`上下文外读取 · N 篇`（可展开）、`上下文刚刚变化`（可展开）；
  折叠状态存在组件本地，不写进偏好。既有的「使用情况」行一个字没改。
- **使用情况默认关**：关着时 `usage=1` 不发、宿主不初始化生命周期、DOM 里**零新增节点**（测试钉死）。

### 新增：列表进出动效（2026-10-03 用户拍板）

验收时用户提的：「新读取跟挤掉旧的未读的，这里的交互可能要优化，因为现在是一闪一闪的，就非常的快…
从当前的、如辅助上下文中新增，它应该是从低向上的…消失的时候从上到下，渐隐掉」。做的还是同一件事，
只是把它**看得见**：一行文档被读到、换了层、被挤出列表时，不再是「瞬间落位」。

- **进来**：从下方 26px 处淡入上浮（高度 0 → 量出来的自然高度、`blur(3px)` 收敛到 0）；
  同一拍里多篇按屏幕顺序错开 45ms，**最多错 6 档**（一次涌进十几篇时不排长队）。
- **出去**：先把自然高度量下来，再把高度收到 0、**自上而下**擦除
  （`clip-path: inset(T 0 0 0)`，T 从 0 到 100%）并渐隐；这一行留在列表里把动画播完才移除，
  否则看起来像「跳到末尾才消失」。它插回的位置由上一帧的 `index` 决定（`mergeGhostRows()`）。
- **换层 / 重排**：走 **FLIP**（同一篇 `rel` 在新旧两帧都在 ⇒ 既不算进入也不算离开，
  交给位置补间）。这一行的节点在跨分区时会被 React 重建，所以位置按 **`rel`** 记，
  老节点量到的矩形照样能用在新节点上：先把它从老位置拉回来（`transform: translate(dx, dy)`）
  再补到归位（340ms），于是「从包外升进 Primary」看起来是**飞上去的**，不是瞬移。
  它跑在提交之后、绘制之前的 layout effect 里，且在 `DocRow` 的进 / 出补间**之后**
  （React 是子先父后）：那一刻新行已经是 0 高、幽灵行还占着原高度，所以量到的位移只剩
  「真的挪了位置」的行，不会和进 / 出补间算两遍；正在进 / 出的行直接跳过。
  位移小于 0.5px（含浏览器缩放 / 滚动的亚像素抖动）算没动过，否则整屏会一直在微微地飘。
- **什么时候不播**：首屏、换类型 / 换排序 / 搜索词变了（那是「换屏」、不是「来了新的」），
  以及系统开了「减弱动态效果」（`prefers-reduced-motion: reduce`，连底色过渡一起去掉）。

两条硬约束：**补间在 JS 里走 WAAPI（`Element.animate`），CSS 里只有两笔静态规则**
（`.knit-doc.leaving` 与减弱动态效果那条媒体查询）—— 高度必须按量出来的自然高度补间，
写几个 `@keyframes` 会在动画收尾的瞬间跳一行间距。`motionAllowed()` 在没有 `document`、
没有 `Element.prototype.animate`、或系统要求减弱动态效果时返回假，于是宿主进程与测试进程里
**一行补间都不排、也不造幽灵行**：渲染树与没有这段动效时逐字一致
（`planRowMotion()` / `mergeGhostRows()` 都是纯函数，测试直接喂数据）。

### 测试

- 新增 `test/document-lifecycle.test.mjs`（24 例）：四档状态、缺 mtime 不下结论、失败 `read` 不计、
  `grep` / `glob` / `bash` 不计、按 `seq` 判最近读取、包外明细与排序、历史归因不漂移、
  同一事件重复派发幂等（`count` 只 +1，且不重采样 mtime）；另有 4 例钉住**开闸回填**
  （补记的读归「会话开头那份包」⇒ 不再被误判成包外、只影响第一份快照、重复派发仍幂等）。
- `test/host-http.test.mjs` 多 3 例端到端：`usage` 顶层新字段与 `stats` 形状不变；
  **真改盘上 mtime** ⇒ 读后已更新，再读一次 ⇒ 修改后已重新读取；
  面板开晚的会话在开闸那一刻**回填**已有的成功读（`reads=1`、`firstReadTier='primary'`、`outside=0`），
  且一个会话只回填一次（再请求一次仍是 1）。
- `test/client.test.mjs` 多 19 例：四档渲染、标题 / 状态 / 时间顺序、最近读取的相对时间、
  包外折叠与展开、Delta 摘要与分组、溢出与 `taskChanged`、只用语义 token、英文环境无汉字；
  关着时零新增节点；另有 7 例钉住**进出动效**只在真机上播 —— 首帧与「换屏」都不播、
  交错按屏幕顺序且封顶、离开的行带着原有的区与位次、同一篇换层既不算进也不算出、
  幽灵行插回原位（含「还活着的不造幽灵」与「别的区不插」）、Node 里恒被 `motionAllowed()` 挡掉、
  CSS 里没有 `@keyframes`（只有 `.knit-doc.leaving` 与减弱动态效果那条媒体查询）；
  另有 3 例钉住**换层 / 重排的 FLIP** —— 位移的正负与阈值（亚像素抖动不算动）、
  给挪过位置的幸存行排一段 `translate(dx,dy) → 0`（进 / 出的行跳过、位置表跨帧传递、
  节点不认 WAAPI 时只记位置不抛错），以及那行 `applyRowFlips(...)` 确实接在提交之后。
- `test/i18n.test.mjs` 多 1 例：16 条新文案中英逐条对齐，且状态文案里不出现推断词。
- `npm test`：**517/517 通过**（v0.16 是 468，新增用例 49 条）。

### 修好：交互审的两处「列表自己跳」（2026-10-04）

**用户报了两件事**：①「我选中一个文档查看全文，特别是在最下方的文档，相关联文档，我一点它就跳，
我一点它就很跳，闪的很快」；②「我刚刚重启 DeepseekHarness，我没有输入任何的对话……
我们的文档列表就开始跳动，它怎么能够切换呢」。**先按数据查**：同一会话连续打 5 次
`/knit/api/recent` 返回逐字一致 ⇒ 服务端不抖，四个根因全在**客户端几何 / 时序**：

| 症状 | 根因 | 修法 |
|---|---|---|
| 点一下就跳 | 预览面板用 `maxHeight: 46%` ⇒ 面板高度由**内容**决定（「加载中」→正文、预览里换一篇都变高矮） | 打开期间高度**固定**成拖出来的比例；长文在正文区里滚，短文档下方留白是代价 |
| 整屏乱飘 | FLIP 拿 `getBoundingClientRect()`（**视口坐标**）当位置：容器滚动 / 容器变高矮 / 行上 `:hover{transform:translateX(-2px)}` 都凭空造出位移 | 改用**布局坐标** `offsetTop` / `offsetLeft`（`rowLayoutPoint()`） |
| 越补越飘 | 换屏与进 / 出补间**在飞的那几百毫秒里**也照量位置，量到中间态，落地后又被当成「挪了位置」 | 这两种时候**一个都不量**，并把位置表清空 |
| 空会话自己跳 | 「光标跟手滚进视口」的依赖里有 `state.docs`（每 5 秒一个新数组）⇒ 把「刷新到数据」当成「用户按了方向键」，光标默认在第一行，用户往下滚过之后每 5 秒被拽回去一次 | 依赖只剩 `[cursor, query]`，且只在列表自己拿着键盘焦点时才滚 |

四条都在源码注释里逐条写着「为什么」；两条硬规则进了 `AGENTS.md` §6.13，教训进了 §8.12。
测试 515 → **517**（`test/client.test.mjs` 多 2 例：`rowLayoutPoint` 的布局坐标优先与兜底分支、
「刷新不许动列表」= 那条 effect 的依赖里没有 `state.docs`；`test/tier1.test.mjs` 那条预览高度的断言
从 `maxHeight` 改成 `height` + 断言 `maxHeight === undefined`）。

## [0.16.0] - 2026-10-01

> ✅ **2026-10-03 已发布**：`v0.16.0` = `8c3ca2c` · npm `latest = 0.16.0`（42 文件 / 341.8 kB / shasum `771705d6…`）。
> 这一版把上一节那批「未发布」的界面收敛**一起**带上。

**Context Effectiveness（依据 `01_ Knit PRD/SDD-v0.16-Context-Effectiveness.md`）**：
一次读落在哪一层，**在读发生那一刻结算并冻结**；并正式引入 **Context Epoch**。
检索侧一行没改（BM25 / IDF / 分层 / Context Pack 装配规则一个字没动），
**没有分数、没有百分比、没有新面板**。

### 修好：历史归因会被「现在」改口（split-brain）

v0.15 里「这次读落在哪一层」被算了两遍：读入库那一刻算一遍（`recordRead()` → `snapshotAt()`，
冻进 `firstTier`），出报告那一刻又拿**最新**那份快照重算一遍（`usageFrom()`）——
`byTier[].read` / `outside` / `supportingCoverage` / `firstReadTier` 全吃重算值。
于是同一条读可以同时是 `firstTier='primary'` 与 `tier='related'`。真实场景就是：

```
10:00 交 Context A（primary = A.md）→ 10:01 读 A.md → 10:03 换 Context B → 10:04 看 usage
⇒ A.md 被算成「包外」—— 历史被现在改口了。
```

现在只有一条规则，由 `src/host/feedback.js` 的两个纯函数说了算：

| 函数 | 语义 |
|---|---|
| `snapshotAt(snapshots, readSeq)` | 取 `seq <= readSeq` 的**最新**快照 = 读发生时生效的那一份 |
| `attributeRead(snapshot, rel)` | 输出 `{ snapshotSeq, epochId, tierAtRead, rankAtRead, insideAtRead }`，读时冻结 |

`recordRead()` 在读那一刻调它并冻进 `firstRead` / `lastRead`；`usageFrom()` 只读冻结值。
`reads[]` 行上的 `tier` / `rank` / `outside` 也一律是**首读**的归因（不再是「它现在在哪一层」），
旧字段名（`firstTier` / `firstReadAt` / `outsideCount` …）与旧键 `churn.snapshots` 全部保留为兼容别名。

### 修好：右栏收起之后，Knit 还在每 5 秒敲一次宿主

**现象（2026-10-01 用户报）**：一旦点开过文件、再把右栏那一栏关掉或收起来，过一会儿它会变成
**一片空白** —— 没有芯片、没有文字，也没有「这类内容还没有可用的查看方式」。

**查到的**：官方右侧栏收起时**不卸载**标签身体（dockkit 的 `keepMounted`），而 `KnitBody` 的轮询
过去只看「挂载了没有」——于是收起来之后照旧每 5 秒请求一次 `/knit/api/recent`（一次全工作区扫描）
并 `setState`，等于往宿主正在收起 / 展开的那棵子树上又插了一帧重渲染。
实测（headless Chrome 里的真客户端）：收起状态 12 秒里发了 **2 次**请求；那一栏确实还在
`visibility:hidden` 里挂着（`knitVisible.visibility === 'hidden'`、`knitRoot === true`）。

**修法**：用座位契约里现成的 `tab.visible` 做闸门。官方在
`@deepseek-ai/dsh-client-ui-sidebar-right` 里算的是

```js
visible: active && (pane.host === 'float' || layout.expanded && (title || pane.activeTabId === tabId))
```

也就是「收起」与「不是当前标签」两种情况都是 `false`。座位适配层把它传给 `KnitBody`：看不见时
**连请求都不发**，在途的那次回来也不落状态；`visible` 变回 `true` 时那个 effect 会重跑 ⇒
**立刻补一次**，不必等下一个 5 秒。

- 实测（同一台真客户端）：收起 13 秒 **0 次**请求（修前 2 次）；重新展开 7 秒内 **2 次**（立刻 + 5 秒那次）。
- 拿不到 `tab.visible` 时（别的宿主 / 降级路径）**当作看得见**，不会把面板冻住。

### 修好：右侧栏「开始」页出现两行一模一样的入口

**现象（2026-10-01 用户报）**：右侧栏「开始」页上有两行同名胶囊（都是「Knit 最近文档」），
点哪一行都进 Knit。

**查到的**：`dsh-better-sidebar` v0.24.1 起有个「原生表面」——把它自己每个 tab descriptor
镜像成官方右侧栏的一个类型（`id = dsh-better-sidebar:<descriptor.id>`、`kind = descriptor.id`），
并且**在 descriptor 没写 `hidden` 时连带注册一条 guide 条目**：

```js
...descriptor.hidden === true || isEditor ? {} : { guide: [{ id: descriptor.id, order: descriptor.order ?? 100, … }] }
```

于是「开始」页同时挂着 ① 我们自己的类型（`kind: 'knit'`）与镜像（`kind: 'knit:recent'`），
标题都取 `guide.title` ⇒ 两行同名。（并不是 Knit 注册了两次。）

**修法**：给 `ctx.betterSidebar.registerTab` 的 descriptor 加 `hidden: true`。它只掐掉那一条镜像
guide 条目（连带 + 菜单项），镜像的类型 / 座位 / `ctx.betterSidebar.openTab` 都还在；入口保留 ①
那条 —— 不依赖宿主装没装 better-sidebar。

- 实测（真客户端 + 刷新）：修前 5 条胶囊里两条 Knit；修后只剩 `data-sidebar-right-guide-entry="knit"` 一条，
  点它照旧开 `tab8`「Knit」。

### 新增：Context Epoch

- **一份快照 = 一个 Epoch**：`epochId` 从 1 开始，**内容真的换了才 +1**
  （签名 = `task` + 三层 `tier:rank:rel`，与 v0.15 同一套判据）——5 秒轮询不会灌进几十个 Epoch。
- **`usage.epochs[]` 与快照栈同生共死**：每项 `{ epochId, snapshotSeq, topic, task,
  primary/supporting/related: { rel|total, read }, outsideReads, continuedReadsAfterExit, reEntries }`。
  **只供内部 / 离线回放 / 将来的评估** —— v0.16 不把它上任何工具输出。
- 保留上限：`MAX_SNAPSHOTS_PER_SESSION` **2 → 20**、`MAX_DELTAS_PER_SESSION` **20 → 50**。
  归因在读时结算，保留数量只决定「离开 / 重新进入」能回溯多远（**宁可漏记，也不猜**）。
- `churn` 口径：新增 `epochs`（换过几个不同的上下文 = 最后一份的编号），`changes = epochs - 1`；
  客户端在用的 `snapshots` / `deltas` 保留为 `changes` 的别名（文案「上下文换过 N 次」不变）。

### 新增：两个事实字段（只记事实，不加解释）

| 字段 | 判据（只在保留窗口内推导） |
|---|---|
| `continuedReadAfterExit` | 这次读**在当时那份快照之外**，且更早的某份快照里有这篇 |
| `reEntry` | 这次读**在当时那份快照之内**，更早的某份快照里也有，但中间至少有一份没有它 |

⚠️ 它们**不许**被读成「Agent 不认可新上下文」——那是推断，不是事实（SDD §5 Evidence Over Interpretation）。
`firstReadTier` 多一个取值 `'outside'`（读过、但读在包外）；`null` 只留给「一次都还没读」。

### 改法：读证据不再拉会话事件，改成订阅 `session/event`

`session.snapshotEvents()` 已被 DSH 标为 deprecated（`dsh-session/README.md:62`：
"new production calls are prohibited"）。v0.16 把读证据的来源换成宿主事件流：

- `apply(ctx)` 顶部 `ctx.on('session/event', onSessionEvent, { global: true })`；回调首行按 `session.id`
  **早退** —— 没开审计的会话只花一次 Map 查找，不建快照、不统计、不进内存。
- `ingestEvents(store, sessionId, [event], { root })` **单事件**入库；游标幂等不变。
- **两个行为变化**：① 订阅之前发生的事**不再回补**（不碰废弃 API 就读不到历史）——
  打开「使用情况」的那一刻起才开始计数；② fork 出来的会话**不再把父会话继承的读算进自己账上**
  （seed 事件不派发；v0.15 从 `state.seq = -1` 拉全量时会算进去）。

### 界面：只多一句「当前上下文 · Epoch N」

不加 Dashboard、不加图表、不动布局；开关打开后那一行**开头**多一个累计编号，其余逐字不变。

### 量尺

`tools/context-feedback-eval.mjs`：日志文件名改成**按形状认**（`session.v<N>.jsonl[.zstd]`，
v0-v4 三代并存都能读，以前写死 v4）；`metricsFor()` 增 `epochs` / `continuedReadsAfterExit` / `reentries`、
`contextChanges` 改读 `churn.changes`；Control 自检的判据放宽成「不许有**落在层里**的读」
（`'outside'` 在对照组是正常的）。

⚠️ **对齐的是规则，不是数字**：离线量尺与 runtime 共用同一份归因（都调 `feedback.js`），
但**交付时刻**不同 —— 面板轮询 / 工具调用是采样，量尺是「每次读前合成一份包」。
逐字段一致是**规则**级；数字级对齐做不到（SDD §3 G4 已据此改名并写明原因）。

### 测试

- 新增 `test/context-effectiveness.test.mjs`（12 条）：历史归因（§24.3）、离开后仍被读（§24.4）、
  重新进入（§24.5）、**规则一致**（§24.6：runtime 记下的归因逐字段等于 `snapshotAt()` +
  `attributeRead()` 现算的结果）、Epoch 边界与上限。
- `test/context-delta.test.mjs` 里那条钉着 split-brain 的双轨断言（`firstTier='primary'` 与
  `tier='related'` 同时成立）改写成「`tier` 也是首读的归因」。
- `test/host-http.test.mjs` 的「使用情况」整段改成**事件驱动**（假 ctx 收 `session/event` 派发），
  顺带覆盖：订阅前的事件不回补、同一 seq 派发 10 次仍只算一遍、畸形事件不影响接口。
- 测试数：**453 / 453 → 468 / 468**。
- `test/client.test.mjs` 新增 2 条**可见性**用例：`visible === false` 时一次都不取数、也不挂轮询；
  座位契约的 `tab.visible` 一路传到 `KnitBody`（拿不到 `useTabInfo` 时按「看得见」处理）。

## [0.15.1] - 2026-09-30 · 并入 0.16.0

> ⚠️ 这一版**没有单独发布**（未打 tag、未单独 publish），**并进了 v0.16.0**（见上一节）——
> 下面这批界面收敛随 `0.16.0` 一起发出。

**界面收敛 + 一处真机修复**：没有新指标、没有新接口，BM25 一行没改，Context Pack 的装配规则一行没改。

用户看过 v0.15 的真实界面之后提了五处收敛（2026-09-30），共同点是同一条审美主张 ——
**能用空间表达的层级，就别再画线**：

| 改动 | 说明 |
|---|---|
| **排序说明那一行整行删除** | 列表上方 `.knit-topic`（`Sorted by relevance` / `按修改时间倒序`，以及它 `title` 里的命中关键词）**整行删掉**：排序方式已经由「相关 / 最新」切换按钮自己表达，再写一行是重复。随之把 `topic.relevancePlain` / `topic.relevanceTerms` / `topic.needsConversation` / `topic.time` 四个文案键从**两种语言里一并删掉**（不为「以后可能用」留着），客户端那份因此变成死代码的 `topic` state 也清了（初始化 + 三处错误分支 + payload 赋值共 5 处） |
| **类型行不再画全宽底边** | `.knit-types` 的 `border-bottom` 删除 —— 层级只由选中页签自己那条 2px 下划线表达（**那条保留**，用户明确说删的不是它） |
| **列表行不再有描边** | `.knit-doc` 静止态那条 `.5px solid transparent` 占位、悬停与选中各自上的 `border-color` 三处一起删；「正在预览」只剩灰底，灰底成为唯一的分层信号。⚠️ 边框删了要用 `padding:10px 11px → 10.5px 11.5px` **把几何补回来**，否则每行矮 1px、左右各窄 .5px |
| **引用区上下两条细线都删** | 预览头的 `border-bottom: .5px border-l3` 与引用条的 `border-bottom: 1px border-l2` 一起删（38px 头部高度保留，排版不动，只是不画线）。这两条线把「被引用」夹在中间，视觉上割裂 |
| **过滤框提示简化** | `过滤标题 / 摘要 / 路径` → **「过滤文档」**（英文 `Filter title / summary / path` → `Filter docs`）：不列字段清单，字段范围由行为本身说明 |

### 修好：悬停浮层永远显示「0 篇」

真机上对话头部右侧那个 Knit 图标，悬停后浮层只有「**0 篇 / 这个工作区里还没有 Markdown 文档。**」，
可面板里同一个工作区的文档一切正常。根因**不在列表逻辑，而在取「当前会话 id」的方式**：

- 入口按钮坐在 `conversation.session.header.utilities` 这个 **session 作用域**的座位上，框架通过
  **标准 props 直接把当前会话 id 递进来**（`SessionStandardProps.sessionId`，由 `dsh-client-ui-session`
  以 `props: ["sessionId"]` 注入；座位契约也写明「Header actions derive their state from standard Session props」）。
- Knit 从 v0.5.0 起读的却是 `ctx.sessions.list` 快照里的 `snapshot.current` —— **现行契约里没有这个字段**：
  `SessionListState` 只有 `{ ids, byId, phase, projectionsBySession }`，契约注释是
  「navigation belongs to view owners」。⇒ 恒取到空串 ⇒ 每次都走「没有当前会话」分支 ⇒ 空态。

改法：**座位 props 的 `sessionId` 优先**，取不到时才退回老读法（`snapshot.current`，给更老的内核兜底）。
「点浮层里某一篇直接展开它的预览」这条通路一直是好的，只是列表为空时点不到 —— 会话 id 一恢复它就回来了。

⚠️ **测试为什么没拦住**：`test/peek.test.mjs` 的假上下文把 `sessions.list.getSnapshot()` 假成了
`{ current: 's-1' }` —— 一个现行内核里根本不存在的字段，于是 450 条测试全绿、真机上永远是空态。
现在假件照着契约写成 `{ ids, byId, phase, projectionsBySession }`，**当前会话 id 一律走座位 props**，
并新增两条回归用例：① 座位 props 生效（快照里没有 `current` 也要照常拉列表）；② 老内核退回 `current`。

测试侧同步改了钉住这五条的断言，并把**「删除」本身写成防回潮断言** —— 新增一条用例守着：
那三处描边、两条分割线、那一行的类名、四个文案键，**只要回来就红**。
测试数：**453 / 453**（合并两条 i18n 用例、新增一条防回潮用例、上述两条会话 id 回归用例，
再加下面这条「占位标记」用例）。

顺带修掉 `knit/README.md` / `knit/README.en.md` 里两处陈旧数字：`395 项测试` → `450`（v0.15.0 时漏改），
并在目录树里补上 v0.15.0 就存在、却一直没列出的 `src/host/feedback.js`。

### 改动：没序号的行不再把序号那一列空着

「其他相关文档」不在 Context Pack 里，所以按 v0.14 的规矩**不编号** —— 但那一格空着，
读到的不是「对齐」，而是「漏了一个号」（用户 2026-10-01 原话：「其他相关文档…又没有这个序号，
没有序号以后左边就空了，视觉上比较割裂，就觉得是个 bug 一样」）。

- **编号规则不变**：仍然是**跨三档连续**的一条序列（01…0N）。三层是**同一个包的一条阅读顺序**
  （先看 / 辅助 / 背景），不是三个各自排名的清单 —— 所以不改成「每一档各自从 01 开始」。
- **没号的行在同一列渲染一个中性标记 `.knit-gapmark`（·）**：不冒充序号，也不让轨道断掉，
  「所有行左边缘对齐」那条纪律照旧。它和 `.knit-num` **共用同一条 CSS 选择器**，
  于是「序号行高 ＝ 标题行高」这条纪律自动覆盖它（不用再同步第三处数字）。
- ⚠️ **只有这一屏里有号时才渲染**：时间序 / 平铺列表整屏都没号 ⇒ 一个标记都没有。
  刺眼的从来是**混着**（一半有号、一半空着），整屏一致就没人觉得缺东西 —— 这条也有用例守着。

### 改动：预览头路径收敛成「…/文件名」+ 按钮改「本地打开」

用户 2026-10-01 原话：「前面那一串都用三个点点点来表示就行了…我觉得这样就够了。…我是想让右边的空间多一点。
另外右边的在本地打开，我觉得修改成本地打开就行。这样改下来，整个 UI 就变得更加鲜亮了」。

- **目录段不再上屏**：`.knit-preview-dir` 的内容由 `splitRelPath(preview.rel).dir`（整段目录）改成
  **固定占位 `…/`**；`splitRelPath()` 函数本身一行没改（无目录时依旧只渲染文件名）。
  **完整相对路径没丢** —— 它在 `.knit-preview-path` 的 `title` 里（悬停即见），
  路径按钮本身仍然可点、仍然是用系统默认应用打开这篇文档。
- **CSS**：`.knit-preview-dir{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,…)}` —— 不再需要
  `min-width:0` + `overflow:hidden` + `text-overflow:ellipsis` 那套收缩（目录已经不渲染了）。
- **文案**：中文 `'preview.openLocalBtn'`：`在本地打开` → **`本地打开`**（英文 `Open locally` 不动）。
- 测试同步：面包屑用例改成断言目录段文本 === `…/`、整条路径文本 === `…/需求 文档.md`，tooltip 仍带完整
  `sub/需求 文档.md`；`test/path.test.mjs` 里「在本地打开」全部改成「本地打开」。测试数仍 **453 / 453**。

### 改动：悬停浮层删掉页脚「点击打开面板」与它上面那条横线

用户 2026-10-01 原话：「那个文档列表下面不是有"点击打开面板"还有上面那条横线，我觉得都可以删掉，有点多余了」。

- 删掉 `KnitPeek` 末尾那个页脚节点与 `'peek.openPanel'` 两个文案键（中英各一条，别处没有引用）；
- 删掉专门给页脚画线的 `.knit-peek-list + .knit-peek-hint{… border-top: …}` 这条 CSS 规则；
- **保留** `.knit-peek .knit-peek-hint`（空态那句「这个工作区里还没有 Markdown 文档。」仍然在用）。
- 浮层那两条通路（点某一篇直接展开预览、点图标打开面板）一行没动。测试数仍 **453 / 453**。

## [0.15.0] - 2026-09-30

**从「构建一份当前任务上下文」再往前一步：让上下文能回答「它到底有没有被用上」。**
排序（BM25）一行没改，Context Pack 的装配规则一行没改，**没有模型、没有联网、没有长期记忆** ——
这一版加的是**一层可核验的使用反馈**：把 agent 真实读过哪些文件（会话日志里的
`tool/call(name="read")` 与按 `callId` 配对的 `tool/result`）跟「**读发生那一刻**生效的那份
Context Pack」对起来，得到五个计数：**Primary follow-through / First read tier /
Supporting coverage / Outside-context / Delta churn**。**只报事实**：没有分数、没有百分比、
没有评分条、没有置信度。

⚠️ **两条硬边界（别越）**：

1. **默认关。** 只有人显式打开（面板头部「使用情况」开关 → 请求带 `usage=1`，或
   `knit_docs` 传 `audit:true`）才开始记账；没打开时**不读一个事件、不攒一条数据**。
   理由是这笔账有代价（每次轮询都要读一遍会话事件），不该由 Knit 替用户决定。
2. **不重复 DSH Trajectory。** 证据的**唯一来源**是会话里**已经存在**的 `tool/call` /
   `tool/result` 事件（`session.snapshotEvents()`，沿用既有拉取式架构，用 `seq` 做幂等游标）——
   **没有新的事件总线、没有 Runtime Trace、没有 Event Store**；数据只在内核内存里，
   重启即失（不落盘、不进 `localStorage`）。

### 加了什么

| 新增 | 说明 |
|---|---|
| **`src/host/feedback.js`** | Context Snapshot / Context Delta / Usage matching。纯逻辑、只 import `node:path`。`snapshotOf()` 把一份包压成 `{seq, at, topic, task, total, items:[{rel,tier,rank}], sig}`；`diffContext()` 给「进 / 出 / 换层」；`normalizeReadEvidence()` 把真实事件流化成「哪一刻读了哪篇」（⚠️ `tool/call` 的 `arguments` 是 JSON **字符串**，必须 `JSON.parse`；`message.isError === true` 的读**不记账**；工作区根之外的路径丢掉）；`ingestEvents()` / `noteSnapshot()` / `usageFor()`。会话与读都有上限（`MAX_SESSIONS 24` / `MAX_READS_PER_SESSION 200` / `MAX_SNAPSHOTS_PER_SESSION 2` / `MAX_DELTAS_PER_SESSION 20` / `MAX_PENDING_CALLS 64`），满员按 **LRU** 淘汰最久没碰的会话 |
| **读落在哪一层，看的是「读发生那一刻」的包** | 每篇读按 `firstReadSeq` 找 `seq ≤` 它的**最新一份快照**。少了这一步，一次话题切换会把之前所有读重新贴上「包外」的标签，指标全是噪声 |
| **`/knit/api/recent?usage=1`** | 开闸信号：**第一次带它就等于对本次会话说「开始记账」**，此后不带参数也回传 `usage`。`/api/context` 只推进快照、**从不激活**。顺序是契约：`usage` 先算（它报告的是**上一份**包），快照后记 |
| **`knit_docs` 的 `audit` 参数（默认 `false`）** | `audit:true` 时在工具结果末尾追加一行 `Usage since the last pack: …`（报告**上一份**包），并把这次装配记进快照。不传 `audit` 的一次普通调用**一个记账方法都不碰**（有测试钉住） |
| **面板头部的「使用情况」开关（默认关）** | 打开后列表上方多一行弱化文字：`先看的「x.md」已读 · 辅助 1/2 · 读了 7 次 · 包外 2 篇 · 上下文换过 2 次`。**没有分数 / 百分比 / 进度条 / 品牌色**，风格与「相关性排序」那行同档 |
| **`tools/context-feedback-eval.mjs`** | 拿真实会话日志（`~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd`）**离线回放**；`--control` 时一份包都不交，做对照组。把「包外」拆成 **`missed`**（Knit 索引里有、却没进包 —— 真漏）与 **`outOfScope`**（压根不在索引里，例如 `.js`）：不拆开的话 `outside` 恒高，读起来像「Context Pack 没用」，其实是**量错了东西** |
| **`test/feedback.test.mjs` · `test/context-delta.test.mjs` · `test/context-feedback-eval.test.mjs`** | 17 + 16 + 7 条：路径归一化的八种输入 / 配对与游标幂等 / 上限与降级不抛 / Delta 四类 / 审计开关 / **Control（不交包 ⇒ 读全在包外）vs Treatment（交包 ⇒ `firstReadTier === 'primary'`）的确定性对照** / 坏行不废整批 |

### 真机读数（本机 `08_Knit`，会话 `session-09a33302`，**只量事实、不下结论**）

- **Treatment**（交包）：**392** 份包 · Primary follow-through **YES** · Supporting coverage **1.00** ·
  包外 **25/32 篇（共 392 次）**，其中 Knit 看得到的 11 篇里漏了 **35** 次、真心漏的只有 4 篇
  （`knit/CHANGELOG.md` · `knit/README.md` · `03_发布/验收-v0.14-重启后待执行.md` · `README.md`）·
  Delta churn：**换过 66 次 / 进 177 / 出 177 / 换层 271 / 任务变了 14**。
- **Control**（`--control`，不交包）：**0** 份包 · 包外 **32/32** · `missed` 11 篇（140 次）· churn 0 ·
  自检退出码 0（**量尺没坏**）。
- ⇒ 可复述的只有一句：**agent 读的东西绝大多数是代码文件** —— 32 篇里 21 篇根本不在 Knit 的索引内
  （`.js` / `.json`）。这是**量尺的读数**，不能读成「Context Pack 没用」，也不能读成「有用」。

**测试：`395 → 447 → 450`**（+33 `feedback`/`context-delta`、+7 `context-feedback-eval`、
+7 `tool` 的 audit 通道、+5 `host-http` 的真实回环 HTTP、+3 `client` 的「使用情况」；
`i18n` 与 `client` 里几条旧断言随「头部多了一个按钮」同步）。`test/context-feedback-eval.test.mjs`
与另两个新文件都**手写进了 `package.json` 的 `scripts.test`**（测试文件现共 19 个）。

⚠️ 这一版**宿主侧**（`src/host/*`）改了，要**重启 DSH** 才生效（`curl -s
"http://127.0.0.1:3080/knit/api/raw?rel=nope.png"`：空 body 的 404 ＝ 旧代码；
`{"ok":false,"code":"knit/not-found"}` ＝ 新代码在跑）；前端那个开关只需 `Cmd + Shift + R`。

## [0.14.0] - 2026-09-29

**从「按当前对话给文档排序」升级成「按对话构建当前任务最需要的项目上下文」。**
排序引擎（BM25）一行没改，工具没有重写 —— 这一版加的是**排序之上的一层**；
面板只在相关模式下从一条平铺列表改成**三层分组**（单栏），没有重做 ——
当天稍后又按真机体验改了**四处形态**：右栏从「固定 310px」改成可以拖宽、可以拖出去浮动、
拖回右缘重新停靠；文档列表从「最多 2 列」改成**永远单列**，每篇的第一行改成
「序号 + Primary 点 + 相对时间」的元信息行、标题独占下一行；**列表行里的路径删掉了**
（它和预览头的面包屑重复 —— 用户原话「点开查看文档详情的时候已经有了」）；**序号
从元信息行里搬了出来，成了每行最左边独立的一列**；最后**时间也回到标题那一行、靠右**，
序号与标题第一行**垂直居中**（见下）。

⚠️ **当天最后一条裁定（2026-09-29）：右侧那个「当前任务上下文」说明栏被删除了。**
用户把 v0.14 的 UI 重新定了一条线 —— **Context Pack 是数据层的结构，不是一个要单独显示出来的
UI 卡片**；它直接落在文档列表的分组里（主要 / 辅助 / 相关，组名后跟一句极短说明）。理由是三重的：
右栏与左侧分组**信息重复**（当前任务＝列表上方那行弱化元信息、「命中 N 篇」＝头部总数、
三条证据类型＝三个组名）、「视觉价值有限」、「容易把 Knit 做成 AI Dashboard」，也不符合 Knit
「安静、开发者工具、高信息密度、可信」的方向。随右栏一起删除的还有它那套
**调宽 / 拖出浮动 / 右缘吸附**与把手 —— 真正只有它用得上的代码，一起删干净。
同一条裁定还带来四处收窄：排序依据那行**不再出现关键词**（退到 `title` 属性里当低层 metadata，
可见文本只有「相关性排序」）、组与组之间**不再画横线**（只留 16px 空间）、`why` 文案从
「直接命中当前话题：a、b」缩成「直接命中：a · b」、文档标题从 12.5px 提到 **14px**
（序号的 `line-height` 同步成 19.6px ＝ 14 × 1.4，这是两者垂直居中的唯一手段）。

### 加了什么

| 新增 | 说明 |
|---|---|
| **Context Pack（当前任务上下文）** | 把一次检索结果拆成 **主要上下文 / 辅助上下文 / 相关上下文** 三层，不再只有一条平铺的列表 |
| **每条都带「为什么在这里」** | 理由来自确定性事实：命中在标题 / 摘要 / 正文（附命中的词）、被主要上下文引用、引用了主要上下文。**不是**「AI 判断这篇重要」 |
| **面板的「当前任务上下文」视图** | 相关模式下文档档改成**三层分组**（主要 / 辅助 / 相关，组名后跟一句极短说明），列表本身仍是那份可搜索 / 可预览 / 可键盘导航的文档列表，**永远单栏**。⚠️ 它**先被做成双栏**（左列表 + 右说明栏），当天就被用户删掉 —— 见本节开头那条裁定 |
| ~~**右栏可拖宽 / 可拖出浮动**（当天追加、当天又删）~~ | 固定 310px 在 1000–1300px 这一段会把左栏挤到只剩一列，所以右栏一度改成：拖左侧把手调宽（260–420px，键盘 ←/→ 也能调）、拖面板头部拖出去变成浮窗、拖回右缘 28px 内松手重新停靠，头部还有「浮动 / 停靠」按钮。**面板本身被删除后，这套几何交互（把手 / 拖拽 / 吸附 / 宽度变量 / 三个纯函数）一起删干净了** —— 留着一套永远调用不到的代码，下一个人只会以为它还在生效 |
| **文档列表永远单列**（当天追加） | 用户原话：「文档列表最多一个就行，现在一行两个有点太多了」。**多列那套是整体删除，不是关掉**：`docLayoutFor` / `DOC_TRACK_PX` / `DOC_GRID_MAX_COLS` / `DOC_SUMMARY_MIN_PX` / `.knit-multicol*` 全部不存在（测试反过来守「它真的没了」）。**行一改成元信息行**：序号 + Primary 点 + 相对时间同一行，**标题独占下一行**，摘要再往下（这一行的形态当天又改了两次：序号先搬成最左边独立一列，随后时间也回到标题那一行 —— 见下面两行）|
| **列表行里不再有路径**（当天追加） | 用户原话：「文档列表中的文档路径，我觉得不需要出现了，因为点开查看文档详情的时候已经有了，所以这里是重复的，隐藏掉」。删掉的是 `.knit-meta` 这个节点本身（**不是 `display:none`**）—— 预览头那条**可点的路径面包屑**（`.knit-preview-path`：目录浅 + 文件名亮）始终显示完整路径。⚠️ 这**不是**「多列砍字段」那条教训的复发：那条守的是「不许因为排版窄就静默少给信息」，而路径是**重复信息**；**摘要仍然任何情况下都不许 `display:none`**。行的定位不走可见路径，`data-knit-rel` 仍在 |
| **序号独立成最左边一列**（当天追加） | 用户原话：「文档列表序号放在独立最左边，其他数据放在右边」（附了一张示意图）。列表行改成**两列 grid**：第一列＝序号（`.knit-num`，22px 固定轨道），第二列＝其余全部数据（`.knit-body`，`minmax(0,1fr)` + 必须写 `min-width:0`，否则长标题会把行撑宽、省略号失效）。**行一从此只剩 Primary 点 + 相对时间**（序号不在它里面了）。**没有序号的行不渲染序号节点**（时间序 / 筛选结果 /「其他相关文档」），但那一列由 grid 轨道保着 —— `.knit-body` 的位置写死 `grid-column:2`，正文不会掉进第一列，左边缘始终和有条目的行对齐。**当天最后一条**：时间不再单独占一行 —— 用户要求「将时间放到标题同行，时间放在右边，然后标题跟时间就可以以序号平行，居中平行」⇒ **行一＝Primary 点 + 标题 + 时间**（时间靠右，靠 `.knit-title` 的 `flex:1 1 auto` + `min-width:0` 把它推到行尾，长标题在时间之前省略）；序号那一列靠 `.knit-num` 的 `line-height:17.5px`（＝标题 `12.5px × 1.4`）与标题第一行**垂直居中** —— ⚠️ 改标题字号或行高时必须同步改它，否则序号会与标题错开 |
| **行的静止态不再有底色**（当天追加） | 用户原话：「深色模式下，文档列表没有选中，鼠标没有悬停，不需要有背景。或者是说，跟深色模式的最底下的背景一样」。`.knit-doc` 的静止态从 `bg-layer-1` 改成 **`transparent`**（露出面板 / 宿主侧边栏的底色）—— 浅色主题下这两个令牌都是 `#fff`（看不出差别），**暗色主题下 `bg-layer-1` 比底色亮一档**，于是每一行都像一张浮起来的小卡片，哪怕没选中、没悬停。hover 与 `.active` 各有自己的令牌，**不动**（都改成 transparent 的话，一屏灰里就认不出选中态了） |
| **`knit_docs` 返回分层上下文** | 模型拿到的从「Top N」变成 `Primary / Supporting / Related`，每项带 `source`（实现 / 测试 / 配置 / 设计 / 文档）与结构化 `reason` |
| **`/knit/api/context`** | 独立的上下文接口。`/api/recent` 里也顺带给一个可选的 `context` 字段（老客户端忽略它） |
| **`src/host/context.js`** | 上下文装配层。纯函数、零 I/O，只吃 `rankByRelevance()` 的名次与 `links.js` 的引用图 |
| **`test/context.test.mjs`** | 规则本身的单元测试（SDD 要的八组：Primary / 无相关 / Supporting / Related / 去重 / 确定性 / 理由 / 上限）。**手写输入、不调 `rankByRelevance()`** |
| **`test/context-eval.test.mjs` + `test/context/fixture.mjs`** | 24 篇语料 / 12 条真实任务型用例的**离线 Context Pack 评测**（与 BM25 评测**分开**，互不覆盖），末尾按 SDD §27 报 **Primary@1 / Supporting Recall / Role Precision** 三个具名指标 |
| **`tools/json-schema-subset.mjs`** | 测试与真机探针**共用**的一份 JSON Schema 子集校验器。不引 ajv —— 本包零依赖，引工作区外那份会让 `npm test` 依赖一个绝对路径 |
| **`tools/replay-cases.mjs`** | **在进程内重放**评审文档 §10 那 5 个真实案例（`import` 源码跑 `execute()`，**不需要重启宿主、也不看运行中的进程**），并打印「平铺 top6 / 前两层 / 提上来 / 降下去 / 零命中靠引用」。加了 `--full` 就打印 agent 真正收到的那段文本 |

测试：**285 → 402 → 403 → 395**（`cd knit && npm test`）。402 那次的最后 7 条是右栏拖宽 / 浮动 / 吸附；
403 是「列表永远单列 + 行一不含标题」两条守卫替换掉一条多列测试后的净增一条；
**最后降到 395 是删掉右栏的直接结果** —— 12 条双栏 / 右栏用例整条删掉，只补了 4 条单栏守卫
（「即使宿主给了 Context Pack，DOM 里也没有任何右栏骨架」「源码里不再有任何右栏 CSS 规则 / 函数 / 常量」
「组与组之间只靠 16px 空间（不再画横线）」「关键词退到 title」）。

> ⚠️ **评审文档 §10 那 5 个案例的旧输出已经作废。** 它们是**上限 3 / 5 / 12 那一版**的快照，
> 上限收敛到 1 / 3 / 5 之后「辅助 5 / 相关 12」不再可复现 —— 用 `node tools/replay-cases.mjs`
> 全部重跑过了，旧数字一个没留。重跑后最值得记的两条：**案例 3 从「没有主文档」变成
> 主文档就是那篇 SDD（本节唯一一条 `direct`）**；而**案例 1 的 Primary 是错的** ——
> 一篇 UI 设计文档靠摘要里「审美**关键词**」蹭进了主要上下文。
> ⇒ **「有落脚点」只保证话题词出现在标题或摘要里，不保证那篇讲的是这件事。**

### 分层规则（确定性，可逐条解释）

| 层 | 判据 | 上限 |
|---|---|---|
| 主要上下文 | 命中，**且**有「落脚点」（话题词命中标题或摘要），**且**相关度 ≥ 最高分的 30% | 1 |
| 辅助上下文 | 对某个「焦点词」有**深入命中**（该词不止一篇在讲，且这一篇是把它讲得最多的那一篇）；**或**与某个主要上下文有引用关系 | 3 |
| 相关上下文 | 其余**有命中**的条目，以及零命中但有引用关系的邻居 | 5 |

上限是**上限，不是配额**：主要上下文允许为空，相关上下文也允许为空。
「说不出凭什么」的条目**不出场** —— 零命中又没有任何引用关系的文档不是「与当前任务有关」，
放它进来只能给它一句「与当前工作区相关」，那正是需求禁止的「可能对你有帮助」。

三条都是**实测调出来的**，踩过的三个坑写在 `src/host/context.js` 的文件头：

1. 只要求「命中 ≥2 个话题词」时，满篇话题词的 `CHANGELOG` 与「什么话题都提一句」的长归档霸占主要上下文；
2. 只看「话题词命中标题/摘要」时，摘要里正好出现话题词的文档也会被抬进主要上下文；
3. 只看「正文里出现过」时，每个话题词各提一句的长归档会进**每一条**任务的辅助上下文。

### 顺带修掉的四个真实缺陷

- **`knit_docs` 在 v0.14 上是坏的 —— 每次调用都在校验层失败**（最严重的一条）。
  工具的输出 schema 是封闭的（`additionalProperties: false`），而三层条目实际带了三个
  没被声明的字段（`kind`、`reason.term`、`totals`），`mtimeMs` 还是浮点
  （`fs.Stats.mtimeMs` 本来就是浮点，schema 写的是 `integer`；时间序那条分支一直是取整的，
  两边不一致）。结果是 agent 侧**一个 Context Pack 都拿不到**，而 335 条测试全绿 ——
  因为所有 tool 测试都是拿手写的假 payload 测渲染，**从来没有把 `execute()` 的真实返回值
  交给它自己的 schema 校验过**。是在做「Control vs Treatment」真机对照实验时暴露的：
  4 个 Treatment 会话 100% 报
  `tool "knit_docs" returned invalid output: "value.primary[0].mtimeMs" must be an integer; …`。
  现在 schema 补齐、`mtimeMs` 在投影层取整，并新增两条测试：一条把真实 `execute()` 的返回值
  （relevance 与 time 两种模式）喂给它自己的 schema，一条反向确认那个校验器真的抓得住
  「漏声明字段」和「该整数给了浮点」。
- **`knit_docs` 的头部会写「0 matching documents」而下面列着结果**：返回的三层结果漏了 `totals.matched`，
  渲染层回落成 0。测试当时是全绿的 —— 现在有两条回归用例钉住它。
- **`rankByRelevance` 的并列兜底键依赖输入排列**：`raw` 与 `mtimeMs` 都相同时按「输入下标」定序，
  换个扫描顺序就会换序。改成按 `rel` 定序 —— 这是「相同输入必须产出完全相同顺序」那条承诺的前提。
- **工具在「工作区有文档、但一个词都没命中」时说了假话**：三层全空时它返回
  `No Markdown documents found in the workspace.` —— 而工作区里明明有 49 篇。
  代码注释里其实已经写明「`total` 是正数而三层全空」是另一种情形，**只有输出字符串没跟着分开**。
  现在分开了，并且把限制和下一步一起说出来：
  `No document matched the current topic — 0 of 49 Markdown documents contain the query terms.` /
  `Matches come from the first 2500 characters of each file; use grep for anything deeper.`
  真机触发场景：问「路径越界怎么防」，49 篇一篇都没命中 —— 因为文档侧只看每篇**前 2500 字**
  （`index.js` 的 `HAYSTACK_CHARS`），而这个词在 5 篇 `.md` 里**全部**出现在 2500 字之后
  （`knit/CHANGELOG.md` @29033、`knit/README.md` @9099、`03_发布/发布文档规划.md` @5200、
  `01_ Knit PRD/Knit_SDD-v0.7-agent文档工具.md` @7342、`01_ Knit PRD/Knit_评审-v0.14-ContextPack.md` @7808）。
  ⚠️ **没有动那个 2500 字的窗口** —— 改它等于改检索行为，会推翻 `test/eval/` 里那套冻结的
  v0.5.2 基线。所以这一版只是**不再说假话**，窗口本身留给下一版单独决策。

### 没有做的事（刻意）

- **不改 BM25**：`relevance.js` 的打分逻辑一行没动，`test/eval.test.mjs` 的 top-1 / MRR / 陷阱
  四条断言原样保留、原样通过。新增的只是「把第 1 趟已经算过的命中词留下来」。
- **不引入 embedding / 模型 / 网络 / 数据库 / 长期记忆**。Context Pack 是一层**纯投影**。
- **不做任务理解**：`task` 字段装的是**最近一条用户消息的原文**，不是任何概括 ——
  Knit 不解一句话的意思，只是把它如实摆出来给人看。工具返回值里**不带** `task`
  （模型看到的是渲染后的文本，头部已经用话题标签说了「这次按什么排的」）。
- **不新增第二套打分**：没有 `contextScore`，界面上也没有百分比、星级、置信度条。
  Eval 报的 `Primary@1 / Supporting Recall / Role Precision` 是**集合关系**，
  不是分数门槛（没有「必须 > 80%」这种断言）。
- **不重扫工作区**：`collect → relevance → links → context assembly` 复用同一批结果，
  引用图复用 `collectDocs` 已经读进内存的正文首部，零额外 I/O。
- **不声称「让 agent 少读几篇」—— 这一版实测是反的。** 重启后用冻结协议跑了
  Control vs Treatment 各 4 次（同 4 条任务、同一个 50 篇工作区）：Treatment 的工具调用
  均值 **6.0** vs Control **4.75**，逐题 **6 vs 5 · 5 vs 5 · 9 vs 5 · 4 vs 4**，**没有一题变少**
  （算上那次 `knit_docs` 调用则是 7.0 vs 4.75）。唯一被消掉的是 `glob`，代价是
  `read` 从 1.75 涨到 3.75、`distinct files read` 从 1.5 涨到 2.75；四条答案**全部正确**，
  所以不是「省了调用但答错」，是单纯没省。**它给出的价值是「定位 + 解释」**
  （该看哪几篇、为什么、有没有主文档），**不是省力**。完整数据见
  `01_ Knit PRD/Knit_评审-v0.14-ContextPack.md` 附三。

## [0.13.1] - 2026-09-23

**只改文档，插件行为一行没动。** 没有新功能、没有修 bug ——
**装过 `0.13.0` 的人没有任何必须升级的理由。**

那为什么还要发一版？因为 **npm 页面上渲染的 README 是「已发布 tarball 里的那一份」**。
`0.13.0` 之后我们往 README 里补了重排动图和两张真机截图，但那个包的 README 是**冻结**的 ——
不重新发一版，npm 那个页面就永远停在老版本：没有动图、没有反馈入口。

### 包内实际变化

只有两个文件（其余改动不在 `package.json` 的 `files` 白名单里，压根不进包）：

| 文件 | 变化 |
|---|---|
| `README.md` / `README.en.md` | 第 1 屏接上**重排动图**；新增「反馈」与「升级」两节；补「图片与视频」「全部」两档真机截图；图注篇数 `34 → 36`；更正关于下载量的说法；修掉过期的测试数 |
| `CHANGELOG.md` | 本节 |

### 不进包的改动（在仓库里，但 `files` 没收录）

| 文件 | 说明 |
|---|---|
| `docs/demo-reorder.gif`（新增 1.3 MB） | README 用**绝对 raw URL** 引用，所以 npm 页面上照样显示 |
| `docs/screenshot-media.png` / `screenshot-all.png`（新增） | 同上 |
| `screenshots.json` | **1 张 → 3 张**（市场详情页的相册会自动跟着变，不用提 PR） |
| `tools/make-demo-gif.mjs`（新增） | 录屏 → GIF 的编码器，含 `--crop` |
| `tools/market-recheck.mjs`（新增） | 市场索引 + 下载量复查，含「形状判读」 |

### 顺带纠正一句我们自己说错的话

npm 的下载量**不是人**。决定性证据：`0.5.0` 只当了 **28 分 09 秒** `latest` 就被下载 **155** 次，
而 `0.13.0` 当了 **59.6 小时** 才 **161** 次 —— **曝光时长差 127 倍，下载量只差 1.04 倍**
（皮尔逊 r = 0.317；真实安装应当接近 +1）。`npm install` 只解析 `latest`，
**没有哪个真人渠道能造出这个形状**。版本分布也是平线：8 个版本几乎均分，
`latest` 占比只有 **14.4%**（对照真包 60–80%）。

⇒ README 里现在按这个口径写：**那个数字不能读成「这么多人在用」。**

## [0.13.0] - 2026-09-20

**三件事，都是真机体验打回来之后改的：**

1. **文档列表响应式**：默认 1 列，宽了**最多 2 列**，多列时字段一个不少
2. **预览面板底色恒为纯白**：删掉「先灰、滚一下才变白」那一整套机制
3. **媒体网格响应式重写**：列数交给 CSS `auto-fill` 连续数，纵向不封顶

外加多列的**键盘与无障碍修复**（P0）：选项语义、`←→` 跨行导航、网格里可见光标。

### 一、文档列表响应式：默认 1 列，宽了最多 **2 列**，多列时字段一个不少

用户提议：「文档这块也可能要支持随着宽度的适应……默认是一个文档在一行，
随着宽度的增加可能要增加到最多 4 个」。这一节改了**三版**，前两版都被否掉，
第三版又把上限从 4 收到 3：

| 版本 | 做法 | 结果 |
|---|---|---|
| 一 | 把 1 列的卡直接压窄成多列 | ❌ 632px / 4 列时标题只剩 **9 个字**，一屏还是 4 篇，只是把信息切碎 |
| 二 | 多列只留**标题 + 时间** | ❌ 「两行保留一行一样的列表数据，现在大于一行后只有标题与时间了」 |
| 三 | 多列**保留全部字段**、只改排版 | ⚠️ 字段对了，但仍允许 4 列 |
| 四 | 上限收到 3 列 | ⚠️ 「大于三行视觉跳动信息过载了」 |
| 五（当前） | 上限再收到 **2 列** | ✅ 交互评审：3 列摘要每行只剩 **16 个汉字**，读不下去 |

**「4 列」被否掉的理由值得记**：4 列不是「更密=更高效」，而是**一屏塞太满**——
扫读时视线要在四个窄栏之间反复跳跃，还要同时读摘要与路径，反而比 3 列更难定位。
**密度有上限，超过就变成信息过载。**

**实测数据（真实标题样本，632px 面板）** —— 这是第一版被否掉的依据：

| 列数 | 格子宽 | 标题能显 | 摘要每行能显 | 一屏几篇 |
|---|---|---|---|---|
| 1 列 | 616px | 52 字 | 56 字 | 4 篇 |
| 2 列 | 303px | 24 字 | 26 字 | 8 篇 |
| 4 列（150px 下限那版） | 146px | **10 字** | 11 字 | 4 篇 |

真实标题中位数 **18 字**、最长 43 字（`Knit_PRD-v0.11-agent价值与信任`）。

**最终版的两条设计：**

1. **格子下限从 150px 提到 205px** —— 宁可列数少一点，也要让 2–3 列的摘要还有 16 个汉字。
   断点因此变成：<420px 1 列 / ≥420px **2 列（封顶）**。
   默认 632px 面板落在 2 列（格子 303px，摘要 **26 字/行**），**标题、时间、摘要、路径全在**。
2. **多列只改排版，不改数据**：时间从「和标题挤一行」改成纵向排、标题与路径折两行。
   摘要按格子宽度决定去留（`docLayoutFor().summary`；窄于 185px 才让位，
   当前配置下达不到，属兜底分支）—— 与媒体卡「窄到 96px 以下让位给缩略图」同一套渐进让位。

**为什么不按列数藏字段**：一多列就砍数据等于**用「看得更多」换「看不到内容」**。
用户的判断是对的 —— 宽面板应该同时得到「更多篇」与「不丢信息」。

**为什么最终停在 2 列**（这一版是交互评审的结论，不是试出来的）：
文档列表的用户任务有三种 —— ①按名字找一篇 ②**读摘要判断哪篇有用** ③看最近改了什么。
多列只对 ①③ 有微弱帮助，对 ② 没有：读文字的成本由「每行字数 + 换行次数」决定，
**不由「一屏几个卡片」决定**。实测每行可容纳的汉字数：

| 列数 | 格子宽 | 摘要每行 | 判断 |
|---|---|---|---|
| 1 列 | 616px | **56 字** | 大多摘要一屏读完 |
| 2 列 | 303px | **26 字** | 仍可读，一屏 8 篇 ✅ |
| 3 列 | 198px | **16 字** | 摘要碎成片段，读到「本文件是 Agent 进」就断了 ❌ |
| 4 列 | 146px | 11 字 | 标题都只剩 10 字 ❌ |

所以 2 列是**摘要仍然可读的上限**；再宽的收益只有「多一篇」，代价是每篇都读不下去。

⚠️ **别再加回 3 列**：真要提升宽面板的信息利用率，该做的是**让单列更舒展**
（时间/路径移到右侧同一基线、摘要可读宽度拉满），不是继续切栏。

### 关于「最多两行」

用户说「修改成最多两行」。这句有两种读法，我按 **B** 实现，并在此标出：

- **A：网格最多铺两行**（第 8 篇之后内部滚动）—— ❌ **没做**，因为那会重演媒体那次的坑：
  按「两行」算死高度、后面的条目被截断或挤进嵌套滚动。
- **B：卡片最多折两行**（标题 2 行、路径 2 行、摘要本来就 2 行），行数不设上限、
  由列表滚动 —— ✅ **做了**，与媒体「纵向铺满、不封顶」保持一致。

⚠️ 另记两个坑：
- **容器类名不能含 `knit-doc`**：第一版叫 `knit-doc-grid`，而 `byClass` 是**子串**匹配 ——
  它把容器当成一个文档行，34 条测试当场红（§6.5 那个坑的第三次）。
  改名 `knit-multicol`，**改的是命名不是测试**。
- **列数类只加在文档容器上**，不能加在 `.knit-list` 上 —— 那是唯一的滚动容器，
  媒体档与「全部」都在它里面。
- **`cols-4` 的 CSS 已随上限一起删掉**：留着就是不可达的死代码，而且会让人以为 4 列还开着。
  有条守卫盯着这件事（`docLayoutFor` 的上限 == 3 且 CSS 里不许出现 `cols-4`）。

### 一点五、多列的键盘与无障碍（P0 修复）

多列改造**引入了一个真实回归**，不是历史问题：列表的键盘模型还是「单列一条线」。

| 缺陷 | 事实 | 修法 |
|---|---|---|
| **选项无语义** | 容器是 `role="listbox"`，但条目是裸 `div` —— 读屏只能播报「一个列表框」，读不出「N 项中的第 i 项」，也读不出当前选中 | 每个条目加 `role="option"` + 稳定 `id`，容器加 `aria-activedescendant`；光标项 = 被指向的那一项，预览项 `aria-selected="true"` |
| **多列无 ←→** | 2 列网格里按 `↓` 视觉上**往右**走，而 `←→` 完全不响应 —— 看到的是两列，键盘只有一条线 | 抽出纯函数 `nextIndexFor(index, key, count, columns)`：`↑↓` 走相邻项、`←→` **跨一整行**（行首/行尾停住**不回绕**，回绕会让方向感更差）、`Home`/`End` 到首尾。**只在多列时接管 ←→**（单列拦它反而会挡掉宿主） |
| **网格里光标不可见** | 单列时靠 `:hover` 的 translateX 提供位置反馈，而网格里这条位移被关掉了（会给整格带来抖动）—— 键盘用户因此完全失去「我在哪」的线索 | 多列时给 `.knit-doc.cursor` 一圈**中性**描边环（与媒体卡光标同一套，不是品牌色，与 `.active` 区分） |

⚠️ 两个实现要点：

- **`id` 必须由 `rel` 哈希稳定推导，不能用计数器** —— `aria-activedescendant` 要指向真实存在的 id，
  而渲染期自增的 id 会在不同帧漂移（渲染顺序、过滤、轮询刷新都会变）。
- **网格容器改 `role="presentation"`**（原来是 `group`）：`option` 要是 `listbox` 的直接子级，
  辅助技术才会把选项算进那个集合。
- 导航算术抽成纯函数是**为了可测**：真实列数靠 `ResizeObserver` 量，测试环境量不到、永远是 1 列 ——
  不抽出来，多列分支就永远跑不到，又是一盏空转的绿灯（§6.12）。

### 二、预览面板：灰底 → 恒为纯阅读底色

用户原话：「文档选中后下拉出现详情时，背景是灰的，这个交互比较差……把它改成整个都是白」。

v0.10 起的行为是「先分层灰，用户一滚正文（> 4px）才**过渡**到纯白」。现在**一展开就是白的**，
而且**滚动、换篇都不会改变底色**。改的是根，不是参数：

- `.knit-preview` 的 `background` 从 `bg-module-platform`（浅 `#f5f6f7`）换成
  **`bg-base`（浅 `#fff` / 深 `#151517`）**，`transition:background-color` 一并去掉
- 删掉 `.knit-preview.reading` 这条规则，以及**整套驱动它的机制**：
  `READING_SCROLL_PX` 常量、模块级 `readingDocs` 集合、`readingTick` 状态、
  正文的 `onScroll` 回调、`PreviewPanel` 的 `reading` / `onScrollBody` 两个 prop
- `readingKey()` 改名 `previewKey()` —— 它现在的使用者只剩引用条的展开态（`expandedLinks`）

⚠️ **别只写 `#fff`**：暗色主题下会白得刺眼。要走 `bg-base` 让两边都跟着主题走。

⚠️ **分层现在不靠底色了**：靠顶部圆角 + 上边界 + 向上柔影（三件都还在，没动）。
旧实现是靠「换一个明暗都不同的表面令牌」做层级，这条路现在废弃了 ——
留着记一笔是因为**「分层未必要靠底色」**才是那条经验的正文。

### 三、媒体网格的响应式重写 —— 花了三次才对，三次都是用户看出来的

起因是用户对着右边栏的「AIGC 资产中心」插件说：「它的图片这一块随着宽度伸缩，
适应得非常好」。对比之后确认，差的不是宽度监听，而是**列数由谁决定**。

三次修正对应三张真机截图，病灶一次比一次隐蔽：

| 第几次 | 病灶 | 用户原话 |
|---|---|---|
| 一 | JS 按**条目个数**反推列数（`Math.ceil(n/2)`，最多 8 列） | 参照 AIGC 的对比提出 |
| 二 | 改成「按条目数反算格宽」——**列数仍被条目数锁死** | 「要我拉到一定的宽度以后，它才从 4 个变成更多」「它不是真的响应式」 |
| 三 | 给网格设 `maxHeight` 封「两行」并让它自己滚 —— **第三行只露一点点** | 「本来有三行，结果第三行只显示了一点点，应该纵向也完整显示」 |

### 第一版（同一天上午，错的）

把「JS 按条目个数反推列数」改成「JS 按可用宽度和条目数算格子宽度 + CSS auto-fill」。
320px 下 5 列 48px 的病治好了，但**列数仍然被条目数锁死**：

| 面板宽 | v0.12.1 | 第一版（错） | 最终版 |
|---|---|---|---|
| 320px | 5 列 / 48px | 3 列 / 86px | **2 列 / 135px** |
| 420px | 5 列 / 68px | 5 列 / 68px | **3 列 / 120px** |
| 632px（默认） | 5 列 / 110px | 5 列 / 110px | **5 列 / 110px** |
| **700px** | 5 列 / 124px | 5 列 / 124px | **5 列 / 124px** |
| **900px** | 5 列 / 164px | 5 列 / 164px | **7 列 / 114px** |
| **1100px** | 5 列 / 207px | 5 列 / 204px | **9 列 / 108px** |
| **1400px** | 5 列 / 207px | 6 列 / 218px | **12 列 / 104px** |

（最终版那几列是实测读数：JS 报的列数与浏览器 `grid-template-columns` 的轨道数一致。）

用户的反馈：「**要我拉到一定的宽度以后，它才从 4 个变成更多**」
「它响应非常的快……就是它是真的是以这种响应式适应列表一样」
「**它不是真的响应式**」。实测确认：第一版从 **400px 到 1200px 列数一直卡在 5 列**，
只有格子从 64px 被吹到 224px。

### 最终版：只钉一个数，`count` 不许进函数，纵向不封顶

```css
grid-template-columns:repeat(auto-fill,minmax(var(--knit-media-track,104px),1fr));
```

- **格子基准固定 104px**，与条目数**完全无关**（实测渲染 104–155px）
- 列数 = 浏览器按可用宽度连续数出来的，**拖宽约 120px 就多一列**，没有平台期
- JS 侧 `mediaLayoutFor(width)` **只接受 width 一个参数** —— 签名里没有 `count`，
  是横向那条唯一的结构性保证（测试里有源码级守卫盯着调用处）
- **纵向有多少行就铺多少行** —— 网格**不设 maxHeight、也不自己滚**，
  滚动统一交给 `.knit-list`（第三版修正，见下）

### 第三版：把「两行封顶」整个删掉

前两版都给网格设了 `maxHeight`（按「两行」算死）+ `overflow-y:auto`，让它内部滚动。
真机上第三行只露出一点点 —— 用户发来截图：「本来有三行，结果第三行只显示了一点点，
应该纵向也完整显示」。

根因：**封顶高度是按「两行」算死的，与面板实际有多高无关**，媒体超过两行就必然截断；
而且「网格自己滚」在「全部」里还会与外层列表叠成嵌套滚动。

修法是**删掉这个机制本身**，而不是调参数：

- `MEDIA_ROWS` 常量删除，布局函数不再返回 `maxHeight`
- `.knit-media-grid` 去掉 `overflow-y:auto`（现在只有 `.knit-list` 滚）
- 渲染处不再写行内 `maxHeight`

与 AIGC 资产中心一致：它那边也是整页滚，网格自己不滚。

### 三个实测踩出来的坑（都写进了注释）

1. **轨道下限 104px 与 `1fr` 都不能省**：只写 `1fr` → 只有一个媒体时那张图撑满面板宽度；
   只写固定宽 → 面板宽了留白、格子不跟着走。
2. **JS 的列数算术必须含 gap**：`floor((可用宽 + gap) / (104 + gap))`，不是 `floor(可用宽 / 104)`；
   少算 gap 会让 JS 与真机差一列。
3. **CSS 注释里不能出现反引号**：那段样式是模板字符串，一个反引号就会把它提前截断 ——
   这次**踩了两次**（第二次是给 `.knit-list` 加引号），`node --check` 报的是
   `Unexpected identifier 'minmax'`（见 AGENTS §6.9）。

### 测试（280 → 282）

`mediaLayoutFor` 的断言整段重写。旧断言守着「最少 3 列 / 一屏 8 个 / 超过等比缩小」，
那是**旧算法的规则本身**，必须跟着改。新断言守五件事：

1. **列数只与宽度有关，与条目数无关** —— 传 120 个条目进去，结果必须与不传一样
2. **没有平台期**：每加 120px 宽度**至少多一列**（这条正是第一版会红的）
3. JS 报的列数与 CSS 的 `auto-fill` 判定**逐字一致**（含 gap）
4. **调用处不许传第二个参数** —— 源码级守卫：剥掉注释后扫每个
   `mediaLayoutFor(...)` 的参数表，出现顶层逗号就红
5. **纵向不许封顶**（第三版）—— 布局函数连 `maxHeight` 这个键都不该有；
   网格的 CSS 规则里不许出现 `overflow-y` / `max-height`；渲染处不许读 `mediaLayout.maxHeight`

### 怎么验的

- **横向**：无头 Chromium 加载**从产品源码抽出的真实 CSS**，17 个面板宽实测：
  JS 列数 == 浏览器列数、格子方正（±2px）、宽度 ≥ 96px、行高一致、列数单调不减 ——
  **全部通过**
- **纵向**：同法测 6 组（含 320px / 6 个 = 3 行这种原病灶场景）——
  行数铺满、网格 `overflowY` 为 visible、`maxHeight` 为 none、
  **最后一行完整**（末行底边不超过网格底边）—— **全部通过**
- 真机（DSH 右边栏）拖动宽度时列数跟随，详见 `03_发布/` 的验收记录

> 教训 1：**只要「条目数」还能影响格宽，列数就一定会被锁死。**
> 前两版在同一个地方栽跟头，区别只是第一版锁得狠（`Math.ceil(n/2)`）、
> 第二版锁得隐蔽（64px 下限把 raw 列数顶满）。**根治办法是把 `count` 从函数签名里拿掉。**
>
> 教训 2：**别用「算出来的高度」去封一块内容的高度。** 算的是「两行」，
> 装的是「三行」，差的那一行就是用户看到的那一点点。要么完全不封，
> 要么按**实际可视高度**封（那需要真的量容器）—— 前者是对的。

## [0.12.1] - 2026-09-19

**一张真机截图抓出来的修复版。** 没有新功能，两件事：把三处**硬编码中文**收进词典，
以及让 README 里那张图**第一次真的能在 npm 页面上显示**。

### 修了什么

英文界面下，文档行右边显示的是中文 `3 分钟前` —— 面板其余部分都是英文。
扫过整个客户端后确认，词典之外只有三处裸中文（其余文案全部走 `t()`）：

| 位置 | 原来 | 现在 |
|---|---|---|
| `relTime()` 的六条时间文案 | `刚刚` / `X分钟前` / `X小时前` / `昨天` / `X天前` / `X月X日` | 六个 `time.*` 键，中英各一套 |
| 文档列表的 `aria-label` | `最近文档` | 键 `list.aria` |
| better-sidebar 的 tab 标题 | `Knit 最近文档` | 复用 `guide.title`（顺带把两个宿主的口径统一了） |

违反的是项目自己的规矩：**文案一律走 i18n，宿主只返回错误码**。

### 加了 4 条守卫（测试 276 → 280）

1. 英文环境渲染出的整棵树里**一个汉字都没有**
2. 英文环境下 `aria-label` / `title` / `placeholder` / `alt` 里也没有汉字
3. 相对时间的**六个分支**都随语言
4. better-sidebar 的 tab 标题随语言

既有那条冒烟用例（只写死 `刷新|按` 两个词去查）**当时没抓住 `3 分钟前`** ——
新守卫改成「不许有任何汉字」，不再靠枚举词。

> ⚠️ **每条守卫都做了证伪**（把三处改回硬编码 → 4 条全红；恢复 → 全绿）。
> 第一版守卫用的是现成语料，两篇文档只落在 2 个时间分支上 ——
> **把 `分钟前` 改回去，守卫竟然全绿**。所以新增一份把六个时间粒度走全的语料。
> **「测试通过」不等于「测到了」。**

### 图片

- **README 第 1 屏换成当前 UI 的真机截图**（中文界面、引用条两组都展开）。
  之前那张停在 v0.5.x，与 v0.6–v0.12 的改动全都对不上
- **README 里的图片地址改成绝对 raw URL** —— npm 页面上这张图**从 `0.5.0` 起就没显示过**：
  用的是相对路径，而 `docs/` 不在 `files` 白名单里，文件根本没进包
  （`unpkg.com/dsh-knit@0.12.0/docs/screenshot.png` → 404）。改完之后换图也不必再发版本

### 注意

- 本版**没有行为变化**：不改排序、不改接口、不改面板逻辑
- 客户端半边改动**硬刷新浏览器即可**，不需要重启 DSH

## [0.12.0] - 2026-09-19

**让文档之间那层「引用关系」看得见。** 预览一篇时，面板给出「**这篇被谁引用 / 这篇引用了谁**」，
一键跳过去。

Knit 原来只回答「哪几篇跟你现在的话题相关」（**排序**问题）。这一版回答的
「这几篇之间连着谁」是**结构**问题 —— 两件事不冲突、不重叠，而且后者只有文件系统知道。

### 起因：先量，再决定

`0.11.0` 那轮真机教会我们「收益型主张必须先量」。所以这一版动手前先拿真实语料
（`05_LoreFlow-Copilot`，129 篇）量了三件事：

| 量到的 | 结果 | 决定 |
|---|---|---|
| `[[wikilink]]` 出现次数 | **0** | **不做** Obsidian 语法支持 |
| `` `path/x.md` `` | **946** | 反引号路径才是要认的写法 |
| 重复 basename | **12 个名字 / 68 个文件**（`SKILL.md` ×20、`01_公众号正文.md` ×12） | **歧义一律不算链接** |
| 链接图当排序信号 | BM25 第 45 名 → 融合后 16~24，RRF 最好第 8 | **不碰排序** |

### 加了什么

- **`/knit/api/links`**：只读，返回某篇的 `incoming` / `outgoing`（**只有 rel + title**，
  不泄漏图与 haystack —— 与 `knit_docs` 同一条纪律）
- **`src/host/links.js`**：纯解析层。`extractRefs` / `resolveRef` / `buildLinkGraph` / `linksOf`，
  零依赖，`list` 与 `read` **由调用方注入**（因此不 import `index.js`，没有环）
- **预览头下方的「引用条」**：默认折叠只给计数，展开列两侧，点一项就地跳过去
- 解析优先级：**引用方所在目录 → 工作区根 → 缩写后缀（`-SDD-v0.6.md`）→ basename（仅当唯一）→ 不算**
- 解析结果**按签名缓存**：真实语料**首次 110 ms、二次 9 ms**

### 刻意不做的（都量过，不是没想过）

`[[wikilink]]` 语法 / 链接图进排序 / 关系图可视化 / 标签与 Dataview 式查询 / 编辑。
理由见 `01_ Knit PRD/Knit_PRD-v0.12-反向链接.md` §三。

### 顺手还了一笔旧债

`0.11.0` ① 的钩子写着「**它读一篇，而不是翻五篇**」—— 那正是四轮真机**没能证实**的收益。
本版把三处改成**机制陈述**（npm `description`、两份 README 顶部钩子）：
「拿回排名**加每篇里命中的那段原文**」。**未证实的收益不再当既成事实写。**

### 测试

**239 → 276**（解析层 31 条 + HTTP 端到端 1 条 + 客户端 5 条），全绿。
`test/eval/` 的 21 条排序用例**结果不变** —— 证明排序一行没碰。

### 注意事项

- ⚠️ **宿主半边改了，必须重启 DSH**（`AGENTS.md` §4.2）—— 新增了一条路由
- ⚠️ **本版不承诺任何行为收益**：只说「引用关系被正确解析出来并且看得见」。
  不写「找得更快」、不写「agent 少读」——那些我们没测
- **已知边界**：不做模糊匹配、不处理 `../` 上跳、不区分代码块里的「示例路径」、
  正文按 512KB 上限截断。**解析不出来就是没有链接 —— 宁可少，不可错**

## [0.11.0] - 2026-09-18

**把 agent 那一面说出来，并把它证明给人看。** 三件事一起：定位外化（①）、
`knit_docs` 返回命中段落（②）、安全属性可核验（③）。
排序算法与面板**零改动**。

> ⚠️ **这一版把 `0.10.0` 一起带上了。** 评审决定：`0.10.0` 不单独发 npm，
> 所以 npm 上会从 `0.9.0` **直接跳到 `0.11.0`**，`0.10.0` 成为一个只存在于 git 的版本号。

### 起因

`00_调研与规划/竞品调研-Codex插件生态.md`（2026-09-18）挖出来的对比：

| 品类 | 代表 | 真实分发量 |
|---|---|---|
| **省 context / 省成本** | `token-optimizer-mcp` | npm **6,240/月**（逐日验过：12/20 非空洞日、日均 ~143，**持续曲线**） |
| 给 agent 找项目文档 | `alcove` | crates.io **总 1,028** |
| 同上 | `agentpack` | npm **305/月** |
| 同上 | `mcp-md-reader` | **没发 npm** |

**同一个生态里「省读」有真实用户，「找文档」没有。** 而 Knit 的 `knit_docs`
本来就是「省读」（agent 不用 glob + 逐个 read 试探），但我们对外只说了面向人的那一面。

### ① agent 价值外化（零代码）

**问题不是没说，是埋太深** —— README 第六节早写了 agent 视角，但打包层全是人：

| 面 | 改前 | 改后 |
|---|---|---|
| npm `description` | 只有人 | 补 `…and hands the same ranking to the agent as a tool, so it reads one doc instead of five.` |
| README 顶部钩子 | 只有人 | 补 **「你的 agent 也一样。同一份排序也给它当工具用 —— 它读一篇，而不是翻五篇。」**（中英各一条） |
| 市场索引 YAML | 没提 agent 工具 | **逐字不改** —— 投稿规范写死「no superlatives / 描述只说功能」，动它有被打回的风险 |

### ② `knit_docs` 返回命中段落

**为什么要先算账**：这件事的成本**不是**门槛 —— 实测 `knit_docs` 一次输出 710 字符，
而**一篇文档平均 12,930 字符**（18.2×）。每篇多 200 字的段落，只等于一篇文档的 7.7%。

**实现后发现实测比预估更省**：

| | 字符 |
|---|---|
| 改前 | 754 |
| 改后 | 1247 |
| **实际多出** | **493**（预估 +750） |
| 占一篇文档 | **3.9%**（预估 5.8%） |

**含义**：只要它拦住 **3.9% 次 `read`** 就回本。**成败 100% 取决于行为问题** ——
agent 拿到段落之后还会不会去读整篇。判据见 `Knit_SDD-v0.11-knit_docs命中段落.md` §六。

设计要点（详见同一份 SDD）：

- 在**原文**上切段落，**不在 `haystack` 上切** —— 后者是小写的，会把 `BM25` 变成 `bm25`，
  与「标签是你自己打的字，大小写原样保留」直接冲突
- 只看前 **2500 字**（与评分窗口 `HAYSTACK_CHARS` 一致），避免「排上来但段落里没命中词」
- 块太长时**以命中词为中心**截，不是从头截
- **跳过与标题重复的块** —— 真实工作区试跑时发现的：H1 里含全部命中词时，
  「命中最多的块」就是标题本身，而标题第 1 行已经给过了，那是纯浪费
- **抽不到就不给**（字段缺省），不写空串、不编造
- `read` **注入**，第二个参数可选 —— 不传时行为与 v0.10 逐字一致

顺手修掉一个**测试查不出来**的坑：段落提取是 200 字，而原来的 `oneLine()` 上限写死
`SUMMARY_CHARS`(90)，直接复用会把段落**二次截掉一半**且测试不报错。
抽出 `flatten(text, cap)` 修掉，并加了一条专门的回归测试。

### ③ 安全属性可核验

新增 `SECURITY.md`：一张对照表，**每条 ✅ 都指向一个真实存在的检查**，
并允许出现 ⚠️（第一条就是**「未经第三方安全审计」**）。

新增 `test/security.test.mjs`（8 条）—— 它不只是测安全，更是**保证那张表不会腐烂**：

- `SECURITY.md` 引用的每个包内路径必须真实存在
- 每个 ✅ 行的证据必须指向具体检查（不能是「我们声称」）
- `SECURITY.md` 必须在 `package.json` 的 `files` 里（否则「随版本一起发」是空话）

**写这张表的过程真的抓出一个漏洞**：`sandbox` 这个 CSP 指令源码里设了，
但 `test/host-http.test.mjs` **只断言了 `default-src 'none'`、没断言 `sandbox`**。
「每条 ✅ 都要有检查」这条规矩把它逼出来了 —— 已补上断言。

### 测试

**217 → 239**（② 加 14 条、③ 加 8 条），全绿。

### 注意事项

- ⚠️ **宿主半边改了，必须重启 DSH**（`AGENTS.md` §4.2）—— ② 是宿主侧改动，不像 ① 那样只改文案
- ⚠️ **② 的机制已真机证实、行为收益未证实 —— 但已查明演示不了。**
  真实宿主里 `knit_docs` 结果 **20/20 篇带 `match:` 行**，段落内容正确。
  可四轮真机之后查出：**工具只在「要一份候选清单」时被调用，
  而它的收益（段落替代读整篇）只在「要一个事实答案」时体现** ——
  后者 agent 的反射是 `grep`，压根不碰这个工具。**触发条件与收益条件是错开的。**
  结论：**按纯增益发布** —— 结果里多一行 `match:`，不改变其余任何行为；
  没有它，`0.10.0` 照常工作。复盘见 `AGENTS.md` §6.10 与
  `01_ Knit PRD/Knit_SDD-v0.11-knit_docs命中段落.md` §10.9–10.10
- 三条适用边界（都不是缺陷，是它该待的射程）：找**确切字符串**时 `grep` 更强；
  **用户措辞与文档措辞不一致**时词面检索会漏；**权威产物在代码里**时不在射程内
  （Knit 只索引 Markdown 与媒体）
- `package.json` 的 `files` 加了 `SECURITY.md`；`test` 脚本加了 `test/security.test.mjs`

## [0.10.0] - 2026-09-18

**把「新标签页」换成「在本地打开」。** 排序算法、宿主半边、`knit_docs` 工具**零改动** —— 纯客户端。

### 为什么

看到豆包文档工具栏的「打开 ▾」（用本机应用打开当前文档），问我们是不是也该这么做。

查完的结论是：**这个能力我们早就有，只是藏起来了** —— 预览头那行路径面包屑一直可点
（`ctx.remote.session.openWorkspacePath`，官方对这个 API 的定义是
「hands a path to the local opener and leaves the effect on the machine」），
悬停提示写着「用系统默认应用打开这篇文档」。但它是面包屑的外观，没人知道能点。

同时「新标签页」重复度高：它开的是官方文档预览，而面板里已经有就地预览。
（不算严格冗余 —— 官方预览有 PDF 渲染器和渲染方式切换，而且我们刻意不接管 `.md`
路由以保留官方产物卡 —— 但确实用得少。双击列表行仍保留这个入口。）

**于是：把值钱的那个放到显眼处，把鸡肋的那个让位。**

### 改了

- 预览头右上角：`[全屏] [新标签页] [✕]` → `[在本地打开] [全屏] [✕]`
- 新按钮文案中英各一条（`preview.openLocalBtn`），tooltip 复用 `preview.openLocal`（带完整相对路径）
- **路径面包屑保持可点** —— 已有的快捷方式不动
- 「新标签页」能力**没有删**：双击列表行 / 媒体卡仍走它（`onOpenTab`）
- 顺手清掉 `PreviewPanel` 上已成死 prop 的 `onOpenTab`，以及词典里没人用的
  `preview.newTab` / `preview.newTabTitle`

### 被否决的方案（都查过官方 API，不是猜的）

| 方案 | 为什么不做 |
|---|---|
| **豆包式「文档应用选择器」**（Typora / Obsidian / 预览…） | DSH **没有**这个能力可复用。官方 `open-in-app` 是给**工作区文件夹**的（路由写死校验「an absolute path naming an existing **directory**」），应用目录还是一张编译期表、全是开发工具 —— **没有 Typora / Obsidian**。要做就得自己写应用目录 + 一条**启动本机进程**的宿主路由 + 跨平台分支。那是新的风险等级（Knit 现在全是只读接口），收益却是猜的 |
| **复用官方 `open-in-app` 做「打开工作区 ▾」** | 能做（`GET /open-in-app/apps` 实测返回 `["finder","cursor","vscode","terminal"]`，图标免费），但它是**文件夹级**，跟要的「打开这篇文档」不是一回事，且与已有的「点工作区路径打开文件夹」重叠 |
| **官方文档预览的「打开方式」** | 名字像，但 `candidates = matchingDocumentPreviews(definitions, file.path)` —— 是 **DSH 内部渲染器**切换（Markdown / 纯文本 / PDF），**不是本机应用** |

### 注意事项

- ⚠️ **纯客户端改动：硬刷新浏览器即可**（`Cmd + Shift + R`），不需要重启 DSH
- 测试 **217/217**（新增 2 条：按钮存在且点击打开本文档；没有 `remote.session` 时给可见提示）

## [0.9.0] - 2026-09-18

**改 `knit_docs` 对自己排名的说法。** 算法、面板、客户端**零改动**。

### 起因：v0.8 的修法打偏了

v0.8 加「结果头部给出总数」，假设 agent 交叉验证是因为**怕漏**。
真机验证（干净子代理 N=3）显示**没有修好**：2 个用了工具，其中 1 个仍然
`grep` 全库重新排名；1 个压根没用工具。

看会话日志才发现它**不是怕漏，是不认这个排名** ——
它自己 `grep -c "排序|BM25|相关度|相关性"` 数关键词密度重排了一遍。

### 于是先把问题变成可量的

新增 `knit/tools/scale-benchmark.mjs`：三条路线、N = 20/60/180/540。
语料刻意做成有真实陷阱的（12 篇短而聚焦的主题文档 + 长干扰文档
「把每条主题各提 5 次但哪件都没讲」，像 CHANGELOG；主题文档一半用描述性文件名、
一半看不出内容）。基线照抄真机日志里 agent 的做法，不算放水。

| 路线 | 文件名说得清 | 文件名看不出 | MRR 随规模 |
|---|---|---|---|
| **Knit BM25** | **100%** | **100%** | **1.000（不随规模变）** |
| grep -c 计数 | 17% | **0%** | 0.313 → **0.089** |
| 只看文件名 | 100% | **0%** | 0.602 |

三条结论：

1. **Knit 的排序远强于自己数关键词** —— agent 重算是不理性的
2. **文件名匹配只在名字描述内容时好使**；Knit 是唯一两种都 100% 的
   （这也解释了为什么那个子代理直接 `bash` 就够了：本仓库文档名恰好都描述内容）
3. **自己数的可靠性随规模单调下降**

### 改动：把这三条说出来

- **工具描述**直说「比你自己匹配文件名或数关键词更可靠 —— 优先用它」，
  并点名两个它自己做不到的事：**稀有词权重**与**不依赖文件名**（依旧 59 词，≤60 上限）
- **结果头部**从「`by relevance to …`」改成
  「`ranked by IDF-weighted relevance to … (rare terms weighted, length-normalised —
  not a keyword count or filename match)`」—— 在它**决定要不要重算的那一刻**给出理由

### 注意事项

- ⚠️ **真机验证已完成，结论是「没修好」。** 三个中性提问（不带任何指令）的干净子代理：
  2 个用了 `knit_docs`，**两个都仍然自己 `grep` / `glob` 全库交叉确认**；1 个压根没用工具。
  对照 v0.8 那轮是「2 个用、1 个交叉验证」。所以**「说清排名口径就能少交叉验证」这条假设
  没有被证实** —— 文案这条路试了两轮都没拿到效果，不再试第三轮。
- ⚠️ **宿主半边不热加载，升级后必须重启 DSH**。
- `/knit/api/*` 与面板**零改动**；测试 **215/215**。

### 发布

这一版是 `0.5.1` 之后**第一次真正发布** —— `0.6.0` / `0.7.0` / `0.8.0` / `0.9.0`
此前都只存在于本地仓库，公开仓库停在 `0.5.1`。随本次发布一并补齐：

- **npm `description` 改成先说痛点**（原来是一串功能罗列）：`Find the doc your agent just
  wrote. …` —— npm 搜索结果只截前几十个字符，原写法把这最值钱的位置浪费在复述功能上
- **README 开头**去掉那段自嘲式的长说明（它卡在钩子和安装命令之间）；
  并把 v0.9 的**规模基准**补进「『相关』是怎么算出来的」，中英两版同步

## [0.8.0] - 2026-09-18

**修两个真机验收发现的缺陷。** 排序算法、面板、客户端**零改动**。

### Fixed

- **「按「xxx」排序」那行显示跨词边界的碎片。** 候选分是 `出现次数 × 词长²`，
  所以每个 3-gram 都压过所有 2-gram —— 对「项目文档」这种输入，
  `项目文` / `目文档` 先被选中，真实的 `项目` / `文档` 作为它们的子串被去重叠吞掉，
  面板就成了「按「目文档、项目文」排序」。

  修法是**合并命中词在原文里的区间**：`项目文[0,3)` 与 `目文档[1,4)` 是**重叠**的，
  合并后切原文正好还原出 `项目文档`。**`extractKeywords` 的候选与顺序一字未改**，
  所以排序不受影响（实测 top-1 95.2% / MRR 0.976，与 v0.6 逐字相同）。

  合并结果还必须**真的在项目里出现过**才认。这一步是必需的：3-gram 逐个错位、
  彼此都重叠，所以「重叠就合并」会一路串下去（「悬停浮层是怎么做的」→「悬停浮层是怎」），
  **加长度上限没用**（链条会一直长到上限为止）。代价实测只有 +0.1ms（500 篇 4.3 → 4.4ms）。

  | 查询 | 旧 | 新 |
  |---|---|---|
  | `项目文档 索引` | 目文档、项目文 | **项目文档** |
  | `排序算法 相关性排序 BM25` | bm25、关性排、序算法 | **BM25、排序算法、相关性排序** |
  | `扩展名白名单都放行什么` | 名白名、展名白、扩展名 | **扩展名白名单** |
  | `悬停浮层是怎么做的` | 停浮层、悬停浮 | **悬停浮层** |

  顺带：**「对」移出 `CN_EDGE_STOP`**。它是介词但也是构词成分（对比、对话、对象），
  判在首字会把「对比度」切成「比度」。实测四档裁剪后，**只去掉这一个字就够，
  且排序四项指标一个都没变** —— 再往下裁没有额外收益，停在最小改动。

- **`knit_docs` 的结果看起来「不完整」，agent 每次都要再 glob 一遍交叉验证。**
  真机验收的三个会话里，三次调用之后 agent **三次都又跑了 `find` / `glob` / `grep`**
  来对照。现在结果头部给出总数（`Top 5 of 21 Markdown documents in this workspace, …`），
  描述里也说明它数得全。

### Added

- **`test/label.test.mjs`** —— 标签可读性的回归测试，断言是**双向**的：
  真词必须出现（`expect`）+ **旧碎片必须不出现**（`deny`）。
  v0.6 之所以漏掉这个问题，是因为评测只量了排序、从没量过标签。

### 注意事项

- ⚠️ **问题 2 的修复没有被验证**：单测只能证明「头部现在带总数了」，
  「agent 因此不再交叉验证」必须**再跑一次真机**才能确认。
- ⚠️ **宿主半边不热加载，升级后必须重启 DSH**。
- ⚠️ 残留：**孤立碎片仍可能出现**（如「视频上」），它没有重叠伙伴可合并。
  合并相邻段能修掉它，但会制造更糟的「相关性排」——这个取舍是有意的。
- `/knit/api/*` 的响应**字段没有增删**，只有 `topic` 的取值变准了。

### 测试

**215/215**（新增 9 条）。

## [0.7.0] - 2026-09-18

**把同一份排序也交给模型。** 面板、`/knit/api/*` 响应、客户端**零改动**。

### Added

- **`knit_docs` 工具**（宿主侧，只读）：agent 可以问「这个项目里跟当前话题最相关的
  文档是哪几篇」，拿到按相关性排序的**工作区相对路径 + 标题 + 摘要**。
  - 不传 `query` 就用**当前对话**排序；传了就用 `query`（把 query 当成一条最新消息，
    走完全相同的抽取规则，不引入第二条抽取路径）
  - 对话不足以判断相关性时**如实返回 `mode: 'time'`** 并在文本里说明，
    与面板那行「对话内容暂按最新排序」同一个口径
  - **不返回相关度分数** —— 它是相对分数，给模型看会被当成绝对置信度。
    顺序即相关度，与面板同一条规矩
  - **不返回正文** —— agent 有自己的 `read` 工具；Knit 负责发现，不负责搬运
  - `limit` 默认 5、上限 20；越界回落而不抛错
- 工具与浏览器那半边是**两次独立的 `ctx.inject`**：没有 `tools` 服务时面板照常工作，
  没有 `webServer` 时工具照常注册。

### 注意事项（**升级前请读**）

- ⚠️ **工具描述会进每一次请求的系统提示词**。装 Knit 的用户每个会话多占一点 token ——
  这是「让 agent 有能力」的必要成本，不装作没有。
- ⚠️ **拿不到会话就报错，不兜底**。HTTP 路由在会话查不到时会兜底到进程 cwd
  （兼容不带 `sessionId` 的老客户端）；工具**没有这个包袱** ——
  兜底只会扫到一个不相干的项目并返回它的文档。
- ⚠️ **宿主半边不热加载，升级后必须重启 DSH**。

### 实现说明

- **没有 import `@deepseek-ai/dsh-tools`，手写 `ToolDefinition`。** 原因：Knit 被
  `link:` 挂进 profile，真实路径在 profile 的 `node_modules` **之外**，裸 Node 解析不到
  `@deepseek-ai/*`（实测 `ERR_MODULE_NOT_FOUND`）。手写保持了**零依赖**，
  且三种目录布局下都能跑。
  这不是猜：手写的 `parameters` 与 `output.schema` 已与真实的
  `parameterSchemaSpecToJsonSchema` / `valueSchemaSpecToJsonSchema` 产物**逐字比对通过**，
  并通过了注册期的 `assertSupportedJsonSchema` 与值校验。
- `scan()` 新增可选参数 `options.query`。**HTTP 路由不传它**，所以 `/knit/api/recent`
  的行为逐字不变。

### 测试

**206/206**（新增 20 条工具测试）。

## [0.6.0] - 2026-09-18

**只改排序质量，不加功能、不改界面。** 面板里唯一会变的是**文档的顺序**，
以及那行「按「xxx」排序」显示的词。

### Changed

- **排序从「加权关键词命中」换成 BM25。** 旧做法有三处硬伤：
  没有 IDF（语料里到处都是的词和罕见词同权，高频词于是不产生任何区分度）、
  没有长度归一化（长文档靠堆词就能赢）、命中次数封顶 6 次是手写硬拐点。
  现在每个词先按语料算 IDF，字段内按 BM25 饱和并做长度归一化
  （`k1 = 1.2`，`b` 按标题 / 摘要 / 正文分别为 `0.3 / 0.5 / 0.75`，字段权重仍是 `4 / 2 / 1`）。
- **关键词抽取丢掉跨词边界的碎片。** 中文没有词边界，n-gram 会把相邻两个词的字粘起来
  （「图片和」「个插」「的排」）。它们分数还高，去重叠时会把「图片」「排序」这些真词挤掉 ——
  结果是查询词里几乎没有一个是文档里真有的词。现在**首字或尾字是纯虚词的候选一律丢掉**。
- **「按「xxx」排序」那行改成显示语料里真实存在的词。** 之前会显示成
  「按「图片和、片和视、和视频」排序」这样的碎片；现在同样这句话显示「按「面板里、视频、图片」排序」。
  响应里的 `keywords` 字段同理。

### Added

- **离线质量评测**（`test/eval/`）：21 个「对话片段 → 期望 top-3」用例，
  覆盖纯中文 / 纯英文技术词 / 中英混合 / 高频词陷阱 / 长文档陷阱 / 退化场景，
  并冻结了 v0.5.2 的抽取与排序作为对照（`test/eval/legacy.mjs`）。
  它在 `npm test` 里跑，阈值是**运行时现算的基线 + 固定增幅**，不是写死的数字。

### 实测

同一套语料、同一套用例，两版引擎各跑一遍：

| | top-1 命中 | MRR | 陷阱违例 |
|---|---|---|---|
| v0.5.2（加权命中） | 76.2%（16/21） | 0.830 | 2 |
| **v0.6（BM25）** | **95.2%（20/21）** | **0.976** | **0** |

排序耗时（500 篇 × 2500 字，20 次平均）：旧 3.9ms → 新 4.3ms（+10%，绝对值远低于 30ms 预算）。

### Notes

- **只改宿主半边**（`src/host/relevance.js` 与 `index.js`），客户端未动 ——
  但**宿主半边不热加载，升级后必须重启 DSH**（不是硬刷新浏览器）。
- `/knit/api/*` 的响应形状**未变**：`score` 仍是 `0–100` 或 `null`，
  `mode` / `topic` / `keywords` / `docs[]` 字段都在，只是取值更准了。
- 相关度**仍然不做可视化** —— 名次即相关度。
- 测试 **186/186**。

## [0.5.2] - 2026-09-18

### Added

- **阅读态**：正文滚动超过 4px 后，预览面板底色从分层灰**过渡**到纯阅读底色
  （浅色 `#fff` / 暗色 `#151517`）—— 灰底是为了让预览与列表分层，但读起来对比度弱，
  给个过渡两者兼得；换一篇回到分层灰。
  **记的是「哪一篇被滚过」，存在模块级 `readingDocs` 集合里**（key = `sessionId + rel`），
  不是组件 state —— 宿主重挂载不会把它清零，鼠标移出面板再回来仍是阅读底色。
- **点预览头的路径打开这篇文档**：用系统默认应用打开当前预览的本地文档，
  新增 i18n 键 `preview.openLocal`（中英同步）。

### Changed

- **灰底降档**：悬停 / 选中的中性灰在 DSH 令牌透明度上**各降一档**
  （悬停保留 40%、选中保留 60%），两个主题各一套 `--knit-hover-bg` / `--knit-active-bg`。
  起因是默认那档太灰，读文档时对比度被吃掉。
- 去掉排序依据那行顶着的 `🤖` 装饰符号，`topic.relevance` / `topic.relevancePlain`
  中英四条现在都是纯文字。

### Notes

- **只改客户端半边**（`src/client/client.js`），宿主未动 ——
  升级后硬刷新浏览器即可，不需要重启 DSH。
- 本版把工作区里一批已完成但一直未提交的改动落盘，测试 **174/174** 全绿。

## [0.5.1] - 2026-09-16

### Fixed

- **测试不再依赖仓库目录布局。** 原先样本工作区写成 `new URL('../../', import.meta.url)`，
  也就是**包根的上一层目录** —— 在作者本机那是 `08_Knit/`（恰好有 Markdown 与截图样本），
  但别人 `git clone` 公开仓库时那是 clone 的**父目录**，从 npm 装进 `node_modules/` 时
  那是 `node_modules/`，两处都没有样本，于是 `npm test` 在 clone 里 160/162、
  在装好的包里 157/162。
  现在由新增的 `test/fixture.mjs` 在临时目录自造样本工作区（3 篇 Markdown、一张图、
  一个非媒体文件，mtime 用 `utimes` 定死以免排序断言看运气），
  三种布局下都是 **162/162**。顺带去掉了对 `docs/screenshot.png`（193 kB）与
  `08_Knit/` 私有内容的依赖 —— 包的体积只增加 1 kB。
- 运行时代码（`src/`）与 `assets/` **逐字节零改动**，插件行为与 `0.5.0` 完全一致。

### Notes

- 这是一次测试与发布质量修正，**没有新功能、没有行为变更**。
  因此若你正在用 `0.5.0`，没有升级的必要。

[0.5.1]: https://github.com/PolinniZhong/dsh-knit/releases/tag/v0.5.1

## [0.5.0] - 2026-09-16

### Added

- **图片与视频管理**：排序栏下新增「文档 / 图片与视频 / 全部」类型切换（偏好记进
  localStorage，默认仍是文档，老体验与悬停浮层完全不变）
- **图片与视频视图**：方形圆角缩略图网格。**最少 3 列**（面板再窄也不掉到 1~2 列），
  只有变宽才加列（上限 4 列）；格子 **64px 起步**；一屏基准 **8 个**（4 列 × 2 行），
  超过 8 个**一个都不隐藏**，而是整块等比缩小（此时卡片文字让位给缩略图）。
  列数与格子边长是同一个约束，由 `mediaLayoutFor(width, count)` 一次算出后以 CSS 变量下发，
  CSS 只留一行 `repeat(3,1fr)` 兜底。视频用 `<video preload="metadata" src#t=0.5>`
  让浏览器直接解出**首帧**当海报，中央叠播放三角、右下角叠 `m:ss` 时长角标
  —— 零依赖、零转码、宿主不解析容器
- **就地预览图片 / 视频**：点缩略图在下方预览面板看大图或直接播放
  （`<video controls>`，静音自动播放以满足浏览器策略），双击仍在新标签打开
- **「全部」视图分上下两区**：文档区最多 4 条，超出时标题右侧给「查看全部 →」切到文档分类；
  图片视频区**不截断**（只给「已显示 / 总数」计数），超过 8 个与媒体视图同样等比缩小
- 宿主扫描从「只收 Markdown」泛化为一次 BFS 同时收 `.md` 与媒体，共享深度 ≤ 6 /
  目录 ≤ 500 / 4s 预算，文档与媒体各自上限 400；媒体**只 stat 不读内容**，只靠文件名参与相关性
- `/raw` 接口支持图片 + 视频白名单（视频 `mp4/m4v/webm/mov/ogv`、≤ 256MB；图片 ≤ 12MB），
  并支持 **HTTP Range（206 Partial Content）**：视频首帧与拖动按需取字节，
  `createReadStream` 流式返回、客户端断开即销毁流，不全量读进内存
- 新增错误码 `knit/media-only`、`knit/media-too-large`，中英双语齐全
- 列表接口新增 `kind=doc|media|all` 参数（缺省 / 非法均回落 `doc`），载荷每项带 `kind` 与 `size`

### Changed

- 面板里的硬编码强调色全部清掉。类型切换的选中态一开始写死紫色，被否（「太突兀了」）；
  换成品牌蓝描边后又被否（「不用加绿色、蓝色的描边，就跟下面列表一样，选中填充背景灰就可以」），
  最终与列表行、排序切换统一用 DSH 的中性令牌（`--dsw-alias-interactive-bg-active` / `-hover`），
  **灰底、不带任何彩色描边**。另有第二套写死的蓝（文档行选中、拖拽条悬停、聚焦圈）
  也一并收进主题令牌
- 品牌色只保留「正在预览」这一处语义：文档行与媒体卡片的那条描边
- 「正在预览」与「键盘焦点」拆开：后者只用中性描边，
  不再让键盘上下移动看起来像「选中了」
- 「全部」不再使用紧凑媒体行（该组件及其样式已删除），媒体一律出方形卡片
- 修掉一处静默样式丢失：`.knit-doc.active` 引用的 `--knit-accent-fill` 已在重构中被删除，
  而未定义变量会让 `background` 整条声明作废（invalid at computed-value time）。
  现已改用中性令牌，并补了「凡 `var(--knit-*)` 无 fallback 就必须有定义」的测试守卫

### Notes

- 视频首帧与时长依赖浏览器对 `<video preload="metadata">` 的支持；宿主页面 CSP 是否放行
  同源媒体（`media-src`）需在真机确认，图片同源已可用
- 安全口径不变：仅监听本机回环、仅 GET、路径越界一律拒绝、扩展名白名单、
  `nosniff` 与 `default-src 'none'; sandbox` 响应头保留

[0.5.0]: https://github.com/PolinniZhong/dsh-knit/releases/tag/v0.5.0

## [0.4.0] - 2026-09-15

首个公开版本。

### Added

- **按当前对话的相关性排序**（纯本地关键词匹配，零模型调用）：标题 ×4 / 摘要 ×2 / 正文前
  2500 字 ×1 加权命中，单词命中封顶 6 次，叠 10% 时间新鲜度微调
- 相关性 / 修改时间双模式一键切换（偏好记在 localStorage）
- 扫描会话工作区内所有 `.md`（递归，深度 ≤ 6，跳过 `node_modules` / `.git` / `dist` 等）
- 每项显示 H1 标题（无则文件名）+ 相对时间 + 首段摘要
- 单击就地展开预览，再点收起
- **相对路径图片真实渲染**（`./img/a.png`、`../assets/b.png`）
- 预览面板可拖高度（夹在 20%–80%，位置记进 localStorage）、可全屏，`Esc` 退出
- 双击在新标签页打开
- 过滤框：按标题 / 摘要 / 路径实时过滤
- 键盘导航：`↑` `↓` 移动即预览 / `Enter` 切换 / `Esc` 收起
- 每 5 秒自动刷新 + 手动刷新；2 分钟内改动过的文档打 🆕
- 会话头部右侧的 Knit 图标入口（`conversation.session.header.utilities`）
- 中英双语，跟随 DSH 语言实时切换（`ctx.locale`，命名空间 `knit`）
- mono 图标，浅色纯黑 / 暗色纯白，四个位置统一
- 双宿主：DSH 自带右侧栏 + `dsh-better-sidebar`（均为可选依赖）
- 对话不足时退回按修改时间排序，并在面板上说明

### Notes

- 零依赖、无安装脚本、无对外网络请求
- 宿主半边改了需要重启 DSH，客户端半边硬刷新浏览器即可
- 相关度不做可视化（不显示百分比、不画长条）—— 排序本身就是答案

[0.4.0]: https://github.com/PolinniZhong/dsh-knit/releases/tag/v0.4.0
