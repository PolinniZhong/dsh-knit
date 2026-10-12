/**
 * Knit v0.23 · **可选混合检索的四路径离线量尺（CLI）**。
 *
 * 跑法：
 * ```sh
 * cd knit && node tools/hybrid-retrieval-eval.mjs
 * KNIT_EVAL_PROVIDER='{"kind":"ollama","base":"http://127.0.0.1:11434","model":"nomic-embed-text"}' \
 *   node tools/hybrid-retrieval-eval.mjs      # 指定真 provider（H1 才会跑）
 * ```
 *
 * 四条路径各自证明什么（别混着读，这是这个脚本唯一的纪律）：
 *
 * | 路径 | 用什么 | 能证明 | **不能**证明 |
 * |---|---|---|---|
 * | **L**  | `retrieval=lexical` | 基线：BM25 在这份语料上找回多少 | —— |
 * | **H0** | hybrid + **确定性替身 provider** | **机制**：候选算得出来、进得了「相关」层、有界、可复现 | ❌ **价值**：替身是加权同义词表，不是模型 |
 * | **H1** | hybrid + **真 provider** | 真模型在这份语料上的召回与代价（小样本） | —— |
 * | **H2** | hybrid + provider 探测失败 | 回退诚实：结果与 L **逐字一致** | —— |
 *
 * ⚠️ **诚实红线**：H1 没跑（本机没 provider）时只打印
 * `value-evidence: pending (no provider)`，**绝不许**把 H0 的数字写成「语义检索提升召回」。
 *
 * 机器（指标 / 跑一条路径 / 探测）在 `test/retrieval-eval.mjs` —— **`tools/` 不进包，
 * 而测试要引它**，所以能进包的那一半必须住在 `test/`（v0.20.0 的教训）。
 */

import { pathToFileURL } from 'node:url'

import { makeWorkspace } from '../test/fixture.mjs'
import { createSemanticEngine } from '../src/host/semantic.js'
import { SEM_EMBED_PER_PASS } from '../src/host/semantic.js'
import { CORPUS_VERSION, DOCS, QUERIES, FAKE_PROVIDER, corpusFiles, createFakeFetch } from '../test/retrieval-corpus.mjs'
import {
  WARMUP_PASSES, recallAt, mrr, unrelatedRateAt, packRels, tierOf,
  runPath, countingFetch, probeProvider, providerFromEnv,
  // ⚠️ 少了这两个就会在打印指标那一行 `ReferenceError`（2026-10-12 抓到过）。
  summarize, table,
} from '../test/retrieval-eval.mjs'

/* ── 主流程 ─────────────────────────────────────────── */

