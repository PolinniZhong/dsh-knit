/**
 * Knit · **关系投影**（v0.21）的测试
 *
 * 靶心是**证据诚实性**，不是召回：每一条关系都必须能说清证据在哪（哪一行、哪种约定），
 * 说不清就不产生关系。所以这一组的重点在「不产生」和「确定性」这两件事上。
 *
 * 全是纯函数测试：不起宿主、不读盘、不 spawn。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createIndex } from '../src/host/links.js'
import { scan, buildContextFor } from '../src/host/index.js'
import { makeWorkspace } from './fixture.mjs'
import {
  importsOf,
  resolveSpec,
  testsOf,
  buildRelationFacts,
  relationsOf,
  resetRelationCache,
  MAX_RELATIONS_PER_ITEM,
  MAX_TOOL_RELATIONS_PER_ITEM,
} from '../src/host/relations.js'

/** 造一条候选记录（与 `collectDocs()` 产出的形状一致：rel / head / mtimeMs）。 */
const cand = (rel, head, mtimeMs = 1000) => ({ rel, head, mtimeMs })

/* ── 1 · importsOf：三种真实写法 + 行号 ───────────────── */

test('importsOf：认 `import … from`、裸 `import`、`require` 三种写法，行号正确', () => {
  const text = [
    "import { a } from './a.js'",
    '',
    "import './side.css'",
    "const b = require('../lib/b')",
    "import x from 'node:test'",
  ].join('\n')
  assert.deepEqual(importsOf(text), [
    { spec: './a.js', line: 1 },
    { spec: './side.css', line: 3 },
    { spec: '../lib/b', line: 4 },
    { spec: 'node:test', line: 5 },
  ])
})

test('importsOf：同一个指定符只报一次（保留首次出现的行号）', () => {
  const text = "import a from './x.js'\nimport b from './x.js'\n"
  assert.deepEqual(importsOf(text), [{ spec: './x.js', line: 1 }])
})

test('importsOf：空 / 非字符串输入返回空数组，不抛', () => {
  assert.deepEqual(importsOf(''), [])
  assert.deepEqual(importsOf(null), [])
  assert.deepEqual(importsOf(undefined), [])
})

/* ── 2 · resolveSpec：只认相对指定符 ──────────────────── */

test('resolveSpec：裸指定符 / 绝对路径 / 出工作区 一律不产生关系', () => {
  const idx = createIndex(['src/a.js', 'src/b.ts', 'lib/index.js', 'docs/c.md', 'src/d.mjs'])
  assert.equal(resolveSpec('node:test', 'src/a.js', idx), null)
  assert.equal(resolveSpec('react', 'src/a.js', idx), null)
  assert.equal(resolveSpec('/abs/x.js', 'src/a.js', idx), null)
  assert.equal(resolveSpec('../../x.js', 'src/a.js', idx), null, '爬出工作区不算')
  assert.equal(resolveSpec('./nope', 'src/a.js', idx), null, '候选集里没有就不算')
  assert.equal(resolveSpec('', 'src/a.js', idx), null)
})

/* ── 3 · resolveSpec：扩展名补全顺序 ──────────────────── */

test('resolveSpec：原样 → 补扩展名 → `/index.<ext>`，顺序固定', () => {
  const idx = createIndex(['src/a.js', 'src/b.ts', 'lib/index.js', 'docs/c.md', 'src/d.mjs'])
  assert.equal(resolveSpec('./b.ts', 'src/a.js', idx), 'src/b.ts', '原样命中')
  assert.equal(resolveSpec('./b', 'src/a.js', idx), 'src/b.ts', '补扩展名')
  assert.equal(resolveSpec('./d', 'src/a.js', idx), 'src/d.mjs', '补 .mjs')
  assert.equal(resolveSpec('../lib', 'src/a.js', idx), 'lib/index.js', '补 /index.<ext>')
  assert.equal(resolveSpec('../docs/c.md', 'src/a.js', idx), 'docs/c.md', '可以指向 md')
})

/* ── 4 · testsOf：命名约定 + 歧义不算 ─────────────────── */

test('testsOf：双向都能认（被测方 / 测试方），用的都是文件名这条可核验的事实', () => {
  const idx = createIndex(['src/host/links.js', 'test/links.test.mjs', 'src/util.js'])
  assert.equal(testsOf('src/host/links.js', idx), 'test/links.test.mjs')
  assert.equal(testsOf('test/links.test.mjs', idx), 'src/host/links.js')
  // 没有任何测试文件的篇不产生关系
  assert.equal(testsOf('src/util.js', idx), null)
  assert.equal(testsOf('test/links.test.mjs', createIndex(['test/links.test.mjs'])), null)
})

