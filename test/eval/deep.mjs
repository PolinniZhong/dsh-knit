/**
 * v0.20 Deep Context Retrieval · **深度评测语料与四个确定性指标**
 *
 * 需求 §23 点名了四个指标，本文件是它们唯一的定义处：
 *
 *   `DeepHitRate`         目标词**只在旧窗口（前 2500 字）之后**时，目标文件是否进入结果
 *   `PassageHit@1`        Top-1 文件的**第一个** passage 是否覆盖目标行
 *   `PassageRecall`       目标 passage 是否出现在该文件返回的 `matches` 里
 *   `LongDocNoiseRate`    「什么都提一句」的长归档文出现在 Primary / Supporting 的比例
 *
 * 三条纪律（与 `test/eval/fixture.mjs` 一致，写在这里免得下一个人踩）：
 *
 *   1. **不碰 v0.19 的基线。** 本文件是**新的一套**语料与指标（§22：两套并存），
 *      `test/eval.test.mjs` / `test/context-eval.test.mjs` 一个字不改。
 *   2. **确定性。** 所有 mtime 由 `makeWorkspace()` 定死；行号由构造式算术给出
 *      （先记 `l.length` 再 push，不手数行）；不依赖扫描序、异步序、对象插入序（§20）。
 *   3. **指标要能区分版本。** `DeepHitRate` 同时算一份**旧窗口模拟**
 *      （`LegacyDeepHitRate`：把正文截到前 2500 字再排序，即 v0.19 的口径）。
 *      如果两个数字一样，这个指标就是废的 —— 测试里对这条有断言。
 *
 * 跑法：`node --test test/deep-eval.test.mjs`（也走 `npm test`）。
 */
import { rmSync } from 'node:fs'
import { rankByRelevance, extractKeywords } from '../../src/host/relevance.js'
import { scan } from '../../src/host/index.js'
import { buildContext } from '../../src/host/context.js'
import { makeWorkspace } from '../fixture.mjs'

/** 旧版本（v0.19）的正文窗口。模拟它才能证明「窗口一开，命中率从 0 变成 1」。 */
export const LEGACY_HAYSTACK_CHARS = 2500

/** 一行与任务无关的正文 —— 长度稳定，便于把目标推到 2500 字之后。 */
function noiseLine(i) {
  return `第 ${i} 行：这一段与查询词毫无关系，只是把真正重要的那几行推到很靠后的位置去。`
}

/** 造一篇「长文档」，目标行按构造式计算行号（**不手数行**）。 */
function longDoc({ title, keys, lead = 120, tail = 12 }) {
  const l = [`# ${title}`, '']
  for (let i = 1; i <= lead; i += 1) l.push(noiseLine(i))
  const marks = []
  for (const key of keys) {
    l.push(`处理入口：${key} 的这个分支写在 src/handler.js 里。`)
    marks.push(l.length) // 1-based 行号
    for (let i = 1; i <= tail; i += 1) l.push(noiseLine(lead + i))
  }
  return { content: l.join('\n'), lines: marks }
}

/** 造一个长代码文件，目标行 = 函数声明那一行。 */
function longCode({ keys, lead = 110, tail = 10 }) {
  const l = ['// deep-code.mjs', "import { helper } from './helper.js'", '']
  for (let i = 1; i <= lead; i += 1) l.push(`// 填充注释第 ${i} 行：与这个查询没有关系。`)
  const marks = []
  for (const key of keys) {
    l.push(`export function ${key}Handler(input) {`)
    marks.push(l.length)
    l.push('  const value = helper(input)')
    l.push('  return value + 1')
    l.push('}')
    for (let i = 1; i <= tail; i += 1) l.push(`// 结尾填充第 ${i} 行。`)
  }
  return { content: l.join('\n'), lines: marks }
}

/** 长归档文：每个话题词都**只提一句**（「什么话题都提一句」的真实污染源）。 */
function longArchive(allKeys) {
  const l = ['# 归档 CHANGELOG', '']
  for (let i = 1; i <= 260; i += 1) l.push(`## 历史条目 ${i}`, `第 ${i} 次改动：顺手修了一点别的东西，与当前任务无关。`, '')
  l.push('## 杂项索引', '')
  for (const key of allKeys) l.push(`- 有一年 ${key} 这件事被顺带提过一次，细节在别处。`)
  return l.join('\n')
}

/** 六个用例共用的稀有词 —— 全部是造出来的，语料里只会出现在我们放的位置。 */
const KEYS = {
  lateDoc: 'obsidianquark',
  deepCode: 'marlinspike',
  tailDoc: 'glaciermoth',
  twinDoc: 'tungstenfin',
  headingDoc: 'peridotlynx',
  control: 'basaltcrow',
}

const ALL_KEYS = Object.values(KEYS)

/**
 * 六个用例。每条：
 *   - `files`    送进 `makeWorkspace()` 的文件
 *   - `target`   期望被找到的文件与**目标行**（1-based）
 *   - `deep`     目标是否落在旧窗口（2500 字）之后 —— 控制组为 `false`
 *   - `query`    交给 `scan()` 的自然语言查询
 */
