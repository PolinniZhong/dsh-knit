/**
 * Knit · **真实工作区检索评测**（v1）—— 把「默认词法在这份真实语料上找回多少」变成可复现的数字。
 *
 * 它**不是** `tools/hybrid-retrieval-eval.mjs` 的替代品，两者量的是不同的东西：
 *
 * | 脚本 | 语料 | 能证明 | 不能用它证明 |
 * |---|---|---|---|
 * | `tools/hybrid-retrieval-eval.mjs` | 合成临时工作区（19 篇，`test/retrieval-corpus.mjs`） | 四路径**机制**（追加、有界、回退逐字一致、确定性替身） | 真实语料上的效果 |
 * | **本脚本** | **真实工作区**（`--root`，本机 182 篇） | 词法基线在真实文件上的 R@5 / MRR / 命中率 / 干扰项命中率；回退一致性；**语义通道的可用头寸** | 语义检索的**价值**（那要真 provider） |
 *
 * 跑法：
 *
 * ```sh
 * cd knit
 * node tools/real-workspace-eval.mjs                 # 量尺（L + H2 回退 + 头寸清单）
 * node tools/real-workspace-eval.mjs --verify        # 先核对标注：标签文件在不在、依据 grep 得到吗
 * node tools/real-workspace-eval.mjs --json          # 只打最后那行 JSON
 * node tools/real-workspace-eval.mjs --root "/path/to/workspace"
 * ```
 *
 * ⚠️ **本脚本跑不出「Hybrid 提升了召回率」这句话**：
 *   · 没有 provider 时，Hybrid 会回退成词法 ⇒ 它**本来就该**与 L 逐字一致（本脚本会验这一条）；
 *   · 有 provider 时，价值的判定也不在这里，而在 `hybrid-retrieval-eval.mjs` 的 H1。
 *   ⇒ 本脚本量到的「词法没找到的标注答案」（`headroom`）是**待验证的机会**，不是收益。
 *
 * 机器（指标函数 / 报告表）复用 `test/retrieval-eval.mjs`；**标注**在本目录的
 * `real-workspace-corpus.mjs`（`tools/` 不进 npm 包，所以它描述的是本机真实目录）。
 */

import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scan, setSemanticEngine, publicScanPayload } from '../src/host/index.js'
import { buildContext } from '../src/host/context.js'
import { createSemanticEngine } from '../src/host/semantic.js'
import { recallAt, mrr, unrelatedRateAt, packRels, tierOf, table } from '../test/retrieval-eval.mjs'
import { CORPUS_VERSION, CORPUS_BASELINE, QUERIES } from './real-workspace-corpus.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..', '..')

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const JSON_ONLY = process.argv.includes('--json')
const VERIFY_ONLY = process.argv.includes('--verify')
const root = resolve(argOf('--root', DEFAULT_ROOT))

/**
 * 🔴 **评测自己的产物必须从语料里排除掉**，否则这份量尺是自我实现的：
 * `real-workspace-corpus.mjs` 里逐字写着 24 条查询与它们的依据短语，
 * 放在工作区里就是一个「每一条查询都能命中它」的磁铁（首跑实测：它出现在几乎每一个包里，
 * 把标注答案挤到第 7–9 位）。它不是被评测的项目文件，它**是评测本身**。
 * 评测报告同理（它会把查询逐条抄一遍）。
 *
 * ⚠️ 这里用的是 `scan()` 公开支持的 `excluded`（v0.21 控制层同一条路：**排除先于检索**）——
 * 不是「跑完再把它们筛掉」。A5 会反过来证明它们真的没进任何一层。
 */
const EVAL_ARTIFACTS = [
  'knit/tools/real-workspace-eval.mjs',
  'knit/tools/real-workspace-corpus.mjs',
  'knit/tools/semantic-request-audit.mjs',
  'knit/docs/evaluations/hybrid-retrieval.md',
  // v0.25 新增的**评测产物**照旧排除（规格文档不算产物，`knit/docs/git-aware-context.md`
  // 就**不**在这里 —— 它是产品规格，理应留在语料里）。
  'knit/docs/evaluations/git-change-value.md',
  'knit/tools/changes-value-eval.mjs',
  'knit/tools/changes-forward-check.mjs',
]
// ⚠️ 即便如此，基线那批数字（corpusDocs 182 / R@5 0.479）**今天也复现不了**，而且不该去凑：
// v0.25 的实现自己在工作区里长出了 4 个**源码/测试**文件（`src/host/git.js`、`src/host/changes.js`、
// `test/git-changes.test.mjs`、`test/http-harness.mjs`）—— 它们是**被测产品**，不是评测产物，
// 把它们排除掉才是伪造语料。所以那个 182 是「v0.25 之前的工作区」的快照，
// 与本轮之后的任何重跑都**不可直接比较**（见 `docs/evaluations/git-change-value.md` §五）。
const EXCLUDED = new Set(process.argv.includes('--no-exclude') ? [] : EVAL_ARTIFACTS)

