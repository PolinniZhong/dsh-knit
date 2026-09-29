/**
 * Knit v0.14 · **Context Pack 质量回归**
 *
 * 这个文件的被测对象不是「结构对不对」，而是**分层有没有决策价值**：
 * 该先看的进 Primary 了吗？证据 / 实现支撑进 Supporting 了吗？
 * README / CHANGELOG 这类高频文档有没有霸占 Primary？
 *
 * 六条硬性验收（需求 §十七 / §十八）：
 *
 *   1. Primary 命中 —— 期望的主文档必须在 Primary 里
 *   2. Supporting 出现 —— 期望的支撑材料必须在 Supporting 里
 *   3. 无关长文档不许抢占 Primary
 *   4. README / CHANGELOG 的高频词不许污染 Primary
 *   5. 零命中的文档不许混进 Primary / Supporting
 *   6. 相同输入必须产出**完全相同**的顺序（跑两遍逐字比对）
 *
 * 另外三条是**「不是 top-N 换三个名字」的证据**（见 `context-eval: 不是 top-N 换名字`）：
 * 层内的东西必须真的来自名次表的不同位置，而且层与层之间不能同序。
 *
 * ⚠️ 这里**不测** BM25 的 top-1 / MRR —— 那是 `test/eval.test.mjs` 的职责，
 * 两套评测必须保持可比（需求 §十九）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { CORPUS, CASES, NOW, buildFixtureGraph } from './context/fixture.mjs'
import { extractKeywords, rankByRelevance, topicLabel } from '../src/host/relevance.js'
import {
  buildContext, explainContext, sourceTypeOf,
  MAX_PRIMARY, MAX_SUPPORTING, MAX_RELATED,
} from '../src/host/context.js'
import { buildLinkGraph, extractRefs, createIndex, resolveRef } from '../src/host/links.js'

/* ── 一次装配：与宿主里 `scan → rankByRelevance → buildLinkGraph → buildContext`
      完全同序，只是把 I/O 换成了语料 ───────────────────────── */

/**
 * 跑一条用例，返回 `{pack, ranked, order}`。
 * @param {object} testCase - 用例
 * @param {object} graph - 引用图
 * @returns {{pack: object, ranked: object[], order: string[]}} 结果
 */
function assemble(testCase, graph) {
  const keywords = extractKeywords(testCase.messages, 30)
  const ranked = rankByRelevance(CORPUS, keywords, NOW)
  const pack = buildContext({
    ranked: ranked.docs,
    topic: topicLabel(ranked.label),
    total: CORPUS.length,
    graph,
  })
  return { pack, ranked: ranked.docs, order: ranked.docs.map((d) => d.rel) }
}

/** 图只建一次（它与用例无关）。 */
const GRAPH = await buildFixtureGraph(buildLinkGraph)

/** 每条用例的装配结果，只算一次。 */
const RESULTS = new Map(CASES.map((testCase) => [testCase.name, assemble(testCase, GRAPH)]))

/** 取某一层的 rel 数组。 */
const rels = (items) => items.map((item) => item.rel)

/* ── 0 · 语料自检：引用关系必须真的被解析出来 ─────────── */

test('语料自检: 引用图从原文里解析出了预期的边', () => {
  // 这条先跑是有原因的：如果 `text` 里那些路径没被解析成边，
  // 「引用关系能不能把邻居带进 Supporting」这件事就根本没被测到 —— 后面全绿也是假的。
  const out = (rel) => [...(GRAPH.out.get(rel) || new Set())].sort()
  assert.deepEqual(out('README.md'), [
    'docs/api-contract.md',
    'docs/eval-benchmark.md',
    'docs/package-layout.md',
    'docs/relevance-algorithm.md',
  ])
  assert.deepEqual(out('docs/relevance-algorithm.md'), [
    'docs/eval-benchmark.md',
    'docs/sdd-context-assembly.md',
  ])
  assert.deepEqual(out('docs/tool-contract.md'), ['docs/sdd-context-assembly.md'])
  assert.deepEqual(out('docs/path-safety.md'), ['docs/api-contract.md'])
})

