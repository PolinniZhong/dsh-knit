/**
 * Knit v0.17 · Document Lifecycle —— **单元层**
 *
 * 这一层只测三件事，全部是纯逻辑，不碰文件系统（版本标记用 `stat` 注入）：
 *
 *   1. 四态生命周期：`unread` / `read` / `updated_after_read` / `reread_after_update`
 *   2. 两个派生投影：最近读取（按事件 `seq` 认）与包外明细（当前层口径）
 *   3. 冻结与幂等：历史归因不漂移、`stats` 键集不变、同一事件重复派发不重复计数、
 *      拿不到版本标记就**不做变化判断**
 *
 * ⚠️ 规格里最要紧的一条纪律：`mtimeMs` 是**版本标记**，不是内容证明。它没变时不许说
 * 「内容没变」，拿不到时更不许猜（宁可少说，也不乱说）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createStore, activateAudit, ingestEvents, noteSnapshot, usageFor, usageFrom,
  lifecycleOf, latestReadOf, outsideDocsOf, markBackfilled, isBackfilled,
} from '../src/host/feedback.js'
import { publicUsage } from '../src/host/index.js'

const ROOT = '/w'

/** 造一份 Context Pack（只给测试要用的字段）。 */
function pack(options = {}) {
  const rows = (list) => (list || []).map((rel) => ({ rel }))
  return {
    mode: 'relevance',
    topic: options.topic || 'knit',
    task: options.task || '',
    primary: rows(options.primary),
    supporting: rows(options.supporting),
    related: rows(options.related),
    totals: { total: 10 },
  }
}

/**
 * 一次成功的读 = `tool/call` + `tool/result` 两件事（与宿主事件流同形）。
 * 归因认的是**结果**那件事的 seq，所以 `readAt('a.md', 10)` 记下来的是 seq 11。
 * @param {string} rel - 路径
 * @param {number} seq - `tool/call` 的 seq
 * @returns {object[]} 两件事
 */
function readAt(rel, seq) {
  const callId = `c${seq}`
  return [
    {
      type: 'tool/call',
      seq,
      time: seq,
      data: { turn: 1, step: 1, callId, name: 'read', arguments: JSON.stringify({ file_path: rel }) },
    },
    {
      type: 'tool/result',
      seq: seq + 1,
      time: seq + 1,
      data: { message: { role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, isError: false } },
    },
  ]
}

/** 一次**失败**的读（`isError: true`）—— 不算读过，也不许影响已有生命周期。 */
function failedRead(rel, seq) {
  const events = readAt(rel, seq)
  events[1].data.message.isError = true
  return events
}

/** 一次搜索类调用（`grep` / `glob` / `bash`）—— 命中不算读过。 */
function searchCall(name, seq) {
  const callId = `x${seq}`
  return [
    {
      type: 'tool/call',
      seq,
      time: seq,
      data: {
        turn: 1,
        step: 1,
        callId,
        name,
        arguments: JSON.stringify({ pattern: 'a', file_path: 'a.md', command: 'ls' }),
      },
    },
    {
      type: 'tool/result',
      seq: seq + 1,
      time: seq + 1,
      data: { message: { role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, isError: false } },
    },
  ]
}

/** 一个开着账的会话。 */
function audited(id) {
  const store = createStore()
  activateAudit(store, id)
  return store
}

/**
 * 一次成功读 + 注入「读那一刻」观察到的版本标记。
 * @param {object} store - store
 * @param {string} id - 会话 id
 * @param {string} rel - 路径
 * @param {number} seq - `tool/call` 的 seq
 * @param {number} mtimeMs - 这次读观察到的版本标记
 * @param {{statCalls: number}} [counter] - 可选：统计取样次数
 * @returns {object} `ingestEvents()` 的结果
 */
function readWith(store, id, rel, seq, mtimeMs, counter) {
  return ingestEvents(store, id, readAt(rel, seq), {
    root: ROOT,
    stat: () => {
      if (counter) counter.statCalls += 1
      return mtimeMs
    },
  })
}

const stateOf = (store, id) => store.sessions.get(id)
const statusOf = (usage, rel) => (usage.lifecycle[rel] || {}).status

