/**
 * v0.20 Deep Context Retrieval：**内容片段层**测试。
 *
 * 需求 §21 点名了 12 个用例（本文件逐条对应，外加一条 §17 的媒体反例）。
 * 两件事与其它测试文件不同，是刻意的：
 *
 *   1. **不动 v0.19 的基线。** `test/eval.test.mjs` / `test/context-eval.test.mjs`
 *      一行都没改（§22）。要证明「窗口打开后确实更准」，用的是本文件里的
 *      `deep-document.md` 回归（§14），不是把旧断言改松。
 *   2. **断言「片段覆盖了目标行」而不是「片段等于某个范围」。** 切分口径以后可以调，
 *      但「命中行必须落在报出去的行区间里」这条永远成立 —— 断言它才有意义。
 *
 * 跑法：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { scan, publicScanPayload } from '../src/host/index.js'
import { buildContext } from '../src/host/context.js'
import {
  chunkText,
  passageMatchesFor,
  windowTf,
  PASSAGE_MAX_PER_FILE,
  PASSAGE_WINDOW,
  SNIPPET_CHARS,
} from '../src/host/passage.js'
import { makeWorkspace } from './fixture.mjs'

/** 测试用稀有词：不会自然出现，于是「命中」一定是这一条造出来的。 */
const KEY = 'zephyrite'

/** 一行与任务无关的正文（长度稳定，便于推算字符位置）。 */
function noiseLine(i) {
  return `无关内容第 ${i} 行：这一段与查询词毫无关系，只是把目标词推到更靠后的位置去。`
}

/** 与任务无关的 n 行。 */
function noise(n) {
  const out = []
  for (let i = 0; i < n; i++) out.push(noiseLine(i + 1))
  return out
}

/** 逗号友好的拼接：`lines('a', ['b','c'])` → `'a\nb\nc'`。 */
function lines(...parts) {
  return parts.flat().join('\n')
}

/**
 * 以显式 query 走相关性排序扫一遍（不依赖任何会话事件）。
 * @param {string} root - 工作区
 * @param {string} query - 查询词
 * @param {object} [options] - 透传给 `scan()`（`kind` 等）
 */
async function relevanceScan(root, query, options = {}) {
  return scan(root, 50, { sort: 'relevance', query, ...options })
}

/** 从公开载荷里取一条记录（找不到就是失败，别让 `?.` 把断言吞掉）。 */
function pick(payload, rel) {
  const hit = payload.docs.find((d) => d.rel === rel)
  assert.ok(hit, `载荷里必须有 ${rel}`)
  return hit
}

test('deep-context ①：命中词在文件头部 → 片段指回头部', async () => {
  const body = lines('# 头部命中', '', `${KEY} 出现在第三行。`, noise(40))
  const root = makeWorkspace([['head.md', body]])
  const payload = await relevanceScan(root, KEY)

  const hit = pick(payload, 'head.md')
  assert.equal(hit.matches.length, 1)
  // 首段从第 1 行开始，且覆盖第 3 行 —— 这就是「指回头部」的可验证形式。
  assert.equal(hit.matches[0].startLine, 1)
  assert.ok(hit.matches[0].endLine >= 3, '片段必须覆盖目标行')
  assert.deepEqual(hit.matches[0].terms, [KEY])
  assert.match(hit.matches[0].snippet, new RegExp(KEY))
  assert.ok(hit.score > 0, '头部命中必须真的拿到分')
})

test('deep-context ②：命中词在文件中间 → 片段落在中间段', async () => {
  const L = ['# 中间命中', '']
  L.push(...noise(30))
  L.push(`这里提到 ${KEY}。`)
  const keyLine = L.length
  L.push(...noise(30))
  const root = makeWorkspace([['mid.md', L.join('\n')]])
  const payload = await relevanceScan(root, KEY)

  const m = pick(payload, 'mid.md').matches[0]
  assert.ok(m.startLine > 1, '不该是首段')
  assert.ok(m.startLine <= keyLine && keyLine <= m.endLine,
    `片段必须覆盖第 ${keyLine} 行，实际 ${m.startLine}-${m.endLine}`)
})