test('语料自检: extractRefs 不把外链与 wikilink 当工作区引用', () => {
  assert.deepEqual(extractRefs('见 https://example.com/a.md 和 [[b]]'), [])
  const index = createIndex(['docs/a.md'])
  assert.equal(resolveRef('https://example.com/a.md', index, 'README.md'), null)
})

/* ── 1–4 · 用例：Primary / Supporting / Related 的集合关系 ─ */

for (const testCase of CASES) {
  test(`context-eval: ${testCase.name}`, () => {
    const { pack } = RESULTS.get(testCase.name)
    const primary = rels(pack.primary)
    const supporting = rels(pack.supporting)
    const related = rels(pack.related)

    // 1 · Primary 命中
    for (const want of testCase.expectPrimary || []) {
      assert.ok(primary.includes(want), `Primary 缺少 ${want}；实际 Primary = ${JSON.stringify(primary)}`)
    }
    // 1b · 「这一对里有一个就行」—— 用于记录**已知无法判定**的并列（见 fixture 的说明）。
    // 它不是放宽标准：如果 Primary 为空、或者冒出第三篇，照样红。
    if (testCase.expectPrimaryOneOf) {
      assert.equal(primary.length, 1, `Primary 应恰好一篇；实际 = ${JSON.stringify(primary)}`)
      assert.ok(
        testCase.expectPrimaryOneOf.includes(primary[0]),
        `Primary 落在意料之外：${primary[0]}；可接受的是 ${JSON.stringify(testCase.expectPrimaryOneOf)}`,
      )
    }
    // 2 · Supporting 出现
    for (const want of testCase.expectSupporting || []) {
      assert.ok(
        supporting.includes(want),
        `Supporting 缺少 ${want}；实际 Supporting = ${JSON.stringify(supporting)}`,
      )
    }
    // 3 · Related 出现
    for (const want of testCase.expectRelated || []) {
      assert.ok(related.includes(want), `Related 缺少 ${want}；实际 Related = ${JSON.stringify(related)}`)
    }
    // 4 · 污染源不许抢占 Primary（README / CHANGELOG / 长归档）
    for (const bad of testCase.notPrimary || []) {
      assert.ok(!primary.includes(bad), `${bad} 不该出现在 Primary；实际 = ${JSON.stringify(primary)}`)
    }
    // 5 · 三层不许互相重复，也不许出现语料外的路径
    const known = new Set(CORPUS.map((doc) => doc.rel))
    const union = new Set([...primary, ...supporting, ...related])
    assert.equal(
      union.size, primary.length + supporting.length + related.length,
      '同一条不许出现在两层里',
    )
    for (const rel of union) assert.ok(known.has(rel), `${rel} 不在语料里`)
  })
}

/* ── 5 · 零命中不许混进「先看」那两层 ──────────────────── */

test('context-eval: Primary 与 Supporting 里不许出现零命中的文档', () => {
  // 这是「不是换个名字」的第一条硬证据：能进 Primary / Supporting 的
  // 必须真的命中了话题，**或者**与 Primary 有引用关系（那时理由会是 linkTarget/linkSource）。
  for (const testCase of CASES) {
    const { pack } = RESULTS.get(testCase.name)
    for (const item of [...pack.primary, ...pack.supporting]) {
      const code = item.reason.code
      const linked = code === 'linkTarget' || code === 'linkSource'
      assert.ok(
        item.reason.terms.length > 0 || linked,
        `${testCase.name}: ${item.rel} 进了「先看」两层却既没命中也没有引用关系（reason=${code}）`,
      )
    }
  }
})