export const DEEP_CASES = (() => {
  const cases = []

  // ① 目标在正文中段（约 6000 字之后）
  {
    const doc = longDoc({ title: 'late-doc', keys: [KEYS.lateDoc] })
    cases.push({
      id: 'late-doc',
      query: `where is ${KEYS.lateDoc} handled`,
      files: [['docs/late-doc.md', doc.content]],
      target: { rel: 'docs/late-doc.md', line: doc.lines[0] },
      deep: true,
    })
  }

  // ② 目标在代码文件的函数声明上（约 5000 字之后）
  {
    const code = longCode({ keys: [KEYS.deepCode] })
    cases.push({
      id: 'deep-code',
      query: `which function implements ${KEYS.deepCode}`,
      files: [['src/deep-code.mjs', code.content]],
      target: { rel: 'src/deep-code.mjs', line: code.lines[0] },
      deep: true,
    })
  }

  // ③ 目标在文档**尾部**（约 7000 字之后）
  {
    const doc = longDoc({ title: 'tail-doc', keys: [KEYS.tailDoc], lead: 160, tail: 3 })
    cases.push({
      id: 'tail-doc',
      query: `${KEYS.tailDoc} 的处理入口在哪`,
      files: [['docs/tail-doc.md', doc.content]],
      target: { rel: 'docs/tail-doc.md', line: doc.lines[0] },
      deep: true,
    })
  }

  // ④ 同一篇里**两处**命中，相隔 3500 字以上 ⇒ 两段都在 2500 之后
  {
    const doc = longDoc({ title: 'twin-doc', keys: [KEYS.twinDoc, KEYS.twinDoc], lead: 110, tail: 60 })
    cases.push({
      id: 'twin-doc',
      query: `${KEYS.twinDoc} 出现在哪几处`,
      files: [['docs/twin-doc.md', doc.content]],
      target: { rel: 'docs/twin-doc.md', line: doc.lines[0] },
      targetLines: doc.lines,
      deep: true,
    })
  }

  // ⑤ 目标出现在一个很深的 Markdown 标题行上
  {
    const doc = longDoc({ title: 'heading-doc', keys: [KEYS.headingDoc], lead: 140, tail: 6 })
    cases.push({
      id: 'heading-doc',
      query: `${KEYS.headingDoc} 这一节讲什么`,
      files: [['docs/heading-doc.md', doc.content]],
      target: { rel: 'docs/heading-doc.md', line: doc.lines[0] },
      deep: true,
    })
  }

  // ⑥ 控制组：目标就在**文件名**里 —— 旧窗口也能命中，用来证明指标不是「一律 0」
  {
    const body = [
      `# ${KEYS.control} 说明`,
      '',
      `${KEYS.control} 这个组件只有很短的一页文档，讲的是它的开关。`,
      '',
      '没有更多内容了。',
    ].join('\n')
    cases.push({
      id: 'control-title',
      query: `what is ${KEYS.control}`,
      files: [[`docs/${KEYS.control}.md`, body]],
      target: { rel: `docs/${KEYS.control}.md`, line: 3 },
      deep: false,
    })
  }

  return cases
})()

/** 每个用例的工作区都额外塞一份「什么都提一句」的长归档 + 两篇普通噪声文档。 */
function extraFiles() {
  return [
    ['archive/CHANGELOG.md', longArchive(ALL_KEYS)],
    ['docs/noise-a.md', '# 噪声 A\n\n与任务无关的一页。\n'],
    ['docs/noise-b.md', '# 噪声 B\n\n也与任务无关。\n'],
  ]
}

/**
 * 旧窗口模拟：v0.19 的 haystack 口径（**先截前 2500 字，再转小写**）。
 *
 * 只服务于 `LegacyDeepHitRate` 这一个数字 —— 它回答「如果正文还是只取前 2500 字，
 * 目标文件还会被找到吗」。不去碰真实的 `scan()`（那已经没有窗口了）。
 *
 * @param {object} c - 用例
 * @returns {{hits: string[]}} 命中旧窗口的文件相对路径
 */
export function legacyRanking(c) {
  const records = c.files.map(([rel, content]) => {
    const name = rel.split('/').pop()
    const head = content.slice(0, 4096)
    const cut = rel.lastIndexOf('/')
    return {
      rel,
      path: rel,
      name,
      kind: rel.endsWith('.md') ? 'md' : 'code',
      size: content.length,
      mtimeMs: 1_760_000_000_000,
      haystack: {
        title: name.toLowerCase(),
        summary: (cut >= 0 ? rel.slice(0, cut + 1) : '').toLowerCase(),
        body: head.slice(0, LEGACY_HAYSTACK_CHARS).toLowerCase(),
      },
    }
  })
  const keywords = extractKeywords([c.query], 30)
  const ranked = rankByRelevance(records, keywords, 1_760_000_000_000)
  // ⚠️ 「命中」= **真的匹配上了**（`raw > 0`），不是「出现在结果列表里」：
  // `rankByRelevance` 把没命中的文档也排在后面返回（面板要列全量），
  // 拿「在列表里」当命中，语料里再多噪声也永远 100% —— 这个指标就废了。
  return { hits: ranked.docs.filter((d) => d.raw > 0).map((d) => d.rel) }
}