test('deep-context ③：命中词在文件尾部 → 片段落在尾段', async () => {
  const L = ['# 尾部命中', '']
  L.push(...noise(60))
  L.push(`结尾之前提到 ${KEY}。`)
  const keyLine = L.length
  const root = makeWorkspace([['tail.md', L.join('\n')]])
  const payload = await relevanceScan(root, KEY)

  const m = pick(payload, 'tail.md').matches[0]
  assert.ok(m.startLine <= keyLine && keyLine <= m.endLine,
    `片段必须覆盖第 ${keyLine} 行，实际 ${m.startLine}-${m.endLine}`)
  assert.ok(m.endLine > 40, '尾部命中不该被报成开头那段')
})

test('deep-context ④：目标词只出现在第 2500 字之后（v0.20 的核心回归，§14）', async () => {
  // 前 2500 字全是无关内容 —— v0.19 只对前 2500 字建 haystack，这个词根本不可见。
  const lead = noise(70) // ≈ 2900 字符
  const keyLine = lead.length + 1
  const body = lines('# 深文档', '', lead, `目标词 ${KEY} 藏在很后面。`)
  const root = makeWorkspace([['deep-document.md', body]])

  // 先证明「旧窗口确实看不到」：这不是装饰性断言，它是这一版存在的理由。
  assert.ok(body.length > 2500, '样本必须长过旧窗口')
  assert.equal(body.slice(0, 2500).toLowerCase().includes(KEY), false,
    '前 2500 字里不许出现目标词（否则这条回归就白做了）')

  const payload = await relevanceScan(root, KEY)
  const hit = pick(payload, 'deep-document.md')
  assert.ok(hit.score > 0, 'v0.20 必须能找到旧窗口之外的目标词')
  const m = hit.matches[0]
  // 片段本身可以从 2500 字之前**起**（切分口径不是断言对象），
  // 但它必须**延伸到窗口之后**并且覆盖目标行 —— 这才是「找到了窗口外的东西」。
  assert.ok(m.endOffset > 2500, `命中片段必须延伸到 2500 字之后，实际 endOffset ${m.endOffset}`)
  assert.ok(m.startLine <= keyLine && keyLine <= m.endLine, '片段必须覆盖目标行')
  assert.match(m.snippet, new RegExp(KEY))
})

test('deep-context ⑤：一篇文件命中多段 → 最多报 2 段，按行号升序', async () => {
  // 目标行号一律**由数组自己算**（`L.push` 之后 `L.length` 就是刚推入那行的行号）：
  // 手算行号漏掉一个空行就会写下一条假断言，而这条测试的价值全在行号上。
  const L = ['# 多段命中', '']
  L.push(...noise(20))
  L.push(`第一处 ${KEY}。`)
  const firstKey = L.length
  L.push(...noise(40))
  L.push(`第二处又提到 ${KEY}。`)
  const secondKey = L.length
  L.push(...noise(6))
  const root = makeWorkspace([['multi.md', L.join('\n')]])
  const payload = await relevanceScan(root, KEY)

  const matches = pick(payload, 'multi.md').matches
  assert.equal(matches.length, PASSAGE_MAX_PER_FILE)
  assert.ok(matches[0].startLine <= firstKey && firstKey <= matches[0].endLine,
    `第 1 段必须覆盖第 ${firstKey} 行，实际 ${matches[0].startLine}-${matches[0].endLine}`)
  assert.ok(matches[1].startLine <= secondKey && secondKey <= matches[1].endLine,
    `第 2 段必须覆盖第 ${secondKey} 行，实际 ${matches[1].startLine}-${matches[1].endLine}`)
  assert.ok(matches[0].endLine < matches[1].startLine, '两段不能重叠，且按行号升序')
  for (const m of matches) {
    assert.deepEqual(m.terms, [KEY])
    assert.match(m.snippet, new RegExp(KEY))
  }
})