/* ── 会话替身：走「面板那条路」（`task` = 用户原话）───────── */

const fakeSession = (text, cwd) => ({
  header: { cwd, id: 'sess-real-eval' },
  snapshotEvents: () => [{
    seq: 1,
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }],
})

/** 计数 fetch（只用来数 H2 的探测次数；它打的端口本来就是关着的）。 */
const countingFetch = (inner) => {
  const fn = async (url, init) => { fn.count += 1; return inner(url, init) }
  fn.count = 0
  return fn
}

/* ── 指标（都按**包内顺序**算；K=5，另附 @10）───────────── */

/**
 * 「命中率」在这里的定义要写死，否则每个人心里的数都不一样：
 * **至少有一条标注答案落进前 K 条的查询占比**（success@K）。
 * 与 Recall@K 的分工：Recall 看「答案找全了多少」，命中率看「多少条查询至少没全空」。
 */
const hitRateAt = (rows, k) => {
  const withHits = rows.filter((r) => r.pack.slice(0, k).some((rel) => r.expected.includes(rel)))
  return rows.length ? withHits.length / rows.length : 0
}

/** 干扰项命中率：前 K 条里出现了**标注的负样例**的查询占比。 */
const distractorRateAt = (rows, k) => {
  const hit = rows.filter((r) => r.pack.slice(0, k).some((rel) => (r.distractors || []).includes(rel)))
  return rows.length ? hit.length / rows.length : 0
}

const summarizeRows = (rows) => {
  const n = rows.length || 1
  const avg = (fn) => rows.reduce((sum, r) => sum + fn(r), 0) / n
  return {
    queries: rows.length,
    recall5: avg((r) => recallAt(r.pack, r.expected, 5)),
    recall10: avg((r) => recallAt(r.pack, r.expected, 10)),
    mrr: avg((r) => mrr(r.pack, r.expected)),
    hit5: hitRateAt(rows, 5),
    hit10: hitRateAt(rows, 10),
    unrelated5: avg((r) => unrelatedRateAt(r.pack, r.expected, 5)),
    distractor5: distractorRateAt(rows, 5),
    avgPack: avg((r) => r.pack.length),
  }
}

/* ── 跑一条路径 ─────────────────────────────────────── */

