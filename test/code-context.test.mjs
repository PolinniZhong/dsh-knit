/**
 * Knit v0.19 · **Code Context 端到端**
 *
 * 这个文件回答的问题不是「`.js` 能不能显示」，而是需求 §49 那一串验收：
 *
 * ```text
 * Retrieval      代码能参与任务检索（文件名 > 路径 > 正文）
 * Context Pack   代码能成为 Primary / Supporting / Related
 * Read Evidence  代码被读取后归因**读时冻结**
 * Lifecycle      代码走同一个四态生命周期
 * Epoch / Delta  代码的进 / 出 / 换层能进当前 Context Epoch
 * Filtering      .map / minified / generated / lock 一条都不污染检索
 * ```
 *
 * 与相邻文件的分工（**刻意不重叠**）：
 *
 *   - `test/classification.test.mjs`  → 分类层本身（哪个后缀归哪一类、能力位）
 *   - `test/host.test.mjs`            → 扫描 / 读取接口的单点行为
 *   - `test/context.test.mjs`         → `buildContext()` 的规则（夹具一律 `kind:'md'`）
 *   - `test/eval.test.mjs`            → BM25 的 top-1 / MRR（文档语料）
 *   - **本文件**                      → 代码**穿过整条链路**之后还对不对
 *
 * ⚠️ 一条设计约束贯穿全文件：**代码不许有第二套机制**。所以这里用的每个入口
 * （`scan` / `buildContextFor` / `buildContext` / `ingestEvents` / `noteSnapshot` /
 * `usageFor` / `lifecycleOf`）都是 Markdown 走的同一个入口，只是 `rel` 换成了代码路径。
 * 任何一条断言如果必须靠「代码专用的分支」才能通过，那就说明实现跑偏了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { scan, collectDocs, readDocument, buildContextFor } from '../src/host/index.js'
import { buildContext } from '../src/host/context.js'
import {
  createStore, activateAudit, ingestEvents, noteSnapshot, usageFor, lifecycleOf,
} from '../src/host/feedback.js'
import { makeWorkspace } from './fixture.mjs'
import { NOISE_RELS } from './eval/fixture.mjs'

/* ── 构造工具 ─────────────────────────────────────────── */

/**
 * 造一条假的 ranked 条目（照抄 `test/context.test.mjs:48-58` 的形状，**只把默认
 * `kind` 换成 `'code'`**）。两个文件共用同一个形状是有意的：分层规则若对代码
 * 另有一套输入约定，那就已经是第二套机制了。
 *
 * @param {string} rel - 相对路径
 * @param {number} raw - BM25 分数（只用于判 Primary 的强度带宽）
 * @param {Array<object>} [terms] - `matchedTerms` 形状
 * @param {object} [extra] - 覆盖 `title` / `summary` / `mtimeMs` / `kind`
 * @returns {object} 假的 ranked 条目
 */
function doc(rel, raw, terms = [], extra = {}) {
  return {
    rel,
    title: extra.title === undefined ? rel : extra.title,
    summary: extra.summary === undefined ? '' : extra.summary,
    mtimeMs: extra.mtimeMs === undefined ? 0 : extra.mtimeMs,
    kind: extra.kind === undefined ? 'code' : extra.kind,
    raw,
    matchedTerms: terms,
  }
}

/** 某词的字段位图。 */
const hit = (term, fields) => ({ term, fields })

/** 取某一层的 rel。 */
const rels = (items) => items.map((item) => item.rel)

const ROOT = '/w'

/**
 * 造一对 `tool/call` + `tool/result` 事件 —— 这是 `read` 工具**被真正执行成功**的形状。
 * 照抄 `test/document-lifecycle.test.mjs` 的写法，不改协议。
 *
 * @param {string} rel - 被读的文件
 * @param {number} seq - 起始序号
 * @returns {object[]} 两个事件
 */
function readAt(rel, seq) {
  const callId = `c${seq}`
  return [
    {
      type: 'tool/call',
      seq,
      time: seq,
      data: { turn: 1, step: 1, callId, name: 'read', arguments: JSON.stringify({ file_path: rel }) },
    },
    {
      type: 'tool/result',
      seq: seq + 1,
      time: seq + 1,
      data: { message: { role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, isError: false } },
    },
  ]
}