test('deep-context ⑥：多文件多段 → 每篇各自带自己的片段', async () => {
  const root = makeWorkspace([
    ['docs/a.md', lines('# A', '', noise(25), `A 提到 ${KEY}。`)],
    ['docs/b.md', lines('# B', '', `B 开头就提到 ${KEY}。`, noise(25))],
    ['docs/c.md', lines('# C', '', noise(12), `C 中间提到 ${KEY}。`, noise(12))],
  ])
  const payload = await relevanceScan(root, KEY)

  const rels = payload.docs.filter((d) => d.score > 0).map((d) => d.rel)
  assert.deepEqual(rels.slice().sort(), ['docs/a.md', 'docs/b.md', 'docs/c.md'])
  for (const rel of rels) {
    const hit = pick(payload, rel)
    assert.ok(hit.matches.length >= 1, `${rel} 必须带片段`)
    assert.ok(hit.matches[0].terms.includes(KEY))
  }
})

test('deep-context ⑦：同样命中两次时，长文件不许因长度占优（§9）', async () => {
  // 60KB 的归档：目标词出现 2 次，但埋在噪声里。
  const archive = []
  archive.push('# 归档变更')
  for (let i = 0; i < 500; i++) archive.push(noiseLine(i + 1))
  archive.push(`顺带提到 ${KEY}。`)
  for (let i = 0; i < 500; i++) archive.push(noiseLine(i + 1000))
  archive.push(`又一次提到 ${KEY}。`)
  // 300 字左右的聚焦文档：目标词同样出现 2 次。
  const focus = lines('# 聚焦', '', '配置说明如下。', `${KEY} 是主开关。`, `再写一遍 ${KEY}。`, noise(3))

  const root = makeWorkspace([['archive/CHANGELOG.md', lines(archive)], ['docs/focus.md', focus]])
  const payload = await relevanceScan(root, KEY)

  const order = payload.docs.filter((d) => d.score > 0).map((d) => d.rel)
  assert.deepEqual(order, ['docs/focus.md', 'archive/CHANGELOG.md'],
    '长度归一化必须让聚焦短文排在长归档之前')
})

test('deep-context ⑧：代码命中落在函数附近', async () => {
  // alpha 必须**够长**（超过 PASSAGE_MIN_CHARS / 300 字），否则前几节会被
  // 合并规则并进 beta 那一段，片段就从文件头开始了 —— 那是切分口径，不是缺陷。
  const L = [
    "import { readFile } from 'node:fs/promises'",
    '',
    'const LIMIT = 100',
    '',
    '/** 甲函数：把输入规整一遍再交出去。 */',
    'export function alpha(n) {',
    '  const step = n + LIMIT',
    "  const padded = String(step).padStart(6, '0')",
    '  const parts = padded.split("")',
    "  const reversed = parts.reverse().join('-')",
    '  const upper = reversed.toUpperCase()',
    '  const again = upper.split("-").join("")',
    '  return again.length > 0 ? again : padded',
    '}',
    '',
    '/** 乙函数：这里用到了目标词。 */',
    'export function beta(n) {',
    `  const label = '${KEY}-' + n`,
    '  return label.toUpperCase()',
    '}',
    '',
    '/** 丙函数。 */',
    'export function gamma(n) {',
    '  return n - 1',
    '}',
  ]
  const betaStart = L.findIndex((l) => l.includes('乙函数')) + 1
  const keyLine = L.findIndex((l) => l.includes(KEY)) + 1
  const root = makeWorkspace([['src/target.mjs', L.join('\n')]])
  const payload = await relevanceScan(root, KEY, { kind: 'code' })

  const hit = pick(payload, 'src/target.mjs')
  const m = hit.matches[0]
  assert.ok(m.startLine <= keyLine && keyLine <= m.endLine,
    `片段必须覆盖第 ${keyLine} 行，实际 ${m.startLine}-${m.endLine}`)
  assert.ok(m.startLine >= betaStart,
    `结构化切分应让片段从 beta 那一节开始（第 ${betaStart} 行），实际从第 ${m.startLine} 行开始`)
  assert.ok(m.endLine <= L.length)
  assert.match(m.snippet, new RegExp(KEY))
})

