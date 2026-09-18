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
 * 模型面向的描述。**必须短** —— 它会进每一次请求的系统提示词。
 *
 * v0.8 把最后一句换成了「Reports how many exist in total」。起因是**真机验收的实测**：
 * agent 每次调用完 `knit_docs`，都又跑一遍 `find` / `glob` / `grep` 去**交叉验证**
 * —— 它不认为这个结果是完整的。结果里给出总数、描述里说明它数得全，
 * 就是为了消掉这次多余的调用。
 */
const DESCRIPTION = 'List Markdown documents that already exist in this project, '
  + 'ranked by relevance to the current conversation (or to an explicit query). '
  + 'Reports how many exist in total, so there is no need to glob or find them separately. '
  + 'Reads the workspace only — it stores nothing and calls no model.'

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
function oneLine(text) {
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS)}…` : flat
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

  // 「共 total 篇，这里是前 docs.length 篇」—— 一部分用来消除「是不是漏了」的疑问
  const scope = ` of ${total} Markdown document${total === 1 ? '' : 's'} in this workspace`

  // 退化情形要**如实说明**，与面板那行「对话内容还不足，暂按最新排序」同一个口径
  const head = value.mode === 'time'
    ? `Not enough conversation to rank by relevance — showing the ${docs.length} most recently modified${scope}:`
    : `Top ${docs.length}${scope}, by relevance to ${value.topic ? `「${value.topic}」` : 'the current conversation'}:`

  const lines = docs.map((doc, index) => {
    const summary = oneLine(doc.summary)
    return `${index + 1}. ${doc.rel} — ${doc.title}${summary ? `\n   ${summary}` : ''}`
  })

  return [head, ...lines].join('\n')
}

/**
 * 造出 `knit_docs` 的 `ToolDefinition`。
 *
 * 形状与官方 `defineTool(...)` 的产物一致：`{ name, description, parameters, output, execute }`。
 *
 * @param {Function} scan - 宿主的扫描函数（注入进来，避免 index.js ↔ tool.js 循环 import）
 * @returns {object} 工具定义
 */
export function knitDocsDefinition(scan) {
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

      return {
        mode: payload.mode === 'relevance' ? 'relevance' : 'time',
        topic: typeof payload.topic === 'string' ? payload.topic : '',
        // `scan()` 的 total 是**全量池子**的条数（在 limit 切片之前），
        // 正好是这里要的「工作区一共有多少篇」。
        total: Number.isInteger(payload.total) ? payload.total : 0,
        docs: (payload.docs || []).map((doc) => ({
          rel: String(doc.rel || ''),
          title: String(doc.title || ''),
          summary: doc.summary == null ? '' : String(doc.summary),
          mtimeMs: Number.isFinite(doc.mtimeMs) ? Math.trunc(doc.mtimeMs) : 0,
        })),
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
 * @returns {() => void} 注销函数
 */
export function registerKnitDocsTool(ctx, scan) {
  return ctx.tools.register(knitDocsDefinition(scan))
}
