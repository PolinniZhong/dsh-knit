/**
 * Knit v0.14 · **Context Assembly 单元测试**（SDD §25 的八组）
 *
 * 与 `test/context-eval.test.mjs` 的分工：
 *
 *   - **本文件**用手写输入测 `buildContext()` / `explainContext()` / `sourceTypeOf()`
 *     的**规则本身**：哪条规则在什么条件下触发、触发了给什么理由、上限怎么截断。
 *     输入是构造出来的，所以每条断言都能指到具体那一行规则。
 *   - **`context-eval.test.mjs`** 用 24 篇真实语料 + 12 条任务型查询测
 *     **分层有没有决策价值**（P@1 / Supporting 召回 / 角色正确性 / 确定性）。
 *
 * SDD §25 要求的八组，逐条对上：
 *
 *   1. Primary        —— 最相关那篇进 Primary
 *   2. No relevance   —— 没有任何关键词 → Primary 为空（**不是**退化成「列出最近的」）
 *   3. Supporting     —— 有证据关系的进 Supporting
 *   4. Related        —— 弱但有据的进 Related
 *   5. Dedup          —— 同一篇只能有一个角色
 *   6. Determinism    —— 同一输入 → 逐字相同输出
 *   7. Why            —— 每个角色都带一个确定性的、可核验的理由
 *   8. Limits         —— primary ≤ 1 / supporting ≤ 3 / related ≤ 5
 *
 * ⚠️ 这里**不碰** BM25 的 top-1 / MRR —— 那是 `test/eval.test.mjs` 的职责，
 * 两套评测必须保持可比（需求 §十九）。本文件一次都不调 `rankByRelevance()`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildContext, explainContext, sourceTypeOf,
  MAX_PRIMARY, MAX_SUPPORTING, MAX_RELATED,
} from '../src/host/context.js'

/* ── 构造工具 ─────────────────────────────────────────── */

/**
 * 造一条「已经排好序」的检索结果。
 *
 * `raw` 是 BM25 分数（只用来判 Primary 的强度带宽）；
 * `terms` 是 `matchedTerms` 形状 `[{term, fields:{title?, summary?, body?, bodyTf?}}]`。
 *
 * @param {string} rel - 相对路径
 * @param {number} raw - BM25 分数
 * @param {Array<object>} [terms] - 命中词
 * @param {object} [extra] - 覆盖 `title` / `summary` / `mtimeMs`
 * @returns {object} 假的 ranked 条目
 */
function doc(rel, raw, terms = [], extra = {}) {
  return {
    rel,
    title: extra.title === undefined ? rel : extra.title,
    summary: extra.summary === undefined ? '' : extra.summary,
    mtimeMs: extra.mtimeMs === undefined ? 0 : extra.mtimeMs,
    kind: 'md',
    raw,
    matchedTerms: terms,
  }
}

/** 某词的字段位图。 */
const hit = (term, fields) => ({ term, fields })

/** 造一张引用图（`{out, in}` 两个 Map）。 */
function graphOf(out = {}, into = {}) {
  const toMap = (obj) => new Map(
    Object.entries(obj).map(([rel, targets]) => [rel, new Set(targets)]),
  )
  return { out: toMap(out), in: toMap(into) }
}

/** 装配的一行简写。 */
const assemble = (ranked, extra = {}) => buildContext({ ranked, ...extra })

/** 取某一层的 rel。 */
const rels = (items) => items.map((item) => item.rel)

/* ── 1 · Primary ─────────────────────────────────────── */

test('context: Primary —— 最相关且「有落脚点」的那篇进 Primary', () => {
  // 落脚点 = 话题词命中**标题或摘要**。这是「这篇就是在讲这件事」的作者信号。
  const pack = assemble([
    doc('docs/algo.md', 30, [hit('bm25', { title: true, body: true, bodyTf: 3 })]),
    doc('docs/other.md', 10, [hit('bm25', { body: true, bodyTf: 1 })]),
  ], { topic: 'bm25 / 排序' })

  assert.deepEqual(rels(pack.primary), ['docs/algo.md'])
  assert.equal(pack.primary[0].reason.code, 'titleMatch')
  assert.deepEqual(pack.primary[0].reason.terms, ['bm25'])
  assert.equal(pack.mode, 'relevance')
  assert.equal(pack.topic, 'bm25 / 排序')
})