test('deep-context ⑨：Markdown 命中贴着 heading 分段', async () => {
  const L = ['# 顶层', '', '## 概览', '']
  L.push(...noise(8))
  L.push('', '## 配置项', '')
  const headLine = L.length - 1 // 刚推入的是 ['', '## 配置项', '']，标题在倒数第二个
  L.push(`这一段讲的正是 ${KEY} 的配置方式。`)
  const keyLine = L.length
  L.push('', ...noise(8))

  const root = makeWorkspace([['docs/config.md', L.join('\n')]])
  const payload = await relevanceScan(root, KEY)

  const m = pick(payload, 'docs/config.md').matches[0]
  // 结构优先：片段**从标题那一行开始**（而不是从上一个段落的中途）。
  assert.equal(m.startLine, headLine, '片段应当从 heading 起算')
  assert.ok(m.startLine <= keyLine && keyLine <= m.endLine,
    `片段必须覆盖第 ${keyLine} 行，实际 ${m.startLine}-${m.endLine}`)
})

test('deep-context ⑩：零命中时没有片段，也没有编造出来的分', async () => {
  const root = makeWorkspace([['docs/empty.md', lines('# 无关', '', noise(30))]])
  const payload = await relevanceScan(root, KEY)

  assert.equal(payload.mode, 'relevance', '有关键词就还是相关性模式')
  assert.deepEqual(payload.keywords, [], '语料里没有这个词，matched 必须是空的')
  for (const d of payload.docs) {
    assert.equal('matches' in d, false, `${d.rel} 不该带 matches 键`)
    assert.equal(d.score, 0)
  }
})

test('deep-context ⑪：同分时按行号稳定排序，且两次跑逐字相同（§20）', async () => {
  // 两段**字节数完全相同**的文本（甲/乙 都是 1 个字符），于是分数必然相同。
  const block = (name) => [`## ${name}`, '', ...noise(9), `这里提到 ${KEY}。`, ...noise(2)]
  const body = lines(block('甲'), block('乙'))

  const keywords = [{ term: KEY, weight: 1 }]
  const entry = { body, kind: 'md', rel: 'same.md', mtimeMs: 1 }
  const first = passageMatchesFor(entry, keywords, 1)
  const second = passageMatchesFor(entry, keywords, 1)

  assert.equal(first.length, 2)
  assert.ok(first[0].endLine < first[1].startLine, '同分时按行号升序')
  assert.deepEqual(first, second, '同一输入必须两次逐字相同')

  // 反证：把输入顺序颠倒，结果不许变（并列排序不许依赖输入顺序）。
  const reordered = passageMatchesFor(
    { ...entry, body: lines(block('乙'), block('甲')) },
    keywords,
    1,
  )
  assert.deepEqual(first.map((m) => m.terms), reordered.map((m) => m.terms))
})

test('deep-context ⑫：文件改动后片段缓存失效，行号跟着变', async () => {
  const root = makeWorkspace([['shift.md', lines('# 位移', '', `${KEY} 在最前面。`, noise(30))]])
  const before = await relevanceScan(root, KEY)
  const firstLine = pick(before, 'shift.md').matches[0].startLine

  // 重写：把目标词挪到后面（mtime 由 fixture 定在 2 分钟前，写盘必然更新）。
  const movedLines = ['# 位移', '', ...noise(40), `${KEY} 挪到了后面。`]
  const keyLine = movedLines.length
  writeFileSync(join(root, 'shift.md'), movedLines.join('\n'))
  const after = await relevanceScan(root, KEY)
  const moved = pick(after, 'shift.md').matches[0]

  assert.ok(moved.startLine > firstLine, `行号必须跟着文件改动走：${firstLine} → ${moved.startLine}`)
  assert.ok(moved.startLine <= keyLine && keyLine <= moved.endLine,
    `片段必须覆盖第 ${keyLine} 行，实际 ${moved.startLine}-${moved.endLine}`)
})

