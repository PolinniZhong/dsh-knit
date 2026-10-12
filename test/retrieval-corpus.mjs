/**
 * Knit v0.23 · **固定检索语料**（版本化、确定性、不打网络）。
 *
 * 用途只有一个：让「语义候选到底有没有把词法漏掉的东西补回来」这句话**可以被量**。
 * 所以这里放三样东西 —— **文档**（真的写成临时工作区去跑 `scan()`）、**任务查询**、
 * 以及每条查询**人工标注的「该命中谁」**（`expected`）。
 *
 * ⚠️ 三条诚实纪律（写这个文件时先读一遍）：
 *   1. `expected` 是**人写的答案**，不是「跑出来什么就算什么」。改语料必须重新想一遍标注。
 *   2. 语料里刻意放了**词法必漏**的样本（同义 / 命名不一致 / 中英错位），也刻意放了
 *      **hard negative**（话题相近、意图不同）。
 *   3. `fakeEmbed()` 是**确定性替身**，不是模型 —— 它是一个「加权同义词表」向量：
 *      能证明**管道**（候选算得出来、进得了包、有界、可复现），**不能**证明**价值**
 *      （真实 embedding 的召回质量）。任何把它跑出来的数字写成「语义检索提升召回」的说法
 *      都是错的 —— 见方案 §9.1 的诚实标注。
 *
 * 向量设计（为什么长这样）：同义词组一维，**泛化词权重低**（如「缓存」很多文档都提），
 * 词组权重高（如「失效 / TTL / stale」）。这是为了在语料里同时造出两种真实情况：
 *   · 「TTL 与 stale」这篇与查询「缓存失效策略」**共享具体概念** ⇒ 余弦高 ⇒ 会被语义补回来（该补）；
 *   · 「缓存大小与内存占用」这篇与查询**只共享泛化词** ⇒ 余弦低 ⇒ 不该被补（hard negative）。
 * 这个设计是**为这份语料造的**，不要拿它去推断真模型的行为。
 */

export const CORPUS_VERSION = 1

/* ── 文档（会真的写进临时工作区；`title` 会成为 H1，也是 BM25 的标题槽）── */

export const DOCS = [
  // ① 缓存族（同义表达：查询说「缓存失效」，正文只说 TTL / stale / 逐出）
  {
    rel: 'docs/cache-design.md',
    title: '缓存设计总览',
    body: '整体设计：读写路径、失效策略与逐出顺序。这里会出现「失效」二字，所以词法能命中。\n',
  },
  {
    rel: 'docs/cache-ttl.md',
    title: 'TTL 与 stale 数据',
    body: '过期数据怎么处理：TTL、stale-while-revalidate、逐出与作废顺序。\n',
  },
  {
    rel: 'docs/cache-size.md',
    title: '大小与内存占用',
    body: '容量上限、淘汰阈值与内存占用统计。与「过期」无关，是 hard negative。\n',
  },
  // ② 语义 / 向量族（命名不一致：代码文件名说 semantic，正文说 cosine）
  {
    rel: 'src/host/semantic.js',
    title: 'semantic.js',
    body: "// 余弦相似度与候选缓存\nconst TOP = 24\nexport function cosine(a, b) { /* dot / norm */ }\n",
  },
  {
    rel: 'docs/semantic-notes.md',
    title: '语义候选笔记',
    body: '记录一次实验：嵌入输入只取标题与摘要；候选有上界；失败要如实回退。\n',
  },
  // ③ 索引族（长 changelog 噪声 + 增量对账）
  {
    rel: 'docs/index-reconcile.md',
    title: '增量对账',
    body: '重启后复用索引；用内容指纹做有界对账，只重读真正变了的记录。\n',
  },
  {
    rel: 'CHANGELOG.md',
    title: '变更日志',
    body: ('索引、增量、对账、重读、指纹、缓存、向量、语义、载荷、预算这些词在这里反复出现，' +
      '但这一篇不是任何查询的答案 —— 它专门用来制造「词频高但无关」的噪声。\n').repeat(12),
  },
  // ④ 关系族（代码 + 文档混合）
  {
    rel: 'src/host/relations.js',
    title: 'relations.js',
    body: "// 引用图：出度 out / 入度 in\nexport function neighboursOf(graph, rel) { return graph.out.get(rel) }\n",
  },
  {
    rel: 'docs/relations.md',
    title: '关系事实',
    body: '每条关系只写可核验的事实：类型、箭头方向、对方路径与行号。\n',
  },
  // ⑤ 控制族（排除 / 固定；hard negative：.gitignore 也讲「排除」）
  {
    rel: 'docs/control-exclude.md',
    title: '排除与固定',
    body: '固定与排除互斥；排除先于检索生效，被排除的文件不得从任何路径回到包里。\n',
  },
  {
    rel: 'docs/gitignore-style.md',
    title: '忽略规则写法',
    body: '讲 .gitignore 的排除写法与通配符优先级 —— 与 Knit 的控制层无关。\n',
  },
  // ⑥ 载荷 / 预算
  {
    rel: 'docs/payload-budget.md',
    title: '载荷预算',
    body: '面板载荷硬上界 16 KB；工具输出不得超过基线的 1.4 倍，加字段必须重测。\n',
  },
  // ⑦ 使用反馈
  {
    rel: 'docs/feedback-attribution.md',
    title: '读归因',
    body: '归因在读那一刻结算并冻结：先记快照再入库，之后换多少份上下文都不会改口。\n',
  },
  // ⑧ 媒体
  {
    rel: 'docs/media-grid.md',
    title: '媒体网格',
    body: '视频取首帧当海报，角标给时长；缩略图格子基准固定 104px，纵向不封顶。\n',
  },
  // ⑨ 插件恢复
  {
    rel: 'docs/plugin-recovery.md',
    title: '插件不见了',
    body: '装不进去先别重装：多半是宿主换了独占的 profile，按手册判机制再修。\n',
  },
  // ⑩ 发布通道
  {
    rel: 'docs/release-oidc.md',
    title: '可信发布',
    body: '先推成功、三处对齐、最后才发；通道用 OIDC，绝不设 npm token。\n',
  },
  // ⑪ 预览高亮
  {
    rel: 'docs/preview-highlight.md',
    title: '语法高亮',
    body: '预览里的代码走官方高亮器，只给命中段那一带上色，超出窗口回落纯文本。\n',
  },
  // ⑫ 一批纯噪声（防止「随便什么都算命中」）
  {
    rel: 'docs/noise-a.md',
    title: '样本变更 A',
    body: '第三篇样本。\n',
  },
  {
    rel: 'docs/noise-b.md',
    title: '样本笔记 B',
    body: '第二篇样本，用来凑数。\n',
  },
]