test('testsOf：同名歧义一律不算（与 v0.12 的 basename 规矩一致）', () => {
  const idx = createIndex([
    'src/host/links.js', 'other/links.js', 'test/links.test.mjs',
  ])
  assert.equal(testsOf('test/links.test.mjs', idx), null, '两个同名被测方 ⇒ 不算')
  assert.equal(testsOf('src/host/links.js', idx), 'test/links.test.mjs')
})

test('testsOf：同目录的 `.test` / `.spec` 也算，但两个都在就不算', () => {
  const one = createIndex(['src/a.js', 'src/a.test.js'])
  assert.equal(testsOf('src/a.js', one), 'src/a.test.js')
  const two = createIndex(['src/a.js', 'src/a.test.js', 'src/a.spec.js'])
  assert.equal(testsOf('src/a.js', two), null, '两个候选 ⇒ 歧义 ⇒ 不算')
})

/* ── 5 · 源仍然只有 Markdown（D5 的守卫原意） ──────────── */

test('buildRelationFacts：md 能指向 md（references）与代码（documents）', () => {
  resetRelationCache()
  const facts = buildRelationFacts([
    cand('docs/spec.md', '设计见 `src/host/links.js` 与 `docs/other.md`'),
    cand('docs/other.md', ''),
    cand('src/host/links.js', ''),
  ], { root: 't-refs' })

  assert.deepEqual(relationsOf(facts, 'docs/spec.md').relations, [
    { type: 'references', dir: 'out', other: 'docs/other.md', line: 1 },
    { type: 'documents', dir: 'out', other: 'src/host/links.js', line: 1 },
  ])
  // 反向边由同一条边推出来（`in` 的行号属于源文件那一行）
  assert.deepEqual(relationsOf(facts, 'src/host/links.js').relations, [
    { type: 'documents', dir: 'in', other: 'docs/spec.md', line: 1 },
  ])
})

test('buildRelationFacts：代码注释里写个路径**不产生** references / documents', () => {
  resetRelationCache()
  const facts = buildRelationFacts([
    cand('src/util.js', '// see `docs/real.md` for details\n'),
    cand('docs/real.md', '# design\n'),
  ], { root: 't-src-only' })

  assert.deepEqual(relationsOf(facts, 'src/util.js').relations, [], '代码不能当引用关系的源')
  assert.deepEqual(relationsOf(facts, 'docs/real.md').relations, [])
})

test('buildRelationFacts：代码 → 代码是 imports，行号是导入那一行', () => {
  resetRelationCache()
  const facts = buildRelationFacts([
    cand('test/deep-scale.test.mjs', "import { GATES } from '../tools/deep-benchmark.mjs'\n"),
    cand('tools/deep-benchmark.mjs', "import { scan } from '../src/host/index.js'\n"),
    cand('src/host/index.js', ''),
  ], { root: 't-imports' })

  assert.deepEqual(relationsOf(facts, 'test/deep-scale.test.mjs').relations, [
    { type: 'imports', dir: 'out', other: 'tools/deep-benchmark.mjs', line: 1 },
  ])
  assert.deepEqual(relationsOf(facts, 'tools/deep-benchmark.mjs').relations, [
    { type: 'imports', dir: 'in', other: 'test/deep-scale.test.mjs', line: 1 },
    { type: 'imports', dir: 'out', other: 'src/host/index.js', line: 1 },
  ])
})

test('buildRelationFacts：自定义路径跳到别的篇，不产生边（对端不在候选集）', () => {
  resetRelationCache()
  const facts = buildRelationFacts([
    cand('a.md', '见 `不在候选集里.md`'),
  ], { root: 't-outside' })
  assert.deepEqual(relationsOf(facts, 'a.md').relations, [])
})

/* ── 6 · 截断顺序确定性 ───────────────────────────────── */

test('relationsOf：截断顺序 = type 优先级 → in 先 → 行号升序 → 对端字典序，并如实给 total', () => {
  resetRelationCache()
  const facts = buildRelationFacts([
    // 三个 references（两个同行 + 一个 in 边）之后再一条 documents ⇒ 3 条上限会把 documents 截掉
    cand('main.md', '见 `z.md` `a.md`\n见 `src/x.js`'),
    cand('hub.md', '第一行\n\n见 `main.md`'),
    cand('z.md', ''),
    cand('a.md', ''),
    cand('src/x.js', ''),
  ], { root: 't-truncate' })

  assert.equal(MAX_RELATIONS_PER_ITEM, 3)
  const got = relationsOf(facts, 'main.md')
  assert.equal(got.total, 4, '被截断的条数要如实给出来')
  assert.deepEqual(got.relations.map((r) => `${r.type}:${r.dir}:${r.other}`), [
    'references:in:hub.md',
    'references:out:a.md',
    'references:out:z.md',
  ], 'documents 是优先级最低的一类，先被截掉')

  // 上限可调（工具侧 2 条走的是同一条路径）
  assert.deepEqual(relationsOf(facts, 'main.md', 2).relations.map((r) => r.other), ['hub.md', 'a.md'])
})

