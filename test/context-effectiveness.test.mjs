/**
 * Knit v0.16 · **Context Effectiveness 的行为测试**（SDD §24.3 / §24.4 / §24.5 / §24.6）。
 *
 * 这里只测 v0.15 里**做不到**的那件事：一次读落在哪一层，必须**在读发生的那一刻**结算并冻结，
 * 之后上下文怎么换都不许改口。
 *
 *   1. **历史归因**（§24.3）—— 读发生在 Epoch 1、出报告时已经是 Epoch 2，`tier` / `rank` /
 *      `inside` / `epochId` 仍然是 Epoch 1 的值；
 *   2. **持续性**（§24.4）—— 离开上下文之后还读 ⇒ 记成事实 `continuedReadAfterExit`，
 *      不许解释成「Agent 不认可新上下文」；
 *   3. **重新进入**（§24.5）—— 离开过、又回到包里、再读 ⇒ `reEntry`；
 *   4. **规则一致**（§24.6）—— runtime 记下来的归因，逐字段等于拿同一份
 *      `(snapshots, reads)` 直接调 `snapshotAt()` + `attributeRead()` 现算的结果。
 *      对齐的是**规则**，不是数字（交付时刻不可观测，见 SDD §3 G4）。
 *
 * ⚠️ 一条纪律：`tier` / `rank` / `outside` 是**首读时**的归因（`firstRead`），
 * 不是「它现在在哪一层」—— 后者根本不存在，那是 Current View ≠ Historical View。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createStore, activateAudit, ingestEvents, noteSnapshot, usageFor, snapshotOf,
  snapshotAt, attributeRead, attributeReadFacts, MAX_SNAPSHOTS_PER_SESSION,
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

/**
 * 一次成功的读 = `tool/call` + `tool/result` 两件事（与宿主事件流同形）。
 * 归因认的是**结果**那件事的 seq（`callSeq` 只是配对用），所以 `readAt('a.md', 20)`
 * 记下来的 `firstRead.seq` 是 21。
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

/** 一个开着账、只交过几份包的会话。 */
function audited(id) {
  const store = createStore()
  activateAudit(store, id)
  return store
}

/* ── 1. 历史归因（§24.3）────────────────────────────────────── */

test('历史归因：换成新 Context 之后再看，旧读的层与 Epoch 一个字节都不许变', () => {
  const store = audited('s1')
  // Epoch 1：a.md 是主看篇
  noteSnapshot(store, 's1', pack({ primary: ['a.md'], supporting: ['b.md'] }), { seq: 10, at: 1000 })
  // 读发生在 Epoch 1（call seq 20 → result seq 21）
  ingestEvents(store, 's1', readAt('a.md', 20), { root: ROOT })
  // Epoch 2：换任务，a.md 掉出包外
  noteSnapshot(store, 's1', pack({ topic: 'other', primary: ['c.md'] }), { seq: 40, at: 2000 })

  const usage = usageFor(store, 's1')
  const row = usage.reads.find((r) => r.rel === 'a.md')

  // 冻结值：读发生时 a.md 在 primary、第 1 个 Epoch、快照 seq 10
  assert.equal(row.firstRead.seq, 21)
  assert.equal(row.firstRead.snapshotSeq, 10)
  assert.equal(row.firstRead.epochId, 1)
  assert.equal(row.firstRead.tier, 'primary')
  assert.equal(row.firstRead.rank, 1)
  assert.equal(row.firstRead.inside, true)

  // 「现在」是 Epoch 2，包里已经没有 a.md 了 —— 但那是 Current View，不是历史
  assert.equal(usage.epochId, 2)
  assert.equal(usage.items.some((item) => item.rel === 'a.md'), false)
  assert.equal(usage.stats.firstReadTier, 'primary')
  assert.equal(usage.stats.firstReadEpoch, 1)
  // 兼容别名也只能是首读的归因（v0.15 这里会拿最新快照重判成 outside）
  assert.equal(row.tier, 'primary')
  assert.equal(row.outside, false)
  // 它算进的是**当时**那个 Epoch，不是现在这个
  assert.equal(usage.epochs[0].primary.read, true)
  assert.equal(usage.epochs[1].primary.read, false)
  assert.equal(usage.stats.primaryFollowThrough, false)
  assert.equal(usage.stats.byTier.primary.read, 0)
})

