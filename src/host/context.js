/**
 * Knit · **上下文装配**（v0.14）
 *
 * ## 这一层是干什么的
 *
 * Retrieval 回答「哪几篇跟这段对话最像」，本模块回答**另一个问题**：
 *
 * > 这个任务，项目里哪些东西**最值得先看**，哪些是证据与实现支撑，哪些只是相关资料。
 *
 * 它是一层**纯投影**：输入是 `rankByRelevance()` 已经算好的名次与命中词、
 * 以及 `links.js` 已经解出来的引用图，输出是三层 Context Pack。
 * **不重新扫工作区、不重新打分、不引入新的相似度。**
 *
 * ## 三条硬约束（都是产品决定，不是实现细节）
 *
 * 1. **零模型、零网络。** 分层全部由下面的确定性规则算出，每一层都能说出
 *    「它凭什么在这里」。不是 embedding，不是 LLM rerank，不是「AI 判断」。
 * 2. **不出新分数。** 对外只给名次与理由，不给 `contextScore = 87.6` ——
 *    相关度是相对量，名次本身就是答案（v0.5 起就守着的口径，见 AGENTS.md §6.6）。
 * 3. **确定性。** 相同输入必然产出逐字相同的顺序。所有并列都有显式兜底键。
 *
 * ## 三层各自的判据
 *
 * | 层 | 什么时候进 | 上限 |
 * |---|---|---|
 * | **Primary**（主要上下文） | 命中，**且**有「落脚点」（有个话题词命中标题或摘要），**且**相关度不是背景噪音（≥ 最高分的 30%） | 3 |
 * | **Supporting**（辅助上下文） | 对某个「焦点词」有**深入命中**（该词不止一篇在讲，而且这一篇是把它**讲得最多**的那一篇）；**或**与某个 Primary 有引用关系 | 5 |
 * | **Related**（相关上下文） | 其余有命中的条目，然后才是其余的引用邻居与零命中项 | 12 |
 *
 * 两个概念都是**可解释、无阈值**的，这是这一层能用一句话讲清的前提：
 *
 * - **落脚点**：作者把话题词写进了标题或摘要 —— 这是「这篇就是在讲这件事」的
 *   最直接的作者信号。只在正文里提到一次不算。
 * - **焦点词**：一个话题词在这批结果里**至少两篇**命中。只在一篇里出现的词
 *   要么是罕见词（那一篇就是答案），要么是噪音；只有「不止一篇在讲」的词
 *   才能把一个正文命中抬到 Supporting。用**结果集内部**的提及次数而不是语料频率，
 *   是因为前者与「这批结果正在讨论什么」严格同源，不用挑一个 df 比例。
 * - **深入命中（docHit）**：焦点词还不够，这一篇得是把它**讲得最多**的那一篇
 *   （正文字频等于全批最大，且至少 2 次）。这一条是实测补的，也是整个分层里
 *   最关键的一条 —— 它把「什么话题都提一句」的归档长文彻底挡住：
 *   长文里每个话题词各出现一次，而真正在讲这件事的文档最少也有两三次。
 *   没有它，长文会出现在**每一条**任务的 Supporting 里，把真正的支撑材料挤掉。
 *
 * ⚠️ 这套规则是**实测调出来的**，不是拍脑袋。三条真实教训：
 *   1. 只要求「命中 ≥2 个话题词」时，满篇话题词的 `CHANGELOG.md` 与
 *      「什么话题都提一句」的长归档会霸占 Primary（实测：任务 2/4/7 全红）。
 *      ⇒ Primary 必须有落脚点。
 *   2. 落脚点单独用也不够：摘要里正好出现话题词的文档也会被抬进 Primary
 *      （实测任务 3 / 9 / 10 全红）。⇒ 再加一条相对强度下限。
 *   4. 只看「有没有出现」还不够：每个话题词各提一句的归档长文会进每一条任务的
 *      Supporting。⇒ 焦点词还要在正文里出现 ≥2 次（`STRONG_BODY_TF`）。
 *   3. 强度下限**不能太高**：「取一半」会误杀同一话题下的第二篇
 *      （实测任务 5 的第二篇只有最高分的 27%）。取 30% 刚好分开两者。
 *
 * ## 引用关系只是上下文信号，不是「更相关」
 *
 * `links.js` 的文件头已经用实测写过：把引用图当排序信号**补不上**词面错配那个缺口
 * （目标文档 BM25 第 45 名 → 融合后最好第 8 名，从未进 top-5）。
 * 所以这里**不许**引用关系把一篇文档抬进 Primary —— 它只能把一篇文档
 * 放进 Supporting / Related。反过来，「被 Primary 引用」是个很强的**阅读顺序**信号：
 * 你读主文档时就会看到那条路径，它就是下一步该打开的东西。
 *
 * ## 已知边界（不要读成缺陷报告，是如实记录）
 *
 * - **不做符号级理解。** v0.19 起代码文件可以进语料，但进来的只是
 *   「文件名 + 路径 + 正文前 N 字符」这一层词面信息 —— **没有 AST、没有符号表、
 *   没有调用图**（那是后续 Deep Retrieval 的方向，不是 v0.19）。所以
 *   「Supporting = 实现文件」现在可以由**代码文件本身**承担，但它凭什么进这一层
 *   仍然是 BM25 的命中，不是「谁调用了谁」。
 * - **不做任务理解。** `task` 字段是**引用**，不是推断：它由调用方传入
 *   （`index.js` 取「最新一条有实质内容的用户消息」原文），本模块只负责透传，
 *   **永远不生成**任务描述 —— 那需要模型，违反约束 1。
 *   没有可引用的用户消息时它就是空串，界面与工具都照常工作。
 * - **媒体不参与分层。** 图片/视频的 haystack 只有文件名，命中即命中，
 *   但把它们排进「先看哪几篇」没有意义，所以不放进 Context Pack。
 * - **不判断「够不够」**。Primary 一篇都没有也要照常交付（三层全空就是全空）——
 *   硬凑一篇「看起来像主文档的」是编造。`MAX_PRIMARY = 1` 是上限，不是指标。
 */