test('context: Primary —— 标题命中且命中词不止一个时理由升级成 direct', () => {
  const pack = assemble([
    doc('docs/algo.md', 30, [
      hit('bm25', { title: true, body: true, bodyTf: 3 }),
      hit('idf', { title: true, body: true, bodyTf: 2 }),
    ]),
  ])
  assert.equal(pack.primary[0].reason.code, 'direct')
})

test('context: Primary —— 强度带宽不够的排在后面（不许「矮子里拔将军」）', () => {
  // `PRIMARY_MIN_SHARE = 0.3`：raw 只有榜首 30% 以下的，即使有落脚点也不算「最直接相关」。
  const pack = assemble([
    doc('docs/head.md', 100, [hit('alpha', { summary: true })]),
    doc('docs/faint.md', 10, [hit('beta', { title: true })]),
  ])
  assert.deepEqual(rels(pack.primary), ['docs/head.md'])
  assert.ok(rels(pack.related).includes('docs/faint.md'), '带宽不够的应当退到 Related，而不是消失')
})

test('context: Primary —— 榜首没有落脚点时，让位给下一篇够格的（而不是空手）', () => {
  // PRD §5 字面写的是 `rankedDocs[0]`。本实现在**榜首本身就是污染源**时分叉：
  // README / 「什么话题都提一句」的长文名次再高也不当主文档，后面那篇真正在讲的顶上。
  const pack = assemble([
    doc('README.md', 40, [hit('alpha', { body: true, bodyTf: 2 })]),
    doc('docs/real.md', 34, [hit('alpha', { title: true })]),
  ])
  assert.deepEqual(rels(pack.primary), ['docs/real.md'])
})

/* ── 2 · No relevance ────────────────────────────────── */

test('context: 没有关键词 —— Primary 为空，而且**不硬凑**', () => {
  // 关键：什么都不该进 Primary。空是正确答案，不是失败 ——
  // 兜底到「最近改动的几篇」等于把 Context Pack 退回普通文件列表。
  const pack = assemble([
    doc('a.md', 0), doc('b.md', 0), doc('c.md', 0),
  ], { topic: '', total: 3 })

  assert.deepEqual(pack.primary, [])
  assert.deepEqual(pack.supporting, [])
  assert.deepEqual(pack.related, [])
  assert.deepEqual(pack.totals, { primary: 0, supporting: 0, related: 0, matched: 0, total: 3 })
  assert.equal(pack.task, '')
})

test('context: 有分数但一条落脚点都没有 —— Primary 仍然为空', () => {
  // 全批只有正文命中、没有任何一篇把它写进标题/摘要 ⇒ 没有主文档。如实说。
  const pack = assemble([
    doc('a.md', 20, [hit('alpha', { body: true, bodyTf: 1 })]),
    doc('b.md', 12, [hit('alpha', { body: true, bodyTf: 1 })]),
  ])
  assert.deepEqual(pack.primary, [])
})

test('context: 空输入 —— 三层全空、totals 全 0，不抛错', () => {
  const pack = assemble([])
  assert.deepEqual(pack.primary, [])
  assert.deepEqual(pack.totals, { primary: 0, supporting: 0, related: 0, matched: 0, total: 0 })
})

test('context: 不传 ranked —— 与空输入同形，不抛错', () => {
  const pack = buildContext()
  assert.deepEqual(rels(pack.primary), [])
  assert.equal(pack.totals.total, 0)
})

/* ── 3 · Supporting ──────────────────────────────────── */

test('context: Supporting —— 焦点词的「深入命中」抬进 Supporting（不需要落脚点）', () => {
  // `gamma` 在前两篇里都被提到（≥ FOCUS_MIN_DOCS），且 impl.md 是全批正文字频最大的那篇
  // （bodyTf 3 ≥ 其他所有篇）。两个条件同时成立才算「这一篇在讲它」。
  const pack = assemble([
    doc('docs/impl.md', 50, [hit('gamma', { body: true, bodyTf: 3 })]),
    doc('docs/near.md', 20, [hit('gamma', { body: true, bodyTf: 1 })]),
  ])
  assert.deepEqual(pack.primary, [], '没有落脚点 ⇒ 不进 Primary')
  assert.deepEqual(rels(pack.supporting), ['docs/impl.md'])
  assert.equal(pack.supporting[0].reason.code, 'bodyMatch')
  assert.deepEqual(rels(pack.related), ['docs/near.md'], '体频不够的那篇退到 Related')
})