/* ── 任务查询 + 人工标注 ─────────────────────────────
 * `expected`：这条查询**正确答案**（人工标注）。
 * `case`：这条查询想考什么（对应方案 §9.1 的七类）。
 */

export const QUERIES = [
  {
    id: 'synonym-cache',
    case: '同义表达',
    query: '缓存失效策略',
    expected: ['docs/cache-design.md'],
    rescue: ['docs/cache-ttl.md'], // 词法必漏（正文没有「缓存 / 失效」），语义该救回来
    note: '词法只能找到写了「失效」的那篇；写 TTL / stale 的那篇要靠语义。',
  },
  {
    id: 'naming-vector',
    case: '自然语言 ↔ 代码命名',
    query: '向量召回接口',
    expected: ['src/host/semantic.js', 'docs/semantic-notes.md'],
    rescue: ['src/host/semantic.js', 'docs/semantic-notes.md'],
    note: '代码文件里没有「向量 / 召回」这几个字（只有 cosine / TOP），词法必漏。',
  },
  {
    id: 'exact-match',
    case: '关键词完全匹配（防退化）',
    query: '逐出顺序',
    expected: ['docs/cache-design.md'],
    rescue: [],
    note: '字面命中：词法必须找得到，语义不许把结果弄丢。',
  },
  {
    id: 'long-changelog-noise',
    case: '长 changelog 噪声',
    query: '增量对账 指纹',
    expected: ['docs/index-reconcile.md'],
    rescue: [],
    note: 'CHANGELOG 里这些词出现上百次，词法靠 IDF 应当仍然压住它。',
  },
  {
    id: 'mixed-code-doc',
    case: '代码 + Markdown 混合',
    query: '引用关系',
    expected: ['src/host/relations.js', 'docs/relations.md'],
    rescue: [],
    note: '代码与文档在同一套 BM25 里竞争，两边都该出现（词法就该拿到它们）。',
  },
  {
    id: 'hard-negative-size',
    case: 'hard negative（语义容易犯错）',
    query: '缓存大小',
    expected: ['docs/cache-size.md'],
    rescue: [],
    note: '只共享泛化词「缓存」；讲 TTL / stale 的那篇与「大小」无关，语义**不许**把它补进来。',
  },
  {
    id: 'hard-negative-exclude',
    case: 'hard negative（词法侧）',
    query: '排除 忽略规则',
    expected: ['docs/control-exclude.md'],
    rescue: [],
    note: '两篇都讲「排除」：控制层那篇是答案，.gitignore 那篇是同词不同义的干扰项。',
  },
  {
    id: 'payload-budget',
    case: '预算 / 上界',
    query: '载荷 预算 上限',
    expected: ['docs/payload-budget.md'],
    rescue: [],
    note: '纯词法就能解决，用来确认语义没有帮倒忙。',
  },
  {
    id: 'feedback-freeze',
    case: '同义表达',
    query: '读归因冻结',
    expected: ['docs/feedback-attribution.md'],
    rescue: [],
    note: '正文没写「冻结」二字（写的是「改口」），考一次近义。',
  },
  {
    id: 'media-poster',
    case: '同义表达',
    query: '视频缩略图海报',
    expected: ['docs/media-grid.md'],
    rescue: [],
    note: '「缩略图 / 海报」都在正文里，词法应当命中。',
  },
  {
    id: 'plugin-profile',
    case: '自然语言 ↔ 术语',
    query: '插件装不进去 profile',
    expected: ['docs/plugin-recovery.md'],
    rescue: [],
    note: '「插件」二字在标题里 ⇒ 词法就能命中；这条用来确认语义没把它弄丢。',
  },
  {
    id: 'release-channel',
    case: '中英错位',
    query: '可信发布通道',
    expected: ['docs/release-oidc.md'],
    rescue: [],
    note: '正文有「通道」与「可信发布」拆开两处，词法可命中。',
  },
  {
    id: 'preview-window',
    case: '同义表达',
    query: '高亮窗口回落',
    expected: ['docs/preview-highlight.md'],
    rescue: [],
    note: '「窗口」「回落」都在正文里。',
  },
]

