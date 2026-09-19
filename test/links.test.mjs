/**
 * Knit · **引用关系解析**（v0.12）的测试
 *
 * 这一组测试的靶心是 **误报**，不是召回。
 * 依据是真实语料的实测：`SKILL.md` 有 20 个、`01_公众号正文.md` 有 12 个，
 * 那些「只写了 basename」的提及多半在讲**文件名约定**，不是在指某一篇 ——
 * 宽松解析会让 13% 的边是错的（见 `Knit_SDD-v0.12` §1.4）。
 *
 * 所以有一条专门的回归用例：**同名文件存在时，光写 basename 必须不产生边**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractRefs,
  createIndex,
  resolveRef,
  buildLinkGraph,
  linksOf,
  resetLinkCache,
} from '../src/host/links.js'

/* ── extractRefs：三种真实写法 ───────────────────────── */

test('extractRefs：认反引号路径（真实语料里的主力写法，946 次）', () => {
  assert.deepEqual(extractRefs('见 `docs/A.md` 那篇'), ['docs/A.md'])
})

test('extractRefs：反引号路径里的空格要保留（`00_ Knit PRD/x.md` 真实存在）', () => {
  assert.deepEqual(extractRefs('见 `00_ Knit PRD/Knit_PRD-v0.12.md`'), ['00_ Knit PRD/Knit_PRD-v0.12.md'])
})

test('extractRefs：认标准 Markdown 链接，并忽略锚点', () => {
  assert.deepEqual(extractRefs('[看这里](docs/A.md#三)'), ['docs/A.md'])
})

test('extractRefs：认裸路径提及（前面是空白或中文括号）', () => {
  assert.deepEqual(extractRefs('见 docs/A.md 那篇'), ['docs/A.md'])
  assert.deepEqual(extractRefs('（docs/A.md）'), ['docs/A.md'])
})

test('extractRefs：去重，保持出现顺序', () => {
  assert.deepEqual(extractRefs('`b.md` 再 `a.md` 又 `b.md`'), ['b.md', 'a.md'])
})

test('extractRefs：外链不算（不是本工作区的文档）', () => {
  assert.deepEqual(extractRefs('[x](https://ex.com/a.md)'), [])
  assert.deepEqual(extractRefs('`ftp://h/a.md`'), [])
})

test('extractRefs：非 .md 不算', () => {
  assert.deepEqual(extractRefs('`a.png` `b.js` `c`'), [])
})

test('extractRefs：不咬 `a.md.bak` 这种更长但不是 .md 的串', () => {
  assert.deepEqual(extractRefs('备份在 a.md.bak'), [])
  assert.deepEqual(extractRefs('`a.md.bak`'), [])
})

test('extractRefs：不做 `[[wikilink]]`（真实语料 0 次使用，SDD §7.1 已否决）', () => {
  assert.deepEqual(extractRefs('见 [[docs/A]] 那篇'), [])
})

test('extractRefs：空/非字符串输入返回空数组，不抛', () => {
  assert.deepEqual(extractRefs(''), [])
  assert.deepEqual(extractRefs(null), [])
  assert.deepEqual(extractRefs(undefined), [])
})

/* ── resolveRef：四级优先 + 歧义不算 ─────────────────── */

const IDX = createIndex([
  'README.md',
  'docs/README.md',
  'docs/LoreFlow-Copilot-PRD-v0.6.md',
  'docs/LoreFlow-Copilot-SDD-v0.6.md',
  'a/SKILL.md',
  'b/SKILL.md',
])

test('resolveRef：① 引用方所在目录优先（这才是相对路径的语义）', () => {
  assert.equal(resolveRef('README.md', IDX, 'docs/B.md'), 'docs/README.md')
})

test('resolveRef：① 同目录没有才退到工作区根', () => {
  assert.equal(resolveRef('README.md', IDX, 'other/B.md'), 'README.md')
})

test('resolveRef：② 完整相对路径直接命中', () => {
  assert.equal(resolveRef('docs/LoreFlow-Copilot-PRD-v0.6.md', IDX, 'x/y.md'), 'docs/LoreFlow-Copilot-PRD-v0.6.md')
})

