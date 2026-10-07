/**
 * 相关性排序的**离线质量回归**。
 *
 * 这是 v0.6 引入的新交付物（PRD §6.1）：排序质量第一次有了可重复的刻度，
 * 而且此后任何改动都不许把它弄坏 —— 包括「不小心把 BM25 换回加权命中」。
 *
 * 阈值不是拍脑袋的常数，而是**每次运行时自己算出来的基线**：
 * `test/eval/legacy.mjs` 冻结了 v0.5.2 的抽取与排序，所以
 * 「新引擎必须显著优于旧引擎」这句话是可以自动验证的（PRD §6.2）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  runEval, CASES, CODE_CASES, CODE_CORPUS, V019_MD_ONLY, V019_WITH_CODE, NOISE_RELS,
} from './eval/fixture.mjs'
import { extractKeywordsLegacy, rankByRelevanceLegacy } from './eval/legacy.mjs'
import { extractKeywords, rankByRelevance } from '../src/host/relevance.js'

/** 要求的最小提升幅度（PRD §6.2）。 */
const MIN_TOP1_GAIN = 0.15
const MIN_MRR_GAIN = 0.10
/** 绝对下限。 */
const MIN_TOP1 = 0.8
const MIN_MRR = 0.85

const baseline = runEval(extractKeywordsLegacy, rankByRelevanceLegacy)
const current = runEval(extractKeywords, rankByRelevance)

/** 百分比，便于失败信息阅读。 */
const pct = (x) => `${(x * 100).toFixed(1)}%`

test('评测集: 新引擎的 top-1 显著优于 v0.5.2 基线', () => {
  assert.ok(
    current.top1Rate >= baseline.top1Rate + MIN_TOP1_GAIN,
    `top-1 提升不足：基线 ${pct(baseline.top1Rate)} → 现在 ${pct(current.top1Rate)}，`
    + `要求至少 +${pct(MIN_TOP1_GAIN)}。未命中：${current.misses.map((m) => `${m.name}(得 ${m.got}，期望 ${m.want})`).join('；')}`,
  )
  assert.ok(
    current.top1Rate >= MIN_TOP1,
    `top-1 低于绝对下限：${pct(current.top1Rate)} < ${pct(MIN_TOP1)}`,
  )
})

test('评测集: 新引擎的 MRR 显著优于 v0.5.2 基线', () => {
  assert.ok(
    current.mrr >= baseline.mrr + MIN_MRR_GAIN,
    `MRR 提升不足：基线 ${baseline.mrr.toFixed(3)} → 现在 ${current.mrr.toFixed(3)}，要求至少 +${MIN_MRR_GAIN}`,
  )
  assert.ok(current.mrr >= MIN_MRR, `MRR 低于绝对下限：${current.mrr.toFixed(3)} < ${MIN_MRR}`)
})

test('评测集: 两个「陷阱」用例必须全部翻正', () => {
  // 陷阱有两种：对话里塞满项目名（高频词），以及什么话题都提一句的长归档。
  // 它们是 PRD §三 的三个失效场景的直接化身，一个都不许失守。
  assert.deepEqual(
    current.trapViolations, [],
    `不该排第一的文档排了第一：${current.trapViolations.map((v) => `${v.name} → ${v.offender}`).join('；')}`,
  )
})

test('评测集: 基线已经答对的用例，一条都不许变错', () => {
  // 只看「基线拿第一」的那些用例 —— 基线答错的用例不构成约束（那正是要修的）。
  const regressions = []
  baseline.ranks.forEach((rank, index) => {
    if (rank !== 1) return
    if (current.ranks[index] !== 1) {
      regressions.push(`第 ${index + 1} 个用例：基线第 1 名，现在第 ${current.ranks[index] || '未命中'} 名`)
    }
  })
  assert.deepEqual(regressions, [], `出现回归：${regressions.join('；')}`)
})

test('评测集: 排序不能退化成一枝独秀', () => {
  // 「只有一篇有分、其余全 0」的排序没有信息量，名次是假的。
  // 这个指标是 v0.6 开发中真实踩过的坑（第一版语料没让项目名铺开，整个评测都在
  // 比较「唯一命中的那篇」），留在这里防止语料或引擎悄悄退化成那样。
  assert.ok(
    current.degenerate < current.total / 2,
    `退化排序过多：${current.degenerate}/${current.total} 个用例只有一篇文档有分`,
  )
})

/* ── v0.19：Code Context 的两臂对比 ──────────────────────────────────
 *
 * 上面那群用例量的是「v0.19 之前的 Knit」在**文档语料**上的排序。V0.19 的新问题
 * 不是「代码能不能显示」，而是两件事，必须分开量：
 *
 *   1. 代码进了同一个语料池之后，**原有文档检索质量有没有被挤下去**（corpus pressure）
 *   2. 代码任务本身**能不能被排到第一**（code recall）
 *
 * 两个臂的语料形状只差一个 `CODE_CORPUS`（`V019_WITH_CODE` = `V019_MD_ONLY` + 代码），
 * 所以差值是**同一池子加料前后**的净效果，不是两份不同语料的对比。
 * ⚠️ 这个评测集**不是难度竞赛**：三条代码用例都是清晰的检索意图，两臂都接近满分。
 * 它的作用是**回归钉** —— 谁把代码候选、噪声过滤或字段权重改坏了，这里会红。
 */
const v019 = {
  docsMdOnly: runEval(extractKeywords, rankByRelevance, V019_MD_ONLY, CASES),
  docsWithCode: runEval(extractKeywords, rankByRelevance, V019_WITH_CODE, CASES),
  codeMdOnly: runEval(extractKeywords, rankByRelevance, V019_MD_ONLY, CODE_CASES),
  codeWithCode: runEval(extractKeywords, rankByRelevance, V019_WITH_CODE, CODE_CASES),
  mixed: runEval(extractKeywords, rankByRelevance, V019_WITH_CODE, [...CASES, ...CODE_CASES]),
}