async function runPath({ retrieval, engine, label, counter }) {
  if (engine) setSemanticEngine(engine)
  else setSemanticEngine(null)

  const rows = []
  const started = Date.now()
  for (const q of QUERIES) {
    const session = fakeSession(q.query, root)
    const payload = await scan(root, 40, {
      session,
      sessionId: `real-${label}-${q.id}`, // 每条查询换一个 sessionId（convCache 按它键控）
      sort: 'relevance',
      kind: 'context',
      retrieval,
      excluded: EXCLUDED,
    })
    const pack = buildContext({ ranked: payload.ranked, topic: payload.topic, task: payload.task, total: payload.total, graph: null })
    const packRelList = packRels(pack)
    const tierOfRel = (rel) => tierOf(pack, rel)
    rows.push({
      id: q.id,
      case: q.case,
      query: q.query,
      expected: q.expected,
      distractors: q.distractors || [],
      note: q.note,
      pack: packRelList,
      tiers: { primary: pack.primary.map((i) => i.rel), supporting: pack.supporting.map((i) => i.rel), related: pack.related.map((i) => i.rel) },
      tier: q.expected.map((rel) => `${rel}=${tierOfRel(rel) || '缺'}`).join(' '),
      publicPayload: publicScanPayload(payload),
      semantic: {
        // ⚠️ 2026-10-13 修：原来这里只手挑 5 个字段，**漏了 `requested` 与 `provider`** ——
        // 于是逐条诊断打出来是 `requested=undefined`（那是取字段的锅，不是宿主没给：
        // `publicSemantic()` 两个字段都下发）。诊断要能回答「用户要的是 hybrid 吗 / 用的哪个 provider」，
        // 这两个字段都得带上。**这是提取，不是新请求**。
        requested: (payload.semantic || {}).requested,
        mode: (payload.semantic || {}).mode,
        reason: (payload.semantic || {}).reason,
        candidates: (payload.semantic || {}).candidates,
        configured: (payload.semantic || {}).configured,
        available: (payload.semantic || {}).available,
        provider: (payload.semantic || {}).provider,
      },
      // 语义通道**够得着**的对象：词法一条都没命中（`raw === 0`）的候选 —— 这就是头寸。
      zeroHit: (payload.ranked || []).filter((d) => (Number(d.raw) || 0) === 0).map((d) => d.rel),
      // 每篇能不能给语义通道「喂得上话」（title + summary 拼得出非空文本）。
      embedTexts: new Map((payload.allDocs || []).map((d) => {
        const t = `${d.title || ''}\n${d.summary || ''}`.trim()
        return [d.rel, t.slice(0, 2000)]
      })),
    })
  }
  setSemanticEngine(null)
  return { rows, wallMs: Date.now() - started, calls: counter ? counter.count : 0 }
}

/* ── 标注核对（--verify / 每轮都跑）────────────────────── */

/** 扫描一次拿全量语料的 rel 集合（按时间序，不抽关键词 ⇒ 最省的那条路）。 */
const corpus = await scan(root, 500, {
  session: fakeSession('x', root), sessionId: 'real-corpus', sort: 'time', kind: 'context',
  excluded: EXCLUDED,
})
const corpusRels = new Set((corpus.allDocs || []).map((d) => d.rel))

const labelProblems = []
for (const q of QUERIES) {
  for (const rel of q.expected) {
    if (!corpusRels.has(rel)) { labelProblems.push(`[${q.id}] 答案不在语料里：${rel}`); continue }
    const phrase = (q.evidence || {})[rel]
    if (!phrase) { labelProblems.push(`[${q.id}] 答案缺依据：${rel}`); continue }
    const text = await readFile(join(root, rel), 'utf8').catch(() => null)
    if (text === null) { labelProblems.push(`[${q.id}] 读不到文件：${rel}`); continue }
    if (!text.includes(phrase)) labelProblems.push(`[${q.id}] 依据 grep 不到（${rel}）：${JSON.stringify(phrase)}`)
  }
  for (const rel of q.distractors || []) {
    if (!corpusRels.has(rel)) labelProblems.push(`[${q.id}] 干扰项不在语料里：${rel}`)
    if (q.expected.includes(rel)) labelProblems.push(`[${q.id}] 同一个文件既标答案又标干扰项：${rel}`)
  }
}

/* ── 四条对照路径 ───────────────────────────────────── */

// L：纯词法（不装引擎 ⇒ 应当**一次 provider 调用都不发**）
const L = await runPath({ retrieval: 'lexical', engine: null, label: 'L' })

// H2：要了 hybrid，但 provider 探测必然失败（打一个关着的回环端口）
const deadFetch = countingFetch(fetch)
const deadEngine = createSemanticEngine({ store: null, fetchImpl: deadFetch, probeTimeoutMs: 300 })
await deadEngine.configure({ kind: 'ollama', base: 'http://127.0.0.1:9', model: 'dead' })
const H2 = await runPath({ retrieval: 'hybrid', engine: deadEngine, label: 'H2', counter: deadFetch })

