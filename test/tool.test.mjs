/**
 * Knit v0.7 · agent 文档工具 `knit_docs` 的测试。
 *
 * 不起真 DSH：用一个假 `ctx`（`inject` + `effect`）和一个假 `exec`
 * （`agent.session.header`），工作区用 `fixture.mjs` 在 tmpdir 里现造 ——
 * 这样测试在任何目录布局下都能跑（AGENTS.md §6.8 的教训）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeWorkspace } from './fixture.mjs'
import {
  TOOL_NAME,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  clampLimit,
  agentScope,
  renderToolText,
  pickSnippet,
  knitDocsDefinition,
  registerKnitDocsTool,
} from '../src/host/tool.js'
import { scan, apply, readDocument, buildContextFor, publicScanPayload } from '../src/host/index.js'
// 校验器与真机探针**共用同一份** —— 两边各写一份必然漂移，
// 而它锁的恰恰是「工具返回值 vs 它自己的 schema」这件最容易腐坏的事。
import { validateAgainst } from '../tools/json-schema-subset.mjs'

const PROJECT_ROOT = makeWorkspace()

/**
 * 造一个假会话：只需要 `header`（cwd + id）与 `snapshotEvents()`。
 * @param {object[]} events - 会话事件
 * @param {object} [header] - 覆盖 header
 * @returns {object} 假会话
 */
function fakeSession(events, header = {}) {
  return {
    header: { cwd: PROJECT_ROOT, id: 'sess-tool-test', ...header },
    snapshotEvents: () => events,
  }
}

/**
 * 造一条用户消息事件。
 * @param {number} seq - 序号
 * @param {string} text - 文本
 * @returns {object} 事件
 */