/**
 * 一张快照用的最小 Context Pack 形状（`primary` / `supporting` / `related` + totals）。
 *
 * @param {object} [spec] - 三层的 rel 列表
 * @returns {object} 包
 */
function packOf(spec = {}) {
  const wrap = (list) => (list || []).map((rel) => ({ rel, title: rel, summary: '', kind: 'code' }))
  return {
    mode: 'relevance',
    topic: 'knit',
    task: '',
    primary: wrap(spec.primary),
    supporting: wrap(spec.supporting),
    related: wrap(spec.related),
    totals: { primary: 0, supporting: 0, related: 0, matched: 0, total: 10 },
  }
}

/**
 * 让一个会话进入「已激活审计 + 有一张快照」的状态。
 *
 * @param {object} [spec] - 快照内容
 * @returns {object} store
 */
function storeWithSnapshot(spec = { primary: ['src/plugin-loader.js'] }) {
  const store = createStore()
  activateAudit(store, 's1')
  noteSnapshot(store, 's1', packOf(spec), { seq: 5, at: 100 })
  return store
}

/* ── 1 · Retrieval：代码参与当前任务检索 ───────────────── */

test('code: 文件名 > 路径 > 正文 —— 三档权重在真实扫描上可观测', async () => {
  // 三个文件，同一个查询词，唯一的区别是它出现在哪一段：
  //   plugin-loader.js   → 文件名    （title  ×4）
  //   plugin/config.js   → 目录      （summary ×2）
  //   lib/x.js           → 只有正文  （body   ×1）
  const root = makeWorkspace([
    ['src/plugin-loader.js', 'export function load () {}\n'],
    ['src/plugin/config.js', 'export const config = {}\n'],
    ['lib/x.js', '// plugin\n'],
  ])
  const r = await scan(root, 60, { sort: 'relevance', kind: 'context', query: 'plugin' })

  assert.equal(r.mode, 'relevance', '有查询词就必须真的排了序')
  const order = r.docs.map((d) => d.rel)
  assert.equal(order[0], 'src/plugin-loader.js', '文件名命中必须压过路径命中')
  assert.ok(
    order.indexOf('src/plugin-loader.js') < order.indexOf('src/plugin/config.js'),
    '路径命中必须压过正文命中',
  )
  assert.ok(
    order.indexOf('src/plugin/config.js') < order.indexOf('lib/x.js'),
    '路径命中必须压过正文命中',
  )
})

test('code: 代码条目带的是宿主的代码字段口径（名字带扩展名、摘要是目录）', async () => {
  const root = makeWorkspace([['src/plugin-loader.js', 'export function load () {}\n']])
  const r = await scan(root, 60, { sort: 'relevance', kind: 'context', query: 'plugin-loader' })
  const top = r.docs[0]

  assert.equal(top.kind, 'code')
  assert.equal(top.rel, 'src/plugin-loader.js')
  // ⚠️ 带扩展名。去掉它，`plugin-loader.js` 与 `plugin.json` 就只剩同一个 stem 了。
  assert.equal(top.title, 'plugin-loader.js')
  // ⚠️ 目录保留结尾斜杠，与列表第二行的观感一致。
  assert.equal(top.summary, 'src/')
})

test('code: 三种池子互不串门 —— doc 默认不含代码，code 只含代码，context 是两者之和', async () => {
  const root = makeWorkspace([['src/plugin-loader.js', 'export function load () {}\n']])

  const docPool = await scan(root, 60, { kind: 'doc' })
  assert.ok(
    docPool.docs.every((d) => d.kind !== 'code'),
    '默认档（旧客户端 / 悬停浮层走这条）不许混进代码 —— v0.18 行为逐字不变',
  )

  const codePool = await scan(root, 60, { kind: 'code' })
  assert.equal(codePool.kind, 'code')
  assert.ok(codePool.docs.every((d) => d.kind === 'code'), 'code 档只含代码')
  assert.ok(
    codePool.docs.some((d) => d.rel === 'src/plugin-loader.js'),
    '扫描出来的代码必须在 code 档里',
  )

  const ctxPool = await scan(root, 60, { kind: 'context' })
  const kinds = new Set(ctxPool.docs.map((d) => d.kind))
  assert.ok(kinds.has('code'), 'context 池必须有代码')
  assert.ok(kinds.has('md'), 'context 池必须有文档 —— 否则不成其为「混合竞争」')
  // 媒体永远不进上下文池（v0.18 的行为，不动）。
  assert.ok(!kinds.has('image') && !kinds.has('video'), '媒体不进 Context')
})

