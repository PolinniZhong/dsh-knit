/**
 * Knit v0.15 · **Context Snapshot / Delta / Usage 的行为测试**
 *
 * 这里测的是「Knit 把上下文交出去之后，到底发生了什么」——
 * Context Snapshot（交出去那一刻的三层排序）· Context Delta（两次之间谁进谁出）
 * · Usage（某次真实的读落在哪一层）。
 *
 * 六条纪律，每一条都对应一组用例：
 *   1. **无变化不记新快照** —— 否则 5 秒轮询会把同一份上下文记成几十份，Delta churn 全是噪音；
 *   2. **游标幂等** —— 同一批事件喂两遍，读只算一遍；
 *   3. **会话隔离** —— A 会话的读不许进 B 会话的报告；
 *   4. **内存有上限** —— 会话数 / 读过的篇数 / Delta 条数都有硬上限（LRU）；
 *   5. **失败降级** —— store 给错了、事件是 null、pack 是 undefined，都不许抛，只返回空结果；
 *   6. **没有分数** —— Usage 里只有计数与事实（`primaryFollowThrough` 是布尔，不是成功率）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createStore, activateAudit, isAudited, ingestEvents, noteSnapshot, usageFor, usageFrom,
  auditPayload, getAuditSummary, resetStore,
  MAX_SESSIONS, MAX_READS_PER_SESSION, MAX_DELTAS_PER_SESSION,
} from '../src/host/feedback.js'

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
    totals: { matched: 0, total: Number.isInteger(options.total) ? options.total : 10 },
  }
}

/** 造一批 read 事件：`pairs` 是 `[rel, seq]`。 */
function readEvents(pairs, startSeq = 100) {
  const events = []
  let seq = startSeq
  for (const [rel, at] of pairs) {
    const callId = `c${seq}`
    events.push({
      type: 'tool/call',
      seq,
      time: (at || seq) * 1,
      data: { turn: 1, step: 1, callId, name: 'read', arguments: JSON.stringify({ file_path: rel }) },
    })
    seq += 1
    events.push({
      type: 'tool/result',
      seq,
      time: (at || seq) * 1,
      data: { message: { role: 'tool', toolCallId: callId, source: { kind: 'tool', callId }, isError: false } },
    })
    seq += 1
  }
  return events
}

test('快照：第一次交出去只记快照，没有 Delta', () => {
  const store = createStore()
  const first = noteSnapshot(store, 's1', pack({ primary: ['a.md'], supporting: ['b.md'] }), { seq: 5, at: 100 })
  assert.ok(first.snapshot)
  assert.equal(first.delta, null)
  const usage = usageFor(store, 's1')
  assert.equal(usage.items.length, 2)
  assert.equal(usage.stats.churn.deltas, 0)
})

test('快照：内容完全相同就不记新快照（否则轮询会灌进几十份）', () => {
  const store = createStore()
  const p = pack({ primary: ['a.md'], supporting: ['b.md'], related: ['c.md'] })
  noteSnapshot(store, 's1', p, { seq: 5, at: 100 })
  assert.equal(noteSnapshot(store, 's1', p, { seq: 6, at: 200 }), null)
  assert.equal(noteSnapshot(store, 's1', p, { seq: 7, at: 300 }), null)
  const usage = usageFor(store, 's1')
  assert.equal(usage.stats.churn.deltas, 0)
  // 时间戳要跟着往前推，不能停在第一次
  assert.equal(usage.at, 300)
  assert.equal(usage.seq, 7)
})