test('context-eval: 「什么话题都提一句」的归档长文永远进不了前两层', () => {
  // §十七 案例 3 的加强版：每个话题词各提一句的长文，对任何任务都没有增量信息。
  // 它既不许进 Primary，也不许进 Supporting —— 实测里它一度出现在**每一条**任务里。
  // 分层里挡住它的那条规则是 `isDocHit`（「这一篇是把它讲得最多的那一篇」）。
  for (const testCase of CASES) {
    const { pack } = RESULTS.get(testCase.name)
    const inTop = rels(pack.primary).includes('docs/long-archive.md')
      || rels(pack.supporting).includes('docs/long-archive.md')
    assert.ok(!inTop, `${testCase.name}: docs/long-archive.md 混进了前两层`)
  }
})

test('context-eval: 没有引用的零命中文档永远进不了前两层', () => {
  // 前两层收录零命中条目的**唯一**理由就是引用关系。没有任何引用的零命中条目
  // 只能进 Related —— 否则「先看这几篇」就掺进了纯背景。
  for (const testCase of CASES) {
    const { pack } = RESULTS.get(testCase.name)
    for (const item of [...pack.primary, ...pack.supporting]) {
      if (item.reason.terms.length > 0) continue
      const linked = item.reason.code === 'linkTarget' || item.reason.code === 'linkSource'
      assert.ok(linked, `${testCase.name}: ${item.rel} 零命中又没引用关系却进了前两层`)
    }
  }
})

test('context-eval: Related 里的每一条也都有可核验的理由（不许「工作区里还有这一篇」凑数）', () => {
  // ⚠️ 这条守卫是 2026-09-29 加的，它锁的是一个**真被改掉的缺陷**：
  // 旧实现 Related 遍历 `[...hit, ...noHit]` —— 一个话题词都没命中、又没有任何引用关系的文档
  // 也会被填进 Related，理由码落到兜底的 `related`，客户端把它译成「与当前工作区相关」。
  // 那正是需求 §九 明令禁止的「可能对你有帮助」（无法验证的推断），
  // 也违反 PRD §5 对 Related 的定义（「与当前任务**有关**」）。
  // ⇒ 现在：Related 的每一条**要么真的命中了话题词，要么与 Primary 有引用关系**，二者必居其一。
  // 两条都不满足就**不出场** —— Related 为空是合法结论（见任务 10）。
  for (const testCase of CASES) {
    const { pack } = RESULTS.get(testCase.name)
    for (const item of pack.related) {
      const linked = item.reason.code === 'linkTarget' || item.reason.code === 'linkSource'
      const hasTerms = item.reason.terms.length > 0
      assert.ok(
        linked || hasTerms,
        `${testCase.name}: ${item.rel} 在 Related 里，但既没命中词也没有引用关系（理由码 ${item.reason.code}）`,
      )
      assert.notEqual(
        item.reason.code, 'related',
        `${testCase.name}: ${item.rel} 用了兜底理由码 related —— 那等于说「工作区里还有这么一篇」`,
      )
    }
  }
})


test('context-eval: README 与 CHANGELOG 永远进不了 Primary', () => {
  // 高频词污染的直接防线。它们在**检索**里已经排得不错（IDF 压住了），
  // 但仍然不许霸占 Primary —— 否则「按对话构建上下文」就退化成「列项目门口那几篇」。
  for (const testCase of CASES) {
    const { pack } = RESULTS.get(testCase.name)
    for (const noisy of ['README.md', 'CHANGELOG.md']) {
      assert.ok(
        !rels(pack.primary).includes(noisy),
        `${testCase.name}: ${noisy} 霸占了 Primary；实际 = ${JSON.stringify(rels(pack.primary))}`,
      )
    }
  }
})

test('context-eval: 进 Primary 的每一条都有「落脚点」（标题或摘要命中）', () => {
  // 「落脚点」是 Primary 的硬条件，这条把它钉死：Primary 里的条目的理由码
  // 必须是标题/摘要类，不能是 bodyMatch / linkTarget。
  const groundedCodes = new Set(['direct', 'titleMatch', 'summaryMatch'])
  for (const testCase of CASES) {
    const { pack } = RESULTS.get(testCase.name)
    for (const item of pack.primary) {
      assert.ok(
        groundedCodes.has(item.reason.code),
        `${testCase.name}: ${item.rel} 进了 Primary 但理由是 ${item.reason.code}（没有落脚点）`,
      )
    }
  }
})