/* ── 1. 四态 ─────────────────────────────────────────────────── */

test('未读：Context 里有它、但一次成功读都没有 → lifecycle 里根本不出现这篇', () => {
  const store = audited('s1')
  noteSnapshot(store, 's1', pack({ primary: ['a.md'] }), { seq: 1, at: 1 })
  const usage = usageFor(store, 's1', { mtimes: { 'a.md': 2000 } })

  assert.equal(usage.lifecycle['a.md'], undefined, '没有读证据就不出现在 lifecycle 里（UI 自行落回未读）')
  assert.deepEqual(usage.lifecycle, {})
  assert.equal(usage.recentRead, null)
})

test('已读：一次成功读 → read、count=1；拿不到当前版本标记也不会多加状态', () => {
  const store = audited('s1')
  noteSnapshot(store, 's1', pack({ primary: ['a.md'] }), { seq: 1, at: 1 })
  readWith(store, 's1', 'a.md', 10, 1000)

  const usage = usageFor(store, 's1')
  assert.equal(statusOf(usage, 'a.md'), 'read')
  assert.equal(usage.lifecycle['a.md'].count, 1)
  assert.equal(usage.lifecycle['a.md'].lastReadMtimeMs, 1000)
  assert.equal(usage.lifecycle['a.md'].changedAfterLastRead, false)
  assert.equal(usage.lifecycle['a.md'].rereadAfterChange, false)
  assert.equal(usage.lifecycle['a.md'].lastReadAt, 11, 'lastReadAt 是结果那件事的墙钟')
})

test('读后已更新：读之后当前版本标记变了 → updated_after_read', () => {
  const store = audited('s1')
  noteSnapshot(store, 's1', pack({ primary: ['a.md'] }), { seq: 1, at: 1 })
  readWith(store, 's1', 'a.md', 10, 1000)

  const usage = usageFor(store, 's1', { mtimes: { 'a.md': 2000 } })
  assert.equal(statusOf(usage, 'a.md'), 'updated_after_read')
  assert.equal(usage.lifecycle['a.md'].changedAfterLastRead, true)
  assert.equal(usage.lifecycle['a.md'].lastReadMtimeMs, 1000, '冻结的是读那一刻看到的标记')
  assert.equal(usage.lifecycle['a.md'].count, 1)
})

test('修改后已重新读取：变化之后又成功读了一次 → reread_after_update、count=2', () => {
  const store = audited('s1')
  noteSnapshot(store, 's1', pack({ primary: ['a.md'] }), { seq: 1, at: 1 })
  readWith(store, 's1', 'a.md', 10, 1000)
  // 当前标记已经是 2000（所以第一次读之后状态是 updated_after_read），这次读观察到 2000
  assert.equal(statusOf(usageFor(store, 's1', { mtimes: { 'a.md': 2000 } }), 'a.md'), 'updated_after_read')
  readWith(store, 's1', 'a.md', 20, 2000)

  const usage = usageFor(store, 's1')
  assert.equal(statusOf(usage, 'a.md'), 'reread_after_update')
  assert.equal(usage.lifecycle['a.md'].count, 2)
  assert.equal(usage.lifecycle['a.md'].lastReadMtimeMs, 2000)
  assert.equal(usage.lifecycle['a.md'].rereadAfterChange, true)
})

test('再次变化 → 回到读后已更新（判定优先级是硬顺序）', () => {
  const store = audited('s1')
  noteSnapshot(store, 's1', pack({ primary: ['a.md'] }), { seq: 1, at: 1 })
  readWith(store, 's1', 'a.md', 10, 1000)
  readWith(store, 's1', 'a.md', 20, 2000)

  const usage = usageFor(store, 's1', { mtimes: { 'a.md': 3000 } })
  assert.equal(statusOf(usage, 'a.md'), 'updated_after_read', 'changedAfterLastRead 先于 rereadAfterChange')
  assert.equal(usage.lifecycle['a.md'].rereadAfterChange, true, '旧事实仍然留着，只是不再是当前状态')
  assert.equal(usage.lifecycle['a.md'].count, 2)
})

