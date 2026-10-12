/**
 * Knit v0.23 · **把四路径量尺钉成测试**（`tools/hybrid-retrieval-eval.mjs` 的可证伪版）。
 *
 * 为什么要有这个文件：量尺是「一次性脚本」，跑完就没人记得它当时输出了什么。
 * 这里把**四条判据**变成每次 `npm test` 都会重跑的断言：
 *
 *   ① **回退逐字一致**：`hybrid + provider 探测失败`（H2）的面板载荷与 `lexical`（L）**完全相同**；
 *   ② **只追加、不改既有**：H0 的「主要 / 辅助」两层与 L 一字不差，「相关」层是 L 的前缀 + 追加，
 *      且标注里「词法必漏、语义该救」的样本真的被补回来了；
 *   ③ **有界**：每轮 provider 调用 ≤ 3（探测 1 + 查询 1 + 文档批 1），且冷启一轮最多嵌 `SEM_EMBED_PER_PASS` 篇；
 *   ④ **指标函数算得对**：用几个能手算的例子钉住 `recallAt` / `mrr` / `unrelatedRateAt`。
 *
 * ⚠️ **H1（真 provider）刻意不进测试** —— 它会打网络、依赖本机装没装模型，
 * 那属于「离线量尺」，不属于必须可复现的回归。缺 provider 时它由脚本如实打印 skip。
 *
 * ⚠️ 这份测试**只证明机制**：向量来自 `retrieval-corpus.mjs` 的确定性替身（加权同义词表），
 * 不是模型。**判定「语义检索有没有价值」不在这份文件的能力范围内**。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { makeWorkspace } from './fixture.mjs'
import { createSemanticEngine, SEM_EMBED_PER_PASS } from '../src/host/semantic.js'
// ⚠️ 从 `test/` 引，**不是** `tools/` —— `tools/` 不随包发布（v0.20.0 的 tarball 内自测
// 就是因为测试引了 `tools/` 里的东西而 638/1）。机器与语料都在会进包的那一半。
import {
  WARMUP_PASSES, recallAt, mrr, unrelatedRateAt,
  runPath, countingFetch, probeProvider, providerFromEnv,
} from './retrieval-eval.mjs'
import { FAKE_PROVIDER, QUERIES, corpusFiles, createFakeFetch } from './retrieval-corpus.mjs'

const root = makeWorkspace(corpusFiles())

/**
 * 剥掉状态行之后的面板载荷（判据 8a 要逐字比它）。
 *
 * ⚠️ `sessionId` 也要剥：它是**请求参数**（每条路径的会话 id 不同，见 `runPath`），
 * 不是检索结果的一部分。第一版没剥，断言红在 `corpus-L-…` vs `corpus-H2-…` 上 ——
 * 那是量尺自己的噪声，不是回退不一致。
 */
const stripSemantic = (payload) => {
  const { semantic, sessionId, ...rest } = payload
  void semantic
  void sessionId
  return JSON.stringify(rest)
}

/** L：词法基线（不装引擎 ⇒ 零 provider 调用）。 */
const L = await runPath({ root, retrieval: 'lexical', engine: null, label: 'L' })

/** H0：混合 + 确定性替身（调用次数数在 fetch 上）。 */
const h0Fetch = countingFetch(createFakeFetch())
const h0Engine = createSemanticEngine({ store: null, fetchImpl: h0Fetch })
await h0Engine.configure(FAKE_PROVIDER)
const H0 = await runPath({ root, retrieval: 'hybrid', engine: h0Engine, label: 'H0', counter: h0Fetch })

/** H2：混合 + provider 探测失败（真 fetch 打一个关着的端口）。 */
const h2Fetch = countingFetch(createFakeFetch({ probeStatus: 503 }))
const h2Engine = createSemanticEngine({ store: null, fetchImpl: h2Fetch, probeTtlMs: 1 })
await h2Engine.configure(FAKE_PROVIDER)
const H2 = await runPath({ root, retrieval: 'hybrid', engine: h2Engine, label: 'H2', counter: h2Fetch })