/* ── 确定性替身嵌入（加权同义词表；**不是模型**）──────── */

/** 同义词组。`weight` 越大越「具体」；泛化词的权重刻意压低。 */
export const CONCEPT_GROUPS = [
  { weight: 1.0, forms: ['失效', '过期', 'stale', 'ttl', '逐出', 'evict', '作废', 'invalidation'] },
  { weight: 0.3, forms: ['缓存', 'cache'] },
  { weight: 1.0, forms: ['向量', 'vector', '嵌入', 'embed', 'embedding'] },
  { weight: 0.6, forms: ['召回', 'recall', '语义', 'semantic', '相似度', 'similarity', '余弦', 'cosine'] },
  { weight: 1.0, forms: ['索引', 'index', '对账', 'reconcile', '指纹', 'fingerprint'] },
  { weight: 0.5, forms: ['增量', 'incremental', '重读', '重算'] },
  { weight: 1.0, forms: ['相关度', '排序', 'rank', 'ranking', 'bm25', 'idf', '词法', 'lexical'] },
  { weight: 1.0, forms: ['排除', 'exclude', '固定', 'pin', '控制层'] },
  { weight: 0.8, forms: ['忽略', 'gitignore', '通配符'] },
  { weight: 1.0, forms: ['大小', '容量', '内存', 'memory', 'size', '占用', '阈值'] },
  { weight: 1.0, forms: ['载荷', 'payload', '字段', 'field', 'schema', '契约'] },
  { weight: 1.0, forms: ['预算', 'budget', '上限', '字节', 'byte', 'kb'] },
  { weight: 1.0, forms: ['关系', 'relation', 'relations', '引用', 'reference', '出度', '入度', '链接', 'link'] },
  { weight: 1.0, forms: ['归因', '快照', 'snapshot', 'epoch', '冻结', '阅读', 'read'] },
  { weight: 1.0, forms: ['缩略图', '海报', 'poster', '媒体', 'media', '视频', 'video', '图片', 'image'] },
  // ⚠️ 刻意**不放** 'host'：代码文档的摘要位就是目录（`src/host/`），放了会把每一篇代码
  //    都往「插件」这一维上拉（实测：`src/host/semantic.js` 因此被稀释到 0.265，反而漏掉）。
  { weight: 1.0, forms: ['插件', 'plugin', 'profile', '装不进去', '不见了'] },
  { weight: 1.0, forms: ['发布', 'publish', 'npm', 'oidc', 'token', '版本', 'tag'] },
  { weight: 1.0, forms: ['高亮', 'highlight', '窗口', '回落', '语法'] },
]

