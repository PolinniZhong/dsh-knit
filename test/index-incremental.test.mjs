/**
 * Knit · **增量上下文索引**（v0.22）的端到端测试
 *
 * 这一版要证明的是提示词 §6 的七条验收，而不是「跑得更快」。七条里每一条在这里都
 * 有一个能**证伪**的断言（把对应实现删掉，这些用例必须变红）：
 *
 *   1. 未修改文件 → 不重新读取 / 解析 / tokenize
 *   2. 修改一个文件 → 只重新处理该文件
 *   3. 新增 / 删除 / 重命名 → 下一次有效检索不返回过期结果
 *   4. 重启 → 可恢复或安全重建
 *   5. 丢失 watcher event → 对账可以修复（v0.22 没有 watcher，权威就是**每轮抽验**）
 *   6. 索引损坏 / storage 不可用 → 回退路径仍可用，不能崩溃
 *   7. 索引路径开启 / 关闭 → 同一语料上的 Context Pack 成员与排序一致
 *
 * 读数的两套证据：
 *   · **计数型**（`indexStatsFor()` 的 `readFiles/cached/reused/verified/put/del`）——
 *     「整读了几次」是可证伪的整数，比墙钟时间稳定；
 *   · **结构型**（复用出来的条目 `body === ''`）—— 正文只可能来自整读，
 *     所以「复用项没有正文」本身就是「没有整读」的直接证据，不依赖计数实现是否正确。
 *
 * ⚠️ 测试里默认把抽验预算设成 **0**（`setIndexVerifyBudget(0)`），让「整读次数」在断言里
 * 没有歧义；**默认预算（8）的行为单独有用例守着**，见「抽验」那一节。
 *
 * ⚠️ **修法 ②（2026-10-10）**：索引只在「这一轮用不着正文」的路上查 —— 也就是
 * `collectDocs()`（低层取数）与**时间序**扫描；相关检索要 BM25 的全部正文，索引复用在
 * 那条路上是净开销，所以 `scan()` 在 `mode === 'relevance'` 时显式传 `{ index: false }`。
 * 于是：本文件里断言「复用 / 整读次数」的用例走 `collectDocs()` 或 `timePageOf()`，
 * 断言「这一页内容对不对」的用例走 `pageOf()`。两条路的职责见最后一节。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  buildContextFor, collectDocs, indexStatsFor, indexStorageStatus, resetIndexMemory,
  scan, setIndexRegistry, setIndexVerifyBudget,
} from '../src/host/index.js'
import { createIndexStore, refsShapeOk } from '../src/host/index-store.js'
import { fakeStorageBackend, makeWorkspace } from './fixture.mjs'

/**
 * 起一个「进程」：重置内存态 → 接上存储 → 设定抽验预算。
 *
 * `budget` 默认 **0**（关掉抽验 ⇒ `readFiles` 就是纯整读次数）；要测生产默认值就传
 * `defaultBudget: true`。两个都不能省，因为 `resetIndexMemory()` 会把预算也复位。
 *
 * @param {{tables: object}|null} medium - 介质（`null` = 没有存储）
 * @param {{budget?: number, defaultBudget?: boolean}} [options] - 预算控制
 * @returns {{store: object|null, medium: object|null}} 存储句柄（要 `await store.flush()`）
 */
function boot(medium, options = {}) {
  resetIndexMemory()
  const backend = medium ? fakeStorageBackend(medium) : null
  const store = backend ? createIndexStore({ backend }) : null
  setIndexRegistry(store)
  if (options.defaultBudget !== true) {
    setIndexVerifyBudget(options.budget == null ? 0 : options.budget)
  }
  return { store, medium: backend ? backend.medium : null }
}

/** 这一批语料里被索引的条目数（docs + code；media 不进索引）。 */
const indexed = (collected) => collected.docs.length + collected.code.length

/** 全部条目的 rel（文档 + 代码）。 */
const relsOf = (collected) => [...collected.docs, ...collected.code].map((doc) => doc.rel)

/** 跑一次相关检索并取出这一页的 rel（顺序即名次）。 */
const pageOf = async (root, query) => {
  const payload = await scan(root, 40, { sort: 'relevance', kind: 'context', query })
  return payload
}

/** 跑一次**时间序**检索 —— 这条路上扫描会真的查索引（复用 + 对账都在这里）。 */
const timePageOf = async (root) => scan(root, 40, { sort: 'time', kind: 'context' })