test('code: 代码与文档混合竞争时，赢的是命中更好的那个，不是「代码」', async () => {
  const root = makeWorkspace([
    ['src/util.js', '// plugin\n'],
    ['docs/plugin.md', '# plugin\n\n说明。\n'],
  ])
  const r = await scan(root, 60, { sort: 'relevance', kind: 'context', query: 'plugin' })

  // 文档的**标题**命中了话题词，代码只在正文提了一句 —— 于是文档赢。
  // 这一条是「不能因为是 Code 就天然优先」的正向证据：判据只有命中位置，
  // 没有任何一处按 kind 加分。
  assert.equal(r.docs[0].rel, 'docs/plugin.md')
  assert.ok(
    r.docs.some((d) => d.kind === 'code'),
    '代码仍然要在结果里 —— 混合池不是「谁赢谁独占」',
  )
})

/* ── 2 · Context Pack：代码能进三层 ───────────────────── */

test('context: 代码可以成为 Primary，理由码走 filenameMatch', () => {
  const pack = buildContext({
    ranked: [doc('src/plugin-loader.js', 30, [hit('plugin-loader', { title: true, body: true, bodyTf: 2 })])],
    topic: 'plugin-loader',
  })

  assert.deepEqual(rels(pack.primary), ['src/plugin-loader.js'])
  assert.equal(pack.primary[0].reason.code, 'filenameMatch', '代码的 title 位是文件名，理由码必须说实话')
  assert.equal(pack.primary[0].kind, 'code')
  assert.equal(pack.primary[0].source, 'impl')
})

test('context: 代码的 direct 升级仍然要求「命中词不止一个」', () => {
  const pack = buildContext({
    ranked: [doc('src/plugin-loader.js', 30, [
      hit('plugin', { title: true, body: true, bodyTf: 2 }),
      hit('loader', { title: true }),
    ])],
  })
  assert.equal(pack.primary[0].reason.code, 'direct')
})

test('context: 代码只命中目录时理由码走 pathMatch', () => {
  const pack = buildContext({
    ranked: [
      doc('src/plugin/loader.js', 30, [hit('plugin', { summary: true, body: true, bodyTf: 1 })], { summary: 'src/plugin/' }),
      doc('docs/other.md', 10, [hit('plugin', { body: true, bodyTf: 1 })], { kind: 'md' }),
    ],
    topic: 'plugin',
  })
  assert.equal(pack.primary[0].rel, 'src/plugin/loader.js')
  assert.equal(pack.primary[0].reason.code, 'pathMatch')
})

test('context: 代码可以成为 Supporting（正文真命中、但没有落脚点）', () => {
  const pack = buildContext({
    ranked: [
      doc('src/plugin-loader.js', 30, [hit('plugin', { title: true })]),
      doc('docs/plugin-notes.md', 20, [hit('plugin', { body: true, bodyTf: 3 })], { kind: 'md' }),
      doc('src/plugin/registry.js', 18, [hit('plugin', { body: true, bodyTf: 3 })]),
    ],
    topic: 'plugin',
  })

  assert.deepEqual(rels(pack.primary), ['src/plugin-loader.js'])
  const supporting = rels(pack.supporting)
  assert.ok(supporting.includes('src/plugin/registry.js'), '正文真讲这件事的代码应当进 Supporting')
  assert.ok(supporting.includes('docs/plugin-notes.md'), '同一层的文档也应当进 —— 两层共用一个池子')
})

test('context: 代码可以成为 Related（弱命中）', () => {
  const pack = buildContext({
    ranked: [
      doc('src/plugin-loader.js', 30, [hit('plugin', { title: true })]),
      doc('src/legacy/old-plugin.js', 8, [hit('plugin', { body: true, bodyTf: 1 })]),
    ],
    topic: 'plugin',
  })
  assert.ok(rels(pack.related).includes('src/legacy/old-plugin.js'))
})

