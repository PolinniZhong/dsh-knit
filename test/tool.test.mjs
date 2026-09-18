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
  knitDocsDefinition,
  registerKnitDocsTool,
} from '../src/host/tool.js'
import { scan, apply } from '../src/host/index.js'

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
 * @param {object} exec - 执行上下文
 * @param {object} args - 参数
 * @returns {Promise<object>} 工具结果
 */
async function runTool(exec, args = {}) {
  return knitDocsDefinition(scan).execute(args, exec)
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
  assert.doesNotThrow(() => apply({ inject: () => {} }))
})

/* ── 定义形状（与官方 defineTool 的产物对齐）─────────── */

test('定义形状: 参数与输出 schema 与 defineTool 的编译产物一致', () => {
  const definition = knitDocsDefinition(scan)
  // 两个参数都可选 → 没有 required，根对象也没有 additionalProperties
  assert.deepEqual(Object.keys(definition.parameters.properties), ['query', 'limit'])
  assert.equal(definition.parameters.type, 'object')
  assert.equal(definition.parameters.required, undefined)
  // 输出是严格的：根与 items 都 additionalProperties: false，且字段必填
  assert.equal(definition.output.schema.additionalProperties, false)
  assert.deepEqual(definition.output.schema.required, ['mode', 'topic', 'total', 'docs'])
  assert.deepEqual(definition.output.schema.properties.mode.enum, ['relevance', 'time'])
  assert.equal(definition.output.schema.properties.total.type, 'integer')
  assert.equal(definition.output.schema.properties.docs.items.additionalProperties, false)
  assert.deepEqual(
    definition.output.schema.properties.docs.items.required,
    ['rel', 'title', 'summary', 'mtimeMs'],
  )
  // 定义里不许出现 score —— 相对分数会被模型当成绝对置信度
  assert.ok(
    !Object.keys(definition.output.schema.properties.docs.items.properties).includes('score'),
    '输出里不该有 score',
  )
})

test('定义形状: 描述够短（它进每一次请求的系统提示词）', () => {
  const words = knitDocsDefinition(scan).description.split(/\s+/).length
  assert.ok(words <= 60, `工具描述 ${words} 个词，太长了`)
})

/* ── 排序 ───────────────────────────────────────────── */

test('不传 query: 用当前对话排序', async () => {
  const session = fakeSession([userMessage(1, 'sidebar 是什么？相关性排序呢')])
  const result = await runTool(fakeExec(session))
  assert.equal(result.mode, 'relevance')
  assert.ok(result.docs.length > 0, '应当有结果')
  assert.equal(result.docs[0].rel, 'README.md', '样本里只有 README 含 sidebar')
  assert.ok(result.topic.length > 0, '应当给出话题')
})

test('传 query: 用 query 排序，而不是用对话', async () => {
  const session = fakeSession([userMessage(1, 'sidebar 是什么？')])
  const byConversation = await runTool(fakeExec(session))
  const byQuery = await runTool(fakeExec(session), { query: '笔记' })
  assert.equal(byConversation.docs[0].rel, 'README.md')
  assert.equal(byQuery.docs[0].rel, 'docs/notes.md', 'query 应当压过对话')
})