/** 语料模型指纹：只比「索引本来就能提供的那几样」（rel / 标题 / 摘要 / 内容指纹）。 */
const corpusFingerprint = (collected) => JSON.stringify(
  [...collected.docs, ...collected.code]
    .map((doc) => [doc.rel, doc.title, doc.summary, doc.headHash])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1)),
)

/** Context Pack 的指纹：四层的 rel 序列（成员 + 顺序都算进去）。 */
async function packFingerprint(root, query) {
  const payload = await pageOf(root, query)
  const pack = await buildContextFor(payload.hostRoot, {
    ranked: payload.ranked, total: payload.total, task: payload.task, topic: payload.topic,
  })
  return JSON.stringify(['pinned', 'primary', 'supporting', 'related']
    .map((tier) => (pack[tier] || []).map((item) => item.rel)))
}

/* ── 1 · 核心声明：重启后未变化的文件不再整读 ─────────── */

test('冷启整读每一篇；「重启」后未变化的文件**一次整读都没有**（§6 第 1、4 条）', async () => {
  const root = makeWorkspace()
  const medium = { tables: {} }

  const cold = boot(medium)
  const coldOut = await collectDocs(root)
  await cold.store.flush()
  const coldStats = indexStatsFor(root)
  assert.equal(coldStats.readFiles, indexed(coldOut), '冷启动必须逐篇读一遍')
  assert.equal(coldStats.reused, 0)
  assert.equal(coldStats.put, indexed(coldOut), '第一次要把整份索引写下去')
  assert.ok(indexed(coldOut) > 0)

  // 「重启」= 同一份介质 + 全新的后端与 store
  const warm = boot(medium)
  const warmOut = await collectDocs(root)
  const warmStats = indexStatsFor(root)
  assert.equal(warmStats.readFiles, 0, '未修改的文件一次都不许整读')
  assert.equal(warmStats.reused, indexed(warmOut), '逐条都该由索引复用')
  assert.equal(warmStats.cached, 0, '进程内缓存已清空 ⇒ 复用只能来自索引')
  assert.equal(warmStats.put, 0, '没有任何变化 ⇒ 不该写回一条记录')
  assert.equal(warmStats.del, 0)
  assert.deepEqual(relsOf(warmOut).sort(), relsOf(coldOut).sort(), '语料成员必须逐字一致')

  // 结构型证据：复用出来的条目**没有正文**（正文只可能来自整读），
  // 也**没有原文首部**（修法 ①：索引只存抽取结果，不存 16KB 原文）
  for (const doc of [...warmOut.docs, ...warmOut.code]) {
    assert.equal(doc.body, '', `${doc.rel} 复用项不该带正文`)
    assert.equal(doc.bodyReady, false)
    assert.equal(doc.head, '', `${doc.rel} 复用项不该带原文首部`)
    assert.equal(refsShapeOk(doc.refs), true, `${doc.rel} 复用项必须带抽取结果 refs`)
    assert.match(doc.headHash, /^[0-9a-f]{16}$/)
  }
  // 抽取结果必须与冷启读盘时算出来的逐字相同 —— 关系与引用图就是靠它才不用重读
  const before = new Map([...coldOut.docs, ...coldOut.code].map((doc) => [doc.rel, doc.refs]))
  for (const doc of [...warmOut.docs, ...warmOut.code]) {
    assert.deepEqual(doc.refs, before.get(doc.rel), `${doc.rel} 的引用抽取结果必须与读盘结果一致`)
  }
})

test('同一进程内第二次扫描走的是**进程内 cache**，不是索引复用（别把旧能力记成新收益）', async () => {
  const root = makeWorkspace()
  boot(null) // 没有存储：这一条要证明 v0.20 就有的能力单独计数
  const first = await collectDocs(root)
  assert.equal(indexStatsFor(root).readFiles, indexed(first))
  const second = await collectDocs(root)
  const stats = indexStatsFor(root)
  assert.equal(stats.cached, indexed(second), '第二次该命中内存 cache')
  assert.equal(stats.readFiles, 0)
  assert.equal(stats.reused, 0, '没有索引 ⇒ 复用数必须是 0')
  assert.deepEqual(relsOf(second).sort(), relsOf(first).sort())
})

/* ── 2 · 抽验：mtime+size 不是唯一证据 ────────────────── */