test('变化：进 / 出 / 换层都记下来，churn 是累计值', () => {
  const store = createStore()
  noteSnapshot(store, 's1', pack({ primary: ['a.md'], supporting: ['b.md'], related: ['c.md'] }), { seq: 5, at: 100 })
  const second = noteSnapshot(store, 's1', pack({ primary: ['b.md'], supporting: ['d.md'], related: [] }), { seq: 20, at: 200 })
  assert.deepEqual(second.delta.appeared.map((x) => x.rel), ['d.md'])
  assert.deepEqual(second.delta.disappeared.map((x) => x.rel), ['a.md', 'c.md'])
  assert.deepEqual(second.delta.moved.map((x) => x.rel), ['b.md'])

  const usage = usageFor(store, 's1')
  assert.equal(usage.stats.churn.deltas, 1)
  assert.equal(usage.stats.churn.appeared, 1)
  assert.equal(usage.stats.churn.disappeared, 2)
  assert.equal(usage.stats.churn.moved, 1)
  assert.deepEqual(usage.delta.appeared.map((x) => x.rel), ['d.md'])
})

test('使用情况：读了 Primary 就是 primaryFollowThrough；读的是 Supporting 记进覆盖率', () => {
  const store = createStore()
  activateAudit(store, 's1')
  noteSnapshot(store, 's1', pack({
    primary: ['a.md'], supporting: ['b.md', 'c.md', 'd.md'], related: ['e.md'],
  }), { seq: 5, at: 100 })

  ingestEvents(store, 's1', readEvents([['a.md', 10], ['b.md', 11]], 100), { root: ROOT })
  const usage = usageFor(store, 's1')

  assert.equal(usage.stats.primaryRel, 'a.md')
  assert.equal(usage.stats.primaryFollowThrough, true)
  assert.equal(usage.stats.firstReadTier, 'primary')
  assert.equal(usage.stats.firstReadRel, 'a.md')
  assert.deepEqual(usage.stats.byTier.supporting, { total: 3, read: 1 })
  assert.equal(Number(usage.stats.supportingCoverage.toFixed(3)), 0.333)
  assert.equal(usage.stats.outside, 0)
  assert.equal(usage.stats.reads, 2)
  assert.equal(usage.stats.distinct, 2)
})

test('使用情况：快照之外的读如实记成 outside，不解释成「失败」', () => {
  const store = createStore()
  noteSnapshot(store, 's1', pack({ primary: ['a.md'] }), { seq: 5, at: 100 })
  ingestEvents(store, 's1', readEvents([['z.md', 50], ['y.md', 51]], 200), { root: ROOT })

  const usage = usageFor(store, 's1')
  assert.equal(usage.stats.outside, 2)
  assert.deepEqual(usage.stats.outsideReads.sort(), ['y.md', 'z.md'])
  assert.equal(usage.stats.primaryFollowThrough, false)
  assert.equal(usage.stats.firstReadTier, null)
  const outside = usage.reads.find((r) => r.rel === 'z.md')
  assert.equal(outside.tier, null)
  assert.equal(outside.outside, true)
})

test('使用情况：Knit 还没给过上下文就自己读了 ⇒ 那一篇算 outside（tier 为 null）', () => {
  const store = createStore()
  activateAudit(store, 's1')
  ingestEvents(store, 's1', readEvents([['a.md', 10]], 100), { root: ROOT })
  const usage = usageFor(store, 's1')
  assert.equal(usage.stats.outside, 1)
  assert.equal(usage.stats.firstReadTier, null)
  assert.equal(usage.stats.primaryFollowThrough, false)
})

test('使用情况：读的时候用的是**当时**那份快照，不是最新那份', () => {
  const store = createStore()
  // 第一份：a.md 在 Primary
  noteSnapshot(store, 's1', pack({ primary: ['a.md'], supporting: ['b.md'] }), { seq: 5, at: 100 })
  // 读发生在 seq 150 —— 此时生效的是第一份
  ingestEvents(store, 's1', readEvents([['a.md', 300]], 300), { root: ROOT })
  // 之后上下文换了：a.md 掉到 Related
  noteSnapshot(store, 's1', pack({ supporting: ['b.md'], related: ['a.md'] }), { seq: 400, at: 400 })

  const usage = usageFor(store, 's1')
  const row = usage.reads.find((r) => r.rel === 'a.md')
  // 行上是「当时」的层（primary），不是现在这份（related）
  assert.equal(row.firstTier, 'primary')
  assert.equal(row.tier, 'related')
})