test('context: Supporting —— 「什么话题都提一句」的长文进不了（这是实测定的闸门）', () => {
  // long.md 也提到了 gamma，但它不是讲得最多的那篇 ⇒ 对任何任务都不是支撑。
  // 没有这道闸门时，每个词都提一句的归档长文会出现在**每一条**任务的 Supporting 里。
  const pack = assemble([
    doc('docs/impl.md', 50, [hit('gamma', { body: true, bodyTf: 3 })]),
    doc('docs/long.md', 40, [hit('gamma', { body: true, bodyTf: 1 })]),
  ])
  assert.ok(!rels(pack.supporting).includes('docs/long.md'))
})

test('context: Supporting —— 与 Primary 有引用关系的（含零命中）带进来，理由不伪装成命中', () => {
  const pack = assemble([
    doc('docs/main.md', 30, [hit('alpha', { title: true })]),
    doc('docs/impl.md', 0),
  ], { graph: graphOf({ 'docs/main.md': ['docs/impl.md'] }) })

  assert.deepEqual(rels(pack.primary), ['docs/main.md'])
  assert.deepEqual(rels(pack.supporting), ['docs/impl.md'])
  assert.equal(pack.supporting[0].reason.code, 'linkTarget')
  assert.deepEqual(pack.supporting[0].reason.terms, [],
    '零命中的条目理由里不许有词 —— 那就是假装命中')
})

test('context: Supporting —— 反方向的引用关系给的是 linkSource', () => {
  // 邻居是从 **Primary 那一侧** 看的：`in['docs/main.md']` 里放着 README，
  // 意思是「README 引用了 main」⇒ main 是被引用方，README 给的理由是 linkSource。
  const pack = assemble([
    doc('docs/main.md', 30, [hit('alpha', { title: true })]),
    doc('README.md', 0),
  ], { graph: graphOf({}, { 'docs/main.md': ['README.md'] }) })

  assert.deepEqual(rels(pack.supporting), ['README.md'])
  assert.equal(pack.supporting[0].reason.code, 'linkSource')
})

test('context: Supporting —— 没有 Primary 就没有引用邻居（引用是相对 Primary 说的）', () => {
  const pack = assemble([
    doc('docs/lone.md', 5, [hit('alpha', { body: true, bodyTf: 1 })]),
    doc('docs/neighbour.md', 0),
  ], { graph: graphOf({ 'docs/lone.md': ['docs/neighbour.md'] }) })

  assert.deepEqual(pack.primary, [])
  assert.deepEqual(pack.supporting, [])
  assert.deepEqual(rels(pack.related), ['docs/lone.md'],
    '零命中的邻居不许自己冒出来 —— Related 收紧后它也不出场')
})

test('context: Supporting —— 图里提到、但这一批结果里没有的邻居不硬凑', () => {
  // 被 limit 切掉的文档不在 ranked 里 —— 没有它的 title/summary/mtime，造不出来。
  const pack = assemble([
    doc('docs/main.md', 30, [hit('alpha', { title: true })]),
  ], { graph: graphOf({ 'docs/main.md': ['docs/cut-off.md'], 'docs/cut-off.md': ['docs/main.md'] }) })

  assert.deepEqual(pack.supporting, [])
  assert.ok(!JSON.stringify(pack).includes('cut-off'))
})

test('context: 没有图时退化成「只看命中」，不抛错', () => {
  const pack = assemble([
    doc('docs/main.md', 30, [hit('alpha', { title: true })]),
    doc('docs/other.md', 5, [hit('alpha', { body: true, bodyTf: 1 })]),
  ], { graph: null })
  assert.deepEqual(rels(pack.primary), ['docs/main.md'])
  assert.deepEqual(rels(pack.related), ['docs/other.md'])
})

/* ── 4 · Related ─────────────────────────────────────── */

test('context: Related —— 命中话题但没有落脚点、也不是支撑的，落在 Related', () => {
  const pack = assemble([
    doc('docs/main.md', 30, [hit('alpha', { title: true })]),
    doc('docs/weak.md', 8, [hit('alpha', { body: true, bodyTf: 1 })]),
  ])
  assert.deepEqual(rels(pack.related), ['docs/weak.md'])
  assert.equal(pack.related[0].reason.code, 'bodyMatch')
})