// H1：真 provider —— 探测不到就如实 skip（**不许**拿替身数字冒充）
const provider = (() => {
  const raw = process.env.KNIT_EVAL_PROVIDER
  if (raw) { try { const p = JSON.parse(raw); if (p && p.kind && p.base && p.model) return p } catch { /* 落回默认 */ } }
  return { kind: 'ollama', base: process.env.KNIT_EVAL_BASE || 'http://127.0.0.1:11434', model: process.env.KNIT_EVAL_MODEL || 'nomic-embed-text' }
})()
const reachable = await (async () => {
  const url = provider.kind === 'ollama' ? `${provider.base}/api/tags` : `${provider.base}/v1/models`
  try {
    const c = typeof AbortController === 'function' ? new AbortController() : null
    const t = c ? setTimeout(() => c.abort(), 1500) : null
    const res = await fetch(url, c ? { signal: c.signal } : {})
    if (t) clearTimeout(t)
    return res.status >= 200 && res.status < 300
  } catch { return false }
})()
let H1 = null
let h1Engine = null
if (reachable) {
  const realFetch = countingFetch(fetch)
  const realEngine = createSemanticEngine({ store: null, fetchImpl: realFetch })
  h1Engine = realEngine
  await realEngine.configure(provider)
  H1 = await runPath({ retrieval: 'hybrid', engine: realEngine, label: 'H1', counter: realFetch })
  H1.appended = H1.rows.map((h) => {
    const l = L.rows.find((r) => r.id === h.id)
    const base = new Set(l ? l.pack : [])
    return h.pack.filter((rel) => !base.has(rel))
  })
}

/* ── 头寸：词法没找到的标注答案（**不是收益**）────────── */

const headroom = []
for (const l of L.rows) {
  const missed = l.expected.filter((rel) => !l.pack.includes(rel))
  if (missed.length === 0) continue
  const l2 = H1 ? H1.rows.find((r) => r.id === l.id) : null
  headroom.push({
    id: l.id,
    query: l.query,
    case: l.case,
    missed,
    // 这些文件是「词法一条都没命中」的那批吗？（语义通道只在这些条上有活干）
    missedZeroHit: missed.map((rel) => l.zeroHit.includes(rel)),
    // 语义通道够得着吗：title + summary 拼得出非空文本
    missedHasEmbedText: missed.map((rel) => Boolean(l.embedTexts.get(rel))),
    foundByHybrid: l2 ? missed.filter((rel) => l2.pack.includes(rel)) : null,
  })
}

/* ── 逐条语义诊断（每条查询 × 每条路径）────────────────
 * `runPath()` 已经为每一行存下了 `semantic`（requested/mode/available/reason/candidates），
 * 但报告里原来**只打印 L 行** ⇒ 「这一轮到底有没有真的进 provider」在逐条层面看不出来。
 * 下面这层是**纯提取**：不改任何检索行为、不发任何额外请求。
 */
const tallyOf = (rows) => {
  const t = {}
  for (const r of rows) {
    const s = r.semantic
    const key = `requested=${s.requested} mode=${s.mode} available=${s.available} reason=${s.reason || '-'} candidates=${s.candidates}`
    t[key] = (t[key] || 0) + 1
  }
  return t
}
const semanticDiagnostics = L.rows.map((l) => ({
  id: l.id,
  L: l.semantic,
  H2: (H2.rows.find((r) => r.id === l.id) || {}).semantic || null,
  H1: H1 ? ((H1.rows.find((r) => r.id === l.id) || {}).semantic || null) : null,
}))

/* ── 断言 ───────────────────────────────────────────── */

const checks = []
const check = (id, title, ok, detail) => checks.push({ id, title, ok: !!ok, detail: detail || '' })

check('A1', '词法路径一次 provider 调用都不发', L.calls === 0, `L 的 provider 调用 = ${L.calls}`)

const stripDynamic = (row) => {
  const { semantic, sessionId, ...rest } = row.publicPayload
  void semantic
  void sessionId
  return JSON.stringify(rest)
}
const mismatched = L.rows.filter((l) => {
  const h = H2.rows.find((r) => r.id === l.id)
  return !h || JSON.stringify(h.pack) !== JSON.stringify(l.pack) || stripDynamic(h) !== stripDynamic(l)
})
check('A2', '回退诚实：provider 探不通时，hybrid 的包与面板载荷与词法**逐字一致**',
  mismatched.length === 0 && H2.rows.every((r) => r.semantic.mode === 'lexical' && r.semantic.reason),
  mismatched.length === 0
    ? `${L.rows.length} 条查询逐条比过（包内顺序 + 除状态行外的载荷）`
    : `不一致：${mismatched.map((r) => r.id).join(', ')}`)

check('A3', '标注自洽：每个答案文件都在语料里、都有一条能 grep 到的依据', labelProblems.length === 0,
  labelProblems.length === 0
    ? `${QUERIES.length} 条查询 / ${QUERIES.reduce((n, q) => n + q.expected.length, 0)} 条答案 / `
      + `${QUERIES.reduce((n, q) => n + (q.distractors || []).length, 0)} 条干扰项，逐条核对通过`
    : labelProblems.join(' | '))

