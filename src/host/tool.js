/**
 * Knit · agent 文档工具（v0.7）
 *
 * 把一个**只读**工具交给模型：`knit_docs` —— 列出这个项目里已有的**文档与代码文件**，
 * 按与当前对话（或调用方给出的 query）的相关性排序。
 *
 * 解决的问题：agent 想引用项目里已有的文档时只能靠猜路径、或者把 glob 出来的
 * 路径一个个 read 试过去。而这份排序 Knit 每一轮**已经算好了**（面板在用），
 * 这里只是同一个结果**再开一个口子给模型**。
 *
 * ── 为什么不用 `defineTool` ───────────────────────────
 *
 * 官方的写法是 `import { defineTool } from '@deepseek-ai/dsh-tools'`。**这个包不能引**：
 * Knit 是被 `link:` 挂进 DSH profile 的，它的真实路径在 profile 的 `node_modules` **之外**，
 * 所以裸 Node 解析不到 `@deepseek-ai/*`（实测 `ERR_MODULE_NOT_FOUND`）。
 * 本机另外两个 `link:` 的开发插件同样是零依赖、从不 import DSH 的包。
 *
 * 所以这里**手写 `ToolDefinition`**。这不是猜：`defineTool` 的实现只是把参数
 * 规格编译成 JSON Schema 再包一层校验，产物就是下面这两个常量 —— 它们是
 * 用真实的 `parameterSchemaSpecToJsonSchema` / `valueSchemaSpecToJsonSchema`
 * 跑出来的结果照抄的。丢掉的那层参数校验由 `clampLimit` 等显式检查补上。
 *
 * 这样 Knit 保持**零依赖**（README 的承诺、也是装完不用 npm install 的前提），
 * 且在「开发目录 / clone / 装进 node_modules」三种布局下都能跑。
 *
 * ── 安全 ─────────────────────────────────────────────
 *
 * 只读。复用的是宿主那条已经加固过的扫描路径（工作区内、跳过 node_modules / .git / dist），
 * **不新增任何 HTTP 路由**，攻击面没有变大。结果里只出现工作区**相对**路径。
 */

/** 工具名。`knit_` 前缀是生态惯例（`tiddlywiki_*`、`memory_*`），避免撞名。 */
export const TOOL_NAME = 'knit_docs'

/** 默认返回几条。 */
export const DEFAULT_LIMIT = 5

/** 上限。 */
export const MAX_LIMIT = 20

/** 结果里摘要再截一次（宿主的首段摘要本身是 60 字，这里防的是极端长首段）。 */
const SUMMARY_CHARS = 90

/**
 * 命中段落的上限（v0.11）。
 *
 * 取值依据是实测：`knit_docs` 一次输出约 710 字符，而**一篇文档平均 12,930 字符**。
 * 每篇多 200 字 ≈ 一篇文档的 7.7%，而它想省掉的是整整一次 `read`。
 * 见 `Knit_SDD-v0.11-knit_docs命中段落.md` §一。
 */
const SNIPPET_CHARS = 200

/**
 * 单文件参与检索的上限（KB）。
 *
 * **必须与 `index.js` 的 `MAX_BODY_BYTES`（256 KB）一致** —— 下面那句真话要如实
 * 说出边界，而这个边界归宿主所有。这是 10.4「镜像表」里的一项（v0.20 之前这里
 * 镜像的是 `HAYSTACK_CHARS = 2500`）。
 */
const MAX_INDEXED_KB = 256

/**
 * 「工作区里有文档，但当前话题一个词都没命中」时补的那句真话。
 *
 * ⚠️ v0.20 改写了这句话。v0.19 及以前它说的是「只在每篇前 2500 字里找，更深的
 * 用 grep」—— 那是当时评分窗口的真实限制。v0.20 取消了这个窗口（需求 §3），
 * 那句话**从今往后是假的**，留着还会让模型为一件不存在的事去做多余的 `grep`。
 *
 * 现在真正的边界只剩两条，都要如实说出来：单文件大小上限（`MAX_INDEXED_KB`）
 * 与媒体没有正文（需求 §17）。
 */
const FULLTEXT_NOTE =
  `Every document and code file was searched in full (files over ${MAX_INDEXED_KB} KB are `
  + 'indexed only up to that size); images and videos have no searchable text.'

/**
 * 模型面向的描述。**必须短** —— 它会进每一次请求的系统提示词。
 *
 * v0.8 加过「Reports how many exist in total」，**但真机验证显示没用**：
 * agent 照样自己 `grep -c` 数一遍关键词重新排名（`Knit_SDD-v0.8` §8.4）。
 * 原因是它**不认这个排名**，不是怕漏。
 *
 * v0.9 换成直接说明**这个排名比它自己数准** —— 依据是 `tools/scale-benchmark.mjs`
 * 的实测（同一套词、同一个可判定任务、N = 20/60/180/540）：
 *
 *   路线          文件名说得清   文件名看不出   MRR 随规模
 *   Knit BM25     100%          100%         1.000（不变）
 *   grep -c 计数   17%           0%           0.313 → 0.089
 *   只看文件名     100%          0%           0.602
 *
 * 所以描述要点名两件它自己做不到的事：**稀有词权重**（不是数次数）
 * 与**不依赖文件名**。最后一句是行为引导 —— 直说「别自己来」。
 */
