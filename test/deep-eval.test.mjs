/**
 * v0.20 Deep Context Retrieval · **深度评测**（需求 §22 / §23）
 *
 * 守四个确定性指标（定义在 `test/eval/deep.mjs`，本文件只做断言）：
 *
 *   DeepHitRate        ≥ 1.0   目标词只在旧窗口之后时，目标文件必须被命中
 *   PassageHit@1       ≥ 0.8   Top-1 文件的第一个 passage 覆盖目标行
 *   PassageRecall      ≥ 0.8   目标 passage 出现在该文件的 `matches` 里
 *   LongDocNoiseRate   = 0     长归档文不得进 Primary / Supporting
 *
 * 外加两条「这个指标是不是废的」自检：
 *   - 旧窗口模拟（v0.19 口径）必须**几乎全灭**（只有控制组命中）——
 *     如果新旧一样，说明用例根本没把目标推到窗口之后。
 *   - 同一次评测跑两遍必须**逐字相同**（需求 §20 的确定性）。
 *
 * 与 v0.19 的两套基线的关系（§22）：`test/eval.test.mjs` 与
 * `test/context-eval.test.mjs` 一个字都没改，它们继续守着老语料上的
 * `MIN_TOP1_GAIN = 0.15` / `MIN_MRR_GAIN = 0.10` / `MIN_TOP1 = 0.8` / `MIN_MRR = 0.85`。
 * 本文件是**第二套**指标，不替换它们。
 *
 * 跑法：`node --test test/deep-eval.test.mjs`（也走 `npm test`）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { DEEP_CASES, runDeepEval, formatDeepEval, LEGACY_HAYSTACK_CHARS } from './eval/deep.mjs'

/** 行号 → 该行之前的字符数（用来证明目标确实在旧窗口之外）。 */
function offsetOfLine(content, line) {
  return content.split('\n').slice(0, line - 1).join('\n').length
}

test('deep-eval 夹具自检：标了 deep 的用例，目标行确实在旧窗口之外', () => {
  const deep = DEEP_CASES.filter((c) => c.deep)
  assert.ok(deep.length >= 5, `至少有 5 条深度用例，实际 ${deep.length}`)
  for (const c of deep) {
    const [rel, content] = c.files[0]
    const wanted = c.targetLines || [c.target.line]
    for (const line of wanted) {
      const offset = offsetOfLine(content, line)
      assert.ok(offset > LEGACY_HAYSTACK_CHARS,
        `${c.id} 的第 ${line} 行只落在第 ${offset} 字 —— 没推到 ${LEGACY_HAYSTACK_CHARS} 字之后，用例是假的`)
    }
  }
  // 控制组必须**不是**深度用例：它证明指标不是「一律 0」
  const control = DEEP_CASES.filter((c) => !c.deep)
  assert.equal(control.length, 1, '恰好一条控制组（目标在文件名里）')
})

test('deep-eval：四个指标（§23）—— DeepHitRate / PassageHit@1 / PassageRecall / LongDocNoiseRate', async () => {
  const { metrics, cases } = await runDeepEval()

  assert.equal(metrics.DeepHitRate, 1,
    `目标词在旧窗口之后时也必须命中：${JSON.stringify(cases.map((c) => [c.id, c.hit]))}`)
  assert.ok(metrics.LegacyDeepHitRate <= 0.2,
    `旧窗口模拟必须几乎全灭（只有控制组命中），实际 ${metrics.LegacyDeepHitRate} —— 新旧一样就说明指标是废的`)
  assert.ok(metrics['PassageHit@1'] >= 0.8, `PassageHit@1 = ${metrics['PassageHit@1']}`)
  assert.ok(metrics.PassageRecall >= 0.8, `PassageRecall = ${metrics.PassageRecall}`)
  assert.equal(metrics.LongDocNoiseRate, 0,
    '长归档文（什么都提一句）不得进 Primary / Supporting')

  // 逐用例的硬要求：命中的文件必须真的带回 `matches`，且行区间覆盖目标行
  for (const c of cases) {
    assert.ok(c.rank >= 1, `${c.id} 必须出现在结果里`)
    assert.notEqual(c.matchRanges.length, 0, `${c.id} 必须带回命中片段`)
    assert.equal(c.noisy.supporting, false, `${c.id}：归档文不得进 Supporting`)
    assert.equal(c.noisy.primary, false, `${c.id}：归档文不得进 Primary`)
  }
  // 旧的 v0.19 语料与基线没被这次评测牵动（§22）——这里只记录，不改它
  assert.ok(formatDeepEval({ metrics, cases }).includes('DeepHitRate=1'))
})

test('deep-eval：指标里不许出现任何 AI 分数 / 置信度（§23 / §26）', async () => {
  const { metrics } = await runDeepEval()
  const keys = Object.keys(metrics).join(',')
  for (const banned of ['contextScore', 'confidence', 'aiScore', 'relevanceScore']) {
    assert.ok(!keys.includes(banned), `不许新增 ${banned}`)
  }
  // 四个名字就是全部（多一个都要先过需求 §23 这一关）
  assert.deepEqual(Object.keys(metrics).sort(),
    ['DeepHitRate', 'LegacyDeepHitRate', 'LongDocNoiseRate', 'PassageHit@1', 'PassageRecall'].sort())
})

test('deep-eval：同一份语料跑两遍，逐字相同（需求 §20 确定性）', async () => {
  const a = await runDeepEval()
  const b = await runDeepEval()
  assert.deepEqual(a.cases, b.cases,
    '文件序 / 名次 / 行区间 / 片段在两次运行之间必须完全一致')
  assert.deepEqual(a.metrics, b.metrics)
})