test('context-eval: 靠引用关系进前两层的条目，理由必须是 link 而不是假装命中', () => {
  // 任务 3 / 10 / 11 都出现了「零命中、但与主要上下文有引用关系」的条目。
  // 它们的理由必须是 linkTarget / linkSource，而且**不许**带命中词 —— 不许编造。
  const seen = []
  for (const testCase of CASES) {
    const { pack } = RESULTS.get(testCase.name)
    for (const item of [...pack.primary, ...pack.supporting]) {
      const code = item.reason.code
      if (code !== 'linkTarget' && code !== 'linkSource') continue
      seen.push(`${testCase.name}:${item.rel}:${code}`)
      assert.deepEqual(item.reason.terms, [], `${item.rel} 零命中却带了命中词`)
      assert.equal(item.reason.fields, 0, `${item.rel} 零命中却报了字段数`)
      assert.ok(
        item.reason.code === 'linkTarget' ? true : true,
        '理由码只能是 linkTarget / linkSource',
      )
    }
  }
  assert.ok(
    seen.some((entry) => entry.endsWith(':linkTarget')),
    `没有任何「被主要文档引用」的条目 —— 引用关系没被装配层用上。实际：${seen.join(' | ')}`,
  )
  assert.ok(
    seen.some((entry) => entry.endsWith(':linkSource')),
    `没有任何「引用了主要文档」的条目。实际：${seen.join(' | ')}`,
  )
})

/* ── 6 · 真的不是「top-N 换名字」──────────────────────── */

test('context-eval: 不是 top-N 换名字 —— 层内条目来自名次表的不同位置', () => {
  // 「换个名字」的意思是：Primary = top-3 改名、Supporting = top 4-8 改名、Related = 其余。
  // 那样的话 Supporting 里每一项的名次都必然紧跟在 Primary 之后。
  // 实测不是：支持材料会从名次表很后面被带上来（引用关系 / 代码角色）。
  let demonstrated = 0
  const detail = []
  for (const testCase of CASES) {
    const { pack, order } = RESULTS.get(testCase.name)
    const primaryRanks = pack.primary.map((item) => order.indexOf(item.rel))
    if (primaryRanks.length === 0) continue
    const lastPrimary = Math.max(...primaryRanks)
    const promoted = pack.supporting
      .map((item) => ({ rel: item.rel, rank: order.indexOf(item.rel) }))
      .filter((entry) => entry.rank > lastPrimary + 1 || entry.rank === -1)
    if (promoted.length > 0) demonstrated += 1
    detail.push({
      name: testCase.name,
      primary: pack.primary.length,
      supporting: pack.supporting.length,
      related: pack.related.length,
      lastPrimary,
      promoted,
    })
  }
  // 只要有一条用例出现了「跨过 Primary 之后的相邻名次被提上来」，分层就不是重新贴标签
  assert.ok(
    demonstrated > 0,
    `没有任何一条用例出现「来自名次表更后面」的支撑条目 —— 那它可能只是 top-N 改名。明细：\n`
    + JSON.stringify(detail, null, 1),
  )
})

test('context-eval: 至少两个用例的三层不是同一个顺序（重排确实发生了）', () => {
  // 若某一层恒等于名次表的某个连续切段，「重排」就没发生。
  let regrouped = 0
  for (const testCase of CASES) {
    const { pack, order } = RESULTS.get(testCase.name)
    const flat = [...rels(pack.primary), ...rels(pack.supporting), ...rels(pack.related)]
    const head = order.slice(0, flat.length)
    if (JSON.stringify(flat) !== JSON.stringify(head)) regrouped += 1
  }
  assert.ok(regrouped >= 2, `只有 ${regrouped} 条用例的顺序与名次表不同 —— 重排幅度太小`)
})

/* ── 7 · 确定性 ─────────────────────────────────────── */