function userMessage(seq, text) {
  return {
    type: 'user/message',
    seq,
    time: Date.now(),
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

/**
 * 造一个假 exec。
 * @param {object|undefined} session - 会话；不传表示非 agent 调用方
 * @returns {object} exec
 */
function fakeExec(session) {
  return session === undefined ? {} : { agent: { session } }
}

/**
 * 调一次工具并返回规范化结果。
 *
 * v0.14 起工具返回的是三层 Context Pack —— 把 `buildContextFor` 一起注入，
 * 走的就是宿主真实的那条路（不再有「测试里退化成一列」这种与生产不一致的分支）。
 *
 * @param {object} exec - 执行上下文
 * @param {object} args - 参数
 * @param {{read?: Function, contextFor?: Function, audit?: object}} [deps] - 覆盖注入的依赖
 * @returns {Promise<object>} 工具结果
 */
async function runTool(exec, args = {}, deps = {}) {
  const read = 'read' in deps ? deps.read : undefined
  const contextFor = 'contextFor' in deps ? deps.contextFor : buildContextFor
  const audit = 'audit' in deps ? deps.audit : undefined
  return knitDocsDefinition(scan, read, contextFor, audit).execute(args, exec)
}

/**
 * 把三层摊平成一条（顺序：primary → supporting → related）。
 *
 * 测试要断言「一共返回了几条」或「某篇在不在结果里」时用它 ——
 * 分层本身该由 `context-eval.test.mjs` 断言，这里只关心工具层的接线。
 *
 * @param {object} result - 工具结果
 * @returns {object[]} 条目
 */
function allItems(result) {
  return [...(result.primary || []), ...(result.supporting || []), ...(result.related || [])]
}

/* ── 注册 ───────────────────────────────────────────── */

/** 造一个只带 `tools` + `effect` 的假 ctx。 */
function fakeToolCtx() {
  const state = { definitions: [], effects: [], disposed: 0 }
  return {
    state,
    ctx: {
      tools: {
        register: (definition) => {
          state.definitions.push(definition)
          return () => { state.disposed += 1 }
        },
      },
      effect: (fn, label) => {
        const dispose = fn()
        state.effects.push({ label, dispose })
        return dispose
      },
    },
  }
}

test('registerKnitDocsTool: 注册一个叫 knit_docs 的工具', () => {
  const { state, ctx } = fakeToolCtx()
  registerKnitDocsTool(ctx, scan)
  assert.equal(state.definitions.length, 1)
  assert.equal(state.definitions[0].name, TOOL_NAME)
  assert.equal(TOOL_NAME, 'knit_docs')
})

test('registerKnitDocsTool: 返回的注销函数能被调用', () => {
  const { state, ctx } = fakeToolCtx()
  const dispose = registerKnitDocsTool(ctx, scan)
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(state.disposed, 1, '注销应当透传到 tools.register 的返回值')
})

test('apply: 只给 tools（webServer 缺席）时仍然注册工具', () => {
  // 这条钉死「两条路互相独立」：面板要 webServer，工具要 tools，
  // 谁先到都该各自起来。如果哪天有人把 'tools' 并进上面那个 inject 数组，
  // 这条会红 —— 那时 webServer 一缺席，工具也一起没了。
  const registered = []
  const rootCtx = {
    on: () => {},
    inject: (deps, cb) => {
      if (deps.includes('tools')) {
        cb({
          tools: { register: (definition) => { registered.push(definition); return () => {} } },
          effect: (fn) => fn(),
        })
      }
      // webServer 那条故意不回调 —— 模拟「服务还没到」
    },
  }
  apply(rootCtx)
  assert.equal(registered.length, 1, 'webServer 缺席不该拖住工具的注册')
  assert.equal(registered[0].name, TOOL_NAME)
})

test('apply: webServer 与 tools 都缺席时不抛错', () => {
  assert.doesNotThrow(() => apply({ on: () => {}, inject: () => {} }))
})

/* ── 定义形状（与官方 defineTool 的产物对齐）─────────── */

test('定义形状: 参数与输出 schema 与 defineTool 的编译产物一致', () => {
  const definition = knitDocsDefinition(scan)
  // 三个参数都可选 → 没有 required，根对象也没有 additionalProperties
  // v0.15 加了 `audit`（默认 false：不传它完全不走 Context Feedback）
  assert.deepEqual(Object.keys(definition.parameters.properties), ['query', 'limit', 'audit'])
  assert.equal(definition.parameters.properties.audit.type, 'boolean')
  assert.equal(definition.parameters.type, 'object')
  assert.equal(definition.parameters.required, undefined)
  // 输出是严格的：根与 items 都 additionalProperties: false，且字段必填
  assert.equal(definition.output.schema.additionalProperties, false)
  assert.deepEqual(
    definition.output.schema.required,
    ['mode', 'topic', 'total', 'primary', 'supporting', 'related'],
  )
  assert.deepEqual(definition.output.schema.properties.mode.enum, ['relevance', 'time'])
  assert.equal(definition.output.schema.properties.total.type, 'integer')
  // v0.14：三层都是同一套 item schema
  for (const tier of ['primary', 'supporting', 'related']) {
    const items = definition.output.schema.properties[tier].items
    assert.equal(items.additionalProperties, false, `${tier} 的条目必须是严格对象`)
    assert.deepEqual(
      items.required,
      ['rel', 'title', 'summary', 'mtimeMs', 'kind', 'source', 'reason'],
    )
    // 定义里不许出现 score / raw —— 相对分数会被模型当成绝对置信度
    assert.ok(!Object.keys(items.properties).includes('score'), `${tier} 里不该有 score`)
    assert.ok(!Object.keys(items.properties).includes('raw'), `${tier} 里不该有 raw`)
    // ⚠️ v0.14 回归守卫：`kind` **必须**被声明。它是 `buildContext()` 每条都给的字段，
    // 而 schema 是 `additionalProperties: false` —— 少声明一个字段，
    // 工具就会在**校验层**失败，agent 一个 Context Pack 都拿不到（真机上踩过：
    // 4 个 Treatment 会话 100% 报 `"value.primary[0].kind" is not a declared property`）。
    assert.equal(items.properties.kind.type, 'string', `${tier} 必须声明 kind`)
    // reason 是结构化理由：码 + 命中的词 + 跨几个字段 + 代表词。**没有**自由文本解释。
    assert.deepEqual(
      Object.keys(items.properties.reason.properties).sort(),
      ['code', 'fields', 'term', 'terms'],
      `${tier} 的 reason 只该有这四个字段`,
    )
    // `term` 在 `explainContext()` 每条分支上都有值 → 声明成可选就是形状漂移
    assert.deepEqual(
      items.properties.reason.required,
      ['code', 'terms', 'fields', 'term'],
      `${tier} 的 reason 四个字段都必填`,
    )
  }
  // 根上另外两个字段：`totals`（渲染头部用的计数，只有 relevance 模式有）
  // 与 `docs`（时间序退回的那一列，形状比三层窄）。两者都不能进 required。
  assert.equal(definition.output.schema.properties.totals.type, 'object')
  assert.deepEqual(definition.output.schema.properties.totals.required, ['matched', 'total'])
  // v0.15：`usage` 是**可选**的字符串（`audit: true` 时才出现）—— 绝不能进 required，
  // 否则不传 audit 的每一次调用都会在校验层失败。
  assert.equal(definition.output.schema.properties.usage.type, 'string')
  assert.ok(
    !definition.output.schema.required.includes('usage'),
    'usage 必须可选：不传 audit 时它连键都不出现',
  )
  assert.equal(definition.output.schema.properties.docs.type, 'array')
  assert.deepEqual(
    Object.keys(definition.output.schema.properties.docs.items.properties).sort(),
    ['mtimeMs', 'rel', 'snippet', 'summary', 'title'],
  )
})

test('定义形状: 描述够短（它进每一次请求的系统提示词）', () => {
  const words = knitDocsDefinition(scan).description.split(/\s+/).length
  assert.ok(words <= 60, `工具描述 ${words} 个词，太长了`)
})

/* ── 自洽性：真实返回值 vs 它自己的 schema ──────────── */

test('自洽性: 真实 execute() 的返回值必须通过它自己的 OUTPUT_SCHEMA', async () => {
  // 这条测试是**补一个真实的洞**。此前所有 tool 测试都是拿手写的假 payload 测
  // `renderToolText()`，从来没有把 `execute()` 的真实返回丢给自己的 schema 校验过
  // —— 于是 v0.14 上线时 `knit_docs` 每次调用都在校验层失败（`kind` /
  // `reason.term` / `totals` 三个字段没声明、`mtimeMs` 是浮点），而 335 条测试全绿。
  // 真机上 4 个 agent 会话 100% 报 invalid output，才发现。
  const schema = knitDocsDefinition(scan, readDocument, buildContextFor).output.schema

  // ① relevance 模式：有对话可依据 → 三层
  const relevance = await runTool(
    fakeExec(fakeSession([userMessage(1, '相关性排序与 BM25 的长度归一化')])),
    {},
    { read: readDocument },
  )
  assert.equal(relevance.mode, 'relevance')
  assert.deepEqual(
    validateAgainst(schema, relevance),
    [],
    'relevance 模式的返回值必须通过自己的 schema',
  )
  // 不能是「空对象也通过」——确认它真的走了三层、真的带了那几个新字段
  assert.ok(allItems(relevance).length > 0, '应当有结果')
  assert.ok(relevance.totals, 'relevance 模式必须带 totals')
  const sample = allItems(relevance)[0]
  assert.ok(Number.isInteger(sample.mtimeMs), 'mtimeMs 必须是整数（fs 给的是浮点）')
  assert.equal(typeof sample.kind, 'string', 'kind 必须在返回值里')
  assert.equal(typeof sample.reason.term, 'string', 'reason.term 必须在返回值里')

  // ② time 模式：没有 query、也没有对话可依据 → 退回一列「最近改动的」
  const time = await runTool(fakeExec(fakeSession([])), {}, { read: readDocument })
  assert.equal(time.mode, 'time')
  assert.deepEqual(
    validateAgainst(schema, time),
    [],
    'time 模式的返回值也必须通过自己的 schema（它走的是更窄的 `docs` 形状）',
  )
  assert.ok(time.docs.length > 0, 'time 模式应当给出最近改动的几篇')
})

test('自洽性: 校验器本身能抓到漏声明的字段（否则上面那条是空测试）', () => {
  const schema = knitDocsDefinition(scan).output.schema
  const good = {
    mode: 'relevance',
    topic: '',
    total: 0,
    primary: [],
    supporting: [],
    related: [],
    totals: { matched: 0, total: 0 },
  }
  assert.deepEqual(validateAgainst(schema, good), [], '合法形状不该报错')
  // 少一个必填字段
  assert.match(
    validateAgainst(schema, { ...good, mode: undefined }).join('\n'),
    /"value\.mode" must be one of/,
  )
  // 多一个没声明的字段（v0.14 真机上踩的正是这一类）
  assert.match(
    validateAgainst(schema, { ...good, bogus: 1 }).join('\n'),
    /"value\.bogus" is not a declared property/,
  )
  // 该是整数的地方给了浮点
  assert.match(
    validateAgainst(schema, { ...good, total: 1.5 }).join('\n'),
    /"value\.total" must be an integer/,
  )
})

/* ── 排序 ───────────────────────────────────────────── */

test('不传 query: 用当前对话排序', async () => {
  const session = fakeSession([userMessage(1, 'sidebar 是什么？相关性排序呢')])
  const result = await runTool(fakeExec(session))
  assert.equal(result.mode, 'relevance')
  const items = allItems(result)
  assert.ok(items.length > 0, '应当有结果')
  assert.equal(items[0].rel, 'README.md', '样本里只有 README 含 sidebar')
  assert.ok(result.topic.length > 0, '应当给出话题')
  // v0.14：命中的那篇进 Primary —— 唯一的话题词就在标题/正文里
  assert.equal(result.primary[0].rel, 'README.md', '直接命中的那篇应当是主要上下文')
})

test('传 query: 用 query 排序，而不是用对话', async () => {
  const session = fakeSession([userMessage(1, 'sidebar 是什么？')])
  const byConversation = await runTool(fakeExec(session))
  const byQuery = await runTool(fakeExec(session), { query: '笔记' })
  assert.equal(allItems(byConversation)[0].rel, 'README.md')
  assert.equal(allItems(byQuery)[0].rel, 'docs/notes.md', 'query 应当压过对话')
})

test('传 query 时不需要会话也能排序（query 不查会话缓存）', async () => {
  const result = await runTool(fakeExec(fakeSession([])), { query: 'sidebar' })
  assert.equal(result.mode, 'relevance')
  assert.equal(allItems(result)[0].rel, 'README.md')
})

test('对话为空且没传 query: 退回时间序并如实说明', async () => {
  const result = await runTool(fakeExec(fakeSession([])))
  assert.equal(result.mode, 'time')
  const text = renderToolText(result)
  assert.ok(/Not enough conversation/.test(text), `渲染文本要说实话：${text}`)
})

/* ── 边界与错误 ─────────────────────────────────────── */

test('exec.agent 缺失: 抛错而不是返回空结果', async () => {
  await assert.rejects(() => runTool(fakeExec(undefined)), /requires an owning agent session/)
})

test('cwd 缺失: 抛错，且不兜底到 process.cwd()', async () => {
  // 兜底到进程 cwd 会扫到一个不相干的项目并返回它的文档 —— 宁可报错
  const session = fakeSession([], { cwd: undefined })
  await assert.rejects(() => runTool(fakeExec(session)), /workspace root/)
})

test('clampLimit: 越界与非整数都回落到合法值', () => {
  assert.equal(clampLimit(undefined), DEFAULT_LIMIT)
  assert.equal(clampLimit('3'), DEFAULT_LIMIT, '字符串不是数字')
  assert.equal(clampLimit(1.9), 1)
  assert.equal(clampLimit(0), 1)
  assert.equal(clampLimit(-5), 1)
  assert.equal(clampLimit(999), MAX_LIMIT)
  assert.equal(clampLimit(Number.NaN), DEFAULT_LIMIT)
  assert.equal(clampLimit(Number.POSITIVE_INFINITY), DEFAULT_LIMIT)
})

test('limit: 只影响参与分层的候选池，不把 Context Pack 又切一刀', async () => {
  const session = fakeSession([userMessage(1, 'sidebar 相关性排序')])
  const result = await runTool(fakeExec(session), { limit: 1 })
  // 样本工作区只有 3 篇 Markdown；limit=1 只是缩小候选池，三层加起来不会超过它
  assert.ok(allItems(result).length <= 3)
  assert.ok(allItems(result).every((item) => typeof item.rel === 'string'))
})

test('agentScope: 从 exec 里取出的三个字段都可用', () => {
  const session = fakeSession([])
  const scope = agentScope(fakeExec(session))
  assert.equal(scope.root, PROJECT_ROOT)
  assert.equal(scope.sessionId, 'sess-tool-test')
  assert.equal(scope.session, session)
})

/* ── 结果净化 ───────────────────────────────────────── */

test('结果不泄漏内部字段，也不给绝对路径', async () => {
  const session = fakeSession([userMessage(1, 'sidebar 相关性排序')])
  const result = await runTool(fakeExec(session))
  const serialized = JSON.stringify(result)
  assert.ok(!serialized.includes('haystack'), '不该出现 haystack')
  assert.ok(!serialized.includes('"raw"'), '不该出现 raw')
  assert.ok(!serialized.includes('"score"'), '不该出现 score')
  // v0.14：分层信号也是内部输入 —— `strength` / `matchedTerms` / `rank` 一个都不许出去
  assert.ok(!serialized.includes('"strength"'), '不该出现 strength')
  assert.ok(!serialized.includes('matchedTerms'), '不该出现 matchedTerms')
  assert.ok(!serialized.includes(PROJECT_ROOT), `不该出现绝对路径：${serialized}`)
  const items = allItems(result)
  assert.ok(items.length > 0)
  for (const doc of items) {
    assert.equal(typeof doc.rel, 'string')
    assert.ok(!doc.rel.startsWith('/'), 'rel 必须是工作区相对路径')
    assert.ok(Number.isInteger(doc.mtimeMs), 'mtimeMs 必须是整数')
    assert.equal(typeof doc.summary, 'string')
    assert.equal(typeof doc.reason.code, 'string', '每条都必须能说出为什么在这里')
  }
})

test('空工作区: 返回空数组并渲染出「没找到」', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const bare = mkdtempSync(join(tmpdir(), 'knit-bare-'))
  const result = await runTool(fakeExec(fakeSession([], { cwd: bare })))
  assert.deepEqual(allItems(result), [])
  assert.match(renderToolText(result), /No documents or code files found/)
})

/* ── 渲染 ───────────────────────────────────────────── */

/**
 * 造一份三层 Context Pack（渲染测试用）。
 * @param {object} options - `{topic, total, primary, supporting, related, matched}`
 * @returns {object} 工具结果
 */
function packOf({ topic = '', total = 0, matched = 0, primary = [], supporting = [], related = [] } = {}) {
  const item = (row) => ({
    rel: row.rel,
    title: row.title,
    summary: row.summary == null ? '' : row.summary,
    mtimeMs: row.mtimeMs || 1,
    source: row.source || 'doc',
    reason: row.reason || { code: 'direct', terms: [topic].filter(Boolean), fields: 1 },
    ...(row.snippet ? { snippet: row.snippet } : {}),
  })
  return {
    mode: 'relevance',
    topic,
    total,
    primary: primary.map(item),
    supporting: supporting.map(item),
    related: related.map(item),
    totals: { matched, total },
  }
}

test('renderToolText: 三层各有序号、rel、标题、单行摘要与 Why 行', () => {
  const text = renderToolText(packOf({
    topic: '排序、sidebar',
    total: 9,
    matched: 3,
    primary: [{ rel: 'docs/a.md', title: '甲', summary: '第一行\n第二行', reason: { code: 'titleMatch', terms: ['排序'], fields: 1 } }],
    supporting: [
      { rel: 'docs/b.md', title: '乙', summary: '', reason: { code: 'bodyMatch', terms: ['sidebar'], fields: 1 } },
    ],
    related: [{ rel: 'CHANGELOG.md', title: '丙', summary: '', reason: { code: 'related', terms: [], fields: 0 } }],
  }))
  // v0.19：语料从「只有 Markdown」变成「文档 + 代码」，所以头部与空态的称谓
  // 也跟着换成「documents and code files」—— 说「Markdown documents」而语料里
  // 含着 `.ts`，是在对模型说假话（tool.js 里那段注释写了同样的理由）。
  assert.match(text, /Context for 「排序、sidebar」: 3 matching of 9 documents and code files/)
  assert.match(text, /split into primary \/ supporting \/ related by deterministic local rules/)
  assert.match(text, /Primary \(read these first\):/)
  assert.match(text, /Supporting \(evidence, implementation, next step\):/)
  assert.match(text, /Related \(background — do not start here\):/)
  assert.match(text, /1\. docs\/a\.md — 甲/)
  assert.match(text, /第一行 第二行/, '摘要要压成一行')
  assert.match(text, /Why: matched in the title \(排序\)/)
  assert.match(text, /Why: matched in the body \(sidebar\)/)
  assert.match(text, /Why: related in the current workspace/)
})

test('renderToolText: 头部同时回答「漏没错」与「凭什么信这个排名」', () => {
  // v0.8 只答了前者（`of N`），真机验证显示 agent 照样自己 grep 一遍 ——
  // 因为它不认这个排名。v0.9 补上后者；v0.14 换成「分层不是平铺」的说法。
  const relevance = renderToolText(packOf({
    topic: 'x', total: 21, matched: 4,
    primary: [{ rel: 'a.md', title: '甲', summary: '' }],
  }))
  assert.match(relevance, /of 21 documents and code files/, '要回答「一共多少篇」')
  assert.match(relevance, /not a flat relevance list/, '要回答「这跟平铺列表有什么不一样」')
  assert.match(relevance, /IDF-weighted relevance/, '要说清排名口径')

  const time = renderToolText({
    mode: 'time', topic: '', total: 21, docs: [{ rel: 'a.md', title: '甲', summary: '', mtimeMs: 1 }],
  })
  assert.match(time, /most recently modified of 21 documents and code files/)
  assert.match(time, /Not enough conversation/)

  // 没有 total 时不写 undefined
  const fallback = renderToolText(packOf({
    topic: '', total: 0, matched: 1, primary: [{ rel: 'a.md', title: '甲', summary: '' }],
  }))
  assert.ok(!fallback.includes('undefined'))
})

test('renderToolText: 只有一篇时用单数', () => {
  const text = renderToolText(packOf({
    total: 1, matched: 1, primary: [{ rel: 'a.md', title: '甲', summary: '' }],
  }))
  assert.match(text, /1 matching of 1 document and code file,/)
  assert.ok(!text.includes('1 matching documents'))
})

test('renderToolText: 超长摘要被截断', () => {
  const text = renderToolText(packOf({
    matched: 1, primary: [{ rel: 'a.md', title: '甲', summary: 'x'.repeat(500) }],
  }))
  assert.ok(!text.includes('x'.repeat(200)), '摘要必须截断')
  assert.match(text, /…/)
})

test('renderToolText: 没有话题时不写空引号', () => {
  const text = renderToolText(packOf({ matched: 1, primary: [{ rel: 'a.md', title: '甲', summary: '' }] }))
  assert.match(text, /Context for the current conversation/)
  assert.ok(!text.includes('「」'))
})

test('renderToolText: 三层都空时才说「没找到」', () => {
  assert.match(renderToolText(packOf({})), /No documents or code files found/)
  // 只有 Related 有内容 —— 仍然要渲染出来（它是「背景资料」，不是没有）
  const onlyRelated = renderToolText(packOf({
    matched: 0, total: 5, related: [{ rel: 'a.md', title: '甲', summary: '' }],
  }))
  assert.match(onlyRelated, /Related \(background — do not start here\):/)
  assert.ok(!onlyRelated.includes('No documents or code files found'))
})

test('renderToolText: 工作区有文档或代码、但话题一个词都没命中 —— 不许说成「工作区里是空的」', () => {
  // 真机实测的场景：问「路径越界怎么防」，49 篇一篇都没命中（文档侧只看每篇前 2500 字，
  // 而这个词在 5 篇 .md 里全部出现在 2500 字之后）。原先这里打印的是
  // "No Markdown documents found in the workspace." —— 工作区里明明有 49 篇。
  const text = renderToolText(packOf({ total: 49 }))
  assert.ok(!text.includes('No documents or code files found'), '总数为 49 时不能说「一篇都没有」')
  assert.match(text, /No document or code file matched the current topic/)
  assert.match(text, /0 of 49 documents and code files/)
  assert.match(text, /2500 characters/) // 窗口限制必须说出来
  assert.match(text, /grep/) // 并给下一步

  // 真的空工作区仍然走原来那句
  assert.match(renderToolText(packOf({ total: 0 })), /No documents or code files found in the workspace\./)
})

/* ── v0.11 ②：命中段落 ───────────────────────────────── */

test('pickSnippet: 空输入 / 空命中词 → 空串', () => {
  assert.equal(pickSnippet('', ['a']), '')
  assert.equal(pickSnippet('正文。', []), '')
  assert.equal(pickSnippet(null, ['a']), '')
  assert.equal(pickSnippet('正文。', ['', '  ']), '', '空词被过滤后也应当是空串')
})

test('pickSnippet: 一块都没命中 → 空串（**不编造**）', () => {
  // 关键：不能退化成「随便给第一段」—— 那会让模型以为这里有相关内容
  assert.equal(pickSnippet('第一段。\n\n第二段。\n\n第三段。', ['不存在的词']), '')
})

test('pickSnippet: 选**含命中词的那一段**，不是第一段', () => {
  const text = '开头这段无关。\n\n中段才讲 BM25 的加权方式。\n\n结尾也无关。'
  const snippet = pickSnippet(text, ['bm25'])
  assert.match(snippet, /BM25/, '要含命中词')
  assert.ok(!snippet.includes('开头这段无关'), '不能给第一段')
  assert.ok(!snippet.includes('结尾也无关'), '不能给最后一段')
})

test('pickSnippet: 保留**原文大小写**（不是 haystack 的小写）', () => {
  // 这是设计的硬约束：README 承诺「打 BM25 就显示 BM25」
  const snippet = pickSnippet('前段。\n\n这里讲 BM25 与 IDF。\n\n后段。', ['bm25', 'idf'])
  assert.match(snippet, /BM25/)
  assert.match(snippet, /IDF/)
  assert.ok(!snippet.includes('bm25'), '不能是小写')
})

test('pickSnippet: 跳过与标题重复的块', () => {
  // 真机试跑时发现：H1 里含全部命中词 ⇒「命中最多」的块就是标题本身，
  // 而标题第 1 行已经给过了，再给一次是纯浪费。
  const text = '# BM25 入门\n\n这一节才展开讲 BM25 的饱和函数。\n'
  const withTitle = pickSnippet(text, ['bm25'], { title: 'BM25 入门' })
  assert.match(withTitle, /饱和函数/, '应当跳到正文那一块')
  assert.ok(!withTitle.includes('入门'), '不能是标题本身')

  // 不传 title 时没有这个排除（纯函数不猜）
  assert.match(pickSnippet(text, ['bm25']), /入门/)
})

test('pickSnippet: 超长块**以命中词为中心**截，不是从头截', () => {
  const head = '甲'.repeat(400)
  const text = `${head}这里有 BM25。${'乙'.repeat(400)}`
  const snippet = pickSnippet(text, ['bm25'])
  assert.ok(snippet.length <= 205, `应当截断，实际 ${snippet.length}`)
  assert.match(snippet, /BM25/, '命中词必须还在截断结果里')
  assert.match(snippet, /^…/, '左边被截掉要有省略号')
  assert.match(snippet, /…$/, '右边被截掉要有省略号')
})

test('pickSnippet: 只看评分窗口内的正文（2500 字之后不算）', () => {
  // 与 index.js 的 HAYSTACK_CHARS 对齐；否则会出现「排上来但段落里没有命中词」
  const text = `${'甲'.repeat(3000)}\n\nBM25 在很后面。`
  assert.equal(pickSnippet(text, ['bm25']), '')
})

test('execute: 传了 read 时命中的那篇带 snippet；没有命中词的篇**不带这个字段**', async () => {
  const exec = fakeExec(fakeSession([userMessage(1, 'sidebar')]))
  const withRead = await runTool(exec, { query: 'sidebar', limit: 3 }, { read: readDocument })
  const readme = allItems(withRead).find((d) => d.rel === 'README.md')
  assert.ok(readme, '样本里应当有 README.md')
  assert.match(String(readme.snippet), /sidebar/, '命中的那篇要带段落')

  // 一块都没命中的篇：**字段缺省**，而不是空串 —— 让「没有命中」在输出里表现为
  // 「没有 match 行」，而不是一行空的 `match: `
  const others = allItems(withRead).filter((d) => d.rel !== 'README.md')
  for (const doc of others) {
    assert.equal('snippet' in doc, false, `${doc.rel} 不该有 snippet 字段`)
  }
})

test('execute: 不传 read → 只是不带段落，分层照常给', async () => {
  const exec = fakeExec(fakeSession([userMessage(1, 'sidebar')]))
  const out = await runTool(exec, { query: 'sidebar', limit: 3 })
  assert.ok(allItems(out).length > 0, '不给 read 也要照常分层')
  for (const doc of allItems(out)) {
    assert.equal('snippet' in doc, false, '没给 read 就不该带段落')
  }
})

test('execute: read 抛错时**不影响**整次调用（只是少一段）', async () => {
  const exec = fakeExec(fakeSession([userMessage(1, 'sidebar')]))
  const boom = async () => { throw new Error('读盘炸了') }
  const out = await runTool(exec, { query: 'sidebar', limit: 3 }, { read: boom })
  assert.ok(allItems(out).length > 0, '排序结果照常返回')
  for (const doc of allItems(out)) assert.equal('snippet' in doc, false)
})

test('execute: read 返回失败信封时也只是少一段，不抛', async () => {
  const exec = fakeExec(fakeSession([userMessage(1, 'sidebar')]))
  const denied = async () => ({ ok: false, code: 'knit/outside-workspace' })
  const out = await runTool(exec, { query: 'sidebar', limit: 3 }, { read: denied })
  assert.ok(allItems(out).length > 0)
  for (const doc of allItems(out)) assert.equal('snippet' in doc, false)
})

test('execute: 时间序（无命中词）时不抽段落，也不硬凑三层', async () => {
  const exec = fakeExec(fakeSession([]))   // 没有对话 ⇒ mode=time
  const out = await runTool(exec, { limit: 3 }, { read: readDocument })
  assert.equal(out.mode, 'time')
  assert.deepEqual([out.primary, out.supporting, out.related], [[], [], []], '时间序不假装分了层')
  assert.ok(out.docs.length > 0, '时间序仍然给一列最近改动')
  for (const doc of out.docs) assert.equal('snippet' in doc, false, '时间序没有命中词可抽')
})

test('execute: 不注入 contextFor 时退化成空的三层（不抛、也没有平铺）', async () => {
  const exec = fakeExec(fakeSession([userMessage(1, 'sidebar')]))
  const out = await runTool(exec, { query: 'sidebar' }, { contextFor: undefined })
  assert.equal(out.mode, 'relevance')
  assert.deepEqual([out.primary, out.supporting, out.related], [[], [], []])
})

test('renderToolText: 有段落时多一行 `match:`，且行序是 标题 / 摘要 / Why / match', () => {
  const value = {
    mode: 'relevance', topic: '排序', total: 2,
    primary: [
      { rel: 'a.md', title: '甲', summary: '摘要甲', mtimeMs: 1, source: 'doc', reason: { code: 'titleMatch', terms: ['排序'], fields: 1 }, snippet: '命中段落甲' },
      { rel: 'b.md', title: '乙', summary: '摘要乙', mtimeMs: 2, source: 'doc', reason: { code: 'bodyMatch', terms: ['排序'], fields: 1 } },
    ],
    supporting: [], related: [], totals: { matched: 2, total: 2 },
  }
  const text = renderToolText(value, (item) => item.snippet || '')
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l === '1. a.md — 甲')
  assert.ok(at > 0, `应有序号行：${text}`)
  assert.equal(lines[at + 1], '   摘要甲', '摘要行紧跟标题行')
  assert.equal(lines[at + 2], '   Why: matched in the title (排序)', 'Why 行在摘要之后')
  assert.equal(lines[at + 3], '   match: 命中段落甲', '段落行在 Why 之后且带 match: 前缀')
  assert.ok(!text.includes('match: \n'), '没有段落时不该出现空的 match 行')
})