test('同一版本重复读：count +1，不会变成「修改后已重新读取」', () => {
  const store = audited('s1')
  noteSnapshot(store, 's1', pack({ primary: ['a.md'] }), { seq: 1, at: 1 })
  readWith(store, 's1', 'a.md', 10, 1000)
  readWith(store, 's1', 'a.md', 20, 1000)

  const usage = usageFor(store, 's1', { mtimes: { 'a.md': 1000 } })
  assert.equal(statusOf(usage, 'a.md'), 'read')
  assert.equal(usage.lifecycle['a.md'].count, 2)
  assert.equal(usage.lifecycle['a.md'].rereadAfterChange, false)
})

/* ── 2. 哪些不算读 ───────────────────────────────────────────── */

test('失败的读不记账，也不影响已有的 lifecycle', () => {
  const store = audited('s1')
  noteSnapshot(store, 's1', pack({ primary: ['a.md', 'b.md'] }), { seq: 1, at: 1 })
  readWith(store, 's1', 'a.md', 10, 1000)
  ingestEvents(store, 's1', failedRead('b.md', 20), { root: ROOT, stat: () => 5000 })

  const usage = usageFor(store, 's1')
  assert.equal(usage.reads.length, 1, '失败读不产生 entry')
  assert.equal(usage.stats.reads, 1)
  assert.equal(statusOf(usage, 'b.md'), undefined)
  assert.equal(usage.lifecycle['a.md'].lastReadMtimeMs, 1000, '失败读连取样都不该发生')
})

test('grep / glob / bash 都不算读', () => {
  const store = audited('s1')
  noteSnapshot(store, 's1', pack({ primary: ['a.md'] }), { seq: 1, at: 1 })
  ingestEvents(store, 's1', searchCall('grep', 10), { root: ROOT, stat: () => 1000 })
  ingestEvents(store, 's1', searchCall('glob', 20), { root: ROOT, stat: () => 1000 })
  ingestEvents(store, 's1', searchCall('bash', 30), { root: ROOT, stat: () => 1000 })

  const usage = usageFor(store, 's1')
  assert.equal(usage.reads.length, 0)
  assert.deepEqual(usage.lifecycle, {})
  assert.equal(usage.recentRead, null)
  assert.equal(usage.stats.reads, 0)
})

/* ── 3. 最近读取 ─────────────────────────────────────────────── */

test('最近读取：按事件 seq 认最近一次，墙钟只用来显示相对时间', () => {
  const store = audited('s1')
  noteSnapshot(store, 's1', pack({ primary: ['a.md', 'b.md'] }), { seq: 1, at: 1 })
  readWith(store, 's1', 'a.md', 10, 1000)
  readWith(store, 's1', 'b.md', 20, 1000)

  const usage = usageFor(store, 's1')
  assert.equal(usage.recentRead.rel, 'b.md')
  assert.equal(usage.recentRead.seq, 21)
  assert.equal(usage.recentRead.tier, 'primary', '层的归因也是读那一刻冻结的')
  assert.equal(usage.recentRead.rank, 2)
  assert.equal(usage.recentRead.inside, true)

  readWith(store, 's1', 'a.md', 30, 1000)
  const next = usageFor(store, 's1')
  assert.equal(next.recentRead.rel, 'a.md', 'seq 更大者才是最近一次')
  assert.equal(next.recentRead.seq, 31)
})

test('最近读取照实返回包外文档（inside: false），不做任何解释', () => {
  const store = audited('s1')
  noteSnapshot(store, 's1', pack({ primary: ['a.md'] }), { seq: 1, at: 1 })
  readWith(store, 's1', 'docs/old-plan.md', 10, 1000)

  const usage = usageFor(store, 's1')
  assert.equal(usage.recentRead.rel, 'docs/old-plan.md')
  assert.equal(usage.recentRead.inside, false)
  assert.equal(usage.recentRead.tier, null)
})

/* ── 4. Context Gap（当前层）─────────────────────────────────── */