const byId = (run, id) => {
  const row = run.rows.find((r) => r.id === id)
  assert.ok(row, `语料里必须有 ${id} 这条查询`)
  return row
}

test('判据 8a：provider 探测失败时，混合结果与词法**逐字一致**（面板载荷 + 包内 rel）', () => {
  assert.equal(H2.rows.length, L.rows.length)
  for (const row of L.rows) {
    const other = byId(H2, row.id)
    assert.deepEqual(other.rels, row.rels, `${row.id}：包内顺序必须一模一样`)
    assert.equal(
      stripSemantic(other.publicPayload),
      stripSemantic(row.publicPayload),
      `${row.id}：除状态行外的面板载荷必须逐字相同`,
    )
    assert.equal(other.semantic.mode, 'lexical', `${row.id}：实际生效模式必须如实回词法`)
    assert.notEqual(other.semantic.reason, null, `${row.id}：必须写明回退原因`)
  }
})

test('判据 8b：H0 只「追加」在相关层 —— 主要 / 辅助两层与 L 一字不差，相关层以 L 为前缀', () => {
  let appendedTotal = 0
  for (const row of L.rows) {
    const other = byId(H0, row.id)
    assert.deepEqual(other.tiers.primary, row.tiers.primary, `${row.id}：主要层不许变`)
    assert.deepEqual(other.tiers.supporting, row.tiers.supporting, `${row.id}：辅助层不许变`)
    assert.deepEqual(
      other.tiers.related.slice(0, row.tiers.related.length),
      row.tiers.related,
      `${row.id}：相关层的既有条目必须原样在前`,
    )
    appendedTotal += other.rels.length - row.rels.length
  }
  assert.ok(appendedTotal > 0, '这份语料里必须至少有一条真的被语义补进来，否则上面两条断言是空转的')
})

test('判据 8b-2：标注为「词法必漏、语义该救」的样本，H0 真的补回来了', () => {
  const rescued = QUERIES.filter((q) => q.rescue.length > 0)
  assert.ok(rescued.length >= 2, '语料里至少要有两条这样的查询，这条守卫才有意义')
  for (const q of rescued) {
    const l = byId(L, q.id)
    const h = byId(H0, q.id)
    for (const rel of q.rescue) {
      assert.ok(!l.rels.includes(rel), `${q.id}：${rel} 在词法路径上**不该**被找到（否则它不是「漏」）`)
      assert.ok(h.rels.includes(rel), `${q.id}：${rel} 应当被语义候选补回来`)
      assert.ok(h.tiers.related.includes(rel), `${q.id}：${rel} 只许落在「相关」层`)
    }
  }
})

test('判据 8c：有界 —— 每轮 provider 调用 ≤ 3（探测 + 查询 + 一批文档）', async () => {
  const counter = countingFetch(createFakeFetch())
  const engine = createSemanticEngine({ store: null, fetchImpl: counter })
  await engine.configure(FAKE_PROVIDER)
  // 冷启动一轮：探测 1 + 查询 1 + 文档批 1
  const cold = await runSingle(engine, counter, 'bounded-cold')
  assert.ok(cold.calls >= 2, `冷启至少要有「探测 + 查询」两次调用，实测 ${cold.calls}`)
  assert.ok(cold.calls <= 3, `冷启不许超过 3 次调用（每轮最多嵌 ${SEM_EMBED_PER_PASS} 篇），实测 ${cold.calls}`)
  // 第二轮：探测有 TTL、文档已缓存 ⇒ 只剩查询那一次
  const warm = await runSingle(engine, counter, 'bounded-warm')
  assert.ok(warm.calls <= 2, `热身之后每轮只该有查询那一次（±1），实测 ${warm.calls}`)
  assert.ok(warm.embedded <= SEM_EMBED_PER_PASS, `单轮嵌入不许超过 ${SEM_EMBED_PER_PASS} 篇`)
})