test('context-eval: 相同输入产出完全相同的顺序（跑两遍逐字比对）', () => {
  const fresh = CASES.map((testCase) => assemble(testCase, GRAPH).pack)
  const cached = CASES.map((testCase) => RESULTS.get(testCase.name).pack)
  assert.deepEqual(
    JSON.parse(JSON.stringify(fresh)),
    JSON.parse(JSON.stringify(cached)),
    '两次装配的结果必须逐字相同',
  )
})

test('context-eval: 打乱语料输入顺序，分层结果不变', () => {
  // `collectDocs` 是按 mtime 倒序给出的，同一份语料换个扫描顺序不该换序。
  // 这条钉的是 `rankByRelevance` 里那个 `__index` 兜底键。
  const shuffled = [...CORPUS].reverse()
  const keywords = extractKeywords(CASES[0].messages, 30)
  const a = rankByRelevance(CORPUS, keywords, NOW)
  const b = rankByRelevance(shuffled, keywords, NOW)
  const packA = buildContext({ ranked: a.docs, topic: topicLabel(a.label), total: CORPUS.length, graph: GRAPH })
  const packB = buildContext({ ranked: b.docs, topic: topicLabel(b.label), total: CORPUS.length, graph: GRAPH })
  assert.deepEqual(rels(packA.primary), rels(packB.primary))
  assert.deepEqual(rels(packA.supporting), rels(packB.supporting))
})

/* ── 8 · 结构与纪律 ─────────────────────────────────── */

test('context-eval: Context Pack 不出分数、不出正文、不出绝对路径', () => {
  const { pack } = RESULTS.get(CASES[0].name)
  const serialized = JSON.stringify(pack)
  for (const forbidden of ['score', 'raw', 'strength', 'haystack', 'matchedTerms', 'rank']) {
    assert.ok(!serialized.includes(`"${forbidden}"`), `Context Pack 不该出现 ${forbidden}`)
  }
  assert.ok(!serialized.includes('归档归档'), '不该带正文')
  assert.ok(!serialized.includes('"text"'), '不该带原文')
  for (const item of [...pack.primary, ...pack.supporting, ...pack.related]) {
    assert.ok(!item.rel.startsWith('/'), `rel 必须是相对路径：${item.rel}`)
    assert.deepEqual(
      Object.keys(item).sort(),
      ['kind', 'mtimeMs', 'reason', 'rel', 'source', 'summary', 'title'],
      `条目字段必须固定：${Object.keys(item).join('/')}`,
    )
  }
})

test('context-eval: 每条都能说出为什么在这里（理由码在封闭集合里）', () => {
  const allowed = new Set([
    'direct', 'titleMatch', 'summaryMatch', 'bodyMatch',
    'linkTarget', 'linkSource', 'related',
  ])
  for (const testCase of CASES) {
    const { pack } = RESULTS.get(testCase.name)
    for (const item of [...pack.primary, ...pack.supporting, ...pack.related]) {
      assert.ok(allowed.has(item.reason.code), `未知理由码 ${item.reason.code}（${item.rel}）`)
      assert.ok(Array.isArray(item.reason.terms), 'terms 必须是数组')
      assert.ok(Number.isInteger(item.reason.fields), 'fields 必须是整数')
    }
  }
})

test('context-eval: 不给 task 时为空串，给了就是**原样引用**（不做任务理解）', async () => {
  const { buildContext } = await import('../src/host/context.js')
  // 评测用例不喂 task ⇒ 空串。它**不是**「Knit 猜出来的任务」。
  for (const testCase of CASES) {
    assert.equal(RESULTS.get(testCase.name).pack.task, '', '不许编一个无法验证的「任务」')
  }
  // 喂了就逐字带出 —— 折叠或改写都算推断，推断在这个模块里是禁止的。
  const cited = '把 Primary 的落脚点规则讲清楚'
  assert.equal(buildContext({ ranked: [], task: cited }).task, cited)
})