test('context: 混合包的条目投影与 v0.18 逐字相同（代码不引入新字段）', () => {
  const pack = buildContext({
    ranked: [
      doc('src/plugin-loader.js', 30, [hit('plugin', { title: true })]),
      doc('docs/plugin.md', 12, [hit('plugin', { body: true, bodyTf: 2 })], { kind: 'md' }),
    ],
    topic: 'plugin',
  })

  const item = pack.primary[0]
  // v0.21 给条目加了 `provenance`（来源三值）—— 这是**唯一**新增的固定字段，
  // 且它是给「为什么在这里」用的，不是给排序用的（关系/来源都不参与分层）。
  assert.deepEqual(
    Object.keys(item).sort(),
    ['kind', 'mtimeMs', 'provenance', 'reason', 'rel', 'source', 'summary', 'title'],
    'Code Context 不许往包条目里塞新字段 —— 有的话 UI 与工具就得同步改两遍',
  )
  // 内部字段一个都不许漏出去。
  const json = JSON.stringify(pack)
  for (const leaked of ['raw', 'strength', 'rank', '"score"', 'haystack', 'termFields', 'bodyTf']) {
    assert.ok(!json.includes(leaked), `内部字段 ${leaked} 漏进了包`)
  }
})

test('context: 端到端 —— 真实工作区扫出来的代码能进 pack 的 Primary', async () => {
  const root = makeWorkspace([
    ['src/plugin-loader.js', 'export function loadPlugin (dir) { /* metadata */ }\n'],
    ['docs/notes.md', '# 笔记\n\n无关内容。\n'],
  ])
  const r = await scan(root, 60, { sort: 'relevance', kind: 'context', query: 'plugin loader metadata' })
  const pack = await buildContextFor(root, {
    ranked: r.ranked, topic: r.topic, task: r.task, total: r.total,
  })

  assert.equal(pack.mode, 'relevance')
  assert.deepEqual(rels(pack.primary), ['src/plugin-loader.js'])
  assert.equal(pack.primary[0].kind, 'code')
  assert.equal(pack.primary[0].source, 'impl')
})

test('context: 引用图里代码只能是「被指向」的一方，不能当源 —— 注释里写个路径不是入围依据', async () => {
  // v0.19 一条**刻意的收窄**：引用图的**源**永远是 Markdown。
  //
  // 理由：代码进 Supporting 的正路是「任务检索命中了它」。若一个源码文件只要注释里
  // 提一句 `docs/X.md` 就能把 X 拉进包、或靠这条边自己被拉进包，那就是一条不打分的后门。
  // 反过来，**文档指向代码**是真实的设计证据（设计文档点名某个实现文件），
  // 与文档指向文档走的是同一条规则 —— 那不是特例，所以保留。
  const root = makeWorkspace([
    // 零命中，唯一的「证据」是注释里写了一个 Markdown 路径。
    ['src/util.js', '// see docs/real.md for details\n'],
    ['docs/real.md', '# design\n\n真正的设计说明。\n'],
  ])
  const r = await scan(root, 60, { sort: 'relevance', kind: 'context', query: 'design' })
  const pack = await buildContextFor(root, {
    ranked: r.ranked, topic: r.topic, task: r.task, total: r.total, withLinks: true,
  })

  assert.deepEqual(rels(pack.primary), ['docs/real.md'])
  const everything = [...rels(pack.primary), ...rels(pack.supporting), ...rels(pack.related)]
  assert.ok(
    !everything.includes('src/util.js'),
    '零命中、只靠注释里写了个路径的代码不许进包',
  )
})

/* ── 3 · Read Evidence：代码读取的归因在读时冻结 ──────── */