// v0.19：理由码要按条目类型分叉（Markdown 说「标题 / 摘要」，代码说「文件名 / 路径」），
// 所以这里要看条目的 `kind`。**看的是分类层给的常量，不是裸字符串** ——
// 本文件里出现的单引号字母串会被 `test/i18n.test.mjs` 当作理由码抽出来（那正是它的用途），
// 在这里写 `doc.kind === 'code'` 会让 `code` 被误认成一个理由码。
// `classification.js` 零依赖，import 它不会成环。
import { KIND_CODE } from './classification.js'
// v0.21：关系**只做投影**（见 D2）。它读的是一份已经算好的「谁提到谁」事实表，
// 不参与任何分层判断 —— 所以这里 import 它不会让排序多一条路径。
import { MAX_RELATIONS_PER_ITEM, relationsOf } from './relations.js'

/* ── 上限（对外契约的一部分，测试直接断言它们）───────────────── */

/**
 * Primary 最多几项。
 *
 * **1** —— PRD §5「Primary = Top 1 relevant artifact」、SDD §25「primary <= 1」。
 * 为什么是 1 而不是 3：Design §30 的完成标准是用户第一眼看到
 * 「这个任务，现在应该先看**这一篇**」。给三篇等于把「哪篇最重要」这个判断
 * 又推回给用户 —— 那正是 Context Pack 要替掉的东西。
 *
 * 实现上它是「名次最靠前、且**通过落脚点与强度闸门**的那一篇」（见下面 `classifyPrimary`
 * 附近的循环）。SDD §6 的字面规则是 `Primary = rankedDocs[0]`；两者在
 * 「榜首本身合格」时完全一致，只有在榜首是污染源（README / 什么都提一句的长文）
 * 时才分叉 —— 那种情况下本实现给出后面那篇真正在讲这件事的，而不是空手。
 */
export const MAX_PRIMARY = 1

/** Supporting 最多几项 —— PRD §5「0 ~ 3」。超过 3 项就不再是支撑，而是第二份清单了。 */
export const MAX_SUPPORTING = 3

/** Related 最多几项 —— PRD §5「0 ~ 5」。 */
export const MAX_RELATED = 5

/**
 * 进 Primary 的相对强度下限：`raw / maxRaw`。
 *
 * 低于这条线的条目是「标题里正好出现了这个词」的背景噪音
 * （比如一篇讲 npm 的文档，摘要里恰好有一句「图片与视频」）。
 *
 * 取 30% 是**实测定下来的**：
 *   - 取 50% 会误杀同一个话题下的第二篇（实测只有最高分的 27%）；
 *   - 去掉这条（0%）会让任务 3、9、10 的 Primary 被误判。
 * 30% 刚好把「这一类噪音」与「同一话题的第二篇」分开。
 */
const PRIMARY_MIN_SHARE = 0.3

/**
 * 一个话题词要算「焦点词」，至少得在这批结果里的几篇命中。
 * = 1 篇（提问者自己提到的那篇）+ 1 篇以上（项目里真的还有别处在讲它）。
 */