const DESCRIPTION = 'Project context for the current task, from the workspace documents and code: '
  + 'primary (read first) / supporting (evidence, implementation) / related, each with its '
  + 'matched passages (line range + snippet). '
  + 'Ranked by IDF-weighted relevance (or explicit query), then split '
  + 'by deterministic rules — prefer it to globbing or counting keyword hits. '
  + 'Reads the workspace; stores nothing, calls no model.'

/**
 * 参数 schema。与 `defineTool` 的编译产物逐字一致
 * （两个参数都可选，所以没有 `required`，根对象也没有 `additionalProperties`）。
 */
const PARAMETERS = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Optional search text. Omit to rank by the current conversation.',
    },
    limit: {
      type: 'integer',
      description: `How many documents to consider (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}). `
        + 'They are grouped into the context tiers, not returned as one flat list.',
    },
    // v0.15：可选的「使用情况」审计。**默认 false** —— 不传它时这次调用的
    // 入参与返回值与 v0.14 逐字一致，老调用方一个字都不用改。
    audit: {
      type: 'boolean',
      description: 'Set true to append a one-line usage summary of the PREVIOUS context pack: '
        + 'whether its primary document has been read since, how many supporting documents were read, '
        + 'and how many reads fell outside the pack. Counts only — no scores, no confidence. '
        + 'Default false.',
    },
  },
}

/**
 * 输出 schema。同样照抄编译产物 —— 注意**没有 `score`**：
 * 相关度是**相对**分数（永远有一篇 100%，且每次刷新可能换人当），
 * 面板里就不显示它，给模型看只会更糟 —— 它会把 86 当成绝对置信度去推理。
 * **顺序即相关度。**
 *
 * v0.14：从「一列文档」变成**三层 Context Pack**。结构变了，纪律没变 ——
 * 仍然不返回分数、不返回正文、不返回绝对路径、不返回 haystack、不返回 embedding。
 * 新增的 `reason` 是**结构化理由**（码 + 命中的词），不是自然语言推断：
 * 宿主只给码，模型自己就能看懂 `direct` / `linkTarget` / `testSupport` 是什么意思。
 */
const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rel: { type: 'string' },
    title: { type: 'string' },
    summary: { type: 'string' },
    mtimeMs: { type: 'integer' },
    // 项目里的角色：impl / test / config / design / doc。纯路径规则，不是内容理解。
    source: { type: 'string', enum: ['impl', 'test', 'config', 'design', 'doc'] },
    // 条目是什么：md / code / image / video。
    // ⚠️ **故意不给它 enum**。取值集合归 `classification.js` 的 `classifyFile()` 所有；
    // 在这里钉一份名单，等于以后每加一种文件类型就让工具在**校验层**静默失败一次。
    // v0.14 正是这么坏掉的：`kind` 当时压根没被声明，而 schema 是 `additionalProperties: false`。
    kind: { type: 'string' },
    reason: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // 为什么它在这个包里。全部来自确定性事实（命中字段 / 引用关系 / 文件角色）。
        code: {
          type: 'string',
          enum: [
            'direct', 'titleMatch', 'filenameMatch', 'summaryMatch', 'pathMatch', 'bodyMatch',
            'linkTarget', 'linkSource', 'related',
          ],
        },
        // 命中的话题词（没有命中就是空数组 —— 不编造）。
        terms: { type: 'array', items: { type: 'string' } },
        // 命中跨了几个字段（0–3）。
        fields: { type: 'integer' },
        // 那句话的代表词：标题命中时取标题里那个词，正文命中时取正文里那个词。
        // 与 `terms` 的区别是它是**单个**。
        term: { type: 'string' },
      },
      // `term` 在 `explainContext()` 的每条分支上都有值（取不到时是空串），
      // 所以它是 required，不是 optional —— schema 要如实描述。
      required: ['code', 'terms', 'fields', 'term'],
    },
    // v0.11：命中的那一小段**原文**（不是整篇）。**可选** ——
    // 时间序模式没有命中词，抽不出来就不带这个字段，
    // 而不是给个空串假装有。
    snippet: { type: 'string' },
    // v0.20：命中**内容片段**（需求 §11）。文件仍是这个工具的基本实体，
    // `matches` 是附加在它上面的一层：最多 `PASSAGE_MAX_PER_FILE`（2）段，
    // 按行号升序，每段自带行号与偏移量 —— 拿到它就能直接去读那一小段，
    // 不必把整篇大文件塞进上下文（需求 §15/§16）。
    // **可选**：没有片段（零命中、媒体、窗口外、`bodyTf` 不足）时这个键不出现，
    // 而不是给个空数组假装搜过。
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          // 1-based，闭区间 —— 与编辑器里看到的一致。
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
          // 0-based 字符偏移，`text.slice(startOffset, endOffset)` 恒等于这段原文。
          startOffset: { type: 'integer' },
          endOffset: { type: 'integer' },
          // 这一段里真实命中的话题词（来自 `rankByRelevance` 的 `matchedTerms`）。
          terms: { type: 'array', items: { type: 'string' } },
          // 这一段里**最相关**的那 200 字（不是整段）。
          snippet: { type: 'string' },
        },
        required: ['startLine', 'endLine', 'startOffset', 'endOffset', 'terms', 'snippet'],
      },
    },
  },
  // `kind` 也是 required：`buildContext()` 每条都给了（取不到时回落 `'md'`）。
  // 声明成可选就等于允许「有的条目有 kind、有的没有」这种形状漂移。
  required: ['rel', 'title', 'summary', 'mtimeMs', 'kind', 'source', 'reason'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['relevance', 'time'] },
    topic: { type: 'string' },
    // 本批语料里**一共有多少个文件**（文档 + 代码）—— 让模型知道这不是「随便挑的几条」，
    // 不必再自己 glob 一遍做交叉验证（v0.8，依据是真机验收里观察到的行为）。
    total: { type: 'integer' },
    // v0.14：三层。`primary` 是「先读这几篇」，`supporting` 是「证据 / 实现 / 下一步」，
    // `related` 是「背景，不要从这里开始」。名字与面板逐字一致。
    primary: { type: 'array', items: ITEM_SCHEMA },
    supporting: { type: 'array', items: ITEM_SCHEMA },
    related: { type: 'array', items: ITEM_SCHEMA },
    // 渲染头部那条「N matching documents」用的计数。**它不是分数** ——
    // 只是「本批语料里命中了几篇 / 一共有几篇」，给模型一个「有没有漏」的锚。
    // 只有 relevance 模式有，所以不在 `required` 里。
    totals: {
      type: 'object',
      additionalProperties: false,
      properties: {
        matched: { type: 'integer' },
        total: { type: 'integer' },
      },
      required: ['matched', 'total'],
    },
    // v0.15：**可选**的一行「使用情况」（只有 `audit: true` 时才有）。
    // 它说的全是计数与事实 —— 没有分数、没有百分比、没有置信度、没有 trajectory。
    // 不传 `audit` 时这个字段根本不出现（而不是给个空串）。
    usage: { type: 'string' },
    // 时间序（对话内容还不足，退回一列「最近改动的」）走这条。**形状比三层窄** ——
    // 没有命中词，就没有 `source` / `reason` 可给，不编造。只有 time 模式有。
    docs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rel: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          mtimeMs: { type: 'integer' },
          snippet: { type: 'string' },
        },
        required: ['rel', 'title', 'summary', 'mtimeMs'],
      },
    },
  },
  required: ['mode', 'topic', 'total', 'primary', 'supporting', 'related'],
}