test('包外明细：当前包外、且真实成功读取过的文档，按首次读顺序排列', () => {
  const store = audited('s1')
  noteSnapshot(store, 's1', pack({ primary: ['a.md'], supporting: ['b.md'] }), { seq: 1, at: 1 })
  readWith(store, 's1', 'docs/old-plan.md', 10, 1000)
  readWith(store, 's1', 'docs/test-case.md', 20, 1000)
  readWith(store, 's1', 'docs/old-plan.md', 30, 1000)
  readWith(store, 's1', 'a.md', 40, 1000)

  const usage = usageFor(store, 's1')
  assert.deepEqual(usage.outsideDocs.map((row) => row.rel), ['docs/old-plan.md', 'docs/test-case.md'])
  assert.equal(usage.outsideDocs[0].count, 2, '明细行要能显示「已读 ×N」')
  assert.equal(usage.outsideDocs[1].count, 1)
  assert.equal(usage.outsideDocs[0].seq, 11, 'seq 是首次读那件事的 seq（排序依据）')
  assert.equal(usage.outsideDocs[0].lastReadAt, 31)
  assert.ok(!usage.outsideDocs.some((row) => row.rel === 'a.md'), '包内的读不算包外')
})

test('两个「包外」口径必须都留着：历史层不漂移，当前层随包变', () => {
  const store = audited('s1')
  // Epoch 1：a.md 在包里，读它 —— 这一读**发生在包内**
  noteSnapshot(store, 's1', pack({ primary: ['a.md'], supporting: ['b.md'] }), { seq: 10, at: 1000 })
  readWith(store, 's1', 'a.md', 20, 1000)
  // Epoch 2：换任务，a.md 掉出当前包
  noteSnapshot(store, 's1', pack({ topic: 'other', primary: ['c.md'] }), { seq: 40, at: 2000 })

  const usage = usageFor(store, 's1', { mtimes: { 'a.md': 1000 } })
  const row = usage.reads.find((item) => item.rel === 'a.md')
  assert.equal(row.firstRead.epochId, 1, '历史归因冻结在 Epoch 1')
  assert.equal(row.firstRead.tier, 'primary')
  assert.equal(row.firstRead.rank, 1)
  assert.equal(row.firstRead.inside, true)
  assert.equal(row.tier, 'primary', '兼容别名也是首次读的层')
  assert.equal(usage.stats.firstReadTier, 'primary')

  assert.equal(usage.stats.outside, 0, 'v0.16 口径：读发生在当时的包内 → 不算包外')
  assert.deepEqual(usage.stats.outsideReads, [])
  assert.deepEqual(usage.outsideDocs.map((item) => item.rel), ['a.md'], 'v0.17 口径：当前包外、被读过')
})

/* ── 5. 最近一次 Delta ───────────────────────────────────────── */

test('最近一次 Delta 只取最后一条，且与 delta 同引用（不新建 Delta Store）', () => {
  const store = audited('s1')
  noteSnapshot(store, 's1', pack({ primary: ['a.md'], supporting: ['b.md'], related: ['c.md'] }), { seq: 1, at: 1 })
  noteSnapshot(store, 's1', pack({ primary: ['b.md'], supporting: ['c.md'] }), { seq: 2, at: 2 })
  noteSnapshot(store, 's1', pack({ primary: ['b.md'], related: ['d.md'] }), { seq: 3, at: 3 })

  const state = stateOf(store, 's1')
  const usage = usageFor(store, 's1')
  assert.equal(usage.latestDelta, usage.delta, '同一个对象的两个引用')
  assert.equal(usage.latestDelta, state.deltas[state.deltas.length - 1])
  assert.deepEqual(usage.latestDelta.appeared.map((item) => item.rel), ['d.md'])
  assert.deepEqual(usage.latestDelta.disappeared.map((item) => item.rel), ['c.md'])
  assert.deepEqual(usage.latestDelta.moved, [])
  assert.equal(usage.latestDelta.fromEpoch, 2)
  assert.equal(usage.latestDelta.toEpoch, 3)
  assert.equal(usage.stats.churn.changes, 2, '三份包 = 两次变化')
  assert.equal(usageFrom(state).latestDelta, state.deltas[state.deltas.length - 1], '纯投影：再算一次还是同一条')
})