test('resolveRef：③ 缩写后缀 `-SDD-v0.6.md`（真实语料里存在）', () => {
  assert.equal(resolveRef('-SDD-v0.6.md', IDX, 'docs/LoreFlow-Copilot-PRD-v0.6.md'),
    'docs/LoreFlow-Copilot-SDD-v0.6.md')
})

test('resolveRef：③ 缩写后缀命中多个就不算（宁可少不可错）', () => {
  // `-6.md` 能匹配 PRD-v0.6 与 SDD-v0.6，无法确定
  assert.equal(resolveRef('-6.md', IDX, 'docs/x.md'), null)
})

test('resolveRef：④ basename 唯一时可以命中', () => {
  assert.equal(resolveRef('LoreFlow-Copilot-PRD-v0.6.md', IDX, 'x/y.md'),
    'docs/LoreFlow-Copilot-PRD-v0.6.md')
})

test('🔴 误报回归：同名文件存在时，光写 basename 必须不产生边', () => {
  // 这条是 v0.12 最重要的回归 —— 真实语料里 SKILL.md 有 20 个。
  // 宽松解析（取第一个）会让 `s5-illustration/SKILL.md` 的入度虚高到 15。
  assert.equal(resolveRef('SKILL.md', IDX, 'z/w.md'), null)
})

test('resolveRef：⑤ 工作区里没有这个文件 → null，不编造', () => {
  assert.equal(resolveRef('docs/不存在.md', IDX, 'x.md'), null)
})

test('resolveRef：`./` 前缀会被剥掉', () => {
  assert.equal(resolveRef('./docs/LoreFlow-Copilot-PRD-v0.6.md', IDX, 'x.md'),
    'docs/LoreFlow-Copilot-PRD-v0.6.md')
})

test('resolveRef：非法输入 → null，不抛', () => {
  assert.equal(resolveRef('', IDX, 'x.md'), null)
  assert.equal(resolveRef('https://e.com/a.md', IDX, 'x.md'), null)
  assert.equal(resolveRef('a.md', null, 'x.md'), null)
})

/* ── buildLinkGraph：注入 list/read，缓存按签名失效 ───── */

/** 造一个可控的假 io：`files` 是 rel → 正文。 */
function fakeIo(files) {
  const reads = { count: 0, byRel: new Map() }
  const docs = Object.keys(files).map((rel, i) => ({
    rel, title: rel.replace(/\.md$/, ''), mtimeMs: 1000 + i,
  }))
  return {
    reads,
    list: async () => ({ docs, truncated: false }),
    read: async (_root, rel) => {
      reads.count += 1
      reads.byRel.set(rel, (reads.byRel.get(rel) || 0) + 1)
      return { ok: true, rel, text: files[rel] }
    },
  }
}

test('buildLinkGraph：正向边与反向边一致（反向边由正向推出来）', async () => {
  resetLinkCache()
  const io = fakeIo({
    'A.md': '见 `B.md` 与 C.md',
    'B.md': '正文没有引用',
    'C.md': '见 `A.md`',
  })
  const g = await buildLinkGraph('/fake-1', io)
  assert.deepEqual([...g.out.get('A.md')].sort(), ['B.md', 'C.md'])
  assert.deepEqual([...g.in.get('B.md')], ['A.md'])
  assert.deepEqual([...g.in.get('A.md')], ['C.md'])
  assert.deepEqual([...g.in.get('C.md')], ['A.md'])
})

test('buildLinkGraph：自引用不算边', async () => {
  resetLinkCache()
  const io = fakeIo({ 'A.md': '见 `A.md`' })
  const g = await buildLinkGraph('/fake-2', io)
  assert.equal(g.out.get('A.md').size, 0)
  assert.equal(g.in.get('A.md').size, 0)
})

test('buildLinkGraph：歧义 basename 不产生边（误报回归，图这一层）', async () => {
  resetLinkCache()
  const io = fakeIo({
    'x/SKILL.md': '内容',
    'y/SKILL.md': '内容',
    'doc.md': '见 `SKILL.md`',
  })
  const g = await buildLinkGraph('/fake-3', io)
  assert.equal(g.out.get('doc.md').size, 0, '歧义 basename 不许产生边')
  assert.equal(g.in.get('x/SKILL.md').size, 0)
  assert.equal(g.in.get('y/SKILL.md').size, 0)
})