test('context: Related —— 零命中、又没有任何引用关系的文档**不出场**', () => {
  // ⚠️ 锁的是一个真被改掉的缺陷（2026-09-29）：旧实现把 `[...hit, ...noHit]` 都灌进 Related，
  // 于是「工作区里还有这么一篇」也能出场，理由码落到兜底的 `related`，
  // 客户端把它译成「与当前工作区相关」—— 那是需求 §九 明令禁止的无法验证的推断。
  const pack = assemble([
    doc('docs/main.md', 30, [hit('alpha', { title: true })]),
    doc('docs/unrelated.md', 0),
    doc('CHANGELOG.md', 0),
  ])
  assert.deepEqual(rels(pack.related), [])
  assert.ok(!JSON.stringify(pack).includes('unrelated'))
  assert.ok(!JSON.stringify(pack).includes('CHANGELOG'))
})

test('context: Related —— Related 为空是合法结论（不是失败）', () => {
  const pack = assemble([doc('docs/main.md', 30, [hit('alpha', { title: true })])])
  assert.deepEqual(rels(pack.primary), ['docs/main.md'])
  assert.deepEqual(pack.related, [])
  assert.equal(pack.totals.related, 0)
})

/* ── 5 · Dedup ───────────────────────────────────────── */

test('context: Dedup —— 同一篇只能出现在一层里', () => {
  // 这篇同时满足「引用邻居」和「焦点词深入命中」两条 Supporting 规则 —— 只能收一次。
  const pack = assemble([
    doc('docs/main.md', 30, [hit('gamma', { title: true })]),
    doc('docs/both.md', 20, [hit('gamma', { body: true, bodyTf: 3 })]),
  ], { graph: graphOf({ 'docs/main.md': ['docs/both.md'] }) })

  assert.deepEqual(rels(pack.supporting), ['docs/both.md'])
  assert.deepEqual(pack.supporting[0].reason.terms, ['gamma'], '先到的规则说了算（深入命中优先）')
})

test('context: Dedup —— 三层之间没有任何 rel 重复', () => {
  const pack = assemble([
    doc('docs/main.md', 100, [hit('alpha', { title: true, body: true, bodyTf: 2 })]),
    doc('docs/h1.md', 40, [hit('alpha', { body: true, bodyTf: 1 })]),
    doc('docs/h2.md', 30, [hit('beta', { body: true, bodyTf: 1 })]),
    doc('docs/n1.md', 0),
    doc('docs/n2.md', 0),
  ], {
    graph: graphOf({
      'docs/main.md': ['docs/n1.md'],
      'docs/n2.md': ['docs/main.md'],
      // 邻居指回 Primary 自己 —— 必须被去重掉
      'docs/n1.md': ['docs/main.md'],
    }),
  })

  const all = [...rels(pack.primary), ...rels(pack.supporting), ...rels(pack.related)]
  assert.equal(new Set(all).size, all.length, `三层之间出现了重复：${JSON.stringify(all)}`)
  assert.ok(!rels(pack.supporting).includes('docs/main.md'))
  assert.ok(!rels(pack.related).includes('docs/main.md'))
})

test('context: Dedup —— 层内的 rel 也不重复', () => {
  const pack = assemble([
    doc('docs/main.md', 100, [hit('alpha', { title: true })]),
    doc('docs/x.md', 40, [hit('alpha', { body: true, bodyTf: 1 })]),
  ], { graph: graphOf({ 'docs/main.md': ['docs/x.md'] }) })
  assert.equal(new Set(rels(pack.related)).size, rels(pack.related).length)
})

/* ── 6 · Determinism ─────────────────────────────────── */

test('context: Determinism —— 同一份输入跑两遍，逐字相同', () => {
  const build = () => [
    doc('docs/main.md', 50, [
      hit('alpha', { title: true, body: true, bodyTf: 2 }),
      hit('beta', { body: true, bodyTf: 2 }),
    ]),
    doc('docs/b.md', 30, [hit('alpha', { body: true, bodyTf: 1 })]),
    doc('docs/c.md', 30, [hit('beta', { body: true, bodyTf: 1 })]),
    doc('docs/n.md', 0),
  ]
  const graph = () => graphOf({ 'docs/main.md': ['docs/n.md'] })
  const a = assemble(build(), { graph: graph(), topic: 't', task: '问题原文', total: 9 })
  const b = assemble(build(), { graph: graph(), topic: 't', task: '问题原文', total: 9 })
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))
})