test('deep-context ⑬：媒体不参与片段检索（§17）', async () => {
  const root = makeWorkspace([['docs/zephyrite-shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])]])
  const payload = await relevanceScan(root, KEY, { kind: 'all' })

  const media = payload.docs.find((d) => d.rel === 'docs/zephyrite-shot.png')
  assert.ok(media, '文件名命中时媒体仍进列表（v0.19 行为）')
  assert.equal('matches' in media, false, '媒体没有正文，不许有片段')
})

test('deep-context ⑭：片段的行号与偏移量恒等式成立（§11）', () => {
  const body = lines('# 标题', '', noise(30), `中间提到 ${KEY}。`, noise(30), `后面又提到 ${KEY}。`)
  const { passages } = chunkText(body, { kind: 'md' })
  assert.ok(passages.length > 1, '样本必须被切成多段')
  for (const p of passages) {
    assert.equal(body.slice(p.startOffset, p.endOffset), p.text, '偏移量必须能切回原文')
    assert.equal(p.body, p.text.toLowerCase())
    assert.ok(p.startLine >= 1 && p.endLine >= p.startLine)
  }
})

test('deep-context ⑮：windowTf 只数「同一个窗口里」的出现次数（D5 的长度无关量）', () => {
  // 不重叠计数（与 relevance.js 的 countOccurrences 同口径）：'aa' 在 'aaaa' 里是 2 次而不是 3 次
  assert.equal(windowTf('aaaa', 'aa', 4), 2)
  assert.equal(windowTf('aaaa', 'aa', 3), 1, '窗口放不下两处时只能算 1 次')

  // 两处相隔 102 个字符：窗口 200 装得下，收紧到 50 就只剩一处
  const spread = `${'x'.repeat(100)}zz${'x'.repeat(100)}zz`
  assert.equal(windowTf(spread, 'zz', 200), 2)
  assert.equal(windowTf(spread, 'zz', 50), 1)

  // 真实场景：29000 字的归档里出现两次 ⇒ 每次都是孤立的
  const huge = `${'x'.repeat(14000)}${KEY}${'x'.repeat(14000)}${KEY}`
  assert.equal(windowTf(huge, KEY, 1200), 1, '窗口 1200 只看得见一处')
  assert.equal(windowTf(huge, KEY, 40000), 2, '窗口拉到比文件还长就看得见两处')

  // 边界：空正文、空词都必须是 0 而不是 NaN
  assert.equal(windowTf('', 'zz'), 0)
  assert.equal(windowTf('zz', ''), 0)
})

test('deep-context ⑯：长归档不许靠整篇字频混进 Supporting（§9 / D5）', async () => {
  // 归档：两处 KEY 相隔约 4 万字 —— 整篇字频 2 次（旧口径「够格」），单窗口只有 1 次
  const archive = ['# 归档变更']
  for (let i = 0; i < 300; i++) archive.push(noiseLine(i + 1))
  archive.push(`顺带提到 ${KEY}。`)
  for (let i = 0; i < 900; i++) archive.push(noiseLine(i + 1000))
  archive.push(`又一次提到 ${KEY}。`)

  const root = makeWorkspace([
    ['archive/CHANGELOG.md', lines(archive)],
    // 聚焦短文：标题就命中（grounded ⇒ 够格进 Primary）
    ['docs/focus.md', lines(`# ${KEY} 配置`, '', `${KEY} 只在这里提一次。`)],
    // 正文命中但标题不命中：只有 isDocHit 这一条路能让它进 Supporting
    // （首段必须与命中词无关，否则摘要会命中 ⇒ grounded ⇒ 走的是另一条路）
    ['docs/notes.md', lines('# 随手记', '', '这一篇讲的是别的事情。', '', `${KEY} 与 ${KEY} 都在这一段里。`)],
  ])
  const payload = await relevanceScan(root, KEY)

  // 第一层保证（文件级）：长度归一化让聚焦短文排第一，长归档排后面
  assert.equal(payload.docs[0].rel, 'docs/focus.md')

  // 第二层保证（分层）：同一段里出现两次才算「这一篇在讲它」
  const pack = buildContext({ ranked: payload.ranked, topic: payload.topic, total: payload.total })
  const rels = (tier) => tier.map((e) => e.rel)
  assert.deepEqual(rels(pack.primary), ['docs/focus.md'])
  assert.ok(
    rels(pack.supporting).includes('docs/notes.md'),
    '同一段里出现两次的词必须能把这一篇抬进 Supporting（否则这条用例只是「什么都不放行」）',
  )
  assert.equal(
    rels(pack.supporting).includes('archive/CHANGELOG.md'),
    false,
    '两处散布在 4 万字里 ⇒ 单窗口只有 1 次，不许进 Supporting',
  )
})

test('R2 面板预算：/api/recent 的片段增量有界 —— ≤24 篇、每篇 ≤2 段、片段 ≤SNIPPET_CHARS+8', async () => {
  // 需求 §16：进上下文的要更精准、不是更多。面板载荷走的是本地 HTTP，不进模型上下文，
  // 但它仍然是**每一篇都可能被拼进去**的东西（`docs` 数组），所以同样要有上界。
  //
  // 实现说明 §7 的 R2 估算「≤10 KB / 每段 ~220 B」偏低了（漏算了 startOffset/endOffset/
  // terms/行号这些 JSON 元数据，每段 ≈110 B）；2026-10-07 真机压力语料实测
  // 24 篇 × 2 段 = 14.8 KB、每篇 615 B。这里把**实测上界**钉成断言（16 KB / 每篇 700 B），
  // 以后谁把每篇段数或片段长度加大，这条会先红。
  const extra = []
  for (let i = 1; i <= 30; i += 1) {
    extra.push([`docs/budget-${i}.md`, lines(
      `# 预算 ${i}`, '',
      noise(4), '',
      `命中：bramblefinch 在这一篇的第一处，${'后面继续展开细节，'.repeat(16)}`, '',
      noise(40), '',
      `再次命中：bramblefinch 在这一篇的第二处，${'同样继续展开细节，'.repeat(16)}`, '',
      noise(60),
    )])
  }
  const root = makeWorkspace(extra)
  const payload = publicScanPayload(await relevanceScan(root, 'bramblefinch'))

  const withMatches = payload.docs.filter((d) => Array.isArray(d.matches) && d.matches.length > 0)
  assert.ok(withMatches.length > 0, '要有带片段的记录，否则这条守卫是空的')
  assert.ok(
    withMatches.length <= PASSAGE_WINDOW,
    `带片段的记录 ${withMatches.length} 篇 > PASSAGE_WINDOW ${PASSAGE_WINDOW}`,
  )
  for (const doc of withMatches) {
    assert.ok(
      doc.matches.length <= PASSAGE_MAX_PER_FILE,
      `${doc.rel} 报了 ${doc.matches.length} 段 > 每篇上限 ${PASSAGE_MAX_PER_FILE}`,
    )
    for (const m of doc.matches) {
      for (const key of ['startLine', 'endLine', 'startOffset', 'endOffset', 'terms', 'snippet']) {
        assert.ok(key in m, `${doc.rel} 的片段少了 ${key}（§11 的最低要求）`)
      }
      assert.ok(
        m.snippet.length <= SNIPPET_CHARS + 8,
        `${doc.rel} 的片段 ${m.snippet.length} 字符 > ${SNIPPET_CHARS} + 8`,
      )
    }
  }

  const strip = (list) => list.map(({ matches, ...rest }) => rest)
  const before = JSON.stringify({ ...payload, docs: strip(payload.docs) }).length
  const after = JSON.stringify(payload).length
  const delta = after - before
  console.log(`    R2 面板实测：${withMatches.length} 篇带片段，载荷 ${before} → ${after} 字节`
    + `（+${delta}，每篇 ${(delta / withMatches.length).toFixed(0)} 字节）`)
  assert.ok(delta > 0, 'v0.20 应当比 v0.19 的载荷更大（否则守卫是假的）')
  assert.ok(delta <= 16000, `片段让载荷多出 ${delta} 字节 > 实测上界 16 KB`)
  assert.ok(
    delta / withMatches.length <= 700,
    `每篇多出 ${(delta / withMatches.length).toFixed(0)} 字节 > 实测上界 700 字节`,
  )
})