test('当前视图可变、历史视图不可变：换回来也不重算', () => {
  const store = audited('s2')
  noteSnapshot(store, 's2', pack({ primary: ['a.md'] }), { seq: 10, at: 1 })
  ingestEvents(store, 's2', readAt('a.md', 20), { root: ROOT })
  noteSnapshot(store, 's2', pack({ primary: ['b.md'] }), { seq: 40, at: 2 })
  noteSnapshot(store, 's2', pack({ primary: ['a.md'] }), { seq: 60, at: 3 })

  const usage = usageFor(store, 's2')
  const row = usage.reads.find((r) => r.rel === 'a.md')
  assert.equal(row.firstRead.epochId, 1)
  assert.equal(row.firstRead.tier, 'primary')
  assert.equal(usage.epochId, 3)
})

/* ── 2. 离开之后仍然被读（§24.4）────────────────────────────── */

test('持续读：离开上下文之后还读那篇 ⇒ 只记事实，不加解释', () => {
  const store = audited('s3')
  noteSnapshot(store, 's3', pack({ primary: ['a.md'], supporting: ['b.md'] }), { seq: 10, at: 1 })
  // Epoch 2：a.md 出包
  noteSnapshot(store, 's3', pack({ supporting: ['b.md'] }), { seq: 20, at: 2 })
  // 出包之后仍然读它
  ingestEvents(store, 's3', readAt('a.md', 30), { root: ROOT })

  const usage = usageFor(store, 's3')
  const row = usage.reads.find((r) => r.rel === 'a.md')
  assert.equal(row.firstRead.epochId, 2)
  assert.equal(row.firstRead.inside, false)
  assert.equal(row.firstRead.tier, null)
  assert.equal(row.continuedReadAfterExit, true)
  assert.equal(row.reEntry, false)
  assert.equal(usage.stats.continuedReadsAfterExit, 1)
  assert.equal(usage.stats.reEntries, 0)
  assert.equal(usage.stats.firstReadTier, 'outside')
  assert.equal(usage.epochs[1].continuedReadsAfterExit, 1)
  // 摘要里只有事实，没有「Agent 不认可」这种话
  assert.equal(/不认可|不信任|confidence|score/i.test(JSON.stringify(usage.epochs)), false)
})

/* ── 3. 离开又回来（§24.5）──────────────────────────────────── */

test('重新进入：离开 → 又回到包里 → 再读 ⇒ reEntry 与 tierAtRead 都是事实', () => {
  const store = audited('s4')
  noteSnapshot(store, 's4', pack({ primary: ['a.md'] }), { seq: 10, at: 1 })
  noteSnapshot(store, 's4', pack({ primary: ['c.md'] }), { seq: 20, at: 2 })
  noteSnapshot(store, 's4', pack({ primary: ['c.md'], supporting: ['a.md'] }), { seq: 30, at: 3 })
  ingestEvents(store, 's4', readAt('a.md', 40), { root: ROOT })

  const usage = usageFor(store, 's4')
  const row = usage.reads.find((r) => r.rel === 'a.md')
  assert.equal(row.firstRead.epochId, 3)
  assert.equal(row.firstRead.tier, 'supporting')
  assert.equal(row.firstRead.inside, true)
  assert.equal(row.reEntry, true)
  // 这一次读本身在包里 ⇒ 不是「离开之后仍在读」
  assert.equal(row.continuedReadAfterExit, false)
  assert.equal(usage.stats.reEntries, 1)
  assert.equal(usage.epochs[2].reEntries, 1)
})

/* ── 4. 两个事实的判据（纯函数直接问）──────────────────────── */