test('renderToolText: 不传 readSnippet → 段落字段被忽略（渲染函数无副作用）', () => {
  const value = {
    mode: 'relevance', topic: '', total: 1,
    primary: [{ rel: 'a.md', title: '甲', summary: '', mtimeMs: 1, source: 'doc', reason: { code: 'direct', terms: [], fields: 0 }, snippet: '不该出现' }],
    supporting: [], related: [], totals: { matched: 1, total: 1 },
  }
  const text = renderToolText(value)
  assert.ok(!text.includes('不该出现'), '没给 readSnippet 时不该读 snippet')
  assert.ok(!text.includes('match:'))
})

test('renderToolText: 段落用 SNIPPET_CHARS 截，**不是**摘要那个 90', () => {
  // 踩过的坑：段落提取是 200 字，若复用只认 90 的 oneLine 会被二次截断，
  // 而且测试不会报错（输出仍是合法的短文本）。
  const long = '丙'.repeat(200)
  const value = {
    mode: 'relevance', topic: '', total: 1,
    primary: [{ rel: 'a.md', title: '甲', summary: '', mtimeMs: 1, source: 'doc', reason: { code: 'direct', terms: [], fields: 0 }, snippet: long }],
    supporting: [], related: [], totals: { matched: 1, total: 1 },
  }
  const text = renderToolText(value, (item) => item.snippet)
  const matchLine = text.split('\n').find((l) => l.startsWith('   match: '))
  assert.ok(matchLine, '应当有 match 行')
  assert.ok(matchLine.length > 120, `段落不该被截到 90，实际 ${matchLine.length - 10}`)
})

