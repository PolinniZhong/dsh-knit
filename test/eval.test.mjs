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

import { runEval } from './eval/fixture.mjs'
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