test('evidence: 代码被读取后留下证据，且认得出它当时在 Primary', () => {
  const store = storeWithSnapshot({ primary: ['src/plugin-loader.js'] })
  ingestEvents(store, 's1', readAt('src/plugin-loader.js', 10), { root: ROOT, stat: () => 1000 })

  const usage = usageFor(store, 's1')
  assert.equal(usage.reads.length, 1)
  const read = usage.reads[0]
  assert.equal(read.rel, 'src/plugin-loader.js')
  // `tier` / `rank` / `inside` 都是**首次读时**的归因，不是「它现在在哪一层」。
  assert.equal(read.tier, 'primary')
  assert.equal(read.firstRead.tier, 'primary')
  assert.equal(read.firstRead.inside, true)
  assert.equal(read.outside, false)
  assert.equal(usage.stats.outside, 0)
})

test('evidence: 包外的代码读取被认成 Outside Context（不是只认 Markdown）', () => {
  const store = storeWithSnapshot({ primary: ['src/plugin-loader.js'] })
  ingestEvents(store, 's1', readAt('src/plugin-loader.js', 10), { root: ROOT, stat: () => 1000 })
  // Agent 自己顺手打开了另一个源码文件 —— 它不在包里。
  ingestEvents(store, 's1', readAt('src/secret/hidden.ts', 20), { root: ROOT, stat: () => 1000 })

  const usage = usageFor(store, 's1')
  assert.equal(usage.stats.outside, 1)
  assert.deepEqual(usage.outsideDocs.map((d) => d.rel), ['src/secret/hidden.ts'])
})

test('evidence: 历史归因在后续快照变化后**不许重算**（读时冻结）', () => {
  const store = storeWithSnapshot({ primary: ['src/plugin-loader.js'] })
  ingestEvents(store, 's1', readAt('src/plugin-loader.js', 10), { root: ROOT, stat: () => 1000 })

  // 再交一张完全不同的包：这个代码文件**离开了**上下文。
  noteSnapshot(
    store, 's1',
    packOf({ primary: ['src/context/context-manager.ts'] }),
    { seq: 30, at: 200 },
  )

  const usage = usageFor(store, 's1')
  const read = usage.reads.find((r) => r.rel === 'src/plugin-loader.js')
  assert.ok(read, '证据不许因为文件离开上下文而消失')
  assert.equal(read.firstRead.tier, 'primary', '读时的层必须是 primary —— 冻结在读的那一刻')
  assert.equal(
    read.firstRead.inside, true,
    '「读的时候在不在包里」也要冻结。用今天的包去重算昨天的事实就是编造',
  )
  // 而**当前**包外的那一份，当然要按今天的包说 —— 这两个口径不是一回事。
  assert.deepEqual(usage.outsideDocs.map((d) => d.rel), ['src/plugin-loader.js'])
})

test('evidence: 代码的重复读取累加次数，不新增条目', () => {
  const store = storeWithSnapshot({ primary: ['src/plugin-loader.js'] })
  ingestEvents(store, 's1', readAt('src/plugin-loader.js', 10), { root: ROOT, stat: () => 1000 })
  ingestEvents(store, 's1', readAt('src/plugin-loader.js', 40), { root: ROOT, stat: () => 1000 })

  const usage = usageFor(store, 's1')
  assert.equal(usage.reads.length, 1)
  assert.equal(usage.reads[0].count, 2)
})

/* ── 4 · Lifecycle：代码走同一个四态 ──────────────────── */

test('lifecycle: 代码的四态与文档完全同一套（纯函数层）', () => {
  assert.equal(lifecycleOf(null).status, 'unread')
  assert.equal(
    lifecycleOf({ count: 1, lastReadMtimeMs: 1000, rereadAfterChange: false }, 1000).status,
    'read',
  )
  assert.equal(
    lifecycleOf({ count: 1, lastReadMtimeMs: 1000, rereadAfterChange: false }, 2000).status,
    'updated_after_read',
  )
  assert.equal(
    lifecycleOf({ count: 2, lastReadMtimeMs: null, rereadAfterChange: true }, 500).status,
    'reread_after_update',
  )
})