const FOCUS_MIN_DOCS = 2

/**
 * 进 Supporting 的正文命中，同一个词至少要在正文里出现几次。
 *
 * `2` 是**实测定下来的**：取 `1` 时「什么话题都提一句」的归档长文会进每一条任务的
 * Supporting；取 `3` 会误杀合理的支撑材料（`docs/api-contract.md` 在任务 3 里
 * 「返回」正好 2 次）。见 `context.js` 文件头「三个真实教训」。
 */
const STRONG_BODY_TF = 2

/** 判定「话题词」时最多回看多少条结果 —— 名次更靠后的提及不构成焦点。 */
const FOCUS_WINDOW = 8

/* ── 代码角色识别 ───────────────────────────────────── */

/**
 * 角色规则表。**顺序即优先级** —— 一篇文章同时像测试又像文档时，
 * 靠前的赢，保证同一篇每次拿到同一个角色。
 *
 * 这些不是「智能识别」：就是路径与文件名的字面规则，可以逐条解释给用户听。
 * 放在 Markdown 语料上，命中的多是 SDD / 设计笔记这类**描述实现**的文档 ——
 * 「对应实现文件」这句解释说的正是「它是那份实现的文字载体」。
 *
 * ⚠️ `design` 必须排在 `impl` **前面**，因为两条规则可能同时命中一条完整路径 ——
 * 例如 `src/host/design.md` 既在 `src/` 下、文件名又明说「这是设计」，必须取 `design`。
 * 顺序写反时，`design` 永远轮不到。
 * （注意 `docs/relevance-algorithm.md` **不属于**这种冲突：它两条规则只命中 `impl` 一条 ——
 * 「文档里描述了某个模块」就是 impl 角色的本意，见 `test/context.test.mjs` 的对照断言。）
 */
const SOURCE_RULES = [
  // 测试 / 评测 / 夹具。分隔符允许 `/` 与 `-`：`test/` 与 `eval-benchmark.md` 都是真实写法。
  { type: 'test', re: /(^|[\/-])(test|tests|spec|specs|__tests__|eval|evals|fixtures?)([\/-]|$)|[.-](test|spec)\.|fixture/i },
  // 配置 / 契约 / 清单
  { type: 'config', re: /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|cordis\.patch\.yml|tsconfig|\.github)(\/|$|\.)|(^|\/)(config|settings|manifest)/i },
  // 设计 / 决策 / 复盘
  { type: 'design', re: /(sdd|prd|rfc|adr|design|spec-|方案|设计|决策|复盘)/i },
  // 实现 / 宿主 / 接口
  { type: 'impl', re: /(^|\/)(src|lib|host|client|impl|runtime)(\/|$)|(^|\/)(api|tool|links|relevance|context|index)[\w.-]*\.md$/i },
  // 文档 / 说明 / 清单
  { type: 'doc', re: /(^|\/)(docs?|guide|manual|readme|changelog|notes?)[\w.-]*\.md$|readme|changelog|\.md$/i },
]

/**
 * 判定一篇文档在项目里是什么角色。
 * @param {string} rel - 工作区相对路径
 * @returns {'impl'|'test'|'config'|'design'|'doc'} 角色
 */
export function sourceTypeOf(rel) {
  const value = String(rel || '')
  if (!value) return 'doc'
  for (const rule of SOURCE_RULES) {
    if (rule.re.test(value)) return rule.type
  }
  return 'doc'
}

/* ── 与 Primary 的引用关系 ─────────────────────────── */

/**
 * 把引用图里某一篇的邻居取出来（出边 + 入边），去重、去掉自己。
 *
 * 图可能不存在（`/api/recent` 那条路不建图，成本要留给真正需要的接口），
 * 这时返回空集合 —— 分层退化成「只看命中」，而不是报错。
 *
 * @param {object|undefined} graph - `buildLinkGraph()` 的产物
 * @param {string} rel - 文档 rel
 * @returns {Set<string>} 邻居 rel 集合
 */
function neighboursOf(graph, rel) {
  const out = new Set()
  if (!graph || !(graph.out instanceof Map) || !(graph.in instanceof Map)) return out
  for (const side of [graph.out.get(rel), graph.in.get(rel)]) {
    if (!(side instanceof Set)) continue
    for (const other of side) {
      if (other && other !== rel) out.add(other)
    }
  }
  return out
}

/* ── 理由（为什么它在这个包里）─────────────────────── */

/**
 * 命中词分几个字段。
 * @param {{title:boolean,summary:boolean,body:boolean}|undefined} fields - 字段位图
 * @returns {number} 0..3
 */