/** 跑一次扫描，返回这一轮的 provider 调用次数与候选数。 */
async function runSingle(engine, counter, sessionId) {
  const { scan, setSemanticEngine } = await import('../src/host/index.js')
  const { fakeSession } = await import('./retrieval-corpus.mjs')
  setSemanticEngine(engine)
  const before = counter.count
  const payload = await scan(root, 40, {
    session: fakeSession('缓存失效策略', root),
    sessionId,
    sort: 'relevance',
    kind: 'context',
    retrieval: 'hybrid',
  })
  setSemanticEngine(null)
  return { calls: counter.count - before, embedded: payload.semantic.candidates }
}

test('判据 8d：局部指标函数算得对（手算例子）', () => {
  // Recall@K：分母是标注答案数，分子是「前 K 条里的答案数」
  assert.equal(recallAt(['a', 'b', 'c'], ['b', 'z'], 3), 0.5, '2 个答案命中 1 个 ⇒ 0.5')
  assert.equal(recallAt(['a', 'b', 'c'], ['c'], 2), 0, 'K=2 时 c 在第 3 位 ⇒ 0')
  assert.equal(recallAt(['a', 'b', 'c'], ['c'], 3), 1, 'K=3 时命中')
  assert.equal(recallAt([], ['a'], 5), 0, '空包 ⇒ 0')
  assert.equal(recallAt(['a'], [], 5), 0, '没有标注答案 ⇒ 0（不是 1）')
  // MRR：第一条命中的倒数排名
  assert.equal(mrr(['x', 'b'], ['b']), 0.5, '第 2 位命中 ⇒ 1/2')
  assert.equal(mrr(['b', 'x'], ['b']), 1, '第 1 位命中 ⇒ 1')
  assert.equal(mrr(['x', 'y'], ['b']), 0, '一条都没命中 ⇒ 0')
  // 无关候选率：前 K 条里不在答案里的比例
  assert.equal(unrelatedRateAt(['a', 'b', 'x', 'y'], ['a', 'b'], 4), 0.5, '4 条里 2 条无关 ⇒ 0.5')
  assert.equal(unrelatedRateAt([], ['a'], 5), 0, '空包 ⇒ 0')
  // 量尺本身的自洽：这份语料上 H0 的召回不该低于 L（同输入、同标注）
  const avg = (rows, fn) => rows.reduce((sum, r) => sum + fn(r), 0) / rows.length
  const lRecall = avg(L.rows, (r) => recallAt(r.rels, r.expected, 5))
  const hRecall = avg(H0.rows, (r) => recallAt(r.rels, r.expected, 5))
  assert.ok(
    hRecall >= lRecall,
    `在这份语料上 H0 的 R@5（${hRecall.toFixed(3)}）不该低于 L（${lRecall.toFixed(3)}）——`
    + '「只追加不改既有」意味着它可以相等，但不可能更低',
  )
  assert.ok(WARMUP_PASSES >= 1)
})

test('判据 8e：H1 的配置解析与探测可用（真 provider 的跑动**故意不在测试里**）', async () => {
  // 默认值：本机 Ollama
  assert.deepEqual(providerFromEnv({}), { kind: 'ollama', base: 'http://127.0.0.1:11434', model: 'nomic-embed-text' })
  // 环境变量给的 JSON 优先
  assert.deepEqual(
    providerFromEnv({ KNIT_EVAL_PROVIDER: '{"kind":"openai-compatible","base":"http://127.0.0.1:9/v1","model":"m"}' }),
    { kind: 'openai-compatible', base: 'http://127.0.0.1:9/v1', model: 'm' },
  )
  // 畸形 JSON 落回默认值，而不是抛
  assert.equal(providerFromEnv({ KNIT_EVAL_PROVIDER: '{oops' }).kind, 'ollama')
  // 探测一个**必然打不通**的回环端口 ⇒ false（H1 因此会如实 skip，而不是假装跑了）
  assert.equal(await probeProvider({ kind: 'ollama', base: 'http://127.0.0.1:9' }), false)
})