test('默认预算（8）：复用项会按指纹复核一遍（§6 第 5 条的权威就是对账）', async () => {
  const root = makeWorkspace()
  const medium = { tables: {} }
  const cold = boot(medium)
  await collectDocs(root)
  await cold.store.flush()

  boot(medium, { defaultBudget: true }) // 生产默认值就是 8
  const out = await collectDocs(root)
  const stats = indexStatsFor(root)
  assert.equal(stats.reused, indexed(out))
  assert.equal(stats.verified, stats.reused, '样本数少于预算 ⇒ 这一轮应该全部核到')
  assert.equal(stats.repaired, 0, '没人被改过 ⇒ 不该有修复')
  assert.equal(stats.readFiles, stats.verified, '抽验读的只有头部，次数等于核验项数')
})

test('抽验是**承重的**：同 mtime 同 size 的改写靠指纹抓得到；预算设 0 就会漏（§4 第 4 条）', async () => {
  /**
   * 造一个「内容变了但 mtime 与 size 都没变」的文件。
   *
   * 这不是人为刁难：`git checkout`、编辑器「保存格式」、脚本原地替换都可能撞上；
   * 只要索引把 mtime+size 当唯一证据，这种改写就会被**静默交付成旧内容**。
   *
   * ⚠️ 观测量是 `title`（由 `# 陈旧 A` / `# 陈旧 B` 解析出来），不是 `head` ——
   * 修法 ① 之后复用项不带原文首部，而标题正是「这条记录到底来自哪一版内容」的
   * 用户可见证据。
   *
   * @param {number} budget - 抽验预算
   * @returns {Promise<{title: string, stats: object}>} 复用出来的标题与统计
   */
  const stale = async (budget) => {
    const root = makeWorkspace([['docs/stale.md', '# 陈旧 A\n\nAAAA\n']])
    const abs = join(root, 'docs/stale.md')
    const before = statSync(abs)

    const cold = boot({ tables: {} }, { budget })
    await collectDocs(root)
    await cold.store.flush()

    writeFileSync(abs, '# 陈旧 B\n\nBBBB\n') // 与上一份**等长**
    utimesSync(abs, before.atimeMs / 1000, before.mtimeMs / 1000) // mtime 还原
    const after = statSync(abs)
    assert.equal(after.size, before.size, '场景准备失败：两次内容不等长')
    assert.ok(Math.abs(after.mtimeMs - before.mtimeMs) <= 1, '场景准备失败：mtime 没还原上')

    boot(cold.medium, { budget }) // 「重启」
    const out = await collectDocs(root)
    return {
      title: out.docs.find((doc) => doc.rel === 'docs/stale.md').title,
      stats: indexStatsFor(root),
    }
  }

  const guarded = await stale(8)
  assert.match(guarded.title, /B/, '默认预算下必须抓到改写并重建')
  assert.equal(guarded.stats.repaired, 1, '抓到一个坏记录')

  // **证伪**：把抽验预算设成 0，同一条路径就漏了 —— 证明这道守卫不是装饰。
  const unguarded = await stale(0)
  assert.match(unguarded.title, /A/, '预算 0 时索引会照旧交付陈旧记录（所以默认预算不能是 0）')
  assert.equal(unguarded.stats.repaired, 0)
})

test('抽验预算是**硬上限**，且它只读头部（不改语料、不误报修复）', async () => {
  const root = makeWorkspace([
    ['a.md', '# a\n'], ['b.md', '# b\n'], ['c.md', '# c\n'], ['d.md', '# d\n'], ['e.md', '# e\n'],
  ])
  const medium = { tables: {} }
  const cold = boot(medium)
  const first = await collectDocs(root)
  await cold.store.flush()
  assert.ok(indexed(first) > 1, '样本要够多，否则测不出上限')

  // 预算 1：三轮各核一条（游标轮转 ⇒ 不会每轮都核同一条，但这一点不可从外部观测，
  // 这里只钉死可证伪的部分：核验数等于预算、不多核也不少核）。
  for (let round = 0; round < 3; round += 1) {
    boot(medium, { budget: 1 })
    const out = await collectDocs(root)
    const stats = indexStatsFor(root)
    assert.equal(stats.verified, 1, '每轮只核一条')
    assert.equal(stats.repaired, 0, '没人被改过 ⇒ 不许误报修复')
    assert.equal(stats.readFiles, 1, '抽验读的只有头部这一次')
    assert.deepEqual(relsOf(out).sort(), relsOf(first).sort())
  }
})

/* ── 3 · 变化：只重建变化的那一个（§6 第 2 条）────────── */