/**
 * 确定性「嵌入」：同义词组命中数 × 组权重，L2 归一化。
 *
 * @param {string} text - 会被 `embedTextOf()` 拼成「标题 + 摘要」
 * @returns {number[]} 固定长度向量（长度 = 词组数）
 */
export function fakeEmbed(text) {
  const lower = String(text || '').toLowerCase()
  const vec = CONCEPT_GROUPS.map((group) => {
    let hits = 0
    for (const form of group.forms) {
      if (matchesForm(lower, form)) hits += 1
    }
    return hits * group.weight
  })
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0))
  return norm > 0 ? vec.map((v) => v / norm) : vec
}

/**
 * 一个词形有没有出现在文本里。
 *
 * ⚠️ 纯 ASCII 的词形必须按**词边界**判：`includes('read')` 会咬中 `README`，
 * `includes('ttl')` 会咬中 `nettl` 之类 —— 假替身因此凭空多出相似度（实测踩到过：
 * README 被当成「使用反馈」的候选）。中文按子串即可（没有词边界这回事）。
 *
 * @param {string} lower - 已小写化的文本
 * @param {string} form - 词形
 * @returns {boolean}
 */
function matchesForm(lower, form) {
  const needle = form.toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]*$/.test(needle)) return lower.includes(needle)
  return new RegExp(`\\b${needle}\\b`).test(lower)
}

/** 假 fetch 的默认 provider 配置（回环地址，永远不会被真的连）。 */
export const FAKE_PROVIDER = { kind: 'ollama', base: 'http://127.0.0.1:11434', model: 'corpus-standin-v1' }

/**
 * 确定性假 provider 的 `fetchImpl`（注入给 `createSemanticEngine`）。
 *
 * 回答两种请求：`/api/tags`（探测）与 `/api/embed`（嵌入）。
 * `calls` 会记下每一次调用 —— 判据「默认零调用」「每轮嵌入有上界」都靠它。
 *
 * @param {{probeStatus?: number, embedStatus?: number}} [options]
 * @returns {Function} fetch 替身（带 `calls` 数组）
 */
export function createFakeFetch(options = {}) {
  const calls = []
  const impl = async (url, init) => {
    const target = String(url)
    calls.push({ url: target, method: (init && init.method) || 'GET' })
    if (target.includes('/api/tags')) {
      const status = options.probeStatus || 200
      return { status, json: async () => ({ models: [] }) }
    }
    if (options.embedStatus && options.embedStatus !== 200) {
      return { status: options.embedStatus, json: async () => ({}) }
    }
    const input = JSON.parse((init && init.body) || '{"input":[]}').input
    return { status: 200, json: async () => ({ embeddings: input.map((text) => fakeEmbed(text)) }) }
  }
  impl.calls = calls
  return impl
}


/* ── 驱动 `scan()` 用的假会话 ─────────────────────────
 * ⚠️ 为什么不用 `scan({ query })` 这条更短的路：显式 query 路径**没有 task**
 * （`index.js` 里那条注释说得很清楚：模型自己知道在问什么，把 query 当任务「是编的」），
 * 于是语义引擎拿到的查询文本会退化成 `keywords.join(' ')` —— 而 `extractKeywords()`
 * 会给长词去重叠（`失效策` 吃掉 `失效`），实际传给 provider 的就只剩几个碎片。
 * 面板与带会话的工具走的是**会话路径**：`task` = 用户原话 ⇒ 语义查询文本就是原话。
 * 量尺要量的是那条路，所以这里造一个最小会话。
 */

/**
 * 造一个最小假会话（只需要 `header` 与 `snapshotEvents()`）。
 * @param {string} text - 用户那句话
 * @param {string} cwd - 工作区根
 * @returns {object} 假会话
 */
export function fakeSession(text, cwd) {
  return {
    header: { cwd, id: 'sess-corpus-eval' },
    snapshotEvents: () => [
      {
        seq: 1,
        type: 'user/message',
        // ⚠️ 事件形状要跟宿主一致：`data` **本身就是那条 message**（`role` + `content`），
        // `source` 挂在同一层。写成 `data.message` 的话 `messageText()` 取不到文本，
        // 会话路径会静默退化成「没有对话」⇒ 整条查询变成时间序（踩过一次）。
        data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
      },
    ],
  }
}

/** 把 `DOCS` 变成 `makeWorkspace()` 要的 `[rel, 内容]` 列表。 */
export function corpusFiles() {
  return DOCS.map((doc) => [doc.rel, `# ${doc.title}\n\n${doc.body}`])
}