test('buildRelationFacts：同一对（类型 + 方向 + 对端）只留一条，行号取最靠前的', () => {
  resetRelationCache()
  const facts = buildRelationFacts([
    // 两种写法都指向同一篇（`docs/x.md` 与 x.md 在候选集里解析成同一个 rel）
    cand('a.md', '见 `docs/x.md`\n见 `x.md`'),
    cand('docs/x.md', ''),
  ], { root: 't-dedup' })
  const got = relationsOf(facts, 'a.md')
  assert.equal(got.total, 1)
  assert.deepEqual(got.relations, [{ type: 'references', dir: 'out', other: 'docs/x.md', line: 1 }])
})

/* ── 7 · 端到端：证据必须能读回原文核验（实现说明 §10.7） ──── */

/**
 * 造一个**真的能互相指到**的工作区。
 *
 * 条目之间的路径故意写成带扩展名的完整相对路径 —— 这样「那一行里应该有对方」
 * 可以用 `basename` 直接断言，不必把解析器再实现一遍（用被测代码去验被测代码，
 * 等于没验）。
 */
function refWorkspace() {
  return makeWorkspace([
    ['docs/spec.md', [
      '# 插件设计',
      '',
      '实现见 `src/host/plugin.js`（v0.19 起代码也进语料）。',
      '背景见 `docs/other.md`。',
      '',
    ].join('\n')],
    ['docs/other.md', '# 背景\n\n无关内容。\n'],
    ['src/host/plugin.js', [
      "import { load } from '../util/helper.js'",
      '',
      'export function plugin () { return load() }',
      '',
    ].join('\n')],
    ['src/util/helper.js', 'export function load () { return 1 }\n'],
  ])
}

test('端到端: 每条关系都能按 other + line 读回原文，那一行真的有那处提及', async () => {
  const root = refWorkspace()
  resetRelationCache()
  const r = await scan(root, 60, { sort: 'relevance', kind: 'context', query: 'plugin 插件设计 helper' })
  const pack = await buildContextFor(root, { ranked: r.ranked, topic: r.topic, total: r.total })
  const items = [...pack.primary, ...pack.supporting, ...pack.related]

  let checked = 0
  for (const item of items) {
    for (const rel of (item.relations || [])) {
      // `tests` 的证据是**文件名约定**，不是某一行文字 ⇒ 它没有 line，也不该被读回。
      if (rel.type === 'tests') {
        assert.equal(rel.line, undefined, `tests 不该有行号：${JSON.stringify(rel)}`)
        continue
      }
      assert.ok(Number.isInteger(rel.line) && rel.line >= 1, `行号必须是 1 起的整数：${JSON.stringify(rel)}`)

      // 行号属于**「谁在提这件事」的那个文件**：out ⇒ 本条目提对方；in ⇒ 对方提本条目。
      // 于是被念到名字的那一篇也随之互换 —— 断言必须跟着换，否则 in 边会被误判成编造。
      const owner = rel.dir === 'in' ? rel.other : item.rel
      const mentioned = rel.dir === 'in' ? item.rel : rel.other
      const text = readFileSync(join(root, owner), 'utf8')
      const line = text.split('\n')[rel.line - 1] || ''
      const base = mentioned.slice(mentioned.lastIndexOf('/') + 1)
      assert.ok(
        line.includes(base),
        `${owner} 第 ${rel.line} 行里没有 ${base} —— 证据是编的：${JSON.stringify(line)}`,
      )
      checked += 1
    }
  }
  assert.ok(checked >= 3, `这个夹具至少要产出 3 条可核验的关系，实测 ${checked} 条`)
})

test('端到端: 关系是投影 —— 关掉它，三层的成员与顺序逐字相同（实现说明 §10.8）', async () => {
  const root = refWorkspace()
  resetRelationCache()
  const r = await scan(root, 60, { sort: 'relevance', kind: 'context', query: 'plugin 插件设计 helper' })
  const withRel = await buildContextFor(root, { ranked: r.ranked, topic: r.topic, total: r.total })
  const without = await buildContextFor(root, {
    ranked: r.ranked, topic: r.topic, total: r.total, withRelations: false,
  })

  const relsOf = (pack) => ['primary', 'supporting', 'related']
    .map((tier) => pack[tier].map((i) => i.rel).join(','))
    .join(' | ')
  assert.equal(relsOf(withRel), relsOf(without), '关系不许改变任何一层的成员或顺序')

  const strip = (item) => {
    const copy = { ...item }
    delete copy.relations
    delete copy.relationsTotal
    return copy
  }
  const flat = (pack) => [...pack.primary, ...pack.supporting, ...pack.related]
  const a = flat(withRel)
  const b = flat(without)
  assert.equal(a.length, b.length)
  for (let i = 0; i < a.length; i += 1) {
    assert.deepEqual(strip(a[i]), b[i], '除 relations / relationsTotal 外，条目必须逐字相同')
    assert.equal(b[i].provenance, a[i].provenance)
  }
  // 反向自检：这个夹具**确实**产出了关系，否则上面那条「相同」是空话。
  assert.ok(a.some((i) => Array.isArray(i.relations) && i.relations.length > 0),
    '夹具没产出任何关系 ⇒ 这条守卫是假的')
})

