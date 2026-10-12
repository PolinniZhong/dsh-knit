/**
 * Knit · **可选混合检索**（v0.23 Phase A + B）的端到端测试。
 *
 * Phase A 的立论是「加了这条通道，默认路径一分钱不花」；**Phase B** 的立论是
 * 「语义条目只能**补进「相关」层**，而且只能**追加在最后**」—— 两层立论都要能被证伪。
 *
 * 判据对照（方案 §9.2）：
 *   · 1   —— 词法模式下**一次 provider 调用都不发**（哪怕配置好了）；
 *   · 2   —— `lexical` 与 v0.22 一致；`hybrid` = 既有条目原样 + 语义条目追加；
 *   · 2c  —— `capRelated` 满时**先挤掉语义条目**，既有条目的成员与顺序不动；
 *   · 3   —— 被排除的文件**不可能**经语义路径回来；
 *   · 3b  —— 零命中的语义条目**进得了包**（拿掉标记必然消失 = 证伪用例）；
 *   · 5   —— 五种失败各自收敛成一个 `reason`，结果与词法一致；
 *   · 6   —— 理由/来源只写可复核的事实：语义条目 `terms` 为空、来源 `semantic`；
 *             同时有词法证据的**按词法**（语义不许盖住它）；
 *   · 7   —— 公开文档的字段集合不受影响（内部标记不许漏出去）。
 *
 * ⚠️ 这里证明的是**机制**，不是「语义检索有用」—— 价值证据要等 Phase C 的消融（真 provider）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { makeWorkspace } from './fixture.mjs'
import { scan, setSemanticEngine } from '../src/host/index.js'
import { buildContext } from '../src/host/context.js'
import { createSemanticEngine, SEM_MIN_SIM } from '../src/host/semantic.js'

const CONFIG = { kind: 'ollama', base: 'http://127.0.0.1:11434', model: 'nomic-embed-text' }
/** 一个能被语义命中的工作区：`secret.md` 的摘要与查询最像，用来验判据 3。 */
const WORKSPACE = [
  ['docs/alpha.md', '# 甲文档\n\n讲的是排序与相关性。\n'],
  ['docs/beta.md', '# 乙文档\n\n讲的是别的主题。\n'],
  ['docs/secret.md', '# 丙文档\n\n语义检索 语义候选 语义补充\n'],
]

/** 假 provider：任何输入都给 `[1,0]`（于是与 query 的余弦 = 1，恒过阈值）。 */
function fakeProvider(options = {}) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET' })
    const path = String(url).replace(CONFIG.base, '')
    if (path === '/api/tags') {
      if (options.probeStatus) return { status: options.probeStatus, json: async () => ({}) }
      return { status: 200, json: async () => ({ models: [] }) }
    }
    if (options.embedGarbage) return { status: 200, json: async () => ({ nope: true }) }
    const input = JSON.parse(init.body).input
    return { status: 200, json: async () => ({ embeddings: input.map(() => [1, 0]) }) }
  }
  impl.calls = calls
  return impl
}

/** 装一个引擎（可带缓存好的 provider 配置），返回 `{engine, calls}`。 */
async function withEngine(options = {}) {
  const fetchImpl = fakeProvider(options)
  const engine = createSemanticEngine({ store: null, fetchImpl })
  if (options.configure !== false) await engine.configure(CONFIG)
  setSemanticEngine(engine)
  return { engine, calls: fetchImpl.calls }
}

const baseOptions = { sort: 'relevance', kind: 'context', query: '语义检索 语义候选' }

/** 把一次扫描装配成 Context Pack（生产同一条路径：`buildContext`）。 */
const packOf = (payload) => buildContext({
  ranked: payload.ranked,
  topic: payload.topic,
  task: payload.task,
  total: payload.total,
  graph: null,
})

/** 造一条 ranked 记录（形状与 `rankByRelevance()` 的产物一致）。 */
const record = (rel, raw, terms = [], extra = {}) => ({
  rel,
  title: extra.title === undefined ? rel : extra.title,
  summary: extra.summary === undefined ? '' : extra.summary,
  mtimeMs: 0,
  kind: 'md',
  raw,
  matchedTerms: terms,
  ...(extra.semantic === true ? { semantic: true } : {}),
})

const bodyHit = (term) => ({ term, fields: { body: true, bodyTf: 1 } })
const titleHit = (term) => ({ term, fields: { title: true } })