test('传 query 时不需要会话也能排序（query 不查会话缓存）', async () => {
  const result = await runTool(fakeExec(fakeSession([])), { query: 'sidebar' })
  assert.equal(result.mode, 'relevance')
  assert.equal(result.docs[0].rel, 'README.md')
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

test('limit: 真的限制了返回条数', async () => {
  const session = fakeSession([])
  const result = await runTool(fakeExec(session), { limit: 1 })
  assert.equal(result.docs.length, 1)
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
  assert.ok(!serialized.includes(PROJECT_ROOT), `不该出现绝对路径：${serialized}`)
  for (const doc of result.docs) {
    assert.equal(typeof doc.rel, 'string')
    assert.ok(!doc.rel.startsWith('/'), 'rel 必须是工作区相对路径')
    assert.ok(Number.isInteger(doc.mtimeMs), 'mtimeMs 必须是整数')
    assert.equal(typeof doc.summary, 'string')
  }
})

test('空工作区: 返回空数组并渲染出「没找到」', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const bare = mkdtempSync(join(tmpdir(), 'knit-bare-'))
  const result = await runTool(fakeExec(fakeSession([], { cwd: bare })))
  assert.deepEqual(result.docs, [])
  assert.match(renderToolText(result), /No Markdown documents found/)
})

/* ── 渲染 ───────────────────────────────────────────── */

test('renderToolText: 有序号、rel、标题与单行摘要', () => {
  const text = renderToolText({
    mode: 'relevance',
    topic: '排序、sidebar',
    total: 9,
    docs: [
      { rel: 'docs/a.md', title: '甲', summary: '第一行\n第二行', mtimeMs: 1 },
      { rel: 'docs/b.md', title: '乙', summary: '', mtimeMs: 2 },
    ],
  })
  assert.match(text, /Top 2 of 9 Markdown documents in this workspace/)
  assert.match(text, /ranked by IDF-weighted relevance to 「排序、sidebar」/)
  assert.match(text, /1\. docs\/a\.md — 甲/)
  assert.match(text, /第一行 第二行/, '摘要要压成一行')
  assert.match(text, /2\. docs\/b\.md — 乙/)
})

test('renderToolText: 头部同时回答「漏没错」与「凭什么信这个排名」', () => {
  // v0.8 只答了前者（`of N`），真机验证显示 agent 照样自己 grep 一遍 ——
  // 因为它不认这个排名。v0.9 补上后者。
  const relevance = renderToolText({
    mode: 'relevance', topic: 'x', total: 21,
    docs: [{ rel: 'a.md', title: '甲', summary: '', mtimeMs: 1 }],
  })
  assert.match(relevance, /of 21 Markdown documents in this workspace/, '要回答「一共多少篇」')
  assert.match(relevance, /not a keyword count or filename match/, '要回答「凭什么信这个排名」')
  assert.match(relevance, /rare terms weighted/, '要说清权重口径')

  const time = renderToolText({
    mode: 'time', topic: '', total: 21,
    docs: [{ rel: 'a.md', title: '甲', summary: '', mtimeMs: 1 }],
  })
  assert.match(time, /most recently modified of 21 Markdown documents/)

  // 没有 total 时回落成返回条数，不写 undefined
  const fallback = renderToolText({
    mode: 'relevance', topic: '', docs: [{ rel: 'a.md', title: '甲', summary: '', mtimeMs: 1 }],
  })
  assert.match(fallback, /of 1 Markdown document/)
  assert.ok(!fallback.includes('undefined'))
})

test('renderToolText: 只有一篇时用单数', () => {
  const text = renderToolText({
    mode: 'relevance', topic: '', total: 1,
    docs: [{ rel: 'a.md', title: '甲', summary: '', mtimeMs: 1 }],
  })
  assert.match(text, /of 1 Markdown document in this workspace/)
  assert.ok(!text.includes('documents'))
})

test('renderToolText: 超长摘要被截断', () => {
  const text = renderToolText({
    mode: 'relevance',
    topic: '',
    docs: [{ rel: 'a.md', title: '甲', summary: 'x'.repeat(500), mtimeMs: 1 }],
  })
  assert.ok(!text.includes('x'.repeat(200)), '摘要必须截断')
  assert.match(text, /…/)
})

test('renderToolText: 没有话题时不写空引号', () => {
  const text = renderToolText({
    mode: 'relevance',
    topic: '',
    docs: [{ rel: 'a.md', title: '甲', summary: '', mtimeMs: 1 }],
  })
  assert.match(text, /to the current conversation/)
  assert.ok(!text.includes('「」'))
})