test('context: Determinism —— 同层顺序完全由 BM25 名次决定，不靠别的东西', () => {
  // `rank` 就是输入下标，所以正常路径下永远用不到 rel 兜底 —— 这条验的是
  // 「同层内部既不重排、也不按稳定排序的怪癖打乱」，顺序就是名次顺序。
  const forward = assemble([
    doc('docs/a.md', 100, [hit('alpha', { title: true })]),
    doc('docs/m.md', 50, [hit('alpha', { body: true, bodyTf: 1 })]),
    doc('docs/z.md', 40, [hit('alpha', { body: true, bodyTf: 1 })]),
  ])
  assert.deepEqual(rels(forward.related), ['docs/m.md', 'docs/z.md'])
})

/* ── 7 · Why ─────────────────────────────────────────── */

test('context: Why —— 理由码来自封闭集合，且每条都能说出凭什么', () => {
  const CODES = new Set([
    'direct', 'titleMatch', 'summaryMatch', 'bodyMatch', 'linkTarget', 'linkSource', 'related',
  ])
  const pack = assemble([
    doc('docs/main.md', 100, [hit('alpha', { title: true })]),
    doc('docs/body.md', 60, [hit('alpha', { body: true, bodyTf: 2 })]),
    doc('docs/weak.md', 30, [hit('alpha', { body: true, bodyTf: 1 })]),
    doc('docs/linked.md', 0),
  ], { graph: graphOf({ 'docs/main.md': ['docs/linked.md'] }) })

  for (const tier of ['primary', 'supporting', 'related']) {
    for (const item of pack[tier]) {
      assert.ok(CODES.has(item.reason.code), `${item.rel} 的理由码 ${item.reason.code} 不在封闭集合里`)
      const linked = item.reason.code === 'linkTarget' || item.reason.code === 'linkSource'
      assert.ok(
        linked || item.reason.terms.length > 0,
        `${item.rel}（${tier}）既没命中词也没有引用关系 —— 说不出凭什么`,
      )
    }
  }
})

test('context: Why —— 有落脚点的角色只能给标题/摘要类理由', () => {
  const GROUNDED = new Set(['direct', 'titleMatch', 'summaryMatch'])
  const pack = assemble([
    doc('docs/t.md', 100, [hit('alpha', { title: true })]),
    doc('docs/s.md', 80, [hit('alpha', { summary: true })]),
  ], { maxPrimary: 2 })
  assert.equal(pack.primary.length, 2)
  for (const item of pack.primary) {
    assert.ok(GROUNDED.has(item.reason.code), `${item.rel} 进了 Primary 但理由是 ${item.reason.code}`)
  }
})

test('context: explainContext —— 七种理由的判定顺序是固定的', () => {
  const cases = [
    // [说明, matchedTerms, links, 期望理由码]
    ['标题命中且不止一个命中词 → direct',
      [hit('a', { title: true }), hit('b', { body: true, bodyTf: 1 })], {}, 'direct'],
    ['只命中标题一个词 → titleMatch',
      [hit('a', { title: true })], {}, 'titleMatch'],
    ['只命中摘要 → summaryMatch',
      [hit('a', { summary: true })], {}, 'summaryMatch'],
    ['有词但没有标题/摘要 → bodyMatch',
      [hit('a', { body: true, bodyTf: 2 })], {}, 'bodyMatch'],
    ['一个词都没命中 + 被 Primary 引用 → linkTarget',
      [], { linkTarget: true }, 'linkTarget'],
    ['一个词都没命中 + 引用了 Primary → linkSource',
      [], { linkSource: true }, 'linkSource'],
    ['什么都没有 → related',
      [], {}, 'related'],
  ]
  for (const [why, terms, links, expected] of cases) {
    const reason = explainContext({ rel: 'x.md', matchedTerms: terms }, links)
    assert.equal(reason.code, expected, why)
  }
})