test('renderToolText: 头部的命中数走 totals.matched —— 不能恒为 0', () => {
  // 实测踩过的真实缺陷：`execute` 返回的三层结果**没有带 totals**，
  // 于是 renderToolText 回落成 0，头部永远写「0 matching documents」，
  // 而下面明明列着五条结果 —— 自相矛盾，而且测试当时是全绿的。
  const value = {
    mode: 'relevance', topic: '排序', total: 44,
    primary: [{ rel: 'a.md', title: '甲', summary: '', mtimeMs: 1, source: 'doc', reason: { code: 'titleMatch', terms: ['排序'], fields: 1 } }],
    supporting: [], related: [],
    totals: { matched: 32, total: 44 },
  }
  const head = renderToolText(value).split('\n')[0]
  assert.match(head, /32 matching of 44 documents and code files/, head)
  assert.ok(!head.includes('0 matching'), '头部不能写 0 而下面列着结果')
})

test('execute: 返回的 totals 带上 matched 与 total', async () => {
  const session = fakeSession([userMessage(1, 'sidebar 相关性排序')])
  const out = await runTool(fakeExec(session))
  assert.ok(out.totals, '结果必须带 totals —— 渲染层靠它写头部的命中数')
  // v0.19：`total` 是**可进上下文的候选数**（文档 + 代码）。样本工作区里
  // README.md / docs/notes.md / CHANGELOG.md 三篇 Markdown **加上 package.json**
  // —— 后者在 v0.19 是合法的代码候选（json 在第一批范围内），所以从 3 变成 4。
  // 这个数字变了本身就是要证明的事：代码真的进了同一个检索池。
  assert.equal(out.totals.total, 4, '样本工作区有 3 篇 Markdown + 1 个 package.json')
  assert.ok(out.totals.matched >= 1, `命中了应当 > 0，实际 ${out.totals.matched}`)
  const head = renderToolText(out).split('\n')[0]
  assert.ok(!head.includes('0 matching'), head)
})