test('没有交过第二份包时 latestDelta 是 null（不编造变化）', () => {
  const store = audited('s1')
  noteSnapshot(store, 's1', pack({ primary: ['a.md'] }), { seq: 1, at: 1 })
  const usage = usageFor(store, 's1')
  assert.equal(usage.delta, null)
  assert.equal(usage.latestDelta, null)
})

/* ── 6. 幂等、冻结与确定性 ───────────────────────────────────── */

test('同一事件重复派发：count 只 +1，版本标记也只取一次样', () => {
  const store = audited('s1')
  noteSnapshot(store, 's1', pack({ primary: ['a.md'] }), { seq: 1, at: 1 })
  const counter = { statCalls: 0 }
  const events = readAt('a.md', 10)
  ingestEvents(store, 's1', events, { root: ROOT, stat: () => { counter.statCalls += 1; return 1000 } })
  ingestEvents(store, 's1', events, { root: ROOT, stat: () => { counter.statCalls += 1; return 9999 } })

  const usage = usageFor(store, 's1')
  assert.equal(usage.reads.length, 1)
  assert.equal(usage.reads[0].count, 1)
  assert.equal(usage.stats.reads, 1)
  assert.equal(counter.statCalls, 1, '重复派发不重复取样')
  assert.equal(usage.lifecycle['a.md'].lastReadMtimeMs, 1000, '第二次投喂不许改写冻结的标记')
})

test('不传 mtimes 时永远不出现 updated_after_read（拿不到证据就不说）', () => {
  const store = audited('s1')
  noteSnapshot(store, 's1', pack({ primary: ['a.md'] }), { seq: 1, at: 1 })
  readWith(store, 's1', 'a.md', 10, 1000)

  const usage = usageFor(store, 's1')
  assert.equal(statusOf(usage, 'a.md'), 'read')
  assert.equal(usage.lifecycle['a.md'].changedAfterLastRead, false)
  assert.ok(!JSON.stringify(usage.lifecycle).includes('updated_after_read'))
  // 什么都不传时四个新投影都老实退化
  const empty = usageFrom(stateOf(store, 's1'))
  assert.deepEqual(empty.outsideDocs, [])
  assert.equal(empty.latestDelta, null)
  assert.equal(Object.keys(empty.lifecycle).length, 1)
})

test('stats 键集冻结（v0.16 的 15 个，一个不多一个不少）', () => {
  const store = audited('s1')
  noteSnapshot(store, 's1', pack({ primary: ['a.md'], supporting: ['b.md'], related: ['c.md'] }), { seq: 1, at: 1 })
  const usage = usageFrom(stateOf(store, 's1'))
  assert.deepEqual(Object.keys(usage.stats).sort(), [
    'byTier', 'churn', 'continuedReadsAfterExit', 'distinct', 'firstReadAt', 'firstReadEpoch',
    'firstReadRel', 'firstReadTier', 'outside', 'outsideReads', 'primaryFollowThrough',
    'primaryRel', 'reEntries', 'reads', 'supportingCoverage',
  ])
  // 四个新投影在**顶层**，不许混进 stats
  assert.deepEqual(
    Object.keys(usage).filter((key) => ['lifecycle', 'recentRead', 'outsideDocs', 'latestDelta'].includes(key)).sort(),
    ['latestDelta', 'lifecycle', 'outsideDocs', 'recentRead'],
  )
})

test('确定性：同样的输入喂两个 store，逐字段 deepEqual', () => {
  const build = () => {
    const store = audited('s1')
    noteSnapshot(store, 's1', pack({ primary: ['a.md'], supporting: ['b.md'] }), { seq: 1, at: 1 })
    readWith(store, 's1', 'a.md', 10, 1000)
    readWith(store, 's1', 'docs/outside.md', 20, 1000)
    return usageFor(store, 's1', { mtimes: { 'a.md': 2000, 'docs/outside.md': 1000 } })
  }
  assert.deepEqual(build(), build())
})

/* ── 7. 兜底与线路裁剪 ───────────────────────────────────────── */