test('改一个文件：只重新处理该文件，其余仍由索引复用', async () => {
  const root = makeWorkspace()
  const medium = { tables: {} }
  const cold = boot(medium)
  const first = await collectDocs(root)
  await cold.store.flush()

  const victim = first.docs[0].rel
  const abs = join(root, victim)
  const before = statSync(abs)
  writeFileSync(abs, `${'# 改过了\n\n'}${'x'.repeat(Math.max(1, before.size - 12))}\n`)
  utimesSync(abs, before.atimeMs / 1000, (before.mtimeMs + 5000) / 1000)
  const after = statSync(abs)
  assert.notEqual(after.mtimeMs, before.mtimeMs, '场景准备失败：mtime 没变')

  boot(medium)
  const second = await collectDocs(root)
  const stats = indexStatsFor(root)
  assert.equal(stats.readFiles, 1, '只许重建被改的那一篇')
  assert.equal(stats.reused, indexed(second) - 1)
  assert.equal(stats.put, 1, '差量只写一条')
  assert.equal(stats.del, 0)
  const doc = [...second.docs, ...second.code].find((item) => item.rel === victim)
  assert.equal(doc.bodyReady, true, '被改的那篇必须真的读盘')
  assert.ok(doc.body.length > 0)
})

test('新增一个文件：新记录入库，未变化的文件不重读', async () => {
  const root = makeWorkspace()
  const medium = { tables: {} }
  const cold = boot(medium)
  await collectDocs(root)
  await cold.store.flush()

  writeFileSync(join(root, 'docs/added.md'), '# 新来的\n\n刚加进来的文件。\n')

  boot(medium)
  const second = await collectDocs(root)
  const stats = indexStatsFor(root)
  assert.ok(relsOf(second).includes('docs/added.md'))
  assert.equal(stats.readFiles, 1, '只有新文件需要读')
  assert.ok(stats.put >= 1, '新记录要落盘')
  assert.equal(stats.del, 0, '没人被删')
})

test('删除一个文件：下一次检索不返回它，索引项也清掉（§6 第 3 条）', async () => {
  const root = makeWorkspace([['docs/gone.md', '# 独有的词 zebrakw\n\n只有这一篇有 zebrakw。\n']])
  const medium = { tables: {} }
  const cold = boot(medium)
  const first = await collectDocs(root)
  await cold.store.flush()
  assert.ok(relsOf(first).includes('docs/gone.md'))
  assert.equal((await cold.store.read(root)).has('docs/gone.md'), true, '先确认它真的进过索引')

  rmSync(join(root, 'docs/gone.md'))

  boot(medium)
  // 相关检索这条路上（修法 ②）**不查索引**，所以「过期索引项被清掉」不是它的职责 ——
  // 它只负责一件事：被删的文件不许出现在这一页、也不许留在名次里。
  const payload = await pageOf(root, 'zebrakw')
  assert.ok(!payload.docs.some((doc) => doc.rel === 'docs/gone.md'), '被删的不许出现在这一页')
  assert.ok(!payload.ranked.some((doc) => doc.rel === 'docs/gone.md'), '也不许留在全量名次里')
  // 对账（过期项的清理）发生在**查索引**的那条路上 —— 时间序扫描。
  const timePage = await timePageOf(root)
  assert.ok(!timePage.docs.some((doc) => doc.rel === 'docs/gone.md'), '时间序里也不许有它')
  const stats = indexStatsFor(root)
  assert.ok(stats.del >= 1, '过期索引项必须被清掉')
  assert.equal((await indexStoreOf(root, medium)).has('docs/gone.md'), false, '存储里也不该再有它')
})

test('重命名 = 删旧 + 增新：旧 rel 不残留，新 rel 立刻可检索', async () => {
  const root = makeWorkspace([['docs/old.md', '# 词 zebrakw\n\n重命名用例。\n']])
  const medium = { tables: {} }
  const cold = boot(medium)
  await collectDocs(root)
  await cold.store.flush()

  renameSync(join(root, 'docs/old.md'), join(root, 'docs/new.md'))

  boot(medium)
  const payload = await pageOf(root, 'zebrakw')
  const rels = payload.ranked.map((doc) => doc.rel)
  assert.ok(rels.includes('docs/new.md'), '新路径必须立刻参与检索')
  assert.ok(!rels.includes('docs/old.md'), '旧路径不许残留')
  // 对账发生在**查索引**的那条路上 —— 时间序扫描（修法 ②）。
  const timeRels = (await timePageOf(root)).docs.map((doc) => doc.rel)
  assert.ok(timeRels.includes('docs/new.md') && !timeRels.includes('docs/old.md'))
  const stats = indexStatsFor(root)
  assert.ok(stats.del >= 1, '旧键要被删掉')
  const stored = await indexStoreOf(root, medium)
  assert.equal(stored.has('docs/old.md'), false)
  assert.equal(stored.has('docs/new.md'), true)
})