/* ── v0.15 · Context Audit 通道 ──────────────────────────
 *
 * 工具**不认识** `feedback.js`：它只认识一个被注入的桥
 * （`{summary, note}`）。这几条锁的就是这条接线的契约：
 *   · 不传 `audit: true` → 桥一个方法都不许被碰，返回里也没有 `usage` 键；
 *   · 传了 → **先 `summary()` 再 `note()`**（summary 报告的是**上一份**包）；
 *   · 桥坏了 → 工具照常返回（这是「Knit 坏了不许影响 Agent」那条纪律）。
 */

/** 造一个记账桥，记录调用顺序。 */
function fakeBridge({ summary = () => 'Usage since the last pack: 0 reads', note = () => null } = {}) {
  const calls = []
  return {
    calls,
    bridge: {
      // v0.16：桥只收 `(sessionId)` / `(sessionId, pack)` —— 读证据由订阅那条路进 store
      summary: (sessionId) => {
        calls.push({ fn: 'summary', sessionId })
        return summary(sessionId)
      },
      note: (sessionId, pack) => {
        calls.push({ fn: 'note', sessionId, pack })
        return note(sessionId, pack)
      },
    },
  }
}

test('audit: 不传 audit 时返回里没有 usage 键，桥一个方法都不许被碰', async () => {
  const session = fakeSession([userMessage(1, 'sidebar 相关性排序')])
  const { bridge, calls } = fakeBridge()
  const out = await runTool(fakeExec(session), {}, { audit: bridge })
  assert.ok(!('usage' in out), '默认（不传 audit）时不许出现 usage 键')
  assert.deepEqual(calls, [], '默认时不许碰记账桥 —— 它默认不是观测者，是关闭的')
  assert.ok(allItems(out).length > 0, '少了 usage 不该影响排序结果')
})