test('事实判据：更早的窗口里从来没有过这篇 ⇒ 两个都是 false', () => {
  const snapshots = [
    { ...snapshotOf(pack({ primary: ['a.md'] }), { seq: 10, at: 1 }), epochId: 1 },
    { ...snapshotOf(pack({ primary: ['b.md'] }), { seq: 20, at: 2 }), epochId: 2 },
  ]
  assert.deepEqual(attributeReadFacts(snapshots, 'z.md', 30), { continuedReadAfterExit: false, reEntry: false })
  // 一直在包里、且没离开过 ⇒ 也不是「重新进入」
  assert.deepEqual(attributeReadFacts(snapshots, 'a.md', 15), { continuedReadAfterExit: false, reEntry: false })
  // 早于任何快照的读：连快照都配不上，两个事实都无从谈起
  assert.deepEqual(attributeReadFacts(snapshots, 'a.md', 5), { continuedReadAfterExit: false, reEntry: false })
  assert.deepEqual(attributeReadFacts(null, 'a.md', 30), { continuedReadAfterExit: false, reEntry: false })
})

test('事实判据：出包那一读算持续读，回到包里那一读算重新进入', () => {
  const snapshots = [
    { ...snapshotOf(pack({ primary: ['a.md'] }), { seq: 10, at: 1 }), epochId: 1 },
    { ...snapshotOf(pack({ primary: ['b.md'] }), { seq: 20, at: 2 }), epochId: 2 },
    { ...snapshotOf(pack({ primary: ['b.md'], related: ['a.md'] }), { seq: 30, at: 3 }), epochId: 3 },
  ]
  assert.deepEqual(attributeReadFacts(snapshots, 'a.md', 25), { continuedReadAfterExit: true, reEntry: false })
  assert.deepEqual(attributeReadFacts(snapshots, 'a.md', 35), { continuedReadAfterExit: false, reEntry: true })
})

test('attributeRead：不在包里也照样给出「当时那份快照」的身份', () => {
  const snapshot = { ...snapshotOf(pack({ primary: ['a.md'] }), { seq: 10, at: 1 }), epochId: 4 }
  assert.deepEqual(attributeRead(snapshot, 'a.md'), {
    snapshotSeq: 10, epochId: 4, tierAtRead: 'primary', rankAtRead: 1, insideAtRead: true,
  })
  assert.deepEqual(attributeRead(snapshot, 'z.md'), {
    snapshotSeq: 10, epochId: 4, tierAtRead: null, rankAtRead: null, insideAtRead: false,
  })
  assert.deepEqual(attributeRead(null, 'a.md'), {
    snapshotSeq: null, epochId: null, tierAtRead: null, rankAtRead: null, insideAtRead: false,
  })
})

/* ── 5. 规则一致（§24.6）────────────────────────────────────── */

test('规则一致：runtime 记下的归因，逐字段等于 snapshotAt() + attributeRead() 现算的结果', () => {
  const store = audited('s5')
  noteSnapshot(store, 's5', pack({ primary: ['a.md'], supporting: ['b.md', 'c.md'] }), { seq: 10, at: 1 })
  noteSnapshot(store, 's5', pack({ supporting: ['b.md'], related: ['a.md'] }), { seq: 30, at: 2 })
  ingestEvents(store, 's5', readAt('a.md', 20), { root: ROOT })
  ingestEvents(store, 's5', readAt('z.md', 40), { root: ROOT })

  const state = store.sessions.get('s5')
  const usage = usageFor(store, 's5')
  assert.equal(usage.reads.length, 2)
  for (const row of usage.reads) {
    const attributed = attributeRead(snapshotAt(state.snapshots, row.firstRead.seq), row.rel)
    assert.deepEqual(
      {
        snapshotSeq: row.firstRead.snapshotSeq,
        epochId: row.firstRead.epochId,
        tierAtRead: row.firstRead.tier,
        rankAtRead: row.firstRead.rank,
        insideAtRead: row.firstRead.inside,
      },
      {
        snapshotSeq: attributed.snapshotSeq,
        epochId: attributed.epochId,
        tierAtRead: attributed.tierAtRead,
        rankAtRead: attributed.rankAtRead,
        insideAtRead: attributed.insideAtRead,
      },
      `${row.rel} 的归因必须是那两个纯函数算出来的`,
    )
  }
})