check('A4', 'L 与 H2 的包长逐条相同（回退不改变包的大小）',
  L.rows.every((l) => (H2.rows.find((r) => r.id === l.id) || {}).pack?.length === l.pack.length),
  '逐条比过')

// A5：评测自己的产物不许出现在任何一层 —— 否则量尺是自我实现的（见 `EVAL_ARTIFACTS` 的注释）。
const leakedArtifacts = [...new Set(L.rows.flatMap((l) => l.pack).filter((rel) => EXCLUDED.has(rel)))]
check('A5', '评测产物（语料 / 量尺 / 报告）没有进任何一层',
  EXCLUDED.size > 0 && leakedArtifacts.length === 0,
  EXCLUDED.size === 0
    ? '⚠️ 本次跑了 --no-exclude：语料里包含评测自己的文件，下面的数字不可用于结论'
    : (leakedArtifacts.length === 0
      ? `已排除 ${EXCLUDED.size} 个路径（经 scan() 的 excluded 参数，先于检索生效）`
      : `漏进包里的：${JSON.stringify(leakedArtifacts)}`))

const headroomNote = headroom.length === 0
  ? '这份语料上词法把所有标注答案都找回来了 —— 语义通道没有头寸'
  : `${headroom.length} 条查询有 ${headroom.reduce((n, h) => n + h.missed.length, 0)} 个标注答案没被词法找回（待验证的机会，**不是**收益）`

/* ── 报告 ───────────────────────────────────────────── */

const version = JSON.parse(await readFile(join(HERE, '..', 'package.json'), 'utf8')).version
const gitHead = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: HERE, encoding: 'utf8' }).trim() } catch { return null } })()

const summaryRows = [
  ['L   词法（默认）', summarizeRows(L.rows), '本次量到的基线'],
  ['H2  hybrid + 探测失败', summarizeRows(H2.rows), '回退，应与 L 逐字一致'],
]
if (H1) summaryRows.push(['H1  hybrid + 真 provider', summarizeRows(H1.rows), `真模型：${provider.model}`])

