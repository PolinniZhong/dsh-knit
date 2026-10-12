/**
 * Knit v0.23 · **四路径量尺的机器**（指标 + 跑一条路径 + provider 探测）。
 *
 * ⚠️ 为什么机器在 `test/` 而不是 `tools/`：**`tools/` 不随 npm 包发布**
 * （`package.json` 的 `files` 白名单只有两个脚本），而 `test/hybrid-eval.test.mjs`
 * 要引它。v0.20.0 就是这么翻车的 —— `test/deep-scale.test.mjs` 当时从
 * `tools/deep-benchmark.mjs` 取语料，发出去的包里 `npm test` 直接 638/1。
 * 修法也照抄那一次：**测试要用的东西放 `test/`**（语料 `retrieval-corpus.mjs` 同理）。
 *
 * CLI 与四路径报告在 `tools/hybrid-retrieval-eval.mjs`（那一份不进包，随便跑）。
 */

import { scan, setSemanticEngine, publicScanPayload } from '../src/host/index.js'
import { buildContext } from '../src/host/context.js'
import { clearVectors, SEM_EMBED_PER_PASS } from '../src/host/semantic.js'
import { DOCS, QUERIES, fakeSession } from './retrieval-corpus.mjs'

/** 冷启动要跑几轮「像面板那样每 5 秒轮询一次」才能把语料铺满向量缓存。 */
export const WARMUP_PASSES = Math.ceil(DOCS.length / SEM_EMBED_PER_PASS)

/* ── 指标（纯函数，测试直接引这几个）────────────────────
 * 口径写在名字里：**都按「包内顺序」算** —— 包才是用户与 agent 真正拿到的东西，
 * `ranked` 只是内部名次。K 默认 5（包通常就 5–15 条）。
 */

/**
 * 前 K 条里命中了多少条标注答案。
 * @param {string[]} packRels - 包内 rel（按阅读顺序）
 * @param {string[]} expected - 人工标注的正确答案
 * @param {number} [k] - 只看前 K 条
 * @returns {number} 0..1；`expected` 为空时返回 0（没有答案就没有召回率可言）
 */
export function recallAt(packRels, expected, k = 5) {
  const want = Array.isArray(expected) ? expected : []
  if (want.length === 0) return 0
  const top = packRels.slice(0, k)
  let hit = 0
  for (const rel of want) if (top.includes(rel)) hit += 1
  return hit / want.length
}

/**
 * 第一条命中的倒数排名（MRR）。
 * @param {string[]} packRels - 包内 rel（按阅读顺序）
 * @param {string[]} expected - 人工标注的正确答案
 * @returns {number} 1/rank；一条都没命中返回 0
 */
export function mrr(packRels, expected) {
  const want = new Set(Array.isArray(expected) ? expected : [])
  if (want.size === 0) return 0
  for (let i = 0; i < packRels.length; i += 1) {
    if (want.has(packRels[i])) return 1 / (i + 1)
  }
  return 0
}

/**
 * 前 K 条里有多少条**不在**标注答案里（无关候选率）。
 * @param {string[]} packRels - 包内 rel
 * @param {string[]} expected - 正确答案
 * @param {number} [k] - 只看前 K 条
 * @returns {number} 0..1
 */
export function unrelatedRateAt(packRels, expected, k = 5) {
  const top = packRels.slice(0, k)
  if (top.length === 0) return 0
  const want = new Set(Array.isArray(expected) ? expected : [])
  return top.filter((rel) => !want.has(rel)).length / top.length
}

/** 包内 rel（按阅读顺序：主要 → 辅助 → 相关）。 */
export function packRels(pack) {
  return [...pack.primary, ...pack.supporting, ...pack.related].map((item) => item.rel)
}

/** 命中层分布：这条 rel 落在哪一层（不在包里返回 null）。 */
export function tierOf(pack, rel) {
  if (pack.primary.some((i) => i.rel === rel)) return 'primary'
  if (pack.supporting.some((i) => i.rel === rel)) return 'supporting'
  if (pack.related.some((i) => i.rel === rel)) return 'related'
  return null
}

/* ── 装配：把一次 `scan()` 的结果变成包 ─────────────────── */

export const assemble = (payload) => buildContext({
  ranked: payload.ranked,
  topic: payload.topic,
  task: payload.task,
  total: payload.total,
  graph: null,
})

/**
 * 把 fetch 包一层计数（「provider 调用次数」就数它 —— 引擎只会通过注入的 fetchImpl 出去）。
 * @param {Function} inner - 真的 fetch（替身或全局）
 * @returns {Function} 带 `count` 的 fetch
 */
export function countingFetch(inner) {
  const fn = async (url, init) => {
    fn.count += 1
    return inner(url, init)
  }
  fn.count = 0
  return fn
}

/**
 * 跑一条路径上的全部查询。
 *
 * @param {object} options - `{ root, retrieval, engine, label, counter }`
 *   `engine` 为 null 表示不装语义引擎（纯词法）；`counter` 是计数 fetch（可无）。
 * @returns {Promise<{rows: object[], wallMs: number, calls: number}>}
 */
