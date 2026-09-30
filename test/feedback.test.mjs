/**
 * Knit v0.15 · **read evidence adapter 与路径归一化的单元测试**
 *
 * 被测对象是 `src/host/feedback.js` 里**最靠近真实世界**的那一层：
 * 会话事件 → 「Agent 真的读了哪一篇」。这一层的错法只有两种，两种都很贵：
 *   - **多记**（把 `grep` 命中、失败的读取、别人的路径算成读）→ Usage 变成假证据；
 *   - **少记**（把真实的读漏掉）→ Usage 永远说「没读」。
 *
 * 事件形状全部照抄 2026-09-30 实测的真实会话文件
 * （`~/.dsh/sessions/…/session.v4.jsonl.zstd`）：
 *   `tool/call`   `data = {turn, step, callId, name, arguments}`（`arguments` 是 **JSON 字符串**）
 *   `tool/result` `data = {turn, step, message}`，`message = {toolCallId, source:{callId}, isError, …}`
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeRel, normalizeReadEvidence, snapshotOf, diffContext,
  MAX_PENDING_CALLS,
} from '../src/host/feedback.js'

const ROOT = '/w'

/** 造一个事件。 */
function ev(seq, type, data, time = seq * 1000) {
  return { type, seq, time, data }
}

/** 造一个 `tool/call`。 */
function call(seq, callId, name, args) {
  return ev(seq, 'tool/call', {
    turn: 1, step: 1, callId, name, arguments: JSON.stringify(args),
  })
}

/** 造一个 `tool/result`。 */
function result(seq, callId, { isError = false } = {}) {
  return ev(seq, 'tool/result', {
    turn: 1,
    step: 1,
    message: {
      role: 'tool',
      toolCallId: callId,
      source: { kind: 'tool', callId },
      isError,
      content: [{ type: 'text', text: '<path>/w/a.md</path>\n<content>x</content>' }],
    },
  })
}

test('路径：绝对路径落在工作区里就转成相对路径，落在外面就丢掉', () => {
  assert.equal(normalizeRel(ROOT, '/w/a/b.md'), 'a/b.md')
  assert.equal(normalizeRel(ROOT, '/w/a/b.md'), 'a/b.md')
  assert.equal(normalizeRel(ROOT, 'a/b.md'), 'a/b.md')
  assert.equal(normalizeRel(ROOT, './a/b.md'), 'a/b.md')
  assert.equal(normalizeRel(ROOT, 'a//b.md'), 'a/b.md')
  // 工作区之外 —— 一个字都不能留
  assert.equal(normalizeRel(ROOT, '/other/x.md'), '')
  assert.equal(normalizeRel(ROOT, '/w/../x.md'), '')
  assert.equal(normalizeRel(ROOT, '../x.md'), '')
  assert.equal(normalizeRel(ROOT, '../../etc/passwd'), '')
})

test('路径：URL、空串、非法类型、超长、NUL 一律丢掉（不猜）', () => {
  assert.equal(normalizeRel(ROOT, 'https://example.com/a.md'), '')
  assert.equal(normalizeRel(ROOT, 'file:///w/a.md'), '')
  assert.equal(normalizeRel(ROOT, ''), '')
  assert.equal(normalizeRel(ROOT, '   '), '')
  assert.equal(normalizeRel(ROOT, null), '')
  assert.equal(normalizeRel(ROOT, 42), '')
  assert.equal(normalizeRel(ROOT, { rel: 'a.md' }), '')
  assert.equal(normalizeRel(ROOT, `a${'b'.repeat(2000)}.md`), '')
  assert.equal(normalizeRel(ROOT, 'a\0b.md'), '')
  assert.equal(normalizeRel('', '/w/a.md'), '')
})

test('证据：`read` 的调用 + 成功结果 = 一次真实的读', () => {
  const events = [
    call(10, 'c1', 'read', { file_path: '/w/knit/src/host/relevance.js' }),
    result(11, 'c1'),
  ]
  const { reads, cursor } = normalizeReadEvidence(events, { root: ROOT, fromSeq: -1 })
  assert.equal(reads.length, 1)
  assert.equal(reads[0].rel, 'knit/src/host/relevance.js')
  assert.equal(reads[0].callSeq, 10)
  assert.equal(reads[0].seq, 11)
  assert.equal(reads[0].time, 11000)
  assert.equal(cursor, 11)
})