test('判据 1：词法模式下**一次 provider 调用都不发**（哪怕 provider 配置好了）', async () => {
  const root = makeWorkspace(WORKSPACE)
  const { calls } = await withEngine()
  const payload = await scan(root, 20, { ...baseOptions, retrieval: 'lexical' })
  assert.equal(calls.length, 0, '默认路径不许有任何 provider 调用（连探测都不许）')
  assert.equal(payload.semantic.mode, 'lexical')
  assert.equal(payload.semantic.available, null, '本轮没探测过 ⇒ 不许谎报可用')
  assert.equal(payload.semantic.configured, true)
  assert.equal(payload.semantic.candidates, 0)
  assert.equal(payload.ranked.filter((doc) => doc.semantic === true).length, 0, '词法路径不许标任何语义条目')
  setSemanticEngine(null)
})

test('判据 2：`lexical` 与 v0.22 一致；`hybrid` = 既有条目原样 + 语义条目**追加**在「相关」层', async () => {
  const root = makeWorkspace(WORKSPACE)
  await withEngine()

  const lexical = await scan(root, 20, { ...baseOptions, retrieval: 'lexical' })
  const hybrid = await scan(root, 20, { ...baseOptions, retrieval: 'hybrid' })

  assert.equal(hybrid.semantic.mode, 'hybrid')
  assert.equal(hybrid.semantic.available, true)
  assert.ok(hybrid.semantic.candidates > 0, '假 provider 恒回 [1,0]，必须有候选')

  const lexPack = packOf(lexical)
  const hybPack = packOf(hybrid)
  const lexRels = [...lexPack.primary, ...lexPack.supporting, ...lexPack.related].map((i) => i.rel)
  const hybRels = [...hybPack.primary, ...hybPack.supporting, ...hybPack.related].map((i) => i.rel)

  // ① 既有条目的成员与顺序一个不差，而且都在**前面**（追加语义不许插队）
  assert.deepEqual(hybRels.slice(0, lexRels.length), lexRels)
  assert.deepEqual(hybPack.primary.map((i) => i.rel), lexPack.primary.map((i) => i.rel))
  assert.deepEqual(hybPack.supporting.map((i) => i.rel), lexPack.supporting.map((i) => i.rel))

  // ② 追加的只能是语义条目，而且只能落在「相关」层
  const appended = hybRels.slice(lexRels.length)
  assert.ok(appended.length > 0, '这一轮必须真的补进了语义条目，否则上面两条断言是空转的')
  for (const rel of appended) {
    const item = hybPack.related.find((row) => row.rel === rel)
    assert.ok(item, `${rel} 只许出现在「相关」层`)
    assert.equal(item.provenance, 'semantic')
  }
  // ③ 词法那一份里一个语义条目都没有（同一份语料、只差 `retrieval`）
  assert.equal(lexPack.related.filter((i) => i.provenance === 'semantic').length, 0)
  setSemanticEngine(null)
})

test('判据 3：被排除的文件**不可能**经语义路径回来（哪怕它是语义上最像的那篇）', async () => {
  const root = makeWorkspace(WORKSPACE)
  await withEngine()
  const excluded = new Set(['docs/secret.md'])
  const payload = await scan(root, 20, { ...baseOptions, excluded, retrieval: 'hybrid' })
  const rels = payload.stats.semantic.rels
  assert.ok(rels.length > 0, '语义候选本身要真的算出来了，这条断言才有意义')
  assert.ok(!rels.includes('docs/secret.md'), '被排除的文件不许出现在语义候选里')
  const pack = packOf(payload)
  const all = [...pack.primary, ...pack.supporting, ...pack.related].map((i) => i.rel)
  assert.ok(!all.includes('docs/secret.md'), '也不许出现在包里')
  setSemanticEngine(null)
})

test('判据 3b：零命中的语义条目**进得了包**，但只进「相关」层；拿掉标记它必然消失（证伪）', () => {
  const main = record('main.md', 9, [titleHit('语义检索')], { title: '主文档', summary: '语义检索' })
  const sem = record('sem.md', 0, [], { title: '语义文档', summary: '语义', semantic: true })

  const pack = buildContext({ ranked: [main, sem], topic: '语义检索', total: 2, graph: null })
  assert.deepEqual(pack.primary.map((i) => i.rel), ['main.md'])
  assert.deepEqual(pack.supporting.map((i) => i.rel), [], '语义条目不许进「辅助」')
  assert.deepEqual(pack.related.map((i) => i.rel), ['sem.md'], '零命中的语义条目只许落在「相关」')
  assert.equal(pack.related[0].provenance, 'semantic')
  assert.equal(pack.related[0].reason.code, 'semantic')

  // 证伪：把准入门槛上那个标记拿掉 ⇒ 它必然消失（`raw === 0` 的文档本来进不了任何一层）
  const without = buildContext({
    ranked: [main, record('sem.md', 0, [], { title: '语义文档', summary: '语义' })],
    topic: '语义检索',
    total: 2,
    graph: null,
  })
  assert.deepEqual(without.related.map((i) => i.rel), [], '拿掉标记后它必须消失 —— 这条就是守卫的证伪')
  assert.equal(without.totals.matched, 1, '`matched` 仍是**词法**命中数，语义不许把它灌大')
})