test('context: explainContext —— 标题优先于摘要、摘要优先于正文（同一个词命中多处也只报最强的）', () => {
  const reason = explainContext({
    rel: 'x.md',
    matchedTerms: [hit('a', { title: true, summary: true, body: true, bodyTf: 3 })],
  })
  assert.equal(reason.code, 'titleMatch')
  assert.equal(reason.fields, 3, 'fields 记的是命中的**字段种类数**（标题/摘要/正文）')
})

test('context: explainContext —— bodyMatch 的 fields 记的是正文命中的**词数**，不是次数', () => {
  const reason = explainContext({
    rel: 'x.md',
    matchedTerms: [
      hit('a', { body: true, bodyTf: 9 }),
      hit('b', { body: true, bodyTf: 7 }),
    ],
  })
  assert.equal(reason.code, 'bodyMatch')
  assert.equal(reason.fields, 2, '两个词各命中一次正文 = 2（不是 9+7）')
})

test('context: explainContext —— 引用关系只在一句话都没命中时才当理由', () => {
  // 有命中就说命中 —— 引用是补充证据，不是更弱的命中。
  const reason = explainContext(
    { rel: 'x.md', matchedTerms: [hit('a', { body: true, bodyTf: 1 })] },
    { linkTarget: true, linkSource: true },
  )
  assert.equal(reason.code, 'bodyMatch')
})

test('context: sourceTypeOf —— 角色是路径字面规则，不是内容理解', () => {
  assert.equal(sourceTypeOf('test/host.test.mjs'), 'test')
  assert.equal(sourceTypeOf('package.json'), 'config')
  assert.equal(sourceTypeOf('src/host/relevance.js'), 'impl')
  assert.equal(sourceTypeOf('README.md'), 'doc')
  // ⚠️ 这条是**故意的**：`docs/relevance-algorithm.md` 名字里有 relevance，
  // 会被 impl 规则按「带模块名的说明文档」收走。它不是在讲设计过程，是在讲实现，
  // 所以 impl 是对的（见 `test/context-eval.test.mjs:468-470` 记的同一个坑）。
  assert.equal(sourceTypeOf('docs/relevance-algorithm.md'), 'impl')
  assert.equal(sourceTypeOf('docs/sdd-context-assembly.md'), 'design', 'sdd- 前缀才是设计')
})

test('context: sourceTypeOf —— design 规则必须排在 impl 前面（同一条路径两种规则都命中时）', () => {
  // 真踩过：`docs/relevance-algorithm.md` 一度被判成 impl（当时 design 排在 impl 后面）。
  // 只有**同时**命中两条规则的路径才能证明顺序 —— `src/host/design.md` 既在 src/ 下、
  // 文件名又明说「这是设计」，必须取 design。
  assert.equal(sourceTypeOf('src/host/design.md'), 'design')
  assert.equal(sourceTypeOf('src/host/方案.md'), 'design')
  assert.equal(sourceTypeOf('lib/adr-001.md'), 'design')
  // 对照组：`docs/` 本身不是「设计」的信号 —— 只有文件名说了才算。
  assert.equal(sourceTypeOf('docs/context-assembly.md'), 'impl')
  assert.equal(sourceTypeOf('src/host/context.md'), 'impl')
})

/* ── 8 · Limits ──────────────────────────────────────── */

test('context: Limits —— 默认上限是 1 / 3 / 5', () => {
  assert.equal(MAX_PRIMARY, 1, 'PRD §5：Primary = Top 1')
  assert.equal(MAX_SUPPORTING, 3, 'PRD §5：Supporting 0~3')
  assert.equal(MAX_RELATED, 5, 'PRD §5：Related 0~5')
})

