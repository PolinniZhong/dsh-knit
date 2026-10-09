/**
 * v0.20 · **规模门槛（R1）**：全文检索轮到 5 秒轮询了没有？
 *
 * 实现说明 §7 R1 的硬门槛（`1000 文件 totalMs <= 1500`）如果只写在
 * `tools/deep-benchmark.mjs` 里，那它就是「跑过一遍的记录」，不是门 —— 改坏了没人知道。
 * 所以这里用**同一个**语料工厂（`makeScaleWorkspace`）跑一条小规模但同形状的门槛：
 *
 *   1. 1000 个文件（四类混合：小 md / 中 md / 大 md / 大代码）
 *   2. 冷扫打一次带 query 的 `scan()` —— 这**正是**客户端每 5 秒轮询打的那条路
 *      （`/knit/api/recent` → `scan()`，`POLL_MS = 5000`）
 *   3. 断言 `totalMs <= 1500`（R1 门槛）与 `warmMs <= 500`（热扫必须远低于 5 秒）
 *
 * ⚠️ 门槛是**量级**断言（实测 ~160ms vs 1500ms，十倍余量），不是性能回归曲线；
 * 真机曲线看 `node tools/deep-benchmark.mjs`。语料上限由 `MAX_DOCS = 400` /
 * `MAX_CODE = 300` 决定 —— 1000 个文件在盘上，进池的是 400 + 100（10% 是代码）。
 *
 * 跑法：`node --test test/deep-scale.test.mjs`（也走 `npm test`）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeScaleWorkspace, timeWorkspace, GATES, SIZES } from './deep-corpus.mjs'
import { scan } from '../src/host/index.js'

test('规模门槛 R1：1000 文件、带 query 的完整 scan 必须远低于 5 秒轮询', async () => {
  const ws = makeScaleWorkspace(1000, 'knit-scale-test')
  try {
    const r = await timeWorkspace(ws.root)

    // 语料真的造出来了、也真的被上限截过（否则这条门槛测的是空气）
    assert.ok(r.counts.scanned > 0, '扫到了文件')
    assert.ok(r.counts.docs <= 400, `文档池受 MAX_DOCS 约束：${r.counts.docs}`)
    assert.ok(r.counts.code <= 300, `代码池受 MAX_CODE 约束：${r.counts.code}`)
    assert.ok(r.ranked > 0, '排序结果非空')

    assert.ok(r.totalMs <= GATES.synthetic1000Ms,
      `R1 硬门槛：1000 文件冷扫 ${r.totalMs.toFixed(0)}ms 必须 <= ${GATES.synthetic1000Ms}ms`)
    assert.ok(r.warmMs <= 500,
      `热扫（缓存命中）${r.warmMs.toFixed(0)}ms 必须远低于 POLL_MS = 5000ms`)
  } finally {
    ws.cleanup()
  }
})

test('规模门槛 R1：语料档位与门槛常量就是实现说明里写的那几个', () => {
  assert.deepEqual(SIZES, [100, 500, 1000], '§18 点名的三档')
  assert.equal(GATES.synthetic1000Ms, 1500, '合成语料门槛')
  assert.equal(GATES.realMs, 1200, '真实工作区门槛')
})

test('规模门槛 R1：同一份语料两次 scan 的相对顺序逐字相同（§20）', async () => {
  const ws = makeScaleWorkspace(120, 'knit-scale-det')
  try {
    const a = await scan(ws.root, 400, { sort: 'relevance', query: 'handler', kind: 'context' })
    const b = await scan(ws.root, 400, { sort: 'relevance', query: 'handler', kind: 'context' })
    assert.deepEqual(a.docs.map((d) => d.rel), b.docs.map((d) => d.rel),
      '文件序不许受扫描序 / 缓存命中影响')
    assert.deepEqual(a.docs.map((d) => (d.matches || []).map((m) => `${m.startLine}-${m.endLine}`).join(',')),
      b.docs.map((d) => (d.matches || []).map((m) => `${m.startLine}-${m.endLine}`).join(',')),
      '片段行区间同样要稳定')
  } finally {
    ws.cleanup()
  }
})