/**
 * 把 `limit` 夹到合法区间。
 *
 * 官方 `defineTool` 会替我们做参数校验，手写定义没有那层，所以在这里补上。
 * 非法值一律**回落到默认值**而不是抛错 —— 一个越界的 `limit` 不值得让整次调用失败。
 *
 * @param {unknown} value - 模型给的 limit
 * @returns {number} 1..MAX_LIMIT 之间的整数
 */
export function clampLimit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT
  const n = Math.trunc(value)
  if (n < 1) return 1
  if (n > MAX_LIMIT) return MAX_LIMIT
  return n
}

/**
 * 从执行上下文里取调用方的工作区根与会话 id。
 *
 * `exec.agent.session.header` 上同时有 `cwd` 与 `id`（见 `@deepseek-ai/dsh-session` 的
 * `SessionHeader`）。**id 必须拿到**：宿主的关键词缓存按 sessionId 键控，
 * 传空串会让不同会话共用一份缓存。
 *
 * @param {object|undefined} exec - 工具执行上下文
 * @returns {{root: string, sessionId: string, session: object|undefined}} 三者都可能是空
 */
export function agentScope(exec) {
  const session = exec && exec.agent ? exec.agent.session : undefined
  const header = session && session.header ? session.header : undefined
  const root = header && typeof header.cwd === 'string' ? header.cwd : ''
  const sessionId = header && typeof header.id === 'string' ? header.id : ''
  return { root, sessionId, session }
}

/**
 * 把摘要压成一行并截断 —— 一条结果不该占掉几十行。
 * @param {unknown} text - 摘要
 * @returns {string} 单行摘要
 */
/**
 * 压成单行并截断。
 *
 * ⚠️ **截断上限是参数，不是常量** —— v0.11 加命中段落时踩过一次：
 * 段落提取出来是 200 字，若复用只认 `SUMMARY_CHARS`(90) 的 `oneLine`，
 * 会被二次截掉一半，而且**测试不会报错**（输出仍然是合法的短文本）。
 *
 * @param {unknown} text - 任意文本
 * @param {number} cap - 上限字符数
 * @returns {string} 单行文本
 */
function flatten(text, cap) {
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return flat.length > cap ? `${flat.slice(0, cap)}…` : flat
}

function oneLine(text) {
  return flatten(text, SUMMARY_CHARS)
}