test('畸形输入不抛：lifecycleOf / latestReadOf / outsideDocsOf 的兜底', () => {
  assert.equal(lifecycleOf(null).status, 'unread')
  assert.equal(lifecycleOf(undefined, 100).status, 'unread')
  assert.equal(lifecycleOf({ count: 'x' }, 100).status, 'unread')
  assert.equal(lifecycleOf({ count: 2, lastReadMtimeMs: null, rereadAfterChange: true }, 500).status,
    'reread_after_update', '没有「上次读到的标记」就不做变化判断')
  assert.equal(lifecycleOf({ count: 2, lastReadMtimeMs: 1000, rereadAfterChange: false }, Number.NaN).status,
    'read', '当前标记缺失/非有限 → 不做变化判断')
  assert.equal(latestReadOf(null), null)
  assert.equal(latestReadOf([]), null)
  assert.deepEqual(outsideDocsOf(null, null), [])
  assert.deepEqual(outsideDocsOf([{ rel: 'a.md', count: 0, firstRead: { seq: 1 }, lastRead: { at: 1 } }], []), [],
    'count 为 0 的 entry 不算读过')
})

test('publicUsage：lifecycle 按 rels 裁剪、outsideDocs 按 limit 截断，四个新键都在', () => {
  const store = audited('s1')
  noteSnapshot(store, 's1', pack({ primary: ['a.md', 'b.md'] }), { seq: 1, at: 1 })
  readWith(store, 's1', 'a.md', 10, 1000)
  readWith(store, 's1', 'c.md', 20, 1000)

  const usage = usageFor(store, 's1', { mtimes: { 'a.md': 2000, 'c.md': 1000 } })
  const wire = publicUsage(usage, 20, new Set(['a.md']))
  assert.deepEqual(Object.keys(wire.lifecycle), ['a.md'], '只发真正会渲染的那些行')
  assert.equal(wire.lifecycle['a.md'].status, 'updated_after_read')
  assert.deepEqual(Object.keys(wire.lifecycle['a.md']).sort(), ['count', 'lastReadAt', 'status'],
    '线路上的每条只带 UI 要的三个字段（中文文案不进数据层）')
  assert.deepEqual(wire.outsideDocs.map((row) => row.rel), ['c.md'])
  assert.equal(wire.recentRead.rel, 'c.md')
  assert.equal(wire.latestDelta, wire.delta)
  assert.deepEqual(Object.keys(wire.stats).sort(), Object.keys(usage.stats).sort(), 'stats 键集一个字不动')

  const full = publicUsage(usage, 20, null)
  assert.deepEqual(Object.keys(full.lifecycle).sort(), ['a.md', 'c.md'], 'rels 省略时不裁剪')
  assert.equal(publicUsage(usage, 1).outsideDocs.length, 1, 'outsideDocs 按 limit 截断')
  assert.equal(publicUsage(null), null)
})

/* ── 8. 回填（v0.17 修订，用户拍板）────────────────────────────────
 *
 * 真实用法是**读完才想起来看面板**。闸门只在 `usage=1` 那一刻才开，所以开闸时
 * 要把会话已有的事件补一次（宿主的 `backfillFeedback`）。这一节钉住三件事：
 * 补记的读**按我们已知最早的那份包**归因（不许说成包外）、只影响第一份快照、
 * 以及「没回填的会话行为一字不变」。
 */

test('回填：补记的读归到「我们已知最早的那份包」，不是包外', () => {
  const store = audited('s1')
  // ① 开闸那一 tick：宿主先标记「这份状态的历史是补记的」
  assert.equal(isBackfilled(store, 's1'), false)
  assert.equal(markBackfilled(store, 's1'), true)
  assert.equal(isBackfilled(store, 's1'), true)
  // ② 顺序关键：**先记下手上这份包**（此刻还没有任何事件，所以 seq 钉在会话开头）
  noteSnapshot(store, 's1', pack({ primary: ['a.md'] }), { at: 5000 })
  assert.equal(stateOf(store, 's1').snapshots[0].seq, -1, '第一份快照必须在会话开头')
  // ③ 再把闸门开之前真实发生过的读补进来（面板打开前用户就已经读过了）
  ingestEvents(store, 's1', readAt('a.md', 10), { root: ROOT, stat: () => 1000 })

  const usage = usageFor(store, 's1', { mtimes: { 'a.md': 1000 } })
  assert.equal(usage.stats.reads, 1)
  assert.equal(usage.lifecycle['a.md'].status, 'read')
  assert.equal(usage.stats.firstReadTier, 'primary', '补记的读按第一份包归因')
  assert.equal(usage.stats.firstReadEpoch, 1)
  assert.equal(usage.stats.outside, 0, '说它是包外就是假话')
  assert.deepEqual(usage.outsideDocs, [])
  assert.equal(usage.recentRead.rel, 'a.md')
  assert.equal(usage.recentRead.inside, true)
})