test('端到端: 面板载荷有界 —— 每条结果的关系投影 ≤ 300 B（实测 ≈228 B）', async () => {
  // 需求 §6.7 的「每文件最多 2~3 条」是**预算约束**，不是建议：
  // 关系只能投影到已进包的那几行，复用短字符串，不许把关系全量塞进 payload。
  const extra = []
  for (let i = 1; i <= 12; i += 1) {
    const refs = [1, 2, 3].map((k) => `docs/peer-${((i + k) % 12) + 1}.md`).join('` `')
    extra.push([`docs/peer-${i}.md`, `# 同伴 ${i}\n\n命中点：payloadbudget 的同伴 ${i}。\n\n见 \`${refs}\`。\n`])
  }
  const root = makeWorkspace(extra)
  resetRelationCache()
  const r = await scan(root, 80, { sort: 'relevance', kind: 'context', query: 'payloadbudget 同伴' })
  const withRel = await buildContextFor(root, { ranked: r.ranked, topic: r.topic, total: r.total })
  const without = await buildContextFor(root, {
    ranked: r.ranked, topic: r.topic, total: r.total, withRelations: false,
  })
  const items = [...withRel.primary, ...withRel.supporting, ...withRel.related]
  assert.ok(items.length >= 5, `要有足够的结果才量得到载荷：${items.length}`)
  assert.ok(items.every((i) => !Array.isArray(i.relations) || i.relations.length <= MAX_RELATIONS_PER_ITEM),
    `每项最多 ${MAX_RELATIONS_PER_ITEM} 条关系`)

  const bytes = (pack) => Buffer.byteLength(JSON.stringify(pack), 'utf8')
  const relBytes = bytes(withRel) - bytes(without)
  const perItem = relBytes / items.length
  console.log(`    R2 实测：面板载荷 ${bytes(withRel)} B（基线 ${bytes(without)} B），`
    + `关系 ${relBytes} B / ${items.length} 项 = ${perItem.toFixed(0)} B/项`)
  assert.ok(perItem <= 300, `关系投影超预算：${perItem.toFixed(0)} B/项 > 300 B/项`)
  assert.ok(bytes(withRel) < 16000, `面板载荷越过 16000 B 门槛：${bytes(withRel)} B`)
})

/* ── 8 · 工具侧：每项 ≤2 条，一行说完（实现说明 §9） ───────── */

test('工具侧: 关系渲染成一行、最多 2 条，方向与行号都如实给出', async () => {
  const { renderToolText } = await import('../src/host/tool.js')
  const item = {
    rel: 'a.md', title: '甲', summary: '', mtimeMs: 1, source: 'doc',
    reason: { code: 'direct', terms: ['甲'], fields: 1, term: '甲' },
    provenance: 'retrieval',
    relations: [
      { type: 'references', dir: 'out', other: 'docs/other.md', line: 7 },
      { type: 'imports', dir: 'in', other: 'src/x.js', line: 2 },
      { type: 'tests', dir: 'out', other: 'test/a.test.mjs' },
    ],
    relationsTotal: 5,
  }
  const value = {
    mode: 'relevance', topic: '甲', total: 1,
    primary: [item], supporting: [], related: [], totals: { matched: 1, total: 1 },
  }
  const lines = renderToolText(value).split('\n')
  const relLines = lines.filter((l) => l.startsWith('   relations: '))
  assert.equal(relLines.length, 1, `一条结果最多一行 relations：${relLines.join(' | ')}`)
  assert.equal(relLines[0], '   relations: references → docs/other.md:7; imports ← src/x.js:2',
    '方向（→ 本项引用对方 / ← 对方引用本项）与行号必须都在')
  assert.equal(MAX_TOOL_RELATIONS_PER_ITEM, 2)
  assert.ok(!relLines[0].includes('a.test.mjs'), '第三条（tests）必须被截掉')
  // 没有关系就不渲染这一行（不写「无」）
  const bare = renderToolText({
    ...value,
    primary: [{ ...item, relations: [] }],
  })
  assert.ok(!bare.includes('   relations: '), '没有关系时不许出现空行')
})