/**
 * 从**原文**里挑出「命中的那一段」，给模型判断「要不要读整篇」用（v0.11）。
 *
 * 三条设计约束，每条都有原因：
 *
 * 1. **在原文上切，不在 `haystack` 上切。** `haystack.body` 是 `.toLowerCase()` 过的
 *    （`index.js:240`），在它上面切会把 `BM25` 变成 `bm25` ——
 *    与「标签是你自己打的字，大小写原样保留」这条既有承诺直接冲突。
 * 2. **全文分块**（v0.20）。以前只看每篇前 2500 字，是为了与评分窗口对齐
 *    （否则会出现「排上来但段落里没命中词」）。窗口取消后评分看全文，这里也看全文 ——
 *    不过正常路径上命中片段已由 `passage.js` 在评分时算好（`doc.matches`），
 *    这个函数现在是「没有片段数据时的兜底」。
 * 3. **块太长时以命中词为中心截**，不是从头截 —— 否则命中那句话可能正好被截掉，
 *    段落就白给了。
 * 4. **跳过与标题重复的块。** 拿真实工作区试跑时发现的：一篇文档的 H1 标题里含全部命中词，
 *    于是「命中词最多的块」就是标题本身 —— 而标题**第 1 行已经给过了**。
 *    这种段落是纯浪费，正是要避免的「负收益」情形。
 *
 * 纯函数：不读盘、不看时钟、无副作用。抽不出命中段落时返回空串
 * （**不编造** —— 「没有命中」和「命中在别处」都不该被伪装成有一段）。
 *
 * @param {string} text - 文档**原文**
 * @param {string[]} terms - 命中词（来自 `scan()` 的 `keywords`，即语料里真实存在的词）
 * @param {{title?: string}} [options] - `title` 用于排除「与标题重复」的块
 * @returns {string} 命中段落（已压成单行、截断），或空串
 */