export async function runPath(options) {
  const { root, retrieval, engine, label, counter } = options
  clearVectors()
  if (engine) setSemanticEngine(engine)
  else setSemanticEngine(null)

  const rows = []
  const started = Date.now()
  for (const q of QUERIES) {
    const session = fakeSession(q.query, root)
    // ⚠️ 每条查询**换一个 sessionId**：`convCache` 按 sessionId + seq 键控，
    // 复用同一个 id 会让第二条查询拿到第一条的关键词（踩过一次）。
    const args = {
      session, sessionId: `corpus-${label}-${q.id}`,
      sort: 'relevance', kind: 'context', retrieval,
    }
    let last = null
    let lastCalls = 0
    // 词法路径不需要预热（没有向量缓存这回事）；混合路径要，模拟面板每 5 秒轮询。
    const passes = engine ? WARMUP_PASSES + 1 : 1
    for (let pass = 0; pass < passes; pass += 1) {
      const before = counter ? counter.count : 0
      last = await scan(root, 40, args)
      lastCalls = (counter ? counter.count : 0) - before
    }
    const pack = assemble(last)
    const rels = packRels(pack)
    const semantic = last.semantic || {}
    const lexicalRels = (last.ranked || []).filter((d) => (Number(d.raw) || 0) > 0).map((d) => d.rel)
    const zeroHit = (last.ranked || []).filter((d) => (Number(d.raw) || 0) === 0).map((d) => d.rel)
    rows.push({
      id: q.id, case: q.case, query: q.query,
      expected: q.expected, rescue: q.rescue,
      rels,
      // 分层结构与面板载荷都留着给测试用（判据 8a/8b 要逐字比它们）
      tiers: {
        primary: pack.primary.map((i) => i.rel),
        supporting: pack.supporting.map((i) => i.rel),
        related: pack.related.map((i) => i.rel),
      },
      publicPayload: publicScanPayload(last),
      tier: q.expected.map((rel) => `${rel}=${tierOf(pack, rel) || '缺'}`).join(' '),
      lexicalRels, zeroHit,
      appended: rels.slice(0, 0), // 由调用方与 L 对比后填
      semantic: {
        mode: semantic.mode, reason: semantic.reason,
        candidates: semantic.candidates,
        configured: semantic.configured,
      },
      passCalls: lastCalls,
    })
  }
  setSemanticEngine(null)
  return { rows, wallMs: Date.now() - started, calls: counter ? counter.count : 0 }
}

/** 打印一张表（纯文本，列宽自适应）。 */
/** 纯文本等宽表（CLI 打印指标用；同样必须导出，理由见 `summarize()`）。 */
export function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)))
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ')
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n')
}

/** 一条查询的指标聚合。 */
/**
 * 把一组「每条查询的命中情况」收成一行指标。
 *
 * ⚠️ **必须导出**：`tools/hybrid-retrieval-eval.mjs`（CLI）也要用它 —— 它原来是个私有函数，
 * 于是 CLI 一跑就 `ReferenceError: summarize is not defined`（2026-10-12 实测抓到）。
 * 机器住 `test/`（`tools/` 不进包、而测试要引它），CLI 只做打印。
 */
export function summarize(rows) {
  const n = rows.length
  const avg = (fn) => rows.reduce((sum, r) => sum + fn(r), 0) / (n || 1)
  return {
    queries: n,
    recall5: avg((r) => recallAt(r.rels, r.expected, 5)),
    recall10: avg((r) => recallAt(r.rels, r.expected, 10)),
    mrr: avg((r) => mrr(r.rels, r.expected)),
    unrelated5: avg((r) => unrelatedRateAt(r.rels, r.expected, 5)),
    avgPack: avg((r) => r.rels.length),
  }
}

/** 探测一个真 provider 在不在（只发一个 GET，不装引擎）。H1 靠它决定「跑」还是「如实 skip」。 */
export async function probeProvider(config) {
  const url = config.kind === 'ollama'
    ? `${config.base}/api/tags`
    : `${config.base}/v1/models`
  try {
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), 1500) : null
    const res = await fetch(url, controller ? { signal: controller.signal } : {})
    if (timer) clearTimeout(timer)
    return res.status >= 200 && res.status < 300
  } catch {
    return false
  }
}

/** 真 provider 模式的配置：`KNIT_EVAL_PROVIDER`（JSON）优先，否则本机 Ollama 默认值。 */
export function providerFromEnv(env = process.env) {
  const raw = env.KNIT_EVAL_PROVIDER
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && parsed.kind && parsed.base && parsed.model) return parsed
    } catch { /* 落回默认值 */ }
  }
  return {
    kind: 'ollama',
    base: env.KNIT_EVAL_BASE || 'http://127.0.0.1:11434',
    model: env.KNIT_EVAL_MODEL || 'nomic-embed-text',
  }
}