function fieldCount(fields) {
  if (!fields) return 0
  return (fields.title ? 1 : 0) + (fields.summary ? 1 : 0) + (fields.body ? 1 : 0)
}

/**
 * 给一篇文档算「它凭什么在这个包里」。
 *
 * 返回值是一个**结构化理由**：`{ code, terms, fields }`。
 * 文案不由宿主生成 —— 宿主只给码，界面语言由客户端词典负责（AGENTS.md §4.5）。
 *
 * 判定顺序是**固定的**，所以同一篇文档每次拿到同一个理由：
 *
 *   1. `direct`      —— 命中标题，且命中 ≥2 个话题词：作者把它写进标题、你还问了不止一个词
 *   2. `titleMatch`  —— 命中标题（**代码**文件名沿用同一条判据，码是 `filenameMatch`）
 *   3. `summaryMatch`—— 命中摘要（没有标题命中时；**代码**的「摘要」是所在目录，
 *                        码是 `pathMatch`）
 *   4. `bodyMatch`   —— 只在正文命中（`fields` 是**焦点词**的正文命中个数，能区分
 *                        「真的在讲」与「正文里蹭了一下」，且不暴露 BM25 分数）
 *   5. `linkTarget`  —— 被某个 Primary 引用
 *   6. `linkSource`  —— 引用了某个 Primary
 *   7. `related`     —— 兜底：名次靠后的命中项
 *
 * v0.19 给代码换的只是**两个码的名字**，不是两套判据 —— 命中位置完全一样
 * （文件名占的是 `title` 槽、目录占的是 `summary` 槽，见 `index.js` 的 `readCode()`）。
 * 换名字是为了让界面能说人话：对 `context-manager.ts` 说「标题命中」是错的，
 * 它的「标题」就是文件名。**判据没有分叉，只有称谓分叉。**
 *
 * @param {object} doc - 记录（`{rel, kind, matchedTerms}`；`matchedTerms[].fields` 是字段位图）
 * @param {{linkTarget?:boolean, linkSource?:boolean}} [links] - 与 Primary 的关系
 * @returns {{code:string, terms:string[], fields:number, term:string}} 理由
 */
export function explainContext(doc, links = {}) {
  const terms = Array.isArray(doc && doc.matchedTerms) ? doc.matchedTerms : []
  const isCode = Boolean(doc && doc.kind === KIND_CODE)
  const names = terms.map((t) => t.term)
  const merged = { title: false, summary: false, body: false }
  let titleTerm = ''
  let bodyTerm = ''
  let bodyHits = 0
  for (const entry of terms) {
    const fields = entry.fields || {}
    // 只记「有没有命中」，不记次数 —— 次数是 BM25 的内部量，不对外。
    if (fields.title) {
      merged.title = true
      if (!titleTerm) titleTerm = entry.term
    }
    if (fields.summary) merged.summary = true
    if (fields.body) {
      merged.body = true
      bodyHits += 1
      if (!bodyTerm) bodyTerm = entry.term
    }
  }
  const total = fieldCount(merged)

  if (merged.title) {
    return {
      code: merged.title && names.length >= 2
        ? 'direct'
        : (isCode ? 'filenameMatch' : 'titleMatch'),
      terms: names,
      fields: total,
      term: titleTerm || names[0] || '',
    }
  }
  if (merged.summary) {
    return { code: isCode ? 'pathMatch' : 'summaryMatch', terms: names, fields: total, term: names[0] || '' }
  }
  if (names.length > 0) {
    return { code: 'bodyMatch', terms: names, fields: bodyHits, term: bodyTerm || names[0] }
  }
  if (links.linkTarget) return { code: 'linkTarget', terms: [], fields: 0, term: '' }
  if (links.linkSource) return { code: 'linkSource', terms: [], fields: 0, term: '' }
  return { code: 'related', terms: [], fields: 0, term: '' }
}

/**
 * 理由的强弱：越小越靠前。仅用于**同一层内**排序时的兜底（名次相同时才看它），
 * 不是分数，也不对外暴露。
 */
const REASON_ORDER = {
  direct: 0,
  titleMatch: 1,
  // 代码的「文件名命中」与 Markdown 的「标题命中」是同一条判据（见 `explainContext()`），
  // 所以强弱同级 —— 不能因为它是代码就排前面或后面。
  filenameMatch: 1,
  summaryMatch: 2,
  pathMatch: 2,
  bodyMatch: 3,
  linkTarget: 4,
  linkSource: 5,
  related: 6,
}