/* ── 4 · 降级：坏存储不许把检索带崩（§6 第 6 条）──────── */

test('没有存储：功能照常，理由说清楚，且一条索引都不写', async () => {
  const root = makeWorkspace()
  boot(null)
  const out = await collectDocs(root)
  const stats = indexStatsFor(root)
  assert.equal(stats.readFiles, indexed(out), '没有索引 ⇒ 只能全都读')
  assert.equal(stats.put, 0)
  assert.equal(stats.reused, 0)
  assert.equal(indexStorageStatus().persisted, false)
  assert.equal(indexStorageStatus().reason, 'no-storage')
  const payload = await pageOf(root, '相关性排序')
  assert.ok(payload.docs.length > 0, '检索照常出结果')
})

test('存储开不起来：退回全量扫描，不抛，理由为 open-failed', async () => {
  const root = makeWorkspace()
  resetIndexMemory()
  const backend = fakeStorageBackend({ tables: {} }, { failOpen: true })
  const store = createIndexStore({ backend })
  setIndexRegistry(store)
  setIndexVerifyBudget(0)

  const out = await collectDocs(root)
  assert.equal(indexStatsFor(root).readFiles, indexed(out))
  assert.equal(indexStatsFor(root).reason, 'open-failed')
  assert.equal(store.persisted, false)
  assert.equal(await store.write('/w', { put: [{ rel: 'a.md' }], del: [] }), false)
})

test('介质损坏 / 记录缺指纹：当未验证重建，绝不抛', async () => {
  const root = makeWorkspace()
  const medium = { tables: {} }
  const cold = boot(medium)
  const first = await collectDocs(root)
  await cold.store.flush()

  // 把一条记录改成「只有 mtime+size」的 v1 形状（缺 headHash），再把另一条打成畸形
  const table = medium.tables.files
  const keys = Object.keys(table)
  const victim = keys[0]
  const victimRel = table[victim].rel
  table[victim] = { ...table[victim], headHash: undefined }
  table[keys[1]] = 'not-an-object'

  boot(medium)
  const second = await collectDocs(root)
  const stats = indexStatsFor(root)
  assert.deepEqual(relsOf(second).sort(), relsOf(first).sort(), '语料成员必须完好')
  assert.ok(stats.readFiles >= 1, '缺指纹的那条必须重读')
  const doc = [...second.docs, ...second.code].find((item) => item.rel === victimRel)
  assert.match(doc.headHash, /^[0-9a-f]{16}$/, '重建之后指纹要补回来')

  // `loadAll()` 直接抛（真实后端在介质损坏时报 `malformed-medium`）：当空索引，照常检索
  resetIndexMemory()
  setIndexRegistry(createIndexStore({ backend: fakeStorageBackend({ tables: {} }, { brokenLoad: true }) }))
  setIndexVerifyBudget(0)
  const out = await collectDocs(root)
  assert.equal(indexStatsFor(root).reason, 'read-failed')
  assert.equal(indexStatsFor(root).readFiles, indexed(out))
  assert.deepEqual(relsOf(out).sort(), relsOf(first).sort())
})

/* ── 5 · 一致性：索引开/关，Context Pack 必须一致（§6 第 7 条）── */