test('证据：只有非 read 的工具时一条都不记 —— grep / glob 命中不是读过（规格 §9）', () => {
  const events = [
    call(1, 'c1', 'glob', { pattern: '**/*.md' }),
    result(2, 'c1'),
    call(3, 'c2', 'grep', { pattern: 'bm25', path: '/w/README.md' }),
    result(4, 'c2'),
    call(5, 'c3', 'bash', { command: 'cat /w/a.md' }),
    result(6, 'c3'),
    call(7, 'c4', 'knit_docs', { limit: 5 }),
    result(8, 'c4'),
  ]
  const { reads } = normalizeReadEvidence(events, { root: ROOT })
  assert.deepEqual(reads, [])
})

test('证据：失败的读不记账（isError:true）', () => {
  const events = [
    call(1, 'c1', 'read', { file_path: '/w/a.md' }),
    result(2, 'c1', { isError: true }),
    call(3, 'c2', 'read', { file_path: '/w/b.md' }),
    result(4, 'c2'),
  ]
  const { reads } = normalizeReadEvidence(events, { root: ROOT })
  assert.equal(reads.length, 1)
  assert.equal(reads[0].rel, 'b.md')
})

test('证据：工作区之外的读不记账', () => {
  const events = [
    call(1, 'c1', 'read', { file_path: '/etc/passwd' }),
    result(2, 'c1'),
    call(3, 'c2', 'read', { file_path: '/w/ok.md' }),
    result(4, 'c2'),
  ]
  const { reads } = normalizeReadEvidence(events, { root: ROOT })
  assert.deepEqual(reads.map((r) => r.rel), ['ok.md'])
})