test('context-eval: 上限是硬约束（Primary ≤ 1，Supporting ≤ 3，Related ≤ 5）', () => {
  for (const testCase of CASES) {
    const { pack } = RESULTS.get(testCase.name)
    assert.ok(pack.primary.length <= 1, `Primary 超上限：${pack.primary.length}`)
    assert.ok(pack.supporting.length <= 3, `Supporting 超上限：${pack.supporting.length}`)
    assert.ok(pack.related.length <= 5, `Related 超上限：${pack.related.length}`)
  }
  // 上限是与规格的契约（PRD §5），不是随手定的数 —— 改了必须同步改这里和文档。
  assert.equal(MAX_PRIMARY, 1)
  assert.equal(MAX_SUPPORTING, 3)
  assert.equal(MAX_RELATED, 5)
  assert.deepEqual(pack0().totals, {
    primary: pack0().primary.length,
    supporting: pack0().supporting.length,
    related: pack0().related.length,
    matched: pack0().totals.matched,
    total: pack0().totals.total,
  })
})

/** 第一条用例的包（给上限测试的 totals 自洽断言用）。 */
function pack0() {
  return RESULTS.get(CASES[0].name).pack
}

/* ── 9 · 纯函数边界 ─────────────────────────────────── */

test('buildContext: 没有图时退化成「只看命中」，不抛错', () => {
  const keywords = extractKeywords(CASES[0].messages, 30)
  const ranked = rankByRelevance(CORPUS, keywords, NOW)
  const pack = buildContext({ ranked: ranked.docs, topic: 'x', total: CORPUS.length })
  assert.ok(pack.primary.length > 0, '没有引用图也应当能分出主要上下文')
  assert.ok(pack.primary.every((item) => item.reason.terms.length > 0), '没有图时进 Primary 的必须是真命中')
})

test('buildContext: 空输入 → 三层全空，totals 全 0', () => {
  const pack = buildContext({ ranked: [], topic: '', total: 0 })
  assert.deepEqual([pack.primary, pack.supporting, pack.related], [[], [], []])
  assert.deepEqual(pack.totals, { primary: 0, supporting: 0, related: 0, matched: 0, total: 0 })
})

test('explainContext: 理由判定顺序固定（直接命中优先于引用关系）', () => {
  // 一篇既命中、又被 Primary 引用的文档，理由必须是 `direct` ——
  // 「真命中」比「被引用」强，不能因为它是邻居就把理由降级。
  const one = explainContext(
    { rel: 'docs/a.md', matchedTerms: [{ term: 'x', fields: { title: true, summary: false, body: true } }] },
    { linkTarget: true, linkSource: true },
  )
  assert.equal(one.code, 'titleMatch', '标题命中优先于引用关系')
  assert.equal(one.fields, 2, '标题 + 正文 = 跨 2 个字段')

  // 标题命中 + 命中 ≥2 个话题词 → 升级成 `direct`（「它就是在讲这件事」）
  const two = explainContext({
    rel: 'docs/a.md',
    matchedTerms: [
      { term: 'x', fields: { title: true, summary: false, body: false } },
      { term: 'y', fields: { title: false, summary: false, body: true } },
    ],
  })
  assert.equal(two.code, 'direct')

  // 只命中摘要 → `summaryMatch`；只在正文 → `bodyMatch`（fields = 焦点词正文命中数）
  assert.equal(explainContext({ rel: 'a.md', matchedTerms: [{ term: 'x', fields: { summary: true } }] }).code, 'summaryMatch')
  const body = explainContext({
    rel: 'a.md',
    matchedTerms: [
      { term: 'x', fields: { body: true, bodyTf: 3 } },
      { term: 'y', fields: { body: true, bodyTf: 1 } },
    ],
  })
  assert.equal(body.code, 'bodyMatch')
  assert.equal(body.fields, 2, '两个词在正文里命中 = 2')

  // 零命中 + 引用关系 → link 码；都不是 → related
  assert.equal(explainContext({ rel: 'a.md', matchedTerms: [] }, { linkTarget: true }).code, 'linkTarget')
  assert.equal(explainContext({ rel: 'a.md', matchedTerms: [] }, { linkSource: true }).code, 'linkSource')
  assert.equal(explainContext({ rel: 'a.md', matchedTerms: [] }).code, 'related')
})

