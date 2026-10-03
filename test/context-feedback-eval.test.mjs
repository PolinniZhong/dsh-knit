/**
 * Context Feedback Eval 的**确定性**对照（v0.15）。
 *
 * 这里不是「再测一遍 feedback.js」—— 那些在 `test/feedback.test.mjs` 与
 * `test/context-delta.test.mjs` 里。这里测的是**量尺本身在真实装配管线上成立**：
 * 同一个工作区、同一批事件，只改一个变量 —— **包交没交给 agent**。
 *
 *   Control（`deliver:false`）  ：没人给过上下文 ⇒ 那次读必须落在包外
 *   Treatment（`deliver:true`） ：读了「先看」的那一篇 ⇒ 必须记成 follow-through
 *
 * 这条对照是这个功能**唯一**能自证的地方：如果 Control 臂也能测出「读命中 primary」，
 * 那这个量尺就是在自说自话（`tools/context-feedback-eval.mjs --control` 里同一条判据）。
 *
 * ⚠️ 工作区一律来自 `makeWorkspace()`（AGENTS.md §6.8：样本不许借仓库里的真实文件），
 * 且用 `quantum-anchor` 这种**只出现在一篇里**的词把 primary 钉死 —— 靠「BM25 大概会选它」
 * 的断言会随排序引擎的调整漂移。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeWorkspace } from './fixture.mjs'
import {
  findLatestSessionLog, findSessionLogById, metricsFor, parseEvents, replaySession, scopeFor,
} from '../tools/context-feedback-eval.mjs'

/** 目标文档：`quantum-anchor` 只在这里出现，所以它必须是 primary。 */
const TARGET = 'docs/target.md'

/**
 * 造一个工作区。`extra` 走 `makeWorkspace()` —— 里面已经有 README / 笔记 / CHANGELOG 三篇。
 * @returns {string} 工作区绝对路径
 */
function workspace() {
  return makeWorkspace([
    [TARGET, '# 排序目标\n\n唯一命中词 quantum-anchor 出现在这篇里，相关性排序也提到了。\n'],
  ])
}

/** 用户消息（`isSubstantiveTask` 认的那种）。 */
function userMessage(seq, text) {
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

/** 一次真实的 `read` 调用（`arguments` 是 JSON **字符串** —— 宿主就是这样存的）。 */
function readCall(seq, filePath) {
  const callId = `c${seq}`
  return {
    type: 'tool/call',
    seq,
    time: 1000 + seq,
    data: { turn: 1, step: 1, callId, name: 'read', arguments: JSON.stringify({ file_path: filePath }) },
  }
}

/** 对应的成功返回。 */
function toolResult(seq, callSeq) {
  const callId = `c${callSeq}`
  return {
    type: 'tool/result',
    seq,
    time: 1000 + seq,
    sourceEventSeqs: [callSeq],
    data: {
      turn: 1, step: 1,
      message: {
        role: 'tool',
        source: { kind: 'tool', callId },
        toolCallId: callId,
        content: [{ type: 'text', text: '<path>…</path>' }],
        isError: false,
        id: `m${seq}`,
      },
    },
  }
}

/**
 * 一份完整的事件流：一句话 → 读「先看」那篇 → 再读一个 Knit 根本索引不到的文件。
 * @returns {object[]} 事件
 */
function treatmentEvents() {
  return [
    userMessage(1, '项目的相关性排序是怎么算的？quantum-anchor 在哪一篇里'),
    readCall(2, TARGET),
    toolResult(3, 2),
    readCall(4, 'package.json'),
    toolResult(5, 4),
  ]
}

test('评测：交过包才能记成 follow-through —— Control 与 Treatment 只差这一个变量', async () => {
  const root = workspace()
  const events = treatmentEvents()

  const control = await replaySession(events, { root, sessionId: 'ctl', deliver: false })
  const treated = await replaySession(events, { root, sessionId: 'trt', deliver: true })

  // 前提：这篇确实是「先看」的那一篇（否则下面两条断言测的是别的东西）
  assert.equal(treated.metrics.primaryRel, TARGET, 'quantum-anchor 应当把这篇钉成 primary')

  // Treatment：读了 primary ⇒ follow-through，第一次读落在 primary 层
  assert.equal(treated.packs > 0, true, 'Treatment 必须真的交过包')
  assert.equal(treated.metrics.primaryRead, true)
  assert.equal(treated.metrics.firstReadTier, 'primary')
  assert.equal(treated.metrics.firstReadRel, TARGET)

  // Control：一份包都没交 ⇒ 那次读只能落在包外，且**不许**记成 follow-through
  assert.equal(control.packs, 0)
  assert.equal(control.metrics.primaryRead, false)
  // v0.16：读过但没人在那一层给过上下文 ⇒ 'outside'（null 只留给「一次都没读」）
  assert.equal(control.metrics.firstReadTier, 'outside')
  assert.equal(control.metrics.outside, 2, '两次读都该在包外')

  // 两边的读**次数**一样 —— 变的只是「有没有人给过上下文」
  assert.equal(control.metrics.reads, treated.metrics.reads)
  assert.equal(control.metrics.distinct, treated.metrics.distinct)
})

test('评测：包外的读要拆成「Knit 看得到却没进包」与「Knit 根本不索引」', async () => {
  const root = workspace()
  const result = await replaySession(treatmentEvents(), { root, sessionId: 'scope' })

  // `package.json` 不是 `.md` ⇒ 永远不可能进包。它**不算漏**。
  assert.deepEqual(result.scope.outOfScopeReads, ['package.json'])
  assert.equal(result.scope.outOfScope, 1)
  // 被读的那篇 `.md` 在扫描结果里、也在包里 ⇒ 既不是漏也不是域外
  assert.equal(result.scope.inScope, 1)
  assert.deepEqual(result.scope.missed, [])

  // Control 臂里，同一篇 `.md` 就变成了**真的漏**（Knit 看得到它，却没人把包交出去）
  const control = await replaySession(treatmentEvents(), { root, sessionId: 'scope-ctl', deliver: false })
  assert.deepEqual(control.scope.missed, [TARGET])
  assert.equal(control.scope.outOfScope, 1)
})

test('评测：话题换了之后快照跟着换（churn 记的是事实，不是估算）', async () => {
  const root = workspace()
  const events = [
    ...treatmentEvents(),
    userMessage(6, '换个话题：把发布记录整理一下'),
    readCall(7, TARGET),
    toolResult(8, 7),
  ]
  const result = await replaySession(events, { root, sessionId: 'churn' })

  assert.equal(result.metrics.contextChanges >= 1, true, '任务变了必须换一份包')
  assert.equal(result.metrics.taskChanged >= 1, true)
  assert.equal(result.metrics.reads, 3)
})

test('评测：同样的输入必须给出逐字一样的读数（两次回放 deepEqual）', async () => {
  const root = workspace()
  const first = await replaySession(treatmentEvents(), { root, sessionId: 'det' })
  const second = await replaySession(treatmentEvents(), { root, sessionId: 'det' })
  assert.deepEqual(first.metrics, second.metrics)
  assert.deepEqual(first.scope, second.scope)
})

test('评测：坏行不废整批（半截的尾行很常见）', () => {
  const text = [
    '{"type":"session","id":"s","cwd":"/tmp"}',
    '{"type":"user/message","seq":1,"data":{}}',
    '{"broken"',
    '',
    '不是 JSON',
  ].join('\n')
  const events = parseEvents(text)
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'session')
})