export async function main() {
  const root = makeWorkspace(corpusFiles())
  console.log(`Knit v0.23 · 四路径消融（corpus v${CORPUS_VERSION}）`)
  console.log(`语料：${DOCS.length} 篇 / ${QUERIES.length} 条查询；冷启动 ${WARMUP_PASSES} 轮铺满向量缓存`
    + `（每轮最多嵌 ${SEM_EMBED_PER_PASS} 篇）`)

  // ── L：词法基线
  const L = await runPath({ root, retrieval: 'lexical', engine: null, label: 'L' })

  // ── H0：混合 + 确定性替身（调用次数数在 fetch 上）
  const fakeFetch = countingFetch(createFakeFetch())
  const fakeEngine = createSemanticEngine({ store: null, fetchImpl: fakeFetch })
  await fakeEngine.configure(FAKE_PROVIDER)
  const H0 = await runPath({ root, retrieval: 'hybrid', engine: fakeEngine, label: 'H0', counter: fakeFetch })

  // L 与 H0 对比：谁被语义补回来了
  const h0ById = new Map(H0.rows.map((r) => [r.id, r]))
  for (const row of L.rows) {
    const h = h0ById.get(row.id)
    if (!h) continue
    const base = new Set(row.rels)
    h.appended = h.rels.filter((rel) => !base.has(rel))
  }

  // ── H2：混合 + provider 探测失败（真 fetch 打一个关着的端口）
  // ⚠️ H2 故意用一个**打不通的回环端口** + 真 fetch ⇒ 探测必然失败（这就是要验的回退路径）。
  const deadEngine = createSemanticEngine({ store: null, fetchImpl: fetch, probeTimeoutMs: 300 })
  await deadEngine.configure({ kind: 'ollama', base: 'http://127.0.0.1:9', model: 'dead' })
  const deadFetch = countingFetch(fetch)
  const H2 = await runPath({ root, retrieval: 'hybrid', engine: deadEngine, label: 'H2', counter: deadFetch })

  // ── H1：混合 + 真 provider（探测不到就如实 skip）
  const provider = providerFromEnv()
  const reachable = await probeProvider(provider)
  let H1 = null
  if (reachable) {
    const realFetch = countingFetch(fetch)
    const realEngine = createSemanticEngine({ store: null, fetchImpl: realFetch })
    await realEngine.configure(provider)
    H1 = await runPath({ root, retrieval: 'hybrid', engine: realEngine, label: 'H1', counter: realFetch })
  }

  /* ── 报告：先指标，后逐条 diff ─────────────────────── */
  const rowsL = L.rows
  const rowsH0 = H0.rows
  const summaryRows = [
    ['L  词法', summarize(rowsL), '基线'],
    ['H0 hybrid + 替身', summarize(rowsH0), '机制证据（**不是**价值证据）'],
    ['H2 hybrid + 探测失败', summarize(H2.rows), '回退，应与 L 逐字一致'],
  ]
  if (H1) summaryRows.push(['H1 hybrid + 真 provider', summarize(H1.rows), `真模型：${provider.model}`])

  console.log('\n── 指标（按包内顺序；Recall 取前 5 / 前 10）──')
  console.log(table(
    ['路径', 'R@5', 'R@10', 'MRR', '无关@5', '平均包长'],
    summaryRows.map(([label, s]) => [
      label, s.recall5.toFixed(3), s.recall10.toFixed(3), s.mrr.toFixed(3),
      s.unrelated5.toFixed(3), s.avgPack.toFixed(1),
    ]),
  ))

  console.log('\n── 代价（时延 / provider 调用）──')
  console.log(table(
    ['路径', '墙钟 ms', 'provider 调用'],
    [
      ['L', String(L.wallMs), '0（默认零调用）'],
      ['H0', String(H0.wallMs), String(H0.calls)],
      ['H2', String(H2.wallMs), String(H2.calls)],
      ...(H1 ? [['H1', String(H1.wallMs), String(H1.calls)]] : []),
    ],
  ))

  const h2same = H2.rows.every((r, i) => JSON.stringify(r.rels) === JSON.stringify(rowsL[i].rels))
  console.log(`\n回退一致性（H2 vs L，逐条比包内 rel 序列）：${h2same ? '✅ 逐字一致' : '❌ 有差异（这是缺陷）'}`)
  const rescued = rowsH0.reduce((sum, r) => sum + r.appended.filter((rel) => r.expected.includes(rel)).length, 0)
  const falsePositives = rowsH0.reduce((sum, r) => sum + r.appended.filter((rel) => !r.expected.includes(rel)).length, 0)
  console.log(`H0 替身补回的**标注答案**：${rescued} 条；补进来的非标注项：${falsePositives} 条`)

  console.log('\n── 逐条 diff（词法漏了谁 / 语义补回了谁）──')
  for (const h of rowsH0) {
    const l = rowsL.find((r) => r.id === h.id)
    const missed = h.expected.filter((rel) => !l.rels.includes(rel))
    const got = h.expected.filter((rel) => h.rels.includes(rel))
    const flag = missed.length === 0 ? '✓' : (got.length > (h.expected.length - missed.length) ? '↗' : '✗')
    console.log(`${flag} [${h.id}] 「${h.query}」`)
    console.log(`    L  : ${l.rels.join(' | ') || '(空)'}`)
    console.log(`    H0 : ${h.rels.join(' | ') || '(空)'}${h.appended.length ? `   ← 追加 ${h.appended.join(' | ')}` : ''}`)
    console.log(`    标注答案：${h.expected.map((rel) => `${rel}[${h.rels.includes(rel) ? '有' : '无'}]`).join(' ')}`
      + `；候选 ${h.semantic.candidates} 条（${h.semantic.mode}${h.semantic.reason ? '/' + h.semantic.reason : ''}）`)
  }

  /* ── 一行 JSON（以后回归对比直接用这行）─────────────── */
  const json = {
    corpusVersion: CORPUS_VERSION,
    docs: DOCS.length,
    queries: QUERIES.length,
    warmupPasses: WARMUP_PASSES,
    paths: {
      L: { metrics: summarize(rowsL), wallMs: L.wallMs, providerCalls: 0 },
      H0: { metrics: summarize(rowsH0), wallMs: H0.wallMs, providerCalls: H0.calls, rescued, falsePositives },
      H2: { metrics: summarize(H2.rows), wallMs: H2.wallMs, identicalToL: h2same },
      H1: H1
        ? { metrics: summarize(H1.rows), wallMs: H1.wallMs, providerCalls: H1.calls, provider: { kind: provider.kind, model: provider.model } }
        : null,
    },
    // ⚠️ 这两行是**结论**，别把它读成修辞。
    mechanismEvidence: 'measured (H0, deterministic stand-in provider)',
    valueEvidence: H1 ? `measured on ${QUERIES.length} queries with ${provider.model} (small sample, not a benchmark)` : 'pending (no provider)',
  }
  console.log(`\nJSON ${JSON.stringify(json)}`)
  if (!H1) {
    console.log(`\nSKIPPED: no provider at ${provider.base} —— H1 没跑。`)
    console.log('value-evidence: pending (no provider)；上面 H0 的数字只能证明**管道**，不能证明**价值**。')
  }
  return json
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) await main()