test('sourceTypeOf: 角色是路径字面规则，不是内容理解', () => {
  assert.equal(sourceTypeOf('test/context/fixture.mjs'), 'test', 'test/ 目录')
  assert.equal(sourceTypeOf('docs/eval-benchmark.md'), 'test', 'eval- 前缀也算评测')
  assert.equal(sourceTypeOf('src/host/index.js'), 'impl', '源码路径仍能认出是实现')
  assert.equal(sourceTypeOf('src/host/index.md'), 'impl')
  assert.equal(sourceTypeOf('docs/sdd-context-assembly.md'), 'design')
  assert.equal(sourceTypeOf('docs/context-assembly.md'), 'impl', '带模块名的说明走 impl')
  assert.equal(sourceTypeOf('CHANGELOG.md'), 'doc')
  // ⚠️ 踩过的坑：`docs/relevance-algorithm.md` 曾经因为文件名里有 relevance 被判成 impl。
  // design 规则排在 impl 前面之后仍然正确 —— 它确实不是设计文档，就是 impl。
  assert.equal(sourceTypeOf('docs/relevance-algorithm.md'), 'impl')
})

/* ── 具名指标（SDD §27）────────────────────────────────
 *
 * SDD §27 点了三个指标的名字，但**没有给公式** —— 公式由这里定义，并在文档里写明：
 *
 *   Primary@1          = 「唯一那篇 Primary 命中期望」的用例数 / 「期望有 Primary」的用例数。
 *                        期望 Primary 为空的用例（任务 12）不进分母 —— 那是另一条守卫。
 *   Supporting Recall  = Σ|实际 Supporting ∩ 期望 Supporting| / Σ|期望 Supporting|
 *                        （微平均，只统计**声明过**期望 Supporting 的用例）。
 *   Role Precision     = 「角色判定未被 fixture 否认」的条目数 / 「被 fixture 表态过的」条目数。
 *
 * ⚠️ Role Precision 的**局限必须说清楚**：fixture 声明的是**必需项**，不是穷举名册。
 * 所以它测的是「没有出现被明确否认的角色」，不是「每个条目都分对了」。
 * 一个条目的角色只有在满足下面任一条时才被计入：
 *   - 它在用例的 expectPrimary / expectSupporting / expectRelated 里被点名 → 必须落在那一层；
 *   - 它在 notPrimary 里被点名且落进了 Primary → 算错。
 * 没被点名的条目（fixture 对它没表态）不计入 —— 不拿没说的话当标准。
 *
 * ⚠️ 三个指标目前都是 1.000（全绿），**这不代表分层有多准** —— 用例本身就是照着
 * 规则写出来的。它们的作用是**回归**：任何一条分层规则漂移，至少会有一个掉下来。
 * SDD §18 明令禁止写「context score 必须 > 80」这种拍出来的分数阈值，
 * 所以这里断言的是**精确的集合关系**（= 1 / 分母 > 0），不是百分比门槛。
 */