/**
 * 靠**引用关系**进包的那几个理由码。
 *
 * v0.21 用它把「这条是从哪来的」落成 §6.5 的三值之一：
 * 命中关键词是 `retrieval`，靠关系进来的是 `relation`，用户自己钉的是 `manual`
 * （`manual` 由调用方在装配**之后**改，本模块不认识「固定」这件事 —— 那是控制层的活）。
 *
 * ⚠️ 名字是 `provenance`，**不是** `source`：条目上的 `source` 早在 v0.14 就有，
 * 指的是**文件角色**（`impl` / `test` / `config` / `design` / `doc`，见 `sourceTypeOf()`），
 * 与「来源」是两件事。改那个字段的语义会静默打断客户端与工具 schema，所以另起一个名字。
 */
const RELATION_REASON = new Set(['linkTarget', 'linkSource', 'related'])

/* ── 主函数 ─────────────────────────────────────────── */

/**
 * 从一次检索结果装配出 Context Pack。
 *
 * **纯函数**：不读盘、不看时钟、不发请求。`ranked` 必须是
 * `rankByRelevance()` 的文档数组（已按相关度降序，且带 `matchedTerms`）。
 *
 * @param {object} input - 装配输入
 * @param {Array<object>} input.ranked - 相关度降序的文档（`rankByRelevance().docs`）
 * @param {string} [input.topic] - 当前话题标签（`topicLabel()` 的产物）
 * @param {object} [input.graph] - `buildLinkGraph()` 的产物；不给就退化成「只看命中」
 * @param {Map<string, Array<object>>} [input.relations] - v0.21：`buildRelationFacts()`
 *   的 `incident`（谁提到谁）。**只用来给已经进包的条目补一段可核验的关系**，
 *   不参与任何分层判断；不给就是「这个包不投影关系」。
 * @param {number} [input.maxPrimary] - 覆盖 Primary 上限（默认 `MAX_PRIMARY` = 1）
 * @param {number} [input.maxSupporting] - 覆盖 Supporting 上限（默认 `MAX_SUPPORTING` = 3）
 * @param {number} [input.maxRelated] - 覆盖 Related 上限（默认 `MAX_RELATED` = 5）
 * @param {number} [input.total] - 整个工作区一共有多少篇（只进 `totals.total`）
 * @param {string} [input.task] - 当前任务的**原文引用**（最新一条有实质内容的用户消息）。
 *   本模块不生成它、也不改写它；不给就是空串。
 * @returns {object} Context Pack（见文件头；`items` 里只有 `rel/title/summary/mtimeMs/kind/source/reason`）
 */