test('lifecycle: 读过的代码被改之后，端到端报 updated_after_read', () => {
  const store = storeWithSnapshot({ primary: ['src/plugin-loader.js'] })
  ingestEvents(store, 's1', readAt('src/plugin-loader.js', 10), { root: ROOT, stat: () => 1000 })

  const before = usageFor(store, 's1', { mtimes: { 'src/plugin-loader.js': 1000 } })
  assert.equal(before.lifecycle['src/plugin-loader.js'].status, 'read')

  // 文件被改（mtime 前进）—— 判据是**读时冻结的 mtime** 与今天的 mtime 之差。
  const after = usageFor(store, 's1', { mtimes: { 'src/plugin-loader.js': 2000 } })
  assert.equal(after.lifecycle['src/plugin-loader.js'].status, 'updated_after_read')
  assert.equal(after.lifecycle['src/plugin-loader.js'].changedAfterLastRead, true)

  // 改完又被读一次 → reread_after_update。**没有第二套代码专用状态机**。
  ingestEvents(store, 's1', readAt('src/plugin-loader.js', 60), {
    root: ROOT,
    stat: () => 2000,
  })
  const reread = usageFor(store, 's1', { mtimes: { 'src/plugin-loader.js': 2000 } })
  assert.equal(reread.lifecycle['src/plugin-loader.js'].status, 'reread_after_update')
})

/* ── 5 · Context Epoch / Delta：代码的进 / 出 / 换层 ──── */

test('epoch: 代码进入上下文产生新 epoch 与 appeared 增量', () => {
  const store = createStore()
  activateAudit(store, 's1')

  const first = noteSnapshot(store, 's1', packOf({ primary: ['src/a.js'] }), { seq: 5, at: 100 })
  assert.equal(first.delta, null, '第一张快照没有「变化」可言')

  const second = noteSnapshot(
    store, 's1',
    packOf({ primary: ['src/b.js'], supporting: ['src/a.js'] }),
    { seq: 9, at: 200 },
  )
  assert.deepEqual(second.delta.appeared, [{ rel: 'src/b.js', tier: 'primary', rank: 1 }])
  // a.js 没有消失：它只是换了层 —— 「离开上下文」与「换层」是两件事。
  assert.deepEqual(second.delta.disappeared, [])
  // `moved` 的形状是 `{rel, from:{tier,rank}, to:{tier,rank}}` —— **不只跨层**，
  // 同一层里换名次也算移动（这里 a.js 是从 primary 换到 supporting）。
  assert.deepEqual(second.delta.moved, [
    { rel: 'src/a.js', from: { tier: 'primary', rank: 1 }, to: { tier: 'supporting', rank: 1 } },
  ])
  assert.equal(second.delta.fromEpoch, 1)
  assert.equal(second.delta.toEpoch, 2)
})

test('epoch: 包没变就不产生新 epoch（签名相同）', () => {
  const store = createStore()
  activateAudit(store, 's1')
  noteSnapshot(store, 's1', packOf({ primary: ['src/a.js'] }), { seq: 5, at: 100 })

  const again = noteSnapshot(store, 's1', packOf({ primary: ['src/a.js'] }), { seq: 12, at: 300 })
  assert.equal(again, null, '同一份包不该刷出一个空 epoch')

  const usage = usageFor(store, 's1')
  assert.equal(usage.stats.churn.deltas, 0)
  assert.equal(usage.epochs.length, 1)
})

test('epoch: 代码离开上下文后仍出现在 usage 的历史里，且不新增第二套 Delta', () => {
  const store = createStore()
  activateAudit(store, 's1')
  noteSnapshot(store, 's1', packOf({ primary: ['src/a.js', 'src/b.js'] }), { seq: 5, at: 100 })
  const drop = noteSnapshot(store, 's1', packOf({ primary: ['src/b.js'] }), { seq: 9, at: 200 })

  // rank 是**层内** 1-based 序号：a.js 在 `primary:['src/a.js','src/b.js']` 里排第一。
  assert.deepEqual(drop.delta.disappeared, [{ rel: 'src/a.js', tier: 'primary', rank: 1 }])
  const usage = usageFor(store, 's1')
  // UI 侧只说「Context Changes」—— 这里确认数据侧也只有一套 delta。
  assert.equal(usage.delta, usage.latestDelta)
  assert.equal(usage.delta.toEpoch, 2)
})

/* ── 6 · Negative：生成 / 噪声产物一条都不许污染检索 ──── */