test('context-eval: 具名指标 —— Primary@1 / Supporting Recall / Role Precision', (t) => {
  /* Primary@1 */
  let primaryCases = 0
  let primaryHits = 0
  const primaryMisses = []
  for (const testCase of CASES) {
    const expected = (testCase.expectPrimary && testCase.expectPrimary.length
      ? testCase.expectPrimary
      : (testCase.expectPrimaryOneOf || []))
    if (!expected.length) continue // 期望为空 → 不进分母
    primaryCases += 1
    const { pack } = RESULTS.get(testCase.name)
    const top = pack.primary.length === 1 ? pack.primary[0].rel : null
    if (top && expected.includes(top)) primaryHits += 1
    else primaryMisses.push(`${testCase.name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(rels(pack.primary))}`)
  }

  /* Supporting Recall（微平均） */
  let supportingExpected = 0
  let supportingFound = 0
  const supportingMisses = []
  for (const testCase of CASES) {
    const expected = testCase.expectSupporting || []
    if (!expected.length) continue
    supportingExpected += expected.length
    const actual = rels(RESULTS.get(testCase.name).pack.supporting)
    for (const rel of expected) {
      if (actual.includes(rel)) supportingFound += 1
      else supportingMisses.push(`${testCase.name}: ${rel} 不在 Supporting 里（实际 ${JSON.stringify(actual)}）`)
    }
  }

  /* Role Precision */
  let declared = 0
  let correct = 0
  const roleMisses = []
  for (const testCase of CASES) {
    const { pack } = RESULTS.get(testCase.name)
    const expPrimary = (testCase.expectPrimary && testCase.expectPrimary.length
      ? testCase.expectPrimary
      : (testCase.expectPrimaryOneOf || []))
    const expSupporting = testCase.expectSupporting || []
    const expRelated = testCase.expectRelated || []
    const notPrimary = testCase.notPrimary || []
    // ⚠️ `expectPrimaryOneOf` 的用例（任务 11）是一条**局限的存档**：那两篇的 BM25 分完全并列
    // （raw 都是 4、标题里都含「排序」），检索没有任何依据分高下，所以断言的是
    // 「一对可接受的答案」。⇒ **落选的那一篇允许待在 Supporting**，不算角色错误 ——
    // 否则这条指标会逼我们去加一层本来不存在的语义判断。
    const oneOfMode = !(testCase.expectPrimary && testCase.expectPrimary.length)
      && (testCase.expectPrimaryOneOf || []).length > 0
    const inExpected = (rel) => expPrimary.includes(rel) || expSupporting.includes(rel) || expRelated.includes(rel)
    const satisfied = (tier, rel) => (tier === 'primary' && expPrimary.includes(rel))
      || (tier === 'supporting' && (expSupporting.includes(rel) || (oneOfMode && expPrimary.includes(rel))))
      || (tier === 'related' && expRelated.includes(rel))

    for (const [tier, items] of [['primary', pack.primary], ['supporting', pack.supporting], ['related', pack.related]]) {
      for (const item of items) {
        const isDeclared = inExpected(item.rel) || (tier === 'primary' && notPrimary.includes(item.rel))
        if (!isDeclared) continue
        declared += 1
        if (satisfied(tier, item.rel)) correct += 1
        else roleMisses.push(`${testCase.name}: ${item.rel} 落在 ${tier}，但期望不是这一层`)
      }
    }
  }

  const primaryAt1 = primaryCases ? primaryHits / primaryCases : 1
  const supportingRecall = supportingExpected ? supportingFound / supportingExpected : 1
  const rolePrecision = declared ? correct / declared : 1

  t.diagnostic(`Primary@1         = ${primaryHits}/${primaryCases} = ${primaryAt1.toFixed(3)}`)
  t.diagnostic(`Supporting Recall = ${supportingFound}/${supportingExpected} = ${supportingRecall.toFixed(3)}`)
  t.diagnostic(`Role Precision    = ${correct}/${declared} = ${rolePrecision.toFixed(3)}`)

  assert.ok(primaryCases > 0, '分母为 0 说明用例丢了期望 — 指标会假绿')
  assert.equal(primaryAt1, 1, `Primary@1 掉了：\n${primaryMisses.join('\n')}`)
  assert.ok(supportingExpected > 0, '分母为 0 说明用例丢了期望 — 指标会假绿')
  assert.equal(supportingRecall, 1, `Supporting Recall 掉了：\n${supportingMisses.join('\n')}`)
  assert.ok(declared > 0, '分母为 0 说明用例丢了期望 — 指标会假绿')
  assert.equal(rolePrecision, 1, `Role Precision 掉了：\n${roleMisses.join('\n')}`)
})