test('buildLinkGraph：同一签名不重复读盘', async () => {
  resetLinkCache()
  const io = fakeIo({ 'A.md': '见 `B.md`', 'B.md': 'x' })
  await buildLinkGraph('/fake-4', io)
  const first = io.reads.count
  await buildLinkGraph('/fake-4', io)
  assert.equal(io.reads.count, first, '签名没变就不该再读一遍')
})

test('buildLinkGraph：mtime 变了要重建', async () => {
  resetLinkCache()
  const files = { 'A.md': '见 `B.md`', 'B.md': 'x' }
  let bump = 0
  const reads = { count: 0 }
  const docs = () => Object.keys(files).map((rel, i) => ({
    rel, title: rel, mtimeMs: 1000 + i + bump,
  }))
  const io = {
    list: async () => ({ docs: docs(), truncated: false }),
    read: async (_r, rel) => { reads.count += 1; return { ok: true, rel, text: files[rel] } },
  }
  await buildLinkGraph('/fake-5', io)
  const first = reads.count
  bump = 500
  await buildLinkGraph('/fake-5', io)
  assert.ok(reads.count > first, 'mtime 变了必须重建')
})

test('buildLinkGraph：读失败的篇跳过，不影响其它篇（skipped 计数）', async () => {
  resetLinkCache()
  const io = fakeIo({ 'A.md': '见 `B.md`', 'B.md': 'x' })
  const realRead = io.read
  io.read = async (root, rel) => (rel === 'B.md' ? { ok: false, code: 'knit/read-failed' } : realRead(root, rel))
  const g = await buildLinkGraph('/fake-6', io)
  assert.equal(g.parsed, 1)
  assert.equal(g.skipped, 1)
  assert.deepEqual([...g.out.get('A.md')], ['B.md'], 'A 的解析不受 B 读失败影响')
})

/* ── linksOf：形状、排序、计数与截断 ─────────────────── */

test('linksOf：未知 rel → not-found（宿主只返回错误码，不返回文案）', () => {
  const g = { titles: new Map([['A.md', 'A']]), in: new Map(), out: new Map(), limited: false }
  assert.deepEqual(linksOf(g, 'nope.md'), { ok: false, code: 'knit/not-found' })
})

test('linksOf：只返回 rel + title，不泄漏内部结构', async () => {
  resetLinkCache()
  const io = fakeIo({ 'A.md': '见 `B.md`', 'B.md': 'x' })
  const g = await buildLinkGraph('/fake-7', io)
  const v = linksOf(g, 'B.md')
  assert.equal(v.ok, true)
  assert.deepEqual(Object.keys(v.incoming[0]).sort(), ['rel', 'title'])
  assert.ok(!('out' in v) && !('titles' in v) && !('signature' in v))
})

test('linksOf：按「对方入度降序」排，平手按 rel 字典序（顺序必须稳定）', async () => {
  resetLinkCache()
  const io = fakeIo({
    // hub 被两篇引用，leaf 没人引用；两者都引用了 T
    'hub.md': '见 `T.md`',
    'x.md': '见 `hub.md`',
    'y.md': '见 `hub.md`',
    'a-leaf.md': '见 `T.md`',
    'T.md': 'target',
  })
  const g = await buildLinkGraph('/fake-8', io)
  const v = linksOf(g, 'T.md')
  assert.deepEqual(v.incoming.map((d) => d.rel), ['hub.md', 'a-leaf.md'],
    '入度高的引用方排前面')
})

test('linksOf：计数给全量，列表可截断', async () => {
  resetLinkCache()
  const files = { 'T.md': 'target' }
  for (let i = 0; i < 5; i += 1) files[`p${i}.md`] = '见 `T.md`'
  const g = await buildLinkGraph('/fake-9', fakeIo(files))
  const v = linksOf(g, 'T.md', 2)
  assert.equal(v.incoming.length, 2)
  assert.equal(v.incomingTotal, 5, '计数必须是全量，不能是截断后的长度')
})

test('linksOf：limited 透传（扫描被上限截断时面板要能提示「结果不完整」）', async () => {
  resetLinkCache()
  const io = fakeIo({ 'A.md': 'x' })
  io.list = async () => ({ docs: [{ rel: 'A.md', title: 'A', mtimeMs: 1 }], truncated: true })
  const g = await buildLinkGraph('/fake-10', io)
  assert.equal(linksOf(g, 'A.md').limited, true)
})