test('幂等：同一批事件喂两遍，读只算一遍', () => {
  const store = createStore()
  noteSnapshot(store, 's1', pack({ primary: ['a.md'] }), { seq: 1, at: 1 })
  const events = readEvents([['a.md', 10]], 100)
  const first = ingestEvents(store, 's1', events, { root: ROOT })
  const second = ingestEvents(store, 's1', events, { root: ROOT })
  assert.equal(first.reads, 1)
  assert.equal(second.reads, 0)
  const usage = usageFor(store, 's1')
  assert.equal(usage.stats.reads, 1)
  assert.equal(usage.reads[0].count, 1)
})

test('幂等：同一篇读两次是 count 2，但仍然只算一个 distinct 篇目', () => {
  const store = createStore()
  noteSnapshot(store, 's1', pack({ supporting: ['b.md'] }), { seq: 1, at: 1 })
  ingestEvents(store, 's1', readEvents([['b.md', 10], ['b.md', 20]], 100), { root: ROOT })
  const usage = usageFor(store, 's1')
  assert.equal(usage.stats.reads, 2)
  assert.equal(usage.stats.distinct, 1)
  assert.equal(usage.reads[0].count, 2)
  assert.deepEqual(usage.stats.byTier.supporting, { total: 1, read: 1 })
})

test('隔离：两个会话各记各的，互不串味', () => {
  const store = createStore()
  noteSnapshot(store, 's1', pack({ primary: ['a.md'] }), { seq: 1, at: 1 })
  noteSnapshot(store, 's2', pack({ primary: ['x.md'] }), { seq: 1, at: 1 })
  ingestEvents(store, 's1', readEvents([['a.md', 10]], 100), { root: ROOT })

  assert.equal(usageFor(store, 's1').stats.primaryFollowThrough, true)
  assert.equal(usageFor(store, 's2').stats.reads, 0)
  assert.equal(usageFor(store, 's2').stats.primaryFollowThrough, false)
  assert.equal(usageFor(store, 's3'), null)

  resetStore(store, 's1')
  assert.equal(usageFor(store, 's1'), null)
  assert.ok(usageFor(store, 's2'))
})

test('审计开关：只对主动开启的会话记账（默认不攒数据）', () => {
  const store = createStore()
  assert.equal(isAudited(store, 's1'), false)
  assert.equal(activateAudit(store, 's1'), true)
  assert.equal(isAudited(store, 's1'), true)
  assert.equal(isAudited(store, 's2'), false)
  resetStore(store)
  assert.equal(isAudited(store, 's1'), false)
})

test('内存上限：读过的篇目按 LRU 砍到上限', () => {
  const store = createStore()
  noteSnapshot(store, 's1', pack({ related: [] }), { seq: 1, at: 1 })
  const pairs = []
  for (let i = 0; i < MAX_READS_PER_SESSION + 25; i += 1) pairs.push([`doc${i}.md`, i])
  ingestEvents(store, 's1', readEvents(pairs, 10), { root: ROOT })

  const usage = usageFor(store, 's1')
  assert.equal(usage.reads.length, MAX_READS_PER_SESSION)
  // 保留的是**最近**读的那批
  assert.equal(usage.reads[usage.reads.length - 1].rel, `doc${MAX_READS_PER_SESSION + 24}.md`)
  assert.equal(usage.reads.find((r) => r.rel === 'doc0.md'), undefined)
})

test('内存上限：会话数超上限时淘汰最久没碰的', () => {
  const store = createStore()
  for (let i = 0; i < MAX_SESSIONS + 3; i += 1) {
    noteSnapshot(store, `s${i}`, pack({ primary: ['a.md'] }), { seq: i, at: i })
  }
  assert.equal(store.sessions.size, MAX_SESSIONS)
  assert.equal(store.sessions.has('s0'), false)
  assert.equal(store.sessions.has(`s${MAX_SESSIONS + 2}`), true)
})