test('没有回填的会话照旧：第一份包之前的读算包外（v0.16 行为一字不动）', () => {
  const store = audited('s1')
  ingestEvents(store, 's1', readAt('a.md', 10), { root: ROOT, stat: () => 1000 })
  noteSnapshot(store, 's1', pack({ primary: ['a.md'] }), { at: 5000 })

  const usage = usageFor(store, 's1', { mtimes: { 'a.md': 1000 } })
  assert.equal(usage.stats.reads, 1, '读照样记下来')
  assert.equal(usage.stats.outside, 1, '只是口径不同：没有它当时在包里的证据')
  assert.equal(usage.stats.firstReadTier, 'outside', '没有回填就没有可归的包，宁可说包外')
  // 「包外明细」看的是**当前**这份包：a.md 现在就在主要层里，所以它不是缺口。
  // 两个「包外」口径拆开正是 v0.16 的设计（历史层不漂移 / 当前层随包变）。
  assert.deepEqual(usage.outsideDocs, [], '历史归因是包外，但当前包里有它 ⇒ 不算缺口')
})

test('回填只影响第一份快照：第二份起照旧按事件水位归因（历史归因不漂移）', () => {
  const store = audited('s2')
  markBackfilled(store, 's2')
  noteSnapshot(store, 's2', pack({ primary: ['a.md'] }), { at: 1 })   // 第一份：seq = -1（会话开头）
  ingestEvents(store, 's2', readAt('a.md', 10), { root: ROOT, stat: () => 1000 })
  noteSnapshot(store, 's2', pack({ related: ['a.md'] }), { at: 2 })   // 第二份：seq = 当时的水位
  ingestEvents(store, 's2', readAt('a.md', 30), { root: ROOT, stat: () => 1000 })

  const state = stateOf(store, 's2')
  assert.equal(state.reads.get('a.md').count, 2)
  assert.equal(state.reads.get('a.md').firstRead.tier, 'primary', '补记那次按第一份包')
  assert.equal(state.reads.get('a.md').lastRead.tier, 'related', '后来那次按第二份包')
  assert.equal(state.reads.get('a.md').lastRead.epochId, 2, '归因钉在读的那一刻的 Epoch')

  const usage = usageFor(store, 's2', { mtimes: { 'a.md': 1000 } })
  assert.equal(usage.lifecycle['a.md'].status, 'read')
  assert.equal(usage.stats.firstReadTier, 'primary', '冻结的归因不因后来的上下文变化而重算')
})

test('回填与订阅幂等：同一个事件先被回填、再从订阅派发一次，count 只 +1', () => {
  const store = audited('s3')
  const events = readAt('a.md', 10)
  ingestEvents(store, 's3', events, { root: ROOT, stat: () => 1000 })   // 回填
  markBackfilled(store, 's3')
  noteSnapshot(store, 's3', pack({ primary: ['a.md'] }), { at: 1 })
  // 宿主之后照常按条派发同一个事件（顺序与真机一致：先 call 后 result）
  for (const event of events) {
    ingestEvents(store, 's3', [event], { root: ROOT, stat: () => 1000 })
  }

  const state = stateOf(store, 's3')
  assert.equal(state.reads.get('a.md').count, 1, '同一次读只算一次')
  assert.equal(usageFor(store, 's3', { mtimes: { 'a.md': 1000 } }).stats.reads, 1)
})