/** 某个 passage 是否覆盖目标行。 */
function covers(match, line) {
  return Boolean(match) && match.startLine <= line && match.endLine >= line
}

/**
 * 跑完整套深度评测。
 *
 * @returns {Promise<{metrics: object, cases: object[]}>} 四指标 + 逐用例明细
 */
export async function runDeepEval() {
  const perCase = []

  for (const c of DEEP_CASES) {
    const root = makeWorkspace([...c.files, ...extraFiles()])
    let payload
    try {
      payload = await scan(root, 50, { sort: 'relevance', query: c.query, kind: 'context' })
    } finally {
      // 一次评测要造 6 个工作区、确定性用例还要跑两遍 —— 用完就删，
      // 别等退出时再统一清（`makeWorkspace` 的兜底监听仍在）。
      rmSync(root, { recursive: true, force: true })
    }

    const hit = payload.docs.some((d) => d.rel === c.target.rel)
    // 「进入结果」的严格口径：**被相关性检索真的命中**（`raw > 0`）。
    // 只看 `docs.some(...)` 是不够的 —— 那个列表里本来就躺着全部扫描到的文档，
    // 于是不管窗口开不开都是 100%（v0.19 的基线 0 就是这么被掩盖掉的）。
    const rankedTarget = payload.ranked.find((d) => d.rel === c.target.rel) || null
    const matched = Boolean(rankedTarget) && rankedTarget.raw > 0
    const rank = payload.docs.findIndex((d) => d.rel === c.target.rel)
    const target = payload.docs.find((d) => d.rel === c.target.rel) || null
    const matches = (target && Array.isArray(target.matches)) ? target.matches : []
    const wanted = c.targetLines || [c.target.line]

    // recall = 目标行**全部**被某一段覆盖（多命中用例要求两处都在）
    const recall = wanted.every((line) => matches.some((m) => covers(m, line)))
    const top = payload.docs[0] || null
    const topMatches = (top && Array.isArray(top.matches)) ? top.matches : []
    const passageHit1 = Boolean(top) && top.rel === c.target.rel
      && wanted.every((line) => topMatches.some((m) => covers(m, line)))

    const split = buildContext({ ranked: payload.ranked, topic: payload.topic, total: payload.total })
    const noisy = {
      primary: split.primary.some((d) => d.rel === 'archive/CHANGELOG.md'),
      supporting: split.supporting.some((d) => d.rel === 'archive/CHANGELOG.md'),
      related: split.related.some((d) => d.rel === 'archive/CHANGELOG.md'),
    }

    const legacy = legacyRanking(c)

    perCase.push({
      id: c.id,
      query: c.query,
      targetRel: c.target.rel,
      targetLines: wanted,
      deep: c.deep,
      hit: matched,
      legacyHit: legacy.hits.includes(c.target.rel),
      rank: rank >= 0 ? rank + 1 : 0,
      passageHit1,
      recall,
      noisy,
      matchRanges: matches.map((m) => `${m.startLine}-${m.endLine}`),
      topRel: top ? top.rel : '',
    })
  }

  const n = perCase.length
  const rate = (pick) => perCase.filter(pick).length / n
  const metrics = {
    DeepHitRate: rate((p) => p.hit),
    LegacyDeepHitRate: rate((p) => p.legacyHit),
    'PassageHit@1': rate((p) => p.passageHit1),
    PassageRecall: rate((p) => p.recall),
    LongDocNoiseRate: rate((p) => p.noisy.primary || p.noisy.supporting),
  }
  return { metrics, cases: perCase }
}

/** 把逐用例明细排成一张人看的表（`npm run` 之外由报告引用）。 */
export function formatDeepEval(result) {
  const head = 'id             deep  hit  legacy  top1  recall  rank  ranges                      archive'
  const rows = result.cases.map((p) => [
    p.id.padEnd(14),
    String(p.deep).padEnd(5),
    String(p.hit).padEnd(4),
    String(p.legacyHit).padEnd(6),
    String(p.passageHit1).padEnd(5),
    String(p.recall).padEnd(7),
    String(p.rank).padEnd(5),
    (p.matchRanges.join(',') || '-').padEnd(27),
    p.noisy.primary ? 'PRIMARY' : (p.noisy.supporting ? 'SUPPORTING' : (p.noisy.related ? 'related' : '-')),
  ].join(' '))
  const m = result.metrics
  return [head, ...rows, '',
    `DeepHitRate=${m.DeepHitRate} (legacy ${m.LegacyDeepHitRate})  PassageHit@1=${m['PassageHit@1']}`
    + `  PassageRecall=${m.PassageRecall}  LongDocNoiseRate=${m.LongDocNoiseRate}`].join('\n')
}