test('规则一致：同样的输入喂两个 store，逐字段 deepEqual（没有隐藏的当前时刻依赖）', () => {
  const build = (id) => {
    const store = audited(id)
    noteSnapshot(store, id, pack({ primary: ['a.md'] }), { seq: 10, at: 1 })
    ingestEvents(store, id, readAt('a.md', 20), { root: ROOT })
    noteSnapshot(store, id, pack({ primary: ['b.md'] }), { seq: 30, at: 2 })
    ingestEvents(store, id, readAt('a.md', 40), { root: ROOT })
    return usageFor(store, id)
  }
  assert.deepEqual(build('left'), build('right'))
})

/* ── 6. Epoch 的边界与上限 ──────────────────────────────────── */

test('Epoch 与快照同生共死：同签名不新建，换了内容才 +1，Delta 带 fromEpoch/toEpoch', () => {
  const store = audited('s6')
  noteSnapshot(store, 's6', pack({ primary: ['a.md'] }), { seq: 10, at: 1 })
  noteSnapshot(store, 's6', pack({ primary: ['a.md'] }), { seq: 20, at: 2 })
  let usage = usageFor(store, 's6')
  assert.equal(usage.stats.churn.epochs, 1)
  assert.equal(usage.stats.churn.changes, 0)
  assert.equal(usage.epochs.length, 1)

  noteSnapshot(store, 's6', pack({ primary: ['b.md'] }), { seq: 30, at: 3 })
  usage = usageFor(store, 's6')
  assert.equal(usage.epochId, 2)
  assert.equal(usage.epochs.length, 2)
  assert.equal(usage.stats.churn.epochs, 2)
  assert.equal(usage.stats.churn.changes, 1)
  assert.equal(usage.delta.fromEpoch, 1)
  assert.equal(usage.delta.toEpoch, 2)
})

test('上限：Epoch 明细只留最近 20 份，「换过几次」仍是累计事实', () => {
  const store = audited('s7')
  const total = MAX_SNAPSHOTS_PER_SESSION + 3
  for (let i = 0; i < total; i += 1) {
    noteSnapshot(store, 's7', pack({ primary: [`p${i}.md`] }), { seq: 10 + i, at: 100 + i })
  }
  const usage = usageFor(store, 's7')
  assert.equal(usage.epochs.length, MAX_SNAPSHOTS_PER_SESSION)
  // 编号是累计的：被淘汰的 Epoch 也算「换过」
  assert.equal(usage.stats.churn.epochs, total)
  assert.equal(usage.stats.churn.changes, total - 1)
  // 客户端在用的旧键名 = 变化次数（`usage.changes` 文案）
  assert.equal(usage.stats.churn.snapshots, total - 1)
  assert.equal(usage.stats.churn.deltas, total - 1)
  // 明细里留下的是最新的那 20 个
  assert.equal(usage.epochs[usage.epochs.length - 1].epochId, total)
})

test('还没交过任何包：Epoch 编号为 0，没有快照可配', () => {
  const store = audited('s8')
  ingestEvents(store, 's8', readAt('a.md', 20), { root: ROOT })
  const usage = usageFor(store, 's8')
  const row = usage.reads[0]
  // 一份包都没交过 ⇒ 没有「当前 Epoch」可指（null，不是 0 —— 0 是个编号）
  assert.equal(usage.epochId, null)
  assert.equal(usage.epochs.length, 0)
  assert.equal(usage.stats.churn.epochs, 0)
  assert.equal(row.firstRead.snapshotSeq, null)
  assert.equal(row.firstRead.epochId, null)
  assert.equal(row.firstRead.inside, false)
  assert.equal(usage.stats.firstReadTier, 'outside')
})