test('评测：metricsFor 的键是稳定的（下游脚本靠它）', () => {
  const metrics = metricsFor(null)
  assert.deepEqual(Object.keys(metrics).sort(), [
    'appeared', 'contextChanges', 'continuedReadsAfterExit', 'disappeared', 'distinct', 'epochs',
    'firstReadRel', 'firstReadTier', 'moved', 'outside', 'outsideReads', 'primaryRead', 'primaryRel',
    'reads', 'reentries', 'supportingCoverage', 'taskChanged',
  ])
  assert.equal(metrics.reads, 0)
  assert.equal(metrics.primaryRead, false)
  assert.equal(metrics.firstReadTier, null)
  assert.equal(metrics.epochs, 0)
  assert.equal(metrics.continuedReadsAfterExit, 0)
  assert.equal(metrics.reentries, 0)
})

test('评测：日志文件名按形状认（v0–v4 三代并存），不写死 v4', () => {
  const dir = mkdtempSync(join(tmpdir(), 'knit-sessions-'))
  try {
    const ws = join(dir, 'workspace')
    // 老会话只留 v3（本机 98 份这种），新会话是 v4
    const old3 = join(ws, 'sess-old')
    const new4 = join(ws, 'sess-new')
    mkdirSync(old3, { recursive: true })
    mkdirSync(new4, { recursive: true })
    writeFileSync(join(old3, 'session.v3.jsonl.zstd'), 'x')
    writeFileSync(join(new4, 'session.v4.jsonl.zstd'), 'y')

    assert.equal(findSessionLogById('sess-old', dir), join(old3, 'session.v3.jsonl.zstd'))
    assert.equal(findSessionLogById('sess-new', dir), join(new4, 'session.v4.jsonl.zstd'))
    assert.equal(findSessionLogById('nope', dir), null)
    // 「最近一份」按 mtime 选，不按版本号选
    assert.equal(findLatestSessionLog(dir), join(new4, 'session.v4.jsonl.zstd'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('评测：scopeFor 不认识 usage 时给空拆分，不抛', () => {
  const scope = scopeFor(null, ['a.md'])
  assert.deepEqual(scope, { inScope: 0, missed: [], missedReads: 0, outOfScope: 0, outOfScopeReads: [] })
})