test('证据：`arguments` 不是合法 JSON 时丢掉，不猜路径', () => {
  const events = [
    { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c1', name: 'read', arguments: '{oops' } },
    { type: 'tool/result', seq: 2, time: 2, data: { message: { toolCallId: 'c1', isError: false } } },
  ]
  const { reads } = normalizeReadEvidence(events, { root: ROOT })
  assert.deepEqual(reads, [])
})

test('证据：`arguments` 已经是对象时也认（适配两种投递形态）', () => {
  const events = [
    { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c1', name: 'read', arguments: { path: '/w/x.md' } } },
    { type: 'tool/result', seq: 2, time: 2, data: { message: { toolCallId: 'c1' } } },
  ]
  const { reads } = normalizeReadEvidence(events, { root: ROOT })
  assert.deepEqual(reads.map((r) => r.rel), ['x.md'])
})

test('证据：还没返回的调用挂在 pending 里，跨轮次才配上对', () => {
  const first = normalizeReadEvidence([
    call(1, 'c1', 'read', { file_path: '/w/a.md' }),
  ], { root: ROOT, fromSeq: -1 })
  assert.deepEqual(first.reads, [])
  assert.equal(first.pending.size, 1)

  // 第二轮：结果到了，游标推进到 1，pending 从上一次带过来
  const second = normalizeReadEvidence([
    result(2, 'c1'),
  ], { root: ROOT, fromSeq: first.cursor, pending: first.pending })
  assert.deepEqual(second.reads.map((r) => r.rel), ['a.md'])
  assert.equal(second.pending.size, 0)
  assert.equal(second.cursor, 2)
})

test('证据：游标是幂等的 —— 同一批事件喂两遍只算一遍', () => {
  const events = [call(10, 'c1', 'read', { file_path: '/w/a.md' }), result(11, 'c1')]
  const once = normalizeReadEvidence(events, { root: ROOT, fromSeq: -1 })
  const twice = normalizeReadEvidence(events, { root: ROOT, fromSeq: once.cursor, pending: once.pending })
  assert.equal(once.reads.length, 1)
  assert.deepEqual(twice.reads, [])
})

test('证据：没有编号的事件不参与（`session` 头行与坏行都被跳过）', () => {
  const events = [
    { type: 'session', data: { id: 's1' } },
    { type: 'tool/call', data: { callId: 'x', name: 'read', arguments: '{"file_path":"/w/a.md"}' } },
    null,
    { type: 'tool/result', seq: 2, data: { message: { toolCallId: 'x', isError: false } } },
  ]
  const { reads, cursor } = normalizeReadEvidence(events, { root: ROOT })
  assert.deepEqual(reads, [])
  assert.equal(cursor, 2)
})

test('证据：只调用不返回的会话不会把 pending 撑大（有上限）', () => {
  const events = []
  for (let i = 0; i < MAX_PENDING_CALLS + 20; i += 1) {
    events.push(call(i + 1, `c${i}`, 'read', { file_path: `/w/a${i}.md` }))
  }
  const { pending } = normalizeReadEvidence(events, { root: ROOT })
  assert.equal(pending.size, MAX_PENDING_CALLS)
})

test('快照：三层被压成 rel / 层 / 层内名次，签名只由内容决定', () => {
  const pack = {
    mode: 'relevance', topic: 'knit', task: '做 v0.15',
    primary: [{ rel: 'a.md' }], supporting: [{ rel: 'b.md' }, { rel: 'c.md' }], related: [{ rel: 'd.md' }],
    totals: { matched: 4, total: 50 },
  }
  const snap = snapshotOf(pack, { seq: 7, at: 1234 })
  assert.deepEqual(snap.items, [
    { rel: 'a.md', tier: 'primary', rank: 1 },
    { rel: 'b.md', tier: 'supporting', rank: 1 },
    { rel: 'c.md', tier: 'supporting', rank: 2 },
    { rel: 'd.md', tier: 'related', rank: 1 },
  ])
  assert.equal(snap.seq, 7)
  assert.equal(snap.at, 1234)
  assert.equal(snap.total, 50)
  // 同样的内容 ⇒ 同样的签名；任务换了 ⇒ 签名就变
  assert.equal(snapshotOf(pack, { seq: 99 }).sig, snap.sig)
  assert.notEqual(snapshotOf({ ...pack, task: '别的任务' }).sig, snap.sig)
})

test('差异：进来的 / 出去的 / 换层的 / 任务变了的分别报清楚', () => {
  const before = snapshotOf({
    task: 'A', primary: [{ rel: 'a.md' }], supporting: [{ rel: 'b.md' }], related: [{ rel: 'c.md' }],
  })
  const after = snapshotOf({
    task: 'B',
    primary: [{ rel: 'b.md' }],
    supporting: [{ rel: 'a.md' }, { rel: 'e.md' }],
    related: [],
  })
  const diff = diffContext(before, after)
  assert.deepEqual(diff.appeared, [{ rel: 'e.md', tier: 'supporting', rank: 2 }])
  assert.deepEqual(diff.disappeared, [{ rel: 'c.md', tier: 'related', rank: 1 }])
  // 顺序是「按新快照的层内顺序」，确定性由 Map 插入顺序保证
  assert.deepEqual(diff.moved.map((m) => [m.rel, m.from.tier, m.to.tier]), [
    ['b.md', 'supporting', 'primary'],
    ['a.md', 'primary', 'supporting'],
  ])
  assert.equal(diff.taskChanged, true)
  assert.equal(diff.stable, false)
})

test('差异：完全一样时 stable，没有假的「变化」', () => {
  const pack = { task: 'A', primary: [{ rel: 'a.md' }], supporting: [], related: [] }
  const diff = diffContext(snapshotOf(pack), snapshotOf(pack))
  assert.equal(diff.stable, true)
  assert.deepEqual(diff.appeared, [])
  assert.deepEqual(diff.moved, [])
})

test('快照：形状不对的输入不会抛，只是产出空快照', () => {
  assert.deepEqual(snapshotOf(null).items, [])
  assert.deepEqual(snapshotOf(undefined).items, [])
  assert.deepEqual(snapshotOf({ primary: 'nope', supporting: [null, { rel: 7 }] }).items, [])
})