export function buildContext(input = {}) {
  const ranked = Array.isArray(input.ranked) ? input.ranked.filter(Boolean) : []
  const graph = input.graph
  const incident = input.relations instanceof Map ? input.relations : null
  const topic = typeof input.topic === 'string' ? input.topic : ''
  // `task` 原样透传 —— 它可能很长、可能为空，这里一个字都不加工（加工就是编造）。
  const task = typeof input.task === 'string' ? input.task : ''
  const capPrimary = Number.isInteger(input.maxPrimary) && input.maxPrimary > 0
    ? input.maxPrimary : MAX_PRIMARY
  const capSupporting = Number.isInteger(input.maxSupporting) && input.maxSupporting > 0
    ? input.maxSupporting : MAX_SUPPORTING
  const capRelated = Number.isInteger(input.maxRelated) && input.maxRelated > 0
    ? input.maxRelated : MAX_RELATED

  const topRaw = ranked.reduce((max, doc) => Math.max(max, Number(doc.raw) || 0), 0)

  // 内部记录：**只带下游真正要用的字段**，不把 haystack / matchedTerms / raw 传出去。
  const records = ranked.map((doc, index) => {
    const terms = Array.isArray(doc.matchedTerms) ? doc.matchedTerms : []
    const fields = { title: false, summary: false, body: false }
    for (const entry of terms) {
      const f = entry.fields || {}
      if (f.title) fields.title = true
      if (f.summary) fields.summary = true
      if (f.body) fields.body = true
    }
    const raw = Number(doc.raw) || 0
    return {
      rel: String(doc.rel || ''),
      title: String(doc.title || doc.name || doc.rel || ''),
      summary: doc.summary == null ? '' : String(doc.summary),
      mtimeMs: Number.isFinite(doc.mtimeMs) ? doc.mtimeMs : 0,
      kind: doc.kind || 'md',
      source: sourceTypeOf(doc.rel),
      terms: terms.map((t) => t.term),
      // 逐词的字段位图，原样留着给 `explainContext()` 用（合并后的 `fields` 只服务分层判断）
      termFields: terms.map((t) => ({ term: t.term, fields: t.fields || {} })),
      // v0.20（D5）：逐词的「单窗口内最大字频」，由宿主（`passage.js` 的
      // `passageTfOf()`）算好带进来。**只在函数内部用来判 `isDocHit`**，不出现在
      // 任何返回值里；缺失（合成夹具、老的调用方）时 `isDocHit` 退回整篇字频。
      passageTf: doc.passageTf && typeof doc.passageTf === 'object' ? doc.passageTf : null,
      fields,
      raw,
      // 相关度带宽（占本批最高 raw 的比例）。**只在函数内部用来判 Primary 的强度下限**，
      // 不出现在任何返回值里。
      strength: topRaw > 0 ? raw / topRaw : 0,
      rank: index,
    }
  })

  // 命中了话题的篇（`raw > 0`）。**只有它们才有资格进任何一层** ——
  // 零命中的文档只能靠「与 Primary 的引用关系」被带进 Supporting / Related（见下）。
  const hit = records.filter((r) => r.raw > 0)

  /* ── 焦点词 ─────────────────────────────────────────
   * 一个话题词在这批结果的前 `FOCUS_WINDOW` 篇里**至少两篇**命中，才算「项目里真的
   * 还有别处在讲它」—— 只有它才能把一个**正文**命中抬到 Supporting。
   *
   * 为什么用「结果集内部的提及次数」而不是语料 df 比例：结果集就是「这批结果正在
   * 讨论什么」的直接证据，两者同源；而 df 比例要挑一个（0.2？0.3？）拍出来的阈值。
   */
  const mentionCount = new Map()
  for (const record of records.slice(0, FOCUS_WINDOW)) {
    for (const term of record.terms) mentionCount.set(term, (mentionCount.get(term) || 0) + 1)
  }
  const isFocusTerm = (term) => (mentionCount.get(term) || 0) >= FOCUS_MIN_DOCS

  /**
   * 落脚点：有没有话题词命中**标题或摘要**。
   * 这是「这篇就是在讲这件事」的作者信号 —— 只在正文提一句不算。
   */
  const grounded = (record) => record.fields.title || record.fields.summary

  /* ── 深入命中（docHit）─────────────────────────────
   * 一个焦点词还要满足：这一篇是**把它讲得最多**的那一篇（全批正文字频最大），
   * 且至少 `STRONG_BODY_TF` 次。
   *
   * 这条是分层里最关键的一道闸门，也是**实测定下来的**：
   * `FOCUS_MIN_DOCS` 只证明「不止一篇提到它」，证明不了「这一篇在讲它」。
   * 「什么话题都提一句」的归档长文满足前一条（每个词都提到一次），
   * 但每一个词都在别处被讲得更多 —— 于是它对**任何**任务都进不了 Supporting。
   * 没有它，那篇长文会出现在每一条任务的 Supporting 里。
   *
   * 用的是**正文字频**（不是 BM25 分数），不进对外输出，只决定资格。
   *
   * ⚠️ v0.20（D5）改了「字频」的口径：优先用**单窗口内最大字频**
   * （`record.passageTf`，由 `passage.js` 的 `windowTf()` 算），只有在没有这份
   * 数据时才退回整篇字频。原因是整篇字频**不是长度无关的**：v0.19 里正文只取
   * 前 2500 字，这个缺陷被窗口意外掩盖；v0.20 打开窗口后，29000 字的 CHANGELOG
   * 里一个词出现 3 次就会压过真正聚焦的短文，于是它对**每个**任务都满足闸门 ——
   * 正是这段注释开头说的那个要防的场景（需求 §9）。
   */
  const passageTfIn = (record, term) => {
    const tf = record.passageTf
    if (!tf || typeof tf !== 'object') return null
    const v = tf[term]
    return Number.isFinite(v) ? v : null
  }

  const maxBodyTf = new Map()
  const maxPassageTf = new Map()
  for (const record of records) {
    for (const entry of record.termFields) {
      const f = entry.fields || {}
      if (!f.body) continue
      const tf = f.bodyTf || 0
      const best = maxBodyTf.get(entry.term) || 0
      if (tf > best) maxBodyTf.set(entry.term, tf)
      const pt = passageTfIn(record, entry.term)
      if (pt != null) {
        const bestPt = maxPassageTf.get(entry.term) || 0
        if (pt > bestPt) maxPassageTf.set(entry.term, pt)
      }
    }
  }
  const isDocHit = (record) => record.termFields.some((entry) => {
    const f = entry.fields || {}
    if (!f.body) return false
    // v0.20：有片段数据就按「单窗口内最大字频」比，没有就退回整篇字频（v0.19 口径）。
    const pt = passageTfIn(record, entry.term)
    if (pt != null) return pt >= STRONG_BODY_TF && pt >= (maxPassageTf.get(entry.term) || 0)
    const tf = f.bodyTf || 0
    return tf >= STRONG_BODY_TF && tf >= (maxBodyTf.get(entry.term) || 0)
  })

  /* ── Primary ────────────────────────────────────────
   * 三个条件**同时**成立才进 —— 见文件头表格。`capPrimary` 是硬上限。 */
  const primary = []
  const bodyOnly = []
  for (const record of hit) {
    const qualifies = grounded(record) && record.strength >= PRIMARY_MIN_SHARE
    if (qualifies && primary.length < capPrimary) primary.push(record)
    else bodyOnly.push(record)
  }

  // Primary 之间：先按名次（相关度本身就是主排序）。
  // ⚠️ **不要**为了「看起来更像主文档」再按词的个数排一次 —— 那是第二套打分。
  primary.sort((a, b) => a.rank - b.rank)

  const primaryRels = new Set(primary.map((r) => r.rel))

  /* ── Supporting ─────────────────────────────────────
   * 两种来源：① 有**焦点词的正文命中**（真命中，只是没有落脚点）；
   * ② 与某个 Primary 有引用关系。② 里可能包含**零命中**的文档
   * （比如 README 引用了主文档）—— 它们的理由会是 `linkTarget` / `linkSource`，
   * 而不是伪装成命中。 */
  const supporting = []
  const seenSupporting = new Set(primaryRels)
  for (const record of bodyOnly) {
    if (supporting.length >= capSupporting) break
    if (!isDocHit(record)) continue
    if (seenSupporting.has(record.rel)) continue
    seenSupporting.add(record.rel)
    supporting.push({ record, linkTarget: false, linkSource: false })
  }

  const byRel = new Map(records.map((r) => [r.rel, r]))
  const linkedToPrimary = []
  if (graph instanceof Object && supporting.length < capSupporting) {
    // 邻居按「对方的 BM25 名次」排 —— 名次靠前的先看，且顺序确定。
    const seenLink = new Set()
    for (const anchor of primary) {
      for (const other of neighboursOf(graph, anchor.rel)) {
        if (seenLink.has(other) || primaryRels.has(other)) continue
        seenLink.add(other)
        const record = byRel.get(other)
        // 图里有、但这一批语料里没有的（被 limit 切掉的）不硬凑。
        if (!record) continue
        linkedToPrimary.push({
          record,
          linkTarget: (graph.out.get(anchor.rel) || new Set()).has(other),
          linkSource: (graph.in.get(anchor.rel) || new Set()).has(other),
        })
      }
    }
  }
  for (const entry of linkedToPrimary) {
    if (supporting.length >= capSupporting) break
    if (seenSupporting.has(entry.record.rel)) continue
    seenSupporting.add(entry.record.rel)
    supporting.push(entry)
  }

  /* ── Related ────────────────────────────────────────
   * 有命中、但没进上面两层的；再补上「引用了 Primary / 被 Primary 引用」的其余邻居。
   *
   * ⚠️ **只走 `hit`，不走 `noHit`**（2026-09-29 改，对齐 PRD §5 / SDD §25）。
   * PRD §5 对 Related 的定义是「**与当前任务有关**，但没有足够证据进入 Primary / Supporting 的资料」——
   * 一个话题词都没命中、又没有引用关系的文档**不是「有关」**，它只是「工作区里还有这一篇」。
   * 放进来会让它带着兜底理由码 `related` 出场，而客户端把那句翻译成
   * 「与当前工作区相关」—— 那正是需求 §九 明令禁止的「可能对你有帮助」（无法验证的推断）。
   * ⇒ 每个进包的东西都要能说出凭什么；说不出就**不出场**（Related 允许为空）。
   * `explainContext()` 里的 `related` 兜底码因此在本装配路径上不再产生，
   * 但保留它：那个函数是纯函数，可以被独立调用。 */
  const related = []
  const seenRelated = new Set([...seenSupporting])
  for (const record of hit) {
    if (related.length >= capRelated) break
    if (seenRelated.has(record.rel)) continue
    seenRelated.add(record.rel)
    related.push({ record, linkTarget: false, linkSource: false })
  }
  if (graph instanceof Object && related.length < capRelated) {
    for (const anchor of primary) {
      for (const other of neighboursOf(graph, anchor.rel)) {
        if (related.length >= capRelated) break
        if (seenRelated.has(other)) continue
        const record = byRel.get(other)
        if (!record) continue
        seenRelated.add(other)
        related.push({
          record,
          linkTarget: (graph.out.get(anchor.rel) || new Set()).has(other),
          linkSource: (graph.in.get(anchor.rel) || new Set()).has(other),
        })
      }
    }
  }

  /**
   * 把内部记录投影成对外的条目：**只有 rel / title / summary / mtimeMs / kind / source /
   * reason / provenance**（外加有关系时的 `relations` + `relationsTotal`）。
   * `raw` / `strength` / `terms` / `fields` 一个都不出去 —— 名次本身就是答案。
   *
   * v0.21：`relations` 与 `relationsTotal` **只在真有关系时才出现**。空数组是纯噪音
   * （没有关系时界面什么也不画），而条目的形状本来是稳定的 —— 少一个恒为空的可选键，
   * 比多 9 个 `"relations":[]` 更省。`relationsTotal` 更只在**被截断**时出现：
   * 界面要说的那句话是「共 N 条关系」，没截断时 `N` 就是列表长度，不必下发。
   */
  const project = (entry) => {
    const record = entry.record
    const reason = explainContext(
      { rel: record.rel, kind: record.kind, matchedTerms: record.termFields },
      entry,
    )
    const item = {
      rel: record.rel,
      title: record.title,
      summary: record.summary,
      mtimeMs: record.mtimeMs,
      kind: record.kind,
      source: record.source,
      reason,
      provenance: RELATION_REASON.has(reason.code) ? 'relation' : 'retrieval',
    }
    if (incident) {
      const found = relationsOf(incident, record.rel, MAX_RELATIONS_PER_ITEM)
      if (found.relations.length > 0) {
        item.relations = found.relations
        if (found.total > found.relations.length) item.relationsTotal = found.total
      }
    }
    return item
  }

  /** 同一层内：名次优先；名次相同按理由强弱；再相同按 rel 字典序（确定性兜底）。 */
  const orderTier = (entries) => entries
    .map((entry) => ({ entry, item: project(entry) }))
    .sort((a, b) => {
      if (a.entry.record.rank !== b.entry.record.rank) return a.entry.record.rank - b.entry.record.rank
      const ra = REASON_ORDER[a.item.reason.code] ?? 99
      const rb = REASON_ORDER[b.item.reason.code] ?? 99
      if (ra !== rb) return ra - rb
      return a.item.rel < b.item.rel ? -1 : a.item.rel > b.item.rel ? 1 : 0
    })
    .map((wrapped) => wrapped.item)

  const primaryItems = orderTier(primary.map((r) => ({ record: r, linkTarget: false, linkSource: false })))
  const supportingItems = orderTier(supporting)
  const relatedItems = orderTier(related)

  return {
    mode: 'relevance',
    topic,
    // **引用，不是推断**（SDD §12）：调用方把「最新一条有实质内容的用户消息」原文递进来，
    // 这里原样带出。填一个猜出来的「任务」比空着更糟 —— 它不可验证，
    // 而 Context Pack 的全部价值就是「每条都能说出凭什么」。
    // 空串是合法值：显式 query 路径（`knit_docs(query)`）就没有对话可引用。
    task,
    primary: primaryItems,
    supporting: supportingItems,
    related: relatedItems,
    totals: {
      primary: primaryItems.length,
      supporting: supportingItems.length,
      related: relatedItems.length,
      // 本批语料里**命中了话题**的篇数。
      matched: hit.length,
      // 整个工作区一共有多少篇（由调用方给全量数；不给就是这一批的条数）。
      // 与 `knit_docs` 头部的 `of N Markdown documents` 是同一个口径。
      total: Number.isInteger(input.total) && input.total >= 0 ? input.total : records.length,
    },
  }
}

/*
 * ⚠️ 这里**故意没有** `renderContextText()`。
 *
 * v0.14 开发中曾有一个把 Context Pack 压成文本的渲染函数，但它是**第二个渲染器**：
 * 模型真正看到的是 `tool.js` 的 `renderToolText()`（`src/host/tool.js:328`），
 * 而 `tool.js:452` 的 `render:` 只把那段文本塞进返回信封 —— 结构化 JSON 模型看不见。
 * 两个渲染器必然漂移（层标题、理由文案、`of N` 的口径都会各走各的），
 * 于是这个函数从未被任何代码调用过（`src/` / `test/` / `tools/` 全查过），已被删除。
 *
 * ⇒ **要改模型看到的文本，改 `tool.js`；不要在这里再造一个渲染器。**
 */