test('audit: true 时先问 summary 再 note，并把这一行放进返回的 usage', async () => {
  const session = fakeSession([userMessage(1, 'sidebar 相关性排序')])
  const { bridge, calls } = fakeBridge()
  const out = await runTool(fakeExec(session), { audit: true }, { audit: bridge })
  assert.equal(out.usage, 'Usage since the last pack: 0 reads')
  assert.deepEqual(
    calls.map((c) => c.fn),
    ['summary', 'note'],
    '顺序是契约：summary 报告的是**上一份**包，必须先问；note 记的是刚交出的这份',
  )
  const noted = calls.find((c) => c.fn === 'note')
  assert.equal(noted.sessionId, 'sess-tool-test', 'note 拿到的是会话 id')
  assert.equal(noted.root, undefined, 'v0.16：桥不再收工作区根（读路径由订阅回调自己归一化）')
  assert.equal(noted.hasSession, undefined, 'v0.16：桥不再收会话对象（它不再去拉事件）')
  assert.ok(noted.pack && noted.pack.totals, 'note 记的是刚交出去的那份包（含 totals）')
  // v0.19：3 篇 Markdown + package.json（代码候选）—— 与上一条同源。
  assert.equal(noted.pack.totals.total, 4)
})

test('audit: 桥抛错 / 返回非字符串时，工具照常返回且不带 usage', async () => {
  const session = fakeSession([userMessage(1, 'sidebar 相关性排序')])
  const boom = fakeBridge({
    summary: () => { throw new Error('记账坏了') },
    note: () => { throw new Error('记账坏了') },
  })
  const out = await runTool(fakeExec(session), { audit: true }, { audit: boom.bridge })
  assert.ok(!('usage' in out), '桥坏了就没有 usage —— 但不许把整次调用搞失败')
  assert.ok(allItems(out).length > 0, '排序结果必须照常给出')

  const weird = fakeBridge({ summary: () => 42, note: () => null })
  const out2 = await runTool(fakeExec(session), { audit: true }, { audit: weird.bridge })
  assert.ok(!('usage' in out2), '桥返回非字符串时当「没什么可说的」，不许把 42 塞进文本')

  const empty = fakeBridge({ summary: () => '' })
  const out3 = await runTool(fakeExec(session), { audit: true }, { audit: empty.bridge })
  assert.ok(!('usage' in out3), '空串同样不加这个键')
})