test('判据 6：语义条目的理由是「语义」且**不冒充关键词命中**；同时有词法证据的按词法分层', () => {
  const sem = record('sem.md', 0, [], { title: '语义文档', summary: '语义', semantic: true })
  const both = record('both.md', 7, [titleHit('语义检索')], { title: '两者都有', summary: '语义检索', semantic: true })
  const pack = buildContext({ ranked: [both, sem], topic: '语义检索', total: 2, graph: null })

  // 语义-only：理由码是 `semantic`，`terms` 必须为空（不许伪装成「正文命中」）
  const semItem = [...pack.related, ...pack.supporting, ...pack.primary].find((i) => i.rel === 'sem.md')
  assert.equal(semItem.reason.code, 'semantic')
  assert.deepEqual(semItem.reason.terms, [])
  assert.equal(semItem.provenance, 'semantic')

  // 词法 + 语义同时命中：**按词法分层、来源如实写词法**（语义不许盖住它）
  const bothItem = pack.primary.find((i) => i.rel === 'both.md')
  assert.ok(bothItem, '有落脚点的条目仍然按词法进「主要」')
  assert.equal(bothItem.provenance, 'retrieval')
  assert.notEqual(bothItem.reason.code, 'semantic')
})

test('判据 2c：`capRelated` 满的时候，被挤掉的是**语义**条目，不是既有条目', () => {
  const lexicalThree = [
    record('lex1.md', 3, [bodyHit('tsk')]),
    record('lex2.md', 2, [bodyHit('tsk')]),
    record('lex3.md', 1, [bodyHit('tsk')]),
  ]
  const semanticTwo = [
    record('sem1.md', 0, [], { semantic: true }),
    record('sem2.md', 0, [], { semantic: true }),
  ]
  const tight = buildContext({ ranked: [...lexicalThree, ...semanticTwo], topic: 'tsk', total: 5, graph: null, maxRelated: 3 })
  assert.deepEqual(tight.related.map((i) => i.rel), ['lex1.md', 'lex2.md', 'lex3.md'], '既有条目先占坑')
  assert.equal(tight.related.filter((i) => i.provenance === 'semantic').length, 0, '名额不够时先牺牲语义')

  const roomy = buildContext({ ranked: [...lexicalThree, ...semanticTwo], topic: 'tsk', total: 5, graph: null, maxRelated: 5 })
  const rels = roomy.related.map((i) => i.rel)
  assert.deepEqual(rels.slice(0, 3), ['lex1.md', 'lex2.md', 'lex3.md'], '既有条目的顺序仍然不动')
  assert.deepEqual(rels.slice(3).sort(), ['sem1.md', 'sem2.md'], '剩下的名额才轮到语义，且追加在最后')
})

test('判据 5：没有配置 ⇒ no-provider（结果与词法一致，且不发任何请求）', async () => {
  const root = makeWorkspace(WORKSPACE)
  const { calls } = await withEngine({ configure: false })
  const hybrid = await scan(root, 20, { ...baseOptions, retrieval: 'hybrid' })
  const lexical = await scan(root, 20, { ...baseOptions, retrieval: 'lexical' })
  assert.equal(hybrid.semantic.reason, 'no-provider')
  assert.equal(hybrid.semantic.available, false)
  assert.deepEqual(hybrid.docs, lexical.docs)
  assert.equal(calls.length, 0, '没有配置 ⇒ 连探测都不发')
  setSemanticEngine(null)
})

test('判据 5：探测失败 / 形状不对 / 没有查询文本，各有各的 reason，且结果与词法一致', async () => {
  const root = makeWorkspace(WORKSPACE)

  await withEngine({ probeStatus: 503 })
  const probeFailed = await scan(root, 20, { ...baseOptions, retrieval: 'hybrid' })
  assert.equal(probeFailed.semantic.reason, 'probe-failed')

  await withEngine({ embedGarbage: true })
  const badShape = await scan(root, 20, { ...baseOptions, retrieval: 'hybrid' })
  assert.equal(badShape.semantic.reason, 'bad-response')

  // ⚠️ `no-query` 现在只在**相关序**里才可能出现（时间序整层不适用，见下面那条专门用例），
  // 而且相关序的 `scan()` 必然有关键词 ⇒ 那条分支由 `semantic.test.mjs` 的引擎单测直接覆盖。
  const lexical = await scan(root, 20, { ...baseOptions, retrieval: 'lexical' })
  assert.deepEqual(probeFailed.docs, lexical.docs)
  assert.deepEqual(badShape.docs, lexical.docs)
  // 回退时**一个语义标记都不许留下**（「与词法一致」是逐字一致，不是「差不多」）
  for (const payload of [probeFailed, badShape]) {
    assert.equal(payload.ranked.filter((doc) => doc.semantic === true).length, 0)
  }
  setSemanticEngine(null)
})