test('negative: 七条生成/噪声路径在真实扫描里一条都不进候选', async () => {
  const extra = NOISE_RELS.map((rel) => [rel, rel.endsWith('.map') || rel.endsWith('.json')
    ? '{"version":3}\n'
    : '// plugin loader metadata\n'])
  // 一个**真的相关**的文件放在噪声里 —— 否则「top-1 不是噪声」可以靠什么都没有来通过。
  extra.push(['src/plugin-loader.js', 'export function loadPlugin (dir) { /* metadata */ }\n'])
  const root = makeWorkspace(extra)

  const { docs, code, stats } = await collectDocs(root)
  const admitted = [...docs, ...code].map((d) => d.rel)

  for (const noise of NOISE_RELS) {
    assert.ok(
      !admitted.includes(noise),
      `${noise} 不该出现在候选里 —— Context eligibility 与 file system visibility 是两件事`,
    )
  }
  assert.ok(admitted.includes('src/plugin-loader.js'), '真正相关的代码必须还在')

  // node_modules / dist / coverage 三条由既有的 SKIP_DIRS 挡（目录级），
  // 另外四条由新增的 code-specific noise 规则挡（文件名级）。
  // 无论哪一层接手，都必须被**数到** —— 沉默的排除是不可核验的。
  assert.equal(stats.generated, 4, 'app.min.js / bundle.generated.js / app.js.map / package-lock.json')
})

test('negative: 噪声不进检索结果，top-1 仍是真正相关的那一个', async () => {
  const extra = NOISE_RELS.map((rel) => [rel, '// plugin loader metadata plugin loader\n'])
  extra.push(['src/plugin-loader.js', 'export function loadPlugin (dir) { /* metadata */ }\n'])
  const root = makeWorkspace(extra)

  const r = await scan(root, 60, { sort: 'relevance', kind: 'context', query: 'plugin loader metadata' })
  assert.equal(r.docs[0].rel, 'src/plugin-loader.js')
  for (const noise of NOISE_RELS) {
    assert.ok(!r.docs.some((d) => d.rel === noise), `${noise} 漏进了检索结果`)
  }
})

test('negative: 被排除的生成产物仍然**可以预览**（.map 是文件系统的一部分）', async () => {
  const root = makeWorkspace([
    ['app.js', 'export function load () {}\n'],
    ['app.js.map', '{"version":3,"sources":["app.js"]}\n'],
  ])

  const r = await readDocument(root, 'app.js.map')
  assert.equal(r.ok, true, '用户主动打开时不许拦 —— 被排除的是「进入检索」而不是「能不能看」')
  assert.equal(r.kind, 'generated')
  // `readDocument` 原样返回文件内容，不做任何重排 —— 所以断言得按原样来。
  assert.match(r.text, /"version":3/)

  // 而它在检索侧就是不存在。
  const ctx = await scan(root, 60, { kind: 'code' })
  assert.ok(ctx.docs.some((d) => d.rel === 'app.js'), '真源码在')
  assert.ok(!ctx.docs.some((d) => d.rel.endsWith('.map')), 'source map 在检索侧不存在')
})

test('negative: minified 后缀不会被「也带 .js」蒙混过关', async () => {
  const root = makeWorkspace([
    ['app.min.js', 'x\n'],
    ['app.js', 'x\n'],
    ['bundle.generated.js', 'x\n'],
    ['data.generated.js', 'x\n'],
  ])
  const { code, stats } = await collectDocs(root)

  // 夹具默认还造了一个 `package.json`（v0.19 起它是合法代码候选），所以按成员断言，
  // 而不是按整份清单断言 —— 否则这条测试会因为夹具变化而假红。
  assert.ok(code.some((c) => c.rel === 'app.js'), '真正的源码必须留下')
  for (const noise of ['app.min.js', 'bundle.generated.js', 'data.generated.js']) {
    assert.ok(!code.some((c) => c.rel === noise), `${noise} 不许进候选`)
  }
  // ⚠️ 扩展名判定顺序是契约：这四个的 ext 都是 `.js`。
  // 先看 ext 再看噪声规则的话，三个生成产物会被当成合法代码。
  assert.equal(stats.generated, 3, '三个生成产物必须被数到，而不是被静默跳过')
})