test('audit: 只给 audit 桥、没有会话（非 agent 调用方）时抛错照旧，不静默出空结果', async () => {
  const { bridge } = fakeBridge()
  await assert.rejects(
    () => runTool({}, { audit: true }, { audit: bridge }),
    /requires an owning agent session/,
  )
})

test('audit: audit 传字符串 "true" 不算数（只有真布尔才记账）', async () => {
  const session = fakeSession([userMessage(1, 'sidebar 相关性排序')])
  const { bridge, calls } = fakeBridge()
  const out = await runTool(fakeExec(session), { audit: 'true' }, { audit: bridge })
  assert.ok(!('usage' in out), '宽松的真值判断会让「字符串 true」也打开记账 —— 不接受')
  assert.deepEqual(calls, [])
})

test('registerKnitDocsTool: 第五个参数（记账桥）被透传给工具定义', () => {
  const { ctx, state } = fakeToolCtx()
  const { bridge } = fakeBridge()
  registerKnitDocsTool(ctx, scan, undefined, buildContextFor, bridge)
  assert.equal(state.definitions.length, 1)
  assert.deepEqual(Object.keys(state.definitions[0].parameters.properties), ['query', 'limit', 'audit'])
})

test('renderToolText: 有 usage 时它单独占最后一行，且不影响三层正文', () => {
  const value = {
    mode: 'relevance', topic: '排序', total: 44,
    primary: [{ rel: 'a.md', title: '甲', summary: '摘要', mtimeMs: 1, source: 'doc', reason: { code: 'titleMatch', terms: ['排序'], fields: 1 } }],
    supporting: [], related: [],
    totals: { matched: 32, total: 44 },
    usage: 'Usage since the last pack: 2 reads',
  }
  const text = renderToolText(value)
  const lines = text.split('\n')
  assert.equal(lines[lines.length - 1], 'Usage since the last pack: 2 reads')
  assert.equal(lines[lines.length - 2], '', '摘要与 usage 之间留一个空行')
  assert.match(text, /甲/, '三层正文照旧')
  // 没有 usage 时不留空行（不许出现尾部空行这种「看不出差别」的漂移）
  const without = renderToolText({ ...value, usage: undefined })
  assert.ok(!without.endsWith('\n'), without)
})