test('内存上限：Delta 只留最近若干条，churn 仍是累计值', () => {
  const store = createStore()
  noteSnapshot(store, 's1', pack({ primary: ['base.md'] }), { seq: 0, at: 0 })
  for (let i = 0; i < MAX_DELTAS_PER_SESSION + 5; i += 1) {
    noteSnapshot(store, 's1', pack({ primary: [`d${i}.md`] }), { seq: i + 1, at: i + 1 })
  }
  const usage = usageFor(store, 's1')
  const changes = MAX_DELTAS_PER_SESSION + 5
  // churn 是**累计**的：明细数组被砍到上限，但「变过几次」不砍
  assert.equal(usage.stats.churn.deltas, changes)
  assert.equal(usage.stats.churn.retained, MAX_DELTAS_PER_SESSION)
  assert.equal(store.sessions.get('s1').deltas.length, MAX_DELTAS_PER_SESSION)
  // 每一次替换都是「进一篇、出一篇」
  assert.equal(usage.stats.churn.appeared, changes)
  assert.equal(usage.stats.churn.disappeared, changes)
})

test('降级：store / 会话 / 事件给错，一律返回空结果，不抛', () => {
  const store = createStore()
  assert.deepEqual(ingestEvents(null, 's1', []), { ok: false, reads: 0, cursor: -1 })
  assert.equal(ingestEvents(store, '', []).ok, false)
  assert.equal(ingestEvents(store, 's1', null).ok, true)
  assert.equal(noteSnapshot(null, 's1', pack()), null)
  assert.equal(noteSnapshot(store, 's1', null), null)
  assert.equal(usageFor(null, 's1'), null)
  assert.equal(usageFor(store, 'nope'), null)
  assert.equal(activateAudit(null, 's1'), false)
  assert.equal(activateAudit(store, ''), false)
  // 坏事件不会把整批作废
  const bad = [null, { type: 'tool/call' }, { type: 'tool/call', seq: 1, data: { name: 'read', callId: 'c', arguments: 'not json' } }]
  assert.equal(ingestEvents(store, 's1', bad).ok, true)
})

test('给 Agent 的摘要：只有事实、没有分数；没可说的就返回空串', () => {
  const store = createStore()
  noteSnapshot(store, 's1', pack({ primary: ['a.md'], supporting: ['b.md', 'c.md'] }), { seq: 1, at: 1 })
  ingestEvents(store, 's1', readEvents([['a.md', 10], ['z.md', 11]], 100), { root: ROOT })

  const usage = usageFor(store, 's1')
  const summary = getAuditSummary(usage)
  assert.match(summary, /primary read \(a\.md\)/)
  assert.match(summary, /supporting 0\/2/)
  assert.match(summary, /1 read outside the pack/)
  assert.doesNotMatch(summary, /%|score|confidence/i)

  const payload = auditPayload(usage)
  assert.deepEqual(payload, {
    primaryRead: true,
    primaryRel: 'a.md',
    supportingRead: 0,
    supportingTotal: 2,
    readsOutside: 1,
    contextChanges: 0,
  })
  assert.equal(getAuditSummary(null), '')
  assert.equal(auditPayload(null), null)
})

test('Usage 的形状是稳定的（给面板与工具用的字段一个不少）', () => {
  const store = createStore()
  noteSnapshot(store, 's1', pack({ primary: ['a.md'], supporting: ['b.md'], related: ['c.md'] }), { seq: 1, at: 1 })
  const usage = usageFrom(store.sessions.get('s1'))
  assert.deepEqual(Object.keys(usage.stats).sort(), [
    'byTier', 'churn', 'distinct', 'firstReadAt', 'firstReadRel', 'firstReadTier',
    'outside', 'outsideReads', 'primaryFollowThrough', 'primaryRel', 'reads',
    'supportingCoverage',
  ])
  assert.equal(usage.stats.supportingCoverage, 0)
  assert.equal(usage.stats.churn.snapshots, 0)
})