if (!JSON_ONLY) {
  const line = (s = '') => console.log(s)
  line('Knit · 真实工作区检索评测')
  line(`  插件版本   ${version}（git ${gitHead || '?'}）`)
  line(`  工作区     ${root}`)
  line(`  语料       ${corpusRels.size} 篇（扫描 ${corpus.stats ? corpus.stats.scanMs : '?'} ms；`
    + `已排除 ${EXCLUDED.size} 个评测自身产物 —— 见 A5）`)
  line(`  语料版本   v${CORPUS_VERSION}（标注于 ${CORPUS_BASELINE.measuredAt}，当初 ${CORPUS_BASELINE.note}）`)
  line(`  查询       ${QUERIES.length} 条（精确 ${QUERIES.filter((q) => q.case === 'exact').length} / `
    + `同义 ${QUERIES.filter((q) => q.case === 'synonym').length} / 负样例 ${QUERIES.filter((q) => q.case === 'negative').length}）`)
  line(`  provider   ${reachable ? `可用（${provider.kind} ${provider.base} ${provider.model}）` : `不可用（探测 ${provider.base} 失败）⇒ H1 跳过`}`)
  line()

  line('── 一、指标（按包内顺序；命中率 = 至少一条标注答案进前 K 的查询占比）──')
  line(table(
    ['路径', 'R@5', 'R@10', 'MRR', '命中@5', '命中@10', '无关@5', '干扰项@5', '平均包长'],
    summaryRows.map(([label, s]) => [
      label, s.recall5.toFixed(3), s.recall10.toFixed(3), s.mrr.toFixed(3),
      s.hit5.toFixed(3), s.hit10.toFixed(3), s.unrelated5.toFixed(3), s.distractor5.toFixed(3), s.avgPack.toFixed(1),
    ]),
  ))
  line()

  line('── 二、代价 ──')
  line(table(['路径', '墙钟 ms', 'provider 调用'], [
    ['L', String(L.wallMs), '0（默认零调用）'],
    ['H2', String(H2.wallMs), String(H2.calls)],
    ...(H1 ? [['H1', String(H1.wallMs), String(H1.calls)]] : []),
  ]))
  line()

  line('── 三、断言 ──')
  for (const c of checks) line(`  ${c.ok ? '✅' : '❌'} ${c.id.padEnd(3)} ${c.title}\n        ${c.detail}`)
  line()

  line('── 三·五、干扰项是谁在骗到前 5 名 ──')
  {
    const tally = new Map()
    for (const l of L.rows) {
      for (const rel of l.pack.slice(0, 5)) {
        if (!(l.distractors || []).includes(rel)) continue
        tally.set(rel, (tally.get(rel) || 0) + 1)
      }
    }
    if (tally.size === 0) line('  （一条都没骗到）')
    for (const [rel, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) line(`  ×${String(n).padEnd(3)} ${rel}`)
    line(`  ⇒ 干扰项@5 = ${(distractorRateAt(L.rows, 5)).toFixed(3)}（${L.rows.filter((l) => l.pack.slice(0, 5).some((rel) => (l.distractors || []).includes(rel))).length}/${L.rows.length} 条查询的前 5 名里有标注的干扰项）`)
    line('  ⚠️ 「无关@5」在这份语料上**不是检索质量指标**：标注只写「该打开的那 1–3 篇」，')
    line('     而包平均 7.6 条 —— 分母注定很大。要看质量请看 命中@5 / R@5 / MRR 与上面的干扰项明细。')
  }
  line()

  line('── 四、语义通道的头寸（词法没找回的标注答案）──')
  line(`  ${headroomNote}`)
  for (const h of headroom) {
    const reach = h.missed.map((rel, i) => `${rel}${h.missedZeroHit[i] ? '（零命中）' : '（有命中但没进包）'}${h.missedHasEmbedText[i] ? '' : '/⚠️无可嵌入文本'}`)
    line(`  · [${h.case}] 「${h.query}」`)
    line(`      未找回：${reach.join('、')}`)
    if (h.foundByHybrid) line(`      真 provider 找回了：${h.foundByHybrid.length ? h.foundByHybrid.join('、') : '（没有）'}`)
  }
  line()

  line('── 五、逐条语义诊断（每条查询在**每条路径**上实际走了哪条路）──')
  line('  ⚠️ 2026-10-13 修：这一节原来只打印 L 行的语义状态，H1 / H2 的 mode/reason 看不到 ——')
  line('     于是「真 provider 到底进没进去」在逐条层面无法确认。现在三列并排。')
  line()
  line(`  ${'查询 id'.padEnd(24)} ${'L'.padEnd(28)} ${'H2'.padEnd(28)} H1`)
  for (const row of semanticDiagnostics) {
    const cell = (d) => `${d.mode}/${d.reason || '-'}/${d.candidates}c`.padEnd(28)
    line(`  ${row.id.padEnd(24)} ${cell(row.L)} ${cell(row.H2)} ${row.H1 ? cell(row.H1) : '(未跑)'}`)
  }
  line()
  line('  ── 每条路径的模式 / 原因汇总 ──')
  for (const [label, tally] of Object.entries({ L: tallyOf(L.rows), H2: tallyOf(H2.rows), ...(H1 ? { H1: tallyOf(H1.rows) } : {}) })) {
    line(`  ${label}：`)
    for (const [k, n] of Object.entries(tally)) line(`      ×${String(n).padEnd(3)} ${k}`)
  }
  line()

  line('── 六、逐条明细（包内顺序 + 标注答案）──')
  for (const l of L.rows) {
    const got = l.expected.filter((rel) => l.pack.includes(rel))
    const missed = l.expected.filter((rel) => !l.pack.includes(rel))
    const flag = missed.length === 0 ? '✓' : (got.length > 0 ? '↗' : '✗')
    const h = H1 ? H1.rows.find((r) => r.id === l.id) : null
    const appended = h ? h.pack.filter((rel) => !l.pack.includes(rel)) : []
    line(`${flag} [${l.case}] 「${l.query}」`)
    line(`     包：${l.pack.join(' | ') || '(空)'}${appended.length ? `   ← H1 追加 ${appended.join(' | ')}` : ''}`)
    line(`     标注答案：${l.expected.map((rel) => `${rel}[${l.pack.includes(rel) ? '有' : '无'}]`).join(' ')}`)
  }
  line()

  const failed = checks.filter((c) => !c.ok)
  line(failed.length === 0 ? '结论：本次全部断言成立。' : `结论：${failed.length} 条断言不成立（见上）。`)
  line('⚠️ 本脚本**没有**证明语义检索有价值：'
    + (H1 ? 'H1 这一轮的数字是小样本真 provider 结果，仍不构成基准。' : 'H1 没跑（本机没有 provider）。'))
}

/* ── JSON（回归对比直接用这一行）────────────────────── */

const json = {
  tool: 'real-workspace-eval',
  corpusVersion: CORPUS_VERSION,
  corpusBaseline: CORPUS_BASELINE,
  pluginVersion: version,
  gitHead,
  root,
  conditions: {
    corpusDocs: corpusRels.size,
    excludedArtifacts: [...EXCLUDED],
    queries: QUERIES.length,
    cases: {
      exact: QUERIES.filter((q) => q.case === 'exact').length,
      synonym: QUERIES.filter((q) => q.case === 'synonym').length,
      negative: QUERIES.filter((q) => q.case === 'negative').length,
    },
    kind: 'context',
    sort: 'relevance',
    limit: 40,
    provider: { reachable, kind: provider.kind, base: provider.base, model: provider.model },
  },
  paths: {
    L: { metrics: summarizeRows(L.rows), wallMs: L.wallMs, providerCalls: L.calls },
    H2: {
      metrics: summarizeRows(H2.rows), wallMs: H2.wallMs, providerCalls: H2.calls,
      identicalToL: checks.find((c) => c.id === 'A2').ok,
    },
    H1: H1
      ? {
        metrics: summarizeRows(H1.rows), wallMs: H1.wallMs, providerCalls: H1.calls,
        provider: { kind: provider.kind, model: provider.model },
        rescued: H1.rows.reduce((sum, h, i) => sum + (h.appended || []).filter((rel) => h.expected.includes(rel)).length, 0),
        appendedUnrelated: H1.rows.reduce((sum, h, i) => sum + (h.appended || []).filter((rel) => !h.expected.includes(rel)).length, 0),
        appendedTotal: H1.rows.reduce((sum, h) => sum + (h.appended || []).length, 0),
      }
      : null,
  },
  headroom: {
    queriesWithMiss: headroom.length,
    missedTotal: headroom.reduce((n, h) => n + h.missed.length, 0),
    missedZeroHit: headroom.reduce((n, h) => n + h.missedZeroHit.filter(Boolean).length, 0),
    detail: headroom.map((h) => ({ id: h.id, query: h.query, case: h.case, missed: h.missed, foundByHybrid: h.foundByHybrid })),
  },
  /**
   * 逐条 + 逐路径的**语义诊断**：这一轮到底走了哪条路。
   * `perPath` 是模式/原因的去重计数，`perQuery` 是每条的原始字段，
   * `providerStatus` 是三条路径跑完后引擎自己的 `status()`（不发新请求，读的是探测缓存）。
   * 「请求真的进了 provider」的判据 = `perPath.H1` 里出现 `mode=hybrid` 且 `providerCalls > 0`。
   */
  diagnostics: {
    perPath: {
      L: tallyOf(L.rows),
      H2: tallyOf(H2.rows),
      ...(H1 ? { H1: tallyOf(H1.rows) } : {}),
    },
    perQuery: semanticDiagnostics,
    providerStatus: {
      L: { configured: false, available: null, reason: null, note: '词法路径不装语义引擎（一次调用都不发）' },
      H2: deadEngine.status(),
      H1: h1Engine ? h1Engine.status() : null,
    },
  },
  checks,
  passed: checks.every((c) => c.ok),
  // 这两行是**结论**，别读成修辞。
  mechanismEvidence: 'measured (lexical baseline on the real workspace + fallback identity)',
  valueEvidence: H1 ? `measured on ${QUERIES.length} queries with ${provider.model} (small sample, not a benchmark)` : 'pending (no provider)',
}
console.log(`\nJSON ${JSON.stringify(json)}`)

// `--verify` 只核对标注；其余情况按断言结果给退出码。
process.exitCode = VERIFY_ONLY
  ? (labelProblems.length === 0 ? 0 : 1)
  : (checks.every((c) => c.ok) ? 0 : 1)