test('判据 7：公开文档的字段集合不受影响（没有偷偷加字段 —— 含 `semantic` 标记）', async () => {
  const root = makeWorkspace(WORKSPACE)
  await withEngine()
  const lexical = await scan(root, 20, { ...baseOptions, retrieval: 'lexical' })
  const hybrid = await scan(root, 20, { ...baseOptions, retrieval: 'hybrid' })
  assert.ok(lexical.docs.length > 0)
  assert.deepEqual(Object.keys(hybrid.docs[0]).sort(), Object.keys(lexical.docs[0]).sort())
  // 内部标记不许漏到浏览器那一份上
  for (const doc of hybrid.docs) assert.equal('semantic' in doc, false, '`semantic` 是宿主内部字段')
  setSemanticEngine(null)
})

test('修订 · 时间序下语义整层不适用：**一次 provider 调用都不发**，如实回 `not-applicable`', async () => {
  const root = makeWorkspace(WORKSPACE)
  const { calls } = await withEngine()
  const payload = await scan(root, 20, { sort: 'time', kind: 'context', query: '语义检索', retrieval: 'hybrid' })
  assert.equal(calls.length, 0, '时间序没有分层结构 ⇒ 语义这一轮连探测都不该发')
  assert.equal(payload.semantic.mode, 'lexical')
  assert.equal(payload.semantic.requested, 'hybrid')
  assert.equal(payload.semantic.reason, 'not-applicable')
  assert.equal(payload.semantic.candidates, 0)
  assert.equal(payload.ranked.length, 0, '时间序本来就没有 ranked')
  setSemanticEngine(null)
})

test('修订 · 嵌入用的查询文本是**用户原话**，不是抽完关键词后的 3-gram 碎片（Phase C 量尺发现）', async () => {
  const root = makeWorkspace(WORKSPACE)
  // 故意选一句会被 `extractKeywords()` 切成碎片的长句：显式 query 路径原来就是这么退化的
  const sentence = '失效策略怎么定才稳妥'
  const seen = []
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/api/tags')) return { status: 200, json: async () => ({}) }
    const input = JSON.parse(init.body).input
    seen.push(input[0])
    return { status: 200, json: async () => ({ embeddings: input.map(() => [1, 0]) }) }
  }
  const engine = createSemanticEngine({ store: null, fetchImpl })
  await engine.configure(CONFIG)
  setSemanticEngine(engine)

  // 走**显式 query** 那条路（`knit_docs(query=…)` / 工具的路径）：`task` 为空
  const payload = await scan(root, 20, { sort: 'relevance', kind: 'context', query: sentence, retrieval: 'hybrid' })
  assert.equal(payload.semantic.mode, 'hybrid')
  assert.ok(seen.length > 0, '要真的发过嵌入请求')
  assert.equal(seen[0], sentence, `嵌入的查询文本必须是原话；实际是 ${JSON.stringify(seen[0])}`)
  // 证伪：抽出来的关键词确实是碎片（说明「原话优先」这条不是空转的守卫）
  assert.ok(!payload.keywords.includes(sentence))
  setSemanticEngine(null)
})

test('语义阈值：低于 `SEM_MIN_SIM` 的候选不计入（阈值是计数口径）', async () => {
  const root = makeWorkspace(WORKSPACE)
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/api/tags')) return { status: 200, json: async () => ({}) }
    const input = JSON.parse(init.body).input
    // query 那一次只有一条输入 ⇒ 给 [1,0]；文档批次（>1 条）全给 [0,1]（与 query 正交 ⇒ 余弦 0）
    const vectors = input.map(() => (input.length === 1 ? [1, 0] : [0, 1]))
    return { status: 200, json: async () => ({ embeddings: vectors }) }
  }
  const engine = createSemanticEngine({ store: null, fetchImpl })
  await engine.configure(CONFIG)
  setSemanticEngine(engine)
  const payload = await scan(root, 20, { ...baseOptions, retrieval: 'hybrid' })
  assert.equal(payload.semantic.available, true)
  assert.equal(payload.semantic.candidates, 0, `正交向量不许达到 ${SEM_MIN_SIM} 阈值`)
  assert.equal(payload.ranked.filter((doc) => doc.semantic === true).length, 0, '没有候选就不许标任何条目')
  setSemanticEngine(null)
})