export function pickSnippet(text, terms, options = {}) {
  const source = String(text == null ? '' : text)
  const words = (Array.isArray(terms) ? terms : [])
    .map((term) => String(term == null ? '' : term).trim().toLowerCase())
    .filter(Boolean)
  if (!source || words.length === 0) return ''

  // 归一化只用于**比较**：去掉 Markdown 标题号、强调号、表格竖线，压平空白，小写
  const norm = (s) => String(s).replace(/[#*|`>\s]+/g, ' ').trim().toLowerCase()
  const titleNorm = norm(options.title || '')

  // 按空行切块 —— 纯字符串运算，不解析 Markdown 结构
  const blocks = source.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean)
  if (blocks.length === 0) return ''

  // 选**命中词种数最多**的那块；并列取靠前的（不给后面的块不该有的优势）
  const scored = blocks.map((block) => {
    const lower = block.toLowerCase()
    let hits = 0
    for (const word of words) if (lower.includes(word)) hits += 1
    return { block, hits, norm: norm(block) }
  })

  // 跳过「与标题重复」的块（见 JSDoc 第 4 条）
  const usable = scored.filter((item) => !(titleNorm && item.norm && titleNorm.includes(item.norm)))
  if (usable.length === 0) return ''

  let best = null
  for (const item of usable) {
    if (item.hits > 0 && (best === null || item.hits > best.hits)) best = item
  }
  // 一块都没命中 → 返回空串，而不是退化成「随便给第一段」
  if (best === null) return ''

  const flat = best.block.replace(/\s+/g, ' ').trim()
  if (flat.length <= SNIPPET_CHARS) return flat

  const lowerFlat = flat.toLowerCase()
  let at = -1
  for (const word of words) {
    const found = lowerFlat.indexOf(word)
    if (found >= 0 && (at < 0 || found < at)) at = found
  }
  const maxStart = flat.length - SNIPPET_CHARS
  const start = at < 0 ? 0 : Math.max(0, Math.min(at - Math.floor(SNIPPET_CHARS / 3), maxStart))
  const head = start > 0 ? '…' : ''
  const tail = start < maxStart ? '…' : ''
  return `${head}${flat.slice(start, start + SNIPPET_CHARS).trim()}${tail}`
}

/**
 * 把 Context Pack 渲染成模型看的文本。
 *
 * **英文**：模型面向文本要的是词表稳定，不跟随界面语言 —— 官方工具
 * （`todo_write`、`present`）也都是英文硬编码。这不是 i18n 违约：
 * AGENTS.md §4.5 那条规则管的是**用户可见**文案，而这里由模型消费。
 *
 * **头部要说清「一共多少篇」**（v0.8）：真机验收里 agent 每次拿到结果都还要
 * 自己 `find` 一遍来确认没漏 —— 把总数写在第一行，是为了消掉这次多余的调用。
 *
 * **v0.14 改的是什么**：以前是一条按相关度排的平铺列表（`Top 5 of 23 …`），
 * 现在是一条**带层级的任务上下文**（Primary / Supporting / Related），
 * 每一项都带 `Why:`。真机上 agent 拿到平铺列表后仍然要自己判断
 * 「哪篇是主文档、哪篇只是背景」—— 那正是这一版要替它省掉的判断。
 *
 * @param {{mode: string, topic: string, total?: number, primary?: Array<object>,
 *   supporting?: Array<object>, related?: Array<object>,
 *   docs?: Array<object>}} value - 工具结果（兼容 v0.13 的 `docs` 形状，供时间序使用）
 * @param {Function} [readSnippet] - 可选：从一条结果里取它的命中段落（`doc.snippet`）。
 *   **注入成函数而不是直接读字段**，是为了让「段落从哪来」这件事留在 `execute` 里，
 *   渲染函数保持无副作用、可单测。
 * @returns {string} 文本
 */
export function renderToolText(value, readSnippet) {
  const mode = value && value.mode === 'relevance' ? 'relevance' : 'time'
  const topic = value && typeof value.topic === 'string' ? value.topic : ''
  const total = Number.isInteger(value && value.total) ? value.total : 0

  // v0.19：语料从「只有 Markdown」变成「文档 + 代码」，所以这里的称谓必须跟着改。
  // 说「9 Markdown documents」而实际语料里含着 `.ts`，是在对模型说假话 ——
  // 而且它会误导模型以为「这个项目里没有代码可看」。**称谓集中在这一处**，
  // 免得以后改口径时要追四条字符串。
  const files = (n) => `${n} document${n === 1 ? '' : 's'} and code file${n === 1 ? '' : 's'}`
  const EMPTY = 'No documents or code files found in the workspace.'

  // 退化（时间序）与「没有对话」是同一件事的两面：都没有命中词。
  if (mode !== 'relevance') {
    const docs = (value && Array.isArray(value.docs)) ? value.docs : []
    if (docs.length === 0) return EMPTY
    const scope = ` of ${files(total)}`
    return [`Not enough conversation to rank by relevance — showing the ${docs.length} most recently modified${scope}:`,
      ...docs.map((doc, index) => `${index + 1}. ${doc.rel} — ${doc.title}`)].join('\n')
  }

  const primary = (value && Array.isArray(value.primary)) ? value.primary : []
  const supporting = (value && Array.isArray(value.supporting)) ? value.supporting : []
  const related = (value && Array.isArray(value.related)) ? value.related : []

  // 三层都空 = 真的没有可看的上下文。**不能只判 total** —— 工作区有文档、
  // 但当前话题一篇都没命中、且一条引用邻居都没有时，`total` 是正数而三层全空。
  if (primary.length + supporting.length + related.length === 0) {
    if (total === 0) return EMPTY
    // 文档在、但一个词都没命中 —— **不许说成「工作区里没有文档」**：
    // 那是一句假话，而且会把 agent 推向一个错的结论（「这个项目里没有相关材料」）。
    // 真机实测（v0.19 的时代）：问「路径越界怎么防」时 49 篇一篇都没命中，因为文档侧
    // 只看每篇**前 2500 字**，而这个词在 5 篇 .md 里全部出现在 2500 字之后。
    // **v0.20 取消了这个窗口**，所以「0 命中」现在是句更强的话；
    // 但仍要把真实边界（单文件大小上限、媒体无正文）说出来，见 `FULLTEXT_NOTE`。
    return [
      `No document or code file matched the current topic — 0 of ${files(total)} contain the query terms.`,
      FULLTEXT_NOTE,
    ].join('\n')
  }

  /**
   * 一项的命中片段（v0.20）。
   *
   * 正常路径上片段是 `passage.js` 在评分时算好的（`item.matches`，带行号）；
   * `readSnippet` 是不带片段数据时的兜底（老调用方、窗口外的文档）。
   * 两者都没有就不渲染 `match:` 那一行 —— 不编造。
   *
   * 行号只在 `matches` 存在时才有，所以旧的 `readSnippet` 返回值一字不改。
   */
  const matchLine = (item) => {
    const matches = item && Array.isArray(item.matches) ? item.matches : []
    const first = matches.find((m) => m && typeof m.snippet === 'string' && m.snippet)
    if (first) {
      const range = Number.isInteger(first.startLine) && Number.isInteger(first.endLine)
        ? `lines ${first.startLine}–${first.endLine} — ` : ''
      return `${range}${flatten(first.snippet, SNIPPET_CHARS)}`
    }
    const raw = typeof readSnippet === 'function' ? readSnippet(item) : ''
    return raw ? flatten(raw, SNIPPET_CHARS) : ''
  }

  /**
   * **只渲染一段**（`match:`）。第二段（`also:`）在 v0.20 实测后被砍掉 ——
   * 保留这段注释，免得下一个人又把它加回来。
   *
   * 需求 §16 的预算是「工具输出不得因为片段而膨胀」。实测（30 篇全命中的压力
   * 语料、5 条结果、比较渲染后的文本而不是结构化 value）：v0.19 基线 2702 字符，
   * 带 `match:` + `also:` 两段时 4614 字符 = **1.71×**，超过实现说明 §7 R2 定的
   * 1.4× ⇒ 按那条规则把**工具侧**降到一段（砍后 1.35×）。面板侧仍是每文件 ≤2 段：
   * 它走本地 HTTP、不进模型上下文，需求 §11 的「可带多段」在那里成立。
   * 这也正对需求 §15 的措辞：给的是「**最相关片段**」（单数）+ 文件 + 理由。
   */
  const lines = (items) => items.map((item, index) => {
    const summary = oneLine(item.summary)
    const why = whyText(item.reason)
    const snippet = matchLine(item)
    return `${index + 1}. ${item.rel} — ${item.title}`
      + `${summary ? `\n   ${summary}` : ''}`
      + `${why ? `\n   Why: ${why}` : ''}`
      + `${snippet ? `\n   match: ${snippet}` : ''}`
  })

  const out = []
  const matched = (value && value.totals && Number.isInteger(value.totals.matched))
    ? value.totals.matched : 0
  out.push(`Context for ${topic ? `「${topic}」` : 'the current conversation'}: `
    + `${matched} matching of ${files(total)}, split into `
    + 'primary / supporting / related by deterministic local rules (first-read order — '
    + 'not a flat relevance list; each tier is still ranked by IDF-weighted relevance):')

  if (primary.length > 0) {
    out.push('', 'Primary (read these first):', ...lines(primary))
  }
  if (supporting.length > 0) {
    out.push('', 'Supporting (evidence, implementation, next step):', ...lines(supporting))
  }
  if (related.length > 0) {
    out.push('', 'Related (background — do not start here):', ...lines(related))
  }
  // v0.15：可选的「使用情况」一行。**只有 `audit: true` 时 `execute` 才会填它**，
  // 所以默认调用的输出与 v0.14 逐字一致。
  const usage = (value && typeof value.usage === 'string') ? value.usage : ''
  if (usage) out.push('', usage)
  return out.join('\n')
}

/**
 * 把结构化理由翻成一句英文。**码 → 文案**，不是自然语言推断 ——
 * 每个码背后都是一条可核验的确定性事实。
 *
 * @param {{code?: string, terms?: string[], fields?: number}} [reason] - `explainContext()` 的产物
 * @returns {string} 文本
 */
function whyText(reason) {
  const code = reason && reason.code ? String(reason.code) : ''
  const terms = reason && Array.isArray(reason.terms) ? reason.terms.join(', ') : ''
  switch (code) {
    case 'direct': return terms ? `direct topic match in the title (${terms})` : 'direct topic match in the title'
    case 'titleMatch': return terms ? `matched in the title (${terms})` : 'matched in the title'
    // v0.19：代码没有「标题 / 摘要」，占这两个槽位的是**文件名**与**所在目录**
    // （见 `index.js` 的 `readCode()`）。判据与 `titleMatch` / `summaryMatch` 完全一样，
    // 只有称谓不同 —— 对一个 `.ts` 文件说 "matched in the title" 是错的。
    case 'filenameMatch': return terms ? `matched in the filename (${terms})` : 'matched in the filename'
    case 'summaryMatch': return terms ? `matched in the summary (${terms})` : 'matched in the summary'
    case 'pathMatch': return terms ? `matched in the path (${terms})` : 'matched in the path'
    case 'bodyMatch': return terms ? `matched in the body (${terms})` : 'matched in the body'
    case 'linkTarget': return 'referenced by a primary document'
    case 'linkSource': return 'references a primary document'
    default: return 'related in the current workspace'
  }
}

/**
 * 取「上一份 Context Pack 之后发生了什么」的一行摘要（v0.15）。
 *
 * `audit` 是**注入**进来的桥（宿主侧 `feedback.js` 的封装），工具自己不认识 feedback ——
 * 与 `scan` / `read` / `contextFor` 同样的理由：一层做一件事，且避免 index.js ↔ tool.js 循环 import。
 * 桥没给、桥抛了、桥返回了非字符串：一律当「没有可说的」，返回空串。
 *
 * @param {object} [audit] - `{summary(sessionId), note(sessionId, pack)}`
 * @param {string} sessionId - 会话 id
 * @returns {string} 一行摘要或空串
 */
function auditSummary(audit, sessionId) {
  if (!audit || typeof audit.summary !== 'function' || !sessionId) return ''
  try {
    const line = audit.summary(sessionId)
    return typeof line === 'string' ? line : ''
  } catch {
    return ''
  }
}

/**
 * 造出 `knit_docs` 的 `ToolDefinition`。
 *
 * 形状与官方 `defineTool(...)` 的产物一致：`{ name, description, parameters, output, execute }`。
 *
 * @param {Function} scan - 宿主的扫描函数（注入进来，避免 index.js ↔ tool.js 循环 import）
 * @param {Function} [read] - 宿主的单篇读取函数 `readDocument(root, rel)`。
 *   **同样注入**，理由与 `scan` 一样。**可选** —— 没给就只是不带命中段落，
 *   `knit_docs` 的其余行为一字不变（老调用方不会坏）。
 * @param {Function} [contextFor] - 宿主的上下文装配函数
 *   `contextFor(root, {ranked, topic, task, total})` → Context Pack。
 *   **同样注入**（v0.14）：装配规则长在 `context.js` 里，工具只负责投影。
 *   不给就退化成 v0.13 的平铺列表 —— 但那只是兜底，正常路径 always 会传。
 * @param {object} [audit] - Context Feedback 的桥（v0.16，**可选**）：
 *   `{ summary(sessionId) → string, note(sessionId, pack) → void }`。
 *   桥不再需要工作区根与会话对象：读证据由宿主的 `session/event` 订阅进 store。
 *   不给就完全没有审计能力 —— 工具的入参与返回值与 v0.14 逐字一致。
 * @returns {object} 工具定义
 */
export function knitDocsDefinition(scan, read, contextFor, audit) {
  /**
   * 给一篇文档抽命中段落。
   *
   * **任何失败都咽掉并返回空串** —— 抽不出段落只是少一条信息，
   * 不该让整次工具调用失败（工具已经拿到了排序结果，那才是主要产出）。
   *
   * @param {string} root - 工作区根
   * @param {string} rel - 相对路径
   * @param {string[]} terms - 命中词
   * @param {string} title - 这一篇的标题（用于排除「与标题重复」的块）
   * @returns {Promise<string>} 命中段落或空串
   */
  async function snippetFor(root, rel, terms, title) {
    if (typeof read !== 'function' || !rel || terms.length === 0) return ''
    try {
      const doc = await read(root, rel)
      if (!doc || doc.ok !== true) return ''
      return pickSnippet(doc.text, terms, { title })
    } catch {
      return ''
    }
  }

  return {
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      // 命中段落从条目自己的 `snippet` 字段取 —— `execute` 已经把它填好了。
      render: (_args, value) => [{
        type: 'text',
        text: renderToolText(value, (item) => (item && item.snippet) || ''),
      }],
    },
    async execute(args, exec) {
      const { root, sessionId, session } = agentScope(exec)

      // 拿不到会话就**报错，不兜底**。HTTP 路由那条路会兜底 process.cwd()，
      // 因为它要兼容不带 sessionId 的老客户端；工具没有这个包袱 ——
      // 兜底到「DSH 进程的 cwd」只会扫到一个不相干的项目并返回它的文档。
      // 宁可报错，也不要返回错的东西。
      if (!root) throw new Error(`${TOOL_NAME} requires an owning agent session with a workspace root`)

      const query = typeof (args && args.query) === 'string' ? args.query.trim() : ''
      const limit = clampLimit(args && args.limit)
      // v0.15：审计是**显式**的（默认 false）。不传它就完全不走 feedback 那条路。
      const auditRequested = !!(args && args.audit === true)

      const payload = await scan(root, limit, {
        session,
        sessionId,
        sort: 'relevance',
        query,
        // v0.19：工具的语料是**文档 + 代码**（不给 HTTP 的 `context` 档）。
        // 这一条正是本次版本的核心主张：代码和 Markdown 在**同一套 BM25、同一套分层**
        // 里竞争，谁进 Primary 只由任务检索决定，没人给代码留座位。
        // 媒体不进 —— 图片/视频没有可检索的正文，进上下文只会稀释（v0.18 起如此）。
        kind: 'context',
      })

      // 命中词用 `scan()` 的 `keywords` —— 它是**语料里真实存在**的那批词
      // （不是原始候选），所以拿它去原文里找段落，必然找得到。
      // 时间序模式下它是空数组 ⇒ terms 为空 ⇒ 不抽段落，正合语义。
      const terms = Array.isArray(payload.keywords) ? payload.keywords : []

      /** 给一篇抽段落：**只用这一篇自己命中的词** —— 拿别篇的词去原文里找，抽出来的段落跟这篇无关。 */
      const snippetOf = async (item) => {
        const own = (item.reason && Array.isArray(item.reason.terms)) ? item.reason.terms : []
        return snippetFor(root, item.rel, own, item.title)
      }

      // 时间序（没有对话可依据）：退回一列「最近改动的」，**不硬凑三层**。
      if (payload.mode !== 'relevance') {
        const recent = await Promise.all((payload.docs || []).map(async (doc) => {
          const row = {
            rel: String(doc.rel || ''),
            title: String(doc.title || ''),
            summary: doc.summary == null ? '' : String(doc.summary),
            mtimeMs: Number.isFinite(doc.mtimeMs) ? Math.trunc(doc.mtimeMs) : 0,
          }
          const snippet = await snippetFor(root, row.rel, terms, row.title)
          if (snippet) row.snippet = snippet
          return row
        }))
        return {
          mode: 'time',
          topic: '',
          total: Number.isInteger(payload.total) ? payload.total : 0,
          primary: [],
          supporting: [],
          related: [],
          docs: recent,
        }
      }

      const pack = typeof contextFor === 'function'
        ? await contextFor(root, {
          // ⚠️ 用 `payload.ranked`（全量、未切片）而不是 `payload.docs`（已切到 limit）——
          // 分层要在完整名次上做，否则「Primary 3 篇 + Supporting 5 篇」会把
          // 本该是 Supporting 的文档因为切片而挤掉（它会掉进 Related，或整个消失）。
          ranked: Array.isArray(payload.ranked) ? payload.ranked : [],
          topic: payload.topic,
          // 任务原文（可能为空：显式 `query` 路径没有对话可引用）。
          // 它进 `pack.task`，但**不出现在工具返回值里** —— 模型看到的是 `output.render`
          // 渲染的那段文本，结构化 JSON 它根本看不见；而 `OUTPUT_SCHEMA` 是封闭的
          // （`additionalProperties: false`），加一个模型用不到的字段只会把 schema 撑开。
          // 头部已经用 topic 标签说了「这次是按什么排的」，那比原文更省 token。
          // Human 面板走 HTTP，`context.task` 在那里有值。
          task: payload.task,
          total: Number.isInteger(payload.total) ? payload.total : 0,
        })
        : { mode: 'relevance', topic: payload.topic || '', total: 0, primary: [], supporting: [], related: [] }

      /**
       * 把装配层的条目投影成 `ITEM_SCHEMA` 的形状。
       *
       * ⚠️ `mtimeMs` **必须在这里取整**。`fs.Stats.mtimeMs` 是浮点，而 schema 写的是
       * `integer` —— v0.14 把三层条目**原样透传**过一次，于是 `knit_docs` 每次调用
       * 都在校验层失败（`"value.primary[0].mtimeMs" must be an integer`），
       * agent 一个 Context Pack 都拿不到。时间序那条分支一直是取整的，两边不一致。
       */
      const project = (item) => ({
        ...item,
        mtimeMs: Number.isFinite(item.mtimeMs) ? Math.trunc(item.mtimeMs) : 0,
      })

      // v0.20：命中片段**在 `scan()` 里就算好了**（`payload.ranked[].matches`，带行号），
      // 键是 `rel`。有片段就不再读盘 —— 这是顺带拿到的性能收益：v0.19 为了抽 200 字，
      // 每一条都要把整篇文件再读一遍（`readDocument` → `pickSnippet`）。
      const matchesByRel = new Map()
      for (const doc of (Array.isArray(payload.ranked) ? payload.ranked : [])) {
        if (Array.isArray(doc.matches) && doc.matches.length > 0) {
          matchesByRel.set(String(doc.rel || ''), doc.matches)
        }
      }

      // 逐个抽命中段落 —— **只对真正要返回的条目做 I/O**，不在全量名次上读盘。
      const withSnippets = async (items) => Promise.all(items.map(async (raw) => {
        const item = project(raw)
        const matches = matchesByRel.get(String(item.rel || ''))
        if (matches) {
          // 单段也照旧填 `snippet` —— 渲染与老调用方都只认它。
          const first = matches.find((m) => m && typeof m.snippet === 'string' && m.snippet)
          return first ? { ...item, matches, snippet: first.snippet } : { ...item, matches }
        }
        const snippet = await snippetOf(item)
        return snippet ? { ...item, snippet } : item
      }))

      // ── v0.15 · Context Feedback ──────────────────────────────────────
      // 顺序是刻意的：先取「**上一份**包之后发生了什么」（usage 是回过头看的），
      // 再把这一份包记成新的 Context Snapshot —— 从下一次调用起，它才是「上一份」。
      // 两步都只是记账，任何失败都只让摘要少一行，绝不让整次工具调用失败。
      const usage = auditRequested ? auditSummary(audit, sessionId) : ''
      if (auditRequested && audit && typeof audit.note === 'function' && sessionId) {
        try {
          audit.note(sessionId, pack)
        } catch {
          // 记账失败不影响排序结果 —— 这是「Knit 坏了也不许影响 Agent」那条纪律
        }
      }

      return {
        mode: 'relevance',
        topic: typeof pack.topic === 'string' ? pack.topic : '',
        total: Number.isInteger(pack.totals && pack.totals.total) ? pack.totals.total : 0,
        // `matched` 走 `totals` —— 头部的「N matching documents」靠它。
        // 漏掉这一个字段会让头部永远写「0 matching documents」，而下面明明列着结果
        // （实测踩过一次，是渲染层的一个真实缺陷，不是美观问题）。
        totals: {
          matched: Number.isInteger(pack.totals && pack.totals.matched) ? pack.totals.matched : 0,
          total: Number.isInteger(pack.totals && pack.totals.total) ? pack.totals.total : 0,
        },
        primary: await withSnippets(pack.primary || []),
        supporting: await withSnippets(pack.supporting || []),
        related: await withSnippets(pack.related || []),
        // 只有 `audit: true` 且真的取到摘要时才有这个字段（否则连键都不出现）
        ...(usage ? { usage } : {}),
      }
    },
  }
}

/**
 * 把工具注册进 `ctx.tools`。
 *
 * 由调用方包在 `ctx.effect(...)` 里 —— `register` 返回的正是注销函数。
 *
 * @param {object} ctx - cordis 上下文（带 `tools` 服务）
 * @param {Function} scan - 宿主的扫描函数
 * @param {Function} [read] - 宿主的单篇读取函数（抽命中段落用；可选）
 * @param {Function} [contextFor] - 宿主的上下文装配函数（v0.14；可选）
 * @param {object} [audit] - Context Feedback 的桥（v0.15；可选）
 * @returns {() => void} 注销函数
 */
export function registerKnitDocsTool(ctx, scan, read, contextFor, audit) {
  return ctx.tools.register(knitDocsDefinition(scan, read, contextFor, audit))
}
