/**
 * Knit · agent 文档工具（v0.7）
 *
 * 把一个**只读**工具交给模型：`knit_docs` —— 列出这个项目里已有的 Markdown 文档，
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
 * 只在原文的**前 2500 字**里找命中段落。
 *
 * 必须与 `index.js` 的 `HAYSTACK_CHARS` 一致 —— 评分只看这个窗口，
 * 若在这里找窗口外的内容，会出现「排上来了、但段落里没有命中词」的自相矛盾。
 */
const SNIPPET_WINDOW = 2500

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
const DESCRIPTION = 'List Markdown documents that already exist in this project, '
  + 'ranked by relevance to the current conversation (or to an explicit query). '
  + 'The ranking weighs rare terms above common ones and normalizes document length, '
  + 'so it beats matching filenames or counting keyword hits — prefer it to doing that yourself. '
  + 'Reads the workspace only; stores nothing and calls no model.'

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
      description: `How many documents to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
    },
  },
}

/**
 * 输出 schema。同样照抄编译产物 —— 注意**没有 `score`**：
 * 相关度是**相对**分数（永远有一篇 100%，且每次刷新可能换人当），
 * 面板里就不显示它，给模型看只会更糟 —— 它会把 86 当成绝对置信度去推理。
 * **顺序即相关度。**
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['relevance', 'time'] },
    topic: { type: 'string' },
    // 工作区里**一共有多少篇**（不是返回了几条）。
    // 给这个数是为了让模型知道结果不是「随便挑的几条」，不必再自己 glob 一遍
    // 做交叉验证 —— v0.8，依据是真机验收里观察到的行为。
    total: { type: 'integer' },
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
          // v0.11：命中的那一小段**原文**（不是整篇）。**可选** ——
          // 时间序模式没有命中词，抽不出来就不带这个字段，
          // 而不是给个空串假装有。
          snippet: { type: 'string' },
        },
        required: ['rel', 'title', 'summary', 'mtimeMs'],
      },
    },
  },
  required: ['mode', 'topic', 'total', 'docs'],
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
 * 2. **只看前 `SNIPPET_WINDOW` 字**，与评分窗口一致，避免「排上来但段落里没命中词」。
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

  const window = source.slice(0, SNIPPET_WINDOW)

  // 按空行切块 —— 纯字符串运算，不解析 Markdown 结构
  const blocks = window.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean)
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
 * 把工具结果渲染成模型看的文本。
 *
 * **英文**：模型面向文本要的是词表稳定，不跟随界面语言 —— 官方工具
 * （`todo_write`、`present`）也都是英文硬编码。这不是 i18n 违约：
 * AGENTS.md §4.5 那条规则管的是**用户可见**文案，而这里由模型消费。
 *
 * **头部要说清「一共多少篇」**（v0.8）：真机验收里 agent 每次拿到结果都还要
 * 自己 `find` 一遍来确认没漏 —— 把总数写在第一行，是为了消掉这次多余的调用。
 *
 * @param {{mode: string, topic: string, total?: number, docs: Array<object>}} value - 工具结果
 * @returns {string} 文本
 */
export function renderToolText(value) {
  const docs = value && Array.isArray(value.docs) ? value.docs : []
  const total = Number.isInteger(value && value.total) ? value.total : docs.length
  if (docs.length === 0) return 'No Markdown documents found in the workspace.'

  // 「共 total 篇」回答「是不是漏了」；「IDF-weighted … not a keyword count or filename match」
  // 回答「凭什么信这个排名」—— 后者才是 agent 自己再 grep 一遍的真正原因（v0.9）。
  const scope = ` of ${total} Markdown document${total === 1 ? '' : 's'}`

  // 退化情形要**如实说明**，与面板那行「对话内容还不足，暂按最新排序」同一个口径
  const head = value.mode === 'time'
    ? `Not enough conversation to rank by relevance — showing the ${docs.length} most recently modified${scope}:`
    : `Top ${docs.length}${scope} in this workspace, ranked by IDF-weighted relevance to `
      + `${value.topic ? `「${value.topic}」` : 'the current conversation'} `
      + '(rare terms weighted, length-normalised — not a keyword count or filename match):'

  const lines = docs.map((doc, index) => {
    const summary = oneLine(doc.summary)
    // 命中段落（v0.11）：给模型判断「要不要读整篇」用。
    // 用一个 `match:` 前缀把它和**首段摘要**区分开 —— 两者都是一行压平的文本，
    // 不加标记的话模型分不清哪行是什么。
    const snippet = doc.snippet ? flatten(doc.snippet, SNIPPET_CHARS) : ''
    return `${index + 1}. ${doc.rel} — ${doc.title}`
      + `${summary ? `\n   ${summary}` : ''}`
      + `${snippet ? `\n   match: ${snippet}` : ''}`
  })

  return [head, ...lines].join('\n')
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
 * @returns {object} 工具定义
 */
export function knitDocsDefinition(scan, read) {
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
      render: (_args, value) => [{ type: 'text', text: renderToolText(value) }],
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

      const payload = await scan(root, limit, {
        session,
        sessionId,
        sort: 'relevance',
        query,
      })

      // 命中词用 `scan()` 的 `keywords` —— 它是**语料里真实存在**的那批词
      // （不是原始候选），所以拿它去原文里找段落，必然找得到。
      // 时间序模式下它是空数组 ⇒ terms 为空 ⇒ 不抽段落，正合语义。
      const terms = Array.isArray(payload.keywords) ? payload.keywords : []

      const docs = await Promise.all((payload.docs || []).map(async (doc) => {
        const row = {
          rel: String(doc.rel || ''),
          title: String(doc.title || ''),
          summary: doc.summary == null ? '' : String(doc.summary),
          mtimeMs: Number.isFinite(doc.mtimeMs) ? Math.trunc(doc.mtimeMs) : 0,
        }
        const snippet = await snippetFor(root, row.rel, terms, row.title)
        // 抽不到就**不带这个字段**，不写空串 —— 让「没有命中」和「命中但没抽出来」
        // 在输出里都是「没有 match 行」，而不是一行空的 `match: `
        if (snippet) row.snippet = snippet
        return row
      }))

      return {
        mode: payload.mode === 'relevance' ? 'relevance' : 'time',
        topic: typeof payload.topic === 'string' ? payload.topic : '',
        // `scan()` 的 total 是**全量池子**的条数（在 limit 切片之前），
        // 正好是这里要的「工作区一共有多少篇」。
        total: Number.isInteger(payload.total) ? payload.total : 0,
        docs,
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
 * @returns {() => void} 注销函数
 */
export function registerKnitDocsTool(ctx, scan, read) {
  return ctx.tools.register(knitDocsDefinition(scan, read))
}