test('索引开启 / 关闭：同一语料同一任务，Context Pack 成员与排序逐字一致', async () => {
  const root = makeWorkspace([
    ['docs/design.md', '# 排序设计\n\n相关性排序与 IDF 的设计说明，sidebar 也在这里。\n'],
    ['docs/impl.js', 'export function rankByRelevance() { return "sidebar 相关性排序" }\n'],
  ])
  const query = '相关性排序 sidebar IDF'
  const medium = { tables: {} }

  // ① 有索引、且是热的
  const cold = boot(medium)
  await collectDocs(root)
  await cold.store.flush()
  boot(medium)
  await collectDocs(root)
  const warm = await packFingerprint(root, query)

  // ② 冷启（索引刚建好那一轮）
  boot(medium, { budget: 0 })
  const withIndex = await packFingerprint(root, query)
  assert.equal(withIndex, warm, '冷启与热索引在同一语料上必须给同一个包')

  // ③ 完全没有索引
  boot(null)
  const without = await packFingerprint(root, query)
  assert.equal(without, withIndex, '「索引开 / 关」两份 Context Pack 必须逐字相同')
  assert.ok(JSON.parse(withIndex).some((tier) => tier.length > 0), '指纹不能是个空包')

  // ④ 语料层一致性 —— **修法 ② 之后，这才是真正吃了索引的那条口径**。
  //    ①②③ 走的是相关检索，而它在修法 ② 里不查索引（两边走同一条路，相等是平凡的，
  //    留在这里当回归守卫）；低层取数（`collectDocs`，时间序扫描也走它）会真的复用，
  //    它交出来的语料模型必须与「没有索引、全部整读」逐字一致。
  boot(medium, { budget: 0 })
  const reusedCorpus = await collectDocs(root)
  assert.ok(indexStatsFor(root).reused > 0, '这条口径必须真的用上了索引，否则一致性是白证的')
  boot(null)
  const readCorpus = await collectDocs(root)
  assert.equal(
    corpusFingerprint(reusedCorpus), corpusFingerprint(readCorpus),
    '复用来的语料与整读来的语料必须给出同一份模型（rel / 标题 / 摘要 / 内容指纹）',
  )
})

/* ── 6 · 内存态：重置干净，别留下跨用例的鬼影 ─────────── */

/* ── 6 · 修法 ②：索引只在「用不着正文」的路上查（2026-10-10）── */

test('修法 ②：要正文的相关检索**不查索引**，时间序才吃索引（两条路都能证伪）', async () => {
  const root = makeWorkspace([
    ['docs/a.md', '# 甲\n\nzebrakw 只在这一篇里。\n'],
    ['docs/b.md', '# 乙\n\n另一篇，用来凑候选数。\n'],
    ['docs/c.js', 'export const c = "zebrakw 也在代码里"\n'],
  ])
  const medium = { tables: {} }
  const cold = boot(medium)
  await collectDocs(root)
  await cold.store.flush()

  // ① 相关检索（排序改「相关」+ 真的抽到关键词）：BM25 要全部正文 ⇒ 整读，且不装载索引。
  //    证伪方式：把 `scan()` 里的 `{ index: mode !== 'relevance' }` 换成不传，
  //    `skipped` 会变 false、`reused` 会大于 0，这一节立刻红。
  boot(medium)
  const page = await pageOf(root, 'zebrakw')
  const rel = indexStatsFor(root)
  assert.ok(page.docs.length > 0, '相关检索照常出结果')
  assert.equal(rel.skipped, true, '要正文的路径**根本没查索引**')
  assert.equal(rel.reused, 0, '也不许把没有正文的复用条目交给 BM25')
  assert.equal(rel.readFiles, rel.candidates, '它只能整读全部候选')

  // ② 时间序：完全吃索引里的字段 ⇒ 真的复用。
  //    证伪方式：删掉 `collectDocs()` 里的 `useIndex` 判定（永远查索引），`readFiles`
  //    会变成 0 而不是 candidates，这一节红。
  boot(medium)
  await timePageOf(root)
  const t = indexStatsFor(root)
  assert.equal(t.skipped, false, '时间序必须查索引')
  assert.equal(t.reused + t.readFiles, t.candidates, '每条候选要么复用、要么整读')
  assert.ok(t.reused > 0, '时间序必须真的复用到了索引，否则索引对这条路也白搭')
  assert.equal(t.readFiles, 0, '预算 0 ⇒ 一条都不用整读（复用是真的）')
})

test('resetIndexMemory：统计清零、注册表断开、预算复位', async () => {
  const root = makeWorkspace()
  const medium = { tables: {} }
  const cold = boot(medium)
  await collectDocs(root)
  await cold.store.flush()
  assert.ok(indexStatsFor(root))

  resetIndexMemory()
  assert.equal(indexStatsFor(root), null, '统计必须清掉')
  assert.equal(indexStorageStatus().persisted, false, '注册表要断开')
  const again = await collectDocs(root)
  assert.equal(indexStatsFor(root).readFiles, indexed(again), '重置后只能重新全读')
})

/**
 * 直接读一次存储（断言「过期项真的不在盘上了」时用）。
 * @param {string} root - 工作区根
 * @param {{tables: object}} medium - 介质
 * @returns {Promise<Map<string, object>>} rel → 记录
 */
async function indexStoreOf(root, medium) {
  const store = createIndexStore({ backend: fakeStorageBackend(medium) })
  return store.read(root)
}