test('context: Limits —— 上限是硬约束，超出的一律截断（1 / 3 / 5）', () => {
  // 一篇够格的 Primary（挡住后面所有有落脚点的），
  // 它的 6 个引用邻居抢 3 个 Supporting 名额，剩下 8 篇有命中的抢 5 个 Related 名额。
  const ranked = [
    doc('docs/main.md', 100, [hit('alpha', { title: true, body: true, bodyTf: 1 })]),
    ...Array.from({ length: 8 }, (_, i) =>
      doc(`docs/h${i + 1}.md`, 20 - i, [hit('alpha', { body: true, bodyTf: 1 })])),
    ...Array.from({ length: 6 }, (_, i) => doc(`docs/n${i + 1}.md`, 0)),
  ]
  const pack = assemble(ranked, {
    graph: graphOf({
      'docs/main.md': ['docs/n1.md', 'docs/n2.md', 'docs/n3.md', 'docs/n4.md', 'docs/n5.md', 'docs/n6.md'],
    }),
  })

  assert.equal(pack.primary.length, 1)
  assert.equal(pack.primary[0].rel, 'docs/main.md')
  assert.equal(pack.supporting.length, 3, 'Supporting 必须被截到 3')
  assert.deepEqual(rels(pack.supporting), ['docs/n1.md', 'docs/n2.md', 'docs/n3.md'],
    '引用邻居按对方的 BM25 名次排 —— 名次靠前的先看')
  assert.equal(pack.related.length, 5, 'Related 必须被截到 5')
  assert.deepEqual(rels(pack.related), ['docs/h1.md', 'docs/h2.md', 'docs/h3.md', 'docs/h4.md', 'docs/h5.md'])
  assert.equal(pack.totals.matched, 9, 'matched 是**命中了的篇数**（1 篇主文档 + 8 篇 h），不受上限影响')
  assert.equal(pack.totals.total, 15)
})

test('context: Limits —— 上限可以被调用方覆盖（但 0 / 负数 / 非整数一律回落到默认值）', () => {
  const ranked = [
    doc('docs/a.md', 100, [hit('alpha', { title: true })]),
    doc('docs/b.md', 90, [hit('alpha', { title: true })]),
    doc('docs/c.md', 80, [hit('alpha', { title: true })]),
  ]
  assert.equal(assemble(ranked, { maxPrimary: 2 }).primary.length, 2)
  assert.equal(assemble(ranked, { maxPrimary: 3 }).primary.length, 3)
  assert.equal(assemble(ranked, { maxPrimary: 0 }).primary.length, MAX_PRIMARY, '0 不是「不要 Primary」')
  assert.equal(assemble(ranked, { maxPrimary: -1 }).primary.length, MAX_PRIMARY)
  assert.equal(assemble(ranked, { maxPrimary: 2.5 }).primary.length, MAX_PRIMARY)
})

/* ── 输出契约 ────────────────────────────────────────── */

test('context: 输出里不许出现内部分数 —— 名次本身就是答案', () => {
  // 需求 §七：不要 contextScore、不要百分比、不要置信度。这条在序列化层面钉死。
  const pack = assemble([
    doc('docs/main.md', 100, [hit('alpha', { title: true, body: true, bodyTf: 3 })]),
    doc('docs/x.md', 20, [hit('alpha', { body: true, bodyTf: 1 })]),
  ], { graph: graphOf({ 'docs/main.md': ['docs/x.md'] }) })
  const json = JSON.stringify(pack)
  for (const forbidden of ['"raw"', '"strength"', '"rank"', '"score"', '"haystack"', '"termFields"', '"bodyTf"']) {
    assert.ok(!json.includes(forbidden), `输出里泄漏了内部字段 ${forbidden}`)
  }
})

test('context: 条目字段是固定投影（rel/title/summary/mtimeMs/kind/source/reason）', () => {
  const pack = assemble([doc('docs/main.md', 100, [hit('alpha', { title: true })], { summary: '摘要' })])
  assert.deepEqual(Object.keys(pack.primary[0]).sort(),
    ['kind', 'mtimeMs', 'reason', 'rel', 'source', 'summary', 'title'])
  assert.deepEqual(Object.keys(pack.primary[0].reason).sort(), ['code', 'fields', 'term', 'terms'])
})

test('context: task 是原样引用 —— 本模块不生成、不改写、也不截断', () => {
  const long = '这是一条很长的问题原文，'.repeat(20)
  const pack = assemble([doc('a.md', 10, [hit('x', { title: true })])], { task: long })
  assert.equal(pack.task, long)
  assert.equal(assemble([], { task: 123 }).task, '', '非字符串一律回落成空串，不 String() 化')
})

test('context: total 只影响 totals.total，不影响任何一层的收录', () => {
  const ranked = [doc('docs/main.md', 100, [hit('alpha', { title: true })])]
  const small = assemble(ranked, { total: 1 })
  const big = assemble(ranked, { total: 999 })
  assert.deepEqual(rels(small.primary), rels(big.primary))
  assert.equal(big.totals.total, 999)
  assert.equal(assemble(ranked).totals.total, 1, '不给 total 就是这一批的条数')
})