test('v0.19 评测集: 加入代码语料之后，文档检索一条都不许变差', () => {
  const before = v019.docsMdOnly
  const after = v019.docsWithCode

  assert.ok(
    after.top1Rate >= before.top1Rate,
    `文档 top-1 掉下去了：Markdown only ${pct(before.top1Rate)} → +Code ${pct(after.top1Rate)}。`
    + `这最可能是 candidate cap / 权重 / 噪声过滤 / corpus admission 里的哪一项，`
    + `报告里要点名，**不要**先想着换算法。`,
  )
  assert.ok(
    after.mrr >= before.mrr,
    `文档 MRR 掉下去了：${before.mrr.toFixed(3)} → ${after.mrr.toFixed(3)}`,
  )

  // 逐条比对：原来第一的，现在还得是第一。整体率相同也可能是「翻正一条、弄坏一条」。
  const broke = []
  before.ranks.forEach((rank, index) => {
    if (rank !== 1) return
    if (after.ranks[index] !== 1) {
      broke.push(`${CASES[index].name}：${pct(1)} → 第 ${after.ranks[index] || '未命中'} 名`)
    }
  })
  assert.deepEqual(broke, [], `加入代码后文档用例被顶掉：${broke.join('；')}`)
})

test('v0.19 评测集: 代码用例在「只有文档」的池子里必然全军覆没', () => {
  // 这条是上一条的**对照臂**：如果代码用例在没有代码的池子里也能答对，
  // 那「加了代码之后答对了」就什么也没证明。
  assert.equal(
    v019.codeMdOnly.top1Rate, 0,
    `代码用例在纯文档语料里不该命中，却命中了 ${pct(v019.codeMdOnly.top1Rate)}`,
  )
})

test('v0.19 评测集: 代码任务可以被排到第一（code recall）', () => {
  const code = v019.codeWithCode
  assert.ok(
    code.top1Rate >= MIN_TOP1,
    `代码 top-1 低于下限：${pct(code.top1Rate)} < ${pct(MIN_TOP1)}；`
    + `未命中：${code.misses.map((m) => `${m.name}(得 ${m.got}，期望 ${m.want})`).join('；')}`,
  )
  assert.ok(code.mrr >= MIN_MRR, `代码 MRR 低于下限：${code.mrr.toFixed(3)} < ${MIN_MRR}`)
  // 三条用例的「不该排第一」约束（任务里根本没提的池内条目）一条都不许犯。
  assert.deepEqual(
    code.trapViolations, [],
    `不该排第一的排了第一：${code.trapViolations.map((v) => `${v.name} → ${v.offender}`).join('；')}`,
  )
})

test('v0.19 评测集: 混合语料的整体 MRR —— 文档与代码一起量，不是各算一半', () => {
  const mixed = v019.mixed
  assert.ok(
    mixed.top1Rate >= MIN_TOP1,
    `混合 top-1 低于下限：${pct(mixed.top1Rate)}；未命中：`
    + mixed.misses.map((m) => `${m.name}(得 ${m.got}，期望 ${m.want})`).join('；'),
  )
  assert.ok(mixed.mrr >= MIN_MRR, `混合 MRR 低于下限：${mixed.mrr.toFixed(3)} < ${MIN_MRR}`)
})

test('v0.19 评测集: 混合场景里文档没有被代码挤出去（Case C 的文档仍在候选前列）', () => {
  // 需求 §18 的反面：不能「因为是 Code 就天然优先」。Case C（session context 的实现）
  // 的正确答案是一篇代码，但同一语料里那篇讲分层的设计文档必须**还在前排**，
  // 否则就说明代码把文档挤没了 —— 那正是 corpus pressure 失效的样子。
  const c = CODE_CASES.find((x) => x.name.includes('混合'))
  const kw = extractKeywords(c.messages, 30)
  const ranked = rankByRelevance(V019_WITH_CODE, kw, 1_760_000_000_000).docs
  const at = ranked.findIndex((d) => d.rel === 'docs/architecture.md')

  assert.equal(ranked[0].rel, c.expect, '代码用例的 top-1 仍是它自己')
  assert.ok(
    at >= 0 && at < 3,
    `设计文档被挤到了第 ${at < 0 ? '未命中' : at + 1} 名 —— 代码不该把文档挤没`,
  )
})

test('v0.19 评测集: 生成 / 噪声路径一条都不在语料里', () => {
  const pool = new Set(V019_WITH_CODE.map((d) => d.rel))
  const leaked = NOISE_RELS.filter((rel) => pool.has(rel))
  assert.deepEqual(leaked, [], `噪声路径漏进了评测语料：${leaked.join('、')}`)

  // 噪声率：代码用例的 top-1 落在噪声路径上的比例，必须是 0。
  const kw = CODE_CASES.map((c) => extractKeywords(c.messages, 30))
  const noiseTop = kw.filter((keywords, i) => NOISE_RELS.includes(
    rankByRelevance(V019_WITH_CODE, keywords, 1_760_000_000_000).docs[0].rel,
  ))
  assert.equal(noiseTop.length / CODE_CASES.length, 0, '噪声成为 top-1 的比例必须是 0')
  assert.equal(
    V019_WITH_CODE.length, V019_MD_ONLY.length + CODE_CORPUS.length,
    '加料前后的语料差必须**只有**代码 —— 差出别的说明夹具被改了，两臂的对比就无效了',
  )
})
